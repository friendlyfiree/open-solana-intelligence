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
import {
  isExactReadSessionOrigin,
  issueReadSessionToken,
  READ_SESSION_SCOPES,
  readSessionIssuer,
  verifyReadSessionToken,
} from "../_shared/osi-v2-read-session-core.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const MAINTAINER_AUTH_UUID = Deno.env.get("OSI_MAINTAINER_AUTH_UUID") ?? "";
const MAX_BODY_BYTES = 16_384;
const PUBLIC_LIST_LIMIT = 50;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function readSessionEnabled(): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", "OSI_V2_READ_SESSION_ENABLED").limit(1);
  return !error && data?.[0]?.value === "true";
}

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
  "id,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,decision,weight,reason_code,proof_type,memo_ref,tx_sig,server_verified,occurred_at,verification_metadata";
const PLEDGE_COLS =
  "id,case_id,pledger_wallet,amount_lamports,state,winning_report_version_id,revision_no,sealed_amount_lamports,withdrawn_at,updated_at";
const PAYMENT_COLS =
  "id,pledge_id,from_wallet,to_wallet,amount_lamports,tx_sig,state,confirmed_at,event_receipt_id,finality,verification_error,created_at";
const SUPPORT_COLS =
  "id,support_type,case_report_version_id,analyst_wallet,target_wallet,from_wallet,amount_lamports,tx_sig,state,event_receipt_id,case_id,context_report_version_id,recipient_manifest,confirmed_at,finality,verification_error,created_at";
const EVIDENCE_COLS =
  "id,kind,ref,is_public,moderation_state,sha256,created_at";
const REVIEW_COLS =
  "id,case_id,reviewer_wallet,decision,reviewer_role,weight,reason_code,is_active,event_receipt_id,created_at";
const RESOLUTION_COLS =
  "id,case_id,winning_report_version_id,public_ref,state,challenge_window_opens_at,challenge_window_ends_at,final_receipt_id,seal_receipt_id,reopened_at,sealed_at,created_at";
const RESOLUTION_REVIEW_COLS =
  "id,resolution_id,candidate_report_version_id,phase,public_ref,reviewer_wallet,decision,weight,tier_snapshot,public_rationale,private_note,is_active,event_receipt_id,created_at";
const CHALLENGE_COLS =
  "id,resolution_id,public_ref,challenger_wallet,reason_code,state,public_safe_summary,restricted_detail,admissibility_ttl_at,review_deadline_at,terminal_at,submitted_receipt_id,opened_receipt_id,resolved_receipt_id,created_at";
const CHALLENGE_REVIEW_COLS =
  "id,challenge_id,phase,public_ref,reviewer_wallet,decision,weight,tier_snapshot,public_rationale,private_note,is_active,event_receipt_id,created_at";

type Row = Record<string, unknown>;

async function loadCaseGraph(caseRows: Row[], publicOnly = false) {
  const caseIds = caseRows.map((c) => String(c.id));
  const publicRefs = caseRows.map((c) => String(c.public_ref));
  const reportsByCase: Record<string, Row[]> = {};
  const versionsByReport: Record<string, Row[]> = {};
  const receiptsByCaseTarget: Record<string, Row[]> = {};
  const evidenceByCase: Record<string, Row[]> = {};
  const reviewsByCase: Record<string, Row[]> = {};
  const governanceByCase: Record<string, Row> = {};
  const moneyByCase: Record<string, Row> = {};
  if (!caseIds.length) {
    return { reportsByCase, versionsByReport, receiptsByCaseTarget, evidenceByCase, reviewsByCase, governanceByCase, moneyByCase };
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

  const { data: pledges } = await admin.from("reward_pledges").select(PLEDGE_COLS)
    .in("case_id", caseIds).limit(200);
  const pledgeIds = (pledges ?? []).map((row) => String(row.id));
  const [{ data: payments }, { data: supports }] = await Promise.all([
    pledgeIds.length
      ? admin.from("reward_payments").select(PAYMENT_COLS).in("pledge_id", pledgeIds)
        .order("created_at", { ascending: true }).limit(500)
      : Promise.resolve({ data: [] }),
    admin.from("support_events").select(SUPPORT_COLS).in("case_id", caseIds)
      .order("created_at", { ascending: true }).limit(500),
  ]);
  const publishedVersionIds = (reports ?? []).map((row) => String(row.current_published_version_id ?? ""))
    .filter(Boolean);
  const { data: reportReviews } = publishedVersionIds.length
    ? await admin.from("case_report_reviews")
      .select("report_version_id,reviewer_wallet,weight,is_active")
      .in("report_version_id", publishedVersionIds).eq("is_active", true).limit(1000)
    : { data: [] };
  const reviewerWallets = [...new Set((reportReviews ?? []).map((row) => String(row.reviewer_wallet)))];
  const { data: reviewerProfiles } = reviewerWallets.length
    ? await admin.from("analyst_profiles")
      .select("wallet,status,verified,approved,weight_cached").in("wallet", reviewerWallets).limit(1000)
    : { data: [] };
  const eligibleReviewerWallets = new Set((reviewerProfiles ?? []).filter((row) => (
    row.verified === true && row.approved === true
    && ["probationary_analyst", "verified_analyst", "senior_analyst"].includes(String(row.status))
    && Number(row.weight_cached) >= 0.50
  )).map((row) => String(row.wallet)));
  const versionById: Record<string, Row> = {};
  for (const version of Object.values(versionsByReport).flat()) versionById[String(version.id)] = version;
  for (const caseRow of caseRows) {
    const caseId = String(caseRow.id);
    const pledge = (pledges ?? []).find((row) => String(row.case_id) === caseId) ?? null;
    const caseReports = reportsByCase[caseId] ?? [];
    const options: Row[] = [];
    for (const report of caseReports.filter((row) => row.current_published_version_id != null)) {
      const version = versionById[String(report.current_published_version_id)];
      if (!version) continue;
      options.push({
        target_type: "report_author", target_ref: version.version_ref,
        wallet: report.author_wallet, label: `Report author ${String(version.version_ref)}`,
      });
      for (const review of (reportReviews ?? []).filter((row) => (
        String(row.report_version_id) === String(version.id)
        && eligibleReviewerWallets.has(String(row.reviewer_wallet))
      ))) {
        options.push({
          target_type: "counted_reviewer", target_ref: version.version_ref,
          wallet: review.reviewer_wallet, label: `Counted reviewer ${String(review.reviewer_wallet)}`,
        });
      }
    }
    const winningVersion = pledge?.winning_report_version_id
      ? versionById[String(pledge.winning_report_version_id)] : null;
    const winningReport = winningVersion
      ? (reports ?? []).find((row) => String(row.id) === String(winningVersion.report_id)) : null;
    moneyByCase[caseId] = {
      pledge,
      payments: pledge ? (payments ?? []).filter((row) => String(row.pledge_id) === String(pledge.id)) : [],
      supports: (supports ?? []).filter((row) => String(row.case_id) === caseId),
      support_options: options.filter((row, index, all) => all.findIndex((candidate) => (
        candidate.target_type === row.target_type && candidate.target_ref === row.target_ref
        && candidate.wallet === row.wallet
      )) === index),
      winning_report_version_ref: winningVersion?.version_ref ?? null,
      winning_report_author_wallet: winningReport?.author_wallet ?? null,
    };
  }

  const [{ data: resolutions }, { data: configRows }] = await Promise.all([
    admin.from("case_resolutions").select(RESOLUTION_COLS)
      .in("case_id", caseIds).order("created_at", { ascending: true }).limit(300),
    admin.from("osi_config").select("key,value").in("key", [
      "OSI_V2_RESOLUTION_STANDARD_MIN_COUNT", "OSI_V2_RESOLUTION_STANDARD_MIN_WEIGHT",
      "OSI_V2_RESOLUTION_HIGH_MIN_COUNT", "OSI_V2_RESOLUTION_HIGH_MIN_WEIGHT",
      "OSI_V2_CHALLENGE_MIN_COUNT", "OSI_V2_CHALLENGE_MIN_WEIGHT",
      "OSI_V2_SEAL_MIN_COUNT", "OSI_V2_SEAL_MIN_WEIGHT",
    ]),
  ]);
  const winningVersionIds = (resolutions ?? [])
    .map((row) => String(row.winning_report_version_id ?? "")).filter(Boolean);
  const { data: winningVersions } = winningVersionIds.length
    ? await admin.from("case_report_versions").select("id,version_ref")
      .in("id", winningVersionIds).limit(300)
    : { data: [] };
  const resolutionIds = (resolutions ?? []).map((row) => String(row.id));
  const [{ data: resolutionReviews }, { data: challenges }] = resolutionIds.length
    ? await Promise.all([
      admin.from("resolution_reviews").select(RESOLUTION_REVIEW_COLS)
        .in("resolution_id", resolutionIds).order("created_at", { ascending: true }).limit(1000),
      admin.from("challenges_v2").select(CHALLENGE_COLS)
        .in("resolution_id", resolutionIds).order("created_at", { ascending: true }).limit(500),
    ])
    : [{ data: [] }, { data: [] }];
  const challengeIds = (challenges ?? []).map((row) => String(row.id));
  const { data: challengeReviews } = challengeIds.length
    ? await admin.from("challenge_reviews").select(CHALLENGE_REVIEW_COLS)
      .in("challenge_id", challengeIds).order("created_at", { ascending: true }).limit(1500)
    : { data: [] };

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
  const paymentIds = [...(payments ?? []), ...(supports ?? [])].map((row) => String(row.id));
  const paymentCaseRef: Record<string, string> = {};
  for (const caseRow of caseRows) {
    const money = moneyByCase[String(caseRow.id)] ?? {};
    for (const row of [...(money.payments as Row[] ?? []), ...(money.supports as Row[] ?? [])]) {
      paymentCaseRef[String(row.id)] = String(caseRow.public_ref);
    }
  }
  const targetIds = [...publicRefs, ...caseIds, ...versionIds, ...resolutionIds, ...challengeIds, ...paymentIds];
  if (targetIds.length) {
    const { data: receipts } = await admin.from("event_receipts").select(RECEIPT_COLS)
      .in("target_id", targetIds).order("occurred_at", { ascending: true }).limit(400);
    for (const receipt of receipts ?? []) {
      const targetId = String(receipt.target_id);
      const directCase = caseRows.find((c) => String(c.id) === targetId);
      const resolution = (resolutions ?? []).find((row) => String(row.id) === targetId);
      const challenge = (challenges ?? []).find((row) => String(row.id) === targetId);
      const challengeResolution = challenge
        ? (resolutions ?? []).find((row) => String(row.id) === String(challenge.resolution_id))
        : null;
      const governanceCase = resolution ?? challengeResolution;
      const governanceCaseRow = governanceCase
        ? caseRows.find((row) => String(row.id) === String(governanceCase.case_id))
        : null;
      const ref = publicRefs.includes(targetId)
        ? targetId : (directCase ? String(directCase.public_ref)
          : (versionCaseRef[targetId] ?? paymentCaseRef[targetId]
            ?? (governanceCaseRow ? String(governanceCaseRow.public_ref) : "")));
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

  const versionRefById: Record<string, string> = {};
  for (const version of Object.values(versionsByReport).flat()) {
    versionRefById[String(version.id)] = String(version.version_ref ?? "");
  }
  for (const version of winningVersions ?? []) {
    versionRefById[String(version.id)] = String(version.version_ref ?? "");
  }
  const config: Record<string, number> = {};
  for (const row of configRows ?? []) config[String(row.key)] = Number(row.value);
  const tally = (rows: Row[], decision: string) => {
    const selected = rows.filter((row) => row.is_active === true && row.decision === decision);
    return { count: selected.length, weight: selected.reduce((sum, row) => sum + Number(row.weight ?? 0), 0) };
  };
  for (const caseRow of caseRows) {
    const caseResolutions = (resolutions ?? []).filter((row) => String(row.case_id) === String(caseRow.id));
    const resolution = caseResolutions.slice().sort((left, right) => (
      new Date(String(right.created_at)).getTime() - new Date(String(left.created_at)).getTime()
    ))[0];
    if (!resolution) { governanceByCase[String(caseRow.id)] = { resolution: null, challenges: [] }; continue; }
    const resReviews = (resolutionReviews ?? []).filter((row) => String(row.resolution_id) === String(resolution.id));
    const minimumCount = caseRow.risk_tier === "high"
      ? config.OSI_V2_RESOLUTION_HIGH_MIN_COUNT : config.OSI_V2_RESOLUTION_STANDARD_MIN_COUNT;
    const minimumWeight = caseRow.risk_tier === "high"
      ? config.OSI_V2_RESOLUTION_HIGH_MIN_WEIGHT : config.OSI_V2_RESOLUTION_STANDARD_MIN_WEIGHT;
    const candidateTallies: Record<string, { count: number; weight: number }> = {};
    // The modeled table has one globally active review per resolution/wallet.
    // A later seal-phase cast therefore retires that wallet's active selection
    // row without erasing it. Derive the immutable selection snapshot from the
    // latest row in the selection phase, never from the cross-phase active bit.
    const latestSelectionByWallet = new Map<string, Row>();
    for (const review of resReviews.filter((row) => row.phase === "selection")) {
      latestSelectionByWallet.set(String(review.reviewer_wallet), review);
    }
    for (const review of [...latestSelectionByWallet.values()]
      .filter((row) => row.decision === "select")) {
      const key = String(review.candidate_report_version_id);
      const entry = candidateTallies[key] ??= { count: 0, weight: 0 };
      entry.count += 1; entry.weight += Number(review.weight ?? 0);
    }
    const ready = Object.entries(candidateTallies)
      .filter(([, value]) => value.count >= minimumCount && value.weight >= minimumWeight)
      .sort((left, right) => right[1].weight - left[1].weight
        || right[1].count - left[1].count || left[0].localeCompare(right[0]));
    const tie = ready.length > 1 && ready[0][1].weight === ready[1][1].weight
      && ready[0][1].count === ready[1][1].count;
    const sealTally = tally(resReviews.filter((row) => row.phase === "seal"), "select");
    const resolutionChallenges = (challenges ?? []).filter((row) => String(row.resolution_id) === String(resolution.id));
    governanceByCase[String(caseRow.id)] = {
      resolution: {
        ...resolution,
        winning_report_version_ref: versionRefById[String(resolution.winning_report_version_id)] || null,
        final_receipt: receiptById[String(resolution.final_receipt_id)] ?? null,
        seal_receipt: receiptById[String(resolution.seal_receipt_id)] ?? null,
        selection_quorum: {
          leader_version_ref: tie || !ready[0] ? null : versionRefById[ready[0][0]] || null,
          leader_count: ready[0]?.[1].count ?? 0,
          leader_weight: ready[0]?.[1].weight ?? 0,
          required_count: minimumCount || 0, required_weight: minimumWeight || 0,
          ready_candidate_count: ready.length, tie_unresolved: tie,
        },
        seal_quorum: {
          approve_count: sealTally.count, approve_weight: sealTally.weight,
          required_count: config.OSI_V2_SEAL_MIN_COUNT || 0,
          required_weight: config.OSI_V2_SEAL_MIN_WEIGHT || 0,
          ready: sealTally.count >= config.OSI_V2_SEAL_MIN_COUNT
            && sealTally.weight >= config.OSI_V2_SEAL_MIN_WEIGHT,
        },
      },
      resolution_reviews: resReviews.map((review) => ({
        ...review,
        candidate_version_ref: versionRefById[String(review.candidate_report_version_id)] || null,
        receipt: receiptById[String(review.event_receipt_id)] ?? null,
      })),
      challenges: resolutionChallenges.map((challenge) => {
        const rows = (challengeReviews ?? []).filter((row) => String(row.challenge_id) === String(challenge.id));
        const accepted = tally(rows.filter((row) => row.phase === "merit"), "accept");
        const rejected = tally(rows.filter((row) => row.phase === "merit"), "reject");
        return {
          ...challenge,
          outcome_quorum: {
            accept_count: accepted.count, accept_weight: accepted.weight,
            reject_count: rejected.count, reject_weight: rejected.weight,
            required_count: config.OSI_V2_CHALLENGE_MIN_COUNT || 0,
            required_weight: config.OSI_V2_CHALLENGE_MIN_WEIGHT || 0,
          },
          submitted_receipt: receiptById[String(challenge.submitted_receipt_id)] ?? null,
          opened_receipt: receiptById[String(challenge.opened_receipt_id)] ?? null,
          resolved_receipt: receiptById[String(challenge.resolved_receipt_id)] ?? null,
          reviews: rows.map((review) => ({
            ...review, receipt: receiptById[String(review.event_receipt_id)] ?? null,
          })),
        };
      }),
    };
  }
  return { reportsByCase, versionsByReport, receiptsByCaseTarget, evidenceByCase, reviewsByCase, governanceByCase, moneyByCase };
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
      graph.governanceByCase[String(caseRow.id)] ?? {},
      graph.moneyByCase[String(caseRow.id)] ?? {},
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
      graph.governanceByCase[String(caseRow.id)] ?? {},
      graph.moneyByCase[String(caseRow.id)] ?? {},
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

async function verifyReadSession(
  req: Request,
  body: Row,
  requiredScope: string,
): Promise<{ ok: true; actor: ProvenActor; payload: Row } | { ok: false; status: number; reason: string }> {
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
    requiredScope,
  });
  if (verified.ok === true && typeof verified.wallet === "string") {
    return { ok: true, actor: { wallet: verified.wallet }, payload: verified.payload as Row };
  }
  return {
    ok: false,
    status: typeof verified.status === "number" ? verified.status : 403,
    reason: typeof verified.reason === "string" ? verified.reason : "read_session_tampered",
  };
}

async function issueReadSessionChallenge(req: Request, body: Row): Promise<Response> {
  if (!await readSessionEnabled()) {
    return jsonResponse(503, { ok: false, error: "read_session_disabled_or_unavailable" });
  }
  if (!isExactReadSessionOrigin(req.headers.get("origin") ?? "", ALLOWED_ORIGIN)) {
    return jsonResponse(403, { ok: false, error: "read_session_wrong_origin" });
  }
  return await issueReadChallenge(req, {
    ...body,
    purpose: "CASE_READ_MY_CASES",
    case_ref: "",
  });
}

async function createReadSession(req: Request, body: Row): Promise<Response> {
  if (!await readSessionEnabled()) {
    return jsonResponse(503, { ok: false, error: "read_session_disabled_or_unavailable" });
  }
  const wallet = safeText(body.wallet);
  const proof = await verifySignedRead(body, "CASE_READ_MY_CASES", {
    target_type: "wallet_cases",
    target_id: wallet,
  });
  if (!proof.ok) return jsonResponse(proof.status, { ok: false, error: proof.reason });

  const [analyst, maintainer] = await Promise.all([
    isVerifiedAnalyst(wallet),
    hasFullMaintainerAccess(req, wallet),
  ]);
  const scopes: string[] = [
    READ_SESSION_SCOPES.CASE_MINE,
    READ_SESSION_SCOPES.CASE_DETAIL,
    READ_SESSION_SCOPES.REPORT_MINE,
    READ_SESSION_SCOPES.ANALYST_WORKSPACE,
  ];
  if (analyst || maintainer) {
    scopes.push(READ_SESSION_SCOPES.CASE_REVIEW, READ_SESSION_SCOPES.REPORT_REVIEW);
  }
  if (maintainer) {
    scopes.push(READ_SESSION_SCOPES.CASE_MAINTAINER, READ_SESSION_SCOPES.ANALYST_MAINTAINER);
  }
  try {
    const issued = await issueReadSessionToken({
      secret: SERVICE_ROLE_KEY,
      issuer: readSessionIssuer(SUPABASE_URL),
      audience: req.headers.get("origin") ?? "",
      allowedOrigin: ALLOWED_ORIGIN,
      wallet,
      scopes,
      authSubject: maintainer ? MAINTAINER_AUTH_UUID : null,
      jti: randomNonce(),
    });
    return jsonResponse(200, {
      ok: true,
      read_session: issued.token,
      wallet,
      scopes: issued.payload.scp,
      issued_at: issued.payload.iat,
      expires_at: issued.payload.exp,
      ttl_seconds: issued.payload.exp - issued.payload.iat,
      auth_user_id: issued.payload.auth_sub,
      read_only: true,
    });
  } catch {
    return jsonResponse(503, { ok: false, error: "read_session_configuration_invalid" });
  }
}

// ---------------------------------------------------------------------------
// Signed operations
// ---------------------------------------------------------------------------

async function listMyCases(req: Request, body: Row): Promise<Response> {
  const wallet = safeText(body.wallet);
  const proof = await verifyReadSession(req, body, READ_SESSION_SCOPES.CASE_MINE);
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
      graph.governanceByCase[String(caseRow.id)] ?? {},
      graph.moneyByCase[String(caseRow.id)] ?? {},
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

function buildReviewTasks(
  cases: Row[], wallet: string, actorKind: "analyst" | "maintainer",
  analystWeight: number | null, reportVotesByVersion: Record<string, Row>,
) {
  const groups: Record<string, Row[]> = {
    report_publication: [], resolution_selection: [], challenge_admissibility: [],
    challenge_adjudication: [], seal_reviews: [],
  };
  const task = (lane: string, value: Row) => groups[lane].push({
    lane, deadline: null, conflict: false, current_vote: null,
    weight_snapshot: actorKind === "analyst" ? analystWeight : null,
    ...value,
  });
  for (const caseItem of cases) {
    const caseRef = String(caseItem.public_ref ?? "");
    const reports = Array.isArray(caseItem.reports) ? caseItem.reports as Row[] : [];
    for (const report of reports) {
      const author = String(report.author_wallet ?? "");
      for (const version of Array.isArray(report.versions) ? report.versions as Row[] : []) {
        if (version.lifecycle_state !== "in_review") continue;
        const ref = String(version.version_ref ?? "");
        const vote = reportVotesByVersion[ref];
        task("report_publication", {
          case_ref: caseRef, exact_target: ref, conflict: author === wallet,
          current_vote: vote ? String(vote.decision ?? "") : null,
          weight_snapshot: vote ? Number(vote.weight ?? analystWeight ?? 0)
            : (actorKind === "analyst" ? analystWeight : null),
          next_action: author === wallet ? "Self-review excluded"
            : (actorKind === "analyst" ? "Review exact Report version" : "Analyst quorum required"),
        });
      }
    }
    const governance = caseItem.governance && typeof caseItem.governance === "object"
      ? caseItem.governance as Row : {};
    const resolution = governance.resolution && typeof governance.resolution === "object"
      ? governance.resolution as Row : null;
    if (!resolution) continue;
    const reviews = Array.isArray(resolution.reviews) ? resolution.reviews as Row[] : [];
    const winningRef = String(resolution.winning_report_version_ref ?? "");
    const selectedReport = reports.find((report) => (
      (Array.isArray(report.versions) ? report.versions as Row[] : [])
        .some((version) => String(version.version_ref ?? "") === winningRef)
    ));
    const selectedAuthorConflict = String(selectedReport?.author_wallet ?? "") === wallet;
    if (resolution.state === "selection_open") {
      for (const report of reports) {
        const author = String(report.author_wallet ?? "");
        for (const version of Array.isArray(report.versions) ? report.versions as Row[] : []) {
          if (version.lifecycle_state !== "published") continue;
          const ref = String(version.version_ref ?? "");
          const own = reviews.find((review) => review.is_active === true
            && review.phase === "selection" && review.reviewer_wallet === wallet
            && review.target_version_ref === ref);
          task("resolution_selection", {
            case_ref: caseRef, exact_target: ref, conflict: author === wallet,
            current_vote: own ? String(own.decision ?? "") : null,
            weight_snapshot: own ? Number(own.weight ?? analystWeight ?? 0)
              : (actorKind === "analyst" ? analystWeight : null),
            next_action: author === wallet ? "Selected Report author excluded"
              : (actorKind === "analyst" ? "Review exact primary candidate" : "Finalize only after unique analyst quorum"),
          });
        }
      }
    }
    const challenges = Array.isArray(governance.challenges) ? governance.challenges as Row[] : [];
    for (const challenge of challenges) {
      const conflict = String(challenge.challenger_wallet ?? "") === wallet || selectedAuthorConflict;
      if (["submitted", "admissibility_review"].includes(String(challenge.state ?? ""))) {
        task("challenge_admissibility", {
          case_ref: caseRef, exact_target: String(challenge.public_ref ?? ""),
          deadline: challenge.admissibility_deadline_at ?? null, conflict,
          next_action: conflict ? "Conflicted actor excluded"
            : (actorKind === "analyst" ? "Decide admissibility" : "Double-gated admissibility decision"),
        });
      }
      if (["open", "under_review"].includes(String(challenge.state ?? ""))) {
        const own = (Array.isArray(challenge.reviews) ? challenge.reviews as Row[] : [])
          .find((review) => review.is_active === true && review.reviewer_wallet === wallet);
        task("challenge_adjudication", {
          case_ref: caseRef, exact_target: String(challenge.public_ref ?? ""),
          deadline: challenge.review_deadline_at ?? null, conflict,
          current_vote: own ? String(own.decision ?? "") : null,
          weight_snapshot: own ? Number(own.weight ?? analystWeight ?? 0)
            : (actorKind === "analyst" ? analystWeight : null),
          next_action: conflict ? "Conflicted actor excluded"
            : (actorKind === "analyst" ? "Review challenge merits" : "Analyst quorum required"),
        });
      }
    }
    const windowEnd = Date.parse(String(resolution.challenge_window_closes_at ?? ""));
    const blockers = challenges.some((challenge) => ["open", "under_review"].includes(String(challenge.state ?? "")));
    if (resolution.state === "in_challenge_window" && Number.isFinite(windowEnd)
        && windowEnd <= Date.now() && !blockers) {
      const own = reviews.find((review) => review.is_active === true
        && review.phase === "seal" && review.reviewer_wallet === wallet);
      task("seal_reviews", {
        case_ref: caseRef, exact_target: String(resolution.public_ref ?? ""),
        deadline: resolution.challenge_window_closes_at ?? null,
        conflict: selectedAuthorConflict,
        current_vote: own ? String(own.decision ?? "") : null,
        weight_snapshot: own ? Number(own.weight ?? analystWeight ?? 0)
          : (actorKind === "analyst" ? analystWeight : null),
        next_action: selectedAuthorConflict ? "Selected Report author excluded"
          : (actorKind === "analyst" ? "Review process seal" : "Finalize only after analyst seal quorum"),
      });
    }
  }
  return groups;
}

async function listReviewableCases(req: Request, body: Row): Promise<Response> {
  const wallet = safeText(body.wallet);
  const proof = await verifyReadSession(req, body, READ_SESSION_SCOPES.CASE_REVIEW);
  if (!proof.ok) return jsonResponse(proof.status, { ok: false, error: proof.reason });

  let actorKind: "analyst" | "maintainer" | null = null;
  if (await isVerifiedAnalyst(wallet)) actorKind = "analyst";
  else if (await hasFullMaintainerAccess(req, wallet)) actorKind = "maintainer";
  if (!actorKind) return jsonResponse(403, { ok: false, error: "not_eligible_reviewer" });

  const { data, error } = await admin.from("cases").select(CASE_COLS)
    .in("stage", [
      "initial_review", "open_public", "in_review", "ready_for_finalization",
      "resolution_proposed", "in_challenge_window", "resolved", "reopened",
    ])
    .neq("submitted_by_wallet", wallet)
    .order("created_at", { ascending: true }).limit(100);
  if (error) return jsonResponse(500, { ok: false, error: "read_failed" });
  const caseRows = data ?? [];
  const graph = await loadCaseGraph(caseRows);
  const caseDtos = caseRows.map((caseRow) => authorizedCaseDto(
    caseRow,
    graph.reportsByCase[String(caseRow.id)] ?? [],
    graph.versionsByReport,
    graph.receiptsByCaseTarget[String(caseRow.public_ref)] ?? [],
    { kind: actorKind, wallet },
    graph.evidenceByCase[String(caseRow.id)] ?? [],
    graph.reviewsByCase[String(caseRow.id)] ?? [],
    graph.governanceByCase[String(caseRow.id)] ?? {},
    graph.moneyByCase[String(caseRow.id)] ?? {},
  ));
  const versionRefById: Record<string, string> = {};
  for (const versions of Object.values(graph.versionsByReport)) {
    for (const version of versions) versionRefById[String(version.id)] = String(version.version_ref ?? "");
  }
  const versionIds = Object.keys(versionRefById);
  const { data: reportVotes } = versionIds.length
    ? await admin.from("case_report_reviews")
      .select("report_version_id,reviewer_wallet,decision,weight,is_active")
      .in("report_version_id", versionIds).eq("reviewer_wallet", wallet).eq("is_active", true)
      .limit(400)
    : { data: [] };
  const reportVotesByVersion: Record<string, Row> = {};
  for (const review of reportVotes ?? []) {
    const ref = versionRefById[String(review.report_version_id)];
    if (ref) reportVotesByVersion[ref] = review;
  }
  const { data: profileRows } = actorKind === "analyst"
    ? await admin.from("analyst_profiles").select("weight_cached").eq("wallet", wallet).limit(1)
    : { data: [] };
  const analystWeight = actorKind === "analyst" ? Number(profileRows?.[0]?.weight_cached ?? 0) : null;
  return jsonResponse(200, {
    ok: true,
    actor_role: actorKind,
    cases: caseDtos,
    review_tasks: buildReviewTasks(
      caseDtos, wallet, actorKind, analystWeight, reportVotesByVersion,
    ),
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
  const proof = await verifyReadSession(req, body, READ_SESSION_SCOPES.CASE_DETAIL);
  if (!proof.ok) return jsonResponse(proof.status, { ok: false, error: proof.reason });

  const { data, error } = await admin.from("cases").select(CASE_COLS)
    .eq("public_ref", caseRef).limit(1);
  if (error) return jsonResponse(500, { ok: false, error: "read_failed" });
  const caseRow = data?.[0];
  if (!caseRow) return jsonResponse(404, { ok: false, error: "not_found_or_denied" });

  // Server-derived actor model. A Report author receives only their own
  // unpublished versions plus public Case material; that role is derived from
  // the exact Case/report relationship and never accepted from the client.
  let actorKind: "owner" | "report_author" | "analyst" | "maintainer" | null = null;
  if (caseRow.submitted_by_wallet === proof.actor.wallet) {
    actorKind = "owner";
  } else if (await isVerifiedAnalyst(proof.actor.wallet)) {
    actorKind = "analyst";
  } else {
    const { data: authoredReports } = await admin.from("case_reports").select("id")
      .eq("case_id", caseRow.id).eq("author_wallet", proof.actor.wallet).limit(1);
    if ((authoredReports ?? []).length > 0) actorKind = "report_author";
    else if (await hasFullMaintainerAccess(req, proof.actor.wallet)) actorKind = "maintainer";
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
        graph.governanceByCase[String(caseRow.id)] ?? {},
        graph.moneyByCase[String(caseRow.id)] ?? {},
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
      graph.governanceByCase[String(caseRow.id)] ?? {},
      graph.moneyByCase[String(caseRow.id)] ?? {},
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
      "OSI_V2_CASE_WRITES_ENABLED", "OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED",
    ]);
  const config: Record<string, string> = {};
  for (const row of configRows ?? []) config[String(row.key)] = String(row.value ?? "");
  const adminWallet = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.admin_wallet ?? "")
    ? config.admin_wallet
    : "";

  const wallet = safeText(body.wallet);
  let walletValid = false;
  if (adminWallet && wallet === adminWallet) {
    const proof = await verifyReadSession(req, body, READ_SESSION_SCOPES.CASE_MAINTAINER);
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
      governanceByCase: graph.governanceByCase,
      receiptTotals,
      crosswalkCount: crosswalkRes.count ?? 0,
      manualQueueCount: queueRes.count ?? 0,
      flags: {
        OSI_V2_WRITES_ENABLED: config.OSI_V2_WRITES_ENABLED ?? "",
        OSI_V2_PROOF_ENABLED: config.OSI_V2_PROOF_ENABLED ?? "",
        OSI_V2_CASE_WRITES_ENABLED: config.OSI_V2_CASE_WRITES_ENABLED ?? "",
        OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED:
          config.OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED ?? "",
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

  // Deterministic DB-clock maintenance. This is service-only and clients
  // cannot choose the deadline, timestamp or terminal state.
  await admin.rpc("osi_v2_expire_due_challenges", { p_limit: 25 });

  switch (body.op) {
    case "list_public_cases":
      return await listPublicCases();
    case "get_public_case":
      return await getPublicCase(body);
    case "issue_read_challenge":
      return await issueReadChallenge(req, body);
    case "issue_read_session_challenge":
      return await issueReadSessionChallenge(req, body);
    case "create_read_session":
      return await createReadSession(req, body);
    case "list_my_cases":
      return await listMyCases(req, body);
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
