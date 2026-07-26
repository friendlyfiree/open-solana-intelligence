import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/osi-core-flow-repair-production.yml", import.meta.url),
  "utf8",
);

assert.match(workflow, /^name: OSI Core Flow Repair Production/m);
assert.match(workflow, /^\s{2}workflow_dispatch:/m);
assert.doesNotMatch(workflow, /^\s{2}(push|pull_request|schedule):/m);
assert.match(workflow, /CORE-FLOW-DEPLOY-afibxpniwfnavdobecrn/);
assert.match(workflow, /refs\/heads\/main/);
assert.match(workflow, /git rev-parse origin\/main/);
assert.match(workflow, /supabase db push --linked --dry-run/);
assert.doesNotMatch(workflow, /supabase db push --linked --yes/);
assert.doesNotMatch(workflow, /supabase secrets set|update public\.osi_config/i);
assert.match(workflow, /for test in tests\/\*\.test\.js tests\/\*\.test\.mjs/);
assert.match(workflow, /deno check/);
assert.match(workflow, /playwright test --config tests\/browser\/playwright\.config\.js/);
assert.match(workflow, /supabase db reset --local --no-seed/);
assert.match(workflow, /supabase db lint --local --level error/);
assert.match(workflow, /supabase test db/);
assert.match(workflow, /osi-v2-concurrency\.test\.sh/);
assert.match(workflow, /osi-core-flow-production-smoke\.mjs --wait-seconds=310/);
assert.match(workflow, /diff -u \/tmp\/config-before\.txt \/tmp\/config-after\.txt/);

const expectedFunctions = [
  "osi-analyst-intake",
  "osi-ai-pack",
  "osi-v2-ai-pack",
  "osi-v2-analyst",
  "osi-v2-case-read",
  "osi-v2-case-write",
  "osi-v2-governance-write",
  "osi-v2-payment",
  "osi-v2-report-read",
  "osi-v2-report-write",
  "osi-v2-wire",
];
for (const slug of expectedFunctions) {
  assert.ok(workflow.split(/\s+/).includes(slug), `missing ${slug}`);
}
assert.doesNotMatch(workflow, /(^|\s)osi-v2-proof(\s|$)/m);

console.log("OSI core-flow production workflow contract passed.");
