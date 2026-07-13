// Dependency-free regression tests for the native V2 Case lifecycle helpers.
// Run: node tests/osi-v2-case-write.test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const core = await import(
  new URL("../supabase/functions/_shared/osi-v2-case-write-core.mjs", import.meta.url)
);

let pass = 0;
let fail = 0;
function ok(name, condition, detail = "") {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error("FAIL " + name + (detail ? " :: " + detail : ""));
}
function throws(name, fn, pattern) {
  try { fn(); ok(name, false, "did not throw"); }
  catch (error) { ok(name, pattern.test(String(error?.message ?? error)), String(error)); }
}

const WALLET = "11111111111111111111111111111111";
const PUBLIC_REF = "OSI-A1B2C3D4E5F6";
const TX_SIG = "2".repeat(88);
const NOW = 1_800_000_000;
const binding = {
  purpose: "CASE_SUBMITTED",
  public_ref: PUBLIC_REF,
  actor_wallet: WALLET,
  actor_role: "owner",
  decision: "submit",
  nonce: "n".repeat(43),
  payload_hash: "a".repeat(64),
  issued_at: NOW,
  expires_at: NOW + 120,
};

const message = core.canonicalCaseEventMessage(binding);
ok("canonical OSI2 Case message has exact grammar",
  message === [
    "OSI2", "1", "CASE_SUBMITTED", "t=case", "id=" + PUBLIC_REF,
    "a=" + WALLET, "r=owner", "d=submit", "n=" + "n".repeat(43),
    "h=" + "a".repeat(64), "ts=" + NOW, "exp=" + (NOW + 120),
  ].join("|"));
ok("canonical message parses and round-trips",
  core.parseCaseEventMessage(message)?.public_ref === PUBLIC_REF);
ok("exact Case message binding passes",
  core.validateCaseEventBinding(message, binding, NOW + 10).ok === true);
ok("wrong purpose is rejected",
  core.validateCaseEventBinding(message, { ...binding, purpose: "CASE_OPENED" }, NOW + 10).reason
    === "wrong_purpose");
ok("expired event is rejected",
  core.validateCaseEventBinding(message, binding, NOW + 121).reason === "expired");
ok("message tampering is rejected",
  core.validateCaseEventBinding(
    message.replace("d=submit", "d=open"), binding, NOW + 10,
  ).reason === "wrong_decision");

const validPayload = {
  title: "Neutral wallet incident review",
  category: "wallet_drain",
  summary_public: "A wallet reported an unexpected transfer pattern for community review.",
  details_restricted: "The owner supplied transaction references and timing context for authorized reviewers.",
  reward_intent_lamports: 1_000_000_000,
  evidence: [
    { kind: "wallet", ref: WALLET },
    { kind: "onchain_tx", ref: "2".repeat(88) },
    { kind: "url", ref: "https://solscan.io/tx/" + "2".repeat(88) },
  ],
};
const normalized = core.normalizeCasePayload(validPayload);
ok("valid Case payload is normalized", normalized.title === validPayload.title
  && normalized.evidence.length === 3);
throws("secret material language is blocked server-side", () => core.normalizeCasePayload({
  ...validPayload,
  details_restricted: "Here is my seed phrase and recovery phrase for the wallet incident.",
}), /prohibited_secret_material/);
throws("non-HTTPS evidence is blocked", () => core.normalizeCasePayload({
  ...validPayload,
  evidence: [{ kind: "url", ref: "http://example.com/evidence" }],
}), /evidence URL/);
throws("duplicate evidence is blocked", () => core.normalizeCasePayload({
  ...validPayload,
  evidence: [
    { kind: "wallet", ref: WALLET },
    { kind: "wallet", ref: WALLET },
  ],
}), /duplicate/);
throws("invalid category is blocked", () => core.normalizeCasePayload({
  ...validPayload, category: "guilty_party",
}), /category/);
throws("oversized reward intent is blocked", () => core.normalizeCasePayload({
  ...validPayload, reward_intent_lamports: Number.MAX_SAFE_INTEGER,
}), /reward intent/);

ok("review input allows canonical decision/reason", core.normalizeReviewInput({
  case_ref: PUBLIC_REF, decision: "approve_open", reason_code: "public_scope_clear",
}).decision === "approve_open");
throws("initial rejection stays disabled until its quorum outcome exists", () => core.normalizeReviewInput({
  case_ref: PUBLIC_REF, decision: "reject", reason_code: "unsafe_or_prohibited",
}), /decision/);
throws("review reason is a server allow-list", () => core.normalizeReviewInput({
  case_ref: PUBLIC_REF, decision: "approve_open", reason_code: "free form private note",
}), /reason code/);

const txFixture = {
  blockTime: NOW + 15,
  meta: { err: null },
  transaction: {
    signatures: [TX_SIG],
    message: {
      accountKeys: [{ pubkey: WALLET, signer: true, writable: true }],
      instructions: [{
        program: "spl-memo",
        programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        parsed: message,
      }],
    },
  },
};
const confirmed = { err: null, confirmationStatus: "confirmed" };
ok("confirmed exact signer+memo transaction verifies",
  core.validateConfirmedMemoTransaction(txFixture, confirmed, {
    tx_sig: TX_SIG, wallet: WALLET, memo: message,
    issued_at: NOW, expires_at: NOW + 120,
  }).ok === true);
ok("wrong transaction signer is rejected",
  core.validateConfirmedMemoTransaction(txFixture, confirmed, {
    tx_sig: TX_SIG, wallet: "11111111111111111111111111111112", memo: message,
    issued_at: NOW, expires_at: NOW + 120,
  }).reason === "wrong_signer");
ok("unconfirmed transaction is rejected",
  core.validateConfirmedMemoTransaction(txFixture, { err: null, confirmationStatus: "processed" }, {
    tx_sig: TX_SIG, wallet: WALLET, memo: message,
    issued_at: NOW, expires_at: NOW + 120,
  }).reason === "transaction_not_confirmed");
ok("wrong memo is rejected",
  core.validateConfirmedMemoTransaction(txFixture, confirmed, {
    tx_sig: TX_SIG, wallet: WALLET, memo: message + "x",
    issued_at: NOW, expires_at: NOW + 120,
  }).reason === "wrong_memo");

ok("full maintainer requires both independent gates",
  core.maintainerGate(true, WALLET, WALLET).ok === true
    && core.maintainerGate(false, WALLET, WALLET).reason === "half_maintainer_wallet_only"
    && core.maintainerGate(true, WALLET, "11111111111111111111111111111112").reason
      === "half_maintainer_auth_only");

const edgeSource = readFileSync(
  join(root, "supabase", "functions", "osi-v2-case-write", "index.ts"), "utf8",
);
ok("Case Edge Function never selects broad star", !edgeSource.includes('select("*")'));
ok("Case Edge Function uses only the Case-specific write flag",
  edgeSource.includes("OSI_V2_CASE_WRITES_ENABLED")
    && !edgeSource.includes("OSI_V2_WRITES_ENABLED")
    && !edgeSource.includes("OSI_V2_PROOF_ENABLED"));
ok("all three native Case effects use service-only RPCs",
  edgeSource.includes('rpc("osi_v2_commit_case_submission"')
    && edgeSource.includes('rpc("osi_v2_commit_case_review"')
    && edgeSource.includes('rpc("osi_v2_commit_case_open"'));
ok("maintainer auth UUID is explicit and fail-closed",
  edgeSource.includes("OSI_MAINTAINER_AUTH_UUID")
    && edgeSource.includes("data?.user?.id === MAINTAINER_AUTH_UUID"));
ok("Case gateway never logs payloads", !/console\.log/.test(edgeSource));

console.log((fail ? "FAILED: " + fail : "OK")
  + " (" + pass + " assertions passed, " + fail + " failed)");
process.exit(fail ? 1 : 0);
