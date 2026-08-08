import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL(
  "../.github/workflows/osi-v2-wire-privacy-production.yml",
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

matches(/^name: OSI V2 Wire Privacy Production$/m, "task-scoped workflow name");
matches(/\bon:\n  workflow_dispatch:\n/, "manual-only trigger");
excludes(/\n  (?:push|pull_request|schedule):/, "no automatic production trigger");
matches(/DEPLOY-WIRE-PRIVACY-\$\{EXPECTED_PROJECT_REF\}/, "project-bound confirmation");
matches(/EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn/, "production project is pinned");
matches(/SLICE_MIGRATION: 20260808153040_remove_private_wire_fields_from_public_rpc\.sql/, "exact migration is pinned");
matches(/FUNCTION_SLUG: osi-v2-wire/, "exact function is pinned");
matches(/refs\/heads\/main/, "dispatch is main only");
matches(/git rev-parse origin\/main/, "current main is revalidated");

matches(/for test in tests\/\*\.test\.js tests\/\*\.test\.mjs/, "all dependency-free tests run");
matches(/deno check "supabase\/functions\/\$\{FUNCTION_SLUG\}\/index\.ts"/, "Wire function is type checked");
matches(/supabase db reset --local --no-seed/, "migrations run from zero");
matches(/supabase db lint --local --level error/, "database lint runs");
matches(/supabase test db/, "pgTAP runs");
matches(/tests\/osi-v2-concurrency\.test\.sh/, "replay tests run");
matches(/public\.osi_v2_get_public_wire_report\(text\)/, "public RPC boundary is checked");

matches(/supabase db push --linked --dry-run/, "production dry-run is mandatory");
matches(/exactly one is allowed/, "dry-run rejects more than one migration");
matches(/supabase db push --linked\n/, "the validated migration is applied");
excludes(/supabase migration repair|db reset --linked/i, "production cannot be repaired or reset");
excludes(/^\s*(?:drop\s+(?:table|schema)|truncate\b|delete\s+from\b)/im, "no destructive SQL exists");

matches(/supabase functions deploy "\$FUNCTION_SLUG"/, "only the pinned function is deployed");
assert.equal(workflow.match(/supabase functions deploy/g)?.length, 1, "one deploy command exists");
passed += 1;
matches(/--no-verify-jwt --use-api/, "existing in-function authorization mode is explicit");
matches(/list_public_wire_reports/, "anonymous Wire list is smoked");
matches(/get_public_wire_report/, "anonymous Wire detail is smoked when data exists");
matches(/forbidden=\{"analysis","uncertainties","body_private","uncertainties_private"\}/, "nested restricted fields are denied");
matches(/restricted_keys\|0/, "database response is checked for restricted keys");
matches(/if: \$\{\{ failure\(\) \}\}/, "a rollout failure triggers containment");
matches(/update public\.osi_config[\s\S]*where key='OSI_V2_WIRE_WRITES_ENABLED'/, "containment disables only the Wire write flag");
matches(/Wire writes could not be confirmed disabled/, "containment verifies the flag is false");
const smokeIndex = workflow.indexOf("Anonymous smoke proves the Edge boundary stays public-safe");
const containmentIndex = workflow.indexOf("Fail closed after any rollout or smoke failure");
assert.ok(smokeIndex > 0 && containmentIndex > smokeIndex, "containment follows the deployment smoke");
passed += 1;
const configUpdates = workflow.match(/update public\.osi_config/g) ?? [];
assert.equal(configUpdates.length, 1, "only one scoped configuration update exists");
passed += 1;
excludes(/supabase secrets (?:set|unset)|SUPABASE_DB_PASSWORD=.*echo/i, "secrets are not changed or printed");

const uses = [...workflow.matchAll(/uses:\s+\S+@(\S+)/g)].map((match) => match[1]);
assert.ok(uses.length >= 4, "required actions are present");
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
assert.ok(runBlocks.length >= 13, "all multiline shell steps are discovered");
for (const [index, script] of runBlocks.entries()) {
  const syntax = spawnSync(bash, ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, `run block ${index + 1} is valid Bash: ${syntax.stderr}`);
  passed += 1;
}

console.log(`osi-v2-wire-privacy-production-workflow: ${passed} passed, 0 failed`);
