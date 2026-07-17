// OSI V2 — SAS on-chain read glue (Deno / Edge).
//
// The verification read path (public verifier + shadow validation) is fully
// SDK-free: it derives the attestation PDA with the dependency-free primitives
// in osi-v2-sas-core.mjs (Web Crypto SHA-256 + pure BigInt ed25519 math) and
// reads the account over plain JSON-RPC `fetch`. Nothing here is a remote SDK
// import, so nothing here depends on the Edge bundler shipping a third-party
// package. The decision logic lives in osi-v2-sas-core.mjs. SAS on chain is
// always the authoritative source; recorded rows are a cache/index only.
//
// Issuance (signing) lives separately in osi-v2-sas-issuer.ts, which is imported
// only by osi-v2-analyst.
//
// Everything here is best-effort: a failure is recorded as service-only
// telemetry and never propagated into an analyst-activation or review-commit
// flow. Raw internal error detail is NEVER returned to unauthenticated callers;
// public responses carry only neutral reason codes.

import {
  SAS_PROGRAM_ID,
  deriveAttestationPda,
  base64ToBytes,
  evaluateAttestation,
  shadowStateFor,
  publicVerifierResponse,
  notConfiguredResponse,
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

// The only public-facing reason code for any transport/RPC failure. Detailed
// internal error strings stay in service-only telemetry, never in a response.
const PUBLIC_RPC_UNAVAILABLE = "rpc_unavailable";

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

type FetchedAccount =
  | { rpcFailed: true; error: string; attestation: string | null }
  | { rpcFailed?: false; found: boolean; attestation: string; ownerProgram?: string; data?: Uint8Array };

// Derive the attestation PDA (SDK-free) and read the account over plain JSON-RPC.
async function fetchAttestationAccount(settings: SasSettings, wallet: string): Promise<FetchedAccount> {
  if (!RPC_URL) return { rpcFailed: true, error: "rpc_unconfigured", attestation: null };
  let pda: string;
  try {
    pda = await deriveAttestationPda({
      programId: settings.programId,
      credential: settings.credential,
      schema: settings.schema,
      wallet,
    });
  } catch (error) {
    return { rpcFailed: true, error: "derive_failed:" + shortError(error), attestation: null };
  }
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [pda, { encoding: "base64", commitment: "confirmed" }],
      }),
      signal: AbortSignal.timeout(Math.max(1, settings.verifyTimeoutMs)),
    });
    if (!response.ok) {
      return { rpcFailed: true, error: "rpc_http_" + response.status, attestation: pda };
    }
    const json = await response.json();
    if (json.error) {
      return { rpcFailed: true, error: "rpc_error:" + shortError(json.error?.message ?? "rpc"), attestation: pda };
    }
    const value = json.result?.value;
    if (!value) return { found: false, attestation: pda };
    const owner = typeof value.owner === "string" ? value.owner : "";
    const dataField = Array.isArray(value.data) ? value.data[0] : "";
    return { found: true, attestation: pda, ownerProgram: owner, data: base64ToBytes(dataField || "") };
  } catch (error) {
    return { rpcFailed: true, error: shortError(error), attestation: pda };
  }
}

function shortError(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 200);
}

export type LiveVerification = {
  // `status.reason` is always public-safe (neutral code or an evaluation reason).
  status: { state: string; valid: boolean; reason: string; expiry: number | null };
  rpcFailed: boolean;
  // Detailed internal error for service-only telemetry; never returned to callers.
  rawError: string | null;
  attestation: string | null;
  latencyMs: number;
};

export async function verifyWalletLive(settings: SasSettings, wallet: string): Promise<LiveVerification> {
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
      status: { state: "pending_verification", valid: false, reason: PUBLIC_RPC_UNAVAILABLE, expiry: null },
      rpcFailed: true,
      rawError: account.error,
      attestation: account.attestation,
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
    rawError: null,
    attestation: (account as { attestation?: string }).attestation ?? null,
    latencyMs,
  };
}

// Public verifier: cache-first, then a live check. Never throws. Never leaks a
// raw internal error string into the response.
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
  // Best-effort cache write. Raw error goes into service-only telemetry columns.
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
      p_error: live.rawError,
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
      p_error: live.rawError,
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
    console.log("sas_shadow_validation_noncritical_error", shortError(error));
  }
}
