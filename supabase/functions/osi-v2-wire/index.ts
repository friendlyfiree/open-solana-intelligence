// OSI V2 native Wire Phase 1 gateway. The browser never receives a service
// credential and cannot choose version numbers, lifecycle, receipt truth, or
// another author's private lineage. Writes require an exact confirmed mainnet
// Memo; private reads require the shared short-lived read-only session.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  randomNonce,
  requestFingerprint,
  trustedClientAddress,
  validateWallet,
} from "../_shared/osi-v2-proof-core.mjs";
import {
  WIRE_EVENT_TYPE,
  authorizedWireReportDto,
  canonicalWireMemo,
  normalizeWirePayload,
  validateConfirmedWireTransaction,
  validateWireIdempotencyKey,
  validateWireMemoBinding,
  validateWireReportRef,
} from "../_shared/osi-v2-wire-core.mjs";
import {
  READ_SESSION_SCOPES,
  readSessionIssuer,
  verifyReadSessionToken,
} from "../_shared/osi-v2-read-session-core.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const SOLANA_RPC_URL = Deno.env.get("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MAX_BODY_BYTES = 180_000;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Row = Record<string, any>;
type WirePayload = {
  title_public_safe: string;
  content_public_safe: string;
  body_private: string;
  uncertainties_private: string;
  revision_reason_code: string | null;
  evidence: Array<{ kind: string; ref: string; sha256: string }>;
};

const HEADER_COLS =
  "id,author_wallet,current_version_id,current_published_version_id,promoted_to_case_id,status,public_ref,native_intake,created_at,updated_at";
const VERSION_COLS =
  "id,wire_report_id,version_no,version_ref,created_by_wallet,title_public_safe,content_public_safe,body_private,uncertainties_private,evidence_snapshot_hash,supersedes_version_id,revision_reason_code,lifecycle_state,event_receipt_id,published_at,created_at";
const EVIDENCE_COLS = "id,kind,ref,sha256,is_public,moderation_state";
const RECEIPT_COLS =
  "id,event_type,target_type,target_id,actor_wallet,actor_role,decision,proof_type,tx_sig,server_verified,occurred_at";

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
  if (code === "42501") return jsonResponse(404, { ok: false, error: "wire_report_not_available" });
  if (code === "23514" || code === "22023") {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  if (code === "40001") return jsonResponse(409, { ok: false, error: "lineage_changed_retry" });
  if (code === "P0001") return jsonResponse(429, { ok: false, error: "rate_limited" });
  if (code === "55000") {
    return jsonResponse(503, { ok: false, error: "wire_writes_disabled_or_unavailable" });
  }
  return jsonResponse(500, { ok: false, error: "wire_write_failed" });
}

async function configEnabled(key: string): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", key).limit(1);
  return !error && data?.[0]?.value === "true";
}

async function wireWritesEnabled(): Promise<boolean> {
  return await configEnabled("OSI_V2_WIRE_WRITES_ENABLED");
}

async function readSessionEnabled(): Promise<boolean> {
  return await configEnabled("OSI_V2_READ_SESSION_ENABLED");
}

async function fingerprint(req: Request): Promise<string> {
  return await requestFingerprint(
    SERVICE_ROLE_KEY + "\u0000osi-v2-wire",
    trustedClientAddress(req.headers),
  );
}

async function loadBoundNonce(nonce: string) {
  const { data, error } = await admin.from("osi_nonces")
    .select("nonce,purpose,actor_wallet,target_type,target_id,payload_hash,issued_at,expires_at,consumed_at,consumed_by_receipt_id,binding_context")
    .eq("nonce", nonce).limit(1);
  return { row: data?.[0] ?? null, error };
}

function memoBinding(nonceRow: Row) {
  const context = nonceRow.binding_context ?? {};
  const versionNo = Number(context.version_no);
  return {
    purpose: WIRE_EVENT_TYPE,
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
  return validateConfirmedWireTransaction(transaction, status, {
    tx_sig: txSig, wallet, memo, issued_at: issuedAt, expires_at: expiresAt,
  });
}

async function prepareWire(req: Request, body: Row): Promise<Response> {
  if (!await wireWritesEnabled()) {
    return jsonResponse(503, { ok: false, error: "wire_writes_disabled" });
  }
  const wallet = safeText(body.wallet);
  try { validateWallet(wallet); }
  catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let wire: WirePayload;
  let idempotencyKey: string;
  let wireReportRef: string | null;
  try {
    wire = await normalizeWirePayload(body.wire) as WirePayload;
    idempotencyKey = validateWireIdempotencyKey(body.idempotency_key);
    wireReportRef = validateWireReportRef(body.wire_report_public_ref, true);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_wire_payload" });
  }
  const { data, error } = await admin.rpc("osi_v2_prepare_wire_version", {
    p_nonce: randomNonce(),
    p_actor_wallet: wallet,
    p_wire_report_public_ref: wireReportRef,
    p_title_public_safe: wire.title_public_safe,
    p_content_public_safe: wire.content_public_safe,
    p_body_private: wire.body_private,
    p_uncertainties_private: wire.uncertainties_private,
    p_revision_reason_code: wire.revision_reason_code,
    p_evidence: wire.evidence,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const issued = data[0];
  if (issued.consumed_receipt_id) {
    return jsonResponse(200, {
      ok: true,
      already_committed: true,
      wire_report_public_ref: issued.wire_report_public_ref,
      version_public_ref: issued.version_public_ref,
      version_no: issued.version_no,
      idempotent_replay: true,
    });
  }
  const binding = {
    purpose: WIRE_EVENT_TYPE,
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
    wire_report_public_ref: issued.wire_report_public_ref,
    version_public_ref: issued.version_public_ref,
    version_no: issued.version_no,
    evidence_manifest_hash: issued.evidence_manifest_hash,
    nonce: issued.issued_nonce,
    payload_hash: issued.payload_hash,
    memo: canonicalWireMemo(binding),
    expires_at: binding.expires_at,
    idempotent_replay: issued.idempotent_replay === true,
  });
}

async function commitWire(body: Row): Promise<Response> {
  if (!await wireWritesEnabled()) {
    return jsonResponse(503, { ok: false, error: "wire_writes_disabled" });
  }
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const memo = safeText(body.memo);
  const txSig = safeText(body.tx_sig);
  try { validateWallet(wallet); }
  catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let wire: WirePayload;
  try { wire = await normalizeWirePayload(body.wire) as WirePayload; }
  catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_wire_payload" });
  }
  const nonceResult = await loadBoundNonce(nonce);
  const bound = nonceResult.row;
  if (nonceResult.error || !bound || bound.purpose !== WIRE_EVENT_TYPE
      || bound.target_type !== "wire_version") {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  const binding = memoBinding(bound);
  const verificationTime = bound.consumed_at
    ? Math.min(Math.floor(Date.now() / 1000), binding.expires_at)
    : Math.floor(Date.now() / 1000);
  const exact = validateWireMemoBinding(memo, binding, verificationTime);
  if (!exact.ok || bound.actor_wallet !== wallet) {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  const chain = await verifyMainnetMemoTransaction(
    txSig, wallet, memo, binding.issued_at, binding.expires_at,
  );
  if (!chain.ok) return jsonResponse(409, { ok: false, error: chain.reason });
  const { data, error } = await admin.rpc("osi_v2_commit_wire_version", {
    p_nonce: nonce,
    p_title_public_safe: wire.title_public_safe,
    p_content_public_safe: wire.content_public_safe,
    p_body_private: wire.body_private,
    p_uncertainties_private: wire.uncertainties_private,
    p_revision_reason_code: wire.revision_reason_code,
    p_evidence: wire.evidence,
    p_tx_sig: txSig,
    p_memo_ref: memo,
    p_occurred_at: (chain as { occurred_at: string }).occurred_at,
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const committed = data[0];
  return jsonResponse(200, {
    ok: true,
    wire_report_public_ref: committed.wire_report_public_ref,
    version_public_ref: committed.version_public_ref,
    version_no: committed.version_no,
    lifecycle_state: "submitted",
    proof: {
      event_type: WIRE_EVENT_TYPE,
      label: "Memo-anchored on Solana",
      proof_type: "solana_memo",
      tx_sig: txSig,
      server_verified: true,
    },
    publication_state_changed: false,
    idempotent_replay: committed.idempotent_replay === true,
  });
}

async function verifyReadSession(
  req: Request,
  body: Row,
): Promise<{ ok: true; wallet: string } | { ok: false; status: number; reason: string }> {
  if (!await readSessionEnabled()) {
    return { ok: false, status: 503, reason: "read_session_disabled_or_unavailable" };
  }
  const verified = await verifyReadSessionToken({
    token: safeText(body.read_session),
    secret: SERVICE_ROLE_KEY,
    issuer: readSessionIssuer(SUPABASE_URL),
    origin: req.headers.get("origin") ?? "",
    allowedOrigin: ALLOWED_ORIGIN,
    wallet: safeText(body.wallet),
    requiredScope: READ_SESSION_SCOPES.WIRE_MINE,
  });
  if (verified.ok === true && typeof verified.wallet === "string") {
    return { ok: true, wallet: verified.wallet };
  }
  return {
    ok: false,
    status: typeof verified.status === "number" ? verified.status : 403,
    reason: typeof verified.reason === "string" ? verified.reason : "read_session_tampered",
  };
}

async function listMyWireReports(req: Request, body: Row): Promise<Response> {
  const proof = await verifyReadSession(req, body);
  if (!proof.ok) return jsonResponse(proof.status, { ok: false, error: proof.reason });
  const { data: headers, error: headerError } = await admin.from("wire_reports")
    .select(HEADER_COLS)
    .eq("author_wallet", proof.wallet)
    .eq("native_intake", true)
    .order("created_at", { ascending: false })
    .limit(200);
  if (headerError) return jsonResponse(503, { ok: false, error: "wire_read_unavailable" });
  const headerRows = headers ?? [];
  if (!headerRows.length) {
    return jsonResponse(200, { ok: true, reports: [], private_projection: true });
  }
  const headerIds = headerRows.map((row) => String(row.id));
  const { data: versions, error: versionError } = await admin.from("wire_report_versions")
    .select(VERSION_COLS)
    .in("wire_report_id", headerIds)
    .order("version_no", { ascending: true })
    .limit(1000);
  if (versionError) return jsonResponse(503, { ok: false, error: "wire_read_unavailable" });
  const versionRows = versions ?? [];
  const versionIds = versionRows.map((row) => String(row.id));
  const receiptIds = [...new Set(versionRows.map((row) => String(row.event_receipt_id)).filter(Boolean))];
  const [linkResult, receiptResult] = await Promise.all([
    versionIds.length
      ? admin.from("wire_report_version_evidence")
        .select("wire_report_version_id,evidence_item_id,ordinal")
        .in("wire_report_version_id", versionIds)
        .order("ordinal", { ascending: true }).limit(5000)
      : Promise.resolve({ data: [], error: null }),
    receiptIds.length
      ? admin.from("event_receipts").select(RECEIPT_COLS).in("id", receiptIds).limit(1000)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (linkResult.error || receiptResult.error) {
    return jsonResponse(503, { ok: false, error: "wire_read_unavailable" });
  }
  const evidenceIds = [...new Set((linkResult.data ?? []).map((row) => String(row.evidence_item_id)))];
  const evidenceResult = evidenceIds.length
    ? await admin.from("evidence_items").select(EVIDENCE_COLS).in("id", evidenceIds).limit(5000)
    : { data: [], error: null };
  if (evidenceResult.error) return jsonResponse(503, { ok: false, error: "wire_read_unavailable" });

  const versionById = new Map(versionRows.map((row) => [String(row.id), row]));
  const evidenceById = new Map((evidenceResult.data ?? []).map((row) => [String(row.id), row]));
  const evidenceByVersion = new Map<string, Row[]>();
  for (const link of linkResult.data ?? []) {
    const evidence = evidenceById.get(String(link.evidence_item_id));
    if (!evidence) continue;
    const key = String(link.wire_report_version_id);
    const items = evidenceByVersion.get(key) ?? [];
    items.push({ ...evidence, ordinal: link.ordinal });
    evidenceByVersion.set(key, items);
  }
  const receiptById = new Map((receiptResult.data ?? []).map((row) => [String(row.id), row]));
  const receiptByVersion = new Map<string, Row>();
  for (const version of versionRows) {
    const receipt = receiptById.get(String(version.event_receipt_id));
    if (receipt?.target_id === String(version.id)) receiptByVersion.set(String(version.id), receipt);
  }
  const writesEnabled = await wireWritesEnabled();
  const reports = headerRows.map((header) => {
    const current = versionById.get(String(header.current_version_id));
    const published = versionById.get(String(header.current_published_version_id || ""));
    const reportVersions = versionRows
      .filter((version) => String(version.wire_report_id) === String(header.id))
      .map((version) => ({
        ...version,
        supersedes_version_ref: version.supersedes_version_id
          ? versionById.get(String(version.supersedes_version_id))?.version_ref ?? null
          : null,
      }));
    return authorizedWireReportDto({
      ...header,
      current_version_ref: current?.version_ref ?? "",
      current_version_no: current?.version_no ?? 0,
      current_published_version_ref: published?.version_ref ?? null,
    }, reportVersions, evidenceByVersion, receiptByVersion, writesEnabled);
  });
  return jsonResponse(200, { ok: true, reports, private_projection: true });
}

async function capabilities(body: Row): Promise<Response> {
  const wallet = safeText(body.wallet);
  if (wallet) {
    try { validateWallet(wallet); }
    catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  }
  const enabled = await wireWritesEnabled();
  return jsonResponse(200, {
    ok: true,
    wire_writes_enabled: enabled,
    wallet_connected: !!wallet,
    class_a_event: WIRE_EVENT_TYPE,
    publication_enabled: false,
    prerequisite: !enabled
      ? "Wire submission is not enabled."
      : !wallet
      ? "Connect a wallet to submit a Wire Report."
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
    case "prepare_wire": return await prepareWire(req, body);
    case "commit_wire": return await commitWire(body);
    case "list_my_wire_reports": return await listMyWireReports(req, body);
    case "capabilities": return await capabilities(body);
    default: return jsonResponse(400, { ok: false, error: "bad_op" });
  }
});
