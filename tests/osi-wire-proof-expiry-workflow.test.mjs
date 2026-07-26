import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/osi-wire-proof-expiry-production.yml", import.meta.url),
  "utf8",
);
const smoke = readFileSync(
  new URL("./osi-core-flow-production-smoke.mjs", import.meta.url),
  "utf8",
);

let assertions = 0;
function ok(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  assertions += 1;
  console.log(`PASS: ${message}`);
}

ok(
  workflow.includes("EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn")
    && workflow.includes('NEW_VERSION: "20260726185457"')
    && workflow.includes("WIRE-PROOF-RECOVERY-${EXPECTED_PROJECT_REF}"),
  "rollout is pinned to the exact project, migration, and confirmation phrase",
);
ok(
  workflow.includes("supabase db push --linked --dry-run")
    && workflow.includes('[ "$got" = "$NEW_VERSION" ]')
    && workflow.includes("supabase db push --linked --yes"),
  "rollout dry-runs and applies only the exact pending migration",
);
ok(
  workflow.includes("functions deploy osi-v2-wire")
    && !/functions deploy (?!osi-v2-wire)/.test(workflow),
  "rollout deploys only the touched Wire Edge Function",
);
ok(
  workflow.includes("where key <> 'OSI_V2_NONCE_TTL_SECONDS'")
    && workflow.includes("diff -u /tmp/config-before.txt /tmp/config-after.txt")
    && workflow.includes("where key='OSI_V2_WIRE_WRITES_ENABLED' and value='true'"),
  "rollout isolates the intended TTL change and fails Wire closed on later failure",
);
ok(
  workflow.includes("tests/osi-core-flow-production-smoke.mjs")
    && smoke.includes("preparedWire.expires_at - preparedWire.issued_at === 300"),
  "production smoke proves the gateway issues the exact five-minute proof window",
);
ok(
  workflow.includes('if frontend="$(')
    && workflow.includes('[[ "$frontend" == *"Your draft is safe; preparing a fresh proof"* ]]')
    && !/curl[\s\S]{0,240}\|\s*grep -q 'Your draft is safe; preparing a fresh proof'/.test(workflow),
  "frontend readiness does not turn grep's successful early exit into a pipefail false negative",
);
ok(
  workflow.includes("smoke_domain_records_committed=0")
    && workflow.includes("diff -u /tmp/v1-before.txt /tmp/v1-after.txt"),
  "rollout proves prepare-only smoke and protected row isolation",
);

console.log(`\n${assertions} Wire proof expiry workflow checks passed.`);
