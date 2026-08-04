import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL(
  "../.github/workflows/archive/osi-case-rejection-appeal-production.yml",
  import.meta.url,
), "utf8");

let passed = 0;
function matches(pattern, message) {
  assert.match(workflow, pattern, message);
  passed += 1;
}

matches(/workflow_dispatch:/, "rollout remains manual");
matches(/CASE-REJECTION-APPEAL-\$\{EXPECTED_PROJECT_REF\}/, "exact production confirmation is required");
matches(/\[ "\$GITHUB_REF" = 'refs\/heads\/main' \]/, "dispatch is restricted to main");
matches(/git rev-parse origin\/main/, "dispatched commit must still be current main");
matches(/EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn/, "production project is pinned");
matches(/NEW_VERSION: '20260802180000'/, "the exact additive migration is pinned");
matches(/supabase db push --linked --dry-run/, "production migration is dry-run first");
matches(/if \[ "\$ROLLOUT_MODE" = deploy \]; then supabase db push --linked --yes; fi/, "only the approved pending migration is applied");
matches(/supabase functions deploy "\$FUNCTION_SLUG"/, "the task function is deployed");
matches(/FUNCTION_SLUG: osi-v2-case-write/, "deployment scope is only Case write");
matches(/OSI_V2_CASE_WRITES_ENABLED' and value='true'/, "Case writes are contained before mutation");
matches(/OSI_V2_CASE_WRITES_ENABLED' and value='false'/, "Case writes are restored after proof");
matches(/if: failure\(\)/, "fail-closed recovery is explicit");
matches(/prepare_case_rejection/, "rejection RPC contract is verified");
matches(/prepare_case_appeal/, "appeal RPC contract is verified");
matches(/anon_denied\|true/, "anonymous execution denial is verified");
matches(/auth_denied\|true/, "authenticated direct execution denial is verified");
matches(/service_allowed\|true/, "service-only execution is verified");
matches(/\[ "\$code" = 503 \]/, "contained writes fail closed before payload validation");
matches(/\[ "\$invalid_code" = 400 \]/, "live writes reject invalid payloads at validation");
matches(/scripts\/protected-row-counts\.sql/, "protected domain rows are compared");
matches(/slug!="osi-v2-case-write"/, "non-task functions are compared");
matches(/npx playwright test --config tests\/browser\/playwright\.config\.js/, "full browser proof is required");
matches(/supabase test db/, "database authorization and lifecycle suite is required");
matches(/tests\/osi-v2-concurrency\.test\.sh/, "concurrency and replay suite is required");
matches(/actionlint" \.github\/workflows\/osi-case-rejection-appeal-production\.yml/, "workflow syntax is linted");

console.log(`osi-case-rejection-appeal-production-workflow: ${passed} passed, 0 failed`);
