// Dependency-free Resolution, Challenge and Case-seal regressions.
// Run: node tests/osi-v2-governance.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const governance = await import(new URL(
  "../supabase/functions/_shared/osi-v2-governance-core.mjs", import.meta.url,
));
const readCore = await import(new URL(
  "../supabase/functions/_shared/osi-v2-case-read-core.mjs", import.meta.url,
));

let pass = 0;
let fail = 0;
function ok(name, condition, detail = "") {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error("FAIL " + name + (detail ? " :: " + detail : ""));
}
function rejects(name, fn, pattern) {
  try { fn(); ok(name, false, "did not reject"); }
  catch (error) { ok(name, pattern.test(String(error?.message ?? error)), String(error)); }
}

const WALLET = "11111111111111111111111111111112";
const OTHER = "11111111111111111111111111111113";
const CASE_REF = "OSI-A1B2C3D4E5F6";
const RESOLUTION_REF = "OSI-RES-A1B2C3D4E5F60718";
const CHALLENGE_REF = "OSI-CHL-A1B2C3D4E5F60718";
const VERSION_REF = "OSI-RV-A1B2C3D4E5F60718";
const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const NONCE = "n".repeat(43);
const HASH = "a".repeat(64);
const NOW = 1_800_000_000_000;

const selection = governance.normalizeGovernancePayload("resolution_review", {
  phase: "selection", report_version_ref: VERSION_REF, decision: "select",
  reason_code: "primary_report_assessment",
  public_rationale: "This exact published version has independent process support.",
  private_note: "Restricted analyst note.",
});
ok("selection review normalizes exact immutable version", selection.report_version_ref === VERSION_REF
  && selection.phase === "selection" && selection.private_note === "Restricted analyst note.");
rejects("selection rejects a malformed exact version", () => governance.normalizeGovernancePayload(
  "resolution_review", { ...selection, report_version_ref: "OSI-RV-WRONG" },
), /report_version_ref/);
rejects("seal review cannot object", () => governance.normalizeGovernancePayload(
  "resolution_review", { ...selection, phase: "seal", decision: "object" },
), /phase or decision/);

const challenge = governance.normalizeGovernancePayload("challenge_submit", {
  reason_code: "material_evidence_challenge",
  public_safe_summary: "New linked evidence materially challenges the selected version.",
  restricted_detail: "Restricted correlation details.", evidence_item_id: TARGET_ID,
});
ok("challenge requires one typed evidence item", challenge.evidence_item_id === TARGET_ID);
rejects("challenge rejects missing evidence", () => governance.normalizeGovernancePayload(
  "challenge_submit", { ...challenge, evidence_item_id: "" },
), /evidence_item_id/);
ok("full maintainer admissibility route is explicit",
  governance.normalizeGovernancePayload("challenge_admit", {
    decision: "accept", route: "maintainer",
  }).route === "maintainer");
rejects("unknown admissibility route fails closed", () => governance.normalizeGovernancePayload(
  "challenge_admit", { decision: "accept", route: "wallet" },
), /route|admissibility/);

ok("target validator binds Case for selection review",
  governance.validateGovernanceTargetRef("resolution_review", CASE_REF) === CASE_REF);
ok("target validator binds resolution for finalization",
  governance.validateGovernanceTargetRef("resolution_finalize", RESOLUTION_REF) === RESOLUTION_REF);
ok("target validator binds challenge for adjudication",
  governance.validateGovernanceTargetRef("challenge_review", CHALLENGE_REF) === CHALLENGE_REF);
rejects("changed target type is rejected", () => governance.validateGovernanceTargetRef(
  "challenge_review", RESOLUTION_REF,
), /target_ref/);

const proof = [
  "OSI2", "REPORT_SELECTED_WINNING", "t=resolution", "id=" + TARGET_ID,
  "ref=" + RESOLUTION_REF, "a=" + WALLET, "h=" + HASH, "n=" + NONCE,
  "ts=" + NOW, "exp=" + (NOW + 120_000),
].join("|");
const expected = {
  purpose: "REPORT_SELECTED_WINNING", target_type: "resolution", target_id: TARGET_ID,
  target_public_ref: RESOLUTION_REF, actor_wallet: WALLET, payload_hash: HASH, nonce: NONCE,
};
ok("class-A proof binds exact resolution, actor, hash and nonce",
  governance.validateGovernanceProofText(proof, expected, NOW + 10_000).ok === true);
ok("changed actor is rejected",
  governance.validateGovernanceProofText(proof, { ...expected, actor_wallet: OTHER }, NOW + 10_000).reason
    === "wrong_actor_wallet");
ok("changed payload is rejected",
  governance.validateGovernanceProofText(proof, { ...expected, payload_hash: "b".repeat(64) }, NOW + 10_000).reason
    === "wrong_payload_hash");
ok("changed nonce is rejected",
  governance.validateGovernanceProofText(proof, { ...expected, nonce: "r".repeat(43) }, NOW + 10_000).reason
    === "wrong_nonce");
ok("expired proof is rejected",
  governance.validateGovernanceProofText(proof, expected, NOW + 120_001).reason === "expired");
ok("final events have honest Memo labels",
  governance.governanceProofLabel("REPORT_SELECTED_WINNING") === "Memo-anchored on Solana"
    && governance.governanceProofLabel("CHALLENGE_ACCEPTED") === "Memo-anchored on Solana"
    && governance.governanceProofLabel("RECORD_SEALED") === "Memo-anchored on Solana");
ok("review events have honest wallet-signature labels",
  governance.governanceProofLabel("RESOLUTION_REVIEW_CAST") === "Wallet-signed & server-verified");

const publicDto = readCore.publicCaseDto({
  public_ref: CASE_REF, title: "Public process record", summary_public: "Safe summary",
  category: "other", stage: "in_challenge_window", visibility: "public",
  created_at: "2026-07-14T00:00:00Z", sealed_at: null,
}, [], {}, [], [], [], {
  resolution: {
    public_ref: RESOLUTION_REF, state: "in_challenge_window",
    winning_report_version_ref: VERSION_REF,
    challenge_window_opens_at: "2026-07-14T00:00:00Z",
    challenge_window_ends_at: "2026-07-21T00:00:00Z",
    selection_quorum: { leader_version_ref: VERSION_REF, leader_count: 2, leader_weight: 2.5,
      required_count: 2, required_weight: 2.5, tie_unresolved: false },
  },
  resolution_reviews: [{
    public_ref: "OSI-RRV-A1B2C3D4E5F60718", phase: "selection",
    candidate_version_ref: VERSION_REF, reviewer_wallet: OTHER, decision: "select",
    weight: 1.5, tier_snapshot: "analyst_i", public_rationale: "Public rationale.",
    private_note: "NEVER LEAK THIS NOTE", is_active: true,
    created_at: "2026-07-14T00:00:00Z", receipt: {
      proof_type: "wallet_signed_server_verified", server_verified: true, actor_role: "analyst",
    },
  }],
  challenges: [{
    public_ref: CHALLENGE_REF, challenger_wallet: WALLET,
    reason_code: "restricted_reason", public_safe_summary: "Public challenge summary.",
    restricted_detail: "NEVER LEAK THIS DETAIL", state: "open",
    admissibility_ttl_at: "2026-07-15T00:00:00Z", review_deadline_at: "2026-07-17T00:00:00Z",
    reviews: [],
  }],
});
const publicText = JSON.stringify(publicDto);
ok("public DTO shows exact selected version and process quorum",
  publicDto.governance.resolution.winning_report_version_ref === VERSION_REF
    && publicDto.governance.resolution.selection_quorum.leader_count === 2);
ok("public DTO shows safe challenge state without restricted material",
  publicDto.governance.challenges[0].blocking === true
    && !/NEVER LEAK|private_note|restricted_detail|reason_code|selection_quorum_hash|[0-9a-f]{8}-[0-9a-f-]{27}/i.test(publicText));
ok("process notice rejects truth guilt payment and custody implications",
  /do not determine truth, guilt, legal certainty, recovery, custody, or payment/.test(
    publicDto.governance.process_notice,
  ));

const migration = readFileSync(join(root,
  "supabase/migrations/20260714082218_osi_v2_resolution_challenge_seal.sql"), "utf8");
const edge = readFileSync(join(root,
  "supabase/functions/osi-v2-governance-write/index.ts"), "utf8");
const ui = readFileSync(join(root, "assets/js/v2-case-integration.js"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const maintainerUi = readFileSync(join(root, "assets/js/54-maintainer-console.js"), "utf8");
const productionWorkflow = readFileSync(join(
  root, ".github/workflows/osi-v2-resolution-production.yml",
), "utf8");
const pgTap = readFileSync(join(
  root, "supabase/tests/osi_v2_resolution_challenge_seal.sql",
), "utf8");

ok("single atomic dedicated lifecycle flag defaults false",
  /OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED', 'false'/.test(migration)
    && !/OSI_V2_(?:RESOLUTION|CHALLENGE|SEAL)_WRITES_ENABLED/.test(migration));
ok("standard high-risk challenge and seal gates are server-derived",
  /OSI_V2_RESOLUTION_STANDARD_MIN_COUNT/.test(migration)
    && /OSI_V2_RESOLUTION_HIGH_MIN_WEIGHT/.test(migration)
    && /OSI_V2_CHALLENGE_MIN_WEIGHT/.test(migration)
    && /OSI_V2_SEAL_MIN_WEIGHT/.test(migration));
ok("deterministic resolution leader keeps exact ties unresolved",
  /order by tally\.total_weight desc, tally\.analyst_count desc/.test(migration)
    && /tie_unresolved :=/.test(migration));
ok("only open and under-review challenges block seal",
  /challenge\.state in \('open', 'under_review'\)/.test(migration));
ok("challenge admission and seal recheck full maintainer double binding",
  (migration.match(/osi_v2_full_maintainer_binding/g) || []).length >= 6
    && /authenticatedMaintainerId/.test(edge) && /configuredAdminWallet/.test(edge));
ok("service-only RPC grants preserve browser default deny",
  /grant execute[\s\S]+to service_role/.test(migration)
    && /revoke all privileges[\s\S]+from public, anon, authenticated/.test(migration));
ok("migration contains no destructive schema or data operation",
  !/^\s*(drop|truncate|delete\s+from|update\s+public\.(?!cases|case_resolutions|challenges_v2|resolution_reviews|challenge_reviews|osi_nonces))/im.test(migration));
ok("Edge verifies mainnet and exact proof before DB commit",
  /MAINNET_GENESIS_HASH/.test(edge) && /validateGovernanceProofText/.test(edge)
    && /validateConfirmedMemoTransaction/.test(edge) && /verifyEd25519Signature/.test(edge));
ok("Case drawer has exactly six lifecycle tabs",
  /\['overview','Overview'\].*\['evidence','Evidence'\].*\['reports','Reports'\].*\['resolution','Resolution'\].*\['challenges','Challenges'\].*\['proof','Proof Log'\]/s.test(ui));
ok("My Reviews exposes all five real task lanes",
  ["report_publication", "resolution_selection", "challenge_admissibility",
    "challenge_adjudication", "seal_reviews"].every((lane) => ui.includes(lane)));
ok("drawer and modal preserve focus trap Escape and focus restore",
  /function trapFocus/.test(ui) && /event\.key==='Escape'/.test(ui)
    && /restoreFocus\(state\.drawerReturnFocus\)/.test(ui));
ok("legacy public challenge button cannot call legacy mutation",
  !/chxSubmit\(\)/.test(html)
    && !/chxOpen/.test(readFileSync(join(root, "assets/js/84-public-records.js"), "utf8")));
ok("maintainer navigation starts hidden and is revealed only for the admin wallet",
  /id="maintainerAccessMenu" style="display:none"/.test(html)
    && /menu\.style\.display=ctx\.isMaintainerWallet\?'':'none'/.test(maintainerUi));
ok("maintainer Operations Center routes finalization through exact V2 lifecycle",
  /Native Resolution Operations/.test(maintainerUi)
    && /osiV2OpenReviewQueue/.test(maintainerUi) && /osiV2OpenCase/.test(maintainerUi));
ok("Public Records has one accurate lifecycle explainer without legacy bypass copy",
  (html.match(/How a record becomes public/g) || []).length === 1
    && !/maintainer seals it|Published by consensus or maintainer seal/.test(html));
ok("Case workspace derives an exact next step and challenge countdown from server state",
  /function nextStepText/.test(ui) && /function countdownText/.test(ui)
    && /countdownText\(resolution\.challenge_window_closes_at\)/.test(ui));
ok("production rollout enables one lifecycle flag and contains no constant division assertion",
  /Enable only the complete Resolution lifecycle flag/.test(productionWorkflow)
    && !/cast\s*\(\s*1\s*\/\s*0/i.test(productionWorkflow)
    && !/(?:^|[^\w])\d+\s*\/\s*0(?:[^\w]|$)/m.test(productionWorkflow));
ok("Field status derives challenge-active and seal-ready without inventing stored states",
  /function hasBlockingChallenge/.test(ui) && /function isSealReady/.test(ui)
    && /resolution\.seal_quorum\.ready===true/.test(ui)
    && /if\(state\.stage==='resolved'\)return item\.stage==='resolved'\|\|isSealReady\(item\)/.test(ui));
ok("governance pgTAP plan matches its exact assertion count",
  Number(pgTap.match(/select\s+plan\((\d+)\)/i)?.[1])
    === (pgTap.match(/^\s*select\s+(?:ok|is|isnt|throws_ok|lives_ok|cmp_ok|results_eq|bag_eq|set_eq|matches|unlike|has_)\s*\(/gmi) || []).length);

console.log(`OSI V2 governance: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
