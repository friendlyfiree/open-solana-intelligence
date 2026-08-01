import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL(
    "../.github/workflows/osi-workflow-recovery-usability-production.yml",
    import.meta.url,
  ),
  "utf8",
);

let passed = 0;
function matches(value, pattern, label) {
  assert.match(value, pattern, label);
  passed += 1;
}
function excludes(value, pattern, label) {
  assert.doesNotMatch(value, pattern, label);
  passed += 1;
}
function equal(actual, expected, label) {
  assert.equal(actual, expected, label);
  passed += 1;
}

matches(workflow, /^name: OSI Workflow Recovery and Usability Production$/m,
  "workflow has one task-scoped production name");
matches(workflow, /\bon:\n  workflow_dispatch:\n/, "workflow is manually dispatched");
excludes(workflow, /\n  (?:push|pull_request|schedule):/, "workflow has no automatic production trigger");
matches(workflow, /RECOVER-USABILITY-\$\{EXPECTED_PROJECT_REF\}/,
  "dispatch requires the project-bound confirmation phrase");
matches(workflow, /EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn/,
  "production project ref is pinned");
matches(workflow, /environment: Production/, "deployment is recorded in Production");
matches(workflow, /PROOF_DIR: \/tmp\/osi-workflow-recovery-proof/,
  "production proof uses a runner-local path valid in job-level env");
excludes(workflow, /\$\{\{\s*runner\.temp\s*\}\}/,
  "job-level env does not use the unavailable runner context");
matches(workflow, /GITHUB_REF}" = "refs\/heads\/main"/,
  "both jobs require main");
matches(workflow, /git rev-parse HEAD\)" = "\$\(git rev-parse origin\/main\)"/,
  "workflow requires the exact current origin/main commit");
matches(workflow, /git status --porcelain/, "workflow requires a clean checkout");
matches(workflow, /permissions:\n  contents: read/, "workflow token is read-only");
matches(workflow, /cancel-in-progress: false/, "a production rollout is never cancelled midway");
equal((workflow.match(/version: 2\.109\.1/g) ?? []).length, 2,
  "validation and production use the CI-pinned Supabase CLI");

matches(workflow, /NEW_VERSION: "20260729134213"/, "one migration version is pinned");
matches(workflow,
  /EXPECTED_FUNCTION_BASELINE_DIGESTS: '[^\n]*"osi-v2-report-read":"891433d28c6224c5e4fdcf8569f1297564b940aa817d7cf5d7f780e102193290"/,
  "the exact pre-rollout function digests are pinned");
matches(workflow,
  /EXPECTED_PARTIAL_FUNCTION_VERSIONS: '[^\n]*"osi-v2-report-read":19/,
  "the exact partial report-read deployment is a recognized resume snapshot");
matches(workflow,
  /EXPECTED_PARTIAL_FUNCTION_DIGESTS: '[^\n]*"osi-v2-report-read":"c38267cd8aaa3a01d8f83d218d0c673618a9a64b1a488924d21f21df9d999d24"/,
  "the partial report-read bundle digest is pinned");
matches(workflow,
  /TARGET_FUNCTION_VERSIONS: '[^\n]*"osi-v2-analyst":18[^\n]*"osi-v2-case-read":24[^\n]*"osi-v2-report-read":19[^\n]*"osi-v2-report-write":16[^\n]*"osi-v2-wire":10/,
  "the exact completed function target is pinned");
matches(workflow,
  /20260729134213_osi_v2_workflow_recovery_usability\.sql/,
  "the exact migration filename is required and nonempty");
matches(workflow,
  /BEFORE_VERSIONS:[\s\S]*20260728170000[\s\S]*AFTER_VERSIONS:[\s\S]*20260729134213/,
  "before and after histories differ by the task migration");
matches(workflow, /Remote migration history is not the exact before or resumed set/,
  "unexpected remote history fails closed");
matches(workflow, /supabase migration list --linked/,
  "local and remote migration status is recorded");
matches(workflow, /supabase db push --linked --dry-run/,
  "production migration is dry-run first");
matches(workflow, /\[ "\$got" = "\$NEW_VERSION" \]/,
  "pending dry-run must contain exactly the one approved version");
matches(workflow, /supabase db push --linked --yes/,
  "the approved additive migration can be applied");

matches(workflow, /for test in tests\/\*\.test\.js tests\/\*\.test\.mjs/,
  "all dependency-free Node tests run");
matches(workflow, /deno check "\$\{deno_sources\[@\]\}"/,
  "all Edge and shared Deno sources are checked");
matches(workflow,
  /npx playwright test --config tests\/browser\/playwright\.config\.js/,
  "browser interaction suite runs");
matches(workflow, /supabase db reset --local --no-seed/,
  "fresh migration-from-zero uses only the disposable local database");
matches(workflow, /supabase db lint --local --level error/, "database lint runs");
matches(workflow, /supabase test db/, "pgTAP runs");
matches(workflow, /tests\/osi-v2-concurrency\.test\.sh/,
  "concurrency and replay integration test runs");

matches(workflow, /scripts\/protected-row-counts\.sql/,
  "protected domain and infrastructure row counts are snapshotted");
matches(workflow,
  /md5\(value\) from public\.osi_config where key not in \('OSI_V2_CASE_WRITES_ENABLED'[^\n]*'OSI_V2_READ_SESSION_ENABLED'\) order by key/,
  "all non-task config values are compared through deterministic runner-local digests");
matches(workflow, /RUNNER_TEMP\/osi-config-before\.txt/,
  "per-key config digests stay outside the uploaded proof artifact");
matches(workflow,
  /TARGET_CASE_REF: \$\{\{ secrets\.OSI_WORKFLOW_RECOVERY_TARGET_CASE_REF \}\}[\s\S]*TARGET_REPORT_REF: \$\{\{ secrets\.OSI_WORKFLOW_RECOVERY_TARGET_REPORT_REF \}\}[\s\S]*TARGET_VERSION_REF: \$\{\{ secrets\.OSI_WORKFLOW_RECOVERY_TARGET_VERSION_REF \}\}/,
  "protected unpublished target selectors come only from repository secrets");
const validateJob = workflow.slice(
  workflow.indexOf("\n  validate:"),
  workflow.indexOf("\n  deploy:"),
);
excludes(validateJob, /OSI_WORKFLOW_RECOVERY_TARGET_/,
  "private target selectors never enter dependency installation or validation processes");
equal((workflow.match(/secrets\.OSI_WORKFLOW_RECOVERY_TARGET_CASE_REF/g) ?? []).length, 4,
  "the Case selector secret is scoped only to the four production steps that need it");
equal((workflow.match(/secrets\.OSI_WORKFLOW_RECOVERY_TARGET_REPORT_REF/g) ?? []).length, 3,
  "the Report selector secret is scoped only to the three production steps that need it");
equal((workflow.match(/secrets\.OSI_WORKFLOW_RECOVERY_TARGET_VERSION_REF/g) ?? []).length, 3,
  "the version selector secret is scoped only to the three production steps that need it");
matches(workflow,
  /TARGET_CASE_REF" =~ \^OSI-\[0-9A-F\]\{12\}\$[\s\S]*TARGET_REPORT_REF" =~ \^OSI-RPT-\[0-9A-F\]\{12\}\$[\s\S]*TARGET_VERSION_REF" =~ \^OSI-RV-\[0-9A-F\]\{16\}\$/,
  "all protected selector secrets are shape-validated before use");
excludes(workflow, /OSI-RPT-[0-9A-F]{12}|OSI-RV-[0-9A-F]{16}/,
  "no concrete unpublished Report or version reference enters Git history");
matches(workflow,
  /diff -u\s+\\?\s*"\$PROOF_DIR\/protected-rows-before\.txt"\s+\\?\s*"\$PROOF_DIR\/protected-rows-after\.txt"/,
  "protected row counts must remain unchanged");
matches(workflow,
  /diff -u\s+\\?\s*"\$RUNNER_TEMP\/osi-target-record-before\.txt"\s+\\?\s*"\$RUNNER_TEMP\/osi-target-record-after\.txt"/,
  "the protected Report selected invariants must remain unchanged");
matches(workflow,
  /target-row-hashes-before\.txt[\s\S]*to_jsonb\(case_item\)[\s\S]*to_jsonb\(report\)[\s\S]*to_jsonb\(version\)[\s\S]*evidence_links[\s\S]*evidence_items[\s\S]*reviews/,
  "the complete protected Case, Report, version, evidence, and review rows are hashed");
matches(workflow,
  /diff -u\s+\\?\s*"\$RUNNER_TEMP\/osi-target-row-hashes-before\.txt"\s+\\?\s*"\$RUNNER_TEMP\/osi-target-row-hashes-after\.txt"/,
  "complete protected target row hashes must remain unchanged");
matches(workflow,
  /diff -u\s+\\?\s*"\$RUNNER_TEMP\/osi-config-before\.txt"\s+\\?\s*"\$RUNNER_TEMP\/osi-config-after\.txt"/,
  "all non-task feature and config values must remain unchanged");
excludes(workflow, /PROOF_DIR\/(?:config|target-row-hashes)-(?:before|after)\.txt/,
  "sensitive-derived comparison digests are not uploaded");
excludes(workflow, /PROOF_DIR\/target-record-(?:before|after)\.txt/,
  "protected unpublished target selectors stay outside uploaded artifacts");
excludes(workflow, /echo "target_(?:report|version)=/,
  "protected unpublished target selectors are absent from summaries and receipts");
matches(workflow,
  /EXPECTED_FUNCTION_VERSIONS: '\{"osi-v2-analyst":17,"osi-v2-case-read":23,"osi-v2-report-read":18,"osi-v2-report-write":15,"osi-v2-wire":9\}'/,
  "all five exact production function baselines are pinned");
matches(workflow,
  /function_rollout_mode="\$\(jq -r[\s\S]*\$versions == \$baseline_versions and \$digests == \$baseline_digests[\s\S]*\$versions == \$partial_versions and \$digests == \$partial_digests/,
  "the function snapshot must match an exact baseline or pinned partial-resume state");

matches(workflow,
  /osi_v2_report_evidence_manifest\('\[\]'::jsonb\)[\s\S]*is distinct from '\[\]'::jsonb/,
  "production gate requires the exact canonical empty manifest");
matches(workflow,
  /osi_v2_report_manifest_hash\('\[\]'::jsonb\)[\s\S]*extensions\.digest\(convert_to\('\[\]', 'UTF8'\), 'sha256'\)/,
  "production gate requires deterministic empty-manifest hashing");
matches(workflow,
  /public\.osi_v2_report_publication_capabilities\(text,uuid\[\],text\)/,
  "the exact public capability signature is verified");
matches(workflow,
  /osi_private\.osi_v2_report_publication_capabilities\(text,uuid\[\],text\)/,
  "the exact private capability signature is verified");
matches(workflow,
  /has_function_privilege\(\s*'anon',[\s\S]*osi_v2_report_publication_capabilities/,
  "anonymous direct RPC execution is checked");
matches(workflow,
  /has_function_privilege\(\s*'authenticated',[\s\S]*osi_v2_report_publication_capabilities/,
  "authenticated direct RPC execution is checked");
matches(workflow,
  /has_function_privilege\(\s*'service_role',[\s\S]*osi_v2_report_publication_capabilities/,
  "service-role RPC execution is checked");
matches(workflow,
  /relation\.relname in \([\s\S]*'cases'[\s\S]*'case_reports'[\s\S]*'case_report_versions'[\s\S]*'case_report_reviews'/,
  "RLS is checked across the Report path");

const containmentStart = workflow.indexOf("Enter task-scoped fail-closed rollout containment");
const deployStart = workflow.indexOf("Deploy and attest exactly the five changed Edge Functions");
const deployEnd = workflow.indexOf("Non-mutating production HTTP and site smokes");
assert.ok(deployStart >= 0 && deployEnd > deployStart, "deployment block exists");
passed += 1;
assert.ok(containmentStart >= 0 && containmentStart < deployStart,
  "task-scoped gates enter fail-closed containment before sequential deployment");
passed += 1;
const deployBlock = workflow.slice(deployStart, deployEnd);
for (const functionName of [
  "osi-v2-analyst",
  "osi-v2-case-read",
  "osi-v2-report-read",
  "osi-v2-report-write",
  "osi-v2-wire",
]) {
  matches(deployBlock, new RegExp(functionName), `${functionName} is deployed`);
}
for (const forbidden of [
  "osi-v2-case-write",
  "osi-v2-payment",
  "osi-v2-proof",
  "osi-v2-ai-pack",
  "osi-v2-governance-write",
]) {
  excludes(deployBlock, new RegExp(forbidden), `${forbidden} is outside deployment scope`);
}
equal((deployBlock.match(/supabase functions deploy/g) ?? []).length, 1,
  "one bounded loop owns all function deployments");
matches(deployBlock, /expected_version "\$\(\(baseline_version \+ 1\)\)"/,
  "each newly deployed function must attest the exact task-target version");
matches(deployBlock, /\.ezbr_sha256!=\$before_digest/,
  "each deployed bundle digest must differ from its exact baseline");
matches(deployBlock, /\.updated_at\|normalized_epoch[\s\S]*\$started\|normalized_epoch/,
  "each deployed function must have a rollout-time update timestamp");
matches(deployBlock,
  /type == "number"[\s\S]*100000000000[\s\S]*\. \/ 1000 \| floor/,
  "millisecond numeric Supabase function timestamps normalize to epoch seconds");
matches(deployBlock,
  /type == "string"[\s\S]*fromdateiso8601/,
  "ISO Supabase function timestamps remain supported");
matches(deployBlock,
  /FUNCTION_ROLLOUT_MODE" = "partial_report_read"[\s\S]*function_name" = "osi-v2-report-read"[\s\S]*continue/,
  "the exact attested partial report-read deployment is not redeployed");
matches(deployBlock,
  /--argjson target_versions "\$TARGET_FUNCTION_VERSIONS"[\s\S]*\$target_versions/,
  "the final five-function snapshot must equal the exact task target");

const smokeStart = workflow.indexOf("Non-mutating production HTTP and site smokes");
const smokeEnd = workflow.indexOf(
  "Read-only analyst and server-projected maintainer capability proof",
);
assert.ok(smokeStart >= 0 && smokeEnd > smokeStart, "HTTP smoke block exists");
passed += 1;
const smokeBlock = workflow.slice(smokeStart, smokeEnd);
matches(smokeBlock, /-X GET "\$base\/osi-v2-case-read"/,
  "Case-read reachability uses a non-mutating method rejection");
matches(smokeBlock, /list_public_reports/,
  "Report-read smoke uses only the public projection");
matches(smokeBlock, /\\"op\\":\\"capabilities\\"/,
  "Report-write smoke uses only its read-only capability operation");
matches(smokeBlock, /osi-v2-analyst[\s\S]*rollout_status/,
  "the changed analyst bundle receives a read-only rollout smoke");
matches(smokeBlock, /osi-v2-wire[\s\S]*wire_writes_enabled/,
  "the changed Wire bundle receives a read-only capability smoke");
excludes(smokeBlock,
  /(?:issue_(?:read_)?challenge|issue_read_session|create_read_session|prepare_|commit_|list_my_|list_review_queue)/,
  "production HTTP smoke issues no nonce, session, private read, or write");
matches(smokeBlock, /protected_unpublished_target_absent/,
  "anonymous smoke proves the protected unpublished Report is absent");
matches(smokeBlock, /legacy\.html/, "legacy route remains reachable");
matches(smokeBlock, /v2-preview\.html/, "retired preview remains a permanent redirect");

const capabilityStart = workflow.indexOf(
  "Read-only analyst and server-projected maintainer capability proof",
);
const capabilityEnd = workflow.indexOf(
  "Verify restored config values protected target and exact function snapshot",
);
assert.ok(capabilityStart >= 0 && capabilityEnd > capabilityStart,
  "actor capability proof block exists");
passed += 1;
const capabilityBlock = workflow.slice(capabilityStart, capabilityEnd);
equal((capabilityBlock.match(/begin read only;/g) ?? []).length, 4,
  "all four actor capability projections are transactionally read-only");
matches(capabilityBlock, /can_cast_analyst_review==true/,
  "an independent eligible analyst is accepted when one exists");
matches(capabilityBlock,
  /independent_eligible_available false[\s\S]*can_cast_analyst_review==false[\s\S]*analyst_review_reason_code==\$reason/,
  "an eligible conflicted analyst is proved fail-closed when no independent analyst exists");
matches(capabilityBlock,
  /analyst_review_reason_code==\$reason[\s\S]*standard_publication_reason_code==\$reason/,
  "a target conflict blocks both review and standard publication with the exact reason");
matches(capabilityBlock, /report_author_conflict[\s\S]*case_owner_conflict/,
  "both target-specific analyst conflicts are derived from production data");
matches(capabilityBlock, /can_publish_via_maintainer_bootstrap==true/,
  "the database projection proves the conditional bootstrap decision");
matches(capabilityBlock, /decision_channel=="maintainer_bootstrap"/,
  "bootstrap channel is explicit");
matches(capabilityBlock, /database_projection_edge_gate_not_invoked/,
  "maintainer proof scope explicitly says the authenticated Edge gate was not invoked");
matches(capabilityBlock, /authenticated_maintainer_edge_session_invoked=false/,
  "the proof does not claim a real authenticated maintainer Edge session");
matches(capabilityBlock, /edge_gate_verified=false[\s\S]*auth_identity_verified=false/,
  "the proof explicitly records that neither Edge gate nor auth identity was verified");
matches(capabilityBlock, /uuid_marker_is_real_auth_identity=false/,
  "the synthetic UUID marker is not mislabeled as an authenticated identity");
equal((capabilityBlock.match(/maintainer_double_gate_required/g) ?? []).length, 2,
  "wallet-only and non-admin-wallet UUID-marker paths are both denied");
excludes(capabilityBlock, /maintainer-auth-only-capability/,
  "the synthetic UUID-marker projection is not mislabeled auth-only");

const productionBlock = workflow.slice(workflow.indexOf("\n  deploy:"));
excludes(productionBlock, /^\s*(?:drop\s+(?:table|schema)|truncate\b|delete\s+from\b)/im,
  "production workflow contains no destructive SQL");
excludes(productionBlock, /supabase\s+(?:db reset|migration repair)/,
  "production job contains no reset or migration repair");
matches(productionBlock,
  /task_gates_true[\s\S]*task_gates_false[\s\S]*rollout_start_mode="live"[\s\S]*rollout_start_mode="contained_resume"/,
  "the seven task gates must be uniformly live or uniformly fail-closed");
matches(productionBlock,
  /function_rollout_mode" = "partial_report_read"[\s\S]*rollout_start_mode" != "contained_resume"/,
  "a partial function snapshot is accepted only while every task gate is contained");
const taskGates = [
  "OSI_V2_CASE_WRITES_ENABLED",
  "OSI_V2_ANALYST_WRITES_ENABLED",
  "OSI_V2_REPORT_WRITES_ENABLED",
  "OSI_V2_REPORT_REVIEW_WRITES_ENABLED",
  "OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED",
  "OSI_V2_WIRE_WRITES_ENABLED",
  "OSI_V2_READ_SESSION_ENABLED",
];
const containmentBlock = workflow.slice(
  containmentStart,
  workflow.indexOf("Deploy and attest exactly the five changed Edge Functions"),
);
for (const gate of taskGates) {
  matches(containmentBlock, new RegExp(gate), `${gate} is included in rollout containment`);
}
matches(containmentBlock,
  /case "\$ROLLOUT_START_MODE" in[\s\S]*live\) expected_gate_value="true"[\s\S]*contained_resume\) expected_gate_value="false"/,
  "containment derives the exact expected gate state from the rollout start mode");
matches(containmentBlock,
  /set_config\([\s\S]*'osi\.rollout\.expected_gate_value'[\s\S]*:'expected_gate_value'[\s\S]*current_setting\('osi\.rollout\.expected_gate_value'\)/,
  "containment binds its expected gate state inside the same database transaction");
matches(containmentBlock, /config\.value is distinct from expected_gate_value/,
  "containment validates live and contained-resume gate snapshots without weakening either");
matches(containmentBlock, /and value is distinct from 'false'/,
  "contained-resume containment does not rewrite already-false gate rows");
excludes(containmentBlock, /where config\.value is distinct from 'true'/,
  "containment does not unconditionally require live gates during a contained resume");
matches(containmentBlock, /and value = 'false'[\s\S]*\[ "\$contained" = "7" \]/,
  "containment verifies all seven task-scoped gates are false");
matches(containmentBlock, /OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED[\s\S]*= "true"/,
  "containment preserves SAS enforcement");
const restoreBlock = workflow.slice(
  workflow.indexOf("Restore exact task-scoped live gates after contained smokes"),
  workflow.indexOf("Read-only analyst and server-projected maintainer capability proof"),
);
for (const gate of taskGates) {
  matches(restoreBlock, new RegExp(gate), `${gate} is restored after contained smokes`);
}
matches(restoreBlock, /and value = 'true'[\s\S]*= "7"/,
  "restore verifies all seven task-scoped gates are true");
matches(restoreBlock, /report_writes_enabled==true[\s\S]*report_review_writes_enabled==true[\s\S]*analyst_writes_enabled==true[\s\S]*wire_writes_enabled==true/,
  "restored Edge capability smokes confirm the task-scoped write routes");
const failureBlock = workflow.slice(
  workflow.indexOf("Fail closed and stop for an immutable forward fix on rollout error"),
  workflow.indexOf("Upload sanitized production proof"),
);
for (const gate of taskGates) {
  matches(failureBlock, new RegExp(gate), `${gate} is included in failure containment`);
}
matches(failureBlock, /and value = 'false'[\s\S]*= "7"/,
  "failure containment verifies all seven task-scoped gates are false");
matches(failureBlock, /OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED[\s\S]*= "true"/,
  "failure containment preserves SAS enforcement");
matches(failureBlock,
  /psql -v ON_ERROR_STOP=1 -Atq <<'SQL'[\s\S]*\n          SQL\n            \[ "\$\(psql/,
  "failure containment closes its heredoc at the generated shell column zero");
excludes(failureBlock,
  /\n            SQL\n            \[ "\$\(psql/,
  "failure containment never indents the shell heredoc delimiter");
matches(productionBlock, /one focused forward-fix PR/,
  "failure path requires a focused forward fix");
matches(productionBlock, /Do not retry until that PR merges/,
  "failure path prevents blind repeated retries");
matches(productionBlock, /solana_transactions_created=0/,
  "receipt records no Solana transaction");
matches(productionBlock, /prepare_or_commit_calls=0/,
  "receipt records no prepare/commit call");
matches(productionBlock, /signed_queue_calls=0/,
  "receipt records no signed analyst or maintainer queue call");
matches(productionBlock,
  /maintainer_capability_scope=database_projection_edge_gate_not_invoked/,
  "receipt names the exact maintainer capability boundary");
matches(productionBlock,
  /maintainer_edge_gate_verified=false[\s\S]*maintainer_auth_identity_verified=false/,
  "receipt preserves the unverified live maintainer boundary");
excludes(productionBlock, /service projection after the Edge double gate/,
  "delivery summary does not overclaim a full maintainer Edge proof");
matches(productionBlock, /provider_generation_calls=0/,
  "receipt records no provider generation");
matches(productionBlock, /feature_flags=seven task-scoped gates temporarily false then restored exactly/,
  "successful receipt reports temporary containment and exact restoration honestly");
matches(productionBlock, /jq -e --slurp '\.\[0\] == \.\[1\]'/,
  "final function snapshot must exactly equal the attested post-deployment snapshot");
matches(productionBlock, /actions\/upload-artifact@[0-9a-f]{40}/,
  "sanitized proof is retained with a SHA-pinned action");

const uses = [...workflow.matchAll(/uses:\s+\S+@(\S+)/g)].map((match) => match[1]);
assert.ok(uses.length >= 6, "workflow uses pinned reusable actions");
assert.ok(uses.every((ref) => /^[0-9a-f]{40}$/.test(ref)),
  "every reusable action is pinned to a full commit SHA");
passed += 2;

console.log(
  `osi-workflow-recovery-usability-production-workflow: ${passed} passed, 0 failed`,
);
