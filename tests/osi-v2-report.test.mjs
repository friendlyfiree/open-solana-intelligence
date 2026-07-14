// Dependency-free regression tests for native Case Report intake and reads.
// Run: node tests/osi-v2-report.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const core = await import(
  new URL("../supabase/functions/_shared/osi-v2-report-core.mjs", import.meta.url)
);

let pass = 0;
let fail = 0;
function ok(name, condition, detail = "") {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error("FAIL " + name + (detail ? " :: " + detail : ""));
}
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
await rejects("Report requires evidence", () => core.normalizeReportPayload({
  ...validPayload, evidence: [],
}), /evidence/);
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
ok("public unpublished projection is empty",
  core.publicPublishedReports([{ current_published_version_id: null }]).length === 0);

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
const config = readFileSync(join(root, "supabase/config.toml"), "utf8");

ok("Report gateways never select broad star",
  !writeSource.includes('select("*")') && !readSource.includes('select("*")'));
ok("write gateway verifies exact mainnet genesis, Memo, signer, and confirmation",
  writeSource.includes("MAINNET_GENESIS_HASH")
    && writeSource.includes('method: "getGenesisHash"')
    && writeSource.includes("validateConfirmedReportTransaction"));
ok("prepare and commit both fail closed on the dedicated flag",
  (writeSource.match(/reportWritesEnabled\(\)/g) ?? []).length >= 3
    && migration.includes("osi_v2_report_writes_enabled() is distinct from true"));
ok("broad Case and proof flags are untouched by Report gateway",
  !writeSource.includes("OSI_V2_WRITES_ENABLED")
    && !writeSource.includes("OSI_V2_PROOF_ENABLED")
    && !writeSource.includes("OSI_V2_CASE_WRITES_ENABLED"));
ok("read gateway derives analyst eligibility and full maintainer double gate",
  readSource.includes("analystEligible")
    && readSource.includes("walletGate && authGate")
    && readSource.includes("half_maintainer_wallet_only")
    && readSource.includes("half_maintainer_auth_only"));
ok("read gateway has durable issue and consume RPCs but no domain writes",
  readSource.includes('rpc("osi_v2_issue_read_nonce"')
    && readSource.includes('rpc("osi_v2_consume_read_nonce"')
    && !/[.]insert\(|[.]update\(|[.]delete\(|[.]upsert\(/.test(readSource));
ok("database commit is one exact atomic function",
  /create function osi_private\.osi_v2_commit_report_version[\s\S]*insert into public\.event_receipts[\s\S]*update public\.osi_nonces[\s\S]*insert into public\.case_report_versions[\s\S]*update public\.case_reports/i.test(migration));
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
ok("Report functions use explicit custom authorization config",
  /\[functions\.osi-v2-report-write\][\s\S]*?verify_jwt\s*=\s*false/.test(config)
    && /\[functions\.osi-v2-report-read\][\s\S]*?verify_jwt\s*=\s*false/.test(config));
ok("My Reports and Report Queue are wired to real signed endpoints",
  html.includes("osiV2OpenMyReports()") && html.includes("osiV2OpenReportQueue()")
    && uiSource.includes("list_my_reports") && uiSource.includes("list_review_queue"));
ok("Report form provides exact prerequisite and transaction states",
  uiSource.includes("Preparing the exact Case, version, evidence manifest")
    && uiSource.includes("Approve the exact CASE_REPORT_VERSION_SUBMITTED Memo")
    && uiSource.includes("Confirming mainnet, signer, exact Memo"));
ok("untrusted Report content is escaped before innerHTML rendering",
  uiSource.includes("<p>'+esc(version.body_private)+'</p>")
    && uiSource.includes("esc(item.ref)"));
ok("legacy and preview pages never load the Report bundle",
  !readFileSync(join(root, "legacy.html"), "utf8").includes("v2-report-integration")
    && !readFileSync(join(root, "v2-preview.html"), "utf8").includes("v2-report-integration"));

console.log((fail ? "FAILED: " + fail : "OK")
  + " (" + pass + " assertions passed, " + fail + " failed)");
process.exit(fail ? 1 : 0);
