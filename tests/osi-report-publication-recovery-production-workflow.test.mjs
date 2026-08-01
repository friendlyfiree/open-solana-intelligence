import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL(
  "../.github/workflows/osi-report-publication-recovery-production.yml",
  import.meta.url,
), "utf8");

assert.match(workflow, /workflow_dispatch:[\s\S]*REPORT-NULLABLE-SUMMARY-\$\{EXPECTED_PROJECT_REF\}/);
assert.equal((workflow.match(/CONFIRM_INPUT: \$\{\{ github\.event\.inputs\.confirm \}\}/g) ?? []).length, 2);
assert.doesNotMatch(workflow, /\[ "\$\{\{ github\.event\.inputs\.confirm \}\}" =/);
assert.match(workflow, /refs\/heads\/main/);
assert.match(workflow, /\$\{NEW_VERSION\}_report_nullable_public_summary\.sql/);
assert.match(workflow, /supabase db push --linked --dry-run/);
assert.match(workflow, /\[ "\$got" = "\$NEW_VERSION" \]/);
assert.match(workflow, /pg_get_constraintdef/);
assert.match(workflow, /if grep -Fq 'content_public_safe IS NOT NULL'/);
assert.match(workflow, /supabase db reset --local --no-seed/);
assert.match(workflow, /supabase db lint --local --level error/);
assert.match(workflow, /supabase test db/);
assert.match(workflow, /tests\/osi-v2-concurrency\.test\.sh/);
assert.match(workflow, /npx playwright test --config tests\/browser\/playwright\.config\.js/);
assert.match(workflow, /actionlint" \.github\/workflows\/osi-report-publication-recovery-production\.yml/);
assert.match(workflow, /bash -n tests\/osi-v2-concurrency\.test\.sh/);
assert.match(workflow, /shellcheck tests\/osi-v2-concurrency\.test\.sh/);
assert.match(workflow, /deno_check_with_retry\(\)/);
assert.match(workflow, /for attempt in 1 2 3/);
assert.match(workflow, /deno_check_with_retry "\$\{deno_sources\[@\]\}" tests\/osi-core-flow-production-smoke\.mjs/);
assert.match(workflow, /EXPECTED_CASE_READ_VERSION: "24"/);
assert.match(workflow, /EXPECTED_CASE_READ_DIGEST: e89897739779cdaaef9179f7a1e971d8284a30cac3fb39f8058233df2cffee0f/);
assert.match(workflow, /EXPECTED_REPORT_READ_VERSION: "19"/);
assert.match(workflow, /EXPECTED_REPORT_READ_DIGEST: c38267cd8aaa3a01d8f83d218d0c673618a9a64b1a488924d21f21df9d999d24/);
assert.match(workflow, /EXPECTED_REPORT_WRITE_VERSION: "17"/);
assert.match(workflow, /EXPECTED_REPORT_WRITE_DIGEST: 05ac686786d3f251f8a36b9ef7c03ab26903e4c2caa9f305cdc0fd7ddeb3d779/);

const deployStart = workflow.indexOf("Deploy and attest only the three affected Functions");
const deployEnd = workflow.indexOf("Read-only contained smoke", deployStart);
assert.ok(deployStart > 0 && deployEnd > deployStart);
const deploy = workflow.slice(deployStart, deployEnd);
assert.equal((deploy.match(/supabase functions deploy/g) ?? []).length, 3);
assert.match(deploy, /supabase functions deploy osi-v2-case-read/);
assert.match(deploy, /supabase functions deploy osi-v2-report-read/);
assert.match(deploy, /supabase functions deploy osi-v2-report-write/);
for (const forbidden of ["osi-v2-case-write", "osi-v2-wire", "osi-v2-analyst"]) {
  assert.doesNotMatch(deploy, new RegExp(forbidden));
}

assert.match(workflow, /where key='OSI_V2_REPORT_REVIEW_WRITES_ENABLED' and value='true'/);
assert.match(workflow, /where key='OSI_V2_REPORT_REVIEW_WRITES_ENABLED' and value='false'/);
assert.match(workflow, /Report publication remains fail-closed/);
const production = workflow.slice(workflow.indexOf("\n  deploy:"));
assert.doesNotMatch(production, /^\s*(?:drop\s+(?:table|schema)|truncate\b|delete\s+from\b)/im);
assert.doesNotMatch(production, /supabase\s+(?:db reset|migration repair)/i);
assert.doesNotMatch(workflow, /(?:"op"\s*:\s*"|\\"op\\":\\")(?:prepare|commit)/);
assert.match(workflow, /scripts\/protected-row-counts\.sql/);
assert.match(workflow, /diff -u "\$RUNNER_TEMP\/target-before\.txt" "\$RUNNER_TEMP\/target-after\.txt"/);
assert.match(workflow, /diff -u "\$PROOF_DIR\/protected-rows-before\.txt" "\$PROOF_DIR\/protected-rows-after\.txt"/);
assert.match(workflow, /solana_transactions_created=0/);
assert.match(workflow, /domain_records_created=0/);
assert.match(workflow, /No public-safe summary was provided\./);
assert.match(workflow, /public Report response contained a restricted body key/i);

const uses = [...workflow.matchAll(/uses:\s+\S+@(\S+)/g)].map((match) => match[1]);
assert.ok(uses.length >= 5);
assert.ok(uses.every((ref) => /^[0-9a-f]{40}$/.test(ref)));

console.log("osi-report-publication-recovery-production-workflow: 36 passed, 0 failed");
