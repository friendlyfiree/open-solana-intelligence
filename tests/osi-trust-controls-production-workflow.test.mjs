import assert from "node:assert/strict";
import fs from "node:fs";

const path = new URL("../.github/workflows/osi-trust-controls-production.yml", import.meta.url);
const source = fs.readFileSync(path, "utf8");
let passed = 0;
function has(name, pattern) { assert.match(source, pattern, name); passed++; }
function lacks(name, pattern) { assert.doesNotMatch(source, pattern, name); passed++; }
function before(name, first, second) {
  const a = source.indexOf(first); const b = source.indexOf(second);
  assert.ok(a >= 0 && b > a, name); passed++;
}

has("scoped workflow name", /^name: OSI Trust Controls Production$/m);
has("manual dispatch only", /^on:\n  workflow_dispatch:/m);
has("exact project confirmation", /DEPLOY-TRUST-CONTROLS-afibxpniwfnavdobecrn/);
has("current main only", /GITHUB_REF.*refs\/heads\/main/);
has("governance migration pinned", /GOVERNANCE_MIGRATION: 20260809091827_governance_bootstrap_challenge_controls\.sql/);
has("Report body migration pinned", /REPORT_BODY_MIGRATION: 20260809200000_osi_v2_published_report_body_is_public\.sql/);
has("full Node battery", /for test in tests\/\*\.test\.js tests\/\*\.test\.mjs/);
has("fresh database", /supabase db reset --local --no-seed/);
has("database lint", /supabase db lint --local --level error/);
has("pgTAP", /supabase test db/);
has("replay suite", /tests\/osi-v2-concurrency\.test\.sh/);
has("only exact safe resume suffixes", /GOVERNANCE_VERSION.*REPORT_BODY_VERSION[\s\S]*REPORT_BODY_VERSION.*\|""/);
has("extra remote migrations denied", /Production contains migration versions absent from current main/);
has("dry-run precedes push", /supabase db push --linked --dry-run/);
has("dry-run exact filenames", /Dry-run mismatch/);
has("additive push", /supabase db push --linked --yes/);
before("dry-run precedes write", "Dry-run exactly the pending in-scope migrations", "Apply only the dry-run-approved additive migrations");
has("protected rows compared", /protected-before\.txt[\s\S]*protected-after\.txt[\s\S]*diff -u \/tmp\/protected-before\.txt \/tmp\/protected-after\.txt/);
has("all configuration compared", /config-before\.txt[\s\S]*config-after\.txt[\s\S]*diff -u \/tmp\/config-before\.txt \/tmp\/config-after\.txt/);
has("two-review count verified", /report_count\|2/);
has("probationary pair weight verified", /report_weight\|1\.00/);
has("published body column verified", /body_column\|true/);
has("governance browser roles denied", /anon_capability\|false[\s\S]*authenticated_capability\|false/);
has("service role retained", /service_capability\|true/);
lacks("no Edge Function deploy", /supabase functions deploy/);
lacks("no feature flag mutation", /update public\.osi_config/);
lacks("no destructive SQL", /\b(?:drop|truncate|delete)\s+(?:table|schema|from)\b/i);
has("forward-fix rollback", /Rollback is a focused additive forward fix/);

console.log(`passed ${passed}`);
