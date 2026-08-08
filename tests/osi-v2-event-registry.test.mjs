import assert from "node:assert/strict";
import fs from "node:fs";
import {
  OSI2_ACTOR_ROLES,
  OSI2_ENVELOPE_PROFILES,
  OSI2_EVENT_CLASSES,
  OSI2_EVENT_REGISTRY_VERSION,
  OSI2_TARGET_TYPES,
  canonicalOsi2Envelope,
  osi2EventClass,
  parseHistoricalGovernanceV0,
  parseOsi2Envelope,
} from "../supabase/functions/_shared/osi-v2-event-registry.mjs";

let passed = 0;
function ok(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed++;
}

const allEvents = Object.values(OSI2_EVENT_CLASSES).flat();
ok("registry version is explicit", OSI2_EVENT_REGISTRY_VERSION === "2026-08-08.1");
ok("registry has the accepted 71 events", allEvents.length === 71);
ok("registry classes never overlap", new Set(allEvents).size === 71);
ok("registry preserves 29 class-B events",
  OSI2_EVENT_CLASSES.wallet_signed_server_verified.length === 29);
ok("registry preserves 34 class-A events", OSI2_EVENT_CLASSES.solana_memo.length === 34);
ok("registry preserves 8 system events", OSI2_EVENT_CLASSES.system_event.length === 8);
const migrationSql = fs.readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .map((name) => fs.readFileSync(
    new URL("../supabase/migrations/" + name, import.meta.url),
    "utf8",
  ))
  .join("\n");
const databaseClasses = {};
for (const match of migrationSql.matchAll(
  /when\s+p_event_type\s*=\s*any\s*\(array\[([\s\S]*?)\]::text\[\]\)\s*then\s*'([^']+)'/g,
)) {
  databaseClasses[match[2]] = [...match[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)]
    .map((event) => event[1]);
}
for (const proofType of Object.keys(OSI2_EVENT_CLASSES)) {
  ok(`${proofType} exactly matches the database receipt registry`,
    JSON.stringify([...OSI2_EVENT_CLASSES[proofType]].sort())
      === JSON.stringify([...(databaseClasses[proofType] || [])].sort()));
}
ok("native support is class A", osi2EventClass("SUPPORT_PAYMENT_CONFIRMED") === "solana_memo");
ok("support targets and shipped wallet actors are explicit",
  OSI2_TARGET_TYPES.includes("support") && OSI2_ACTOR_ROLES.includes("wallet"));
ok("field order is immutable per named profile",
  OSI2_ENVELOPE_PROFILES.v1_expiring.fields.join(",") === "t,id,a,r,d,n,h,ts,exp"
  && OSI2_ENVELOPE_PROFILES.v1_issued.fields.join(",") === "t,id,a,r,d,n,h,ts"
  && OSI2_ENVELOPE_PROFILES.v2_expiring_minimal.fields.join(",") === "t,id,a,n,h,ts,exp");

const wallet = "11111111111111111111111111111112";
const expiringBinding = {
  purpose: "CASE_SUBMITTED",
  target_type: "case",
  target_ref: "OSI-ABCDEF123456",
  actor_wallet: wallet,
  actor_role: "owner",
  decision: "submit",
  nonce: "n".repeat(32),
  payload_hash: "a".repeat(64),
  issued_at: 1800000000,
  expires_at: 1800000120,
};
const expiringGolden = [
  "OSI2", "1", "CASE_SUBMITTED", "t=case", "id=OSI-ABCDEF123456",
  `a=${wallet}`, "r=owner", "d=submit", `n=${"n".repeat(32)}`,
  `h=${"a".repeat(64)}`, "ts=1800000000", "exp=1800000120",
].join("|");
ok("v1 expiring golden vector is byte exact",
  canonicalOsi2Envelope(expiringBinding) === expiringGolden);
ok("v1 expiring golden vector round-trips exactly",
  parseOsi2Envelope(expiringGolden)?.target_ref === "OSI-ABCDEF123456");
ok("field reordering is rejected",
  parseOsi2Envelope(expiringGolden.replace("|t=case|id=", "|id=case|t=")) === null);

const fixture = JSON.parse(fs.readFileSync(
  new URL("./fixtures/osi-v2-mainnet-support-payment.json", import.meta.url),
  "utf8",
));
const historicalPaymentMemo = fixture.transaction.transaction.message.instructions[3].parsed;
ok("immutable historical payment Memo uses its registered v1 issued profile",
  canonicalOsi2Envelope({
    purpose: "SUPPORT_PAYMENT_CONFIRMED",
    target_type: "support",
    target_ref: fixture.intent.target_public_ref,
    actor_wallet: fixture.intent.payer_wallet,
    actor_role: fixture.intent.actor_role,
    decision: "sent",
    nonce: fixture.intent.nonce,
    payload_hash: fixture.intent.payload_hash,
    issued_at: fixture.intent.issued_at,
  }, "v1_issued") === historicalPaymentMemo);
ok("historical payment Memo remains parseable without being rewritten",
  parseOsi2Envelope(historicalPaymentMemo, "v1_issued")?.nonce === fixture.intent.nonce);

const minimalGolden = canonicalOsi2Envelope({
  purpose: "CASE_WITHDRAWN",
  target_type: "case",
  target_ref: "018f47ac-7d20-7b92-a323-7fc0f3f43c10",
  actor_wallet: wallet,
  nonce: "p".repeat(32),
  payload_hash: "b".repeat(64),
  issued_at: 1800000000,
  expires_at: 1800000120,
}, "v2_expiring_minimal");
ok("v2 minimal signMessage profile excludes invented role and decision fields",
  minimalGolden === [
    "OSI2", "2", "CASE_WITHDRAWN", "t=case",
    "id=018f47ac-7d20-7b92-a323-7fc0f3f43c10", `a=${wallet}`,
    `n=${"p".repeat(32)}`, `h=${"b".repeat(64)}`,
    "ts=1800000000", "exp=1800000120",
  ].join("|"));

const governanceV0 = [
  "OSI2", "REPORT_SELECTED_WINNING", "t=resolution",
  "id=018f47ac-7d20-7b92-a323-7fc0f3f43c10", "ref=OSI-RES-ABCDEF1234567890",
  `a=${wallet}`, `h=${"c".repeat(64)}`, `n=${"g".repeat(32)}`,
  "ts=1800000000000", "exp=1800000120000",
].join("|");
ok("unversioned governance history has an explicit read-only parser",
  parseHistoricalGovernanceV0(governanceV0)?.target_public_ref
    === "OSI-RES-ABCDEF1234567890");
assert.throws(() => canonicalOsi2Envelope({ ...expiringBinding, purpose: "INVENTED_EVENT" }));
passed++;
assert.throws(() => canonicalOsi2Envelope({ ...expiringBinding, actor_role: "supporter" }));
passed++;

for (const relative of [
  "../supabase/functions/_shared/osi-v2-case-write-core.mjs",
  "../supabase/functions/_shared/osi-v2-report-core.mjs",
  "../supabase/functions/_shared/osi-v2-wire-core.mjs",
  "../supabase/functions/_shared/osi-v2-payment-core.mjs",
  "../supabase/functions/_shared/osi-v2-analyst-core.mjs",
  "../supabase/functions/_shared/osi-v2-proof-core.mjs",
  "../supabase/functions/osi-v2-ai-pack/core.ts",
]) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  ok(`${relative.split("/").at(-1)} uses the shared canonical registry`,
    source.includes("osi-v2-event-registry.mjs"));
}

console.log(`OK (${passed} assertions passed)`);
