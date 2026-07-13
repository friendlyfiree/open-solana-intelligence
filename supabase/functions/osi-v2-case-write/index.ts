// OSI V2 Case write gateway. Every native mutation is Case-scoped, uses the
// durable Stage-5 nonce store, and commits through one service-only database
// transaction after server verification. The broad V2 write/proof flags are
// intentionally not read or changed by this function.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  payloadHash,
  randomNonce,
  requestFingerprint,
  sha256HexUtf8,
  trustedClientAddress,
  validateWallet,
  verifyEd25519Signature,
} from "../_shared/osi-v2-proof-core.mjs";
import {
  canonicalCaseEventMessage,
  maintainerGate,
  normalizeCasePayload,
  normalizeReviewInput,
  validateCaseEventBinding,
  validateConfirmedMemoTransaction,
  validateIdempotencyKey,
} from "../_shared/osi-v2-case-write-core.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const SOLANA_RPC_URL = Deno.env.get("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com";
const MAINTAINER_AUTH_UUID = Deno.env.get("OSI_MAINTAINER_AUTH_UUID") ?? "";
const MAX_BODY_BYTES = 32_768;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Row = Record<string, unknown>;
type CasePayload = {
  title: string;
  category: string;
  summary_public: string;
  details_restricted: string;
  reward_intent_lamports: number | null;
  evidence: Array<{ kind: string; ref: string }>;
};
type ReviewInput = { case_ref: string; decision: string; reason_code: string };
type ReviewActor =
  | { ok: true; role: "analyst" | "senior" | "maintainer"; auth_id: string }
  | { ok: false; reason: string };

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "3600",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function isoSeconds(value: unknown): number {
  const milliseconds = Date.parse(String(value ?? ""));
  if (!Number.isFinite(milliseconds)) throw new TypeError("invalid database timestamp");
  return Math.floor(milliseconds / 1000);
}

function rpcFailure(error: Row | null): Response {
  const code = safeText(error?.code);
  if (code === "42501") return jsonResponse(403, { ok: false, error: "not_authorized" });
  if (code === "23514" || code === "22023") {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  if (code === "40001") return jsonResponse(409, { ok: false, error: "concurrent_retry" });
  if (code === "P0001") return jsonResponse(429, { ok: false, error: "rate_limited" });
  if (code === "55000") return jsonResponse(503, { ok: false, error: "case_writes_disabled_or_unavailable" });
  return jsonResponse(500, { ok: false, error: "write_failed" });
}

async function caseWritesEnabled(): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", "OSI_V2_CASE_WRITES_ENABLED").limit(1);
  return !error && data?.[0]?.value === "true";
}

async function configuredAdminWallet(): Promise<string> {
  const { data } = await admin.from("osi_config").select("value")
    .eq("key", "admin_wallet").limit(1);
  const wallet = safeText(data?.[0]?.value);
  try { return validateWallet(wallet); } catch { return ""; }
}

async function authenticatedMaintainerId(req: Request): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(MAINTAINER_AUTH_UUID)) return "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return "";
  try {
    const { data, error } = await admin.auth.getUser(token);
    return !error && data?.user?.id === MAINTAINER_AUTH_UUID ? data.user.id : "";
  } catch {
    return "";
  }
}

async function analystRole(wallet: string): Promise<"analyst" | "senior" | ""> {
  const { data } = await admin.from("analyst_profiles")
    .select("status,verified,approved,weight_cached")
    .eq("wallet", wallet).limit(1);
  const profile = data?.[0];
  if (!profile || profile.verified !== true || profile.approved !== true
      || !["probationary_analyst", "verified_analyst", "senior_analyst"].includes(profile.status)
      || Number(profile.weight_cached) < 0.5 || Number(profile.weight_cached) > 3) return "";
  return profile.status === "senior_analyst" ? "senior" : "analyst";
}

async function fullMaintainer(req: Request, wallet: string) {
  const [adminWallet, authId] = await Promise.all([
    configuredAdminWallet(), authenticatedMaintainerId(req),
  ]);
  const gate = maintainerGate(!!authId, wallet, adminWallet);
  return { ...gate, auth_id: gate.ok ? authId : "" };
}

async function caseRow(publicRef: string) {
  const { data, error } = await admin.from("cases")
    .select("id,public_ref,submitted_by_wallet,stage,visibility")
    .eq("public_ref", publicRef).limit(1);
  return { row: data?.[0] ?? null, error };
}

async function fingerprint(req: Request): Promise<string> {
  return await requestFingerprint(
    SERVICE_ROLE_KEY + "\u0000osi-v2-case-write",
    trustedClientAddress(req.headers),
  );
}

async function issueCaseNonce(args: Row) {
  return await admin.rpc("osi_v2_issue_case_nonce", args);
}

async function loadBoundNonce(nonce: string) {
  const { data, error } = await admin.from("osi_nonces")
    .select("nonce,purpose,actor_wallet,target_id,payload_hash,issued_at,expires_at,consumed_at")
    .eq("nonce", nonce).limit(1);
  return { row: data?.[0] ?? null, error };
}

function proofBinding(nonceRow: Row, publicRef: string, actorRole: string, decision: string) {
  return {
    purpose: String(nonceRow.purpose),
    public_ref: publicRef,
    actor_wallet: String(nonceRow.actor_wallet),
    actor_role: actorRole,
    decision,
    nonce: String(nonceRow.nonce),
    payload_hash: String(nonceRow.payload_hash),
    issued_at: isoSeconds(nonceRow.issued_at),
    expires_at: isoSeconds(nonceRow.expires_at),
  };
}

async function verifyMemoTransaction(txSig: string, wallet: string, memo: string, issuedAt: number, expiresAt: number) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(txSig)) {
    return { ok: false, reason: "bad_transaction_signature" };
  }
  let response: Response;
  try {
    response = await fetch(SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "getTransaction", params: [txSig, {
          commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0,
        }] },
        { jsonrpc: "2.0", id: 2, method: "getSignatureStatuses", params: [[txSig], {
          searchTransactionHistory: true,
        }] },
      ]),
    });
  } catch {
    return { ok: false, reason: "rpc_unavailable" };
  }
  if (!response.ok) return { ok: false, reason: "rpc_unavailable" };
  let results: any[];
  try { results = await response.json() as any[]; } catch { return { ok: false, reason: "rpc_invalid_response" }; }
  const transaction = results.find((item) => item.id === 1)?.result;
  const status = results.find((item) => item.id === 2)?.result?.value?.[0];
  return validateConfirmedMemoTransaction(transaction, status, {
    tx_sig: txSig, wallet, memo, issued_at: issuedAt, expires_at: expiresAt,
  });
}

async function prepareCase(req: Request, body: Row): Promise<Response> {
  if (!await caseWritesEnabled()) return jsonResponse(503, { ok: false, error: "case_writes_disabled" });
  const wallet = safeText(body.wallet);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let payload: CasePayload;
  let idempotencyKey: string;
  try {
    payload = normalizeCasePayload(body.case) as CasePayload;
    idempotencyKey = validateIdempotencyKey(body.idempotency_key);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_case_payload" });
  }
  const hash = await payloadHash(payload);
  const { data, error } = await issueCaseNonce({
    p_nonce: randomNonce(), p_purpose: "CASE_SUBMITTED", p_actor_wallet: wallet,
    p_actor_role: "owner", p_target_id: null, p_payload_hash: hash,
    p_idempotency_key: idempotencyKey, p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const issued = data[0];
  const binding = {
    purpose: "CASE_SUBMITTED", public_ref: issued.public_ref, actor_wallet: wallet,
    actor_role: "owner", decision: "submit", nonce: issued.issued_nonce,
    payload_hash: hash, issued_at: isoSeconds(issued.issued_at),
    expires_at: isoSeconds(issued.expires_at),
  };
  return jsonResponse(200, {
    ok: true, public_ref: issued.public_ref, nonce: issued.issued_nonce,
    payload_hash: hash, memo: canonicalCaseEventMessage(binding),
    expires_at: binding.expires_at, idempotent_replay: issued.idempotent_replay === true,
  });
}

async function commitCase(body: Row): Promise<Response> {
  if (!await caseWritesEnabled()) return jsonResponse(503, { ok: false, error: "case_writes_disabled" });
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const memo = safeText(body.memo);
  const txSig = safeText(body.tx_sig);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let payload: CasePayload;
  try { payload = normalizeCasePayload(body.case) as CasePayload; }
  catch (error) { return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_case_payload" }); }
  const hash = await payloadHash(payload);
  const nonceResult = await loadBoundNonce(nonce);
  const bound = nonceResult.row;
  if (nonceResult.error || !bound || bound.purpose !== "CASE_SUBMITTED") {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  const publicRef = "OSI-" + String(bound.target_id).replaceAll("-", "").slice(0, 12).toUpperCase();
  const binding = proofBinding(bound, publicRef, "owner", "submit");
  const exact = validateCaseEventBinding(memo, binding, Math.floor(Date.now() / 1000));
  if (!exact.ok || bound.actor_wallet !== wallet || bound.payload_hash !== hash) {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  const chain = await verifyMemoTransaction(txSig, wallet, memo, binding.issued_at, binding.expires_at);
  if (!chain.ok) return jsonResponse(409, { ok: false, error: chain.reason });
  const evidence = await Promise.all(payload.evidence.map(async (item) => ({
    kind: item.kind, ref: item.ref, sha256: await sha256HexUtf8(String(item.ref)),
  })));
  const { data, error } = await admin.rpc("osi_v2_commit_case_submission", {
    p_nonce: nonce, p_payload_hash: hash, p_title: payload.title,
    p_category: payload.category, p_summary_public: payload.summary_public,
    p_details_restricted: payload.details_restricted,
    p_reward_intent_lamports: payload.reward_intent_lamports,
    p_evidence: evidence, p_tx_sig: txSig, p_memo_ref: memo,
    p_occurred_at: (chain as { occurred_at: string }).occurred_at,
  });
  if (error || !data?.[0]) return rpcFailure(error);
  return jsonResponse(200, {
    ok: true, case: { public_ref: data[0].public_ref, stage: "initial_review", visibility: "private" },
    proof: { label: "Memo-anchored on Solana", tx_sig: txSig },
    idempotent_replay: data[0].idempotent_replay === true,
  });
}

async function resolveReviewActor(
  req: Request,
  wallet: string,
  requestedRoute: string,
): Promise<ReviewActor> {
  const [role, maintainer] = await Promise.all([analystRole(wallet), fullMaintainer(req, wallet)]);
  if (requestedRoute === "maintainer") {
    return maintainer.ok
      ? { ok: true, role: "maintainer", auth_id: maintainer.auth_id }
      : { ok: false, reason: maintainer.reason ?? "maintainer_denied" };
  }
  if (role) return { ok: true, role, auth_id: "" };
  if (maintainer.ok) return { ok: true, role: "maintainer", auth_id: maintainer.auth_id };
  return { ok: false, reason: "not_eligible_reviewer" };
}

async function prepareReview(req: Request, body: Row): Promise<Response> {
  if (!await caseWritesEnabled()) return jsonResponse(503, { ok: false, error: "case_writes_disabled" });
  const wallet = safeText(body.wallet);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let input: ReviewInput;
  let idempotencyKey: string;
  try {
    input = normalizeReviewInput(body.review) as ReviewInput;
    idempotencyKey = validateIdempotencyKey(body.idempotency_key);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_review_payload" });
  }
  const found = await caseRow(String(input.case_ref));
  if (found.error || !found.row || found.row.stage !== "initial_review" || found.row.visibility !== "private") {
    return jsonResponse(404, { ok: false, error: "not_found_or_not_reviewable" });
  }
  if (found.row.submitted_by_wallet === wallet) return jsonResponse(403, { ok: false, error: "self_review_denied" });
  const actor = await resolveReviewActor(req, wallet, safeText(body.route));
  if (!actor.ok) return jsonResponse(403, { ok: false, error: actor.reason });
  if (actor.role === "maintainer" && input.decision !== "approve_open") {
    return jsonResponse(403, { ok: false, error: "maintainer_acknowledgement_is_approve_only" });
  }
  const { data: history } = await admin.from("case_initial_reviews").select("id")
    .eq("case_id", found.row.id).eq("reviewer_wallet", wallet).limit(1);
  const purpose = history?.length ? "CASE_INITIAL_REVIEW_REVISED" : "CASE_INITIAL_REVIEW_CAST";
  const signedPayload = {
    case_ref: input.case_ref, decision: input.decision, reason_code: input.reason_code,
    actor_role: actor.role,
    maintainer_auth_id: actor.role === "maintainer" ? actor.auth_id : null,
  };
  const hash = await payloadHash(signedPayload);
  const { data, error } = await issueCaseNonce({
    p_nonce: randomNonce(), p_purpose: purpose, p_actor_wallet: wallet,
    p_actor_role: actor.role, p_target_id: found.row.id, p_payload_hash: hash,
    p_idempotency_key: idempotencyKey, p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const issued = data[0];
  const binding = {
    purpose, public_ref: input.case_ref, actor_wallet: wallet, actor_role: actor.role,
    decision: input.decision, nonce: issued.issued_nonce, payload_hash: hash,
    issued_at: isoSeconds(issued.issued_at), expires_at: isoSeconds(issued.expires_at),
  };
  return jsonResponse(200, {
    ok: true, actor_role: actor.role, counted_weight: actor.role === "maintainer" ? 0 : "server-derived",
    nonce: issued.issued_nonce, payload_hash: hash,
    message: canonicalCaseEventMessage(binding), expires_at: binding.expires_at,
  });
}

async function commitReview(req: Request, body: Row): Promise<Response> {
  if (!await caseWritesEnabled()) return jsonResponse(503, { ok: false, error: "case_writes_disabled" });
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const message = safeText(body.message);
  const signature = safeText(body.signature);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let input: ReviewInput;
  try { input = normalizeReviewInput(body.review) as ReviewInput; }
  catch (error) { return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_review_payload" }); }
  const found = await caseRow(String(input.case_ref));
  if (found.error || !found.row) return jsonResponse(404, { ok: false, error: "not_found_or_denied" });
  const actor = await resolveReviewActor(req, wallet, safeText(body.route));
  if (!actor.ok) return jsonResponse(403, { ok: false, error: actor.reason });
  const signedPayload = {
    case_ref: input.case_ref, decision: input.decision, reason_code: input.reason_code,
    actor_role: actor.role,
    maintainer_auth_id: actor.role === "maintainer" ? actor.auth_id : null,
  };
  const hash = await payloadHash(signedPayload);
  const nonceResult = await loadBoundNonce(nonce);
  const bound = nonceResult.row;
  if (nonceResult.error || !bound || !["CASE_INITIAL_REVIEW_CAST", "CASE_INITIAL_REVIEW_REVISED"].includes(bound.purpose)) {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  const binding = proofBinding(bound, String(input.case_ref), actor.role, String(input.decision));
  const exact = validateCaseEventBinding(message, binding, Math.floor(Date.now() / 1000));
  if (!exact.ok || bound.actor_wallet !== wallet || bound.target_id !== found.row.id || bound.payload_hash !== hash) {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  if (!await verifyEd25519Signature(message, signature, wallet)) {
    return jsonResponse(403, { ok: false, error: "bad_signature" });
  }
  const { data, error } = await admin.rpc("osi_v2_commit_case_review", {
    p_nonce: nonce, p_payload_hash: hash, p_signature: signature,
    p_actor_role: actor.role, p_decision: input.decision, p_reason_code: input.reason_code,
  });
  if (error || !data?.[0]) return rpcFailure(error);
  return jsonResponse(200, {
    ok: true, public_ref: data[0].public_ref, actor_role: actor.role,
    analyst_ready: data[0].analyst_ready === true,
    maintainer_ready: data[0].maintainer_ready === true,
    open_ready: data[0].open_ready === true,
    actor_open_ready: actor.role === "maintainer"
      ? data[0].maintainer_ready === true
      : data[0].analyst_ready === true && input.decision === "approve_open",
    proof: { label: "Wallet-signed & server-verified" },
    idempotent_replay: data[0].idempotent_replay === true,
    next_step: actor.role === "maintainer" && data[0].maintainer_ready === true
      ? "This full maintainer may anchor CASE_OPENED on Solana."
      : data[0].analyst_ready === true && input.decision === "approve_open"
      ? "This eligible approving analyst may anchor CASE_OPENED on Solana."
      : "Waiting for either the analyst threshold or a full maintainer approval.",
  });
}

function openPayload(caseRef: string, actorRole: string) {
  return {
    case_ref: caseRef,
    outcome: "open",
    actor_role: actorRole,
    opening_path: actorRole === "maintainer" ? "maintainer" : "analyst",
    analyst_required_count: 1,
    analyst_required_weight: "0.50",
    maintainer_double_gate_required: actorRole === "maintainer",
  };
}

async function prepareOpen(req: Request, body: Row): Promise<Response> {
  if (!await caseWritesEnabled()) return jsonResponse(503, { ok: false, error: "case_writes_disabled" });
  const wallet = safeText(body.wallet);
  const publicRef = safeText(body.case_ref);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let idempotencyKey: string;
  try { idempotencyKey = validateIdempotencyKey(body.idempotency_key); }
  catch { return jsonResponse(400, { ok: false, error: "bad_idempotency_key" }); }
  const actor = await resolveReviewActor(req, wallet, safeText(body.route));
  if (!actor.ok) return jsonResponse(403, { ok: false, error: actor.reason });
  const found = await caseRow(publicRef);
  if (found.error || !found.row) return jsonResponse(404, { ok: false, error: "not_found_or_denied" });
  if (found.row.submitted_by_wallet === wallet) {
    return jsonResponse(403, { ok: false, error: "self_review_denied" });
  }
  const hash = await payloadHash(openPayload(publicRef, actor.role));
  const { data, error } = await issueCaseNonce({
    p_nonce: randomNonce(), p_purpose: "CASE_OPENED", p_actor_wallet: wallet,
    p_actor_role: actor.role, p_target_id: found.row.id, p_payload_hash: hash,
    p_idempotency_key: idempotencyKey, p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const issued = data[0];
  const binding = {
    purpose: "CASE_OPENED", public_ref: publicRef, actor_wallet: wallet,
    actor_role: actor.role, decision: "open", nonce: issued.issued_nonce,
    payload_hash: hash, issued_at: isoSeconds(issued.issued_at),
    expires_at: isoSeconds(issued.expires_at),
  };
  return jsonResponse(200, {
    ok: true, nonce: issued.issued_nonce, payload_hash: hash,
    actor_role: actor.role,
    opening_path: actor.role === "maintainer" ? "maintainer" : "analyst",
    memo: canonicalCaseEventMessage(binding), expires_at: binding.expires_at,
  });
}

async function commitOpen(req: Request, body: Row): Promise<Response> {
  if (!await caseWritesEnabled()) return jsonResponse(503, { ok: false, error: "case_writes_disabled" });
  const wallet = safeText(body.wallet);
  const publicRef = safeText(body.case_ref);
  const nonce = safeText(body.nonce);
  const memo = safeText(body.memo);
  const txSig = safeText(body.tx_sig);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  const actor = await resolveReviewActor(req, wallet, safeText(body.route));
  if (!actor.ok) return jsonResponse(403, { ok: false, error: actor.reason });
  const found = await caseRow(publicRef);
  if (found.error || !found.row) return jsonResponse(404, { ok: false, error: "not_found_or_denied" });
  if (found.row.submitted_by_wallet === wallet) {
    return jsonResponse(403, { ok: false, error: "self_review_denied" });
  }
  const hash = await payloadHash(openPayload(publicRef, actor.role));
  const nonceResult = await loadBoundNonce(nonce);
  const bound = nonceResult.row;
  if (nonceResult.error || !bound || bound.purpose !== "CASE_OPENED") {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  const binding = proofBinding(bound, publicRef, actor.role, "open");
  const exact = validateCaseEventBinding(memo, binding, Math.floor(Date.now() / 1000));
  if (!exact.ok || bound.actor_wallet !== wallet || bound.target_id !== found.row.id || bound.payload_hash !== hash) {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  const chain = await verifyMemoTransaction(txSig, wallet, memo, binding.issued_at, binding.expires_at);
  if (!chain.ok) return jsonResponse(409, { ok: false, error: chain.reason });
  const { data, error } = await admin.rpc("osi_v2_commit_case_open", {
    p_nonce: nonce, p_payload_hash: hash, p_tx_sig: txSig,
    p_memo_ref: memo, p_occurred_at: (chain as { occurred_at: string }).occurred_at,
  });
  if (error || !data?.[0]) return rpcFailure(error);
  return jsonResponse(200, {
    ok: true, case: { public_ref: data[0].public_ref, stage: "open_public", visibility: "public" },
    actor_role: actor.role,
    opening_path: actor.role === "maintainer" ? "maintainer" : "analyst",
    proof: { label: "Memo-anchored on Solana", tx_sig: txSig },
    idempotent_replay: data[0].idempotent_replay === true,
  });
}

async function actorCapabilities(req: Request, body: Row): Promise<Response> {
  const wallet = safeText(body.wallet);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  const [role, maintainer, enabled] = await Promise.all([
    analystRole(wallet), fullMaintainer(req, wallet), caseWritesEnabled(),
  ]);
  return jsonResponse(200, {
    ok: true, case_writes_enabled: enabled, analyst_eligible: !!role,
    analyst_role: role || null, maintainer_access: maintainer.ok === true,
    maintainer_gate: maintainer.ok ? "full" : maintainer.reason,
    maintainer_review_effect: "independent_initial_open_path",
    maintainer_can_open: maintainer.ok === true,
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return jsonResponse(503, { ok: false, error: "not_configured" });
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { ok: false, error: "body_too_large" });
  }
  let body: Row;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) throw new RangeError();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
    body = parsed as Row;
  } catch (error) {
    return jsonResponse(error instanceof RangeError ? 413 : 400, {
      ok: false, error: error instanceof RangeError ? "body_too_large" : "bad_json",
    });
  }

  switch (body.op) {
    case "prepare_case": return await prepareCase(req, body);
    case "commit_case": return await commitCase(body);
    case "prepare_review": return await prepareReview(req, body);
    case "commit_review": return await commitReview(req, body);
    case "prepare_open": return await prepareOpen(req, body);
    case "commit_open": return await commitOpen(req, body);
    case "actor_capabilities": return await actorCapabilities(req, body);
    default: return jsonResponse(400, { ok: false, error: "bad_op" });
  }
});
