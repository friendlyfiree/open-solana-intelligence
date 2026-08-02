import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL(
  "../.github/workflows/osi-v2-analyst-function-deploy.yml",
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

matches(/^name: OSI V2 Analyst Function Deploy$/m, "task-scoped name");
matches(/\bon:\n  workflow_dispatch:\n/, "manual-only trigger");
excludes(/\n  (?:push|pull_request|schedule):/, "no automatic production trigger");
matches(/DEPLOY-ANALYST-\$\{EXPECTED_PROJECT_REF\}/, "project-bound confirmation");
matches(/EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn/, "pinned production project");
matches(/FUNCTION_SLUG: osi-v2-analyst/, "exact function slug");
matches(/refs\/heads\/main/, "main-only dispatch");
matches(/git rev-parse origin\/main/, "current main is revalidated");

matches(/for test in tests\/\*\.test\.js tests\/\*\.test\.mjs/, "all dependency-free tests run");
matches(/deno check "supabase\/functions\/\$\{FUNCTION_SLUG\}\/index\.ts"/, "function is type checked");
matches(/supabase db reset --local --no-seed/, "fresh database reset runs");
matches(/supabase db lint --local --level error/, "database lint runs");
matches(/supabase test db/, "pgTAP tests run");
matches(/tests\/osi-v2-concurrency\.test\.sh/, "concurrency and replay tests run");

matches(/supabase migration list --linked/, "remote migration status is recorded");
matches(/remote_versions.*local_versions/s, "local and production histories must match");
matches(/supabase db push --linked --dry-run/, "production dry-run is required");
matches(/up to date\|no migrations/, "dry-run must prove zero pending migrations");
excludes(/supabase db push --linked --yes/, "workflow cannot apply a migration");
excludes(/supabase migration repair|db reset --linked/i, "workflow cannot repair or reset production");

matches(/supabase functions deploy "\$FUNCTION_SLUG"/, "deploy command uses only the exact slug");
const deployCommands = workflow.match(/supabase functions deploy/g) ?? [];
assert.equal(deployCommands.length, 1, "only one function deploy command exists");
passed += 1;
excludes(/supabase functions deploy (?!"\$FUNCTION_SLUG")\S+/, "no other function is deployed");
matches(/--no-verify-jwt --use-api/, "existing in-function authorization mode remains explicit");

matches(/list_public_profiles/, "public analyst DTO is smoked");
matches(/details_restricted\|payload_hash\|nonce\|signature\|maintainer_auth_id/, "restricted public fields are denied");
matches(/definitely_not_an_op/, "unknown operation is denied");
matches(/ANALYST_READ_MAINTAINER_QUEUE/, "maintainer queue challenge is tested");
matches(/\[ "\$code" = "403" \]/, "ordinary wallet denial is exact");
matches(/prepare_application.*wallet.*bad/s, "invalid application stops before nonce issuance");

matches(/state-before\.txt[\s\S]*state-after\.txt/, "protected analyst state is snapshotted");
matches(/diff -u \/tmp\/state-before\.txt \/tmp\/state-after\.txt/, "protected analyst rows must not change");
matches(/slug!="osi-v2-analyst"/, "non-task functions are isolated");
matches(/diff -u \/tmp\/non-task-before\.json \/tmp\/non-task-after\.json/, "non-task function snapshot is unchanged");
matches(/Analyst function version did not advance/, "task function deployment is attested");

matches(/if: failure\(\)/, "post-deploy failures trigger containment");
matches(/OSI_V2_ANALYST_WRITES_ENABLED'[\s\S]*value='false'/, "only the analyst write flag is disabled on failure");
matches(/Immutable applications, versions, reviews, profiles and receipts are retained/, "disable plan preserves immutable data");
excludes(/^\s*(?:drop\s+(?:table|schema)|truncate\b|delete\s+from\b)/im, "no destructive SQL");
excludes(/supabase secrets (?:set|unset)|SUPABASE_DB_PASSWORD=.*echo/i, "no secret mutation or printing");

const uses = [...workflow.matchAll(/uses:\s+\S+@(\S+)/g)].map((match) => match[1]);
assert.ok(uses.length >= 5, "all required actions are present");
assert.ok(uses.every((ref) => /^[0-9a-f]{40}$/.test(ref)), "every action is SHA pinned");
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
    body.push(line.startsWith(" ".repeat(contentIndent)) ? line.slice(contentIndent) : "");
  }
  runBlocks.push(body.join("\n"));
}
const bash = process.platform === "win32"
  ? String.raw`C:\Program Files\Git\bin\bash.exe`
  : "bash";
assert.ok(runBlocks.length >= 14, "all multiline shell steps are discovered");
for (const [index, script] of runBlocks.entries()) {
  const syntax = spawnSync(bash, ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, `run block ${index + 1} is valid Bash: ${syntax.stderr}`);
  passed += 1;
}
passed += 1;

console.log(`osi-v2-analyst-function-deploy-workflow: ${passed} passed, 0 failed`);
