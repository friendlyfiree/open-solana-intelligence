// OSI V2 — SAS issuance path (osi-v2-analyst only).
//
// This is the ONLY module that signs and sends attestation create/close
// transactions, from the dedicated low-privilege operational issuer key
// (OSI_V2_SAS_ISSUER_SECRET). It is imported only by osi-v2-analyst, so the
// heavy signing SDK is not bundled into the read-path functions.
//
// The SDK is imported statically through osi-v2-sas-sdk.ts (see that file for the
// bundling rationale). Everything here is best-effort: issuance never blocks or
// fails analyst activation, and a failure is recorded as telemetry only.

import { reconcileIssuance, base58Decode } from "./osi-v2-sas-core.mjs";
import { fetchSasSettings } from "./osi-v2-sas-onchain.ts";
import type { SasSettings } from "./osi-v2-sas-onchain.ts";
import * as sdkModule from "./osi-v2-sas-sdk.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
type Admin = Any;

// The SDK surface is deliberately used untyped. The shim is @ts-nocheck, but its
// re-exports still carry the SDK's branded types (Address<...>, transaction
// message brands) when the checker resolves remote declarations, and those
// brands reject the plain base58 strings this module passes. Erasing the types
// here keeps `deno check` deterministic across environments while leaving the
// static import (and therefore deploy-time bundling) fully intact.
const sdk = sdkModule as Any;

const RPC_URL = Deno.env.get("SOLANA_RPC_URL") ?? "";
// The dedicated low-privilege issuer keypair generated in the browser by the
// Step 0 tool. This must never be the maintainer wallet's key.
const ISSUER_SECRET = Deno.env.get("OSI_V2_SAS_ISSUER_SECRET") ?? "";

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
      console.log("sas_issuance_noop", JSON.stringify({ wallet: input.wallet, reason: decision.reason }));
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
      // sendTransaction proves submission, not confirmation. Keep the public
      // cache pending so the verifier performs a live confirmed-state check
      // before it reports this credential as valid or revoked.
      await admin.rpc("osi_v2_sas_record_wallet_state", {
        p_wallet: input.wallet,
        p_state: "pending_verification",
        p_credential: settings?.credential ?? null,
        p_schema: settings?.schema ?? null,
        p_issuer: settings?.issuer ?? null,
        p_attestation: result.attestation ?? null,
        p_result: decision.action + "_submitted",
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
// the dedicated operational issuer key (an authorized signer on the Credential
// alongside the maintainer wallet). This on-chain write path is exercised
// manually after Step 0 (no automated coverage is possible without the issuer
// secret and a mainnet signature).
async function performOnChainReconcile(
  settings: SasSettings,
  wallet: string,
  decision: { action: string; statusCode?: number; tierCode?: number },
): Promise<{ ok: boolean; txSig?: string | null; attestation?: string | null; error?: string }> {
  try {
    const rpc = sdk.createSolanaRpc(RPC_URL);
    const secretBytes = parseSecretKey(ISSUER_SECRET);
    const issuer = await sdk.createKeyPairSignerFromBytes(secretBytes);
    const credential = settings.credential as string;
    const schema = settings.schema as string;
    const [attestationPda] = await sdk.deriveAttestationPda({ credential, schema, nonce: wallet });

    let instruction: Any;
    if (decision.action === "issue") {
      const schemaAccount = await sdk.fetchSchema(rpc, schema);
      const data = sdk.serializeAttestationData(schemaAccount.data, {
        tier: decision.tierCode ?? 0,
        status: decision.statusCode ?? 0,
      });
      instruction = sdk.getCreateAttestationInstruction({
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
      instruction = sdk.getCloseAttestationInstruction({
        payer: issuer,
        authority: issuer,
        credential,
        attestation: attestationPda,
      });
    }
    const txSig = await sendInstruction(rpc, issuer, instruction);
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
  // base58-encoded secret key (reuse the core decoder).
  return base58Decode(trimmed);
}

async function sendInstruction(rpc: Any, signer: Any, instruction: Any): Promise<string> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = sdk.pipe(
    sdk.createTransactionMessage({ version: 0 }),
    (m: Any) => sdk.setTransactionMessageFeePayerSigner(signer, m),
    (m: Any) => sdk.setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m: Any) => sdk.appendTransactionMessageInstruction(instruction, m),
  );
  const signed = await sdk.signTransactionMessageWithSigners(message);
  const signature = sdk.getSignatureFromTransaction(signed);
  const encoded = sdk.getBase64EncodedWireTransaction(signed);
  await rpc.sendTransaction(encoded, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  return String(signature);
}
