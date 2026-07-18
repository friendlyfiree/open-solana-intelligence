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
  ...validPayload, title_public_safe: "short",
}), /title/i);
await rejects("Wire requires an explicit uncertainty statement", () => core.normalizeWirePayload({
  ...validPayload, uncertainties_private: "unknown",
}), /uncertainties/i);
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

const gateway = readFileSync(new URL("../supabase/functions/osi-v2-wire/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260718120000_osi_v2_wire_phase1.sql", import.meta.url), "utf8");
ok("Wire gateway fails closed on its exact flag before both write operations",
  (gateway.match(/if \(!await wireWritesEnabled\(\)\)/g) || []).length >= 2
    && gateway.includes('data?.[0]?.value === "true"'));
ok("Wire gateway has no public list operation in Phase 1",
  !gateway.includes("list_public_wire") && gateway.includes('case "list_my_wire_reports"'));
ok("private Wire reads require the dedicated shared session scope",
  gateway.includes("READ_SESSION_SCOPES.WIRE_MINE")
    && gateway.includes("verifyReadSessionToken"));
ok("Wire responses do not expose internal receipt UUIDs",
  !gateway.includes("receipt_id: issued.consumed_receipt_id")
    && !gateway.includes("receipt_id: committed.receipt_id"));
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

console.log(`\n${passed} native Wire Phase 1 checks passed.`);
