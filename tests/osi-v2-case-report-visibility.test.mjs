// Dependency-free regression tests for Case and Report structured visibility,
// analyst publication authority and long-form intake bounds.
// Run: node tests/osi-v2-case-report-visibility.test.mjs   (exit 0 = pass)
//
// These cover the layers that do not need a database: the exact projection
// builders, the Edge validation bounds, the backward-compatibility
// normalization for records written before the structured sections existed, and
// the frontend/migration contracts that carry the same guarantees. The database
// half (evidence promotion inside the publication transactions, the capability
// projection, the widened CHECK bounds) is covered by
// supabase/tests/osi_v2_case_report_visibility_publication.sql.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const caseRead = await import(
  new URL("../supabase/functions/_shared/osi-v2-case-read-core.mjs", import.meta.url)
);
const caseWrite = await import(
  new URL("../supabase/functions/_shared/osi-v2-case-write-core.mjs", import.meta.url)
);
const reportCore = await import(
  new URL("../supabase/functions/_shared/osi-v2-report-core.mjs", import.meta.url)
);

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error("FAIL " + name + (detail ? " :: " + detail : ""));
}
function throws(name, fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  ok(name, threw);
}
async function throwsAsync(name, fn) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  ok(name, threw);
}

const WALLET = "11111111111111111111111111111112";
const OTHER_WALLET = "11111111111111111111111111111113";
const TX = "K".repeat(88);
const SOURCE = "https://example.org/case-source";

// ---------------------------------------------------------------------------
// 1-2. A Case created with every field keeps every field, and an authorized
//      reviewer reads all of them.
// ---------------------------------------------------------------------------
const fullCaseRow = {
  id: "case-uuid",
  public_ref: "OSI-AABBCCDDEEFF",
  title: "Structured intake Case",
  category: "wallet_drain",
  summary_public: "A neutral public-safe summary of the incident under review.",
  details_restricted: "Restricted intake detail for authorized reviewers only.",
  reward_intent_lamports: 250000000,
  submitted_by_wallet: WALLET,
  stage: "initial_review",
  visibility: "private",
  risk_tier: "standard",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};
const pendingEvidence = [
  { kind: "wallet", ref: OTHER_WALLET, sha256: "a".repeat(64), is_public: false, moderation_state: "pending" },
  { kind: "onchain_tx", ref: TX, sha256: "b".repeat(64), is_public: false, moderation_state: "pending" },
  { kind: "url", ref: SOURCE, sha256: "c".repeat(64), is_public: false, moderation_state: "pending" },
];

for (const actorKind of ["owner", "analyst", "maintainer"]) {
  const dto = caseRead.authorizedCaseDto(
    fullCaseRow, [], {}, [], { kind: actorKind, wallet: actorKind === "owner" ? WALLET : OTHER_WALLET },
    pendingEvidence, [], {}, {},
  );
  ok(actorKind + " reads the public-safe summary", dto.summary === fullCaseRow.summary_public);
  ok(actorKind + " reads the restricted intake detail",
    dto.details_restricted === fullCaseRow.details_restricted);
  ok(actorKind + " reads every structured reference",
    dto.evidence.length === 3
    && dto.evidence_sections.wallets.length === 1
    && dto.evidence_sections.transactions.length === 1
    && dto.evidence_sections.links.length === 1);
  ok(actorKind + " reads the network the intake validator proved",
    dto.evidence_sections.networks[0] === caseRead.SOLANA_NETWORK_LABEL);
  ok(actorKind + " reads a followable explorer link for the wallet reference",
    dto.evidence_sections.wallets[0].link_url === "https://solscan.io/account/" + OTHER_WALLET);
  ok(actorKind + " reads a followable explorer link for the transaction reference",
    dto.evidence_sections.transactions[0].link_url === "https://solscan.io/tx/" + TX);
  ok(actorKind + " reads the exact untruncated source URL",
    dto.evidence_sections.links[0].ref === SOURCE);
  ok(actorKind + " reads the recorded reward intent",
    dto.reward_intent_lamports === 250000000);
}

// ---------------------------------------------------------------------------
// 3. Publication makes the reviewed manifest public, and only that.
// ---------------------------------------------------------------------------
const publicCaseRow = { ...fullCaseRow, stage: "open_public", visibility: "public" };
const promotedEvidence = pendingEvidence.map(
  (item) => ({ ...item, is_public: true, moderation_state: "approved" }),
);
const publicDto = caseRead.publicCaseDto(
  publicCaseRow, [], {}, [], promotedEvidence, [], {}, {},
);
ok("a published Case shows every promoted reference",
  publicDto.evidence.length === 3
  && publicDto.evidence_sections.wallets.length === 1
  && publicDto.evidence_sections.transactions.length === 1
  && publicDto.evidence_sections.links.length === 1);
ok("a published Case shows the public-safe summary", publicDto.summary === fullCaseRow.summary_public);

const mixedDto = caseRead.publicCaseDto(
  publicCaseRow, [], {}, [],
  [promotedEvidence[0], pendingEvidence[1], { ...pendingEvidence[2], moderation_state: "blocked" }],
  [], {}, {},
);
ok("a public Case never shows pending or blocked evidence",
  mixedDto.evidence.length === 1 && mixedDto.evidence_sections.wallets.length === 1
  && mixedDto.evidence_sections.transactions.length === 0
  && mixedDto.evidence_sections.links.length === 0);

// ---------------------------------------------------------------------------
// 4. Private fields never leak into a public response.
// ---------------------------------------------------------------------------
ok("a public Case DTO carries no restricted intake detail",
  !Object.prototype.hasOwnProperty.call(publicDto, "details_restricted"));
ok("a public Case DTO carries no owner wallet",
  !Object.prototype.hasOwnProperty.call(publicDto, "submitted_by_wallet"));
ok("a public Case DTO contains no forbidden key anywhere",
  caseRead.collectForbiddenKeys(publicDto).size === 0,
  [...caseRead.collectForbiddenKeys(publicDto)].join(","));
ok("a public Case DTO carries no opening capability",
  !Object.prototype.hasOwnProperty.call(publicDto, "opening_capability"));

// ---------------------------------------------------------------------------
// 5-6. Server-derived opening authority, exposed but never invented.
// ---------------------------------------------------------------------------
const analystCapable = caseRead.authorizedCaseDto(
  fullCaseRow, [], {}, [],
  {
    kind: "analyst",
    wallet: OTHER_WALLET,
    opening_capability: {
      actor_is_eligible_analyst: true,
      can_cast_initial_review: true,
      can_anchor_public_open: true,
      decision_channel: "standard",
      actor_active_decision: "approve_open",
      analyst_quorum_ready: true,
      analyst_approve_count: 1,
      analyst_approve_weight: 1,
      required_analyst_count: 1,
      required_analyst_weight: 0.5,
      case_writes_enabled: true,
    },
  },
  pendingEvidence, [], {}, {},
);
ok("an authorized analyst receives the server-derived opening capability",
  analystCapable.opening_capability.can_anchor_public_open === true
  && analystCapable.opening_capability.decision_channel === "standard");
const analystBlocked = caseRead.authorizedCaseDto(
  fullCaseRow, [], {}, [],
  {
    kind: "analyst",
    wallet: OTHER_WALLET,
    opening_capability: {
      actor_is_eligible_analyst: true,
      can_cast_initial_review: true,
      can_anchor_public_open: false,
      public_open_reason_code: "approval_not_counted",
      decision_channel: null,
    },
  },
  pendingEvidence, [], {}, {},
);
ok("a blocked analyst receives the exact unmet prerequisite",
  analystBlocked.opening_capability.can_anchor_public_open === false
  && analystBlocked.opening_capability.public_open_reason_code === "approval_not_counted");
ok("every capability reason code has exact user-facing text",
  ["case_writes_disabled", "case_not_in_initial_review", "case_owner_conflict",
    "not_eligible_reviewer", "no_active_approve_open_review", "approval_not_counted",
    "analyst_open_quorum_not_ready", "maintainer_open_path_not_ready",
    "rejection_quorum_ready", "open_path_unavailable"]
    .every((code) => typeof caseRead.CASE_OPENING_REASON_TEXT[code] === "string"
      && caseRead.CASE_OPENING_REASON_TEXT[code].length > 20));
ok("an absent capability projection never fabricates authority",
  caseRead.caseOpeningCapabilityDto(null) === null
  && caseRead.caseOpeningCapabilityDto({}).can_anchor_public_open === false);

// ---------------------------------------------------------------------------
// 7. Published Report structured content.
// ---------------------------------------------------------------------------
const publishedReport = {
  report_public_ref: "OSI-RPT-AABBCCDDEEFF",
  version_public_ref: "OSI-RV-AABBCCDDEEFF0011",
  version_no: 1,
  lifecycle_state: "published",
  content_public_safe: "A public-safe finding summary.",
  evidence: [
    { ordinal: 1, kind: "wallet", ref: OTHER_WALLET, sha256: "a".repeat(64), is_public: true, moderation_state: "approved" },
    { ordinal: 2, kind: "onchain_tx", ref: TX, sha256: "b".repeat(64), is_public: true, moderation_state: "approved" },
    { ordinal: 3, kind: "url", ref: SOURCE, sha256: "c".repeat(64), is_public: true, moderation_state: "approved" },
    { ordinal: 4, kind: "url", ref: "https://example.org/pending", sha256: "d".repeat(64), is_public: false, moderation_state: "pending" },
  ],
  quorum: { risk_tier: "standard", approve_count: 2, approve_weight: 2, required_count: 2, required_weight: 2, approve_ready: true },
  reviews: [],
  publication_receipt: null,
  published_at: "2026-08-02T00:00:00Z",
};
const publicReport = reportCore.publicReportGovernanceDto(publishedReport);
ok("a published Report shows its approved wallets, transactions and links",
  publicReport.evidence.length === 3
  && publicReport.evidence_sections.wallets.length === 1
  && publicReport.evidence_sections.transactions.length === 1
  && publicReport.evidence_sections.links.length === 1);
ok("a published Report shows the network and explorer link for each chain reference",
  publicReport.evidence_sections.wallets[0].network === caseRead.SOLANA_NETWORK_LABEL
  && publicReport.evidence_sections.transactions[0].link_url === "https://solscan.io/tx/" + TX);
ok("a published Report never shows an unapproved reference",
  !publicReport.evidence.some((item) => item.ref === "https://example.org/pending"));
ok("a published Report keeps its exact public-safe summary",
  publicReport.content_public_safe === "A public-safe finding summary.");

const authorizedReport = reportCore.authorizedReportDto(
  {
    case_public_ref: "OSI-AABBCCDDEEFF",
    report_public_ref: "OSI-RPT-AABBCCDDEEFF",
    author_wallet: WALLET,
    status: "active",
    current_version_ref: "OSI-RV-AABBCCDDEEFF0011",
    current_version_no: 1,
  },
  [{
    id: "v1", version_ref: "OSI-RV-AABBCCDDEEFF0011", version_no: 1,
    lifecycle_state: "in_review", body_private: "Restricted narrative.",
    content_public_safe: "Public-safe summary.", evidence_snapshot_hash: "e".repeat(64),
    revision_reason_code: null, created_at: "2026-08-01T00:00:00Z",
  }],
  new Map([["v1", publishedReport.evidence]]),
  new Map(), "analyst",
);
ok("an analyst reviewing an unpublished Report reads its full structured manifest",
  authorizedReport.versions[0].evidence.length === 4
  && authorizedReport.versions[0].evidence_sections.wallets.length === 1
  && authorizedReport.versions[0].evidence_sections.links.length === 2);

// ---------------------------------------------------------------------------
// 8. Backward compatibility: records written before the structured sections.
// ---------------------------------------------------------------------------
const legacyEvidence = [
  { ref: OTHER_WALLET, is_public: true, moderation_state: "approved" },
  { kind: "", ref: TX, is_public: true, moderation_state: "approved" },
  { kind: null, ref: SOURCE, is_public: true, moderation_state: "approved" },
  { kind: "note", ref: "internal-ledger-row-14", is_public: true, moderation_state: "approved" },
];
const legacyDto = caseRead.publicCaseDto(
  publicCaseRow, [], {}, [], legacyEvidence, [], {}, {},
);
ok("an older record with no evidence kind is normalized by reference shape",
  legacyDto.evidence_sections.wallets.length === 1
  && legacyDto.evidence_sections.transactions.length === 1
  && legacyDto.evidence_sections.links.length === 1);
ok("an unrecognized older reference is kept, never dropped",
  legacyDto.evidence_sections.other.length === 1
  && legacyDto.evidence_sections.other[0].ref === "internal-ledger-row-14");
ok("an older record with no sha256 still renders",
  legacyDto.evidence.every((item) => typeof item.sha256 === "string"));
ok("an older record with no evidence at all produces no empty section",
  Object.values(caseRead.evidenceSections([])).every((rows) => rows.length === 0));
ok("a reference that does not validate never earns a link",
  caseRead.evidenceLink("url", "http://example.org/insecure") === null
  && caseRead.evidenceLink("url", "https://user:pw@example.org") === null
  && caseRead.evidenceLink("wallet", "not-a-wallet") === null);

// ---------------------------------------------------------------------------
// 9. Long-form bounds. Content is refused, never truncated.
// ---------------------------------------------------------------------------
ok("Case bounds are the owner-approved minimums",
  caseWrite.CASE_SUMMARY_MAX >= 10000 && caseWrite.CASE_DETAILS_MAX >= 25000);
ok("Report bounds are the owner-approved minimums",
  reportCore.REPORT_SUMMARY_MAX >= 10000 && reportCore.REPORT_BODY_MAX >= 100000
  && reportCore.REPORT_RATIONALE_MAX >= 10000 && reportCore.REPORT_PRIVATE_NOTE_MAX >= 10000);

const longSummary = "s".repeat(caseWrite.CASE_SUMMARY_MAX);
const longDetails = "d".repeat(caseWrite.CASE_DETAILS_MAX);
const normalizedCase = caseWrite.normalizeCasePayload({
  title: "Long form Case", category: "other",
  summary_public: longSummary, details_restricted: longDetails,
  evidence: [{ kind: "wallet", ref: OTHER_WALLET }],
});
ok("a maximum-length Case summary is stored whole",
  normalizedCase.summary_public.length === caseWrite.CASE_SUMMARY_MAX);
ok("a maximum-length Case detail is stored whole",
  normalizedCase.details_restricted.length === caseWrite.CASE_DETAILS_MAX);
throws("an over-length Case summary is refused, not clipped", () => caseWrite.normalizeCasePayload({
  title: "Long form Case", category: "other",
  summary_public: "s".repeat(caseWrite.CASE_SUMMARY_MAX + 1), evidence: [],
}));
throws("an over-length Case detail is refused, not clipped", () => caseWrite.normalizeCasePayload({
  title: "Long form Case", category: "other", summary_public: "valid summary",
  details_restricted: "d".repeat(caseWrite.CASE_DETAILS_MAX + 1), evidence: [],
}));

const longReport = await reportCore.normalizeReportPayload({
  body_private: "b".repeat(reportCore.REPORT_BODY_MAX),
  content_public_safe: "p".repeat(reportCore.REPORT_SUMMARY_MAX),
  evidence: [{ kind: "url", ref: SOURCE }],
});
ok("a maximum-length Report narrative is stored whole",
  longReport.body_private.length === reportCore.REPORT_BODY_MAX);
ok("a maximum-length Report summary is stored whole",
  longReport.content_public_safe.length === reportCore.REPORT_SUMMARY_MAX);
await throwsAsync("an over-length Report narrative is refused, not clipped",
  () => reportCore.normalizeReportPayload({
    body_private: "b".repeat(reportCore.REPORT_BODY_MAX + 1), evidence: [],
  }));
await throwsAsync("an over-length Report summary is refused, not clipped",
  () => reportCore.normalizeReportPayload({
    body_private: "b".repeat(200),
    content_public_safe: "p".repeat(reportCore.REPORT_SUMMARY_MAX + 1), evidence: [],
  }));
const longReview = reportCore.normalizeReportReview({
  version_public_ref: "OSI-RV-AABBCCDDEEFF0011",
  decision: "approve", reason_code: "evidence_reviewed",
  public_rationale: "r".repeat(reportCore.REPORT_RATIONALE_MAX),
  private_note: "n".repeat(reportCore.REPORT_PRIVATE_NOTE_MAX),
});
ok("a maximum-length review rationale and note are stored whole",
  longReview.public_rationale.length === reportCore.REPORT_RATIONALE_MAX
  && longReview.private_note.length === reportCore.REPORT_PRIVATE_NOTE_MAX);
throws("an over-length review rationale is refused", () => reportCore.normalizeReportReview({
  version_public_ref: "OSI-RV-AABBCCDDEEFF0011", decision: "approve",
  reason_code: "evidence_reviewed",
  public_rationale: "r".repeat(reportCore.REPORT_RATIONALE_MAX + 1),
}));

// ---------------------------------------------------------------------------
// 10. Frontend contract.
// ---------------------------------------------------------------------------
const index = readFileSync(join(root, "index.html"), "utf8");
const caseUi = readFileSync(join(root, "assets/js/v2-case-integration.js"), "utf8");
const reportUi = readFileSync(join(root, "assets/js/v2-report-integration.js"), "utf8");
const caseCss = readFileSync(join(root, "assets/css/v2-case-integration.css"), "utf8");

ok("every long-form form field carries the widened HTML maxlength",
  index.includes('id="v2-case-summary" class="fo-in fo-ta" minlength="10" maxlength="10000"')
  && index.includes('id="v2-case-details" class="fo-in fo-ta" maxlength="25000"')
  && index.includes('<textarea id="osi-report-summary" rows="5" maxlength="10000"')
  && index.includes('<textarea id="osi-report-narrative" rows="9" minlength="80" maxlength="100000"'));
ok("every widened field states its budget and counts characters live",
  index.includes('data-osi-counter-for="v2-case-summary"')
  && index.includes('data-osi-counter-for="v2-case-details"')
  && index.includes('data-osi-counter-for="osi-report-summary"')
  && index.includes('data-osi-counter-for="osi-report-narrative"')
  && index.includes("10 to 10,000 characters")
  && index.includes("Up to 25,000 characters")
  && index.includes("Up to 10,000 characters"));
ok("an over-length paste is refused with exact numbers instead of clipped",
  caseUi.includes("function bindLongFormCounters()")
  && caseUi.includes("event.preventDefault();")
  && caseUi.includes("Not inserted. That paste would make this field {next} characters")
  && caseUi.includes("nothing was truncated"));
ok("the Case drawer asks for the authorized projection before the anonymous one",
  caseUi.includes("async function authorizedCaseRead(ref)")
  && caseUi.includes("op:'get_authorized_case'")
  && caseUi.includes("window.osiV2ReadSession(['case:detail'],{allowUnlock:false})")
  && caseUi.indexOf("var authorized=await authorizedCaseRead(ref);")
    < caseUi.indexOf("op:'get_public_case',public_ref:ref"));
ok("the drawer never opens a wallet prompt to try the authorized read",
  caseUi.includes("{allowUnlock:false}"));
ok("publication authority comes from the server capability, not client arithmetic",
  caseUi.includes("function openingCapability(item)")
  && caseUi.includes("if(capability.can_anchor_public_open!==true)return'';")
  && caseUi.includes("capability.decision_channel==='maintainer_bootstrap'?'maintainer':'analyst'"));
ok("an analyst reaches the review surface outside the review queue",
  caseUi.includes("function reviewSurfaceAvailable(item)")
  && caseUi.includes("}else if(reviewSurfaceAvailable(item)){")
  && !caseUi.includes("}else if(state.mode==='review'&&item.visibility==='private'){"));
ok("a blocked publication control names its exact unmet prerequisite",
  caseUi.includes("var OPENING_REASON_TEXT={")
  && caseUi.includes("function openingReasonText(code)")
  && caseUi.includes("openingReasonText(capability.public_open_reason_code)"));
ok("structured sections render per kind and skip empty groups",
  caseUi.includes("var EVIDENCE_SECTION_ORDER=[")
  && caseUi.includes("['wallets','Wallet Addresses']")
  && caseUi.includes("['transactions','Transactions']")
  && caseUi.includes("['links','Evidence and Sources']")
  && caseUi.includes("if(!rows.length)return'';")
  && caseUi.includes("if(!blocks.length)return options.emptyHtml||'';"));
ok("the Case overview renders its sections separately",
  caseUi.includes("esc(t('Summary'))")
  && caseUi.includes("esc(t('Description'))")
  && caseUi.includes("esc(t('Structured References'))")
  && caseUi.includes("esc(t('Additional Details'))"));
ok("a full reference value stays copyable even when the display elides it",
  caseUi.includes('title="\'+esc(ref)+\'"')
  && caseUi.includes('data-osi-copy="\'+esc(ref)+\'"')
  && caseUi.includes("[data-osi-copy]"));
ok("only a validated https link becomes a followable href",
  caseUi.includes("function safeExternalUrl(value)")
  && caseUi.includes("/^https:\\/\\/[^\\s\"'<>]+$/.test(url)"));
ok("the Report surfaces reuse the same structured renderer",
  reportUi.includes("window.osiV2EvidenceSectionsHtml")
  && reportUi.includes("function structuredReferences(row)")
  && reportUi.includes("evidenceHtml(version.evidence,version.evidence_sections)"));
ok("long references wrap instead of widening the layout",
  caseCss.includes(".osi-ref-value{overflow-wrap:anywhere;word-break:break-word")
  && caseCss.includes(".osi-ref-item{display:grid")
  && caseCss.includes("@media(max-width:640px)"));
ok("reference controls stay at a real touch size on a phone",
  caseCss.includes(".osi-ref-actions .osi-ref-copy,.osi-ref-actions .osi-ref-link{flex:1 1 auto;min-height:40px}"));

// ---------------------------------------------------------------------------
// 11. Migration contract.
// ---------------------------------------------------------------------------
const migration = readFileSync(
  join(root, "supabase/migrations/20260807090000_osi_v2_case_report_visibility_publication.sql"),
  "utf8",
);
ok("the Case public-open commit promotes the reviewed intake manifest",
  /create or replace function osi_private\.osi_v2_commit_case_open_outcome\(/.test(migration)
  && migration.includes("from public.case_evidence_links as link")
  && /update public\.evidence_items as evidence\s*\n\s*set moderation_state='approved',is_public=true/.test(migration));
ok("the Report publication commit promotes the reviewed version manifest",
  /create or replace function osi_private\.osi_v2_commit_report_publication\(/.test(migration)
  && migration.includes("from public.case_report_version_evidence as link")
  && migration.includes("and evidence.moderation_state = 'pending'"));
ok("no promotion path can ever un-block a blocked evidence item",
  !/moderation_state\s*(=|in)\s*\(?'blocked'/.test(
    migration.slice(migration.indexOf("create or replace function osi_private.osi_v2_commit_case_open_outcome(")),
  ));
ok("the backfill is bounded by an already-completed publication transition",
  migration.includes("and case_item.visibility = 'public'")
  && migration.includes("and version.lifecycle_state in ('published', 'superseded')")
  && migration.includes("and version.publication_receipt_id is not null"));
ok("the migration deletes and drops nothing beyond a widened constraint",
  !/\bdrop\s+table\b/i.test(migration)
  && !/\bdrop\s+column\b/i.test(migration)
  && !/\bdrop\s+schema\b/i.test(migration)
  && !/\btruncate\b/i.test(migration)
  && !/\bdelete\s+from\b/i.test(migration));
ok("the widened bounds match the Edge validation layer",
  migration.includes("char_length(btrim(summary_public)) between 1 and 10000")
  && migration.includes("char_length(btrim(details_restricted)) between 0 and 25000")
  && migration.includes("char_length(p_content_public_safe) not between 1 and 10000")
  && migration.includes("char_length(p_public_rationale) not between 10 and 10000"));
ok("the capability projection is service-only and side-effect free",
  migration.includes("raise exception 'Case capability projection is service-only'")
  && /create function osi_private\.osi_v2_case_opening_capabilities\([\s\S]*?\blanguage plpgsql\s*\n\s*stable/.test(migration)
  && migration.includes("revoke all privileges on function\n  public.osi_v2_case_opening_capabilities(text, uuid[], text)\n  from public, anon, authenticated;"));
ok("the capability projection delegates counted quorum to the write-path functions",
  migration.includes("from osi_private.osi_v2_case_review_quorum(target.id)")
  && migration.includes("from osi_private.osi_v2_case_rejection_quorum(target.id)")
  && migration.includes("osi_private.osi_v2_sas_review_counts('case_initial', review.id)"));

console.log((fail ? "FAILED: " + fail : "OK")
  + " (" + pass + " assertions passed, " + fail + " failed)");
process.exit(fail ? 1 : 0);
