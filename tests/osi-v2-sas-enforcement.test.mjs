// Behavioral tests for the D19 SAS credential enforcement decision core, plus
// structural regression tests for the migration, the rollout workflow and the
// Edge wiring that makes enforcement real.
//
// The on-chain side is mocked at the account-bytes level: every "verified",
// "expired", "invalid" and "absent" case below is decided by the same
// evaluateAttestation the production verifier calls, not by string matching.
//
// Run: node tests/osi-v2-sas-enforcement.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const core = await import(
  new URL("../supabase/functions/_shared/osi-v2-sas-core.mjs", import.meta.url)
);

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

let pass = 0;
let fail = 0;
function ok(name, condition, detail = "") {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error("FAIL " + name + (detail ? " :: " + detail : ""));
}

// ---------------------------------------------------------------------------
// Mocked on-chain attestation accounts
// ---------------------------------------------------------------------------
const CRED = "11111111111111111111111111111111";
const SCHEMA = "So11111111111111111111111111111111111111112";
const ISSUER = "SysvarC1ock11111111111111111111111111111111";
const OTHER_ISSUER = "SysvarRent111111111111111111111111111111111";
const WALLET_A = "So11111111111111111111111111111111111111112";
const WALLET_B = "SysvarC1ock11111111111111111111111111111111";
const WALLET_C = "SysvarRent111111111111111111111111111111111";
const PROGRAM = core.SAS_PROGRAM_ID;
const EXPECTED = { programId: PROGRAM, credential: CRED, schema: SCHEMA, issuer: ISSUER };
const NOW = 1_800_000_000;

function le32(n) {
  return Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}
function le64(value) {
  const out = new Uint8Array(8);
  let v = BigInt(value);
  if (v < 0n) v += 1n << 64n;
  for (let i = 0; i < 8; i += 1) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
function attestationAccount({ credential, schema, signer, expiry }) {
  const body = Uint8Array.from([7, 7]);
  const parts = [
    Uint8Array.from([0]),
    core.base58Decode(credential), // nonce slot
    core.base58Decode(credential),
    core.base58Decode(schema),
    le32(body.length), body,
    core.base58Decode(signer),
    le64(expiry),
    core.base58Decode(credential), // token account slot
  ];
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return { found: true, ownerProgram: PROGRAM, data: out };
}

// A live verification result shaped exactly like verifyWalletLive returns.
function liveFor(account) {
  if (account === "rpc_failure") {
    return {
      status: { state: "pending_verification", valid: false, reason: "rpc_unavailable", expiry: null },
      rpcFailed: true,
    };
  }
  return {
    status: core.evaluateAttestation(account, EXPECTED, NOW),
    rpcFailed: false,
  };
}

const VERIFIED_ACCOUNT = attestationAccount({
  credential: CRED, schema: SCHEMA, signer: ISSUER, expiry: NOW + 86_400,
});
const EXPIRED_ACCOUNT = attestationAccount({
  credential: CRED, schema: SCHEMA, signer: ISSUER, expiry: NOW - 60,
});
const WRONG_ISSUER_ACCOUNT = attestationAccount({
  credential: CRED, schema: SCHEMA, signer: OTHER_ISSUER, expiry: NOW + 86_400,
});
const ABSENT_ACCOUNT = { found: false };

// ---------------------------------------------------------------------------
// 1. A live credential decides authority, and only a live one does
// ---------------------------------------------------------------------------
ok("verified credential counts",
  core.recheckStateFor(liveFor(VERIFIED_ACCOUNT)).counts === true);
ok("verified credential records the verified snapshot state",
  core.recheckStateFor(liveFor(VERIFIED_ACCOUNT)).state === core.SAS_STATE.VERIFIED);

ok("absent credential contributes zero",
  core.recheckStateFor(liveFor(ABSENT_ACCOUNT)).counts === false);
ok("absent credential is labeled invalid, not silently dropped",
  core.recheckStateFor(liveFor(ABSENT_ACCOUNT)).state === core.SAS_STATE.INVALID);
ok("absent credential carries the honest reason",
  core.evaluateAttestation(ABSENT_ACCOUNT, EXPECTED, NOW).reason === "absent");

ok("expired credential contributes zero",
  core.recheckStateFor(liveFor(EXPIRED_ACCOUNT)).counts === false);
ok("expired credential is labeled expired",
  core.recheckStateFor(liveFor(EXPIRED_ACCOUNT)).state === core.SAS_STATE.EXPIRED);

ok("credential from the wrong issuer contributes zero",
  core.recheckStateFor(liveFor(WRONG_ISSUER_ACCOUNT)).counts === false);
ok("wrong issuer is labeled invalid with an issuer_mismatch reason",
  core.evaluateAttestation(WRONG_ISSUER_ACCOUNT, EXPECTED, NOW).reason === "issuer_mismatch");

ok("an unreachable verifier never grants authority",
  core.recheckStateFor(liveFor("rpc_failure")).counts === false);
ok("an unreachable verifier records pending_verification, so it can be retried",
  core.recheckStateFor(liveFor("rpc_failure")).state === core.SAS_STATE.PENDING);

// ---------------------------------------------------------------------------
// 2. Flag OFF is exactly today's behavior (the tautology)
// ---------------------------------------------------------------------------
const ROWS = [
  { review_kind: "case_report", review_id: "11111111-1111-1111-1111-111111111111", reviewer_wallet: WALLET_A },
  { review_kind: "case_report", review_id: "22222222-2222-2222-2222-222222222222", reviewer_wallet: WALLET_A },
  { review_kind: "resolution", review_id: "33333333-3333-3333-3333-333333333333", reviewer_wallet: WALLET_B },
];
const CONFIGURED_ON = { enforcementEnabled: true, configured: true };
const CONFIGURED_OFF = { enforcementEnabled: false, configured: true };

ok("flag OFF performs no re-check at all",
  core.enforcementRecheckPlan({ settings: CONFIGURED_OFF, rows: ROWS }).skip === true);
ok("flag OFF reports enforcement_off as the reason",
  core.enforcementRecheckPlan({ settings: CONFIGURED_OFF, rows: ROWS }).reason === "enforcement_off");
ok("flag OFF plans zero on-chain reads",
  core.enforcementRecheckPlan({ settings: CONFIGURED_OFF, rows: ROWS }).batches.length === 0);
ok("absent settings fail closed to no re-check rather than throwing",
  core.enforcementRecheckPlan({ settings: null, rows: ROWS }).skip === true);

// ---------------------------------------------------------------------------
// 3. Flag ON plans one live read per distinct wallet, and is bounded
// ---------------------------------------------------------------------------
const planOn = core.enforcementRecheckPlan({ settings: CONFIGURED_ON, rows: ROWS });
ok("flag ON plans a re-check", planOn.skip === false);
ok("flag ON collapses a wallet's reviews into one live on-chain read",
  planOn.batches.length === 2, JSON.stringify(planOn.batches.map((b) => b.wallet)));
ok("every review of a wallet is recorded from that one read",
  planOn.batches.find((b) => b.wallet === WALLET_A)?.reviews.length === 2);
ok("the plan carries the exact review kind and id for each snapshot",
  planOn.batches.find((b) => b.wallet === WALLET_B)?.reviews[0].reviewKind === "resolution");

const manyRows = [WALLET_A, WALLET_B, WALLET_C].map((wallet, index) => ({
  review_kind: "case_report",
  review_id: "4444444" + index + "-4444-4444-4444-444444444444",
  reviewer_wallet: wallet,
}));
const bounded = core.enforcementRecheckPlan({ settings: CONFIGURED_ON, rows: manyRows, budget: 2 });
ok("the live read budget is bounded", bounded.batches.length === 2);
ok("truncation is reported rather than hidden", bounded.truncated === true);

ok("a malformed worklist row is dropped rather than trusted",
  core.enforcementRecheckPlan({
    settings: CONFIGURED_ON,
    rows: [{ review_kind: "case_report", review_id: "x", reviewer_wallet: "not-a-wallet" }],
  }).batches.length === 0);

// ---------------------------------------------------------------------------
// 4. Enforcement on but SAS unconfigured records nothing and grants nothing
// ---------------------------------------------------------------------------
const unconfigured = core.enforcementRecheckPlan({
  settings: { enforcementEnabled: true, configured: false }, rows: ROWS,
});
ok("unconfigured SAS never invents authority", unconfigured.skip === true);
ok("unconfigured SAS reports not_configured", unconfigured.reason === "not_configured");
ok("an unconfigured evaluation is invalid, not verified",
  core.evaluateAttestation(VERIFIED_ACCOUNT, { programId: PROGRAM }, NOW).state === core.SAS_STATE.INVALID);

// ---------------------------------------------------------------------------
// 5. Staleness: a cache never substitutes beyond the configured window
// ---------------------------------------------------------------------------
const NOW_MS = 1_800_000_000_000;
ok("a fresh cached verified answer may be reused",
  core.cacheAnswerUsable({
    state: "verified", checkedAt: NOW_MS - 60_000, nowMs: NOW_MS, staleSeconds: 900,
  }) === true);
ok("a cached answer past the staleness window is not usable",
  core.cacheAnswerUsable({
    state: "verified", checkedAt: NOW_MS - 901_000, nowMs: NOW_MS, staleSeconds: 900,
  }) === false);
ok("the boundary of the window is exclusive",
  core.cacheAnswerUsable({
    state: "verified", checkedAt: NOW_MS - 900_000, nowMs: NOW_MS, staleSeconds: 900,
  }) === false);
ok("a pending cached state is never usable, however fresh",
  core.cacheAnswerUsable({
    state: "pending_verification", checkedAt: NOW_MS, nowMs: NOW_MS, staleSeconds: 900,
  }) === false);
ok("an unchecked cached state is never usable",
  core.cacheAnswerUsable({
    state: "unchecked", checkedAt: NOW_MS, nowMs: NOW_MS, staleSeconds: 900,
  }) === false);
ok("a cache row with no timestamp is not an answer",
  core.cacheAnswerUsable({
    state: "verified", checkedAt: null, nowMs: NOW_MS, staleSeconds: 900,
  }) === false);
ok("a future-dated cache row is rejected rather than trusted",
  core.cacheAnswerUsable({
    state: "verified", checkedAt: NOW_MS + 60_000, nowMs: NOW_MS, staleSeconds: 900,
  }) === false);
ok("a cached invalid answer is still an answer inside the window",
  core.cacheAnswerUsable({
    state: "invalid", checkedAt: NOW_MS - 1000, nowMs: NOW_MS, staleSeconds: 900,
  }) === true);

// ---------------------------------------------------------------------------
// 6. Issuance failure never blocks analyst activation
// ---------------------------------------------------------------------------
ok("issuance is a no-op when SAS is unconfigured, never a throw",
  core.reconcileIssuance({
    settings: { issuanceEnabled: true, configured: false }, status: "verified_analyst",
  }).action === "noop_unconfigured");
ok("an unconfigured issuance reports not_configured rather than failing",
  core.reconcileIssuance({
    settings: { issuanceEnabled: true, configured: false }, status: "verified_analyst",
  }).reason === "not_configured");
ok("issuance disabled is also a no-op",
  core.reconcileIssuance({
    settings: { issuanceEnabled: false, configured: true }, status: "verified_analyst",
  }).action === "noop_unconfigured");
ok("absent settings do not throw during activation",
  core.reconcileIssuance({ settings: null, status: "probationary_analyst" }).action === "noop_unconfigured");

const issuerSource = read("supabase/functions/_shared/osi-v2-sas-issuer.ts");
ok("the issuer reconciliation path is wrapped so a failure cannot propagate",
  /try\s*\{/.test(issuerSource) && /catch/.test(issuerSource));
ok("issuance failure is recorded as a failed ledger entry, not raised",
  /osi_v2_sas_record_issuance/.test(issuerSource) && /['"]failed['"]/.test(issuerSource));

const analystSource = read("supabase/functions/osi-v2-analyst/index.ts");
ok("analyst activation calls issuance without awaiting a success result",
  /maybeReconcileSasCredential/.test(analystSource));
ok("analyst activation never returns an issuance error to the caller",
  !/maybeReconcileSasCredential[\s\S]{0,400}?return jsonResponse\(\s*5\d\d/.test(analystSource));

// ---------------------------------------------------------------------------
// 7. Migration: where enforcement binds, and that it stays off in code
// ---------------------------------------------------------------------------
const enforcementSql = read("supabase/migrations/20260725120000_osi_v2_sas_enforcement.sql");
const credentialSql = read("supabase/migrations/20260716120000_osi_v2_sas_credential.sql");

ok("the enforcement flag still ships false",
  /'OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED',\s*'false'/.test(credentialSql));
ok("no migration ever sets the enforcement flag true",
  !fs.readdirSync(path.join(root, "supabase", "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .some((name) => {
      const sql = read(path.join("supabase", "migrations", name));
      return /OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED[\s\S]{0,120}?(=\s*'true'|,\s*'true')/.test(sql);
    }));

ok("the predicate still short-circuits to true before touching any SAS table",
  /if not osi_private\.osi_v2_sas_enforcement_enabled\(\) then\s*\n\s*return true;/.test(enforcementSql));
ok("enforcement on requires the currently published credential coordinates",
  /v\.checked_credential = expected\.credential/.test(enforcementSql)
    && /v\.checked_schema = expected\.schema/.test(enforcementSql)
    && /v\.checked_issuer = expected\.issuer/.test(enforcementSql));
ok("unconfigured SAS withholds weight instead of granting it",
  /if expected\.credential is null[\s\S]{0,200}?return false;/.test(enforcementSql));
ok("only a verified snapshot counts",
  /v\.verification_state = 'verified'/.test(enforcementSql));

ok("the bootstrap bypass can never reach a challenge verdict or AI Pack approval",
  /sas_bypass[\s\S]{0,300}?p_review_kind in \('case_initial', 'case_report', 'resolution', 'wire_report'\)/
    .test(enforcementSql)
    && !/sas_bypass[\s\S]{0,300}?'challenge'/.test(enforcementSql));

ok("the D17 bootstrap selection support tally is now gated too",
  /osi_v2_bootstrap_selection_support[\s\S]*?osi_private\.osi_v2_sas_review_counts\('resolution', review\.id\)/
    .test(enforcementSql));

ok("a resolved snapshot stays immutable under the coordinates it was taken with",
  /bound_to_current/.test(enforcementSql)
    && /in \('verified', 'invalid', 'revoked', 'expired'\)\s*\n\s*and bound_to_current then/.test(enforcementSql));

ok("the lazy re-check worklist returns nothing while enforcement is off",
  /osi_v2_sas_reviews_needing_recheck[\s\S]*?if not osi_private\.osi_v2_sas_enforcement_enabled\(\) then\s*\n\s*return;/
    .test(enforcementSql));
ok("the worklist covers all six review kinds",
  ["case_initial", "case_report", "resolution", "challenge", "wire_report", "ai_pack"]
    .every((kind) => new RegExp("select '" + kind + "'|select '" + kind + "'::text").test(enforcementSql)));
ok("maintainer rows on a Case are never listed for the analyst credential gate",
  /r\.reviewer_role = 'analyst'/.test(enforcementSql));

const authorityBody = (() => {
  const start = enforcementSql.indexOf("create function osi_private.osi_v2_sas_review_authority");
  return start < 0 ? "" : enforcementSql.slice(start, enforcementSql.indexOf("$$;", start));
})();
ok("the authority projection function body exists", authorityBody.length > 200);
ok("the authority projection exposes no wallet, signature or note",
  !/reviewer_wallet|signature|private_note|public_rationale|payload_hash/.test(authorityBody));
ok("every new SAS helper is granted to service_role only",
  /revoke all privileges on function %s from public, anon, authenticated/.test(enforcementSql)
    && /grant execute on function %s to service_role/.test(enforcementSql));
ok("the migration explicitly refuses to write the enforcement flag",
  /is deliberately NOT written here/.test(enforcementSql));

// Every live quorum computation that counts analyst reviews is gated.
const gatedQuorums = [
  ["supabase/migrations/20260716120000_osi_v2_sas_credential.sql", "osi_v2_report_quorum", "case_report"],
  ["supabase/migrations/20260716120000_osi_v2_sas_credential.sql", "osi_v2_case_review_quorum", "case_initial"],
  ["supabase/migrations/20260716120000_osi_v2_sas_credential.sql", "osi_v2_resolution_quorum", "resolution"],
  ["supabase/migrations/20260716120000_osi_v2_sas_credential.sql", "osi_v2_seal_quorum", "resolution"],
  ["supabase/migrations/20260716120000_osi_v2_sas_credential.sql", "osi_v2_challenge_quorum", "challenge"],
  ["supabase/migrations/20260718130000_osi_v2_wire_phase2.sql", "osi_v2_wire_quorum", "wire_report"],
  ["supabase/migrations/20260718140000_osi_v2_ai_pack_phase1.sql", "osi_v2_ai_pack_quorum", "ai_pack"],
];
for (const [file, fn, kind] of gatedQuorums) {
  const sql = read(file);
  const start = sql.indexOf(fn);
  const body = start >= 0 ? sql.slice(start, start + 6000) : "";
  ok(fn + " counts only SAS-gated analyst reviews",
    new RegExp("osi_v2_sas_review_counts\\('" + kind + "'").test(body));
}

// ---------------------------------------------------------------------------
// 8. Edge wiring: the re-check runs before every quorum-dependent transition
// ---------------------------------------------------------------------------
const onchain = read("supabase/functions/_shared/osi-v2-sas-onchain.ts");
ok("the re-check consults the authoritative chain, never the wallet cache",
  /refreshReviewVerifications[\s\S]*?verifyWalletLive/.test(onchain)
    && !/refreshReviewVerifications[\s\S]{0,2000}?osi_v2_sas_wallet_credentials/.test(onchain));
ok("authority projection chunks every review id and fails unresolved rows closed",
  /for \(let offset = 0; offset < ids\.length; offset \+= 400\)/.test(onchain)
    && /p_review_ids: ids\.slice\(offset, offset \+ 400\)/.test(onchain)
    && /state: "authority_unavailable"/.test(onchain)
    && !/filter\(\(id\).*slice\(0, 400\)/.test(onchain));
ok("a verifier failure inside the re-check never propagates",
  /export async function refreshReviewVerifications[\s\S]*?catch \(error\)[\s\S]*?console\.log\("sas_recheck_noncritical_error"/
    .test(onchain));

const wiring = [
  ["supabase/functions/osi-v2-case-write/index.ts", '"case"', 2],
  ["supabase/functions/osi-v2-report-write/index.ts", '"report_version"', 2],
  ["supabase/functions/osi-v2-wire/index.ts", '"wire_version"', 2],
  ["supabase/functions/osi-v2-ai-pack/index.ts", '"pack_version"', 2],
];
for (const [file, target, minimum] of wiring) {
  const source = read(file);
  const matches = source.split("refreshReviewVerifications").length - 1;
  ok(file + " settles SAS snapshots before its quorum transitions",
    matches >= minimum && source.includes(target),
    "found " + matches + " call sites");
}
const governance = read("supabase/functions/osi-v2-governance-write/index.ts");
ok("governance finalize actions settle SAS snapshots on both prepare and commit",
  /resolution_finalize: "resolution"/.test(governance)
    && /seal_finalize: "resolution"/.test(governance)
    && /challenge_finalize: "challenge"/.test(governance)
    && (governance.split("refreshReviewVerifications").length - 1) >= 2);

ok("AI Pack reviews now record a SAS snapshot at cast time",
  /runShadowValidation\([\s\S]{0,200}?reviewKind: "ai_pack"/
    .test(read("supabase/functions/osi-v2-ai-pack/index.ts")));
ok("Case initial reviews resolve their snapshot by review id, not a missing public_ref",
  /reviewKind: "case_initial"/.test(read("supabase/functions/osi-v2-case-write/index.ts"))
    && /data\[0\]\.review_id/.test(read("supabase/functions/osi-v2-case-write/index.ts")));

// ---------------------------------------------------------------------------
// 9. Honest surfacing wherever a decision weight is shown
// ---------------------------------------------------------------------------
const caseCore = read("supabase/functions/_shared/osi-v2-case-read-core.mjs");
const reportCore = read("supabase/functions/_shared/osi-v2-report-core.mjs");
for (const [name, source] of [["case", caseCore], ["report", reportCore]]) {
  ok(name + " DTO stays silent about authority while enforcement is off",
    /if \(!authority \|\| authority\.enforced !== true\) return null;/.test(source));
  ok(name + " DTO carries the authority label next to the weight",
    /sas_authority: sasAuthorityDto\(review\)/.test(source));
}

const caseUi = read("assets/js/v2-case-integration.js");
const reportUi = read("assets/js/v2-report-integration.js");
for (const [name, source] of [["case", caseUi], ["report", reportUi]]) {
  ok(name + " UI renders nothing unless enforcement is actually on",
    /if\(!a\|\|a\.enforced!==true\)return'';/.test(source));
  ok(name + " UI states plainly that a counted review was verified on chain",
    /Authority verified on Solana/.test(source));
  ok(name + " UI states plainly why a review did not count",
    /Not counted: no valid SAS credential/.test(source)
      && /Not counted: SAS credential not confirmed/.test(source));
  ok(name + " UI reuses the existing badge classes without a restyle",
    /class="osi-proof-label"/.test(source) && /class="osi-chip warning"/.test(source));
  ok(name + " UI copy contains no em dash", !/\u2014|&mdash;|&#8212;/.test(source));
}

// ---------------------------------------------------------------------------
// 10. Rollout workflow: guarded, dispatch only, single-flag rollback
// ---------------------------------------------------------------------------
const workflow = read(".github/workflows/osi-v2-sas-enforcement-production.yml");
ok("the rollout workflow is workflow_dispatch only",
  /^on:\s*\n\s*workflow_dispatch:/m.test(workflow) && !/\n\s*push:/.test(workflow));
ok("the rollout workflow requires a typed confirmation phrase",
  /SAS-ENFORCE-ON-\$\{EXPECTED_PROJECT_REF\}/.test(workflow));
ok("the rollout workflow pins the exact project ref",
  /EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn/.test(workflow));
ok("the rollout workflow must be dispatched from main",
  /refs\/heads\/main/.test(workflow));
ok("the rollout workflow snapshots osi_config before and after",
  /osi-config-before\.txt/.test(workflow) && /osi-config-after\.txt/.test(workflow));
ok("the rollout workflow proves only the one key changed",
  /More than the single enforcement key changed/.test(workflow));
ok("the rollout workflow refuses to flip unless SAS is fully published",
  /is not published\. Run the Step 0 bootstrap first/.test(workflow));
ok("the rollout workflow aborts if production is not currently false",
  /Enforcement is not currently false in production/.test(workflow));
ok("the rollout workflow rolls back automatically on a post-flip failure",
  /failure\(\) && steps\.flip\.outcome == 'success'/.test(workflow));
ok("rollback is exactly the one flag set back to false",
  /set value='false'[\s\S]{0,120}?ENFORCEMENT_KEY/.test(workflow));
ok("the rollout workflow verifies the flag is still false after the migration",
  /The migration changed the enforcement flag/.test(workflow));
ok("the rollout workflow never prints a secret value",
  !/echo\s+"?\$\{?SUPABASE_(ACCESS_TOKEN|DB_PASSWORD)/.test(workflow));
ok("the rollout workflow contains no em dash", !/\u2014/.test(workflow));

console.log((fail ? "FAILED: " + fail : "OK") +
  " (" + pass + " assertions passed, " + fail + " failed)");
process.exit(fail ? 1 : 0);
