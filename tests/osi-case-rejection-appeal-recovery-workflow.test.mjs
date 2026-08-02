import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL(
  "../.github/workflows/osi-case-rejection-appeal-recovery-production.yml",
  import.meta.url,
), "utf8");

let passed = 0;
function matches(pattern, message) {
  assert.match(workflow, pattern, message);
  passed += 1;
}
function excludes(pattern, message) {
  assert.doesNotMatch(workflow, pattern, message);
  passed += 1;
}

matches(/workflow_dispatch:/, "recovery is manual-only");
matches(/RECOVER-CASE-REJECTION-APPEAL-\$\{EXPECTED_PROJECT_REF\}/, "exact typed recovery phrase is required");
matches(/\[ "\$GITHUB_REF" = 'refs\/heads\/main' \]/, "recovery is main-only");
matches(/git rev-parse origin\/main/, "current main is rechecked");
matches(/EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn/, "production project is pinned");
matches(/EXPECTED_VERSION: '20260802180000'/, "installed migration is pinned");
matches(/supabase db push --linked --dry-run/, "zero migration delta is proven");
excludes(/supabase db push --linked --yes/, "recovery applies no migration");
excludes(/supabase functions deploy/, "recovery deploys no Function");
matches(/where key='OSI_V2_CASE_WRITES_ENABLED'"\)" = false/, "recovery begins only from the contained flag state");
matches(/\[ "\$code" = 503 \]/, "contained fail-closed response is proven");
matches(/set value='true'.*OSI_V2_CASE_WRITES_ENABLED/, "only the Case flag is restored");
matches(/\[ "\$code" = 400 \]/, "live invalid payload validation is proven");
matches(/list_public_cases/, "public Case privacy smoke remains covered");
matches(/scripts\/protected-row-counts\.sql/, "protected domain rows are compared");
matches(/all-functions-before\.json/, "all deployed Functions are snapshotted");
matches(/diff -u "\$PROOF_DIR\/all-functions-before\.json"/, "no Function mutation is required");
matches(/if: failure\(\)/, "failure containment is explicit");
matches(/set value='false'.*OSI_V2_CASE_WRITES_ENABLED/, "failure returns Case writes to false");
matches(/actionlint" \.github\/workflows\/osi-case-rejection-appeal-recovery-production\.yml/, "workflow syntax is linted");
matches(/supabase test db/, "database authorization suite is rerun");
matches(/tests\/osi-v2-concurrency\.test\.sh/, "replay and concurrency are rerun");

console.log(`osi-case-rejection-appeal-recovery-workflow: ${passed} passed, 0 failed`);
