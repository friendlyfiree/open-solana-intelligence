import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/osi-production-hardening-e2e.yml", import.meta.url),
  "utf8",
);

let passed = 0;
function ok(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed++;
}

ok("rollout is manual, main-only, project-pinned, and typed-confirmed",
  /on:\s*\r?\n\s+workflow_dispatch:/.test(workflow)
  && workflow.includes("HARDEN-E2E-afibxpniwfnavdobecrn")
  && workflow.includes("EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn")
  && workflow.includes('refs/heads/main'));
ok("exact additive forward fix is the 27th pinned version",
  workflow.includes('NEW_VERSION: "20260728153100"')
  && workflow.includes("20260728132011 20260728153100")
  && workflow.includes('supabase db push --linked --dry-run')
  && workflow.includes('if: env.MIGRATION_PENDING == \'true\''));
ok("clean-room gate runs all Node, Deno, browser, migration, lint, pgTAP, and race tests",
  workflow.includes('for test in tests/*.test.js tests/*.test.mjs')
  && workflow.includes('deno check "${deno_sources[@]}"')
  && workflow.includes('npx playwright test --config tests/browser/playwright.config.js')
  && workflow.includes('supabase db reset --local --no-seed')
  && workflow.includes('supabase db lint --local --level error')
  && workflow.includes('supabase test db')
  && workflow.includes('tests/osi-v2-concurrency.test.sh'));
ok("production snapshot covers domain, money, nonce, legacy, and storage rows",
  [
    "cases", "analyst_profiles", "event_receipts", "osi_nonces",
    "reward_payments", "support_events", "wire_reports",
    "legacy_onchain_events", "legacy_requests", "storage_objects",
  ].every((name) => workflow.includes(`'${name}'`))
  && workflow.includes('diff -u /tmp/rows-before.txt /tmp/rows-after.txt'));
ok("semantic authorization proof covers policies, grants, storage, and SECURITY DEFINER",
  workflow.includes("legacy onchain write policy survived")
  && workflow.includes("unsafe request policy survived")
  && workflow.includes("osi-uploads upload or listing policy survived")
  && workflow.includes("browser-reachable SECURITY DEFINER function found")
  && workflow.includes("historical public object URL bucket changed"));
ok("live negative smoke attempts no valid domain write or transaction",
  workflow.includes("/rest/v1/requests")
  && workflow.includes("/rest/v1/onchain_events")
  && workflow.includes('\'{"event_type":"FAKE","tx_sig":"')
  && !workflow.includes('"id":9223372036854770003')
  && workflow.includes("/storage/v1/object/osi-uploads/negative-smoke.txt")
  && workflow.includes('storage-list.json)" = "[]"')
  && workflow.includes('"op":"recover_payment"')
  && workflow.includes('"tx_sig":"bad"'));
ok("only the task-scoped payment function is deployed",
  workflow.includes("functions deploy osi-v2-payment")
  && !/functions deploy (?!osi-v2-payment)/.test(workflow));
ok("Vercel proof waits for the exact recovery UI from the dispatched commit",
  workflow.includes("Re-verify existing signature")
  && workflow.includes("osi:v2:payment-recovery:1")
  && workflow.includes("?commit=${GITHUB_SHA}"));
ok("resumed rollout stays disabled until every pre-enable gate passes",
  workflow.includes('= "false" ]')
  && workflow.includes('"payment_writes_enabled":false')
  && workflow.indexOf("Deploy only the changed payment Edge Function")
    < workflow.indexOf("Enable only payment and run final negative smoke")
  && workflow.indexOf("Verify exact Vercel frontend hardening")
    < workflow.indexOf("Enable only payment and run final negative smoke")
  && workflow.includes("where key<>'OSI_V2_PAYMENT_WRITES_ENABLED'"));
ok("failure disables only payment and preserves immutable data",
  workflow.includes("where key='OSI_V2_PAYMENT_WRITES_ENABLED' and value='true'")
  && !/\b(drop\s+table|supabase\s+migration\s+repair)\b/i.test(workflow)
  && workflow.includes("immutable data retained"));
ok("deployment receipt states zero domain rows and zero Solana transactions",
  workflow.includes("production_domain_rows=unchanged")
  && workflow.includes("solana_transactions_created=0")
  && workflow.includes("feature_flags=payment_false_to_true_only"));

console.log(`OK (${passed} assertions passed)`);
