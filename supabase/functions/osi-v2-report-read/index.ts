// OSI V2 Case Report read gateway. Unpublished Report existence and content
// stay behind a durable, single-use wallet-signed read. Author, analyst and
// full maintainer projections are resolved on the server from stored state.

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
  buildChallenge,
  challengeSigningInput,
  parseChallenge,
  validateChallengeBinding,
} from "../_shared/osi-v2-case-read-core.mjs";
import { authorizedReportDto } from "../_shared/osi-v2-report-core.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const MAINTAINER_AUTH_UUID = Deno.env.get("OSI_MAINTAINER_AUTH_UUID") ?? "";
const MAX_BODY_BYTES = 16_384;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Row = Record<string, any>;
type Scope = "my_reports" | "review_queue";

const REPORT_COLS =
  "id,case_id,author_wallet,current_version_id,current_published_version_id,status,public_ref,native_intake,created_at,updated_at";
const VERSION_COLS =
  "id,report_id,version_no,version_ref,created_by_wallet,body_private,content_public_safe,evidence_snapshot_hash,supersedes_version_id,revision_reason_code,lifecycle_state,event_receipt_id,created_at";
const CASE_COLS = "id,public_ref,stage,visibility";
const EVIDENCE_COLS = "id,kind,ref,sha256";
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

function scopeBinding(scope: Scope, wallet: string) {
  return scope === "my_reports"
    ? { purpose: "CASE_READ_MY_CASES", target_type: "wallet_cases", target_id: wallet }
    : { purpose: "CASE_READ_REVIEW_QUEUE", target_type: "review_queue", target_id: wallet };
}

async function hmacHex(input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SERVICE_ROLE_KEY + "\u0000osi-v2-report-read-challenge"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function issueChallenge(req: Request, body: Row): Promise<Response> {
  const scope = safeText(body.scope) as Scope;
  const wallet = safeText(body.wallet);
  if (!new Set(["my_reports", "review_queue"]).has(scope)) {
    return jsonResponse(400, { ok: false, error: "bad_scope" });
  }
  try { validateWallet(wallet); }
  catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  const binding = scopeBinding(scope, wallet);
  const nonce = randomNonce();
  const fingerprintHash = await requestFingerprint(
    SERVICE_ROLE_KEY + "\u0000osi-v2-report-read",
    trustedClientAddress(req.headers),
  );
  const { data, error } = await admin.rpc("osi_v2_issue_read_nonce", {
    p_nonce: nonce,
    p_purpose: binding.purpose,
    p_actor_wallet: wallet,
    p_target_type: binding.target_type,
    p_target_id: binding.target_id,
    p_request_fingerprint_hash: fingerprintHash,
  });
  if (error || !data?.[0]) {
    return jsonResponse(error?.code === "P0001" ? 429 : 503, {
      ok: false,
      error: error?.code === "P0001" ? "rate_limited" : "challenge_unavailable",
    });
  }
  const fields = {
    ...binding,
    wallet,
    nonce,
    issued_at: Math.floor(Date.parse(String(data[0].issued_at)) / 1000),
    expires_at: Math.floor(Date.parse(String(data[0].expires_at)) / 1000),
  };
  const mac = await hmacHex(challengeSigningInput(fields));
  return jsonResponse(200, {
    ok: true,
    challenge: buildChallenge(fields, mac),
    expires_at: fields.expires_at,
  });
}

async function verifySignedRead(body: Row, scope: Scope) {
  const wallet = safeText(body.wallet);
  const challenge = safeText(body.challenge);
  const signature = safeText(body.signature);
  if (!wallet || !challenge || !signature) {
    return { ok: false as const, status: 400, reason: "missing_fields" };
  }
  const fields = parseChallenge(challenge);
  if (!fields) return { ok: false as const, status: 400, reason: "bad_challenge" };
  const expectedMac = await hmacHex(challengeSigningInput(fields));
  if (!timingSafeEqualHex(expectedMac, fields.hmac ?? "")) {
    return { ok: false as const, status: 403, reason: "bad_challenge" };
  }
  const binding = scopeBinding(scope, wallet);
  const exact = validateChallengeBinding(
    fields,
    { ...binding, wallet },
    Math.floor(Date.now() / 1000),
  );
  if (!exact.ok) {
    return { ok: false as const, status: 403, reason: exact.reason ?? "bad_binding" };
  }
  if (!await verifyEd25519Signature(challenge, signature, wallet)) {
    return { ok: false as const, status: 403, reason: "bad_signature" };
  }
  const { data, error } = await admin.rpc("osi_v2_consume_read_nonce", {
    p_nonce: fields.nonce,
    p_purpose: binding.purpose,
    p_actor_wallet: wallet,
    p_target_type: binding.target_type,
    p_target_id: binding.target_id,
  });
  if (error) return { ok: false as const, status: 503, reason: "challenge_unavailable" };
  if (data !== true) return { ok: false as const, status: 403, reason: "replayed_or_expired" };
  return { ok: true as const, wallet };
}

async function analystEligible(wallet: string): Promise<boolean> {
  const { data, error } = await admin.from("analyst_profiles")
    .select("wallet,status,verified,approved,weight_cached")
    .eq("wallet", wallet).limit(1);
  const row = data?.[0];
  return !error && !!row && row.verified === true && row.approved === true
    && ["probationary_analyst", "verified_analyst", "senior_analyst"].includes(row.status)
    && Number(row.weight_cached) >= 0.5 && Number(row.weight_cached) <= 3;
}

async function maintainerGate(req: Request, wallet: string) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const [{ data: config }, auth] = await Promise.all([
    admin.from("osi_config").select("value").eq("key", "admin_wallet").limit(1),
    token ? admin.auth.getUser(token) : Promise.resolve({ data: { user: null }, error: null }),
  ]);
  const walletGate = safeText(config?.[0]?.value) === wallet && !!wallet;
  const authGate = !auth.error
    && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(MAINTAINER_AUTH_UUID)
    && auth.data?.user?.id === MAINTAINER_AUTH_UUID;
  if (walletGate && authGate) return { ok: true, reason: "full" };
  if (walletGate) return { ok: false, reason: "half_maintainer_wallet_only" };
  if (authGate) return { ok: false, reason: "half_maintainer_auth_only" };
  return { ok: false, reason: "maintainer_denied" };
}

async function loadReports(headers: Row[], access: "author" | "analyst" | "maintainer") {
  if (!headers.length) return [];
  const reportIds = headers.map((row) => String(row.id));
  const caseIds = [...new Set(headers.map((row) => String(row.case_id)))];
  const [{ data: versions, error: versionError }, { data: cases, error: caseError }] = await Promise.all([
    admin.from("case_report_versions").select(VERSION_COLS)
      .in("report_id", reportIds).order("version_no", { ascending: true }).limit(1000),
    admin.from("cases").select(CASE_COLS).in("id", caseIds).limit(500),
  ]);
  if (versionError || caseError) throw new Error("read_failed");
  const versionRows = versions ?? [];
  const versionIds = versionRows.map((row) => String(row.id));
  const receiptIds = versionRows.map((row) => String(row.event_receipt_id));
  const [{ data: links, error: linkError }, { data: receipts, error: receiptError }] = await Promise.all([
    versionIds.length
      ? admin.from("case_report_version_evidence")
        .select("report_version_id,evidence_item_id,ordinal")
        .in("report_version_id", versionIds).order("ordinal", { ascending: true }).limit(5000)
      : Promise.resolve({ data: [], error: null }),
    receiptIds.length
      ? admin.from("event_receipts").select(RECEIPT_COLS).in("id", receiptIds).limit(1000)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (linkError || receiptError) throw new Error("read_failed");
  const evidenceIds = [...new Set((links ?? []).map((row) => String(row.evidence_item_id)))];
  const evidenceResult = evidenceIds.length
    ? await admin.from("evidence_items").select(EVIDENCE_COLS).in("id", evidenceIds).limit(5000)
    : { data: [], error: null };
  if (evidenceResult.error) throw new Error("read_failed");

  const caseById = new Map((cases ?? []).map((row) => [String(row.id), row]));
  const versionById = new Map(versionRows.map((row) => [String(row.id), row]));
  const evidenceById = new Map((evidenceResult.data ?? []).map((row) => [String(row.id), row]));
  const evidenceByVersion = new Map<string, Row[]>();
  for (const link of links ?? []) {
    const evidence = evidenceById.get(String(link.evidence_item_id));
    if (!evidence) continue;
    const key = String(link.report_version_id);
    const items = evidenceByVersion.get(key) ?? [];
    items.push({ ...evidence, ordinal: link.ordinal });
    evidenceByVersion.set(key, items);
  }
  const receiptByVersion = new Map<string, Row>();
  const receiptById = new Map((receipts ?? []).map((row) => [String(row.id), row]));
  for (const version of versionRows) {
    const receipt = receiptById.get(String(version.event_receipt_id));
    if (receipt) receiptByVersion.set(String(version.id), receipt);
  }

  return headers.map((header) => {
    const caseRow = caseById.get(String(header.case_id));
    const reportVersions = versionRows
      .filter((version) => String(version.report_id) === String(header.id))
      .map((version) => ({
        ...version,
        supersedes_version_ref: version.supersedes_version_id
          ? versionById.get(String(version.supersedes_version_id))?.version_ref ?? null
          : null,
      }));
    const current = versionById.get(String(header.current_version_id));
    const published = header.current_published_version_id
      ? versionById.get(String(header.current_published_version_id))
      : null;
    return authorizedReportDto({
      case_public_ref: caseRow?.public_ref,
      report_public_ref: header.public_ref,
      author_wallet: header.author_wallet,
      status: header.status,
      current_version_ref: current?.version_ref,
      current_version_no: current?.version_no,
      current_published_version_ref: published?.version_ref ?? null,
      revision_eligible: access === "author"
        && caseRow?.visibility === "public"
        && ["open_public", "in_review", "reopened"].includes(caseRow?.stage)
        && header.status === "active",
    }, reportVersions, evidenceByVersion, receiptByVersion, access);
  });
}

async function listMyReports(body: Row): Promise<Response> {
  const proof = await verifySignedRead(body, "my_reports");
  if (!proof.ok) return jsonResponse(proof.status, { ok: false, error: proof.reason });
  const { data, error } = await admin.from("case_reports").select(REPORT_COLS)
    .eq("author_wallet", proof.wallet)
    .eq("native_intake", true)
    .not("public_ref", "is", null)
    .order("created_at", { ascending: false }).limit(200);
  if (error) return jsonResponse(500, { ok: false, error: "read_failed" });
  try {
    return jsonResponse(200, {
      ok: true,
      actor_role: "author",
      reports: await loadReports(data ?? [], "author"),
    });
  } catch {
    return jsonResponse(500, { ok: false, error: "read_failed" });
  }
}

async function listReviewQueue(req: Request, body: Row): Promise<Response> {
  const proof = await verifySignedRead(body, "review_queue");
  if (!proof.ok) return jsonResponse(proof.status, { ok: false, error: proof.reason });
  const [analyst, maintainer] = await Promise.all([
    analystEligible(proof.wallet),
    maintainerGate(req, proof.wallet),
  ]);
  const access = analyst ? "analyst" : maintainer.ok ? "maintainer" : null;
  if (!access) return jsonResponse(403, { ok: false, error: maintainer.reason });
  const { data, error } = await admin.from("case_reports").select(REPORT_COLS)
    .eq("native_intake", true)
    .eq("status", "active")
    .neq("author_wallet", proof.wallet)
    .not("current_version_id", "is", null)
    .order("created_at", { ascending: true }).limit(200);
  if (error) return jsonResponse(500, { ok: false, error: "read_failed" });
  try {
    const reports = (await loadReports(data ?? [], access)).filter((report) => {
      const current = report.versions.find(
        (version: Row) => version.version_ref === report.current_version_ref,
      );
      return current && ["submitted", "in_review"].includes(current.lifecycle_state);
    });
    return jsonResponse(200, {
      ok: true,
      actor_role: access,
      queue_state: "awaiting_review",
      review_mutations_enabled: false,
      next_prerequisite: "Counted Report review and publication quorum are not enabled yet.",
      reports,
    });
  } catch {
    return jsonResponse(500, { ok: false, error: "read_failed" });
  }
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
    case "issue_read_challenge": return await issueChallenge(req, body);
    case "list_my_reports": return await listMyReports(body);
    case "list_review_queue": return await listReviewQueue(req, body);
    default: return jsonResponse(400, { ok: false, error: "bad_op" });
  }
});
