import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/osi-core-flow-repair-production.yml", import.meta.url),
  "utf8",
);
const alignmentWorkflow = fs.readFileSync(
  new URL(
    "../.github/workflows/osi-core-flow-validator-alignment-production.yml",
    import.meta.url,
  ),
  "utf8",
);
const alignmentMigration = fs.readFileSync(
  new URL(
    "../supabase/migrations/20260726173000_osi_core_flow_validator_alignment.sql",
    import.meta.url,
  ),
  "utf8",
);
const verificationWorkflow = fs.readFileSync(
  new URL(
    "../.github/workflows/osi-core-flow-production-verification.yml",
    import.meta.url,
  ),
  "utf8",
);
const productionSmoke = fs.readFileSync(
  new URL("./osi-core-flow-production-smoke.mjs", import.meta.url),
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
assert.match(workflow, /grep -q "\$marker" <<< "\$html"/);

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

assert.match(alignmentWorkflow, /^name: OSI Core Flow Validator Alignment Production/m);
assert.match(alignmentWorkflow, /^\s{2}workflow_dispatch:/m);
assert.doesNotMatch(alignmentWorkflow, /^\s{2}(push|pull_request|schedule):/m);
assert.match(alignmentWorkflow, /CORE-FLOW-VALIDATORS-afibxpniwfnavdobecrn/);
assert.match(alignmentWorkflow, /NEW_VERSION: "20260726173000"/);
assert.match(alignmentWorkflow, /supabase db push --linked --dry-run/);
assert.match(alignmentWorkflow, /supabase db push --linked --yes/);
assert.match(alignmentWorkflow, /osi-core-flow-production-smoke\.mjs --wait-seconds=310/);
assert.match(alignmentWorkflow, /diff -u \/tmp\/config-before\.txt \/tmp\/config-after\.txt/);
assert.doesNotMatch(
  alignmentWorkflow,
  /supabase functions deploy|supabase secrets set|update public\.osi_config/i,
);

assert.match(
  alignmentMigration,
  /char_length\(p_title_public_safe\) not between 3 and 160/,
);
assert.match(
  alignmentMigration,
  /char_length\(p_content_public_safe\) not between 10 and 4000/,
);
assert.match(alignmentMigration, /char_length\(p_body_private\) not between 20 and 100000/);
assert.match(alignmentMigration, /jsonb_array_length\(value\) between 0 and 6/);
assert.doesNotMatch(alignmentMigration, /update public\.osi_config/i);

assert.match(verificationWorkflow, /^name: OSI Core Flow Production Verification/m);
assert.match(verificationWorkflow, /^\s{2}workflow_dispatch:/m);
assert.doesNotMatch(verificationWorkflow, /^\s{2}(push|pull_request|schedule):/m);
assert.match(verificationWorkflow, /CORE-FLOW-VERIFY-afibxpniwfnavdobecrn/);
assert.match(verificationWorkflow, /osi-core-flow-production-smoke\.mjs --wait-seconds=310/);
assert.match(verificationWorkflow, /diff -u \/tmp\/config-before\.txt \/tmp\/config-after\.txt/);
assert.match(verificationWorkflow, /smoke_domain_records_committed=0/);
assert.doesNotMatch(
  verificationWorkflow,
  /supabase db push|supabase functions deploy|supabase secrets set|update public\.osi_config/i,
);

assert.match(productionSmoke, /op: "prepare_application",\s+wallet,\s+application: \{/);
assert.match(
  productionSmoke,
  /wire_safety_checks: \["payment_card", "secret_material", "illegal_access", "doxxing", "https_only"\]/,
);

console.log("OSI core-flow production workflow contract passed.");
