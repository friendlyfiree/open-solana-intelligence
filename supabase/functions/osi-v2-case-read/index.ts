// ============================================================================
// Supabase Edge Function: osi-v2-case-read
// ----------------------------------------------------------------------------
// Read-only V2 Case vertical slice (rollout step 7). Serves minimized Case
// DTOs from the V2 domain tables, which remain default-deny under RLS: this
// function is the only client-reachable read path and it authorizes every
// caller server-side.
//
//   op=list_public_cases        anonymous — genuinely public Cases only
//   op=get_public_case          anonymous — one public Case by public_ref
//   op=issue_read_challenge     mints a durable single-use signing challenge
//   op=list_my_cases            proven owner wallet — that wallet's Cases
//   op=list_reviewable_cases    proven eligible analyst / full maintainer
//   op=get_authorized_case      proven wallet — owner / verified-analyst scope
//   op=maintainer_case_overview BOTH maintainer Supabase auth AND the
//                               configured admin wallet (half-maintainer = 403)
//
// READ AUTHORIZATION GUARANTEE: this function never mutates a V2 domain row or
// creates a Proof Log receipt. It inserts and atomically consumes one row in
// the service-only osi_read_nonces security-infrastructure table. That durable
// nonce closes cross-instance replay while retaining the HMAC, exact purpose /
// target binding, <=120s expiry and server-side Ed25519 verification.
//
// The service-role key never leaves this function and is never logged.
// Deploy with "Verify JWT" OFF: wallet actors authenticate with signatures,
// and the maintainer path validates its Supabase JWT itself (both gates).
// ============================================================================

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
  authorizedCaseDto,
  buildChallenge,
  canActorReadCase,
  challengeSigningInput,
  isCasePublic,
  maintainerOverviewDto,
  parseChallenge,
  proofLabel,
  publicCaseDto,
  PUBLIC_CASE_STAGES,
  READ_PURPOSES,
  validateChallengeBinding,
} from "../_shared/osi-v2-case-read-core.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const MAINTAINER_AUTH_UUID = Deno.env.get("OSI_MAINTAINER_AUTH_UUID") ?? "";
const MAX_BODY_BYTES = 16_384;
const PUBLIC_LIST_LIMIT = 50;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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
  return typeof value === "string" ? value : "";
}

async function hmacHex(input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SERVICE_ROLE_KEY + "\u0000osi-v2-case-read-challenge"),
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
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Data loading (minimized columns; service role never exposed)
// ---------------------------------------------------------------------------

const CASE_COLS =
  "id,public_ref,title,category,summary_public,details_restricted,reward_intent_lamports,submitted_by_wallet,stage,visibility,risk_tier,sealed_at,created_at,updated_at";
const REPORT_COLS =
  "id,case_id,author_wallet,current_version_id,current_published_version_id,status,public_ref,native_intake,created_at";
const VERSION_COLS =
  "id,report_id,version_no,version_ref,created_by_wallet,body_private,content_public_safe,evidence_snapshot_hash,lifecycle_state,published_at,created_at";
const RECEIPT_COLS =
  "id,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,decision,weight,reason_code,proof_type,memo_ref,tx_sig,server_verified,occurred_at";
const EVIDENCE_COLS =
  "id,kind,ref,is_public,moderation_state,sha256,created_at";
const REVIEW_COLS =
  "id,case_id,reviewer_wallet,decision,reviewer_role,weight,reason_code,is_active,event_receipt_id,created_at";

type Row = Record<string, unknown>;

async function loadCaseGraph(caseRows: Row[], publicOnly = false) {
  const caseIds = caseRows.map((c) => String(c.id));
  const publicRefs = caseRows.map((c) => String(c.public_ref));
  const reportsByCase: Record<string, Row[]> = {};
  const versionsByReport: Record<string, Row[]> = {};
  const receiptsByCaseTarget: Record<string, Row[]> = {};
  const evidenceByCase: Record<string, Row[]> = {};
  const reviewsByCase: Record<string, Row[]> = {};
  if (!caseIds.length) {
    return { reportsByCase, versionsByReport, receiptsByCaseTarget, evidenceByCase, reviewsByCase };
  }

  let reportsQuery = admin.from("case_reports").select(REPORT_COLS)
    .in("case_id", caseIds);
  if (publicOnly) reportsQuery = reportsQuery.not("current_published_version_id", "is", null);
  const { data: reports } = await reportsQuery
    .order("created_at", { ascending: true }).limit(200);
  const reportIds = (reports ?? []).map((r) => String(r.id));
  for (const report of reports ?? []) {
    const key = String(report.case_id);
    (reportsByCase[key] ??= []).push(report);
  }

  if (reportIds.length) {
    const publishedVersionIds = (reports ?? [])
      .map((report) => String(report.current_published_version_id ?? ""))
      .filter(Boolean);
    let versionsQuery = admin.from("case_report_versions").select(VERSION_COLS);
    versionsQuery = publicOnly
      ? versionsQuery.in("id", publishedVersionIds)
      : versionsQuery.in("report_id", reportIds);
    const { data: versions } = await versionsQuery
      .order("version_no", { ascending: true }).limit(400);
    for (const version of versions ?? []) {
      const key = String(version.report_id);
      (versionsByReport[key] ??= []).push(version);
    }
  }

  // Case-targeted receipts key on public_ref; report-version receipts on the
  // version uuid. Both are folded into the owning Case's proof log.
  const versionIds = Object.values(versionsByReport).flat().map((v) => String(v.id));
  const versionCaseRef: Record<string, string> = {};
  for (const [reportId, versions] of Object.entries(versionsByReport)) {
    const report = (reports ?? []).find((r) => String(r.id) === reportId);
    const caseRow = report ? caseRows.find((c) => String(c.id) === String(report.case_id)) : null;
    if (!caseRow) continue;
    for (const version of versions) versionCaseRef[String(version.id)] = String(caseRow.public_ref);
  }
  const targetIds = [...publicRefs, ...caseIds, ...versionIds];
  if (targetIds.length) {
    const { data: receipts } = await admin.from("event_receipts").select(RECEIPT_COLS)
      .in("target_id", targetIds).order("occurred_at", { ascending: true }).limit(400);
    for (const receipt of receipts ?? []) {
      const targetId = String(receipt.target_id);
      const directCase = caseRows.find((c) => String(c.id) === targetId);
      const ref = publicRefs.includes(targetId)
        ? targetId : (directCase ? String(directCase.public_ref) : versionCaseRef[targetId]);
      if (!ref) continue;
      (receiptsByCaseTarget[ref] ??= []).push(receipt);
    }
  }

  const [{ data: links }, { data: reviews }] = await Promise.all([
    admin.from("case_evidence_links").select("case_id,evidence_item_id")
      .in("case_id", caseIds).limit(400),
    admin.from("case_initial_reviews").select(REVIEW_COLS)
      .in("case_id", caseIds).order("created_at", { ascending: true }).limit(400),
  ]);
  const evidenceIds = (links ?? []).map((link) => String(link.evidence_item_id));
  let evidence: Row[] = [];
  if (evidenceIds.length) {
    const result = await admin.from("evidence_items").select(EVIDENCE_COLS)
      .in("id", evidenceIds).order("created_at", { ascending: true }).limit(400);
    evidence = result.data ?? [];
  }
  for (const link of links ?? []) {
    const item = evidence.find((entry) => String(entry.id) === String(link.evidence_item_id));
    if (item) (evidenceByCase[String(link.case_id)] ??= []).push(item);
  }
  const receiptById: Record<string, Row> = {};
  for (const rows of Object.values(receiptsByCaseTarget)) {
    for (const receipt of rows) receiptById[String(receipt.id)] = receipt;
  }
  for (const review of reviews ?? []) {
    const value = { ...review, receipt: receiptById[String(review.event_receipt_id)] ?? null };
    (reviewsByCase[String(review.case_id)] ??= []).push(value);
  }
  return { reportsByCase, versionsByReport, receiptsByCaseTarget, evidenceByCase, reviewsByCase };
}

// ---------------------------------------------------------------------------
// Anonymous operations
// ---------------------------------------------------------------------------

async function listPublicCases(): Promise<Response> {
  const { data, error } = await admin.from("cases").select(CASE_COLS)
    .eq("visibility", "public")
    .in("stage", [...PUBLIC_CASE_STAGES])
    .order("created_at", { ascending: false })
    .limit(PUBLIC_LIST_LIMIT);
  if (error) return jsonResponse(500, { ok: false, error: "read_failed" });
  const caseRows = (data ?? []).filter(isCasePublic);
  const graph = await loadCaseGraph(caseRows, true);
  return jsonResponse(200, {
    ok: true,
    cases: caseRows.map((caseRow) => publicCaseDto(
      caseRow,
      graph.reportsByCase[String(caseRow.id)] ?? [],
      graph.versionsByReport,
      graph.receiptsByCaseTarget[String(caseRow.public_ref)] ?? [],
      graph.evidenceByCase[String(caseRow.id)] ?? [],
      graph.reviewsByCase[String(caseRow.id)] ?? [],
    )),
  });
}

async function getPublicCase(body: Row): Promise<Response> {
  const publicRef = safeText(body.public_ref);
  if (!/^OSI-[0-9A-Z]{6,20}$/.test(publicRef)) {
    return jsonResponse(400, { ok: false, error: "bad_public_ref" });
  }
  const { data, error } = await admin.from("cases").select(CASE_COLS)
    .eq("public_ref", publicRef).limit(1);
  if (error) return jsonResponse(500, { ok: false, error: "read_failed" });
  const caseRow = data?.[0];
  // Private and nonexistent Cases are indistinguishable to anonymous callers.
  if (!caseRow || !isCasePublic(caseRow)) {
    return jsonResponse(404, { ok: false, error: "not_found_or_private" });
  }
  const graph = await loadCaseGraph([caseRow], true);
  return jsonResponse(200, {
    ok: true,
    case: publicCaseDto(
      caseRow,
      graph.reportsByCase[String(caseRow.id)] ?? [],
      graph.versionsByReport,
      graph.receiptsByCaseTarget[String(caseRow.public_ref)] ?? [],
      graph.evidenceByCase[String(caseRow.id)] ?? [],
      graph.reviewsByCase[String(caseRow.id)] ?? [],
    ),
  });
}

// ---------------------------------------------------------------------------
// Signed-read challenge issuance and verification
// ---------------------------------------------------------------------------

function challengeTargetFor(purpose: string, wallet: string, caseRef: string) {
  if (purpose === "CASE_READ_MY_CASES") return { target_type: "wallet_cases", target_id: wallet };
  if (purpose === "CASE_READ_AUTHORIZED_CASE") return { target_type: "case", target_id: caseRef };
  if (purpose === "CASE_READ_REVIEW_QUEUE") {
    return { target_type: "review_queue", target_id: wallet };
  }
  if (purpose === "CASE_READ_MAINTAINER_OVERVIEW") {
    return { target_type: "config", target_id: "maintainer_overview" };
  }
  return null;
}

async function issueReadChallenge(req: Request, body: Row): Promise<Response> {
  const purpose = safeText(body.purpose);
  const wallet = safeText(body.wallet);
  const caseRef = safeText(body.case_ref);
  if (!READ_PURPOSES.has(purpose)) return jsonResponse(400, { ok: false, error: "bad_purpose" });
  try {
    validateWallet(wallet);
  } catch {
    return jsonResponse(400, { ok: false, error: "bad_wallet" });
  }
  if (purpose === "CASE_READ_AUTHORIZED_CASE" && !/^OSI-[0-9A-Z]{6,20}$/.test(caseRef)) {
    return jsonResponse(400, { ok: false, error: "bad_case_ref" });
  }
  const target = challengeTargetFor(purpose, wallet, caseRef);
  if (!target) return jsonResponse(400, { ok: false, error: "bad_purpose" });

  const nonce = randomNonce();
  const fingerprintHash = await requestFingerprint(
    SERVICE_ROLE_KEY + "\u0000osi-v2-case-read",
    trustedClientAddress(req.headers),
  );
  const { data, error } = await admin.rpc("osi_v2_issue_read_nonce", {
    p_nonce: nonce,
    p_purpose: purpose,
    p_actor_wallet: wallet,
    p_target_type: target.target_type,
    p_target_id: target.target_id,
    p_request_fingerprint_hash: fingerprintHash,
  });
  if (error || !data?.[0]) {
    return jsonResponse(error?.code === "P0001" ? 429 : 503, {
      ok: false,
      error: error?.code === "P0001" ? "rate_limited" : "challenge_unavailable",
    });
  }
  const issuedAt = Math.floor(Date.parse(String(data[0].issued_at)) / 1000);
  const expiresAt = Math.floor(Date.parse(String(data[0].expires_at)) / 1000);
  const fields = {
    purpose,
    target_type: target.target_type,
    target_id: target.target_id,
    wallet,
    nonce,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const mac = await hmacHex(challengeSigningInput(fields));
  return jsonResponse(200, {
    ok: true,
    challenge: buildChallenge(fields, mac),
    expires_at: fields.expires_at,
  });
}

type ProvenActor = { wallet: string };

async function verifySignedRead(
  body: Row,
  purpose: string,
  expectedTarget: { target_type: string; target_id: string },
): Promise<{ ok: true; actor: ProvenActor } | { ok: false; status: number; reason: string }> {
  const wallet = safeText(body.wallet);
  const challenge = safeText(body.challenge);
  const signature = safeText(body.signature);
  if (!wallet || !challenge || !signature) {
    return { ok: false, status: 400, reason: "missing_fields" };
  }
  const fields = parseChallenge(challenge);
  if (!fields) return { ok: false, status: 400, reason: "bad_challenge" };

  const expectedMac = await hmacHex(challengeSigningInput(fields));
  if (!timingSafeEqualHex(expectedMac, fields.hmac ?? "")) {
    return { ok: false, status: 403, reason: "bad_challenge" };
  }
  const binding = validateChallengeBinding(
    fields,
    { purpose, wallet, ...expectedTarget },
    Math.floor(Date.now() / 1000),
  );
  if (!binding.ok) return { ok: false, status: 403, reason: binding.reason ?? "bad_binding" };
  const validSignature = await verifyEd25519Signature(challenge, signature, wallet);
  if (!validSignature) return { ok: false, status: 403, reason: "bad_signature" };
  const { data: consumed, error: consumeError } = await admin.rpc("osi_v2_consume_read_nonce", {
    p_nonce: fields.nonce,
    p_purpose: fields.purpose,
    p_actor_wallet: fields.wallet,
    p_target_type: fields.target_type,
    p_target_id: fields.target_id,
  });
  if (consumeError) return { ok: false, status: 503, reason: "challenge_unavailable" };
  if (consumed !== true) return { ok: false, status: 403, reason: "replayed_or_expired" };
  return { ok: true, actor: { wallet } };
}

// ---------------------------------------------------------------------------
// Signed operations
// ---------------------------------------------------------------------------

async function listMyCases(body: Row): Promise<Response> {
  const wallet = safeText(body.wallet);
  const proof = await verifySignedRead(body, "CASE_READ_MY_CASES", {
    target_type: "wallet_cases",
    target_id: wallet,
  });
  if (!proof.ok) return jsonResponse(proof.status, { ok: false, error: proof.reason });

  const { data, error } = await admin.from("cases").select(CASE_COLS)
    .eq("submitted_by_wallet", proof.actor.wallet)
    .order("created_at", { ascending: false }).limit(100);
  if (error) return jsonResponse(500, { ok: false, error: "read_failed" });
  const caseRows = data ?? [];
  const graph = await loadCaseGraph(caseRows);
  return jsonResponse(200, {
    ok: true,
    cases: caseRows.map((caseRow) => authorizedCaseDto(
      caseRow,
      graph.reportsByCase[String(caseRow.id)] ?? [],
      graph.versionsByReport,
      graph.receiptsByCaseTarget[String(caseRow.public_ref)] ?? [],
      { kind: "owner", wallet: proof.actor.wallet },
      graph.evidenceByCase[String(caseRow.id)] ?? [],
      graph.reviewsByCase[String(caseRow.id)] ?? [],
    )),
  });
}

async function isVerifiedAnalyst(wallet: string): Promise<boolean> {
  const { data } = await admin.from("analyst_profiles")
    .select("wallet,status,verified,approved,weight_cached")
    .eq("wallet", wallet).limit(1);
  const analyst = data?.[0];
  return !!analyst && analyst.verified === true && analyst.approved === true
    && ["probationary_analyst", "verified_analyst", "senior_analyst"].includes(analyst.status)
    && Number(analyst.weight_cached) >= 0.50;
}

async function listReviewableCases(req: Request, body: Row): Promise<Response> {
  const wallet = safeText(body.wallet);
  const proof = await verifySignedRead(body, "CASE_READ_REVIEW_QUEUE", {
    target_type: "review_queue",
    target_id: wallet,
  });
  if (!proof.ok) return jsonResponse(proof.status, { ok: false, error: proof.reason });

  let actorKind: "analyst" | "maintainer" | null = null;
  if (await isVerifiedAnalyst(wallet)) actorKind = "analyst";
  else if (await hasFullMaintainerAccess(req, wallet)) actorKind = "maintainer";
  if (!actorKind) return jsonResponse(403, { ok: false, error: "not_eligible_reviewer" });

  const { data, error } = await admin.from("cases").select(CASE_COLS)
    .eq("stage", "initial_review").eq("visibility", "private")
    .neq("submitted_by_wallet", wallet)
    .order("created_at", { ascending: true }).limit(100);
  if (error) return jsonResponse(500, { ok: false, error: "read_failed" });
  const caseRows = data ?? [];
  const graph = await loadCaseGraph(caseRows);
  return jsonResponse(200, {
    ok: true,
    actor_role: actorKind,
    cases: caseRows.map((caseRow) => authorizedCaseDto(
      caseRow,
      graph.reportsByCase[String(caseRow.id)] ?? [],
      graph.versionsByReport,
      graph.receiptsByCaseTarget[String(caseRow.public_ref)] ?? [],
      { kind: actorKind, wallet },
      graph.evidenceByCase[String(caseRow.id)] ?? [],
      graph.reviewsByCase[String(caseRow.id)] ?? [],
    )),
  });
}

async function hasFullMaintainerAccess(req: Request, wallet: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(MAINTAINER_AUTH_UUID)) return false;
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const [{ data: configRows }, authResult] = await Promise.all([
    admin.from("osi_config").select("value").eq("key", "admin_wallet").limit(1),
    admin.auth.getUser(token),
  ]);
  return authResult.error == null
    && authResult.data?.user?.id === MAINTAINER_AUTH_UUID
    && configRows?.[0]?.value === wallet;
}

async function getAuthorizedCase(req: Request, body: Row): Promise<Response> {
  const caseRef = safeText(body.case_ref);
  if (!/^OSI-[0-9A-Z]{6,20}$/.test(caseRef)) {
    return jsonResponse(400, { ok: false, error: "bad_case_ref" });
  }
  const proof = await verifySignedRead(body, "CASE_READ_AUTHORIZED_CASE", {
    target_type: "case",
    target_id: caseRef,
  });
  if (!proof.ok) return jsonResponse(proof.status, { ok: false, error: proof.reason });

  const { data, error } = await admin.from("cases").select(CASE_COLS)
    .eq("public_ref", caseRef).limit(1);
  if (error) return jsonResponse(500, { ok: false, error: "read_failed" });
  const caseRow = data?.[0];
  if (!caseRow) return jsonResponse(404, { ok: false, error: "not_found_or_denied" });

  // Server-derived actor model: owner by exact wallet, else verified analyst
  // within the analyst read scope. Denials are indistinguishable from absence.
  let actorKind: "owner" | "analyst" | "maintainer" | null = null;
  if (caseRow.submitted_by_wallet === proof.actor.wallet) {
    actorKind = "owner";
  } else if (await isVerifiedAnalyst(proof.actor.wallet)) {
    actorKind = "analyst";
  } else if (await hasFullMaintainerAccess(req, proof.actor.wallet)) {
    actorKind = "maintainer";
  }
  const actor = actorKind
    ? { kind: actorKind, wallet: proof.actor.wallet }
    : { kind: "anonymous" as const };
  if (!canActorReadCase(actor, caseRow)) {
    return jsonResponse(404, { ok: false, error: "not_found_or_denied" });
  }
  const graph = await loadCaseGraph([caseRow]);
  const reports = graph.reportsByCase[String(caseRow.id)] ?? [];
  const receipts = graph.receiptsByCaseTarget[String(caseRow.public_ref)] ?? [];
  // A proven wallet with no owner/analyst standing gets ONLY the public
  // projection of a public Case — never the authorized field set.
  if (!actorKind) {
    return jsonResponse(200, {
      ok: true,
      actor_role: "public",
      case: publicCaseDto(
        caseRow,
        reports,
        graph.versionsByReport,
        receipts,
        graph.evidenceByCase[String(caseRow.id)] ?? [],
        graph.reviewsByCase[String(caseRow.id)] ?? [],
      ),
    });
  }
  return jsonResponse(200, {
    ok: true,
    actor_role: actorKind,
    case: authorizedCaseDto(
      caseRow,
      reports,
      graph.versionsByReport,
      receipts,
      { kind: actorKind, wallet: proof.actor.wallet },
      graph.evidenceByCase[String(caseRow.id)] ?? [],
      graph.reviewsByCase[String(caseRow.id)] ?? [],
    ),
  });
}

// Maintainer double-gate. BOTH must hold, in this order, always evaluated
// fail-closed:
//   Gate 1 — a valid Supabase user session JWT whose subject equals the
//            explicitly configured maintainer auth UUID;
//   Gate 2 — a fresh signed read challenge from the CONFIGURED admin wallet.
// A missing/blank configured admin wallet denies everyone (fail closed).
async function maintainerCaseOverview(req: Request, body: Row): Promise<Response> {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  let authValid = false;
  if (token) {
    try {
      const { data, error } = await admin.auth.getUser(token);
      authValid = !error
        && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(MAINTAINER_AUTH_UUID)
        && data?.user?.id === MAINTAINER_AUTH_UUID;
    } catch {
      authValid = false;
    }
  }

  const { data: configRows } = await admin.from("osi_config").select("key,value")
    .in("key", [
      "admin_wallet", "OSI_V2_WRITES_ENABLED", "OSI_V2_PROOF_ENABLED",
      "OSI_V2_CASE_WRITES_ENABLED",
    ]);
  const config: Record<string, string> = {};
  for (const row of configRows ?? []) config[String(row.key)] = String(row.value ?? "");
  const adminWallet = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.admin_wallet ?? "")
    ? config.admin_wallet
    : "";

  const wallet = safeText(body.wallet);
  let walletValid = false;
  if (adminWallet && wallet === adminWallet) {
    const proof = await verifySignedRead(body, "CASE_READ_MAINTAINER_OVERVIEW", {
      target_type: "config",
      target_id: "maintainer_overview",
    });
    walletValid = proof.ok;
  }

  // Half-maintainer states are explicitly denied; the response names which
  // gate is missing so the operator can complete it, but returns no data.
  if (!authValid && !walletValid) {
    return jsonResponse(403, { ok: false, error: "maintainer_denied" });
  }
  if (!authValid) return jsonResponse(403, { ok: false, error: "half_maintainer_wallet_only" });
  if (!walletValid) return jsonResponse(403, { ok: false, error: "half_maintainer_auth_only" });

  const [casesRes, receiptsRes, crosswalkRes, queueRes] = await Promise.all([
    admin.from("cases").select(CASE_COLS).order("created_at", { ascending: true }).limit(200),
    admin.from("event_receipts").select(RECEIPT_COLS).limit(1000),
    admin.from("migration_crosswalk").select("id", { count: "exact", head: true }),
    admin.from("migration_manual_queue").select("id", { count: "exact", head: true }),
  ]);
  if (casesRes.error) return jsonResponse(500, { ok: false, error: "read_failed" });
  const caseRows = casesRes.data ?? [];
  const graph = await loadCaseGraph(caseRows);
  const receiptTotals: Record<string, number> = {};
  for (const receipt of receiptsRes.data ?? []) {
    const label = proofLabel(receipt);
    receiptTotals[label] = (receiptTotals[label] ?? 0) + 1;
  }
  return jsonResponse(200, {
    ok: true,
    overview: maintainerOverviewDto({
      cases: caseRows,
      reportsByCase: graph.reportsByCase,
      versionsByReport: graph.versionsByReport,
      receiptsByCaseTarget: graph.receiptsByCaseTarget,
      receiptTotals,
      crosswalkCount: crosswalkRes.count ?? 0,
      manualQueueCount: queueRes.count ?? 0,
      flags: {
        OSI_V2_WRITES_ENABLED: config.OSI_V2_WRITES_ENABLED ?? "",
        OSI_V2_PROOF_ENABLED: config.OSI_V2_PROOF_ENABLED ?? "",
        OSI_V2_CASE_WRITES_ENABLED: config.OSI_V2_CASE_WRITES_ENABLED ?? "",
      },
    }),
  });
}

// ---------------------------------------------------------------------------

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
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return jsonResponse(413, { ok: false, error: "body_too_large" });
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
    body = parsed as Row;
  } catch {
    return jsonResponse(400, { ok: false, error: "bad_json" });
  }

  switch (body.op) {
    case "list_public_cases":
      return await listPublicCases();
    case "get_public_case":
      return await getPublicCase(body);
    case "issue_read_challenge":
      return await issueReadChallenge(req, body);
    case "list_my_cases":
      return await listMyCases(body);
    case "list_reviewable_cases":
      return await listReviewableCases(req, body);
    case "get_authorized_case":
      return await getAuthorizedCase(req, body);
    case "maintainer_case_overview":
      return await maintainerCaseOverview(req, body);
    default:
      return jsonResponse(400, { ok: false, error: "bad_op" });
  }
});
