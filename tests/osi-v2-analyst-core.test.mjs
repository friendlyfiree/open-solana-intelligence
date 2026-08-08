// Dependency-free analyst activation core and gateway contract tests.
// Run: node tests/osi-v2-analyst-core.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../supabase/functions/_shared/osi-v2-analyst-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edge = fs.readFileSync(path.join(root, "supabase/functions/osi-v2-analyst/index.ts"), "utf8");
const sql = fs.readFileSync(path.join(root, "supabase/migrations/20260713184533_osi_v2_analyst_activation.sql"), "utf8");
const schema = fs.readFileSync(path.join(root, "supabase/migrations/20260711092711_osi_v2_additive_schema.sql"), "utf8");
const wallet = "11111111111111111111111111111111";
const versionId = "018f0e80-0000-4000-8000-000000000001";
const versionRef = "OSI-APP-018F0E800000";

let count = 0;
function ok(condition, message) {
  count += 1;
  if (!condition) throw new Error("not ok " + count + " - " + message);
  console.log("ok " + count + " - " + message);
}
function rejects(fn, message) {
  let rejected = false;
  try { fn(); } catch { rejected = true; }
  ok(rejected, message);
}

const application = core.normalizeApplicationPayload({
  x_handle: "@Chain_Sleuth",
  handle: "Chain_Sleuth",
  display_name: "Chain Sleuth",
  bio: "Independent Solana transaction researcher.",
  expertise: ["osint", "blockchain_forensics", "osint"],
  links: [{ label: "Research", url: "https://example.com/work#section" }],
  motivation: "I want to review public incident evidence with careful attribution and a challengeable record.",
  experience: "I have traced Solana transaction flows and published reproducible research with cited transaction references.",
  proof_urls: ["https://example.com/proof"],
  safety_acknowledged: true,
}, { sha256: "a".repeat(64), mime: "image/png" });

ok(application.profile.handle === "chain_sleuth", "handle is normalized for case-insensitive uniqueness");
ok(application.profile.expertise.join(",") === "blockchain_forensics,osint", "expertise is canonical and deduplicated");
ok(application.profile.links[0].url === "https://x.com/chain_sleuth"
  && application.profile.links[1].url === "https://example.com/work",
"an optional X identity receives its canonical link and optional link fragments are removed");
const minimalApplication = core.normalizeApplicationPayload({
  x_handle: "@signal_reader", bio: "Solana public-evidence researcher.",
  experience: "", expertise: [], links: [], safety_acknowledged: true,
});
ok(minimalApplication.profile.handle === null
  && minimalApplication.application.x_handle === "signal_reader"
  && minimalApplication.profile.links[0].url === "https://x.com/signal_reader"
  && minimalApplication.profile.expertise.length === 0
  && minimalApplication.application.motivation === null
  && minimalApplication.application.experience === null
  && minimalApplication.application.safety_acknowledged === true,
"minimal application keeps optional X separate from the OSI public handle");
const walletIdentityApplication = core.normalizeApplicationPayload({
  handle: "   ",
  x_handle: " ",
  display_name: "",
  bio: "Wallet-authenticated public-evidence researcher.",
  expertise: [],
  links: [
    { label: " ", url: " " },
    { label: "", url: "" },
  ],
  proof_urls: ["", "   "],
  safety_acknowledged: true,
});
ok(walletIdentityApplication.profile.handle === null
  && walletIdentityApplication.profile.display_name === null
  && walletIdentityApplication.profile.links.length === 0
  && walletIdentityApplication.application.x_handle === null
  && walletIdentityApplication.application.proof_urls.length === 0,
"wallet identity remains canonical when optional handle, X and blank link rows are omitted");
const handleOnlyApplication = core.normalizeApplicationPayload({
  handle: "OSI_Researcher",
  x_handle: "",
  bio: "Wallet-authenticated public-evidence researcher.",
  links: [],
  safety_acknowledged: true,
});
ok(handleOnlyApplication.profile.handle === "osi_researcher"
  && handleOnlyApplication.application.x_handle === null
  && handleOnlyApplication.profile.links.length === 0,
"an optional OSI handle is independent from optional X identity");
rejects(() => core.normalizeApplicationPayload({
  x_handle: "@signal_reader", bio: "Solana public-evidence researcher.",
  experience: "", expertise: [], links: [],
}), "application rejects a missing signed safety acknowledgement");
rejects(() => core.normalizeApplicationPayload({
  x_handle: "x", handle: "x", display_name: "X", bio: "short", expertise: [], links: [],
  motivation: "short", experience: "short", proof_urls: [],
}), "invalid public profile and application fields are rejected");
rejects(() => core.normalizeApplicationPayload({
  handle: "bad-handle",
  x_handle: "",
  bio: "A sufficiently long public biography.",
  links: [],
  safety_acknowledged: true,
}), "a non-empty malformed optional OSI handle is rejected");
rejects(() => core.normalizeApplicationPayload({
  handle: "",
  x_handle: "@x",
  bio: "A sufficiently long public biography.",
  links: [],
  safety_acknowledged: true,
}), "a non-empty malformed optional X identity is rejected");
rejects(() => core.normalizeApplicationPayload({
  handle: 123,
  x_handle: null,
  bio: "A sufficiently long public biography.",
  links: [],
  safety_acknowledged: true,
}), "a supplied optional identity field must still be a string");
rejects(() => core.normalizeApplicationPayload({
  x_handle: "valid_handle",
  handle: "valid_handle", display_name: "Valid Name", bio: "A sufficiently long public biography.",
  expertise: ["osint"], links: [{ label: "local", url: "https://127.0.0.1/a" }],
  motivation: "A sufficiently long motivation that explains a responsible public evidence review practice in detail.",
  experience: "A sufficiently long experience statement for this focused security test.", proof_urls: [], safety_acknowledged: true,
}), "private and local tracking link targets are rejected");
rejects(() => core.normalizeApplicationPayload({
  x_handle: "valid_handle",
  handle: "valid_handle", display_name: "Valid Name", bio: "A sufficiently long public biography.",
  expertise: ["osint"], links: [],
  motivation: "This text is long enough but includes a seed phrase which must never be accepted by this application flow.",
  experience: "A sufficiently long experience statement for this focused security test.", proof_urls: [], safety_acknowledged: true,
}), "secret material is rejected");

const binding = {
  purpose: "ANALYST_APPLICATION_VERSION_SUBMITTED",
  target_type: "application_version",
  target_ref: versionRef,
  actor_wallet: wallet,
  actor_role: "wallet",
  decision: "submit",
  nonce: "n".repeat(43),
  payload_hash: "b".repeat(64),
  issued_at: 1_700_000_000,
  expires_at: 1_700_000_120,
};
const message = core.canonicalAnalystEventMessage(binding);
ok(message.includes("|t=application_version|id=" + versionRef + "|a=" + wallet + "|"), "message binds exact public version ref and actor");
ok(core.exactAnalystEventMessage(message, binding, 1_700_000_060), "exact fresh message is accepted");
ok(!core.exactAnalystEventMessage(message.replace("d=submit", "d=revise"), binding, 1_700_000_060), "different decision is rejected");
ok(!core.exactAnalystEventMessage(message, binding, 1_700_000_121), "expired message is rejected");

const probation = core.analystProbationPayload(wallet, versionId, versionRef);
ok(probation.status === "probationary_analyst" && probation.tier_code === "probationary" && probation.weight === "0.50", "probation outcome is exact and server-derived");

const png = new Uint8Array(45);
png.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82], 0);
new DataView(png.buffer).setUint32(16, 64);
new DataView(png.buffer).setUint32(20, 64);
png.set([0,0,0,0,73,69,78,68,0,0,0,0], png.length - 12);
ok(core.inspectProfileImage(png, "image/png").width === 64, "bounded PNG with exact magic and terminal IEND is accepted");
rejects(() => core.inspectProfileImage(new TextEncoder().encode("<svg onload=alert(1)></svg>"), "image/png"), "SVG and executable markup are rejected");
rejects(() => core.inspectProfileImage(new Uint8Array([...png, 1]), "image/png"), "content appended after the image terminator is rejected");

const dto = core.publicAnalystDto({
  wallet, handle: "chain_sleuth", display_name: "Chain Sleuth", bio: "Public bio",
  avatar_url: null, expertise_public: ["osint"], links_public: [],
  status: "probationary_analyst", tier_code: "probationary", weight_cached: 0.5,
}, [], [{
  event_type: "ANALYST_PROBATION", actor_wallet: wallet, actor_role: "maintainer",
  decision: "probation", proof_type: "solana_memo", tx_sig: "1".repeat(64),
  occurred_at: "2026-07-13T00:00:00Z", payload_hash: "secret", nonce: "secret", signature: "secret",
}]);
ok(!("payload_hash" in dto.proof_history[0]) && !("nonce" in dto.proof_history[0]) && !("signature" in dto.proof_history[0]), "public DTO excludes private proof material");
const supportDto = core.publicAnalystDto({
  wallet, handle: "chain_sleuth", display_name: "Chain Sleuth", bio: "Public bio",
  expertise_public: [], links_public: [], status: "verified_analyst", tier_code: "verified", weight_cached: 1,
}, [], [{
  event_type: "SUPPORT_PAYMENT_CONFIRMED", actor_wallet: "11111111111111111111111111111112",
  actor_role: "wallet", decision: "sent", proof_type: "solana_memo", tx_sig: "2".repeat(64),
  memo_ref: "OSI2|1|SUPPORT_PAYMENT_CONFIRMED|fixture", occurred_at: "2026-07-15T00:00:00Z",
  recipient_amount_lamports: "25000000", payment_total_lamports: "75000000",
  payment_target_public_ref: "OSI-AN-ABCDEF1234567890", payment_finality: "finalized",
  payment_slot: "500001", payment_block_time: "2026-07-15T00:00:00Z",
  verification_metadata: { private: "must not leak" }, payload_hash: "must not leak",
}]);
ok(supportDto.proof_history[0].payment_proof.recipient_amount_lamports === "25000000"
  && supportDto.proof_history[0].payment_proof.finality === "finalized"
  && supportDto.proof_history[0].memo.startsWith("OSI2|1|SUPPORT_PAYMENT_CONFIRMED"),
"public verified analyst profile includes the exact recipient share of finalized support proof");
ok(!("verification_metadata" in supportDto.proof_history[0]) && !("payload_hash" in supportDto.proof_history[0]),
"analyst support proof exposes no raw verification metadata or binding hash");

ok(edge.includes("authenticatedMaintainerId") && edge.includes("configuredAdminWallet") && edge.includes("fullMaintainer"), "every maintainer operation has a double-gate primitive");
ok(edge.includes('"application_under_review"')
  && edge.includes('"active_analyst_cannot_apply"')
  && edge.includes('"application_state_changed"'),
"application lifecycle conflicts return actionable stable error codes");
ok((edge.match(/await fullMaintainer\(req, wallet\)/g) ?? []).length >= 5, "maintainer reads and writes independently revalidate both gates");
ok(edge.includes("target.application.applicant_wallet === wallet") && sql.includes("application_row.applicant_wallet = bound_nonce.actor_wallet"), "self-review is denied in Edge and database layers");
ok(edge.includes("inspectProfileImage") && edge.includes('sha256HexUtf8(wallet)) + \"/\" + image.sha256'), "avatar bytes and immutable owner/content path are enforced");
ok(sql.includes("OSI_V2_ANALYST_WRITES_ENABLED', 'true'"), "reviewed analyst slice is enabled by its exact migration");
ok(edge.includes("data?.[0]?.value === \"true\""), "missing or malformed analyst rollout state still fails closed");
ok(sql.includes("weight_cached = 0.50") && sql.includes("tier_code = 'probationary'"), "database derives exact probationary weight and tier");
ok(sql.includes("force row level security") || fs.readFileSync(path.join(root, "supabase/migrations/20260711092856_osi_v2_default_deny.sql"), "utf8").includes("analyst_application_reviews"), "analyst tables remain under forced default-deny RLS");
ok(!edge.includes("select(\"*\")"), "gateway avoids select-star projections");
ok(edge.includes('SUPPORT_PAYMENT_CONFIRMED') && edge.includes('recipient_amount_lamports'), "public analyst graph maps finalized support manifests back to every exact recipient");
ok(/create table public\.analyst_profiles[\s\S]*wallet text primary key[\s\S]*handle text[\s\S]*check \(handle is null/i.test(schema),
"database keeps the wallet as canonical identity and permits an omitted public handle");

// Public contributions derived from receipts when the stored table is silent.
const otherWallet = "11111111111111111111111111111112";
const contributionReceipts = [
  { event_type: "CASE_SUBMITTED", target_type: "case", public_ref: "OSI-BFD6490F5270", actor_wallet: wallet, server_verified: true, occurred_at: "2026-07-26T13:30:08Z" },
  { event_type: "WIRE_REPORT_REVIEW_CAST", target_type: "wire_version", public_ref: "OSI-WV-FB0E72AC4878", actor_wallet: wallet, server_verified: true, occurred_at: "2026-07-26T20:37:47Z" },
  { event_type: "WIRE_REPORT_REVIEW_REVISED", target_type: "wire_version", public_ref: "OSI-WV-FB0E72AC4878", actor_wallet: wallet, server_verified: true, occurred_at: "2026-07-27T16:31:21Z" },
  { event_type: "CASE_INITIAL_REVIEW_CAST", target_type: "case", public_ref: "OSI-00CB089E5105", actor_wallet: wallet, server_verified: true, occurred_at: "2026-07-29T13:07:51Z" },
  { event_type: "REPORT_PUBLISHED", target_type: "report_version", public_ref: "OSI-RV-7998E263D19C", actor_wallet: wallet, server_verified: true, occurred_at: "2026-08-01T09:02:46Z" },
  { event_type: "SUPPORT_PAYMENT_CONFIRMED", target_type: "support", public_ref: "OSI-SUP-0001", actor_wallet: wallet, server_verified: true, occurred_at: "2026-08-03T05:55:16Z" },
  { event_type: "CASE_REPORT_REVIEW_CAST", target_type: "report_version", public_ref: "OSI-RV-0000000000", actor_wallet: otherWallet, server_verified: true, occurred_at: "2026-08-02T00:00:00Z" },
  { event_type: "CHALLENGE_SUBMITTED", target_type: "challenge", public_ref: "", actor_wallet: wallet, server_verified: true, occurred_at: "2026-08-02T10:00:00Z" },
];
const derived = core.deriveAnalystContributions(wallet, contributionReceipts);
ok(derived.length === 3, "derived contributions cover exactly the analyst's own referenced public work");
ok(derived.map((row) => row.kind).join(",") === "case_initial_review,wire_report_review,case_submitted",
"derived contributions are ordered newest first");
ok(derived.filter((row) => row.kind === "wire_report_review").length === 1
  && derived.find((row) => row.kind === "wire_report_review").created_at === "2026-07-27T16:31:21Z",
"a revised review collapses onto its subject instead of counting twice");
ok(!derived.some((row) => row.kind === "report_published" || row.subject_type === "support"),
"operator publication and money transfers are never counted as analyst contributions");
ok(!derived.some((row) => row.subject_id === "OSI-RV-0000000000"),
"another wallet's review is never attributed to this analyst");
ok(!derived.some((row) => row.subject_type === "challenge"),
"work with no public reference is omitted rather than published unlookupable");
ok(derived.every((row) => /^OSI-/.test(row.subject_id)),
"derived contributions publish the reader-facing reference, never an internal id");

// The subject index a public reader is allowed to be told about. Everything the
// record and the filtered contribution list publish must resolve through it.
const publicSubjects = core.indexPublicSubjects({
  cases: [
    { id: "case-1", public_ref: "OSI-BFD6490F5270", title: "Treasury outflow", stage: "sealed", visibility: "public", sealed_at: "2026-08-04T00:00:00Z" },
    { id: "case-2", public_ref: "OSI-00CB089E5105", title: "Drainer cluster", stage: "open_public", visibility: "public", updated_at: "2026-07-30T00:00:00Z" },
    { id: "case-3", public_ref: "OSI-PRIVATE00001", title: "Still private", stage: "initial_review", visibility: "private" },
    { id: "case-4", public_ref: "OSI-LEGACY0000000001", title: "Legacy", stage: "open_public", visibility: "public", category: "legacy_import" },
    { id: "case-5", public_ref: "OSI-ARCHIVED00001", title: "Archived", stage: "open_public", visibility: "public", archived_at: "2026-08-01T00:00:00Z" },
  ],
  reports: [
    { id: "report-1", public_ref: "OSI-RPT-AAAAAAAAAAAA", case_id: "case-1", current_published_version_id: "rv-1", updated_at: "2026-08-02T00:00:00Z" },
    { id: "report-2", public_ref: "OSI-RPT-BBBBBBBBBBBB", case_id: "case-1", current_published_version_id: null },
    { id: "report-3", public_ref: "OSI-RPT-CCCCCCCCCCCC", case_id: "case-3", current_published_version_id: "rv-9" },
  ],
  wires: [
    { id: "wire-1", public_ref: "OSI-WR-DDDDDDDDDDDD", title: "Sniper wallets", current_published_version_id: "wv-1", updated_at: "2026-07-28T00:00:00Z" },
    { id: "wire-2", public_ref: "OSI-WR-EEEEEEEEEEEE", title: "Unpublished", current_published_version_id: null },
  ],
  reportVersions: [
    { version_ref: "OSI-RV-7998E263D19C0000", report_id: "report-1" },
    { version_ref: "OSI-RV-UNPUBLISHED00000", report_id: "report-2" },
  ],
  wireVersions: [
    { version_ref: "OSI-WV-FB0E72AC4878", wire_report_id: "wire-1" },
  ],
});
ok(publicSubjects.get("OSI-BFD6490F5270").outcome === "sealed"
  && publicSubjects.get("OSI-00CB089E5105").outcome === "open",
"a public Case carries the outcome its own stage states");
ok(!publicSubjects.has("OSI-PRIVATE00001") && !publicSubjects.has("OSI-LEGACY0000000001")
  && !publicSubjects.has("OSI-ARCHIVED00001"),
"a private, legacy or archived Case is never publicly resolvable");
ok(publicSubjects.get("OSI-RPT-AAAAAAAAAAAA").case_ref === "OSI-BFD6490F5270"
  && publicSubjects.get("OSI-RPT-AAAAAAAAAAAA").outcome === "published",
"a published Report resolves to its public parent Case");
ok(!publicSubjects.has("OSI-RPT-BBBBBBBBBBBB"),
"an unpublished Report's existence is never announced by a contributor's profile");
ok(!publicSubjects.has("OSI-RPT-CCCCCCCCCCCC"),
"a published Report on a still-private Case stays unresolvable");
ok(!publicSubjects.has("OSI-WR-EEEEEEEEEEEE"),
"an unpublished Wire Report's existence and author stay private");
ok(publicSubjects.get("OSI-RV-7998E263D19C0000")?.public_ref === "OSI-RPT-AAAAAAAAAAAA"
  && publicSubjects.get("OSI-WV-FB0E72AC4878")?.public_ref === "OSI-WR-DDDDDDDDDDDD",
"a review's exact version reference resolves to the header it judged");
ok(!publicSubjects.has("OSI-RV-UNPUBLISHED00000"),
"a version of an unpublished Report inherits its parent's privacy, not a public alias");

const recordReceipts = [
  { event_type: "CASE_SUBMITTED", target_type: "case", public_ref: "OSI-BFD6490F5270", actor_wallet: wallet, server_verified: true, proof_type: "solana_memo", tx_sig: "a".repeat(64), occurred_at: "2026-07-26T13:30:08Z" },
  { event_type: "CASE_REPORT_VERSION_SUBMITTED", target_type: "report_version", public_ref: "OSI-RV-7998E263D19C0000", actor_wallet: wallet, server_verified: true, proof_type: "solana_memo", tx_sig: "b".repeat(64), occurred_at: "2026-08-01T09:02:46Z" },
  { event_type: "WIRE_REPORT_REVIEW_CAST", target_type: "wire_version", public_ref: "OSI-WV-FB0E72AC4878", actor_wallet: wallet, server_verified: true, proof_type: "wallet_signed_server_verified", occurred_at: "2026-07-26T20:37:47Z" },
  { event_type: "WIRE_REPORT_REVIEW_REVISED", target_type: "wire_version", public_ref: "OSI-WV-FB0E72AC4878", actor_wallet: wallet, server_verified: true, proof_type: "wallet_signed_server_verified", occurred_at: "2026-07-27T16:31:21Z" },
  { event_type: "CASE_REPORT_REVIEW_CAST", target_type: "report_version", public_ref: "OSI-RV-UNPUBLISHED00000", actor_wallet: wallet, server_verified: true, proof_type: "wallet_signed_server_verified", occurred_at: "2026-07-20T00:00:00Z" },
  { event_type: "CASE_SUBMITTED", target_type: "case", public_ref: "OSI-PRIVATE00001", actor_wallet: wallet, server_verified: true, proof_type: "solana_memo", tx_sig: "c".repeat(64), occurred_at: "2026-08-05T00:00:00Z" },
  { event_type: "REPORT_PUBLISHED", target_type: "report_version", public_ref: "OSI-RV-7998E263D19C0000", actor_wallet: wallet, server_verified: true, proof_type: "solana_memo", tx_sig: "d".repeat(64), occurred_at: "2026-08-02T00:00:00Z" },
];
const record = core.buildPublicWorkRecord(wallet, recordReceipts, publicSubjects);
ok(record.entries.length === 3, "the record lists exactly the publicly resolvable subjects the wallet worked on");
ok(!record.entries.some((entry) => entry.public_ref === "OSI-PRIVATE00001"),
"a Case that is still private is never named in a public record");
ok(record.unlisted.some((row) => row.kind === "case_submitted" && row.count === 1)
  && record.unlisted.some((row) => row.kind === "case_report_review" && row.count === 1),
"work on an unresolvable subject is counted honestly instead of being named or dropped");
const reportEntry = record.entries.find((entry) => entry.public_ref === "OSI-RPT-AAAAAAAAAAAA");
ok(reportEntry.role === "author" && reportEntry.acts.length === 1,
"authorship outranks review on the same subject and an operator publication is not the author's act");
ok(reportEntry.acts[0].tx_sig === "b".repeat(64) && reportEntry.anchored === true,
"an authored version carries the exact mainnet transaction that anchored it");
const wireEntry = record.entries.find((entry) => entry.public_ref === "OSI-WR-DDDDDDDDDDDD");
ok(wireEntry.role === "reviewer" && wireEntry.acts.length === 2 && wireEntry.anchored === false,
"a wallet-signed review is recorded as review work and is never labelled on-chain");
ok(record.summary.cases === 1 && record.summary.cases_sealed === 1
  && record.summary.reports_published === 1 && record.summary.wire_reports_published === 1,
"the summary counts exactly the entries listed beneath it");
ok(record.summary.memo_anchored_acts === 2 && record.summary.reviews === 2,
"the summary separates memo-anchored acts from wallet-signed reviews");
ok(core.buildPublicWorkRecord(wallet, recordReceipts, new Map()).entries.length === 0,
"an unavailable subject index publishes nothing rather than falling open");

const derivedDto = core.publicAnalystDto({
  wallet, handle: "chain_sleuth", display_name: "Chain Sleuth", bio: "Public bio",
  expertise_public: [], links_public: [], status: "verified_analyst", tier_code: "verified", weight_cached: 1,
}, [], contributionReceipts, publicSubjects);
ok(derivedDto.contributions.length === 3,
"an analyst with no stored contribution rows still publishes their real public work");
const privateDerivedDto = core.publicAnalystDto({
  wallet, handle: "chain_sleuth", display_name: "Chain Sleuth", bio: "Public bio",
  expertise_public: [], links_public: [], status: "verified_analyst", tier_code: "verified", weight_cached: 1,
}, [], [
  ...contributionReceipts,
  { event_type: "CASE_SUBMITTED", target_type: "case", public_ref: "OSI-PRIVATE00001", actor_wallet: wallet, server_verified: true, occurred_at: "2026-08-06T00:00:00Z" },
], publicSubjects);
ok(privateDerivedDto.contributions.length === 3
  && !privateDerivedDto.contributions.some((row) => row.subject_id === "OSI-PRIVATE00001"),
"a contribution to a still-private Case is withheld from the public list rather than published");
const storedDto = core.publicAnalystDto({
  wallet, handle: "chain_sleuth", display_name: "Chain Sleuth", bio: "Public bio",
  expertise_public: [], links_public: [], status: "verified_analyst", tier_code: "verified", weight_cached: 1,
}, [
  { kind: "case_report_review", subject_type: "report_version", subject_id: "OSI-RV-7998E263D19C0000", created_at: "2026-07-01T00:00:00Z" },
  { kind: "case_submitted", subject_type: "case", subject_id: "OSI-PRIVATE00001", created_at: "2026-07-02T00:00:00Z" },
], contributionReceipts, publicSubjects);
ok(storedDto.contributions.length === 1 && storedDto.contributions[0].subject_id === "OSI-RV-7998E263D19C0000",
"the stored contribution table stays authoritative but still cannot name a private subject");
const leakDto = core.publicAnalystDto({
  wallet, handle: "chain_sleuth", display_name: "Chain Sleuth", bio: "Public bio",
  expertise_public: [], links_public: [], status: "verified_analyst", tier_code: "verified", weight_cached: 1,
}, [], recordReceipts, publicSubjects);
ok(leakDto.proof_history.every((row) => row.public_ref === null || publicSubjects.has(row.public_ref)),
"proof history keeps every receipt but only points at references a reader can open");
ok(leakDto.proof_history.some((row) => row.event_type === "CASE_SUBMITTED" && row.public_ref === null),
"a receipt on a private subject keeps its proof and loses its pointer");
ok(edge.includes("target_type,public_ref,actor_wallet"),
"the analyst gateway reads the subject reference its public contributions are derived from");
ok(edge.includes("indexPublicSubjects") && edge.includes("buildPublicWorkRecord")
  && edge.includes('case "get_public_profile"'),
"the gateway builds the public record and exposes the shareable single-profile route");

// The public-stage rule lives in two files so the analyst function does not
// bundle the Case read core. It may never drift.
const { PUBLIC_CASE_STAGES } = await import("../supabase/functions/_shared/osi-v2-case-read-core.mjs");
ok([...PUBLIC_CASE_STAGES].sort().join(",") === [...core.PUBLIC_SUBJECT_CASE_STAGES].sort().join(","),
"the analyst record mirrors the exact public Case stages the Case read core enforces");
// A typo in the map would silently drop a whole class of contribution forever,
// so every key has to be an event the registry actually issues.
const { osi2EventClass } = await import("../supabase/functions/_shared/osi-v2-event-registry.mjs");
ok(Object.keys(core.ANALYST_CONTRIBUTION_KINDS).every((event) => osi2EventClass(event) !== null),
"every contribution event is a registered OSI2 event type");

console.log("1.." + count);
