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
import {
  authorizedReportDto,
  publicReportGovernanceDto,
} from "../_shared/osi-v2-report-core.mjs";
import {
  READ_SESSION_SCOPES,
  readSessionIssuer,
  verifyReadSessionToken,
} from "../_shared/osi-v2-read-session-core.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const MAINTAINER_AUTH_UUID = Deno.env.get("OSI_MAINTAINER_AUTH_UUID") ?? "";
const MAX_BODY_BYTES = 16_384;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function readSessionEnabled(): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", "OSI_V2_READ_SESSION_ENABLED").limit(1);
  return !error && data?.[0]?.value === "true";
}

type Row = Record<string, any>;
type Scope = "my_reports" | "review_queue";

const REPORT_COLS =
  "id,case_id,author_wallet,current_version_id,current_published_version_id,status,public_ref,native_intake,created_at,updated_at";
const VERSION_COLS =
  "id,report_id,version_no,version_ref,created_by_wallet,body_private,content_public_safe,evidence_snapshot_hash,supersedes_version_id,revision_reason_code,lifecycle_state,event_receipt_id,publication_receipt_id,publication_quorum_hash,published_at,created_at";
const CASE_COLS = "id,public_ref,stage,visibility,risk_tier,submitted_by_wallet,category,archived_at";
const EVIDENCE_COLS = "id,kind,ref,sha256,is_public,moderation_state";
const RECEIPT_COLS =
  "id,event_version,event_type,target_type,target_id,actor_wallet,actor_role,decision,weight,reason_code,proof_type,tx_sig,server_verified,occurred_at,decision_channel";
const REVIEW_COLS =
  "id,report_version_id,reviewer_wallet,decision,weight,reason_code,is_active,event_receipt_id,public_ref,tier_snapshot,public_rationale,private_note,created_at";

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

async function verifyReadSession(
  req: Request,
  body: Row,
  requiredScope: string,
): Promise<{ ok: true; wallet: string } | { ok: false; status: number; reason: string }> {
  if (!await readSessionEnabled()) {
    return { ok: false as const, status: 503, reason: "read_session_disabled_or_unavailable" };
  }
  const verified = await verifyReadSessionToken({
    token: safeText(body.read_session),
    secret: SERVICE_ROLE_KEY,
    issuer: readSessionIssuer(SUPABASE_URL),
    origin: req.headers.get("origin") ?? "",
    allowedOrigin: ALLOWED_ORIGIN,
    wallet: safeText(body.wallet),
    requiredScope,
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

async function analystEligible(wallet: string): Promise<boolean> {
  const { data, error } = await admin.from("analyst_profiles")
    .select("wallet,status,verified,approved,weight_cached")
    .eq("wallet", wallet).limit(1);
  const row = data?.[0];
  return !error && !!row && row.verified === true && row.approved === true
    && ["probationary_analyst", "verified_analyst", "senior_analyst"].includes(row.status)
    && Number(row.weight_cached) >= 0.5 && Number(row.weight_cached) <= 3;
}

async function reviewWritesEnabled(): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", "OSI_V2_REPORT_REVIEW_WRITES_ENABLED").limit(1);
  return !error && data?.[0]?.value === "true";
}

async function quorumThresholds() {
  const { data, error } = await admin.from("osi_config").select("key,value")
    .in("key", [
      "OSI_V2_REPORT_STANDARD_MIN_ANALYSTS",
      "OSI_V2_REPORT_STANDARD_MIN_WEIGHT",
      "OSI_V2_REPORT_HIGH_MIN_ANALYSTS",
      "OSI_V2_REPORT_HIGH_MIN_WEIGHT",
    ]).limit(4);
  if (error) throw new Error("read_failed");
  const values = new Map((data ?? []).map((row) => [String(row.key), Number(row.value)]));
  return {
    standard: {
      count: values.get("OSI_V2_REPORT_STANDARD_MIN_ANALYSTS") ?? 0,
      weight: values.get("OSI_V2_REPORT_STANDARD_MIN_WEIGHT") ?? 0,
    },
    high: {
      count: values.get("OSI_V2_REPORT_HIGH_MIN_ANALYSTS") ?? 0,
      weight: values.get("OSI_V2_REPORT_HIGH_MIN_WEIGHT") ?? 0,
    },
  };
}

function quorumFor(
  riskTier: string,
  reviews: Row[],
  profileByWallet: Map<string, Row>,
  receiptById: Map<string, Row>,
  thresholds: Row,
) {
  const counted = reviews.filter((review) => {
    const profile = profileByWallet.get(String(review.reviewer_wallet));
    const receipt = receiptById.get(String(review.event_receipt_id));
    return review.is_active === true && !!review.public_ref && !!profile
      && profile.verified === true && profile.approved === true
      && ["probationary_analyst", "verified_analyst", "senior_analyst"].includes(profile.status)
      && receipt?.event_version === "OSI2"
      && ["CASE_REPORT_REVIEW_CAST", "CASE_REPORT_REVIEW_REVISED"].includes(receipt?.event_type)
      && receipt?.target_type === "report_version"
      && receipt?.target_id === String(review.report_version_id)
      && receipt?.actor_wallet === review.reviewer_wallet
      && ["analyst", "senior"].includes(receipt?.actor_role)
      && receipt?.decision === review.decision
      && Number(receipt?.weight) === Number(review.weight)
      && (receipt?.reason_code ?? null) === (review.reason_code ?? null)
      && receipt?.server_verified === true
      && receipt?.proof_type === "wallet_signed_server_verified";
  });
  const selected = riskTier === "high" ? thresholds.high : thresholds.standard;
  const approve = counted.filter((review) => review.decision === "approve");
  const reject = counted.filter((review) => review.decision === "reject");
  const approveWeight = approve.reduce((sum, review) => sum + Number(review.weight), 0);
  const rejectWeight = reject.reduce((sum, review) => sum + Number(review.weight), 0);
  return {
    risk_tier: riskTier,
    approve_count: approve.length,
    approve_weight: approveWeight,
    reject_count: reject.length,
    reject_weight: rejectWeight,
    required_count: selected.count,
    required_weight: selected.weight,
    approve_ready: approve.length >= selected.count && approveWeight >= selected.weight,
    reject_ready: reject.length >= selected.count && rejectWeight >= selected.weight,
  };
}

function publicReviewHistory(
  versionId: string,
  reviews: Row[],
  receiptById: Map<string, Row>,
) {
  return reviews.filter((review) => {
    const receipt = receiptById.get(String(review.event_receipt_id));
    return !!review.public_ref
      && receipt?.event_version === "OSI2"
      && ["CASE_REPORT_REVIEW_CAST", "CASE_REPORT_REVIEW_REVISED"].includes(receipt?.event_type)
      && receipt?.target_type === "report_version"
      && receipt?.target_id === versionId
      && receipt?.actor_wallet === review.reviewer_wallet
      && ["analyst", "senior"].includes(receipt?.actor_role)
      && receipt?.decision === review.decision
      && Number(receipt?.weight) === Number(review.weight)
      && (receipt?.reason_code ?? null) === (review.reason_code ?? null)
      && receipt?.server_verified === true
      && receipt?.proof_type === "wallet_signed_server_verified";
  });
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

async function loadReports(
  headers: Row[],
  access: "author" | "analyst" | "maintainer",
  viewerWallet = "",
) {
  if (!headers.length) return [];
  const reportIds = headers.map((row) => String(row.id));
  const caseIds = [...new Set(headers.map((row) => String(row.case_id)))];
  const [{ data: versions, error: versionError }, { data: cases, error: caseError }] = await Promise.all([
    admin.from("case_report_versions").select(VERSION_COLS)
      .in("report_id", reportIds).order("version_no", { ascending: true }).limit(1000),
    admin.from("cases").select(CASE_COLS).in("id", caseIds).is("archived_at", null)
      .neq("category", "legacy_import").limit(500),
  ]);
  if (versionError || caseError) throw new Error("read_failed");
  const versionRows = versions ?? [];
  const versionIds = versionRows.map((row) => String(row.id));
  const { data: reviews, error: reviewError } = versionIds.length
    ? await admin.from("case_report_reviews").select(REVIEW_COLS)
      .in("report_version_id", versionIds).order("created_at", { ascending: true }).limit(5000)
    : { data: [], error: null };
  if (reviewError) throw new Error("read_failed");
  const receiptIds = [...new Set([
    ...versionRows.map((row) => String(row.event_receipt_id)),
    ...versionRows.map((row) => String(row.publication_receipt_id || "")).filter(Boolean),
    ...(reviews ?? []).map((row) => String(row.event_receipt_id)),
  ])];
  const reviewerWallets = [...new Set((reviews ?? []).map((row) => String(row.reviewer_wallet)))];
  const [{ data: links, error: linkError }, { data: receipts, error: receiptError }, profileResult, thresholds] = await Promise.all([
    versionIds.length
      ? admin.from("case_report_version_evidence")
        .select("report_version_id,evidence_item_id,ordinal")
        .in("report_version_id", versionIds).order("ordinal", { ascending: true }).limit(5000)
      : Promise.resolve({ data: [], error: null }),
    receiptIds.length
      ? admin.from("event_receipts").select(RECEIPT_COLS).in("id", receiptIds).limit(6000)
      : Promise.resolve({ data: [], error: null }),
    reviewerWallets.length
      ? admin.from("analyst_profiles")
        .select("wallet,handle,display_name,status,tier_code,verified,approved,weight_cached")
        .in("wallet", reviewerWallets).limit(1000)
      : Promise.resolve({ data: [], error: null }),
    quorumThresholds(),
  ]);
  if (linkError || receiptError || profileResult.error) throw new Error("read_failed");
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
  const profileByWallet = new Map((profileResult.data ?? []).map((row) => [String(row.wallet), row]));
  const reviewsByVersion = new Map<string, Row[]>();
  for (const review of reviews ?? []) {
    const key = String(review.report_version_id);
    const profile = profileByWallet.get(String(review.reviewer_wallet));
    const rows = reviewsByVersion.get(key) ?? [];
    rows.push({
      ...review,
      reviewer_handle: profile?.handle ?? null,
      receipt: receiptById.get(String(review.event_receipt_id)) ?? null,
    });
    reviewsByVersion.set(key, rows);
  }
  for (const version of versionRows) {
    const receipt = receiptById.get(String(version.event_receipt_id));
    if (receipt) receiptByVersion.set(String(version.id), receipt);
  }

  const reviewEnabled = await reviewWritesEnabled();
  return headers.filter((header) => {
    const caseRow = caseById.get(String(header.case_id));
    return !!caseRow && (access !== "analyst" || (
      header.author_wallet !== viewerWallet
      && caseRow?.submitted_by_wallet !== viewerWallet
    ));
  }).map((header) => {
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
    const quorumByVersion = new Map<string, Row>();
    for (const version of reportVersions) {
      quorumByVersion.set(String(version.id), quorumFor(
        String(caseRow?.risk_tier || "standard"),
        reviewsByVersion.get(String(version.id)) ?? [],
        profileByWallet,
        receiptById,
        thresholds,
      ));
    }
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
      review_mutations_enabled: access === "analyst" && reviewEnabled,
    }, reportVersions, evidenceByVersion, receiptByVersion, access,
    reviewsByVersion, quorumByVersion);
  });
}

async function listMyReports(req: Request, body: Row): Promise<Response> {
  const proof = await verifyReadSession(req, body, READ_SESSION_SCOPES.REPORT_MINE);
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
  const proof = await verifyReadSession(req, body, READ_SESSION_SCOPES.REPORT_REVIEW);
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
    const reviewEnabled = await reviewWritesEnabled();
    const reports = (await loadReports(data ?? [], access, proof.wallet)).filter((report) => {
      const current = report.versions.find(
        (version: Row) => version.version_ref === report.current_version_ref,
      );
      return current && ["submitted", "in_review"].includes(current.lifecycle_state);
    });
    return jsonResponse(200, {
      ok: true,
      actor_role: access,
      queue_state: "awaiting_review",
      review_mutations_enabled: access === "analyst" && reviewEnabled,
      next_prerequisite: !reviewEnabled
        ? "Counted Report review and publication are safely disabled during rollout."
        : access === "maintainer"
        ? "Maintainers may inspect restricted review material but cannot replace analyst quorum."
        : null,
      reports,
    });
  } catch {
    return jsonResponse(500, { ok: false, error: "read_failed" });
  }
}

async function listPublicReports(body: Row): Promise<Response> {
  const caseRef = safeText(body.case_ref);
  if (!/^OSI-[0-9A-F]{12}$/.test(caseRef)) {
    return jsonResponse(404, { ok: false, error: "case_not_available" });
  }
  const { data: cases, error: caseError } = await admin.from("cases")
    .select("id,public_ref,risk_tier,visibility,category,archived_at")
    .eq("public_ref", caseRef).eq("visibility", "public").is("archived_at", null)
    .neq("category", "legacy_import").limit(1);
  const caseRow = cases?.[0];
  if (caseError || !caseRow) {
    return jsonResponse(404, { ok: false, error: "case_not_available" });
  }
  const { data: headers, error: headerError } = await admin.from("case_reports")
    .select(REPORT_COLS).eq("case_id", caseRow.id).eq("native_intake", true)
    .eq("status", "active").not("public_ref", "is", null)
    .order("created_at", { ascending: true }).limit(200);
  if (headerError) return jsonResponse(500, { ok: false, error: "read_failed" });
  const versionIds = [...new Set((headers ?? []).flatMap((header) => [
    String(header.current_version_id || ""),
    String(header.current_published_version_id || ""),
  ]).filter(Boolean))];
  if (!versionIds.length) return jsonResponse(200, { ok: true, case_public_ref: caseRef, reports: [] });
  try {
    const [{ data: versions, error: versionError }, { data: reviews, error: reviewError }, thresholds] = await Promise.all([
      admin.from("case_report_versions").select(VERSION_COLS).in("id", versionIds).limit(400),
      admin.from("case_report_reviews").select(REVIEW_COLS)
        .in("report_version_id", versionIds).order("created_at", { ascending: true }).limit(5000),
      quorumThresholds(),
    ]);
    if (versionError || reviewError) throw new Error("read_failed");
    const reviewerWallets = [...new Set((reviews ?? []).map((row) => String(row.reviewer_wallet)))];
    const receiptIds = [...new Set([
      ...(reviews ?? []).map((row) => String(row.event_receipt_id)),
      ...(versions ?? []).map((row) => String(row.publication_receipt_id || "")).filter(Boolean),
    ])];
    const [profileResult, receiptResult] = await Promise.all([
      reviewerWallets.length
        ? admin.from("analyst_profiles")
          .select("wallet,handle,status,tier_code,verified,approved,weight_cached")
          .in("wallet", reviewerWallets).limit(1000)
        : Promise.resolve({ data: [], error: null }),
      receiptIds.length
        ? admin.from("event_receipts").select(RECEIPT_COLS).in("id", receiptIds).limit(6000)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (profileResult.error || receiptResult.error) throw new Error("read_failed");
    const profileByWallet = new Map((profileResult.data ?? []).map((row) => [String(row.wallet), row]));
    const receiptById = new Map((receiptResult.data ?? []).map((row) => [String(row.id), row]));
    const reviewsByVersion = new Map<string, Row[]>();
    for (const review of reviews ?? []) {
      const key = String(review.report_version_id);
      const rows = reviewsByVersion.get(key) ?? [];
      rows.push({
        ...review,
        reviewer_handle: profileByWallet.get(String(review.reviewer_wallet))?.handle ?? null,
        receipt: receiptById.get(String(review.event_receipt_id)) ?? null,
      });
      reviewsByVersion.set(key, rows);
    }
    const visibleVersions = (versions ?? []).filter((version) => {
      if (version.lifecycle_state === "published") return true;
      if (version.lifecycle_state !== "in_review") return false;
      const rows = reviewsByVersion.get(String(version.id)) ?? [];
      return quorumFor(
        String(caseRow.risk_tier || "standard"), rows,
        profileByWallet, receiptById, thresholds,
      ).approve_count >= 1;
    });
    const publishedIds = visibleVersions.filter((row) => row.lifecycle_state === "published")
      .map((row) => String(row.id));
    const { data: links, error: linkError } = publishedIds.length
      ? await admin.from("case_report_version_evidence")
        .select("report_version_id,evidence_item_id,ordinal")
        .in("report_version_id", publishedIds).order("ordinal", { ascending: true }).limit(5000)
      : { data: [], error: null };
    if (linkError) throw new Error("read_failed");
    const evidenceIds = [...new Set((links ?? []).map((row) => String(row.evidence_item_id)))];
    const evidenceResult = evidenceIds.length
      ? await admin.from("evidence_items").select(EVIDENCE_COLS).in("id", evidenceIds).limit(5000)
      : { data: [], error: null };
    if (evidenceResult.error) throw new Error("read_failed");
    const evidenceById = new Map((evidenceResult.data ?? []).map((row) => [String(row.id), row]));
    const evidenceByVersion = new Map<string, Row[]>();
    for (const link of links ?? []) {
      const item = evidenceById.get(String(link.evidence_item_id));
      if (!item) continue;
      const key = String(link.report_version_id);
      const rows = evidenceByVersion.get(key) ?? [];
      rows.push({ ...item, ordinal: link.ordinal });
      evidenceByVersion.set(key, rows);
    }
    const headerById = new Map((headers ?? []).map((row) => [String(row.id), row]));
    const reports = visibleVersions.map((version) => {
      const header = headerById.get(String(version.report_id));
      const reviewRows = reviewsByVersion.get(String(version.id)) ?? [];
      const publicReviews = publicReviewHistory(String(version.id), reviewRows, receiptById);
      return publicReportGovernanceDto({
        report_public_ref: header?.public_ref,
        version_public_ref: version.version_ref,
        version_no: version.version_no,
        lifecycle_state: version.lifecycle_state,
        content_public_safe: version.content_public_safe,
        body_private: version.body_private,
        evidence: evidenceByVersion.get(String(version.id)) ?? [],
        quorum: quorumFor(
          String(caseRow.risk_tier || "standard"), reviewRows,
          profileByWallet, receiptById, thresholds,
        ),
        reviews: publicReviews,
        publication_receipt: receiptById.get(String(version.publication_receipt_id)) ?? null,
        published_at: version.published_at,
      });
    });
    return jsonResponse(200, { ok: true, case_public_ref: caseRef, reports });
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
    case "list_public_reports": return await listPublicReports(body);
    case "issue_read_challenge": return await issueChallenge(req, body);
    case "list_my_reports": return await listMyReports(req, body);
    case "list_review_queue": return await listReviewQueue(req, body);
    default: return jsonResponse(400, { ok: false, error: "bad_op" });
  }
});
