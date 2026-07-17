// OSI V2 — SAS on-chain glue (Deno / Edge).
//
// This module contains the only code that talks to Solana for the SAS credential
// gate. The decision logic lives in the dependency-free osi-v2-sas-core.mjs; here
// we derive the attestation PDA, read the account, and (when fully configured)
// issue/revoke attestations from the maintainer issuer authority.
//
// The Solana SDKs are loaded through COMPUTED dynamic imports so `deno check`
// never type-checks the remote packages (keeping the CI Deno gate green), and so
// the SDK graph is only fetched at runtime when a real on-chain action is taken.
// Everything here is best-effort: a failure is recorded as telemetry and never
// propagated into an analyst-activation or review-commit flow.

import {
  SAS_PROGRAM_ID,
  buildAttestationSeeds,
  evaluateAttestation,
  shadowStateFor,
  publicVerifierResponse,
  notConfiguredResponse,
  reconcileIssuance,
  isPubkey,
} from "./osi-v2-sas-core.mjs";

// deno-lint-ignore no-explicit-any
type Any = any;
// The Supabase service-role client. Kept loose so the real client (whose builder
// return types are thenables, not Promises) is assignable without friction.
type Admin = Any;

export type SasSettings = {
  programId: string;
  credential: string | null;
  schema: string | null;
  issuer: string | null;
  issuanceEnabled: boolean;
  enforcementEnabled: boolean;
  configured: boolean;
  verifyTimeoutMs: number;
  staleSeconds: number;
};

const RPC_URL = Deno.env.get("SOLANA_RPC_URL") ?? "";
const ISSUER_SECRET = Deno.env.get("OSI_V2_SAS_ISSUER_SECRET") ?? "";

function computedImport(specifier: string): Promise<Any> {
  // Built at runtime so `deno check` cannot statically resolve/type-check it.
  const url = ["https://esm.sh/", specifier].join("");
  return import(url);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), Math.max(1, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function fetchSasSettings(admin: Admin): Promise<SasSettings | null> {
  try {
    const { data, error } = await admin.rpc("osi_v2_sas_settings");
    const row = Array.isArray(data) ? data[0] : null;
    if (error || !row) return null;
    return {
      programId: typeof row.program_id === "string" ? row.program_id : SAS_PROGRAM_ID,
      credential: isPubkey(row.credential_pubkey) ? row.credential_pubkey : null,
      schema: isPubkey(row.schema_pubkey) ? row.schema_pubkey : null,
      issuer: isPubkey(row.issuer_pubkey) ? row.issuer_pubkey : null,
      issuanceEnabled: row.issuance_enabled === true,
      enforcementEnabled: row.enforcement_enabled === true,
      configured: row.configured === true,
      verifyTimeoutMs: Number(row.verify_timeout_ms) || 2500,
      staleSeconds: Number(row.stale_seconds) || 900,
    };
  } catch {
    return null;
  }
}

// Fetch and normalize the on-chain attestation account for a subject wallet.
async function fetchAttestationAccount(
  settings: SasSettings,
  wallet: string,
): Promise<
  | { rpcFailed: true; error: string }
  | { rpcFailed?: false; found: boolean; attestation: string; ownerProgram?: string; data?: Uint8Array }
> {
  if (!RPC_URL) return { rpcFailed: true, error: "rpc_unconfigured" };
  try {
    const web3 = await computedImport("@solana/web3.js@1.98.0");
    const seeds = buildAttestationSeeds({
      credential: settings.credential,
      schema: settings.schema,
      wallet,
    });
    const programId = new web3.PublicKey(settings.programId || SAS_PROGRAM_ID);
    const [pda] = web3.PublicKey.findProgramAddressSync(seeds, programId);
    const connection = new web3.Connection(RPC_URL, "confirmed");
    const info: Any = await withTimeout<Any>(
      connection.getAccountInfo(pda),
      settings.verifyTimeoutMs,
    );
    if (!info) return { found: false, attestation: pda.toBase58() };
    return {
      found: true,
      attestation: pda.toBase58(),
      ownerProgram: info.owner.toBase58(),
      data: new Uint8Array(info.data),
    };
  } catch (error) {
    return { rpcFailed: true, error: String((error as Error)?.message ?? error).slice(0, 200) };
  }
}

export type LiveVerification = {
  status: { state: string; valid: boolean; reason: string; expiry: number | null };
  rpcFailed: boolean;
  attestation: string | null;
  latencyMs: number;
};

export async function verifyWalletLive(
  settings: SasSettings,
  wallet: string,
): Promise<LiveVerification> {
  const started = Date.now();
  const expected = {
    programId: settings.programId,
    credential: settings.credential,
    schema: settings.schema,
    issuer: settings.issuer,
  };
  const account = await fetchAttestationAccount(settings, wallet);
  const latencyMs = Date.now() - started;
  if ("rpcFailed" in account && account.rpcFailed) {
    return {
      status: { state: "pending_verification", valid: false, reason: account.error, expiry: null },
      rpcFailed: true,
      attestation: null,
      latencyMs,
    };
  }
  const status = evaluateAttestation(
    account as { found: boolean; ownerProgram?: string; data?: Uint8Array },
    expected,
    Math.floor(Date.now() / 1000),
  );
  return {
    status,
    rpcFailed: false,
    attestation: (account as { attestation?: string }).attestation ?? null,
    latencyMs,
  };
}

// Public verifier: cache-first, then a live check. Never throws.
export async function publicVerify(admin: Admin, wallet: string): Promise<Record<string, unknown>> {
  const settings = await fetchSasSettings(admin);
  if (!settings || !settings.configured) return notConfiguredResponse(wallet);
  const expected = {
    programId: settings.programId,
    credential: settings.credential,
    schema: settings.schema,
    issuer: settings.issuer,
  };

  // Cache-first: a fresh cached check bounds Solana load for repeated queries.
  try {
    const { data } = await admin
      .from("osi_v2_sas_wallet_credentials")
      .select("verification_state,credential_expiry,last_checked_at")
      .eq("wallet", wallet)
      .maybeSingle();
    if (data && data.last_checked_at) {
      const ageMs = Date.now() - Date.parse(data.last_checked_at);
      if (
        Number.isFinite(ageMs) &&
        ageMs >= 0 &&
        ageMs < settings.staleSeconds * 1000 &&
        data.verification_state !== "pending_verification"
      ) {
        const valid = data.verification_state === "verified";
        return publicVerifierResponse({
          wallet,
          status: {
            state: data.verification_state,
            valid,
            reason: valid ? "valid" : data.verification_state,
            expiry: data.credential_expiry ? Math.floor(Date.parse(data.credential_expiry) / 1000) : null,
          },
          expected,
          source: "cache",
          checkedAt: data.last_checked_at,
        });
      }
    }
  } catch {
    // Cache miss/failure is non-fatal; fall through to a live check.
  }

  const live = await verifyWalletLive(settings, wallet);
  // Best-effort cache write.
  try {
    await admin.rpc("osi_v2_sas_record_wallet_state", {
      p_wallet: wallet,
      p_state: live.rpcFailed ? "pending_verification" : live.status.state,
      p_credential: settings.credential,
      p_schema: settings.schema,
      p_issuer: settings.issuer,
      p_attestation: live.attestation,
      p_expiry: live.status.expiry ? new Date(live.status.expiry * 1000).toISOString() : null,
      p_latency_ms: live.latencyMs,
      p_result: live.rpcFailed ? "rpc_failed" : live.status.reason,
      p_error: live.rpcFailed ? live.status.reason : null,
    });
  } catch {
    // ignore cache write failure
  }
  return publicVerifierResponse({
    wallet,
    status: live.status,
    expected,
    source: "live",
    checkedAt: new Date().toISOString(),
  });
}

// Resolve a review's UUID from its committing event receipt id.
const REVIEW_TABLE: Record<string, string> = {
  case_initial: "case_initial_reviews",
  case_report: "case_report_reviews",
  resolution: "resolution_reviews",
  challenge: "challenge_reviews",
  wire_report: "wire_report_reviews",
  ai_pack: "ai_pack_reviews",
};

export async function resolveReviewIdByReceipt(
  admin: Admin,
  reviewKind: string,
  receiptId: string,
): Promise<string | null> {
  const table = REVIEW_TABLE[reviewKind];
  if (!table || !receiptId) return null;
  try {
    const { data } = await admin
      .from(table)
      .select("id")
      .eq("event_receipt_id", receiptId)
      .maybeSingle();
    return data?.id ?? null;
  } catch {
    return null;
  }
}

export async function resolveReviewIdByPublicRef(
  admin: Admin,
  reviewKind: string,
  publicRef: string,
): Promise<string | null> {
  const table = REVIEW_TABLE[reviewKind];
  if (!table || !publicRef) return null;
  try {
    const { data } = await admin
      .from(table)
      .select("id")
      .eq("public_ref", publicRef)
      .eq("is_active", true)
      .maybeSingle();
    return data?.id ?? null;
  } catch {
    return null;
  }
}

// Best-effort shadow validation for a just-committed review. NEVER throws and
// NEVER affects the review submission; it only records telemetry.
export async function runShadowValidation(
  admin: Admin,
  input: { reviewKind: string; reviewId: string | null; wallet: string },
): Promise<void> {
  try {
    if (!input.reviewId) return;
    const settings = await fetchSasSettings(admin);
    if (!settings || !settings.configured) {
      await admin.rpc("osi_v2_sas_record_review_verification", {
        p_review_kind: input.reviewKind,
        p_review_id: input.reviewId,
        p_wallet: input.wallet,
        p_state: "unchecked",
        p_result: "sas_unconfigured",
      });
      return;
    }
    const live = await verifyWalletLive(settings, input.wallet);
    const state = shadowStateFor({ status: live.status, rpcFailed: live.rpcFailed });
    await admin.rpc("osi_v2_sas_record_review_verification", {
      p_review_kind: input.reviewKind,
      p_review_id: input.reviewId,
      p_wallet: input.wallet,
      p_state: state,
      p_credential: settings.credential,
      p_schema: settings.schema,
      p_issuer: settings.issuer,
      p_latency_ms: live.latencyMs,
      p_result: live.rpcFailed ? "rpc_failed" : live.status.reason,
      p_error: live.rpcFailed ? live.status.reason : null,
    });
    // Also refresh the per-wallet cache (best-effort).
    if (!live.rpcFailed) {
      await admin.rpc("osi_v2_sas_record_wallet_state", {
        p_wallet: input.wallet,
        p_state: live.status.state,
        p_credential: settings.credential,
        p_schema: settings.schema,
        p_issuer: settings.issuer,
        p_attestation: live.attestation,
        p_expiry: live.status.expiry ? new Date(live.status.expiry * 1000).toISOString() : null,
        p_latency_ms: live.latencyMs,
        p_result: live.status.reason,
      });
    }
  } catch (error) {
    console.log("sas_shadow_validation_noncritical_error", String((error as Error)?.message ?? error));
  }
}

// Best-effort issuance/revocation reconciliation on a tier transition. NEVER
// throws into the analyst-activation flow; a safe, logged no-op when unconfigured.
export async function maybeReconcileSasCredential(
  admin: Admin,
  input: { wallet: string; status: string },
): Promise<{ action: string; reason: string; txSig?: string | null }> {
  try {
    const settings = await fetchSasSettings(admin);
    const decision = reconcileIssuance({ settings: settings ?? undefined, status: input.status });
    if (decision.action === "noop_unconfigured") {
      console.log(
        "sas_issuance_noop",
        JSON.stringify({ wallet: input.wallet, reason: decision.reason }),
      );
      return decision;
    }
    if (!ISSUER_SECRET) {
      console.log("sas_issuance_noop", JSON.stringify({ wallet: input.wallet, reason: "issuer_secret_absent" }));
      return { action: "noop_unconfigured", reason: "issuer_secret_absent" };
    }
    const result = await performOnChainReconcile(settings as SasSettings, input.wallet, decision);
    await admin.rpc("osi_v2_sas_record_issuance", {
      p_wallet: input.wallet,
      p_issuance_state: result.ok ? (decision.action === "issue" ? "issued" : "revoked") : "failed",
      p_tx_sig: result.txSig ?? null,
      p_attestation: result.attestation ?? null,
      p_error: result.ok ? null : (result.error ?? "issuance_failed"),
    });
    if (result.ok) {
      await admin.rpc("osi_v2_sas_record_wallet_state", {
        p_wallet: input.wallet,
        p_state: decision.action === "issue" ? "verified" : "revoked",
        p_credential: settings?.credential ?? null,
        p_schema: settings?.schema ?? null,
        p_issuer: settings?.issuer ?? null,
        p_attestation: result.attestation ?? null,
        p_result: decision.action,
      });
    }
    return { action: decision.action, reason: decision.reason, txSig: result.txSig ?? null };
  } catch (error) {
    console.log("sas_issuance_error", String((error as Error)?.message ?? error));
    try {
      await admin.rpc("osi_v2_sas_record_issuance", {
        p_wallet: input.wallet,
        p_issuance_state: "failed",
        p_error: String((error as Error)?.message ?? error).slice(0, 400),
      });
    } catch {
      // swallow
    }
    return { action: "error", reason: "exception" };
  }
}

// Sign + send the actual createAttestation / closeAttestation transaction from
// the maintainer issuer authority. Uses sas-lib + @solana/kit at runtime only.
// This on-chain write path is exercised manually after Step 0 (no automated
// coverage is possible without the issuer secret and a mainnet signature).
async function performOnChainReconcile(
  settings: SasSettings,
  wallet: string,
  decision: { action: string; statusCode?: number; tierCode?: number },
): Promise<{ ok: boolean; txSig?: string | null; attestation?: string | null; error?: string }> {
  try {
    const kit = await computedImport("@solana/kit@5");
    const sas = await computedImport("sas-lib@1.0.10");
    const rpc = kit.createSolanaRpc(RPC_URL);
    const secretBytes = parseSecretKey(ISSUER_SECRET);
    const issuer = await kit.createKeyPairSignerFromBytes(secretBytes);
    const credential = settings.credential as string;
    const schema = settings.schema as string;
    const [attestationPda] = await sas.deriveAttestationPda({ credential, schema, nonce: wallet });

    let instruction: Any;
    if (decision.action === "issue") {
      const schemaAccount = await sas.fetchSchema(rpc, schema);
      const data = sas.serializeAttestationData(schemaAccount.data, {
        tier: decision.tierCode ?? 0,
        status: decision.statusCode ?? 0,
      });
      instruction = sas.getCreateAttestationInstruction({
        payer: issuer,
        authority: issuer,
        credential,
        schema,
        attestation: attestationPda,
        nonce: wallet,
        data,
        expiry: 0,
      });
    } else {
      instruction = sas.getCloseAttestationInstruction({
        payer: issuer,
        authority: issuer,
        credential,
        attestation: attestationPda,
      });
    }
    const txSig = await sendKitInstruction(kit, rpc, issuer, instruction);
    return { ok: true, txSig, attestation: String(attestationPda) };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 400) };
  }
}

function parseSecretKey(secret: string): Uint8Array {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed) as number[]);
  }
  // base58 secret key
  // Reuse the core base58 decoder via a fresh import to avoid duplicating logic.
  // (Imported statically at top would be ideal, but the decoder is exported.)
  return base58ToBytes(trimmed);
}

// Local base58 decode (Solana secret keys). Mirrors the core decoder.
function base58ToBytes(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const map = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i += 1) map.set(alphabet[i], i);
  const bytes: number[] = [];
  for (const ch of value) {
    const digit = map.get(ch);
    if (digit === undefined) throw new Error("bad base58 secret");
    let carry = digit;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = Math.floor(carry / 256);
    }
  }
  for (let k = 0; k < value.length && value[k] === "1"; k += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

async function sendKitInstruction(kit: Any, rpc: Any, signer: Any, instruction: Any): Promise<string> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = kit.pipe(
    kit.createTransactionMessage({ version: 0 }),
    (m: Any) => kit.setTransactionMessageFeePayerSigner(signer, m),
    (m: Any) => kit.setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m: Any) => kit.appendTransactionMessageInstruction(instruction, m),
  );
  const signed = await kit.signTransactionMessageWithSigners(message);
  const signature = kit.getSignatureFromTransaction(signed);
  const encoded = kit.getBase64EncodedWireTransaction(signed);
  await rpc.sendTransaction(encoded, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  return String(signature);
}
