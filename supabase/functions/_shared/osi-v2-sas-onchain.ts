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
  cacheAnswerUsable,
  enforcementRecheckPlan,
  recheckStateFor,
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
      // A stale cached answer is not an answer: beyond the configured window
      // the authoritative on-chain read is performed instead.
      if (cacheAnswerUsable({
        state: data.verification_state,
        checkedAt: data.last_checked_at,
        nowMs: Date.now(),
        staleSeconds: settings.staleSeconds,
      })) {
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

// ---------------------------------------------------------------------------
// Enforcement: lazy bounded re-check before a quorum-dependent transition.
//
// A review only carries quorum count and voting weight when its per-review
// snapshot says the caster's SAS credential verified live on chain under the
// currently published credential, schema and issuer. Two things can leave a
// snapshot uncountable through no fault of the analyst: the RPC was unreachable
// at cast time (snapshot 'pending_verification'), or OSI rotated its credential
// after the review was cast. Both are repaired here, with a fresh live
// on-chain read, immediately before the transition that would count the review.
//
// A cached wallet row is NEVER consulted on this path: the cache is an index,
// and enforcement asks the authoritative on-chain answer. This is a strict
// no-op when enforcement is off (the worklist RPC also returns zero rows then),
// and it never throws, so a verifier outage can never break a governance write:
// it simply leaves the affected reviews uncounted.
// ---------------------------------------------------------------------------
export type SasRecheckOutcome = {
  attempted: number;
  verified: number;
  unresolved: number;
};

const RECHECK_WALLET_BUDGET = 12;

export async function refreshReviewVerifications(
  admin: Admin,
  targetType: string,
  targetId: string | null | undefined,
): Promise<SasRecheckOutcome> {
  const outcome: SasRecheckOutcome = { attempted: 0, verified: 0, unresolved: 0 };
  try {
    if (!targetId) return outcome;
    const settings = await fetchSasSettings(admin);
    // Flag off: behave exactly as before enforcement existed.
    if (!settings || settings.enforcementEnabled !== true) return outcome;
    const { data, error } = await admin.rpc("osi_v2_sas_reviews_needing_recheck", {
      p_target_type: targetType,
      p_target_id: targetId,
      p_limit: 200,
    });
    if (error || !Array.isArray(data) || data.length === 0) return outcome;
    const plan = enforcementRecheckPlan({
      settings,
      rows: data as Record<string, unknown>[],
      budget: RECHECK_WALLET_BUDGET,
    });
    // Unconfigured SAS records nothing: every affected review stays honestly
    // uncounted rather than being granted an authority nobody could confirm.
    if (plan.skip) {
      outcome.unresolved = data.length;
      return outcome;
    }
    // One live on-chain read per distinct wallet, bounded so a stalled verifier
    // cannot hold a governance write open indefinitely.
    for (const { wallet, reviews } of plan.batches) {
      const live = await verifyWalletLive(settings, wallet);
      const { state, counts } = recheckStateFor(live);
      for (const review of reviews) {
        outcome.attempted += 1;
        if (counts) outcome.verified += 1;
        else outcome.unresolved += 1;
        await admin.rpc("osi_v2_sas_record_review_verification", {
          p_review_kind: review.reviewKind,
          p_review_id: review.reviewId,
          p_wallet: wallet,
          p_state: state,
          p_credential: settings.credential,
          p_schema: settings.schema,
          p_issuer: settings.issuer,
          p_latency_ms: live.latencyMs,
          p_result: live.rpcFailed ? "rpc_failed" : live.status.reason,
          p_error: live.rawError,
        });
      }
      if (!live.rpcFailed) {
        await admin.rpc("osi_v2_sas_record_wallet_state", {
          p_wallet: wallet,
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
    }
  } catch (error) {
    // A verifier failure never blocks a governance write; it only withholds
    // weight from the reviews it could not confirm.
    console.log("sas_recheck_noncritical_error", shortError(error));
  }
  return outcome;
}

// Per-review authority for the surfaces that show a decision weight. Returns a
// map from review id to the public-safe answer. Calls are chunked to the exact
// database limit; unresolved ids are made explicitly uncounted by
// attachReviewAuthority so a partial RPC failure can never grant authority.
export type SasReviewAuthority = {
  enforced: boolean;
  counted: boolean;
  state: string;
};

export async function reviewAuthorityById(
  admin: Admin,
  reviewKind: string,
  reviewIds: string[],
): Promise<Record<string, SasReviewAuthority>> {
  const out: Record<string, SasReviewAuthority> = {};
  try {
    const ids = [...new Set(reviewIds.filter((id) => typeof id === "string" && id))];
    if (ids.length === 0) return out;
    for (let offset = 0; offset < ids.length; offset += 400) {
      const { data, error } = await admin.rpc("osi_v2_sas_review_authority", {
        p_review_kind: reviewKind,
        p_review_ids: ids.slice(offset, offset + 400),
      });
      if (error || !Array.isArray(data)) continue;
      for (const row of data as Record<string, unknown>[]) {
        const id = String(row.review_id ?? "");
        if (!id) continue;
        out[id] = {
          enforced: row.enforcement_enabled === true,
          counted: row.counted === true,
          state: String(row.verification_state ?? "unchecked"),
        };
      }
    }
  } catch {
    // attachReviewAuthority converts every unresolved row to an explicit,
    // fail-closed authority result.
  }
  return out;
}

// Attach the authority answer to review rows in place, under a public-safe
// `sas_authority` key. Rows without an id are left untouched.
export async function attachReviewAuthority(
  admin: Admin,
  reviewKind: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const byId = await reviewAuthorityById(
    admin,
    reviewKind,
    rows.map((row) => String(row.id ?? "")),
  );
  for (const row of rows) {
    const id = String(row.id ?? "");
    if (!id) continue;
    row.sas_authority = byId[id] ?? {
      enforced: true,
      counted: false,
      state: "authority_unavailable",
    };
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
