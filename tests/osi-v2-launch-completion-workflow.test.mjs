import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/osi-v2-launch-completion-production.yml", import.meta.url),
  "utf8",
);

assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /LAUNCH-COMPLETE-\$\{EXPECTED_PROJECT_REF\}/);
assert.match(workflow, /refs\/heads\/main/);
assert.match(workflow, /git rev-parse origin\/main/);
assert.match(workflow, /20260728170000_osi_v2_solana_pay_and_maintainer_ai_pack\.sql/);
assert.match(workflow, /supabase db push --linked --dry-run/);
assert.match(workflow, /supabase db push --linked --yes/);
assert.match(workflow, /supabase db reset --local --no-seed/);
assert.match(workflow, /supabase db lint --local --level error/);
assert.match(workflow, /supabase test db/);
assert.match(workflow, /tests\/osi-v2-concurrency\.test\.sh/);
assert.match(workflow, /npx playwright test --config tests\/browser\/playwright\.config\.js/);
assert.match(workflow, /node scripts\/verify-sas-mainnet\.mjs/);
assert.match(workflow, /scripts\/protected-row-counts\.sql/);
assert.match(workflow, /diff -u \/tmp\/protected-rows-before\.txt \/tmp\/protected-rows-after\.txt/);
assert.match(workflow, /diff -u \/tmp\/config-unchanged-before\.txt \/tmp\/config-unchanged-after\.txt/);

const deployBlock = workflow.slice(
  workflow.indexOf("Deploy exactly the three changed Edge Functions"),
  workflow.indexOf("Negative production smokes before enabling"),
);
for (const name of ["osi-v2-payment", "osi-v2-analyst", "osi-v2-ai-pack"]) {
  assert.match(deployBlock, new RegExp(name));
}
for (const forbidden of ["osi-v2-case-read", "osi-v2-case-write", "osi-v2-wire", "osi-v2-proof"]) {
  assert.doesNotMatch(deployBlock, new RegExp(forbidden));
}

assert.match(workflow, /OSI_V2_SOLANA_PAY_ENABLED','OSI_V2_AI_PACK_WRITES_ENABLED/);
assert.match(workflow, /OSI_V2_AI_PACK_ACCESS_MODE'"\)" = "maintainer_only"/);
assert.match(workflow, /OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED'"\)" = "false"/);
assert.match(workflow, /OSI_V2_WRITES_ENABLED'"\)" = "false"/);
assert.match(workflow, /OSI_V2_PROOF_ENABLED'"\)" = "false"/);
assert.match(workflow, /OSI_V2_FALLBACK_GOVERNANCE'"\)" = "false"/);
assert.match(workflow, /solana_pay_enabled==true/);
assert.match(workflow, /maintainer_access==false and \.can_generate==false/);
assert.match(workflow, /\.packs==\[\]/);
assert.match(workflow, /No prepare\/commit endpoint or Solana transaction was invoked/);

const destructive = workflow
  .replace(/supabase db reset --local --no-seed/g, "")
  .replace(/Do not drop, reset, repair, truncate, broadly update, or rewrite production data\./g, "");
assert.doesNotMatch(destructive, /\b(?:drop\s+(?:table|schema)|truncate|delete\s+from|migration\s+repair|db\s+reset)\b/i);

console.log("osi-v2-launch-completion-workflow: 35 passed, 0 failed");
