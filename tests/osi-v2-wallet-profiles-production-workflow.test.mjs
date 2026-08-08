import assert from "node:assert/strict";
import fs from "node:fs";

const path = new URL("../.github/workflows/osi-v2-wallet-profiles-production.yml", import.meta.url);
const source = fs.readFileSync(path, "utf8");
let passed = 0;
function has(name, pattern) { assert.match(source, pattern, name); passed++; }
function before(name, first, second) {
  const a = source.indexOf(first); const b = source.indexOf(second);
  assert.ok(a >= 0 && b > a, name); passed++;
}

has("scoped workflow name", /^name: OSI V2 Wallet Profiles Production$/m);
has("manual dispatch only", /^on:\n  workflow_dispatch:/m);
has("exact project confirmation", /DEPLOY-WALLET-PROFILES-afibxpniwfnavdobecrn/);
has("dispatch input is passed through environment", /CONFIRM_INPUT: \$\{\{ github\.event\.inputs\.confirm \}\}[\s\S]*\[ "\$CONFIRM_INPUT" =/);
has("current main only", /GITHUB_REF.*refs\/heads\/main/);
has("exact migration pinned", /SLICE_MIGRATION: 20260808163737_osi_v2_wallet_profiles\.sql/);
has("exact profile function pinned", /PROFILE_FUNCTION: osi-v2-profile/);
has("exact Case read function pinned", /CASE_READ_FUNCTION: osi-v2-case-read/);
has("profile flag pinned", /PROFILE_FLAG: OSI_V2_PROFILE_WRITES_ENABLED/);
has("full Node battery", /for test in tests\/\*\.test\.js tests\/\*\.test\.mjs/);
has("both functions type checked", /deno check "supabase\/functions\/\$\{PROFILE_FUNCTION\}\/index\.ts"[\s\S]*deno check "supabase\/functions\/\$\{CASE_READ_FUNCTION\}\/index\.ts"/);
has("fresh database validation", /supabase db reset --local --no-seed/);
has("database lint", /supabase db lint --local --level error/);
has("pgTAP", /supabase test db/);
has("replay tests", /tests\/osi-v2-concurrency\.test\.sh/);
has("dry-run exact one", /supabase db push --linked --dry-run[\s\S]*\[ "\$count" = "1" \]/);
has("profile forced RLS checked", /forced_rls/);
has("browser table privileges denied", /anon_select[\s\S]*authenticated_update/);
has("no backfill asserted locally", /profile_rows\|0/);
has("production analyst count preserved", /ANALYST_COUNT_BEFORE[\s\S]*analyst_rows/);
has("unknown avatar bucket is rejected before migration", /profile avatar bucket already exists; refusing to adopt or expose unknown objects/);
has("partial profile config is rejected before migration", /Profile configuration already exists without the reviewed migration history/);
before("migration precedes deployment", "Apply exactly the wallet-profile migration", "Deploy exactly the profile and Case-read functions");
has("deploys exact two slugs", /functions deploy "\$PROFILE_FUNCTION"[\s\S]*functions deploy "\$CASE_READ_FUNCTION"/);
has("Function inventory is compared before and after", /functions-before\.json[\s\S]*non-task-before\.json[\s\S]*functions-after\.json[\s\S]*diff -u \/tmp\/non-task-before\.json \/tmp\/non-task-after\.json/);
has("deployed Functions must be active and JWT-disabled", /osi-v2-profile" and \.status=="ACTIVE" and \.verify_jwt==false[\s\S]*osi-v2-case-read" and \.status=="ACTIVE" and \.verify_jwt==false/);
has("existing Case-read version must advance", /Case-read Function version did not advance/);
before("closed-gate smoke precedes enable", "Smoke reads and fail-closed writes before enable", "Enable only owner-controlled profile writes");
has("public missing-profile smoke", /get_public_profile/);
has("owner session denied without proof", /owner_session_required/);
has("Case list and detail are smoked", /list_public_cases[\s\S]*get_public_case/);
has("Case submitter DTO has exact public allowlist", /allowed=\{'public_ref','handle','display_name','avatar_url'\}/);
has("Case detail repeats the submitter allowlist check", /public-case-detail\.json[\s\S]*body\['case'\]\.get\('submitter_profile'\)[\s\S]*allowed=\{'public_ref','handle','display_name','avatar_url'\}/);
has("flag enabled with one-row guard", /where key='\$\{PROFILE_FLAG\}' and value='false' returning 1/);
has("enabled negative smoke creates no data", /Smoke enabled gate without creating fake profile data[\s\S]*select count\(\*\) from public\.wallet_profiles where wallet='bad'/);
has("failure containment is conditional", /if: \$\{\{ failure\(\) \}\}/);
has("containment changes only profile flag", /update public\.osi_config set value='false'.*key='\$\{PROFILE_FLAG\}'/);
before("containment follows enabled smoke", "Smoke enabled gate without creating fake profile data", "Fail closed after any rollout or smoke failure");
has("immutable data retained", /immutable profile receipts and rows remain retained/);
has("no fake content contract", /creates no users, profiles, Cases, Reports, transactions or activity/);

console.log(`passed ${passed}`);
