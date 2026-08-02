import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL(
  "../.github/workflows/osi-report-rejection-production.yml",
  import.meta.url,
), "utf8");

let passed = 0;
function matches(pattern, label) {
  assert.match(workflow, pattern, label);
  passed += 1;
}
function excludes(pattern, label) {
  assert.doesNotMatch(workflow, pattern, label);
  passed += 1;
}

matches(/^name: OSI Report Rejection Transition Production$/m, "task-scoped name");
matches(/\bon:\n  workflow_dispatch:\n/, "manual-only trigger");
excludes(/\n  (?:push|pull_request|schedule):/, "no automatic production trigger");
matches(/REPORT-REJECTION-\$\{EXPECTED_PROJECT_REF\}/, "project-bound confirmation");
matches(/EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn/, "pinned production ref");
matches(/NEW_VERSION: "20260802102728"/, "one migration version");
matches(/\$\{NEW_VERSION\}_osi_v2_report_rejection_transition\.sql/, "exact migration file");
matches(/BEFORE_VERSIONS:[\s\S]*20260801120700[\s\S]*AFTER_VERSIONS:[\s\S]*20260802102728/, "exact before and after histories");
excludes(/20260802071500/, "obsolete local-only migration version is absent");
matches(/byte-equivalent SQL under its[\s\S]*canonical 20260802102728 version/, "audited provenance is documented");
matches(/Remote migration history is not the exact before or already-applied set/, "unexpected history fails closed");
matches(/supabase migration list --linked/, "remote migration status recorded");
matches(/supabase db push --linked --dry-run/, "dry-run required");
matches(/\[ "\$pending" = "\$NEW_VERSION" \]/, "dry-run allows only the task migration");
matches(/ROLLOUT_HISTORY_MODE=already_applied/, "safe already-applied resume");
matches(/ROLLOUT_START_MODE=live/, "live gate snapshot is explicit");
matches(/ROLLOUT_START_MODE=contained_resume/, "fail-closed resume snapshot is explicit");
matches(/supabase db push --linked --yes/, "additive push is explicit");

matches(/for test_file in tests\/\*\.test\.js tests\/\*\.test\.mjs/, "all Node regressions run");
matches(/deno_check_with_retry "\$\{deno_sources\[@\]\}"/, "all Edge sources checked");
matches(/npx playwright test --config tests\/browser\/playwright\.config\.js/, "browser suite runs");
matches(/supabase db reset --local --no-seed/, "fresh disposable database reset");
matches(/supabase db lint --local --level error/, "database lint runs");
matches(/supabase test db/, "pgTAP runs");
matches(/tests\/osi-v2-concurrency\.test\.sh/, "race and replay tests run");
matches(/actionlint" \.github\/workflows\/osi-report-rejection-production\.yml/, "workflow syntax linted");

matches(/to_regprocedure\('osi_private\.osi_v2_prepare_report_rejection/, "private prepare verified");
matches(/to_regprocedure\('osi_private\.osi_v2_commit_report_rejection/, "private commit verified");
matches(/to_regprocedure\('public\.osi_v2_prepare_report_rejection/, "public prepare wrapper verified");
matches(/to_regprocedure\('public\.osi_v2_commit_report_rejection/, "public commit wrapper verified");
matches(/'anon'.*osi_v2_prepare_report_rejection[\s\S]*'execute'/, "anonymous prepare privilege checked");
matches(/'authenticated'.*osi_v2_prepare_report_rejection[\s\S]*'execute'/, "authenticated prepare privilege checked");
matches(/'service_role'.*osi_v2_prepare_report_rejection[\s\S]*'execute'/, "service prepare privilege checked");
matches(/rate_window_counts_rejection\|true/, "rejection shares the review rate window");

const deploy = workflow.slice(workflow.indexOf("\n  deploy:"));
assert.doesNotMatch(deploy, /supabase functions deploy/, "no Function deployment");
passed += 1;
assert.match(deploy, /function-before\.json[\s\S]*function-after\.json/);
assert.match(deploy, /diff -u "\$PROOF_DIR\/function-before\.json" "\$PROOF_DIR\/function-after\.json"/);
passed += 2;
assert.match(deploy, /scripts\/protected-row-counts\.sql/);
assert.match(deploy, /diff -u "\$PROOF_DIR\/protected-rows-before\.txt" "\$PROOF_DIR\/protected-rows-after\.txt"/);
assert.match(deploy, /config-before\.txt[\s\S]*config-after\.txt/);
passed += 3;
assert.match(deploy, /OSI_V2_REPORT_REVIEW_WRITES_ENABLED'[\s\S]*value='false'/);
assert.match(deploy, /OSI_V2_REPORT_REVIEW_WRITES_ENABLED'[\s\S]*value='true'/);
assert.match(deploy, /expected_gate_value=true[\s\S]*contained_resume[\s\S]*expected_gate_value=false/);
assert.match(deploy, /Report review outcomes remain fail-closed/);
passed += 4;

excludes(/^\s*(?:drop\s+(?:table|schema)|truncate\b|delete\s+from\b)/im, "no destructive SQL");
excludes(/supabase\s+(?:migration repair|db reset --linked)/i, "no remote repair or reset");
excludes(/\"op\":\"(?:commit_rejection|prepare_report|commit_report|commit_review)\"/, "no production success-path write call");
matches(/prepare_or_commit_successes=0/, "no successful prepare or commit claimed");
matches(/solana_transactions_created=0/, "no Solana transaction claimed");
matches(/domain_records_created=0/, "no domain records created");
matches(/function_deployments=0/, "no Function deployment claimed");

const uses = [...workflow.matchAll(/uses:\s+\S+@(\S+)/g)].map((match) => match[1]);
assert.ok(uses.length >= 5);
assert.ok(uses.every((ref) => /^[0-9a-f]{40}$/.test(ref)));
passed += 2;

const lines = workflow.split(/\r?\n/);
const runBlocks = [];
for (let index = 0; index < lines.length; index += 1) {
  const marker = lines[index].match(/^(\s*)run: \|$/);
  if (!marker) continue;
  const baseIndent = marker[1].length;
  const contentIndent = baseIndent + 2;
  const body = [];
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && line.match(/^\s*/)[0].length <= baseIndent) {
      index -= 1;
      break;
    }
    body.push(line.startsWith(" ".repeat(contentIndent))
      ? line.slice(contentIndent)
      : "");
  }
  runBlocks.push(body.join("\n"));
}
const bash = process.platform === "win32"
  ? String.raw`C:\Program Files\Git\bin\bash.exe`
  : "bash";
assert.ok(runBlocks.length >= 12, "all multiline shell steps are discovered");
for (const [index, script] of runBlocks.entries()) {
  const syntax = spawnSync(bash, ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, `run block ${index + 1} is valid Bash: ${syntax.stderr}`);
  passed += 1;
}
passed += 1;

console.log(`osi-report-rejection-production-workflow: ${passed} passed, 0 failed`);
