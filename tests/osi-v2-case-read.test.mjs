// Dependency-free regression tests for the OSI V2 read-only Case slice.
// Run: node tests/osi-v2-case-read.test.mjs   (exit 0 = pass)
//
// Covers, without a network or database:
//   - exact proof labels (legacy data can never earn a verified/on-chain label)
//   - the server-side authorization matrix (anonymous/owner/analyst/maintainer)
//   - read-challenge build/parse/binding: expiry, wrong purpose, wrong target,
//     wallet mismatch, tampering
//   - a full Ed25519 sign/verify round-trip over a real challenge string
//   - DTO minimization: no private/internal field can appear in a public DTO,
//     and a version body is returned only to its own author wallet
//   - stored-XSS escaping in the new V2 frontend renderer
//   - static no-mutation guarantee: the Edge Function source contains SELECT
//     access only (no insert/update/delete/upsert/rpc) and never enables the
//     V2 write/proof flags.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as edSign } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const core = await import(
  new URL("../supabase/functions/_shared/osi-v2-case-read-core.mjs", import.meta.url)
);
const proofCore = await import(
  new URL("../supabase/functions/_shared/osi-v2-proof-core.mjs", import.meta.url)
);

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error("FAIL " + name + (detail ? " :: " + detail : ""));
}

// ---------------------------------------------------------------------------
// Proof labels are exact and fail toward the legacy label.
// ---------------------------------------------------------------------------
const REAL_TX = "5".repeat(88);
ok("memo label requires server_verified AND a real tx_sig",
  core.proofLabel({ proof_type: "solana_memo", server_verified: true, tx_sig: REAL_TX })
    === "Memo-anchored on Solana");
ok("memo without tx_sig degrades to legacy label",
  core.proofLabel({ proof_type: "solana_memo", server_verified: true, tx_sig: null })
    === "Legacy / not server-verified");
ok("wallet-signed label requires server_verified=true",
  core.proofLabel({ proof_type: "wallet_signed_server_verified", server_verified: true })
    === "Wallet-signed & server-verified");
ok("system event label",
  core.proofLabel({ proof_type: "system_event", server_verified: true }) === "System event");
ok("legacy import is always the legacy label",
  core.proofLabel({ proof_type: "legacy_imported", server_verified: false, tx_sig: REAL_TX })
    === "Legacy / not server-verified");
ok("legacy import can NEVER be labeled on-chain even with a tx_sig",
  core.proofLabel({ proof_type: "legacy_imported", server_verified: false, tx_sig: REAL_TX })
    !== "Memo-anchored on Solana");
ok("unverified wallet-signed claim degrades to legacy label",
  core.proofLabel({ proof_type: "wallet_signed_server_verified", server_verified: false })
    === "Legacy / not server-verified");

// ---------------------------------------------------------------------------
// Authorization matrix.
// ---------------------------------------------------------------------------
const OWNER = "4" + "a".repeat(43);
const STRANGER = "5" + "b".repeat(43);
const privateDraft = { visibility: "private", stage: "draft", submitted_by_wallet: OWNER };
const publicOpen = { visibility: "public", stage: "open_public", submitted_by_wallet: OWNER };
const privateSubmitted = { visibility: "private", stage: "submitted", submitted_by_wallet: OWNER };

ok("anonymous reads a public Case", core.canActorReadCase({ kind: "anonymous" }, publicOpen));
ok("anonymous denied a private Case", !core.canActorReadCase({ kind: "anonymous" }, privateDraft));
ok("owner reads own private Case",
  core.canActorReadCase({ kind: "owner", wallet: OWNER }, privateDraft));
ok("wrong wallet denied a private Case",
  !core.canActorReadCase({ kind: "owner", wallet: STRANGER }, privateDraft));
ok("analyst denied a private draft",
  !core.canActorReadCase({ kind: "analyst", wallet: STRANGER }, privateDraft));
ok("analyst reads a submitted (in-governance) Case",
  core.canActorReadCase({ kind: "analyst", wallet: STRANGER }, privateSubmitted));
ok("maintainer reads a private draft",
  core.canActorReadCase({ kind: "maintainer" }, privateDraft));
ok("null case denied", !core.canActorReadCase({ kind: "maintainer" }, null));
ok("public stage set mirrors the schema check",
  core.PUBLIC_CASE_STAGES.has("sealed") && !core.PUBLIC_CASE_STAGES.has("draft")
    && !core.PUBLIC_CASE_STAGES.has("submitted"));

// ---------------------------------------------------------------------------
// Challenge build/parse/binding.
// ---------------------------------------------------------------------------
const NOW = 1_800_000_000;
const FIELDS = {
  purpose: "CASE_READ_MY_CASES",
  target_type: "wallet_cases",
  target_id: OWNER,
  wallet: OWNER,
  nonce: "n".repeat(43),
  issued_at: NOW,
  expires_at: NOW + 120,
};
const MAC = "ab".repeat(32);
const challenge = core.buildChallenge(FIELDS, MAC);
const parsed = core.parseChallenge(challenge);
ok("challenge round-trips", !!parsed && parsed.purpose === FIELDS.purpose
  && parsed.wallet === OWNER && parsed.nonce === FIELDS.nonce && parsed.hmac === MAC
  && parsed.issued_at === NOW && parsed.expires_at === NOW + 120);
ok("tampered challenge fails parse (extra segment)",
  core.parseChallenge(challenge + "|x=1") === null);
ok("truncated challenge fails parse",
  core.parseChallenge(challenge.split("|").slice(0, 9).join("|")) === null);
ok("bad purpose fails parse",
  core.parseChallenge(challenge.replace("CASE_READ_MY_CASES", "CASE_WRITE_ANYTHING")) === null);

const expected = { purpose: FIELDS.purpose, target_type: FIELDS.target_type, target_id: FIELDS.target_id, wallet: OWNER };
ok("valid binding accepted",
  core.validateChallengeBinding(parsed, expected, NOW + 10).ok === true);
ok("expired challenge rejected",
  core.validateChallengeBinding(parsed, expected, NOW + 121).reason === "expired");
ok("wrong purpose rejected",
  core.validateChallengeBinding(parsed, { ...expected, purpose: "CASE_READ_MAINTAINER_OVERVIEW" }, NOW + 10).reason === "wrong_purpose");
ok("wrong target rejected",
  core.validateChallengeBinding(parsed, { ...expected, target_id: STRANGER }, NOW + 10).reason === "wrong_target");
ok("wallet mismatch rejected",
  core.validateChallengeBinding(parsed, { ...expected, wallet: STRANGER }, NOW + 10).reason === "wallet_mismatch");
const longTtl = core.parseChallenge(core.buildChallenge({ ...FIELDS, expires_at: NOW + 301 }, MAC));
ok("over-long TTL rejected even before expiry",
  core.validateChallengeBinding(longTtl, expected, NOW + 10).reason === "bad_expiry");

// ---------------------------------------------------------------------------
// Full Ed25519 round-trip over a challenge string (same verifier the Edge
// Function uses). Wrong-wallet and tampered-message verification must fail.
// ---------------------------------------------------------------------------
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
const testWallet = base58Encode(rawPub);
if (testWallet.length >= 32 && testWallet.length <= 44) {
  const signFields = { ...FIELDS, wallet: testWallet, target_id: testWallet };
  const signChallenge = core.buildChallenge(signFields, MAC);
  const signature = edSign(null, Buffer.from(signChallenge, "utf8"), privateKey).toString("base64");
  ok("genuine signature verifies",
    await proofCore.verifyEd25519Signature(signChallenge, signature, testWallet));
  ok("signature fails for a different wallet",
    !(await proofCore.verifyEd25519Signature(signChallenge, signature, OWNER)));
  ok("signature fails for a tampered challenge",
    !(await proofCore.verifyEd25519Signature(signChallenge + "x", signature, testWallet)));
} else {
  ok("generated test wallet has base58 length 32-44 (rare edge skipped)", true);
}

// ---------------------------------------------------------------------------
// DTO minimization.
// ---------------------------------------------------------------------------
const caseRow = {
  id: "11111111-1111-1111-1111-111111111111",
  public_ref: "OSI-TESTREF000000001",
  title: "Fixture case",
  category: "legacy_import",
  summary_public: "Public-safe summary",
  submitted_by_wallet: OWNER,
  stage: "open_public",
  visibility: "public",
  risk_tier: "standard",
  sealed_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};
const report = {
  id: "22222222-2222-2222-2222-222222222222",
  case_id: caseRow.id,
  author_wallet: STRANGER,
  current_version_id: "33333333-3333-3333-3333-333333333333",
  current_published_version_id: null,
  status: "active",
  created_at: "2026-01-03T00:00:00Z",
};
const version = {
  id: "33333333-3333-3333-3333-333333333333",
  report_id: report.id,
  version_no: 1,
  created_by_wallet: STRANGER,
  body_private: "SECRET private findings body",
  content_public_safe: null,
  evidence_snapshot_hash: "e".repeat(64),
  lifecycle_state: "submitted",
  published_at: null,
  created_at: "2026-01-03T00:00:00Z",
};
const receipt = {
  event_type: "LEGACY_CASE_OPENED",
  target_type: "case",
  target_id: caseRow.public_ref,
  proof_type: "legacy_imported",
  memo_ref: "legacy memo text",
  tx_sig: REAL_TX,
  server_verified: false,
  occurred_at: "2026-01-04T00:00:00Z",
};

const pub = core.publicCaseDto(caseRow, [report], { [report.id]: [version] }, [receipt]);
const pubLeaks = core.collectForbiddenKeys(pub);
ok("public DTO leaks no forbidden key", pubLeaks.size === 0, [...pubLeaks].join(","));
ok("public DTO never contains the private body or any wallet",
  !JSON.stringify(pub).includes("SECRET") && !JSON.stringify(pub).includes(OWNER)
    && !JSON.stringify(pub).includes(STRANGER));
ok("public DTO keeps the exact legacy label",
  pub.proof_log[0].label === "Legacy / not server-verified");

const ownerView = core.authorizedCaseDto(caseRow, [report], { [report.id]: [version] }, [receipt],
  { kind: "owner", wallet: OWNER });
ok("case owner does NOT receive another author's private body",
  !JSON.stringify(ownerView).includes("SECRET"));
ok("case owner sees version metadata (length, hash, state)",
  ownerView.reports[0].versions[0].body_length === version.body_private.length
    && ownerView.reports[0].versions[0].lifecycle_state === "submitted");

const authorView = core.authorizedCaseDto(caseRow, [report], { [report.id]: [version] }, [receipt],
  { kind: "owner", wallet: STRANGER });
ok("the version author receives their own private body",
  authorView.reports[0].versions[0].body_private === version.body_private);

const overview = core.maintainerOverviewDto({
  cases: [caseRow],
  reportsByCase: { [caseRow.id]: [report] },
  versionsByReport: { [report.id]: [version] },
  receiptsByCaseTarget: { [caseRow.public_ref]: [receipt] },
  receiptTotals: { "Legacy / not server-verified": 1 },
  crosswalkCount: 43,
  manualQueueCount: 14,
  flags: { OSI_V2_WRITES_ENABLED: "false", OSI_V2_PROOF_ENABLED: "false" },
});
ok("maintainer overview never contains a private body",
  !JSON.stringify(overview).includes("SECRET"));
ok("maintainer overview reports both flags verbatim",
  overview.flags.OSI_V2_WRITES_ENABLED === "false" && overview.flags.OSI_V2_PROOF_ENABLED === "false");

// ---------------------------------------------------------------------------
// Stored-XSS escaping in the V2 frontend renderer.
// ---------------------------------------------------------------------------
const appSource = readFileSync(join(root, "assets/js/v2-case-app.js"), "utf8");
function loadFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error(name + " not found");
  let i = src.indexOf("{", start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return (0, eval)("(" + src.slice(start, end).replace("function " + name, "function") + ")");
}
const escapeHtml = loadFn(appSource, "escapeHtml");
ok("v2 escapeHtml neutralises all five significant characters",
  escapeHtml("<>&\"'") === "&lt;&gt;&amp;&quot;&#39;");
ok("v2 escapeHtml neutralises a script payload",
  !escapeHtml("</script><img src=x onerror=alert(1)>").includes("<"));

// ---------------------------------------------------------------------------
// Static guarantees on the Edge Function source: SELECT-only, no flag writes,
// wired to the correct minimal columns, verify_jwt declared in config.
// ---------------------------------------------------------------------------
const fnSource = readFileSync(join(root, "supabase/functions/osi-v2-case-read/index.ts"), "utf8");
// The in-memory replay cache is a Map — its .delete() is not a DB mutation.
const dbSource = fnSource.split("\n").filter((line) => !line.includes("consumedNonces")).join("\n");
for (const forbidden of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
  ok("edge function performs no mutation call: " + forbidden, !dbSource.includes(forbidden));
}
ok("edge function never writes the V2 flags",
  !/OSI_V2_(WRITES|PROOF)_ENABLED'?\s*[,)]?\s*(=|value)/.test(fnSource)
    || !/\.(update|insert|upsert)\(/.test(fnSource));
ok("edge function never selects broad *", !fnSource.includes('select("*")'));
ok("service role key is never in a response",
  !fnSource.includes("SERVICE_ROLE_KEY") || !fnSource.match(/jsonResponse\([^)]*SERVICE_ROLE_KEY/));
const configToml = readFileSync(join(root, "supabase/config.toml"), "utf8");
ok("config.toml declares explicit auth for osi-v2-case-read",
  /\[functions\.osi-v2-case-read\][\s\S]*?verify_jwt\s*=\s*false/.test(configToml));

// The classic app source never logs API payloads and never touches the
// service key; the only key literal allowed is the publishable config global.
ok("v2 app never console.logs API data", !/console\.log/.test(appSource));
ok("v2 app holds no service-role literal", !/service_role|SERVICE_ROLE/i.test(appSource));

console.log((fail ? "FAILED: " + fail : "OK") + " (" + pass + " assertions passed, " + fail + " failed)");
process.exit(fail ? 1 : 0);
