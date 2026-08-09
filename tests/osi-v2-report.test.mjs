// Dependency-free regression tests for native Case Report intake and reads.
// Run: node tests/osi-v2-report.test.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const core = await import(
  new URL("../supabase/functions/_shared/osi-v2-report-core.mjs", import.meta.url)
);
const incidentFixture = JSON.parse(readFileSync(
  join(here, "fixtures/osi-v2-report-publication-recovery.json"), "utf8",
));

let pass = 0;
let fail = 0;
function ok(name, condition, detail = "") {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error("FAIL " + name + (detail ? " :: " + detail : ""));
}
const reportUiSource = readFileSync(join(root, "assets/js/v2-report-integration.js"), "utf8");
ok("Report timestamps follow the selected product locale instead of the browser locale",
  reportUiSource.includes("window.OSI_I18N.getLocale()")
    && reportUiSource.includes("==='tr'?'tr-TR':'en-US'")
    && reportUiSource.includes("date.toLocaleString(locale,{dateStyle:'medium',timeStyle:'short'})")
    && !reportUiSource.includes("toLocaleString(undefined"));
ok("the Case Reports tab exposes an honest accessible loading state until the exact public projection resolves",
  reportUiSource.includes("function reportLoadingState(mode)")
    && reportUiSource.includes("Loading published Reports...")
    && reportUiSource.includes("role=\"status\" aria-live=\"polite\"")
    && reportUiSource.includes("aria-hidden=\"true\"")
    && reportUiSource.includes("host.innerHTML=reportLoadingState('public')")
    && reportUiSource.includes("aria-busy=\"true\">'+reportLoadingState(mode)"));
async function rejects(name, fn, pattern) {
  try { await fn(); ok(name, false, "did not reject"); }
  catch (error) { ok(name, pattern.test(String(error?.message ?? error)), String(error)); }
}

const WALLET = "11111111111111111111111111111111";
const OTHER = "11111111111111111111111111111112";
const TX_SIG = "2".repeat(88);
const NOW = 1_800_000_000;
const binding = {
  purpose: "CASE_REPORT_VERSION_SUBMITTED",
  version_public_ref: "OSI-RV-A1B2C3D4E5F60718",
  actor_wallet: WALLET,
  actor_role: "wallet",
  decision: "submit",
  nonce: "n".repeat(43),
  payload_hash: "a".repeat(64),
  issued_at: NOW,
  expires_at: NOW + 120,
};
const memo = core.canonicalReportMemo(binding);
ok("canonical Report Memo uses only the safe exact version reference",
  memo === [
    "OSI2", "1", "CASE_REPORT_VERSION_SUBMITTED", "t=report_version",
    "id=OSI-RV-A1B2C3D4E5F60718", "a=" + WALLET, "r=wallet", "d=submit",
    "n=" + "n".repeat(43), "h=" + "a".repeat(64), "ts=" + NOW,
    "exp=" + (NOW + 120),
  ].join("|") && !memo.includes("restricted"));
ok("Report Memo parses and round-trips",
  core.parseReportMemo(memo)?.version_public_ref === binding.version_public_ref);
ok("exact Report Memo binding passes",
  core.validateReportMemoBinding(memo, binding, NOW + 10).ok === true);
ok("changed exact version is rejected",
  core.validateReportMemoBinding(memo, {
    ...binding, version_public_ref: "OSI-RV-FFFFFFFFFFFFFFFF",
  }, NOW + 10).reason === "wrong_version_public_ref");
ok("changed actor is rejected",
  core.validateReportMemoBinding(memo, { ...binding, actor_wallet: OTHER }, NOW + 10).reason
    === "wrong_actor_wallet");
ok("expired Report Memo binding is rejected",
  core.validateReportMemoBinding(memo, binding, NOW + 121).reason === "expired");

const reviewBinding = {
  purpose: "CASE_REPORT_REVIEW_CAST",
  version_public_ref: binding.version_public_ref,
  actor_wallet: OTHER,
  actor_role: "analyst",
  decision: "approve",
  nonce: "r".repeat(43),
  payload_hash: "b".repeat(64),
  issued_at: NOW,
  expires_at: NOW + 120,
};
const reviewMessage = core.canonicalReportGovernanceMessage(reviewBinding);
ok("review signMessage binds exact version actor role decision nonce and payload",
  core.validateReportGovernanceBinding(reviewMessage, reviewBinding, NOW + 10).ok === true
    && reviewMessage.includes("CASE_REPORT_REVIEW_CAST")
    && reviewMessage.includes("r=analyst")
    && reviewMessage.includes("d=approve"));
ok("review replay with a different decision is rejected",
  core.validateReportGovernanceBinding(reviewMessage, {
    ...reviewBinding, decision: "reject",
  }, NOW + 10).reason === "wrong_decision");
const publicationBinding = {
  ...reviewBinding,
  purpose: "REPORT_PUBLISHED",
  decision: "publish",
  nonce: "p".repeat(43),
};
const publicationMemo = core.canonicalReportGovernanceMessage(publicationBinding);
ok("REPORT_PUBLISHED Memo binds the exact version and eligible analyst actor",
  core.validateReportGovernanceBinding(
    publicationMemo, publicationBinding, NOW + 10,
  ).ok === true);

// The other analyst-quorum outcome. It rides the same class-A envelope, so the
// contracts that keep the two apart are the ones worth pinning.
const rejectionBinding = {
  ...reviewBinding,
  purpose: "REPORT_REJECTED",
  decision: "reject",
  nonce: "x".repeat(43),
};
const rejectionMemo = core.canonicalReportGovernanceMessage(rejectionBinding);
ok("REPORT_REJECTED Memo binds the exact version and eligible analyst actor",
  core.validateReportGovernanceBinding(
    rejectionMemo, rejectionBinding, NOW + 10,
  ).ok === true
    && rejectionMemo.includes("REPORT_REJECTED")
    && rejectionMemo.includes("d=reject"));
ok("a rejection Memo can never be replayed as a publication",
  core.validateReportGovernanceBinding(
    rejectionMemo, { ...rejectionBinding, purpose: "REPORT_PUBLISHED" }, NOW + 10,
  ).ok !== true);
ok("REPORT_REJECTED refuses the publish decision",
  (() => {
    try {
      core.canonicalReportGovernanceMessage({ ...rejectionBinding, decision: "publish" });
      return false;
    } catch { return true; }
  })());
// Rejection is analyst-quorum only, so the D17 maintainer bootstrap role that
// publication may carry must never appear on a rejection message.
ok("REPORT_REJECTED refuses the maintainer actor role",
  (() => {
    try {
      core.canonicalReportGovernanceMessage({ ...rejectionBinding, actor_role: "maintainer" });
      return false;
    } catch { return true; }
  })());
ok("REPORT_PUBLISHED still accepts the maintainer bootstrap actor role",
  typeof core.canonicalReportGovernanceMessage({
    ...publicationBinding, actor_role: "maintainer", nonce: "m".repeat(43),
  }) === "string");

const validPayload = {
  body_private: "A complete restricted trace explains transaction order, wallet relationships, uncertainty, and evidentiary limits.",
  content_public_safe: "A wallet-linked transfer sequence is submitted for independent review.",
  revision_reason_code: null,
  evidence: [
    { kind: "wallet", ref: WALLET },
    { kind: "onchain_tx", ref: TX_SIG },
    { kind: "url", ref: "https://solscan.io/tx/" + TX_SIG },
  ],
};
const normalized = await core.normalizeReportPayload(validPayload);
ok("Report payload normalizes exact structured evidence hashes",
  normalized.evidence.length === 3
    && normalized.evidence.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)));
const emptyEvidence = await core.normalizeReportPayload({
  ...validPayload, evidence: [],
});
ok("Report accepts an exact zero-evidence payload",
  Array.isArray(emptyEvidence.evidence) && emptyEvidence.evidence.length === 0);
const omittedEvidence = await core.normalizeReportPayload({
  ...validPayload, evidence: undefined,
});
ok("omitted optional Report evidence normalizes to the canonical empty array",
  Array.isArray(omittedEvidence.evidence) && omittedEvidence.evidence.length === 0);
const blankEvidence = await core.normalizeReportPayload({
  ...validPayload,
  evidence: [
    { kind: "url", ref: "   " },
    { kind: "", ref: "" },
    { kind: "wallet", ref: WALLET },
  ],
});
ok("blank evidence placeholders are omitted without weakening supplied evidence validation",
  blankEvidence.evidence.length === 1 && blankEvidence.evidence[0].ref === WALLET);
await rejects("non-HTTPS evidence is denied", () => core.normalizeReportPayload({
  ...validPayload, evidence: [{ kind: "url", ref: "http://example.com" }],
}), /URL/);
await rejects("duplicate evidence is denied", () => core.normalizeReportPayload({
  ...validPayload, evidence: [
    { kind: "wallet", ref: WALLET }, { kind: "wallet", ref: WALLET },
  ],
}), /duplicate/);
await rejects("secret material language is denied", () => core.normalizeReportPayload({
  ...validPayload,
  body_private: "This restricted narrative is long enough but includes a seed phrase and private key that must never enter OSI.",
}), /prohibited_secret_material/);
await rejects("unsupported revision reason is denied", () => core.normalizeReportPayload({
  ...validPayload, revision_reason_code: "erase_history",
}), /revision reason/);
const normalizedReview = core.normalizeReportReview({
  version_public_ref: binding.version_public_ref,
  decision: "approve",
  reason_code: "evidence_reviewed",
  public_rationale: "The cited transfers and stated uncertainty were independently checked.",
  private_note: "Restricted correlation note for authorized review routes only.",
});
ok("Report review keeps public-safe rationale separate from restricted note",
  normalizedReview.public_rationale.startsWith("The cited")
    && normalizedReview.private_note.startsWith("Restricted"));
await rejects("Report review rejects a short public rationale", () => Promise.resolve(
  core.normalizeReportReview({ ...normalizedReview, public_rationale: "too short" }),
), /public-safe rationale/);

const transaction = {
  blockTime: NOW + 15,
  meta: { err: null },
  transaction: {
    signatures: [TX_SIG],
    message: {
      accountKeys: [{ pubkey: WALLET, signer: true, writable: true }],
      instructions: [{
        program: "spl-memo",
        programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        parsed: memo,
      }],
    },
  },
};
const confirmed = { err: null, confirmationStatus: "confirmed" };
ok("confirmed exact signer and Memo transaction passes",
  core.validateConfirmedReportTransaction(transaction, confirmed, {
    tx_sig: TX_SIG, wallet: WALLET, memo, issued_at: NOW, expires_at: NOW + 120,
  }).ok === true);
ok("unconfirmed transaction is denied",
  core.validateConfirmedReportTransaction(transaction, {
    err: null, confirmationStatus: "processed",
  }, {
    tx_sig: TX_SIG, wallet: WALLET, memo, issued_at: NOW, expires_at: NOW + 120,
  }).reason === "transaction_not_confirmed");
ok("wrong signer is denied",
  core.validateConfirmedReportTransaction(transaction, confirmed, {
    tx_sig: TX_SIG, wallet: OTHER, memo, issued_at: NOW, expires_at: NOW + 120,
  }).reason === "wrong_signer");
ok("changed Memo is denied",
  core.validateConfirmedReportTransaction(transaction, confirmed, {
    tx_sig: TX_SIG, wallet: WALLET, memo: memo + "x", issued_at: NOW, expires_at: NOW + 120,
  }).reason === "wrong_memo");
ok("finalized signature status with temporarily absent transaction is retryable",
  core.validateConfirmedReportTransaction(null, {
    err: null, confirmationStatus: "finalized",
  }, {
    tx_sig: incidentFixture.transactions[1].tx_sig,
    wallet: incidentFixture.wallet,
    memo: incidentFixture.transactions[1].memo,
    issued_at: incidentFixture.transactions[1].issued_at,
    expires_at: incidentFixture.transactions[1].expires_at,
  }).reason === "transaction_not_indexed");

function incidentTransaction(fixture, overrides = {}) {
  return {
    blockTime: overrides.blockTime ?? fixture.block_time,
    meta: { err: overrides.err ?? null },
    transaction: {
      signatures: [fixture.tx_sig],
      message: {
        accountKeys: [{
          pubkey: overrides.wallet ?? incidentFixture.wallet,
          signer: true,
          writable: true,
        }],
        instructions: [{
          program: "spl-memo",
          programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
          parsed: overrides.memo ?? fixture.memo,
        }],
      },
    },
  };
}
function rpcBatch(fixture, transaction = incidentTransaction(fixture), status = {
  err: null, confirmationStatus: "finalized",
}) {
  return [
    { jsonrpc: "2.0", id: 1, result: transaction },
    { jsonrpc: "2.0", id: 2, result: { value: [status] } },
    { jsonrpc: "2.0", id: 3, result: incidentFixture.mainnet_genesis_hash },
  ];
}
function verifierInput(fixture) {
  return {
    tx_sig: fixture.tx_sig,
    wallet: incidentFixture.wallet,
    memo: fixture.memo,
    issued_at: fixture.issued_at,
    expires_at: fixture.expires_at,
    rpc_url: "https://fixture.invalid",
    mainnet_genesis_hash: incidentFixture.mainnet_genesis_hash,
  };
}
function response(okValue, body) {
  return { ok: okValue, json: async () => body };
}

const incident = incidentFixture.transactions[1];
let lookup = 0;
const indexingRecovery = await core.verifyReportMainnetMemoTransaction(
  verifierInput(incident),
  {
    sleep: async () => {},
    fetch: async () => response(true, rpcBatch(incident, lookup++ === 0 ? null : incidentTransaction(incident))),
  },
);
ok("production incident fixture recovers when parsed transaction follows finalized status",
  indexingRecovery.ok === true
    && indexingRecovery.occurred_at === new Date(incident.block_time * 1000).toISOString()
    && lookup === 2);

let throttledLookup = 0;
const throttledRecovery = await core.verifyReportMainnetMemoTransaction(
  verifierInput(incidentFixture.transactions[0]),
  {
    sleep: async () => {},
    fetch: async () => ++throttledLookup === 1
      ? response(false, null)
      : response(true, rpcBatch(incidentFixture.transactions[0])),
  },
);
ok("temporary RPC 429 or 5xx is retried with the same transaction",
  throttledRecovery.ok === true && throttledLookup === 2);

let malformedLookup = 0;
const malformedRecovery = await core.verifyReportMainnetMemoTransaction(
  verifierInput(incident),
  {
    sleep: async () => {},
    fetch: async () => ++malformedLookup === 1
      ? response(true, { incomplete: true })
      : response(true, rpcBatch(incident)),
  },
);
ok("malformed RPC JSON shape is retried before accepting the exact transaction",
  malformedRecovery.ok === true && malformedLookup === 2);

const wrongIncidentSigner = await core.verifyReportMainnetMemoTransaction(
  verifierInput(incident),
  { fetch: async () => response(true, rpcBatch(incident, incidentTransaction(incident, { wallet: OTHER }))), sleep: async () => {} },
);
ok("incident recovery rejects the wrong signer without another lookup",
  wrongIncidentSigner.reason === "wrong_signer");
const wrongIncidentMemo = await core.verifyReportMainnetMemoTransaction(
  verifierInput(incident),
  { fetch: async () => response(true, rpcBatch(incident, incidentTransaction(incident, { memo: incident.memo + "x" }))), sleep: async () => {} },
);
ok("incident recovery rejects a changed exact Memo", wrongIncidentMemo.reason === "wrong_memo");
const failedIncident = await core.verifyReportMainnetMemoTransaction(
  verifierInput(incident),
  { fetch: async () => response(true, rpcBatch(incident, incidentTransaction(incident, { err: { InstructionError: [0, "Custom"] } }), { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" })), sleep: async () => {} },
);
ok("incident recovery rejects a failed transaction", failedIncident.reason === "transaction_failed");
const outsideWindow = await core.verifyReportMainnetMemoTransaction(
  verifierInput(incident),
  { fetch: async () => response(true, rpcBatch(incident, incidentTransaction(incident, { blockTime: incident.expires_at + 1 }))), sleep: async () => {} },
);
ok("incident recovery rejects a transaction outside the issuance window",
  outsideWindow.reason === "stale_transaction");

const exactVersion = {
  id: "33333333-3333-3333-3333-333333333333",
  version_ref: binding.version_public_ref,
  version_no: 1,
  lifecycle_state: "submitted",
  body_private: validPayload.body_private,
  content_public_safe: validPayload.content_public_safe,
  evidence_snapshot_hash: "e".repeat(64),
  revision_reason_code: null,
  supersedes_version_ref: null,
  created_at: "2026-07-14T00:00:00Z",
};
const evidenceMap = new Map([[exactVersion.id, [{
  ordinal: 1, kind: "wallet", ref: WALLET, sha256: "f".repeat(64),
}]]]);
const receiptMap = new Map([[exactVersion.id, {
  event_type: "CASE_REPORT_VERSION_SUBMITTED",
  proof_type: "solana_memo",
  server_verified: true,
  tx_sig: TX_SIG,
  occurred_at: "2026-07-14T00:00:00Z",
}]]);
const authorDto = core.authorizedReportDto({
  case_public_ref: "OSI-A1B2C3D4E5F6",
  report_public_ref: "OSI-RPT-A1B2C3D4E5F6",
  author_wallet: WALLET,
  status: "active",
  current_version_ref: binding.version_public_ref,
  current_version_no: 1,
  current_published_version_ref: null,
  revision_eligible: true,
}, [exactVersion], evidenceMap, receiptMap, "author");
ok("author DTO includes full exact immutable history and evidence",
  authorDto.versions[0].body_private === validPayload.body_private
    && authorDto.versions[0].evidence[0].ref === WALLET
    && authorDto.versions[0].proof.server_verified === true);
ok("author DTO never invents review mutation controls",
  authorDto.review_mutations_enabled === false && authorDto.revision_eligible === true);
const dualCapabilityMap = new Map([[exactVersion.id, {
  actor_is_eligible_analyst: true,
  actor_is_full_maintainer: true,
  can_cast_analyst_review: true,
  analyst_review_reason_code: null,
  can_publish_via_standard_quorum: false,
  standard_publication_reason_code: "analyst_quorum_not_ready",
  can_publish_via_maintainer_bootstrap: true,
  maintainer_bootstrap_reason_code: null,
  decision_channel: "maintainer_bootstrap",
  standard_quorum_ready: false,
  approve_count: 0,
  approve_weight: 0,
  reject_count: 0,
  reject_weight: 0,
  required_count: 2,
  required_weight: 2,
  sas_enforcement_enabled: true,
  bootstrap_enabled: true,
  bootstrap_active: true,
  bootstrap_tier: "maintainer_only",
  eligible_analyst_count: 0,
  bootstrap_required_analyst_count: 0,
  bootstrap_required_analyst_weight: 0,
}]]);
const dualRoleDto = core.authorizedReportDto({
  case_public_ref: "OSI-A1B2C3D4E5F6",
  report_public_ref: "OSI-RPT-A1B2C3D4E5F6",
  author_wallet: OTHER,
  status: "active",
  current_version_ref: binding.version_public_ref,
  current_version_no: 1,
  current_published_version_ref: null,
}, [exactVersion], evidenceMap, receiptMap, "maintainer",
new Map(), new Map(), dualCapabilityMap);
ok("dual-role Report DTO preserves analyst review and maintainer bootstrap independently",
  dualRoleDto.can_cast_analyst_review === true
    && dualRoleDto.can_publish_via_maintainer_bootstrap === true
    && dualRoleDto.review_mutations_enabled === true
    && dualRoleDto.publication_capability.decision_channel === "maintainer_bootstrap"
    && dualRoleDto.versions[0].publication_capability.bootstrap.tier === "maintainer_only");
ok("public unpublished projection is empty",
  core.publicPublishedReports([{ current_published_version_id: null }]).length === 0);
let unpublishedProjectionRejected = false;
try {
  core.publicReportGovernanceDto({
    report_public_ref: "OSI-RPT-A1B2C3D4E5F6",
    version_public_ref: binding.version_public_ref,
    version_no: 1,
    lifecycle_state: "in_review",
  });
} catch (error) {
  unpublishedProjectionRejected = error instanceof TypeError;
}
ok("public Report DTO rejects every unpublished lifecycle state",
  unpublishedProjectionRejected);
const restrictedPublicSentinel = "RESTRICTED BODY MUST NEVER ENTER A PUBLIC DTO";
const nullablePublicDto = core.publicReportGovernanceDto({
  report_public_ref: "OSI-RPT-A1B2C3D4E5F6",
  version_public_ref: binding.version_public_ref,
  version_no: 1,
  lifecycle_state: "published",
  body_private: restrictedPublicSentinel,
  content_public_safe: null,
  evidence: [],
  reviews: [],
});
ok("published Report DTO preserves an absent public-safe summary as null",
  nullablePublicDto.content_public_safe === null);
ok("published Report DTO never falls back to the restricted body",
  !Object.hasOwn(nullablePublicDto, "body")
    && !Object.hasOwn(nullablePublicDto, "body_private")
    && !JSON.stringify(nullablePublicDto).includes(restrictedPublicSentinel));
const summarizedPublicDto = core.publicReportGovernanceDto({
  report_public_ref: "OSI-RPT-A1B2C3D4E5F6",
  version_public_ref: binding.version_public_ref,
  version_no: 1,
  lifecycle_state: "published",
  content_public_safe: validPayload.content_public_safe,
});
ok("published Report DTO keeps a supplied public-safe summary unchanged",
  summarizedPublicDto.content_public_safe === validPayload.content_public_safe);

ok("publication-state constraint failures are not mislabeled as proof expiry",
  JSON.stringify(core.classifyReportRpcFailure({
    code: "23514",
    message: "new row violates check constraint",
    details: 'Failing row violates constraint "case_report_versions_publication_state_check"',
  }, true)) === JSON.stringify({ status: 503, error: "publication_state_invalid" }));
ok("an exact prepared-publication binding failure remains a proof failure",
  core.classifyReportRpcFailure({
    code: "23514", message: "Report publication payload changed after prepare",
  }, true).error === "proof_binding_rejected");
ok("unrelated check violations use a bounded lifecycle error",
  core.classifyReportRpcFailure({ code: "23514", message: "another constraint" }, true).error
    === "report_state_rejected");
ok("unrelated invalid parameters use a bounded request error",
  core.classifyReportRpcFailure({ code: "22023", message: "another parameter" }, true).error
    === "report_request_invalid");
ok("the exact publication issuance-window failure keeps its recovery guidance",
  core.classifyReportRpcFailure({
    code: "22023", message: "Report publication transaction outside issuance window",
  }, true).error === "publication_transaction_outside_window");

const writeSource = readFileSync(
  join(root, "supabase/functions/osi-v2-report-write/index.ts"), "utf8",
);
const readSource = readFileSync(
  join(root, "supabase/functions/osi-v2-report-read/index.ts"), "utf8",
);
const uiSource = readFileSync(join(root, "assets/js/v2-report-integration.js"), "utf8");
const html = readFileSync(join(root, "index.html"), "utf8");
const migration = readFileSync(
  join(root, "supabase/migrations/20260714044036_osi_v2_case_report_intake.sql"), "utf8",
);
const governanceMigration = readFileSync(
  join(root, "supabase/migrations/20260714064501_osi_v2_report_review_publication.sql"), "utf8",
);
const recoveryMigration = readFileSync(
  join(root, "supabase/migrations/20260729134213_osi_v2_workflow_recovery_usability.sql"), "utf8",
);
const config = readFileSync(join(root, "supabase/config.toml"), "utf8");
const productionWorkflow = readFileSync(
  join(root, ".github/workflows/archive/osi-v2-report-review-production.yml"), "utf8",
);

ok("Report gateways never select broad star",
  !writeSource.includes('select("*")') && !readSource.includes('select("*")'));
ok("write gateway verifies exact mainnet genesis, Memo, signer, and confirmation",
  writeSource.includes("MAINNET_GENESIS_HASH")
    && writeSource.includes("verifyReportMainnetMemoTransaction")
    && readFileSync(
      join(root, "supabase/functions/_shared/osi-v2-report-core.mjs"), "utf8",
    ).includes('method: "getGenesisHash"'));
ok("prepare and commit both fail closed on the dedicated flag",
  (writeSource.match(/reportWritesEnabled\(\)/g) ?? []).length >= 3
    && migration.includes("osi_v2_report_writes_enabled() is distinct from true"));
ok("review and publication use an independent fail-closed flag",
  governanceMigration.includes("OSI_V2_REPORT_REVIEW_WRITES_ENABLED")
    && (governanceMigration.match(/osi_v2_report_review_writes_enabled\(\) is distinct from true/g) ?? []).length >= 4
    && writeSource.includes("reportReviewWritesEnabled"));
ok("broad Case and proof flags are untouched by Report gateway",
  !writeSource.includes("OSI_V2_WRITES_ENABLED")
    && !writeSource.includes("OSI_V2_PROOF_ENABLED")
    && !writeSource.includes("OSI_V2_CASE_WRITES_ENABLED"));
ok("read gateway derives analyst eligibility and full maintainer double gate",
  readSource.includes("analystEligible")
    && readSource.includes("walletGate && authGate")
    && readSource.includes("half_maintainer_wallet_only")
    && readSource.includes("half_maintainer_auth_only"));
ok("author, review and public Report reads exclude archived and legacy-import parent Cases",
  readSource.includes('in("id", caseIds).is("archived_at", null)')
    && readSource.includes('eq("visibility", "public").is("archived_at", null)')
    && (readSource.match(/\.neq\("category", "legacy_import"\)/g) || []).length >= 2
    && readSource.includes('return !!caseRow && (access === "author" || (')
    && readSource.includes('header.author_wallet !== viewerWallet')
    && readSource.includes('caseRow?.submitted_by_wallet !== viewerWallet'));
ok("read gateway has durable issue and consume RPCs but no domain writes",
  readSource.includes('rpc("osi_v2_issue_read_nonce"')
    && readSource.includes('rpc("osi_v2_consume_read_nonce"')
    && !/[.]insert\(|[.]update\(|[.]delete\(|[.]upsert\(/.test(readSource));
ok("database commit is one exact atomic function",
  /create function osi_private\.osi_v2_commit_report_version[\s\S]*insert into public\.event_receipts[\s\S]*update public\.osi_nonces[\s\S]*insert into public\.case_report_versions[\s\S]*update public\.case_reports/i.test(migration));
ok("review history is append-only and snapshots server-derived weight and tier",
  governanceMigration.includes("CASE_REPORT_REVIEW_REVISED")
    && governanceMigration.includes("profile.weight_cached")
    && governanceMigration.includes("profile.tier_code")
    && governanceMigration.includes("superseded_by = new_review_id"));
ok("Report author and Case owner are both denied review and publication",
  (governanceMigration.match(/in \(report_row\.author_wallet, case_row\.submitted_by_wallet\)/g) ?? []).length >= 3);
ok("publication requires count and weight quorum and preserves Case lifecycle",
  governanceMigration.includes("approval_count >= minimum_count and approval_weight >= minimum_weight")
    && governanceMigration.includes("'REPORT_PUBLISHED'")
    && !/update\s+public\.cases[\s\S]*REPORT_PUBLISHED/i.test(governanceMigration));
ok("review receipts are wallet-signed while publication receipt is a Solana Memo",
  governanceMigration.includes("'wallet_signed_server_verified'")
    && governanceMigration.includes("'solana_memo'")
    && writeSource.includes("verifyEd25519Signature")
    && writeSource.includes("verifyMainnetMemoTransaction"));
ok("revision lineage and published pointer rules are explicit",
  migration.includes("supersedes_version_id")
    && migration.includes("current_version_id = actual_version_id")
    && !/set\s+current_published_version_id/i.test(migration));
ok("one native header per exact Case and author is enforced",
  migration.includes("case_reports_native_case_author_uidx")
    && migration.includes("Report lineage is ambiguous"));
ok("nonce binds server-generated version and non-secret reservation context",
  migration.includes("binding_context")
    && migration.includes("'version_public_ref'")
    && migration.includes("'evidence_manifest_hash'")
    && !migration.slice(
      migration.indexOf("p_request_fingerprint_hash, binding_context"),
      migration.indexOf("issued_time + pg_catalog.make_interval", migration.indexOf("p_request_fingerprint_hash, binding_context")),
    ).includes("p_body_private"));
ok("additive recovery migration canonicalizes zero evidence without a placeholder",
  recoveryMigration.includes("between 0 and 12 references")
    && recoveryMigration.includes("'[]'::jsonb")
    && recoveryMigration.includes("coalesce(")
    && !recoveryMigration.includes("placeholder.invalid"));
ok("canonical Report capability RPC is service-only, side-effect-free and SAS-aware",
  recoveryMigration.includes("osi_v2_report_publication_capabilities")
    && recoveryMigration.includes("osi_private.osi_v2_report_quorum(target.version_id)")
    && recoveryMigration.includes("osi_private.osi_v2_sas_enforcement_enabled()")
    && recoveryMigration.includes("from public, anon, authenticated")
    && recoveryMigration.includes("to service_role")
    && !/osi_v2_report_publication_capabilities[\s\S]*insert into public\.osi_nonces/i.test(
      recoveryMigration,
    ));
ok("signed Report queue consumes independent actor capabilities and submitted versions",
  readSource.includes('rpc("osi_v2_report_publication_capabilities"')
    && readSource.includes('maintainer.ok ? "maintainer" : analyst ? "analyst"')
    && readSource.includes('["submitted", "in_review"].includes(current.lifecycle_state)')
    && readSource.includes("can_publish_via_maintainer_bootstrap")
    && !readSource.includes("Maintainers may inspect restricted review material but cannot replace analyst quorum."));
ok("restricted Report queue excludes authors and Case owners before graph loading",
  readSource.includes('.neq("author_wallet", proof.wallet)')
    && readSource.includes('select("id,submitted_by_wallet")')
    && readSource.includes("const eligibleHeaders = candidateHeaders.filter")
    && readSource.indexOf("const eligibleHeaders = candidateHeaders.filter")
      < readSource.indexOf("eligibleHeaders,", readSource.indexOf("const eligibleHeaders")));
const unsignedCapabilitiesSource = writeSource.slice(
  writeSource.indexOf("async function capabilities("),
  writeSource.indexOf("serve(async", writeSource.indexOf("async function capabilities(")),
);
ok("unsigned write preflight cannot enumerate an unpublished exact Report version",
  !unsignedCapabilitiesSource.includes("exactVersion(")
    && !unsignedCapabilitiesSource.includes("osi_v2_report_publication_capabilities")
    && !unsignedCapabilitiesSource.includes("version_available"));
const publicationCommitSource = writeSource.slice(
  writeSource.indexOf("async function commitPublication("),
  writeSource.indexOf("async function listPublicationRecovery("),
);
ok("bootstrap recovery revalidates the full maintainer before querying chain data",
  publicationCommitSource.indexOf("await fullMaintainer(req, wallet)") >= 0
    && publicationCommitSource.indexOf("await fullMaintainer(req, wallet)")
      < publicationCommitSource.indexOf("verifyMainnetMemoTransaction("));
const publicationRecoverySource = writeSource.slice(
  writeSource.indexOf("async function listPublicationRecovery("),
  writeSource.indexOf("async function capabilities("),
);
ok("historical recovery lists only exact unconsumed bootstrap proofs for the current full maintainer",
  publicationRecoverySource.includes("await fullMaintainer(req, wallet)")
    && publicationRecoverySource.includes('.eq("target_id", String(target.row.id))')
    && publicationRecoverySource.includes('.is("consumed_at", null)')
    && publicationRecoverySource.includes('decision_channel !== "maintainer_bootstrap"')
    && publicationRecoverySource.includes("maintainer_auth_uuid !== gate.auth_id"));
ok("read quorum fails closed unless SAS authority explicitly counts a review",
  readSource.includes("review.sas_authority?.counted === true")
    && !readSource.includes("review.sas_authority?.enforced !== true"));
ok("Report functions use explicit custom authorization config",
  /\[functions\.osi-v2-report-write\][\s\S]*?verify_jwt\s*=\s*false/.test(config)
    && /\[functions\.osi-v2-report-read\][\s\S]*?verify_jwt\s*=\s*false/.test(config));
ok("My Reports and Report Queue are wired to real signed endpoints",
  html.includes("osiV2OpenMyReports()") && html.includes("osiV2OpenReviewQueue()")
    && uiSource.includes("list_my_reports") && uiSource.includes("list_review_queue")
    && uiSource.includes("osiV2LoadReportReviewTasks"));
ok("eligible analyst review and exact publication controls are wired",
  uiSource.includes("prepare_review") && uiSource.includes("commit_review")
    && uiSource.includes("prepare_publication") && uiSource.includes("commit_publication")
    && uiSource.includes("Only analysts count toward publication quorum"));
ok("Report reviews require rationale only for negative or revision decisions",
  uiSource.includes("Required for reject or request revision; optional otherwise")
    && uiSource.includes("decision.value==='reject'||decision.value==='request_revision'")
    && uiSource.includes("The exact report version and its evidence were reviewed.")
    && uiSource.includes("rationale.reportValidity()"));
ok("public Case Report status uses a public allowlist endpoint",
  readSource.includes("listPublicReports")
    && readSource.includes("publicReportGovernanceDto")
    && uiSource.includes("list_public_reports"));
const publicReadSlice = readSource.slice(
  readSource.indexOf("async function listPublicReports("),
  readSource.indexOf("serve(async", readSource.indexOf("async function listPublicReports(")),
);
// This assertion used to be "the public projection never reads the body". The
// body is now publishable, so the guarantee moves rather than disappears: the
// anonymous path may read it, and must hand every copy to the one function that
// decides whether it may leave. Nothing here may reach a response by any other
// route, and the query that feeds it must still be pinned to the published
// pointer, which the assertion below this one holds.
ok("anonymous Report reads pass the body only through the projection that gates it",
  publicReadSlice.includes("PUBLIC_VERSION_COLS")
    && publicReadSlice.includes("publicReportGovernanceDto(")
    && publicReadSlice.split("\n").filter((line) => line.includes("body_private")).length === 1
    && publicReadSlice.includes("body_private: version.body_private,")
    && publicReadSlice.includes("body_is_public: version.body_is_public,")
    && !/jsonResponse\([^)]*body_private/.test(publicReadSlice));
ok("only a published version whose author allowed it can carry the body out",
  /public_body:\s*report\.body_is_public === true && report\.body_private != null/
    .test(readFileSync(join(root, "supabase/functions/_shared/osi-v2-report-core.mjs"), "utf8")));
ok("public Report visibility follows only the exact published pointer",
  readSource.includes('.not("current_published_version_id", "is", null)')
    && readSource.includes("String(header.current_published_version_id) === String(version.id)")
    && !/quorumFor\([\s\S]*?\)\.approve_count >= 1/.test(readSource)
    && uiSource.includes("Every Report and exact version stays private until publication is finalized.")
    && !uiSource.includes("private until its first counted approval"));
ok("Case Report drawer writes are bound to the exact Case load and DOM instance",
  uiSource.includes("sectionLoadToken")
    && uiSource.includes("token===state.sectionLoadToken")
    && uiSource.includes("String(state.sectionContext.public_ref||'')===String(caseRef||'')")
    && uiSource.includes("document.getElementById('osi-public-reports')===host")
    && uiSource.includes("expectedRenderToken!==state.sectionLoadToken")
    && uiSource.includes("!sectionIsCurrent(token,caseRef,host)"));
ok("production rollout changes only the dedicated review flag and fails closed",
  productionWorkflow.includes("REPORT-REVIEW-DEPLOY-${EXPECTED_PROJECT_REF}")
    && productionWorkflow.includes("OSI_V2_REPORT_REVIEW_WRITES_ENABLED")
    && productionWorkflow.includes("review_flag")
    && !/cast\s*\(\s*1\s*\/\s*0/i.test(productionWorkflow));
ok("production Deno checks tolerate only bounded dependency registry failures",
  productionWorkflow.includes("deno_check_with_retry()")
    && productionWorkflow.includes("for attempt in 1 2 3")
    && (productionWorkflow.match(/deno_check_with_retry supabase\/functions\//g) ?? []).length === 5
    && productionWorkflow.includes('if [ "$attempt" -eq 3 ]'));
ok("Report form provides exact prerequisite and transaction states",
  uiSource.includes("Preparing the exact Case, version, evidence manifest")
    && uiSource.includes("Approve the exact CASE_REPORT_VERSION_SUBMITTED Memo")
    && uiSource.includes("Confirming mainnet, signer, exact Memo"));
// The restricted narrative and the public-safe summary now render through
// reportProseBlock -> publicProse, which preserves paragraphs for long-form
// research. The escaping invariant is unchanged and is asserted on the exact
// path the content now takes: every text chunk goes through esc() and only the
// paragraph structure is markup.
ok("untrusted Report content is escaped before innerHTML rendering",
  uiSource.includes("reportProseBlock('Restricted narrative',version.body_private)")
    && uiSource.includes("reportProseBlock('Public-safe summary',version.content_public_safe)")
    && uiSource.includes("function reportProseBlock(heading,value){")
    && uiSource.includes("var body=publicProse(value);")
    && /function publicProse\(value\)\{[\s\S]*?return esc\(line\.trim\(\)\);/.test(uiSource)
    && uiSource.includes("esc(item.ref)"));
// Structured references are the substance of a published Report, so the
// renderer must emit the exact untruncated value in the copy target, the title
// and the link, and it must refuse any href that is not a validated https URL.
ok("published Report references render structurally with escaped exact values",
  uiSource.includes("function structuredReferences(row)")
    && uiSource.includes("window.osiV2EvidenceSectionsHtml")
    && uiSource.includes("evidence_sections:row&&row.evidence_sections||null")
    && uiSource.includes('var safe=/^https:\\/\\/[^\\s"\'<>]+$/.test(link)?link:\'\';')
    && uiSource.includes("title=\"'+esc(item.ref)+'\">'+esc(item.ref)+'</div>"));
const publicRowsSlice = uiSource.slice(
  uiSource.indexOf("function publishedRows("),
  uiSource.indexOf("async function publicReports", uiSource.indexOf("function publishedRows(")),
);
ok("public Report rendering explains a missing summary without reading a body fallback",
  publicRowsSlice.includes("No public-safe summary was provided.")
    && publicRowsSlice.includes("The restricted Report body is not public.")
    && !publicRowsSlice.includes("row.body"));
ok("bootstrap publication remains visibly distinct after public or authorized reload",
  uiSource.includes("proof.decision_channel_label")
    && uiSource.includes("decision_channel=")
    && uiSource.includes("It is not independent analyst quorum.")
    && uiSource.includes("publicationChannelHtml(row.publication_proof)")
    && uiSource.includes("publicationChannelHtml(proof)"));
// ── The published analysis is public ────────────────────────────────────────
// Publishing a conclusion while withholding the reasoning is the opposite of
// what this projection exists for. The first Report to clear an analyst quorum
// carried 10,651 characters of traced, sourced analysis and showed the public
// 607 of them. Publication is the gate; the author's flag is the choice.
const publishedBase = {
  report_public_ref: "OSI-RPT-B7D4E9F4A3D1",
  version_public_ref: "OSI-RV-84E1DCA675CA4480",
  version_no: 1,
  lifecycle_state: "published",
  content_public_safe: "A traced fund movement path is published for review.",
  body_private: "1. Subject and Scope\n\nThe reviewed analysis, in full.",
  evidence: [],
  reviews: [],
};
ok("a published version whose author allowed it carries the full analysis", (() => {
  const dto = core.publicReportGovernanceDto({ ...publishedBase, body_is_public: true });
  return dto.public_body === publishedBase.body_private;
})());
ok("a published version whose author held the analysis back carries none of it", (() => {
  const dto = core.publicReportGovernanceDto({ ...publishedBase, body_is_public: false });
  return dto.public_body === null && dto.content_public_safe !== null;
})());
ok("publication itself is still the gate an unpublished version cannot pass", (() => {
  for (const state of ["draft", "submitted", "in_review", "rejected", "superseded"]) {
    let refused = false;
    try {
      core.publicReportGovernanceDto({ ...publishedBase, lifecycle_state: state, body_is_public: true });
    } catch { refused = true; }
    if (!refused) return false;
  }
  return true;
})());
ok("the public read gateway selects and forwards both halves of that decision", (() => {
  const edge = readFileSync(join(root, "supabase/functions/osi-v2-report-read/index.ts"), "utf8");
  const cols = edge.match(/const PUBLIC_VERSION_COLS =\s*\n?\s*"([^"]+)"/);
  return Boolean(cols)
    && cols[1].includes("body_private") && cols[1].includes("body_is_public")
    && edge.includes("body_private: version.body_private,")
    && edge.includes("body_is_public: version.body_is_public,");
})());
ok("the published analysis renders as prose, escaped, and never as raw markup",
  reportUiSource.includes("row.public_body")
    && /public_body[\s\S]{0,320}publicProse\(row\.public_body\)/.test(reportUiSource)
    && reportUiSource.includes("osi-report-full"));

// ── A signed publication survives the tab ───────────────────────────────────
// On 2026-08-09 an analyst signed a REPORT_PUBLISHED Memo that confirmed on
// mainnet 66 seconds inside its window, the commit never fired, and the
// signature became unrecoverable: the only pointer to it lived in
// sessionStorage, and the standard route has no server-side recovery. The fee
// was spent and the Report stayed unpublished. These pin the storage tier to
// the line the validator already draws between prepared and signed.
ok("a prepared outcome with no signature stays tab-scoped",
  /if\(!normalized\.txSig\)\{try\{localStorage\.removeItem\(key\);\}catch\(_\)\{\}return stored;\}/
    .test(reportUiSource));
ok("a signed outcome is written to durable storage as well",
  /function persistPublicationPending\(normalized\)[\s\S]{0,420}localStorage\.setItem\(key,body\)/
    .test(reportUiSource));
ok("a closed tab falls back to the durable copy instead of losing the signature",
  /function loadPublicationPending[\s\S]{0,600}sessionStorage\.getItem\(key\)[\s\S]{0,240}localStorage\.getItem\(key\)/
    .test(reportUiSource));
ok("clearing a pending outcome clears both copies, never just one",
  /function removePublicationPending[\s\S]{0,320}sessionStorage\.removeItem\(key\)[\s\S]{0,120}localStorage\.removeItem\(key\)/
    .test(reportUiSource)
    && /function clearPublicationPendingForWallet[\s\S]{0,320}\[sessionStorage,localStorage\]/
      .test(reportUiSource));
ok("the validator still refuses an unsigned record past its window, and keeps a signed one",
  reportUiSource.includes("if(!txSig&&expiresAt<Math.floor(Date.now()/1000))return null;"));
ok("a stored record still never carries anything beyond the on-chain artefact",
  /return\{purpose:purpose,route:route,versionRef:exactVersion,wallet:exactWallet,nonce:nonce,memo:memo,txSig:txSig,/
    .test(reportUiSource)
    && !/normalizePublicationPending[\s\S]{0,1400}(read_session|private_note|body_private)/.test(reportUiSource));

// ── Reviewer identity ───────────────────────────────────────────────────────
// A handle is optional on an analyst profile and two of the three live
// analysts have never set one, so a reviewer resolved by handle alone rendered
// as a shortened wallet on the Report surfaces while the Analyst Network
// showed their name. These pin the one order both now use.
ok("a reviewer with no handle is still carried by name through the authorized DTO", (() => {
  const dto = core.authorizedReportDto(
    {
      case_public_ref: "OSI-E0F2D49EA78B",
      report_public_ref: "OSI-RPT-B7D4E9F4A3D1",
      author_wallet: "9KZXnfztWnBNJARVGyMoPuT7dF759bKuPwgdmgUVJQXb",
      status: "active",
      current_version_ref: "OSI-RV-84E1DCA675CA4480",
    },
    [{
      id: "v1", version_ref: "OSI-RV-84E1DCA675CA4480", version_no: 1,
      lifecycle_state: "in_review",
      created_by_wallet: "9KZXnfztWnBNJARVGyMoPuT7dF759bKuPwgdmgUVJQXb",
      evidence_snapshot_hash: "a".repeat(64), body_private: "body",
    }],
    new Map([["v1", []]]),
    new Map(),
    "analyst",
    new Map([["v1", [
      { public_ref: "OSI-RVW-9758F496558B4410", reviewer_wallet: "fceautvpTPgT3BV43SbCU6i9P1QhHz5PhKM96ZFgQ9v",
        reviewer_handle: null, reviewer_display_name: "lilbagscientist",
        decision: "approve", weight: 0.5, tier_snapshot: "probationary", is_active: true },
      { public_ref: "OSI-RVW-79E56FCED14449E7", reviewer_wallet: "2awpjumkqhWywwbmDBixjo7cAnqD5fGfNGNv6MMTc4M7",
        reviewer_handle: "nerissa", reviewer_display_name: "NerissaXBT",
        decision: "approve", weight: 0.5, tier_snapshot: "probationary", is_active: true },
    ]]]),
  );
  const reviews = dto.versions[0].reviews;
  return reviews[0].reviewer_display_name === "lilbagscientist"
    && reviews[0].reviewer_handle === null
    && reviews[1].reviewer_display_name === "NerissaXBT";
})());
ok("the read gateway selects the display name it is asked to project", (() => {
  const edge = readFileSync(join(root, "supabase/functions/osi-v2-report-read/index.ts"), "utf8");
  const selects = edge.match(/\.select\("wallet,handle[^"]*"\)/g) || [];
  return selects.length >= 2
    && selects.every((select) => select.includes("display_name"))
    && (edge.match(/reviewer_display_name:/g) || []).length >= 2;
})());
ok("both Report review surfaces resolve one reviewer through one helper",
  uiSource.includes("function reviewerName(review)")
    && /reviewerName[\s\S]{0,220}reviewer_display_name[\s\S]{0,120}reviewer_handle[\s\S]{0,120}short\(/.test(uiSource)
    && (uiSource.match(/esc\(reviewerName\(review\)\)/g) || []).length === 2
    && !uiSource.includes("review.reviewer_handle||short(review.reviewer_wallet)"));

ok("legacy and preview pages never load the Report bundle",
  !readFileSync(join(root, "legacy.html"), "utf8").includes("v2-report-integration")
    && !existsSync(join(root, "v2-preview.html"))
    && readFileSync(join(root, "vercel.json"), "utf8").includes('"source": "/v2-preview.html"'));

console.log((fail ? "FAILED: " + fail : "OK")
  + " (" + pass + " assertions passed, " + fail + " failed)");
process.exit(fail ? 1 : 0);
