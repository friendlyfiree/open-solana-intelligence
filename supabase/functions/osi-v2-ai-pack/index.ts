// OSI V2 AI Pack gateway.
//
// This function is deliberately separate from the legacy V1 AI Pack endpoint:
// V2 uses immutable Case-bound versions, scoped manifests, Stage-5 nonces,
// server-derived roles, durable reservations, and exact analyst quorum. The
// browser never receives the service role or provider key, and this module
// intentionally contains no logging calls because prompts and generated
// artifacts may contain restricted Case material.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  randomNonce,
  requestFingerprint,
  trustedClientAddress,
  validateWallet,
  verifyEd25519Signature,
} from "../_shared/osi-v2-proof-core.mjs";
import {
  maintainerGate,
  validateConfirmedMemoTransaction,
} from "../_shared/osi-v2-case-write-core.mjs";
import {
  READ_SESSION_SCOPES,
  isExactReadSessionOrigin,
  readSessionIssuer,
  verifyReadSessionToken,
} from "../_shared/osi-v2-read-session-core.mjs";
import {
  AI_PACK_APPROVAL_EVENT,
  AI_PACK_GENERATION_EVENT,
  AI_PACK_OWNER_FEEDBACK_EVENT,
  AI_PACK_REVIEW_EVENTS,
  GenerationExecutionError,
  authorizedCasePacksDto,
  canonicalAiPackApprovalMemo,
  executeReservedGeneration,
  groupPublicPackRows,
  normalizeOwnerFeedback,
  normalizeReview,
  parseAiPackProof,
  proofBindingFromNonce,
  validateAiPackProof,
  validateCaseRef,
  validateIdempotencyKey,
  validatePackType,
  validateVersionRef,
} from "./core.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "";
const SOLANA_RPC_URL = Deno.env.get("SOLANA_RPC_URL") ?? "";
const MAINTAINER_AUTH_UUID = Deno.env.get("OSI_MAINTAINER_AUTH_UUID") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MAX_BODY_BYTES = 96_000;
const RPC_TIMEOUT_MS = 15_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const TX_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

type Row = Record<string, any>;
type SupabaseError = Row | null;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstRow(data: unknown): Row | null {
  return Array.isArray(data)
    ? data[0] ?? null
    : data && typeof data === "object"
    ? data as Row
    : null;
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "3600",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (origin && isExactReadSessionOrigin(origin, ALLOWED_ORIGIN)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" },
  });
}

function requestOriginAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  return !origin || isExactReadSessionOrigin(origin, ALLOWED_ORIGIN);
}

function numericErrorDetails(error: SupabaseError): Record<string, number> | undefined {
  const allowed = new Set([
    "retry_after_seconds",
    "cooldown_remaining_seconds",
    "reset_in_seconds",
  ]);
  const output: Record<string, number> = {};
  const raw = error?.details;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const number = Number(value);
      if (allowed.has(key) && Number.isSafeInteger(number) && number >= 0 && number <= 604800) {
        output[key] = number;
      }
    }
  } else if (typeof raw === "string" && raw.length <= 1000) {
    for (const key of allowed) {
      const match = raw.match(new RegExp("\\b" + key + "\\s*[=:]\\s*(\\d{1,7})\\b"));
      const number = match ? Number(match[1]) : NaN;
      if (Number.isSafeInteger(number) && number >= 0 && number <= 604800) output[key] = number;
    }
  }
  return Object.keys(output).length ? output : undefined;
}

function rpcFailure(
  req: Request,
  error: SupabaseError,
  fallback = "ai_pack_write_failed",
): Response {
  const code = safeText(error?.code);
  const message = safeText(error?.message);
  const details = numericErrorDetails(error);
  const body = (name: string) => ({
    ok: false,
    error: name,
    ...(details ? { details } : {}),
  });

  if (new Set([
    "ai_pack_prepare_wallet_rate_limited",
    "ai_pack_prepare_fingerprint_rate_limited",
    "ai_pack_wallet_rate_limited",
    "ai_pack_fingerprint_rate_limited",
    "ai_pack_case_cooldown_active",
    "ai_pack_daily_quota_exhausted",
  ]).has(message)) {
    return jsonResponse(req, 429, body(message));
  }
  if (message === "ai_pack_input_too_large") {
    return jsonResponse(req, 413, body(message));
  }
  if (new Set([
    "ai_pack_generation_binding_changed",
    "ai_pack_generation_expired",
    "ai_pack_generation_concurrent",
    "ai_pack_generation_in_progress",
    "ai_pack_proof_binding_rejected",
    "ai_pack_review_binding_changed",
    "ai_pack_feedback_binding_changed",
    "ai_pack_approval_binding_changed",
    "analyst_quorum_not_met",
  ]).has(message) || code === "23514" || code === "40001") {
    return jsonResponse(req, 409, body(message || "ai_pack_proof_binding_rejected"));
  }
  if (new Set([
    "ai_pack_generation_actor_ineligible",
    "ai_pack_review_actor_ineligible",
    "ai_pack_feedback_actor_ineligible",
    "ai_pack_approval_actor_ineligible",
    "ai_pack_creator_self_review_forbidden",
    "ai_pack_case_owner_review_forbidden",
    "maintainer_cannot_substitute_ai_pack_quorum",
  ]).has(message) || code === "42501") {
    return jsonResponse(req, 403, body(message || "not_authorized"));
  }
  if (message === "ai_pack_not_found_or_denied" || code === "P0002") {
    return jsonResponse(req, 404, body("ai_pack_not_found_or_denied"));
  }
  if (new Set([
    "ai_pack_writes_disabled",
    "ai_pack_review_writes_disabled",
    "ai_pack_config_invalid",
  ]).has(message) || code === "55000") {
    return jsonResponse(req, 503, body(message || "ai_pack_writes_disabled_or_unavailable"));
  }
  if (code === "23505") return jsonResponse(req, 409, body("ai_pack_conflict"));
  return jsonResponse(req, 500, body(fallback));
}

async function configRows(keys: string[]): Promise<Record<string, string> | null> {
  const { data, error } = await admin.from("osi_config").select("key,value").in("key", keys);
  if (error) return null;
  const result: Record<string, string> = {};
  for (const row of data ?? []) result[String(row.key)] = String(row.value ?? "");
  return result;
}

async function configEnabled(key: string): Promise<boolean> {
  const values = await configRows([key]);
  return values?.[key] === "true";
}

async function authenticatedMaintainerId(req: Request): Promise<string> {
  if (!UUID.test(MAINTAINER_AUTH_UUID)) return "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return "";
  try {
    const { data, error } = await admin.auth.getUser(token);
    return !error && data?.user?.id === MAINTAINER_AUTH_UUID ? data.user.id : "";
  } catch {
    return "";
  }
}

async function fullMaintainer(req: Request, wallet: string) {
  const [values, authId] = await Promise.all([
    configRows(["admin_wallet"]),
    authenticatedMaintainerId(req),
  ]);
  let configuredWallet = "";
  try {
    configuredWallet = validateWallet(values?.admin_wallet ?? "");
  } catch {
    configuredWallet = "";
  }
  const gate = maintainerGate(Boolean(authId), wallet, configuredWallet);
  return { ...gate, auth_id: gate.ok ? authId : "" };
}

async function analystStatus(wallet: string): Promise<string> {
  const { data, error } = await admin.from("analyst_profiles")
    .select("status,verified,approved,weight_cached")
    .eq("wallet", wallet)
    .limit(1);
  const row = data?.[0];
  if (error || !row || row.verified !== true || row.approved !== true) return "";
  const weight = Number(row.weight_cached);
  if (!Number.isFinite(weight) || weight < 0.5 || weight > 3) return "";
  return new Set(["probationary_analyst", "verified_analyst", "senior_analyst"])
      .has(String(row.status))
    ? String(row.status)
    : "";
}

async function flagsAvailable() {
  const values = await configRows([
    "OSI_V2_WRITES_ENABLED",
    "OSI_V2_PROOF_ENABLED",
    "OSI_V2_AI_PACK_WRITES_ENABLED",
    "OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED",
  ]);
  const base = values?.OSI_V2_WRITES_ENABLED === "true"
    && values?.OSI_V2_PROOF_ENABLED === "true";
  const writes = base && values?.OSI_V2_AI_PACK_WRITES_ENABLED === "true";
  return {
    writes,
    review: writes && values?.OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED === "true",
  };
}

async function requireWriteFlags(
  req: Request,
  reviewRequired = false,
): Promise<Response | null> {
  const flags = await flagsAvailable();
  if (!flags.writes) {
    return jsonResponse(req, 503, { ok: false, error: "ai_pack_writes_disabled" });
  }
  if (reviewRequired && !flags.review) {
    return jsonResponse(req, 503, {
      ok: false,
      error: "ai_pack_review_writes_disabled",
    });
  }
  return null;
}

async function fingerprint(req: Request): Promise<string> {
  return await requestFingerprint(
    SERVICE_ROLE_KEY + "\u0000osi-v2-ai-pack",
    trustedClientAddress(req.headers),
  );
}

async function loadBoundNonce(nonce: string) {
  if (!NONCE.test(nonce)) return { row: null, error: null };
  const { data, error } = await admin.from("osi_nonces")
    .select(
      "nonce,purpose,actor_wallet,target_type,target_id,payload_hash,issued_at,expires_at,consumed_at,consumed_by_receipt_id,binding_context",
    )
    .eq("nonce", nonce)
    .limit(1);
  return { row: data?.[0] ?? null, error };
}

async function verifySignedWrite(
  req: Request,
  body: Row,
  allowedPurposes: Set<string>,
) {
  const wallet = validateWallet(body.wallet);
  const nonce = safeText(body.nonce);
  const message = safeText(body.message);
  const signature = safeText(body.signature);
  const loaded = await loadBoundNonce(nonce);
  const row = loaded.row;
  const purpose = String(row?.purpose ?? "");
  const expectedTargetType = purpose === AI_PACK_OWNER_FEEDBACK_EVENT
    ? "pack_owner_feedback"
    : "pack_version";
  if (loaded.error || !row || row.target_type !== expectedTargetType
      || !allowedPurposes.has(purpose)) {
    throw new GenerationExecutionError("unknown_or_wrong_nonce", 409);
  }
  const binding = proofBindingFromNonce(row);
  const verificationTime = row.consumed_at
    ? Math.min(Math.floor(Date.now() / 1000), binding.expires_at)
    : Math.floor(Date.now() / 1000);
  const proof = validateAiPackProof(message, binding, verificationTime);
  if (!proof.ok || wallet !== row.actor_wallet) {
    throw new GenerationExecutionError("ai_pack_proof_binding_rejected", 409);
  }
  if (!await verifyEd25519Signature(message, signature, wallet)) {
    throw new GenerationExecutionError("invalid_wallet_signature", 401);
  }
  let authId: string | null = null;
  if (binding.actor_role === "maintainer") {
    const gate = await fullMaintainer(req, wallet);
    if (!gate.ok) throw new GenerationExecutionError(gate.reason, 403);
    authId = gate.auth_id;
  }
  return { wallet, nonce, message, signature, row, binding, authId };
}

async function consumedSignedReceipt(
  nonceRow: Row,
  binding: ReturnType<typeof proofBindingFromNonce>,
  proofType: "system_event" | "wallet_signed_server_verified",
): Promise<Row | null> {
  const receiptId = safeText(nonceRow.consumed_by_receipt_id);
  if (!UUID.test(receiptId)) return null;
  const { data, error } = await admin.from("event_receipts")
    .select(
      "id,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,decision,proof_type,server_verified,occurred_at",
    )
    .eq("id", receiptId)
    .limit(1);
  const receipt = data?.[0];
  const expectedTargetType = binding.purpose === AI_PACK_OWNER_FEEDBACK_EVENT
    ? "pack_owner_feedback"
    : "pack_version";
  const expectedDecision = binding.purpose === AI_PACK_OWNER_FEEDBACK_EVENT
    ? String(nonceRow.binding_context?.feedback_type ?? "")
    : binding.decision;
  if (error || !receipt || receipt.event_type !== binding.purpose
      || receipt.target_type !== expectedTargetType
      || String(receipt.target_id) !== String(nonceRow.target_id)
      || receipt.actor_wallet !== binding.actor_wallet
      || receipt.actor_role !== binding.actor_role
      || receipt.decision !== expectedDecision
      || receipt.proof_type !== proofType || receipt.server_verified !== true) {
    return null;
  }
  return receipt;
}

async function committedGenerationReplay(
  verified: Awaited<ReturnType<typeof verifySignedWrite>>,
): Promise<Row | null> {
  const receipt = await consumedSignedReceipt(
    verified.row,
    verified.binding,
    "system_event",
  );
  if (!receipt) return null;
  const { data, error } = await admin.from("osi_v2_ai_pack_generation_runs")
    .select(
      "pack_public_ref,version_public_ref,version_no,state,receipt_id",
    )
    .eq("nonce", verified.nonce)
    .eq("receipt_id", receipt.id)
    .limit(1);
  const run = data?.[0];
  if (error || !run || run.state !== "committed"
      || run.version_public_ref !== verified.binding.version_ref) {
    return null;
  }
  const { data: versions, error: versionError } = await admin.from("ai_pack_versions")
    .select("lifecycle_state")
    .eq("id", verified.row.target_id)
    .eq("version_ref", verified.binding.version_ref)
    .limit(1);
  if (versionError || !versions?.[0]) return null;
  return {
    ...run,
    lifecycle_state: versions[0].lifecycle_state,
    idempotent_replay: true,
  };
}

function preparedWriteDto(row: Row, expectedPurpose: string, wallet: string) {
  const nonce = safeText(row.nonce ?? row.issued_nonce);
  const proofText = safeText(row.proof_text);
  const parsed = parseAiPackProof(proofText);
  if (!parsed || parsed.purpose !== expectedPurpose || parsed.nonce !== nonce
      || parsed.actor_wallet !== wallet) {
    throw new TypeError("ai_pack_prepared_proof_invalid");
  }
  const committed = row.generation_state === "committed"
    || UUID.test(String(row.receipt_id ?? row.consumed_receipt_id ?? ""));
  const proof = expectedPurpose === AI_PACK_APPROVAL_EVENT
    ? {
      event_type: expectedPurpose,
      label: "Memo-anchored on Solana",
      proof_type: "solana_memo",
      server_verified: true,
    }
    : expectedPurpose === AI_PACK_GENERATION_EVENT
    ? {
      event_type: expectedPurpose,
      label: "System event",
      proof_type: "system_event",
      server_verified: true,
    }
    : {
      event_type: expectedPurpose,
      label: "Wallet-signed and server-verified",
      proof_type: "wallet_signed_server_verified",
      server_verified: true,
    };
  return {
    already_committed: committed,
    nonce,
    message: proofText,
    pack_public_ref: row.pack_public_ref == null ? null : String(row.pack_public_ref),
    version_ref: parsed.version_ref,
    version_no: Number.isSafeInteger(Number(row.version_no)) ? Number(row.version_no) : null,
    lifecycle_state: row.lifecycle_state == null ? null : String(row.lifecycle_state),
    expires_at: parsed.expires_at,
    idempotent_replay: row.idempotent_replay === true || committed,
    ...(committed ? {
      proof,
      ...(expectedPurpose === AI_PACK_GENERATION_EVENT
        ? {
          authorization: {
            label: "Wallet-signed and server-verified",
            proof_type: "wallet_signed_server_verified",
            server_verified: true,
          },
        }
        : {}),
    } : {}),
  };
}

function committedWriteDto(row: Row | null, versionFallback: string | null = null) {
  const versionRef = row?.version_ref ?? row?.version_public_ref ?? versionFallback;
  return {
    pack_public_ref: row?.pack_public_ref == null ? null : String(row.pack_public_ref),
    version_ref: versionRef == null ? null : validateVersionRef(versionRef),
    version_no: Number.isSafeInteger(Number(row?.version_no)) ? Number(row?.version_no) : null,
    lifecycle_state: row?.lifecycle_state == null ? null : String(row.lifecycle_state),
    idempotent_replay: row?.idempotent_replay === true,
  };
}

async function capabilities(req: Request, body: Row): Promise<Response> {
  let wallet: string;
  let caseRef: string;
  try {
    wallet = validateWallet(body.wallet);
    caseRef = validateCaseRef(body.case_ref);
  } catch {
    return jsonResponse(req, 400, { ok: false, error: "bad_capability_request" });
  }
  const [caseResult, status, maintainer, flags] = await Promise.all([
    admin.from("cases")
      .select("id,public_ref,submitted_by_wallet,visibility,stage")
      .eq("public_ref", caseRef)
      .limit(1),
    analystStatus(wallet),
    fullMaintainer(req, wallet),
    flagsAvailable(),
  ]);
  const caseRow = caseResult.data?.[0] ?? null;
  // Capabilities are not a private read. Do not reveal a private Case through
  // this unsigned operation.
  const caseAvailable = !caseResult.error && caseRow?.visibility === "public";
  const owner = caseAvailable && caseRow.submitted_by_wallet === wallet;
  const caseStageEligible = caseAvailable && new Set([
    "open_public",
    "in_review",
    "ready_for_finalization",
    "resolution_proposed",
    "in_challenge_window",
    "resolved",
    "reopened",
  ]).has(String(caseRow.stage));
  const analystEligible = Boolean(status);
  const generationEligible = status === "verified_analyst" || status === "senior_analyst";
  const role = owner
    ? "owner"
    : maintainer.ok
    ? "maintainer"
    : status === "senior_analyst"
    ? "senior"
    : analystEligible
    ? "analyst"
    : "public";
  const canGenerate = Boolean(
    caseAvailable && caseStageEligible && flags.writes && !owner
      && (generationEligible || maintainer.ok)
      && ANTHROPIC_API_KEY.trim().length >= 20,
  );
  let prerequisite: string | null = null;
  if (!caseAvailable) prerequisite = "AI Packs are available only for a public Case.";
  else if (!flags.writes) {
    prerequisite = "AI Pack generation is disabled until every required server rollout gate is enabled.";
  } else if (!caseStageEligible) {
    prerequisite = "This Case lifecycle stage is not eligible for AI Pack generation.";
  } else if (owner) prerequisite = "Case owners cannot generate AI Packs in this release.";
  else if (status === "probationary_analyst") {
    prerequisite = "Generation requires verified or senior analyst standing.";
  } else if (!generationEligible && !maintainer.ok) {
    prerequisite = "Generation requires a verified analyst or full maintainer.";
  } else if (ANTHROPIC_API_KEY.trim().length < 20) {
    prerequisite = "AI Pack generation is temporarily unavailable.";
  }
  return jsonResponse(req, 200, {
    ok: true,
    case_ref: caseRef,
    ai_pack_writes_enabled: flags.writes,
    ai_pack_review_writes_enabled: flags.review,
    case_stage_eligible: caseStageEligible,
    viewer_role: role,
    analyst_eligible: analystEligible,
    maintainer_access: maintainer.ok,
    can_generate: canGenerate,
    generation_prerequisite: canGenerate ? null : prerequisite,
  });
}

async function listPublicPacks(req: Request, body: Row, global: boolean): Promise<Response> {
  let caseRef: string | null = null;
  try {
    caseRef = global ? null : validateCaseRef(body.case_ref);
  } catch {
    return jsonResponse(req, 400, { ok: false, error: "bad_case_ref" });
  }
  const { data, error } = await admin.rpc("osi_v2_list_public_ai_packs", {
    p_case_public_ref: caseRef,
  });
  if (error) return jsonResponse(req, 503, { ok: false, error: "ai_pack_read_unavailable" });
  try {
    return jsonResponse(req, 200, { ok: true, packs: groupPublicPackRows(data ?? []) });
  } catch {
    return jsonResponse(req, 503, { ok: false, error: "ai_pack_projection_invalid" });
  }
}

async function verifyPrivateRead(req: Request, body: Row) {
  if (!await configEnabled("OSI_V2_READ_SESSION_ENABLED")) {
    return { ok: false as const, status: 503, reason: "read_session_disabled_or_unavailable" };
  }
  const verified = await verifyReadSessionToken({
    token: safeText(body.read_session),
    secret: SERVICE_ROLE_KEY,
    issuer: readSessionIssuer(SUPABASE_URL),
    origin: req.headers.get("origin") ?? "",
    allowedOrigin: ALLOWED_ORIGIN,
    wallet: safeText(body.wallet),
    requiredScope: READ_SESSION_SCOPES.AIPACK_DETAIL,
  });
  if (verified.ok !== true || typeof verified.wallet !== "string") {
    return {
      ok: false as const,
      status: typeof verified.status === "number" ? verified.status : 403,
      reason: typeof verified.reason === "string" ? verified.reason : "read_session_tampered",
    };
  }
  return { ok: true as const, wallet: verified.wallet };
}

async function getCasePacks(req: Request, body: Row): Promise<Response> {
  let caseRef: string;
  try {
    caseRef = validateCaseRef(body.case_ref);
  } catch {
    return jsonResponse(req, 400, { ok: false, error: "bad_case_ref" });
  }
  const proof = await verifyPrivateRead(req, body);
  if (!proof.ok) return jsonResponse(req, proof.status, { ok: false, error: proof.reason });
  const maintainer = await fullMaintainer(req, proof.wallet);
  const { data, error } = await admin.rpc("osi_v2_get_authorized_ai_packs", {
    p_case_public_ref: caseRef,
    p_actor_wallet: proof.wallet,
    p_maintainer_auth_uuid: maintainer.ok ? maintainer.auth_id : null,
  });
  if (error) {
    return error.code === "42501"
      ? jsonResponse(req, 404, { ok: false, error: "ai_pack_not_found_or_denied" })
      : jsonResponse(req, 503, { ok: false, error: "ai_pack_read_unavailable" });
  }
  const result = firstRow(data);
  if (!result) return jsonResponse(req, 404, { ok: false, error: "ai_pack_not_found_or_denied" });
  const role = safeText(result.viewer_role);
  try {
    return jsonResponse(req, 200, {
      ok: true,
      viewer_role: role,
      case_ref: validateCaseRef(result.case_public_ref),
      packs: authorizedCasePacksDto(result.packs, role, result.case_public_ref),
    });
  } catch {
    return jsonResponse(req, 503, { ok: false, error: "ai_pack_projection_invalid" });
  }
}

async function prepareGeneration(req: Request, body: Row): Promise<Response> {
  let wallet: string;
  let caseRef: string;
  let packType: string;
  let idempotencyKey: string;
  try {
    wallet = validateWallet(body.wallet);
    caseRef = validateCaseRef(body.case_ref);
    packType = validatePackType(body.pack_type);
    idempotencyKey = validateIdempotencyKey(body.idempotency_key);
  } catch {
    return jsonResponse(req, 400, { ok: false, error: "bad_generation_request" });
  }
  const maintainer = await fullMaintainer(req, wallet);
  const { data, error } = await admin.rpc("osi_v2_prepare_ai_pack_generation", {
    p_nonce: randomNonce(),
    p_actor_wallet: wallet,
    p_case_public_ref: caseRef,
    p_pack_type: packType,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
    p_maintainer_auth_uuid: maintainer.ok ? maintainer.auth_id : null,
  });
  if (error) return rpcFailure(req, error, "ai_pack_generation_prepare_failed");
  const row = firstRow(data);
  if (!row) return jsonResponse(req, 500, { ok: false, error: "ai_pack_generation_prepare_failed" });
  if (row.generation_state === "failed") {
    return jsonResponse(req, 409, {
      ok: false,
      error: "ai_pack_generation_already_failed",
      idempotent_replay: true,
      retry_with_new_idempotency_key: true,
    });
  }
  try {
    return jsonResponse(req, 200, {
      ok: true,
      ...preparedWriteDto(row, AI_PACK_GENERATION_EVENT, wallet),
    });
  } catch {
    return jsonResponse(req, 503, { ok: false, error: "ai_pack_generation_prepare_invalid" });
  }
}

async function commitGeneration(req: Request, body: Row): Promise<Response> {
  try {
    const verified = await verifySignedWrite(req, body, new Set([AI_PACK_GENERATION_EVENT]));
    if (verified.row.consumed_at) {
      const replay = await committedGenerationReplay(verified);
      if (!replay) {
        return jsonResponse(req, 409, {
          ok: false,
          error: "ai_pack_generation_binding_changed",
        });
      }
      return jsonResponse(req, 200, {
        ok: true,
        already_committed: true,
        ...committedWriteDto(replay, verified.binding.version_ref),
        idempotent_replay: true,
        proof: {
          event_type: AI_PACK_GENERATION_EVENT,
          label: "System event",
          proof_type: "system_event",
          server_verified: true,
        },
        authorization: {
          label: "Wallet-signed and server-verified",
          proof_type: "wallet_signed_server_verified",
          server_verified: true,
        },
      });
    }
    const blocked = await requireWriteFlags(req);
    if (blocked) return blocked;
    const { data, error } = await admin.rpc("osi_v2_reserve_ai_pack_generation", {
      p_nonce: verified.nonce,
      p_signature: verified.signature,
      p_signed_message: verified.message,
      p_maintainer_auth_uuid: verified.authId,
    });
    if (error) return rpcFailure(req, error, "ai_pack_generation_reserve_failed");
    const reservation = firstRow(data);
    if (!reservation) {
      return jsonResponse(req, 500, { ok: false, error: "ai_pack_generation_reserve_failed" });
    }
    const executed = await executeReservedGeneration({
      reservation,
      nonce: verified.nonce,
      apiKey: ANTHROPIC_API_KEY,
      fetchImpl: fetch,
      rpc: (name, args) => admin.rpc(name, args),
    });
    return jsonResponse(req, 200, {
      ok: true,
      already_committed: executed.already_committed,
      ...committedWriteDto(executed.generation, verified.binding.version_ref),
      idempotent_replay: executed.idempotent_replay,
      proof: {
        event_type: AI_PACK_GENERATION_EVENT,
        label: "System event",
        proof_type: "system_event",
        server_verified: true,
      },
      authorization: {
        label: "Wallet-signed and server-verified",
        proof_type: "wallet_signed_server_verified",
        server_verified: true,
      },
    });
  } catch (error) {
    const failure = error instanceof GenerationExecutionError ? error : null;
    return jsonResponse(req, failure?.status ?? 400, {
      ok: false,
      error: failure?.code ?? "bad_generation_commit",
    });
  }
}

async function prepareReview(req: Request, body: Row): Promise<Response> {
  let wallet: string;
  let review: ReturnType<typeof normalizeReview>;
  let idempotencyKey: string;
  try {
    wallet = validateWallet(body.wallet);
    review = normalizeReview(body);
    idempotencyKey = validateIdempotencyKey(body.idempotency_key);
  } catch {
    return jsonResponse(req, 400, { ok: false, error: "bad_review_request" });
  }
  const { data, error } = await admin.rpc("osi_v2_prepare_ai_pack_review", {
    p_nonce: randomNonce(),
    p_actor_wallet: wallet,
    p_version_public_ref: review.version_ref,
    p_decision: review.decision,
    p_reason_code: review.reason_code,
    p_public_rationale: review.public_rationale,
    p_private_note: review.private_note,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error) return rpcFailure(req, error, "ai_pack_review_prepare_failed");
  const row = firstRow(data);
  if (!row) return jsonResponse(req, 500, { ok: false, error: "ai_pack_review_prepare_failed" });
  const event = safeText(row.event_type);
  if (!AI_PACK_REVIEW_EVENTS.has(event)) {
    return jsonResponse(req, 503, { ok: false, error: "ai_pack_review_prepare_invalid" });
  }
  try {
    return jsonResponse(req, 200, { ok: true, ...preparedWriteDto(row, event, wallet) });
  } catch {
    return jsonResponse(req, 503, { ok: false, error: "ai_pack_review_prepare_invalid" });
  }
}

async function commitReview(req: Request, body: Row): Promise<Response> {
  try {
    const verified = await verifySignedWrite(req, body, AI_PACK_REVIEW_EVENTS);
    const context = verified.row.binding_context ?? {};
    const review = normalizeReview({
      version_ref: context.version_public_ref,
      decision: context.decision,
      reason_code: context.reason_code,
      public_rationale: context.public_rationale,
      private_note: context.private_note,
    });
    if (verified.row.consumed_at) {
      const receipt = await consumedSignedReceipt(
        verified.row,
        verified.binding,
        "wallet_signed_server_verified",
      );
      if (!receipt) {
        return jsonResponse(req, 409, {
          ok: false,
          error: "ai_pack_review_binding_changed",
        });
      }
      return jsonResponse(req, 200, {
        ok: true,
        already_committed: true,
        version_ref: verified.binding.version_ref,
        review_public_ref: /^OSI-APR-[0-9A-F]{16}$/.test(String(receipt.public_ref ?? ""))
          ? receipt.public_ref
          : null,
        decision: review.decision,
        idempotent_replay: true,
        proof: {
          event_type: verified.binding.purpose,
          label: "Wallet-signed and server-verified",
          proof_type: "wallet_signed_server_verified",
          server_verified: true,
        },
      });
    }
    const blocked = await requireWriteFlags(req, true);
    if (blocked) return blocked;
    const { data, error } = await admin.rpc("osi_v2_commit_ai_pack_review", {
      p_nonce: verified.nonce,
      p_decision: review.decision,
      p_reason_code: review.reason_code,
      p_public_rationale: review.public_rationale,
      p_private_note: review.private_note,
      p_signature: verified.signature,
      p_signed_message: verified.message,
    });
    if (error) return rpcFailure(req, error, "ai_pack_review_commit_failed");
    const row = firstRow(data);
    return jsonResponse(req, 200, {
      ok: true,
      ...committedWriteDto(row, verified.binding.version_ref),
      review_public_ref: row?.review_public_ref == null ? null : String(row.review_public_ref),
      decision: review.decision,
      idempotent_replay: row?.idempotent_replay === true,
      proof: {
        event_type: verified.binding.purpose,
        label: "Wallet-signed and server-verified",
        proof_type: "wallet_signed_server_verified",
        server_verified: true,
      },
    });
  } catch (error) {
    const failure = error instanceof GenerationExecutionError ? error : null;
    return jsonResponse(req, failure?.status ?? 400, {
      ok: false,
      error: failure?.code ?? "bad_review_commit",
    });
  }
}

async function prepareOwnerFeedback(req: Request, body: Row): Promise<Response> {
  let wallet: string;
  let feedback: ReturnType<typeof normalizeOwnerFeedback>;
  let idempotencyKey: string;
  try {
    wallet = validateWallet(body.wallet);
    feedback = normalizeOwnerFeedback(body);
    idempotencyKey = validateIdempotencyKey(body.idempotency_key);
  } catch {
    return jsonResponse(req, 400, { ok: false, error: "bad_feedback_request" });
  }
  const { data, error } = await admin.rpc("osi_v2_prepare_ai_pack_owner_feedback", {
    p_nonce: randomNonce(),
    p_owner_wallet: wallet,
    p_version_public_ref: feedback.version_ref,
    p_feedback_type: feedback.feedback_type,
    p_public_safe_summary: feedback.public_safe_summary,
    p_feedback_restricted: feedback.feedback_restricted,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error) return rpcFailure(req, error, "ai_pack_feedback_prepare_failed");
  const row = firstRow(data);
  if (!row) return jsonResponse(req, 500, { ok: false, error: "ai_pack_feedback_prepare_failed" });
  try {
    return jsonResponse(req, 200, {
      ok: true,
      ...preparedWriteDto(row, AI_PACK_OWNER_FEEDBACK_EVENT, wallet),
    });
  } catch {
    return jsonResponse(req, 503, { ok: false, error: "ai_pack_feedback_prepare_invalid" });
  }
}

async function commitOwnerFeedback(req: Request, body: Row): Promise<Response> {
  try {
    const verified = await verifySignedWrite(
      req,
      body,
      new Set([AI_PACK_OWNER_FEEDBACK_EVENT]),
    );
    const context = verified.row.binding_context ?? {};
    const feedback = normalizeOwnerFeedback({
      version_ref: context.version_public_ref,
      feedback_type: context.feedback_type,
      public_safe_summary: context.public_safe_summary,
      feedback_restricted: context.feedback_restricted,
    });
    if (verified.row.consumed_at) {
      const receipt = await consumedSignedReceipt(
        verified.row,
        verified.binding,
        "wallet_signed_server_verified",
      );
      if (!receipt) {
        return jsonResponse(req, 409, {
          ok: false,
          error: "ai_pack_feedback_binding_changed",
        });
      }
      return jsonResponse(req, 200, {
        ok: true,
        already_committed: true,
        version_ref: verified.binding.version_ref,
        feedback_type: feedback.feedback_type,
        advisory_only: true,
        review_weight: 0,
        idempotent_replay: true,
        proof: {
          event_type: AI_PACK_OWNER_FEEDBACK_EVENT,
          label: "Wallet-signed and server-verified",
          proof_type: "wallet_signed_server_verified",
          server_verified: true,
        },
      });
    }
    const blocked = await requireWriteFlags(req);
    if (blocked) return blocked;
    const { data, error } = await admin.rpc("osi_v2_commit_ai_pack_owner_feedback", {
      p_nonce: verified.nonce,
      p_feedback_type: feedback.feedback_type,
      p_public_safe_summary: feedback.public_safe_summary,
      p_feedback_restricted: feedback.feedback_restricted,
      p_signature: verified.signature,
      p_signed_message: verified.message,
    });
    if (error) return rpcFailure(req, error, "ai_pack_feedback_commit_failed");
    const row = firstRow(data);
    return jsonResponse(req, 200, {
      ok: true,
      ...committedWriteDto(row, verified.binding.version_ref),
      feedback_type: feedback.feedback_type,
      advisory_only: true,
      review_weight: 0,
      idempotent_replay: row?.idempotent_replay === true,
      proof: {
        event_type: AI_PACK_OWNER_FEEDBACK_EVENT,
        label: "Wallet-signed and server-verified",
        proof_type: "wallet_signed_server_verified",
        server_verified: true,
      },
    });
  } catch (error) {
    const failure = error instanceof GenerationExecutionError ? error : null;
    return jsonResponse(req, failure?.status ?? 400, {
      ok: false,
      error: failure?.code ?? "bad_feedback_commit",
    });
  }
}

async function prepareApproval(req: Request, body: Row): Promise<Response> {
  let wallet: string;
  let versionRef: string;
  let idempotencyKey: string;
  try {
    wallet = validateWallet(body.wallet);
    versionRef = validateVersionRef(body.version_ref);
    idempotencyKey = validateIdempotencyKey(body.idempotency_key);
  } catch {
    return jsonResponse(req, 400, { ok: false, error: "bad_approval_request" });
  }
  const maintainer = await fullMaintainer(req, wallet);
  if (!maintainer.ok) return jsonResponse(req, 403, { ok: false, error: maintainer.reason });
  const { data, error } = await admin.rpc("osi_v2_prepare_ai_pack_approval", {
    p_nonce: randomNonce(),
    p_maintainer_wallet: wallet,
    p_version_public_ref: versionRef,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
    p_maintainer_auth_uuid: maintainer.auth_id,
  });
  if (error) return rpcFailure(req, error, "ai_pack_approval_prepare_failed");
  const row = firstRow(data);
  if (!row) return jsonResponse(req, 500, { ok: false, error: "ai_pack_approval_prepare_failed" });
  try {
    const dto = preparedWriteDto(row, AI_PACK_APPROVAL_EVENT, wallet);
    return jsonResponse(req, 200, {
      ok: true,
      ...dto,
      memo: dto.message,
      message: undefined,
    });
  } catch {
    return jsonResponse(req, 503, { ok: false, error: "ai_pack_approval_prepare_invalid" });
  }
}

async function verifyMainnetMemo(
  txSig: string,
  wallet: string,
  memo: string,
  issuedAt: number,
  expiresAt: number,
) {
  if (!TX_SIG.test(txSig) || !SOLANA_RPC_URL) {
    return { ok: false, reason: !SOLANA_RPC_URL ? "rpc_unavailable" : "bad_transaction_signature" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(SOLANA_RPC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [
            txSig,
            {
              commitment: "confirmed",
              encoding: "jsonParsed",
              maxSupportedTransactionVersion: 0,
            },
          ],
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "getSignatureStatuses",
          params: [[txSig], { searchTransactionHistory: true }],
        },
        { jsonrpc: "2.0", id: 3, method: "getGenesisHash" },
      ]),
    });
  } catch {
    return { ok: false, reason: "rpc_unavailable" };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) return { ok: false, reason: "rpc_unavailable" };
  let result: Row[];
  try {
    result = await response.json() as Row[];
  } catch {
    return { ok: false, reason: "rpc_invalid_response" };
  }
  if (!Array.isArray(result)) return { ok: false, reason: "rpc_invalid_response" };
  if (result.find((entry) => entry.id === 3)?.result !== MAINNET_GENESIS_HASH) {
    return { ok: false, reason: "wrong_cluster" };
  }
  const transaction = result.find((entry) => entry.id === 1)?.result;
  const status = result.find((entry) => entry.id === 2)?.result?.value?.[0];
  return validateConfirmedMemoTransaction(transaction, status, {
    tx_sig: txSig,
    wallet,
    memo,
    issued_at: issuedAt,
    expires_at: expiresAt,
  });
}

async function committedApprovalReplay(
  nonceRow: Row,
  binding: ReturnType<typeof proofBindingFromNonce>,
  txSig: string,
  memo: string,
): Promise<Row | null> {
  const receiptId = safeText(nonceRow.consumed_by_receipt_id);
  if (!UUID.test(receiptId)) return null;
  const { data, error } = await admin.from("event_receipts")
    .select(
      "id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,decision,proof_type,tx_sig,memo_ref,server_verified,occurred_at,decision_channel",
    )
    .eq("id", receiptId)
    .limit(1);
  const receipt = data?.[0];
  if (error || !receipt || receipt.event_version !== "OSI2"
      || receipt.event_type !== AI_PACK_APPROVAL_EVENT
      || receipt.target_type !== "pack_version"
      || String(receipt.target_id) !== String(nonceRow.target_id)
      || receipt.public_ref !== binding.version_ref
      || receipt.actor_wallet !== binding.actor_wallet
      || receipt.actor_role !== "maintainer"
      || receipt.decision !== "approve"
      || receipt.proof_type !== "solana_memo"
      || receipt.decision_channel !== "standard"
      || receipt.server_verified !== true
      || receipt.tx_sig !== txSig || receipt.memo_ref !== memo) {
    return null;
  }
  return receipt;
}

async function commitApproval(req: Request, body: Row): Promise<Response> {
  let wallet: string;
  let versionRef: string;
  try {
    wallet = validateWallet(body.wallet);
    versionRef = validateVersionRef(body.version_ref);
  } catch {
    return jsonResponse(req, 400, { ok: false, error: "bad_approval_request" });
  }
  const nonce = safeText(body.nonce);
  const memo = safeText(body.memo);
  const txSig = safeText(body.tx_sig);
  const loaded = await loadBoundNonce(nonce);
  const bound = loaded.row;
  if (loaded.error || !bound || bound.purpose !== AI_PACK_APPROVAL_EVENT
      || bound.target_type !== "pack_version") {
    return jsonResponse(req, 409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  let binding;
  try {
    binding = proofBindingFromNonce(bound);
    const expectedMemo = canonicalAiPackApprovalMemo(binding);
    const verificationTime = bound.consumed_at
      ? Math.min(Math.floor(Date.now() / 1000), binding.expires_at)
      : Math.floor(Date.now() / 1000);
    const exact = validateAiPackProof(memo, binding, verificationTime);
    if (!exact.ok || memo !== expectedMemo || wallet !== bound.actor_wallet
        || versionRef !== binding.version_ref) {
      return jsonResponse(req, 409, { ok: false, error: "ai_pack_proof_binding_rejected" });
    }
  } catch {
    return jsonResponse(req, 409, { ok: false, error: "ai_pack_proof_binding_rejected" });
  }
  const maintainer = await fullMaintainer(req, wallet);
  if (!maintainer.ok) return jsonResponse(req, 403, { ok: false, error: maintainer.reason });

  if (bound.consumed_at) {
    const receipt = await committedApprovalReplay(bound, binding, txSig, memo);
    if (!receipt) {
      return jsonResponse(req, 409, { ok: false, error: "ai_pack_approval_binding_changed" });
    }
    return jsonResponse(req, 200, {
      ok: true,
      already_committed: true,
      version_ref: versionRef,
      lifecycle_state: "approved",
      idempotent_replay: true,
      proof: {
        event_type: AI_PACK_APPROVAL_EVENT,
        label: "Memo-anchored on Solana",
        proof_type: "solana_memo",
        tx_sig: txSig,
        server_verified: true,
      },
    });
  }

  const blocked = await requireWriteFlags(req, true);
  if (blocked) return blocked;
  const chain = await verifyMainnetMemo(
    txSig,
    wallet,
    memo,
    binding.issued_at,
    binding.expires_at,
  );
  if (!chain.ok) return jsonResponse(req, 409, { ok: false, error: chain.reason });
  const { data, error } = await admin.rpc("osi_v2_commit_ai_pack_approval", {
    p_nonce: nonce,
    p_tx_sig: txSig,
    p_memo_ref: memo,
    p_occurred_at: (chain as { occurred_at: string }).occurred_at,
    p_maintainer_auth_uuid: maintainer.auth_id,
  });
  if (error) return rpcFailure(req, error, "ai_pack_approval_commit_failed");
  const row = firstRow(data);
  return jsonResponse(req, 200, {
    ok: true,
    already_committed: false,
    ...committedWriteDto(row, versionRef),
    idempotent_replay: row?.idempotent_replay === true,
    proof: {
      event_type: AI_PACK_APPROVAL_EVENT,
      label: "Memo-anchored on Solana",
      proof_type: "solana_memo",
      tx_sig: txSig,
      server_verified: true,
    },
  });
}

serve(async (req: Request): Promise<Response> => {
  try {
    if (!requestOriginAllowed(req)) {
      return jsonResponse(req, 403, { ok: false, error: "origin_not_allowed" });
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    if (req.method !== "POST") {
      return jsonResponse(req, 405, { ok: false, error: "method_not_allowed" });
    }
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return jsonResponse(req, 503, { ok: false, error: "not_configured" });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) {
      return jsonResponse(req, 415, { ok: false, error: "content_type_required" });
    }
    const declaredLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return jsonResponse(req, 413, { ok: false, error: "body_too_large" });
    }
    let body: Row;
    try {
      const raw = await req.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
        return jsonResponse(req, 413, { ok: false, error: "body_too_large" });
      }
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
      body = value as Row;
    } catch {
      return jsonResponse(req, 400, { ok: false, error: "bad_json" });
    }

    switch (safeText(body.op)) {
      case "capabilities":
        return await capabilities(req, body);
      case "list_public_packs":
        return await listPublicPacks(req, body, true);
      case "list_public_case_packs":
        return await listPublicPacks(req, body, false);
      case "get_case_packs":
        return await getCasePacks(req, body);
      case "prepare_generation":
        return await prepareGeneration(req, body);
      case "commit_generation":
        return await commitGeneration(req, body);
      case "prepare_review":
        return await prepareReview(req, body);
      case "commit_review":
        return await commitReview(req, body);
      case "prepare_owner_feedback":
        return await prepareOwnerFeedback(req, body);
      case "commit_owner_feedback":
        return await commitOwnerFeedback(req, body);
      case "prepare_approval":
        return await prepareApproval(req, body);
      case "commit_approval":
        return await commitApproval(req, body);
      default:
        return jsonResponse(req, 400, { ok: false, error: "bad_op" });
    }
  } catch {
    // Never serialize or log database/provider exceptions, prompts, evidence,
    // generated text, credentials, or signatures.
    return jsonResponse(req, 500, { ok: false, error: "ai_pack_request_failed" });
  }
});
