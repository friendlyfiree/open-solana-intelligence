// OSI V2 native Case Report write gateway. The browser never receives a
// service credential and cannot choose author, version number, lifecycle,
// receipt type, or Case eligibility. The database revalidates the complete
// payload and commits all effects atomically after mainnet Memo confirmation.

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
  REPORT_EVENT_TYPE,
  REPORT_PUBLICATION_EVENT_TYPE,
  REPORT_REVIEW_EVENT_TYPES,
  canonicalReportMemo,
  canonicalReportGovernanceMessage,
  normalizeReportPayload,
  normalizeReportReview,
  validateConfirmedReportTransaction,
  validateReportGovernanceBinding,
  validateReportIdempotencyKey,
  validateReportMemoBinding,
} from "../_shared/osi-v2-report-core.mjs";
import { maintainerGate } from "../_shared/osi-v2-case-write-core.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const SOLANA_RPC_URL = Deno.env.get("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com";
const MAINTAINER_AUTH_UUID = Deno.env.get("OSI_MAINTAINER_AUTH_UUID") ?? "";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MAX_BODY_BYTES = 180_000;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Row = Record<string, any>;
type ReportPayload = {
  body_private: string;
  content_public_safe: string | null;
  revision_reason_code: string | null;
  evidence: Array<{ kind: string; ref: string; sha256: string }>;
};
type ReviewPayload = {
  version_public_ref: string;
  decision: "approve" | "reject" | "request_revision" | "abstain";
  reason_code: string;
  public_rationale: string;
  private_note: string | null;
};

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

function rpcFailure(error: Row | null, governance = false): Response {
  const code = safeText(error?.code);
  if (code === "42501") {
    return governance
      ? jsonResponse(403, { ok: false, error: "not_eligible_or_self_review" })
      : jsonResponse(404, { ok: false, error: "case_not_available" });
  }
  if (code === "23514" || code === "22023") {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  if (code === "40001") return jsonResponse(409, { ok: false, error: "lineage_changed_retry" });
  if (code === "P0001") return jsonResponse(429, { ok: false, error: "rate_limited" });
  if (code === "55000") return jsonResponse(503, { ok: false, error: "report_writes_disabled_or_unavailable" });
  return jsonResponse(500, { ok: false, error: "report_write_failed" });
}

async function reportWritesEnabled(): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", "OSI_V2_REPORT_WRITES_ENABLED").limit(1);
  return !error && data?.[0]?.value === "true";
}

async function reportReviewWritesEnabled(): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", "OSI_V2_REPORT_REVIEW_WRITES_ENABLED").limit(1);
  return !error && data?.[0]?.value === "true";
}

async function eligibleCase(publicRef: string) {
  const { data, error } = await admin.from("cases")
    .select("id,public_ref,stage,visibility")
    .eq("public_ref", publicRef)
    .eq("visibility", "public")
    .in("stage", ["open_public", "in_review", "reopened"])
    .limit(1);
  return { row: data?.[0] ?? null, error };
}

async function fingerprint(req: Request): Promise<string> {
  return await requestFingerprint(
    SERVICE_ROLE_KEY + "\u0000osi-v2-report-write",
    trustedClientAddress(req.headers),
  );
}

async function loadBoundNonce(nonce: string) {
  const { data, error } = await admin.from("osi_nonces")
    .select("nonce,purpose,actor_wallet,target_type,target_id,payload_hash,issued_at,expires_at,consumed_at,consumed_by_receipt_id,binding_context")
    .eq("nonce", nonce).limit(1);
  return { row: data?.[0] ?? null, error };
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
  } catch { return ""; }
}

// The D17 bootstrap publication channel is requested explicitly. Both gates
// (configured admin wallet AND authenticated maintainer identity) must pass
// here, and the database independently re-verifies them plus the live tier.
async function fullMaintainer(req: Request, wallet: string) {
  const [adminWallet, authId] = await Promise.all([
    configuredAdminWallet(), authenticatedMaintainerId(req),
  ]);
  const gate = maintainerGate(!!authId, wallet, adminWallet);
  return { ...gate, auth_id: gate.ok ? authId : "" };
}

async function exactVersion(versionRef: string) {
  const { data, error } = await admin.from("case_report_versions")
    .select("id,version_ref,report_id,lifecycle_state")
    .eq("version_ref", versionRef).limit(1);
  return { row: data?.[0] ?? null, error };
}

function memoBinding(nonceRow: Row) {
  const context = nonceRow.binding_context ?? {};
  const versionNo = Number(context.version_no);
  return {
    purpose: REPORT_EVENT_TYPE,
    version_public_ref: String(context.version_public_ref ?? ""),
    actor_wallet: String(nonceRow.actor_wallet),
    actor_role: "wallet",
    decision: versionNo === 1 ? "submit" : "revise",
    nonce: String(nonceRow.nonce),
    payload_hash: String(nonceRow.payload_hash),
    issued_at: isoSeconds(nonceRow.issued_at),
    expires_at: isoSeconds(nonceRow.expires_at),
  };
}

function governanceBinding(nonceRow: Row, decision: string) {
  const context = nonceRow.binding_context ?? {};
  return {
    purpose: String(nonceRow.purpose),
    version_public_ref: String(context.version_public_ref ?? ""),
    actor_wallet: String(nonceRow.actor_wallet),
    actor_role: String(context.actor_role ?? ""),
    decision,
    nonce: String(nonceRow.nonce),
    payload_hash: String(nonceRow.payload_hash),
    issued_at: isoSeconds(nonceRow.issued_at),
    expires_at: isoSeconds(nonceRow.expires_at),
  };
}

async function verifyMainnetMemoTransaction(
  txSig: string,
  wallet: string,
  memo: string,
  issuedAt: number,
  expiresAt: number,
) {
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
        { jsonrpc: "2.0", id: 3, method: "getGenesisHash" },
      ]),
    });
  } catch {
    return { ok: false, reason: "rpc_unavailable" };
  }
  if (!response.ok) return { ok: false, reason: "rpc_unavailable" };
  let results: Row[];
  try { results = await response.json() as Row[]; }
  catch { return { ok: false, reason: "rpc_invalid_response" }; }
  if (!Array.isArray(results)) return { ok: false, reason: "rpc_invalid_response" };
  if (results.find((item) => item.id === 3)?.result !== MAINNET_GENESIS_HASH) {
    return { ok: false, reason: "wrong_cluster" };
  }
  const transaction = results.find((item) => item.id === 1)?.result;
  const status = results.find((item) => item.id === 2)?.result?.value?.[0];
  return validateConfirmedReportTransaction(transaction, status, {
    tx_sig: txSig, wallet, memo, issued_at: issuedAt, expires_at: expiresAt,
  });
}

async function prepareReport(req: Request, body: Row): Promise<Response> {
  if (!await reportWritesEnabled()) {
    return jsonResponse(503, { ok: false, error: "report_writes_disabled" });
  }
  const wallet = safeText(body.wallet);
  const caseRef = safeText(body.case_ref);
  try { validateWallet(wallet); }
  catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  if (!/^OSI-[0-9A-F]{12}$/.test(caseRef)) {
    return jsonResponse(404, { ok: false, error: "case_not_available" });
  }
  let report: ReportPayload;
  let idempotencyKey: string;
  try {
    report = await normalizeReportPayload(body.report) as ReportPayload;
    idempotencyKey = validateReportIdempotencyKey(body.idempotency_key);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_report_payload" });
  }
  const found = await eligibleCase(caseRef);
  if (found.error || !found.row) {
    return jsonResponse(404, { ok: false, error: "case_not_available" });
  }
  const { data, error } = await admin.rpc("osi_v2_prepare_report_version", {
    p_nonce: randomNonce(),
    p_actor_wallet: wallet,
    p_case_id: found.row.id,
    p_body_private: report.body_private,
    p_content_public_safe: report.content_public_safe,
    p_revision_reason_code: report.revision_reason_code,
    p_evidence: report.evidence,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const issued = data[0];
  if (issued.consumed_receipt_id) {
    return jsonResponse(200, {
      ok: true,
      already_committed: true,
      case_public_ref: issued.case_public_ref,
      report_public_ref: issued.report_public_ref,
      version_public_ref: issued.version_public_ref,
      version_no: issued.version_no,
      receipt_id: issued.consumed_receipt_id,
      idempotent_replay: true,
    });
  }
  const binding = {
    purpose: REPORT_EVENT_TYPE,
    version_public_ref: issued.version_public_ref,
    actor_wallet: wallet,
    actor_role: "wallet",
    decision: Number(issued.version_no) === 1 ? "submit" : "revise",
    nonce: issued.issued_nonce,
    payload_hash: issued.payload_hash,
    issued_at: isoSeconds(issued.issued_at),
    expires_at: isoSeconds(issued.expires_at),
  };
  return jsonResponse(200, {
    ok: true,
    already_committed: false,
    case_public_ref: issued.case_public_ref,
    report_public_ref: issued.report_public_ref,
    version_public_ref: issued.version_public_ref,
    version_no: issued.version_no,
    evidence_manifest_hash: issued.evidence_manifest_hash,
    nonce: issued.issued_nonce,
    payload_hash: issued.payload_hash,
    memo: canonicalReportMemo(binding),
    expires_at: binding.expires_at,
    idempotent_replay: issued.idempotent_replay === true,
  });
}

async function commitReport(body: Row): Promise<Response> {
  if (!await reportWritesEnabled()) {
    return jsonResponse(503, { ok: false, error: "report_writes_disabled" });
  }
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const memo = safeText(body.memo);
  const txSig = safeText(body.tx_sig);
  try { validateWallet(wallet); }
  catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let report: ReportPayload;
  try { report = await normalizeReportPayload(body.report) as ReportPayload; }
  catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_report_payload" });
  }
  const nonceResult = await loadBoundNonce(nonce);
  const bound = nonceResult.row;
  if (nonceResult.error || !bound || bound.purpose !== REPORT_EVENT_TYPE
      || bound.target_type !== "report_version") {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  const binding = memoBinding(bound);
  // A consumed nonce may be retried after its issuance window. Exact binding,
  // the original confirmed transaction and the database receipt must still
  // match, but expiry cannot turn an already committed action into a duplicate.
  const verificationTime = bound.consumed_at
    ? Math.min(Math.floor(Date.now() / 1000), binding.expires_at)
    : Math.floor(Date.now() / 1000);
  const exact = validateReportMemoBinding(memo, binding, verificationTime);
  if (!exact.ok || bound.actor_wallet !== wallet) {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  const chain = await verifyMainnetMemoTransaction(
    txSig, wallet, memo, binding.issued_at, binding.expires_at,
  );
  if (!chain.ok) return jsonResponse(409, { ok: false, error: chain.reason });
  const { data, error } = await admin.rpc("osi_v2_commit_report_version", {
    p_nonce: nonce,
    p_body_private: report.body_private,
    p_content_public_safe: report.content_public_safe,
    p_revision_reason_code: report.revision_reason_code,
    p_evidence: report.evidence,
    p_tx_sig: txSig,
    p_memo_ref: memo,
    p_occurred_at: (chain as { occurred_at: string }).occurred_at,
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const committed = data[0];
  return jsonResponse(200, {
    ok: true,
    case_public_ref: committed.case_public_ref,
    report_public_ref: committed.report_public_ref,
    version_public_ref: committed.version_public_ref,
    version_no: committed.version_no,
    lifecycle_state: "submitted",
    proof: {
      event_type: REPORT_EVENT_TYPE,
      label: "Memo-anchored on Solana",
      proof_type: "solana_memo",
      tx_sig: txSig,
      server_verified: true,
    },
    idempotent_replay: committed.idempotent_replay === true,
  });
}

async function prepareReview(req: Request, body: Row): Promise<Response> {
  if (!await reportReviewWritesEnabled()) {
    return jsonResponse(503, { ok: false, error: "report_review_writes_disabled" });
  }
  const wallet = safeText(body.wallet);
  try { validateWallet(wallet); }
  catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let review: ReviewPayload;
  let idempotencyKey: string;
  try {
    review = normalizeReportReview(body.review) as ReviewPayload;
    idempotencyKey = validateReportIdempotencyKey(body.idempotency_key);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_review_payload" });
  }
  const found = await exactVersion(review.version_public_ref);
  if (found.error || !found.row) {
    return jsonResponse(404, { ok: false, error: "report_version_not_available" });
  }
  const { data, error } = await admin.rpc("osi_v2_prepare_report_review", {
    p_nonce: randomNonce(),
    p_actor_wallet: wallet,
    p_version_id: found.row.id,
    p_decision: review.decision,
    p_reason_code: review.reason_code,
    p_public_rationale: review.public_rationale,
    p_private_note: review.private_note,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error, true);
  const issued = data[0];
  if (issued.consumed_receipt_id) {
    return jsonResponse(200, {
      ok: true,
      already_committed: true,
      case_public_ref: issued.case_public_ref,
      report_public_ref: issued.report_public_ref,
      version_public_ref: issued.version_public_ref,
      review_public_ref: issued.review_public_ref,
      idempotent_replay: true,
    });
  }
  const binding = {
    purpose: issued.purpose,
    version_public_ref: issued.version_public_ref,
    actor_wallet: wallet,
    actor_role: issued.actor_role,
    decision: review.decision,
    nonce: issued.issued_nonce,
    payload_hash: issued.payload_hash,
    issued_at: isoSeconds(issued.issued_at),
    expires_at: isoSeconds(issued.expires_at),
  };
  return jsonResponse(200, {
    ok: true,
    already_committed: false,
    case_public_ref: issued.case_public_ref,
    report_public_ref: issued.report_public_ref,
    version_public_ref: issued.version_public_ref,
    review_public_ref: issued.review_public_ref,
    actor_role: issued.actor_role,
    nonce: issued.issued_nonce,
    payload_hash: issued.payload_hash,
    message: canonicalReportGovernanceMessage(binding),
    expires_at: binding.expires_at,
    idempotent_replay: issued.idempotent_replay === true,
  });
}

async function commitReview(body: Row): Promise<Response> {
  if (!await reportReviewWritesEnabled()) {
    return jsonResponse(503, { ok: false, error: "report_review_writes_disabled" });
  }
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const message = safeText(body.message);
  const signature = safeText(body.signature);
  try { validateWallet(wallet); }
  catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let review: ReviewPayload;
  try { review = normalizeReportReview(body.review) as ReviewPayload; }
  catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_review_payload" });
  }
  const nonceResult = await loadBoundNonce(nonce);
  const bound = nonceResult.row;
  if (nonceResult.error || !bound || !REPORT_REVIEW_EVENT_TYPES.has(bound.purpose)
      || bound.target_type !== "report_version") {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  const binding = governanceBinding(bound, review.decision);
  const verificationTime = bound.consumed_at
    ? Math.min(Math.floor(Date.now() / 1000), binding.expires_at)
    : Math.floor(Date.now() / 1000);
  const exact = validateReportGovernanceBinding(message, binding, verificationTime);
  if (!exact.ok || bound.actor_wallet !== wallet
      || binding.version_public_ref !== review.version_public_ref) {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  if (!await verifyEd25519Signature(message, signature, wallet)) {
    return jsonResponse(403, { ok: false, error: "bad_signature" });
  }
  const { data, error } = await admin.rpc("osi_v2_commit_report_review", {
    p_nonce: nonce,
    p_decision: review.decision,
    p_reason_code: review.reason_code,
    p_public_rationale: review.public_rationale,
    p_private_note: review.private_note,
    p_signature: signature,
    p_message: message,
  });
  if (error || !data?.[0]) return rpcFailure(error, true);
  const committed = data[0];
  return jsonResponse(200, {
    ok: true,
    case_public_ref: committed.case_public_ref,
    report_public_ref: committed.report_public_ref,
    version_public_ref: committed.version_public_ref,
    review_public_ref: committed.review_public_ref,
    actor_role: committed.actor_role,
    decision: committed.decision,
    weight: Number(committed.weight),
    tier_snapshot: committed.tier_snapshot,
    quorum: {
      approve_count: Number(committed.approve_count),
      approve_weight: Number(committed.approve_weight),
      required_count: Number(committed.required_count),
      required_weight: Number(committed.required_weight),
      approve_ready: committed.approve_ready === true,
    },
    proof: {
      event_type: String(bound.purpose),
      label: "Wallet-signed and server-verified",
      proof_type: "wallet_signed_server_verified",
      actor_role: committed.actor_role,
      server_verified: true,
    },
    idempotent_replay: committed.idempotent_replay === true,
  });
}

async function preparePublication(req: Request, body: Row): Promise<Response> {
  if (!await reportReviewWritesEnabled()) {
    return jsonResponse(503, { ok: false, error: "report_review_writes_disabled" });
  }
  const wallet = safeText(body.wallet);
  const versionRef = safeText(body.version_public_ref);
  let idempotencyKey: string;
  try {
    validateWallet(wallet);
    idempotencyKey = validateReportIdempotencyKey(body.idempotency_key);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_publication_payload" });
  }
  const found = await exactVersion(versionRef);
  if (found.error || !found.row) {
    return jsonResponse(404, { ok: false, error: "report_version_not_available" });
  }
  let maintainerAuthId = "";
  if (safeText(body.route) === "maintainer_bootstrap") {
    const gate = await fullMaintainer(req, wallet);
    if (!gate.ok) return jsonResponse(403, { ok: false, error: gate.reason });
    maintainerAuthId = gate.auth_id;
  }
  const { data, error } = await admin.rpc("osi_v2_prepare_report_publication", {
    p_nonce: randomNonce(),
    p_actor_wallet: wallet,
    p_version_id: found.row.id,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
    p_maintainer_auth_uuid: maintainerAuthId || null,
  });
  if (error || !data?.[0]) return rpcFailure(error, true);
  const issued = data[0];
  if (issued.consumed_receipt_id) {
    return jsonResponse(200, {
      ok: true,
      already_committed: true,
      case_public_ref: issued.case_public_ref,
      report_public_ref: issued.report_public_ref,
      version_public_ref: issued.version_public_ref,
      idempotent_replay: true,
    });
  }
  const binding = {
    purpose: REPORT_PUBLICATION_EVENT_TYPE,
    version_public_ref: issued.version_public_ref,
    actor_wallet: wallet,
    actor_role: issued.actor_role,
    decision: "publish",
    nonce: issued.issued_nonce,
    payload_hash: issued.payload_hash,
    issued_at: isoSeconds(issued.issued_at),
    expires_at: isoSeconds(issued.expires_at),
  };
  return jsonResponse(200, {
    ok: true,
    already_committed: false,
    case_public_ref: issued.case_public_ref,
    report_public_ref: issued.report_public_ref,
    version_public_ref: issued.version_public_ref,
    actor_role: issued.actor_role,
    quorum_hash: issued.quorum_hash,
    nonce: issued.issued_nonce,
    payload_hash: issued.payload_hash,
    memo: canonicalReportGovernanceMessage(binding),
    expires_at: binding.expires_at,
    idempotent_replay: issued.idempotent_replay === true,
  });
}

async function commitPublication(req: Request, body: Row): Promise<Response> {
  if (!await reportReviewWritesEnabled()) {
    return jsonResponse(503, { ok: false, error: "report_review_writes_disabled" });
  }
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const memo = safeText(body.memo);
  const txSig = safeText(body.tx_sig);
  const versionRef = safeText(body.version_public_ref);
  try { validateWallet(wallet); }
  catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  const nonceResult = await loadBoundNonce(nonce);
  const bound = nonceResult.row;
  if (nonceResult.error || !bound || bound.purpose !== REPORT_PUBLICATION_EVENT_TYPE
      || bound.target_type !== "report_version") {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  const binding = governanceBinding(bound, "publish");
  const verificationTime = bound.consumed_at
    ? Math.min(Math.floor(Date.now() / 1000), binding.expires_at)
    : Math.floor(Date.now() / 1000);
  const exact = validateReportGovernanceBinding(memo, binding, verificationTime);
  if (!exact.ok || bound.actor_wallet !== wallet || binding.version_public_ref !== versionRef) {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  const chain = await verifyMainnetMemoTransaction(
    txSig, wallet, memo, binding.issued_at, binding.expires_at,
  );
  if (!chain.ok) return jsonResponse(409, { ok: false, error: chain.reason });
  let maintainerAuthId = "";
  if (bound.binding_context?.decision_channel === "maintainer_bootstrap") {
    const gate = await fullMaintainer(req, wallet);
    if (!gate.ok) return jsonResponse(403, { ok: false, error: gate.reason });
    maintainerAuthId = gate.auth_id;
  }
  const { data, error } = await admin.rpc("osi_v2_commit_report_publication", {
    p_nonce: nonce,
    p_tx_sig: txSig,
    p_memo_ref: memo,
    p_occurred_at: (chain as { occurred_at: string }).occurred_at,
    p_maintainer_auth_uuid: maintainerAuthId || null,
  });
  if (error || !data?.[0]) return rpcFailure(error, true);
  const committed = data[0];
  const bootstrapChannel = bound.binding_context?.decision_channel === "maintainer_bootstrap";
  return jsonResponse(200, {
    ok: true,
    case_public_ref: committed.case_public_ref,
    report_public_ref: committed.report_public_ref,
    version_public_ref: committed.version_public_ref,
    lifecycle_state: "published",
    actor_role: committed.actor_role,
    quorum_hash: committed.quorum_hash,
    previous_published_version_ref: committed.previous_published_version_ref,
    decision_channel: bootstrapChannel ? "maintainer_bootstrap" : "standard",
    proof: {
      event_type: REPORT_PUBLICATION_EVENT_TYPE,
      label: "Memo-anchored on Solana",
      proof_type: "solana_memo",
      actor_role: committed.actor_role,
      tx_sig: txSig,
      server_verified: true,
      decision_channel: bootstrapChannel ? "maintainer_bootstrap" : "standard",
    },
    case_lifecycle_changed: false,
    process_notice: bootstrapChannel
      ? "Publication was finalized through the maintainer bootstrap (cold-start) channel, not an independent analyst quorum. It is not proof of truth, guilt, or legal certainty."
      : "Publication records a reviewed OSI process outcome. It is not proof of truth, guilt, or legal certainty.",
    idempotent_replay: committed.idempotent_replay === true,
  });
}

async function capabilities(body: Row): Promise<Response> {
  const wallet = safeText(body.wallet);
  if (wallet) {
    try { validateWallet(wallet); }
    catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  }
  const [enabled, reviewEnabled] = await Promise.all([
    reportWritesEnabled(),
    reportReviewWritesEnabled(),
  ]);
  const caseRef = safeText(body.case_ref);
  let caseEligible = false;
  let caseStage: string | null = null;
  if (/^OSI-[0-9A-F]{12}$/.test(caseRef)) {
    const found = await eligibleCase(caseRef);
    caseEligible = !found.error && !!found.row;
    caseStage = found.row?.stage ?? null;
  }
  return jsonResponse(200, {
    ok: true,
    report_writes_enabled: enabled,
    report_review_writes_enabled: reviewEnabled,
    case_eligible: caseEligible,
    case_stage: caseStage,
    wallet_connected: !!wallet,
    prerequisite: !enabled
      ? "Report submission is not enabled."
      : !wallet
      ? "Connect a wallet to submit a Report."
      : !caseEligible
      ? "This Case is not in an eligible public investigation stage."
      : null,
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonResponse(503, { ok: false, error: "not_configured" });
  }
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
      ok: false,
      error: error instanceof RangeError ? "body_too_large" : "bad_json",
    });
  }

  switch (body.op) {
    case "prepare_report": return await prepareReport(req, body);
    case "commit_report": return await commitReport(body);
    case "prepare_review": return await prepareReview(req, body);
    case "commit_review": return await commitReview(body);
    case "prepare_publication": return await preparePublication(req, body);
    case "commit_publication": return await commitPublication(req, body);
    case "capabilities": return await capabilities(body);
    default: return jsonResponse(400, { ok: false, error: "bad_op" });
  }
});
