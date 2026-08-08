import { readFileSync } from "node:fs";
import * as core from "../supabase/functions/_shared/osi-v2-wire-core.mjs";

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error("FAIL: " + name);
  passed += 1;
  console.log("PASS: " + name);
}
async function rejects(name, runner, pattern) {
  try { await runner(); }
  catch (error) { ok(name, pattern.test(String(error?.message || error))); return; }
  throw new Error("FAIL: " + name);
}
function loadNamedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`Unclosed function ${name}`);
  return Function(`"use strict";return (${source.slice(start, end)});`)();
}

const WALLET = "11111111111111111111111111111112";
const OTHER = "11111111111111111111111111111113";
const TX_SIG = "2".repeat(88);
const NOW = 1_800_000_000;
const binding = {
  purpose: core.WIRE_EVENT_TYPE,
  version_public_ref: "OSI-WV-A1B2C3D4E5F60718",
  actor_wallet: WALLET,
  actor_role: "wallet",
  decision: "submit",
  nonce: "n".repeat(43),
  payload_hash: "a".repeat(64),
  issued_at: NOW,
  expires_at: NOW + 120,
};
const memo = core.canonicalWireMemo(binding);
ok("Wire Memo uses the canonical class-A event and typed target",
  memo.startsWith("OSI2|1|WIRE_REPORT_VERSION_SUBMITTED|t=wire_version|id=OSI-WV-"));
ok("Wire Memo validates only against the exact prepared binding",
  core.validateWireMemoBinding(memo, binding, NOW + 10).ok === true
    && core.validateWireMemoBinding(memo, { ...binding, actor_wallet: OTHER }, NOW + 10).ok === false);
ok("changed Wire Memo text is rejected", core.parseWireMemo(memo + "x") === null);

const validPayload = {
  title_public_safe: "Treasury transfer sequence for review",
  content_public_safe: "A public-safe summary describes a linked transfer sequence without asserting guilt or identity.",
  body_private: "The detailed analysis records transaction order, wallet relationships, alternative explanations, and the exact source trail for independent review.",
  uncertainties_private: "Attribution remains uncertain and exchange ownership has not been independently confirmed.",
  revision_reason_code: null,
  evidence: [
    { kind: "wallet", ref: WALLET },
    { kind: "onchain_tx", ref: TX_SIG },
    { kind: "url", ref: "https://solscan.io/tx/" + TX_SIG },
  ],
};
const normalized = await core.normalizeWirePayload(validPayload);
ok("Wire payload binds ordered structured evidence hashes",
  normalized.evidence.length === 3
    && normalized.evidence.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)));
await rejects("Wire requires a public-safe title", () => core.normalizeWirePayload({
  ...validPayload, title_public_safe: "x",
}), /title/i);
const minimalWire = await core.normalizeWirePayload({
  title_public_safe: "DEX",
  content_public_safe: "Public flow",
  body_private: "Public transactions show a repeated transfer pattern.",
  uncertainties_private: "",
  revision_reason_code: null,
  evidence: [],
});
ok("Wire accepts optional uncertainties and an empty structured evidence manifest",
  minimalWire.uncertainties_private === "" && minimalWire.evidence.length === 0);
await rejects("Wire rejects non-HTTPS evidence", () => core.normalizeWirePayload({
  ...validPayload, evidence: [{ kind: "url", ref: "http://example.com" }],
}), /URL/);
await rejects("Wire rejects duplicate evidence", () => core.normalizeWirePayload({
  ...validPayload, evidence: [{ kind: "wallet", ref: WALLET }, { kind: "wallet", ref: WALLET }],
}), /duplicate/);
await rejects("Wire rejects secret material server-side", () => core.normalizeWirePayload({
  ...validPayload,
  body_private: "This detailed analysis is long enough but asks for a seed phrase and private key, which must never enter the Wire intake path.",
}), /prohibited_secret_material/);
await rejects("Wire rejects illegal-access material server-side", () => core.normalizeWirePayload({
  ...validPayload,
  body_private: "This detailed analysis is long enough but includes stolen credentials for unauthorized access, which must never enter the Wire intake path.",
}), /prohibited_illegal_access_material/);
await rejects("Wire rejects doxxing material server-side", () => core.normalizeWirePayload({
  ...validPayload,
  body_private: "This detailed analysis is long enough but includes a private home address for doxxing, which must never enter the Wire intake path.",
}), /prohibited_personal_data/);
await rejects("Wire rejects an invented revision reason", () => core.normalizeWirePayload({
  ...validPayload, revision_reason_code: "erase_history",
}), /revision reason/);
ok("Wire references are typed and do not accept Case Report references",
  core.validateWireReportRef("OSI-WR-A1B2C3D4E5F6") === "OSI-WR-A1B2C3D4E5F6");
await rejects("Wire reference parser rejects the wrong lane", () => Promise.resolve(
  core.validateWireReportRef("OSI-RPT-A1B2C3D4E5F6"),
), /reference/);

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
ok("confirmed exact Wire signer and Memo transaction passes",
  core.validateConfirmedWireTransaction(transaction, confirmed, {
    tx_sig: TX_SIG, wallet: WALLET, memo, issued_at: NOW, expires_at: NOW + 120,
  }).ok === true);
ok("wrong Wire signer is rejected",
  core.validateConfirmedWireTransaction(transaction, confirmed, {
    tx_sig: TX_SIG, wallet: OTHER, memo, issued_at: NOW, expires_at: NOW + 120,
  }).reason === "wrong_signer");
ok("unconfirmed Wire transaction is rejected",
  core.validateConfirmedWireTransaction(transaction, {
    err: null, confirmationStatus: "processed",
  }, {
    tx_sig: TX_SIG, wallet: WALLET, memo, issued_at: NOW, expires_at: NOW + 120,
  }).reason === "transaction_not_confirmed");

const version = {
  id: "33333333-3333-4333-8333-333333333333",
  version_ref: binding.version_public_ref,
  version_no: 1,
  lifecycle_state: "submitted",
  title_public_safe: validPayload.title_public_safe,
  content_public_safe: validPayload.content_public_safe,
  body_private: validPayload.body_private,
  uncertainties_private: validPayload.uncertainties_private,
  evidence_snapshot_hash: "e".repeat(64),
  revision_reason_code: null,
  supersedes_version_ref: null,
  created_at: "2026-07-18T00:00:00Z",
};
const evidence = new Map([[version.id, [{
  ordinal: 1, kind: "wallet", ref: WALLET, sha256: "f".repeat(64),
}]]]);
const receipts = new Map([[version.id, {
  event_type: core.WIRE_EVENT_TYPE,
  target_type: "wire_version",
  actor_wallet: WALLET,
  actor_role: "wallet",
  decision: "submit",
  proof_type: "solana_memo",
  server_verified: true,
  tx_sig: TX_SIG,
  occurred_at: "2026-07-18T00:00:00Z",
}]]);
const dto = core.authorizedWireReportDto({
  public_ref: "OSI-WR-A1B2C3D4E5F6",
  status: "active",
  current_version_ref: binding.version_public_ref,
  current_version_no: 1,
  current_published_version_ref: null,
}, [version], evidence, receipts, true);
ok("author DTO contains exact private history and verified proof",
  dto.versions[0].body_private === validPayload.body_private
    && dto.versions[0].evidence[0].ref === WALLET
    && dto.versions[0].proof.server_verified === true);
ok("author DTO omits internal identifiers and proof binding material",
  dto.id === undefined && dto.author_wallet === undefined
    && dto.versions[0].id === undefined && dto.versions[0].nonce === undefined
    && dto.versions[0].payload_hash === undefined && dto.versions[0].signature === undefined);
ok("Phase 1 DTO never invents public or governance controls",
  dto.current_published_version_ref === null
    && dto.review_mutations_enabled === undefined
    && dto.publication_enabled === undefined);

const publicDto = core.publicWireReportDto({
  analysis: "restricted body must not cross the public boundary",
  author: { display_name: "Analyst", handle: "analyst", wallet: WALLET, auth_uuid: "private" },
  challenge_state: null,
  challenges: [{
    challenge_public_ref: "OSI-CHL-A1B2C3D4E5F60718",
    challenger_wallet: OTHER,
    public_safe_summary: "Public challenge summary",
    restricted_detail: "private challenge detail",
    reviews: [{
      public_rationale: "Public rationale",
      private_note: "restricted review note",
      reviewer: { wallet: OTHER, auth_uuid: "private" },
    }],
  }],
  evidence: [{ ordinal: 1, kind: "wallet", ref: WALLET, sha256: "f".repeat(64), id: "private" }],
  is_current_published: true,
  proof_log: [{
    event_type: "SUPPORT_PAYMENT_CONFIRMED",
    proof_type: "solana_memo",
    payment_proof: {
      recipient_manifest: [{ wallet: OTHER, amount_lamports: "1000", private_note: "private" }],
    },
    internal_id: "private",
  }],
  publication: { proof_type: "solana_memo", private_note: "private" },
  reviews: [{ public_rationale: "Public rationale", private_note: "private" }],
  summary: "Public-safe summary",
  support: [],
  title: "Public-safe title",
  uncertainties: "restricted uncertainties must not cross the public boundary",
  version_no: 1,
  version_public_ref: binding.version_public_ref,
  wire_report_public_ref: "OSI-WR-A1B2C3D4E5F6",
});
ok("public Wire DTO is an explicit allowlist that strips restricted body and nested private fields",
  publicDto.title === "Public-safe title"
    && publicDto.summary === "Public-safe summary"
    && publicDto.analysis === undefined
    && publicDto.uncertainties === undefined
    && publicDto.author.auth_uuid === undefined
    && publicDto.evidence[0].id === undefined
    && publicDto.reviews[0].private_note === undefined
    && publicDto.challenges[0].restricted_detail === undefined
    && publicDto.challenges[0].reviews[0].private_note === undefined
    && publicDto.proof_log[0].internal_id === undefined
    && publicDto.proof_log[0].payment_proof.recipient_manifest[0].wallet === OTHER
    && publicDto.proof_log[0].payment_proof.recipient_manifest[0].private_note === undefined
    && publicDto.publication.private_note === undefined);

const review = core.normalizeWireReview({
  version_public_ref: binding.version_public_ref,
  decision: "approve",
  reason_code: "wire_evidence_assessment",
  public_rationale: "The exact evidence manifest supports publication with the recorded limitations.",
  private_note: "Restricted analyst context remains outside every public DTO.",
});
ok("Wire reviews bind an exact version and the four accepted decisions",
  review.version_public_ref === binding.version_public_ref
    && core.WIRE_REVIEW_DECISIONS.size === 4
    && core.WIRE_REVIEW_DECISIONS.has("request_revision"));
await rejects("Wire review rejects an invented decision", () => Promise.resolve(
  core.normalizeWireReview({ ...review, decision: "publish" }),
), /decision/);
const reviewBinding = {
  purpose: "WIRE_REPORT_REVIEW_CAST",
  version_public_ref: binding.version_public_ref,
  actor_wallet: OTHER,
  actor_role: "analyst",
  decision: "approve",
  nonce: "q".repeat(43),
  payload_hash: "b".repeat(64),
  issued_at: NOW,
  expires_at: NOW + 120,
};
const reviewMessage = core.canonicalWireGovernanceMessage(reviewBinding);
ok("Wire review signMessage binds purpose target actor decision nonce and payload",
  core.validateWireGovernanceBinding(reviewMessage, reviewBinding, NOW + 10).ok === true);
const publicationBinding = {
  ...reviewBinding,
  purpose: core.WIRE_PUBLICATION_EVENT_TYPE,
  actor_role: "maintainer",
  decision: "publish",
};
ok("Wire publication Memo accepts the explicitly labeled maintainer actor path",
  core.parseWireGovernanceMessage(core.canonicalWireGovernanceMessage(publicationBinding))?.actor_role === "maintainer");
ok("Wire governance target parser keeps challenge and promotion targets typed",
  core.validateWireGovernanceTargetRef("wire_promote", binding.version_public_ref) === binding.version_public_ref
    && core.validateWireGovernanceTargetRef("challenge_finalize", "OSI-CHL-A1B2C3D4E5F60718") === "OSI-CHL-A1B2C3D4E5F60718");
const challengePayload = core.normalizeWireGovernancePayload("challenge_submit", {
  reason_code: "material_evidence_challenge",
  public_safe_summary: "The exact published evidence needs independent review.",
  restricted_detail: null,
  evidence_ordinal: 1,
  evidence_sha256: "c".repeat(64),
});
ok("Wire challenges bind public evidence coordinates without exposing its UUID",
  challengePayload.evidence_ordinal === 1
    && challengePayload.evidence_sha256 === "c".repeat(64)
    && challengePayload.evidence_item_id === undefined);
await rejects("Wire promotion accepts no client-derived Case payload", () => Promise.resolve(
  core.normalizeWireGovernancePayload("wire_promote", { title: "invented" }),
), /invalid|payload/i);

const gateway = readFileSync(new URL("../supabase/functions/osi-v2-wire/index.ts", import.meta.url), "utf8");
const wireUi = readFileSync(new URL("../assets/js/v2-wire-integration.js", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260718120000_osi_v2_wire_phase1.sql", import.meta.url), "utf8");
const phase2 = readFileSync(new URL("../supabase/migrations/20260718130000_osi_v2_wire_phase2.sql", import.meta.url), "utf8");
const queueCardUi = wireUi.slice(
  wireUi.indexOf("function queueCard("),
  wireUi.indexOf("async function loadWireQueueData("),
);
const publishWireUi = wireUi.slice(
  wireUi.indexOf("async function publishWire("),
  wireUi.indexOf("function queueCard("),
);
const bootstrapUnavailableReason = loadNamedFunction(
  wireUi,
  "wireBootstrapUnavailableReason",
);
ok("Wire maintainer bootstrap requires the exact item capability while standard analyst publication remains independent",
  queueCardUi.includes(
    "bootstrapReady=caps.maintainer_access===true&&item.can_publish_via_maintainer_bootstrap===true",
  )
    && queueCardUi.includes("standardReady=caps.analyst_eligible===true")
    && queueCardUi.includes("(standardReady||bootstrapReady)")
    && !queueCardUi.includes("bootstrapCheck=caps.maintainer_access===true"));
ok("Wire publication action rechecks the exact queued item and fails closed before prepare",
  publishWireUi.includes(
    "state.queue.find(function(row){return row&&row.version_public_ref===versionRef;})",
  )
    && publishWireUi.includes(
      "bootstrapReady=caps.maintainer_access===true&&item&&item.can_publish_via_maintainer_bootstrap===true",
    )
    && publishWireUi.includes("(!standardReady&&!bootstrapReady)")
    && publishWireUi.indexOf("(!standardReady&&!bootstrapReady)")
      < publishWireUi.indexOf("prepare_wire_publication"));
ok("Wire bootstrap absence has an honest exact-item reason instead of implying authorization",
  bootstrapUnavailableReason({}, true)
    === "Maintainer bootstrap is unavailable for this exact Wire version because the server did not explicitly authorize it."
    && bootstrapUnavailableReason({
      maintainer_bootstrap_reason_code: "bootstrap_support_not_met",
    }, true).includes("bootstrap support not met")
    && bootstrapUnavailableReason({}, false) === ""
    && queueCardUi.includes("esc(publicationUnavailable)"));
ok("Wire gateway fails closed on its exact flag before every write family",
  (gateway.match(/if \(!await wireWritesEnabled\(\)\)/g) || []).length >= 6
    && gateway.includes('data?.[0]?.value === "true"'));
ok("Wire capabilities expose the independent payment gate for honest support controls",
  gateway.includes('configEnabled("OSI_V2_PAYMENT_WRITES_ENABLED")')
    && gateway.includes("support_enabled: enabled && paymentEnabled"));
ok("Wire gateway exposes only explicit public list and detail operations",
  gateway.includes('case "list_public_wire_reports"')
    && gateway.includes('case "get_public_wire_report"')
    && !gateway.includes('select("*")'));
const publicListGateway = gateway.slice(
  gateway.indexOf("async function listPublicWireReports("),
  gateway.indexOf("async function getPublicWireReport("),
);
const publicDetailGateway = gateway.slice(
  gateway.indexOf("async function getPublicWireReport("),
  gateway.indexOf("async function listWireReviewQueue("),
);
const queueGateway = gateway.slice(
  gateway.indexOf("async function listWireReviewQueue("),
  gateway.indexOf("function wireGovernanceBinding("),
);
ok("JSONB list and restricted queue RPC results preserve their exact response shapes while public detail is sanitized",
  publicListGateway.includes("const reports = data;")
    && publicListGateway.includes("Array.isArray(reports)")
    && publicDetailGateway.includes("publicWireReportDto(data)")
    && queueGateway.includes("const reports = data;")
    && !gateway.includes("scalarJson"));
ok("public Wire UI never renders the restricted analysis or uncertainties fields",
  !wireUi.slice(wireUi.indexOf("function overviewTab("), wireUi.indexOf("function evidenceTab(")).includes("item.analysis")
    && !wireUi.slice(wireUi.indexOf("function overviewTab("), wireUi.indexOf("function evidenceTab(")).includes("item.uncertainties")
    && wireUi.includes("Restricted analysis and uncertainties remain private"));
ok("Wire dates follow the selected product locale instead of the browser locale",
  wireUi.includes("window.OSI_I18N")
    && wireUi.includes("'tr-TR':'en-US'")
    && wireUi.includes("date.toLocaleString(locale,"));
ok("private Wire reads require the dedicated shared session scopes",
  gateway.includes("READ_SESSION_SCOPES.WIRE_MINE")
    && gateway.includes("READ_SESSION_SCOPES.WIRE_QUEUE")
    && gateway.includes("verifyReadSessionToken"));
const intakeGateway = gateway.slice(
  gateway.indexOf("async function prepareWire("),
  gateway.indexOf("async function verifyReadSession("),
);
ok("private intake responses do not expose internal receipt UUIDs",
  !intakeGateway.includes("receipt_id:"));
ok("database RPCs are service-only and browser roles are revoked",
  migration.includes("Wire prepare is service-only")
    && migration.includes("Wire commit is service-only")
    && migration.includes("from public, anon, authenticated"));
ok("Wire commit atomically creates receipt version evidence and current pointer",
  /osi_v2_commit_wire_version[\s\S]*insert into public\.event_receipts[\s\S]*update public\.osi_nonces[\s\S]*insert into public\.wire_report_versions[\s\S]*insert into public\.wire_report_version_evidence[\s\S]*update public\.wire_reports/i.test(migration));
ok("Wire intake cannot advance publication or Case state",
  migration.includes("current_published_version_id")
    && !/set\s+current_published_version_id\s*=/i.test(migration)
    && !/update\s+public\.cases/i.test(migration));
ok("Phase 2 publication has exact normal count and weight defaults",
  phase2.includes("('OSI_V2_WIRE_STANDARD_MIN_COUNT', '2'")
    && phase2.includes("('OSI_V2_WIRE_STANDARD_MIN_WEIGHT', '2.00'")
    && phase2.includes("current_published_version_id = version_row.id"));
ok("Wire self-review and bootstrap self-publication are database denials",
  phase2.includes("Wire author cannot review this Wire version")
    && (phase2.match(/p_actor_wallet = report_row\.author_wallet/g) || []).length >= 2);
const bootstrapSupport = phase2.slice(
  phase2.indexOf("create function osi_private.osi_v2_wire_bootstrap_support("),
  phase2.indexOf("create function osi_private.osi_v2_prepare_wire_publication("),
);
ok("Wire bootstrap support counts only exact verified native review receipts",
  bootstrapSupport.includes("join public.event_receipts as receipt")
    && bootstrapSupport.includes("receipt.event_version = 'OSI2'")
    && bootstrapSupport.includes("receipt.server_verified = true")
    && bootstrapSupport.includes("review.public_ref is not null"));
ok("challenge finalization cannot select the bootstrap decision channel",
  phase2.includes("Bootstrap channel is unreachable for Wire challenges and promotion")
    && phase2.includes("binding->>'decision_channel' is distinct from 'standard'"));
ok("accepted challenges preserve publication and add an under-re-review marker",
  /challenge_quorum\.outcome = 'accept'[\s\S]*set contested_at = p_occurred_at/i.test(phase2)
    && phase2.includes("challenge_quorum.outcome = 'accept' and version_row.contested_at is null")
    && !/challenge_quorum\.outcome = 'accept'[\s\S]{0,500}current_published_version_id\s*=\s*null/i.test(phase2));
ok("Wire challenges accept only currently public approved linked evidence",
  (phase2.match(/evidence_row\.is_public is distinct from true/g) || []).length >= 2
    && (phase2.match(/evidence_row\.moderation_state <> 'approved'/g) || []).length >= 2);
ok("promotion creates a private initial-review Case without reward",
  /insert into public\.cases[\s\S]*null, bound\.actor_wallet, 'initial_review', 'private'/i.test(phase2)
    && phase2.includes("'kind', 'wire_report_version'")
    && phase2.includes("case_ref := 'OSI-' || upper(substr(replace(case_id::text, '-', ''), 1, 12))"));
ok("publication is the exact evidence visibility boundary",
  /update public\.evidence_items as evidence[\s\S]*set moderation_state = 'approved', is_public = true/i.test(phase2)
    && (phase2.match(/evidence\.is_public = true[\s\S]{0,100}evidence\.moderation_state = 'approved'/g) || []).length >= 2);
ok("public Wire history keeps superseded exact publications discoverable",
  /version\.lifecycle_state in \('published', 'superseded'\)/i.test(phase2)
    && phase2.includes("'is_current_published', report.current_published_version_id = version.id"));
ok("Wire support finalization rechecks both flags and the current author target",
  /create or replace function public\.osi_v2_guard_support_event\(\)[\s\S]*osi_v2_wire_writes_enabled\(\)[\s\S]*osi_v2_payment_writes_enabled\(\)/i.test(phase2)
    && phase2.includes("Wire and payment writes must both be enabled")
    && phase2.includes("Wire support requires the exact current published author target")
    && phase2.includes("report.current_published_version_id = version.id"));
ok("Wire-targeted lazy challenge expiry also fails closed on the dedicated flag",
  /create or replace function osi_private\.osi_v2_expire_due_challenges[\s\S]*challenge\.wire_report_version_id is null[\s\S]*osi_v2_wire_writes_enabled\(\) is true/i.test(phase2)
    && gateway.includes('action.startsWith("challenge_") && !await expireDueChallenges()'));
ok("public Wire Proof Logs use explicit event and support-receipt allowlists",
  (phase2.match(/receipt\.event_type in \([\s\S]*?'WIRE_REPORT_VERSION_SUBMITTED'[\s\S]*?'WIRE_PROMOTED'[\s\S]*?\)/g) || []).length >= 2
    && (phase2.match(/support\.id::text = receipt\.target_id/g) || []).length >= 2
    && (phase2.match(/profile\.verified = true[\s\S]*?profile\.approved = true/g) || []).length >= 4);

console.log(`\n${passed} native Wire Phase 1 and Phase 2 checks passed.`);
