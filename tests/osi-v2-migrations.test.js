// Dependency-free structural regression tests for the OSI V2 foundation SQL.
// Run: node tests/osi-v2-migrations.test.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const migrationDir = path.join(root, 'supabase', 'migrations');
const migrationFiles = fs.readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const expectedFiles = [
  '20260711092711_osi_v2_additive_schema.sql',
  '20260711092852_osi_v2_integrity_guards.sql',
  '20260711092856_osi_v2_default_deny.sql',
  '20260711182949_osi_v2_stage5_nonce_receipts.sql',
  '20260712002518_osi_v2_legacy_classification.sql',
  '20260712121301_osi_v2_legacy_materialization.sql',
  '20260713045903_osi_v2_case_lifecycle.sql',
  '20260713184533_osi_v2_analyst_activation.sql',
  '20260714044036_osi_v2_case_report_intake.sql',
  '20260714064501_osi_v2_report_review_publication.sql',
  '20260714082218_osi_v2_resolution_challenge_seal.sql',
  '20260715053828_osi_v2_native_sol_payments.sql',
  '20260715112621_osi_v2_shared_read_session.sql',
];

const sqlByFile = Object.fromEntries(
  migrationFiles.map((name) => [
    name,
    fs.readFileSync(path.join(migrationDir, name), 'utf8'),
  ]),
);
const schema = sqlByFile[expectedFiles[0]] || '';
const integrity = sqlByFile[expectedFiles[1]] || '';
const deny = sqlByFile[expectedFiles[2]] || '';
const lifecycle = sqlByFile['20260713045903_osi_v2_case_lifecycle.sql'] || '';
const analystActivation = sqlByFile['20260713184533_osi_v2_analyst_activation.sql'] || '';
const reportIntake = sqlByFile['20260714044036_osi_v2_case_report_intake.sql'] || '';
const resolutionLifecycle = sqlByFile['20260714082218_osi_v2_resolution_challenge_seal.sql'] || '';
const nativePayments = sqlByFile['20260715053828_osi_v2_native_sol_payments.sql'] || '';
const sharedReadSession = sqlByFile['20260715112621_osi_v2_shared_read_session.sql'] || '';
const allSql = migrationFiles.map((name) => sqlByFile[name]).join('\n');
const config = fs.readFileSync(path.join(root, 'supabase', 'config.toml'), 'utf8');
const analystProductionWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'osi-v2-analyst-production.yml'),
  'utf8',
);
const reportProductionWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'osi-v2-report-production.yml'),
  'utf8',
);
const resolutionProductionWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'osi-v2-resolution-production.yml'),
  'utf8',
);
const paymentProductionWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'osi-v2-payment-production.yml'),
  'utf8',
);
const readSessionProductionWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'osi-v2-read-session-production.yml'),
  'utf8',
);
const proofCore = fs.readFileSync(
  path.join(root, 'supabase', 'functions', '_shared', 'osi-v2-proof-core.mjs'),
  'utf8',
);

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) {
    pass += 1;
    return;
  }
  fail += 1;
  console.error('FAIL ' + name + (detail ? ' :: ' + detail : ''));
}

ok(
  'resolution lifecycle PL/pgSQL blocks use terminated END statements',
  !/\nend\r?\n\$\$;/.test(resolutionLifecycle),
);
ok(
  'governance commit parenthesizes CASE inside its PL/pgSQL IF condition',
  resolutionLifecycle.includes(
    "bound.purpose is distinct from (case when challenge_quorum.outcome = 'accept'",
  ) && !/bound\.purpose\s+is\s+distinct\s+from\s+case\b/i.test(resolutionLifecycle),
);
ok(
  'extended review receipt binder preserves uncounted maintainer application reviews',
  /maintainer_review\s*:=\s*\([\s\S]*tg_table_name\s*=\s*'analyst_application_reviews'[\s\S]*new\.weight\s*=\s*0[\s\S]*if\s+maintainer_review\s+and\s+receipt\.actor_role/i
    .test(resolutionLifecycle),
);

ok(
  'exact ordered migration set',
  JSON.stringify(migrationFiles) === JSON.stringify(expectedFiles),
  migrationFiles.join(', '),
);

ok(
  'shared read session is additive stateless infrastructure and starts fail closed',
  sharedReadSession.includes("values ('OSI_V2_READ_SESSION_ENABLED', 'false'")
    && !/create\s+table|alter\s+table|drop\s+|truncate\s+/i.test(sharedReadSession),
);
ok(
  'shared read-session rollout is exact main-only and fail-closed',
  readSessionProductionWorkflow.includes('READ-SESSION-DEPLOY-${EXPECTED_PROJECT_REF}')
    && readSessionProductionWorkflow.includes('refs/heads/main')
    && readSessionProductionWorkflow.includes('supabase db push --linked --dry-run')
    && readSessionProductionWorkflow.includes('functions deploy osi-v2-case-read')
    && readSessionProductionWorkflow.includes('functions deploy osi-v2-report-read')
    && readSessionProductionWorkflow.includes('functions deploy osi-v2-analyst')
    && readSessionProductionWorkflow.includes("where key='OSI_V2_READ_SESSION_ENABLED' and value='true'"),
);

for (const name of expectedFiles) {
  const sql = sqlByFile[name] || '';
  ok(
    name + ' is atomic',
    /^\s*(?:--[^\n]*\n|\s)*begin;/i.test(sql)
      && /commit;\s*$/i.test(sql),
  );
  ok(name + ' has a lock timeout', /set\s+local\s+lock_timeout\s*=\s*'5s'/i.test(sql));
}

ok('local seed execution is disabled', /\[db\.seed\][\s\S]*?enabled\s*=\s*false/i.test(config));
for (const functionName of [
  'osi-analyst-intake', 'osi-ai-pack', 'osi-v2-analyst',
  'osi-v2-report-write', 'osi-v2-report-read',
  'osi-v2-governance-write',
  'osi-v2-payment',
]) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  ok(
    functionName + ' custom auth config is explicit',
    new RegExp(
      '\\[functions\\.' + escaped + '\\][\\s\\S]*?verify_jwt\\s*=\\s*false',
      'i',
    ).test(config),
  );
}
ok(
  'osi-v2-proof custom wallet auth config is explicit',
  /\[functions\.osi-v2-proof\][\s\S]*?verify_jwt\s*=\s*false/i.test(config),
);

const logicalDomainTables = [
  'cases',
  'case_reports',
  'case_report_versions',
  'wire_reports',
  'wire_report_versions',
  'evidence_items',
  'case_evidence_links',
  'case_report_version_evidence',
  'wire_report_version_evidence',
  'ai_pack_version_evidence',
  'case_initial_reviews',
  'case_report_reviews',
  'wire_report_reviews',
  'resolution_reviews',
  'challenge_reviews',
  'ai_pack_reviews',
  'analyst_application_reviews',
  'case_resolutions',
  'challenges',
  'analyst_applications',
  'analyst_application_versions',
  'analyst_profiles',
  'analyst_contributions',
  'analyst_reputation_snapshots',
  'ai_packs',
  'ai_pack_versions',
  'ai_pack_owner_feedback',
  'reward_pledges',
  'reward_payments',
  'support_events',
  'event_receipts',
  'osi_config',
];
const infraTables = [
  'osi_nonces',
  'osi_read_nonces',
  'migration_crosswalk',
  'migration_manual_queue',
];
const expectedPhysicalTables = logicalDomainTables
  .map((name) => name === 'challenges' ? 'challenges_v2' : name)
  .concat(infraTables)
  .sort();

const createdTables = [...allSql.matchAll(
  /create\s+table(?:\s+if\s+not\s+exists)?\s+public\.([a-z0-9_]+)/gi,
)].map((match) => match[1]).sort();

ok('32 logical domain tables', logicalDomainTables.length === 32);
ok('4 separate infrastructure tables', infraTables.length === 4);
ok(
  '36 expected physical tables represented',
  JSON.stringify(createdTables) === JSON.stringify(expectedPhysicalTables),
  createdTables.join(', '),
);
ok(
  'V1 challenge collision uses challenges_v2',
  schema.includes('create table public.challenges_v2')
    && !schema.includes('create table public.challenges ('),
);

const withoutLineComments = allSql.replace(/--[^\n]*/g, '');
const destructivePatterns = [
  /\bdrop\s+(table|schema|column|type)\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b/i,
  /\balter\s+table\s+public\.(reports|bounties|challenges|vouches|onchain_events|analysts|escalation_packs)\b/i,
];
for (const pattern of destructivePatterns) {
  ok('no destructive SQL: ' + pattern, !pattern.test(withoutLineComments));
}

for (const table of expectedPhysicalTables.filter((name) => name !== 'osi_config')) {
  ok(
    'default-deny list includes ' + table,
    deny.includes("'" + table + "'")
      || (table === 'osi_read_nonces'
        && /alter table public\.osi_read_nonces enable row level security/i.test(lifecycle)
        && /alter table public\.osi_read_nonces force row level security/i.test(lifecycle)
        && /revoke all privileges on table public\.osi_read_nonces from public, anon, authenticated/i.test(lifecycle)),
  );
}
ok(
  'RLS is enabled and forced dynamically',
  deny.includes('enable row level security')
    && deny.includes('force row level security'),
);
ok(
  'anon/authenticated privileges revoked',
  deny.includes('from public, anon, authenticated'),
);
ok(
  'service role receives explicit table access',
  deny.includes('to service_role'),
);
ok('no permissive policy in foundation slice', !/create\s+policy/i.test(deny));

for (const key of [
  'OSI_V2_SCHEMA_READY',
  'OSI_V2_WRITES_ENABLED',
  'OSI_V2_FALLBACK_GOVERNANCE',
]) {
  const keyPattern = new RegExp(
    "\\('" + key + "',\\s*'false'",
    'i',
  );
  ok(key + ' fails closed', keyPattern.test(deny));
}
ok(
  'write flag is never seeded true',
  !/\('OSI_V2_WRITES_ENABLED',\s*'true'/i.test(allSql),
);

const classMatches = [...allSql.matchAll(
  /when\s+p_event_type\s*=\s*any\s*\(array\[([\s\S]*?)\]::text\[\]\)\s*then\s*'([^']+)'/g,
)];
const registry = {};
for (const match of classMatches) {
  registry[match[2]] = [...match[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)]
    .map((event) => event[1]);
}
ok(
  '28 class-B events',
  (registry.wallet_signed_server_verified || []).length === 28,
);
ok('34 class-A events', (registry.solana_memo || []).length === 34);
ok('8 system events', (registry.system_event || []).length === 8);
const allEvents = Object.values(registry).flat();
ok('70 canonical events', allEvents.length === 70);
ok('canonical event classes do not overlap', new Set(allEvents).size === 70);
ok('native payment migration starts only its dedicated flag false',
  /\('OSI_V2_PAYMENT_WRITES_ENABLED',\s*'false'/i.test(nativePayments)
    && !/\('OSI_V2_PAYMENT_WRITES_ENABLED',\s*'true'/i.test(nativePayments));
ok('native payment tables remain FORCE RLS and browser-default-deny',
  ['reward_pledges', 'reward_payments', 'support_events'].every((table) =>
    nativePayments.includes(`alter table public.${table} force row level security`))
    && /revoke all privileges on table public\.reward_pledges,public\.reward_payments,public\.support_events\s+from public,anon,authenticated/i.test(nativePayments));
ok('payment submission, finalization and failure state remain service-role only',
  ['osi_v2_record_payment_submission', 'osi_v2_commit_payment', 'osi_v2_record_payment_failure']
    .every((name) => new RegExp(
      `revoke all privileges on function public\\.${name}\\([^;]+from public,anon,authenticated`,
      'i',
    ).test(nativePayments)));
ok('pledge signature guard uses a PostgreSQL-safe Ed25519 base64 length bound',
  nativePayments.includes("p_signature !~ '^[A-Za-z0-9+/=_-]{80,100}$'")
    && !nativePayments.includes('{64,256}'));
ok('native payment events use exact Class B pledge and Class A transfer proofs',
  ['REWARD_PLEDGE_CREATED', 'REWARD_PLEDGE_REVISED', 'REWARD_PLEDGE_WITHDRAWN']
    .every((event) => (registry.wallet_signed_server_verified || []).includes(event))
    && ['REWARD_PAYMENT_CONFIRMED', 'SUPPORT_PAYMENT_CONFIRMED']
      .every((event) => (registry.solana_memo || []).includes(event)));
ok('support payment code never mutates analyst reputation, weight or contribution tables',
  !/(?:insert\s+into|update)\s+public\.analyst_(?:profiles|contributions|reputation_snapshots)/i
    .test(nativePayments));
ok('Case sealing atomically freezes the exact pledge amount and winning Report version without moving SOL',
  nativePayments.includes('create trigger osi_v2_freeze_reward_on_case_seal')
    && nativePayments.includes("set state = 'assigned', winning_report_version_id = winning_version_id")
    && nativePayments.includes('sealed_amount_lamports = reward.amount_lamports'));
const proofPurposeBlock = proofCore.match(
  /export const CLASS_B_PURPOSES = new Set\(\[([\s\S]*?)\]\);/,
);
const proofPurposes = proofPurposeBlock
  ? [...proofPurposeBlock[1].matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((match) => match[1])
  : [];
ok(
  'Edge proof purpose allowlist exactly matches canonical class B',
  JSON.stringify([...proofPurposes].sort())
    === JSON.stringify([...(registry.wallet_signed_server_verified || [])].sort()),
);
for (const event of [
  'CASE_REPORT_VERSION_SUBMITTED',
  'WIRE_REPORT_VERSION_SUBMITTED',
  'ANALYST_APPLICATION_VERSION_SUBMITTED',
  'AI_PACK_OWNER_FEEDBACK_SUBMITTED',
  'CHALLENGE_ADMISSIBILITY_ACCEPTED',
  'CHALLENGE_ADMISSIBILITY_REJECTED',
  'CHALLENGE_WITHDRAWN',
  'CHALLENGE_EXPIRED',
  'CHALLENGE_REVIEW_CAST',
  'CHALLENGE_REVIEW_REVISED',
  'CHALLENGE_ACCEPTED',
  'CHALLENGE_REJECTED',
  'AI_PACK_REJECTED',
]) {
  ok('canonical registry contains ' + event, allEvents.includes(event));
}

for (const required of [
  'event_receipts_anchor_wallet_format_check',
  'event_receipts_legacy_truthfulness_check',
  'event_receipts_canonical_transport_check',
  'event_receipts_nonce_fk',
  'challenges_v2_exactly_one_target_check',
  'challenges_v2_target_kind_consistency_check',
  'support_events_typed_target_check',
  'case_reports_current_version_same_report_fk',
  'wire_reports_current_version_same_report_fk',
  'analyst_applications_current_version_same_parent_fk',
  'ai_packs_current_version_same_pack_fk',
  'osi_v2_validate_native_receipt_nonce',
  'osi_v2_enforce_no_self_review',
  'osi_v2_enforce_resolution_review_case',
  'osi_v2_validate_pack_manifest_evidence',
  'osi_v2_validate_review_successor',
  'osi_v2_enforce_review_weight',
  'osi_v2_enforce_review_target_state',
  'osi_v2_validate_reward_pledge_insert',
  'osi_v2_enforce_reward_winner_case',
  'osi_v2_validate_reward_payment_insert',
  'osi_v2_validate_support_target',
  'osi_v2_guard_config_write',
  'osi_v2_guard_nonce_update',
  'osi_v2_issue_nonce',
  'osi_v2_consume_signed_nonce',
  'osi_v2_issue_read_nonce',
  'osi_v2_consume_read_nonce',
  'osi_v2_issue_case_nonce',
  'osi_v2_commit_case_submission',
  'osi_v2_commit_case_review',
  'osi_v2_commit_case_open',
  'osi_v2_case_review_quorum',
  'osi_v2_prepare_report_version',
  'osi_v2_commit_report_version',
  'osi_v2_report_writes_enabled',
]) {
  ok('required integrity guard exists: ' + required, allSql.includes(required));
}

ok(
  'Stage-5 nonce stores only a keyed request fingerprint',
  allSql.includes('request_fingerprint_hash text not null')
    && !allSql.includes('request_ip text'),
);
ok(
  'Stage-5 proof switch fails closed',
  /\('OSI_V2_PROOF_ENABLED',\s*'false'/i.test(allSql)
    && !/\('OSI_V2_PROOF_ENABLED',\s*'true'/i.test(allSql),
);
ok(
  'broad V2 write flag remains false while the Case gate is exact',
  !/\('OSI_V2_WRITES_ENABLED',\s*'true'/i.test(allSql)
    && /\('OSI_V2_CASE_WRITES_ENABLED',\s*'true'/i.test(lifecycle)
    && lifecycle.includes("where key = 'OSI_V2_CASE_WRITES_ENABLED'"),
);
ok(
  'durable read nonce consumption is one atomic conditional update',
  /create function osi_private\.osi_v2_consume_read_nonce[\s\S]*update public\.osi_read_nonces[\s\S]*consumed_at is null[\s\S]*return found/i.test(lifecycle),
);
ok(
  'Case opening models analyst count+weight and full-maintainer readiness independently',
  lifecycle.includes('analyst_count >= 1 and total_weight >= 0.50')
    && lifecycle.includes('maintainer_count >= 1')
    && /osi_v2_commit_case_open[\s\S]*osi_v2_case_review_quorum/i.test(lifecycle),
);
ok(
  'maintainer review has zero analyst weight and may issue CASE_OPENED on its own verified path',
  lifecycle.includes("review_weight := 0")
    && lifecycle.includes("opening_review.reviewer_role = 'maintainer'")
    && lifecycle.includes('quorum_row.maintainer_ready')
    && !lifecycle.includes("Maintainer status alone cannot open a Case"),
);
ok(
  'Case idempotency binds retries to the exact target',
  lifecycle.includes("existing.target_id is distinct from p_target_id")
    && lifecycle.includes('Idempotency key is bound to another exact Case action'),
);
ok(
  'unfinished initial rejection outcome fails closed in the database',
  lifecycle.includes("p_decision not in ('approve_open', 'needs_more')")
    && lifecycle.includes('Initial rejection outcome is not enabled in this Case slice'),
);
ok(
  'all submission-bound Case content is immutable',
  /new\.title is distinct from old\.title[\s\S]*new\.category is distinct from old\.category[\s\S]*new\.summary_public is distinct from old\.summary_public[\s\S]*new\.details_restricted is distinct from old\.details_restricted/i.test(lifecycle),
);
ok(
  'analyst slice is independently enabled and malformed flag state fails closed',
  analystActivation.includes("('OSI_V2_ANALYST_WRITES_ENABLED', 'true'")
    && analystActivation.includes("where key = 'OSI_V2_ANALYST_WRITES_ENABLED'")
    && analystActivation.includes("value = 'true'"),
);
ok(
  'Report slice has its own disabled-by-default fail-closed gate',
  reportIntake.includes("('OSI_V2_REPORT_WRITES_ENABLED', 'false'")
    && reportIntake.includes("where key = 'OSI_V2_REPORT_WRITES_ENABLED'")
    && reportIntake.includes("value = 'true'")
    && !reportIntake.includes("('OSI_V2_REPORT_WRITES_ENABLED', 'true'"),
);
ok(
  'Report writes atomically bind exact version evidence receipt and pointer',
  /osi_v2_commit_report_version[\s\S]*insert into public\.event_receipts[\s\S]*insert into public\.case_report_versions[\s\S]*case_report_version_evidence[\s\S]*current_version_id = actual_version_id/i.test(reportIntake)
    && !/set\s+current_published_version_id/i.test(reportIntake),
);
ok(
  'Report prepare and commit both enforce exact active public Case allowlist',
  (reportIntake.match(/stage in \('open_public', 'in_review', 'reopened'\)/g) || []).length >= 2
    && (reportIntake.match(/visibility = 'public'/g) || []).length >= 2,
);
ok(
  'Report lineage uses a single native header per Case and author',
  reportIntake.includes('case_reports_native_case_author_uidx')
    && reportIntake.includes('Report lineage is ambiguous'),
);
ok(
  'Report rate limit and cooldown configuration fail closed',
  reportIntake.includes('OSI_V2_REPORT_RATE_WINDOW_SECONDS')
    && reportIntake.includes('OSI_V2_REPORT_MAX_PER_WALLET')
    && reportIntake.includes('OSI_V2_REPORT_MAX_PER_FINGERPRINT')
    && reportIntake.includes('OSI_V2_REPORT_COOLDOWN_SECONDS')
    && reportIntake.includes('Report write security configuration is absent or invalid'),
);
ok(
  'analyst application versions use exact Stage-5 binding',
  analystActivation.includes("'ANALYST_APPLICATION_VERSION_SUBMITTED'")
    && analystActivation.includes("bound_nonce.target_type <> 'application_version'")
    && analystActivation.includes('bound_nonce.payload_hash <> p_payload_hash')
    && analystActivation.includes('Application nonce binding is invalid'),
);
ok(
  'maintainer application review is uncounted and exact-version bound',
  analystActivation.includes("tg_table_name = 'analyst_application_reviews'")
    && analystActivation.includes('new.weight = 0')
    && analystActivation.includes("bound_nonce.actor_wallet, 'maintainer'")
    && analystActivation.includes('version_row.id::text'),
);
ok(
  'probation outcome derives the exact minimum tier and weight',
  analystActivation.includes("status = 'probationary_analyst'")
    && analystActivation.includes("tier_code = 'probationary'")
    && analystActivation.includes('weight_cached = 0.50')
    && analystActivation.includes("'ANALYST_PROBATION'"),
);
ok(
  'avatar storage grants no browser mutation path',
  analystActivation.includes("'osi-analyst-avatars'")
    && analystActivation.includes("array['image/png', 'image/jpeg']")
    && !/create policy[\s\S]*osi-analyst-avatars/i.test(analystActivation),
);
ok(
  'analyst production workflow is manual, main-only, and exact-migration pinned',
  analystProductionWorkflow.includes('workflow_dispatch:')
    && !analystProductionWorkflow.includes('pull_request:')
    && !analystProductionWorkflow.includes('push:')
    && analystProductionWorkflow.includes('refs/heads/main')
    && analystProductionWorkflow.includes("NEW_VERSION: '20260713184533'")
    && analystProductionWorkflow.includes('Dry-run must contain only the analyst migration'),
);
ok(
  'analyst production workflow validates then deploys only its function',
  analystProductionWorkflow.includes('needs: validate')
    && analystProductionWorkflow.includes('supabase test db')
    && analystProductionWorkflow.includes('bash tests/osi-v2-concurrency.test.sh')
    && analystProductionWorkflow.includes('functions deploy osi-v2-analyst')
    && !analystProductionWorkflow.includes('functions deploy osi-v2-case-write'),
);
ok(
  'Report production workflow is manual main-only and exact-migration pinned',
  reportProductionWorkflow.includes('workflow_dispatch:')
    && !reportProductionWorkflow.includes('pull_request:')
    && !reportProductionWorkflow.includes('push:')
    && reportProductionWorkflow.includes('refs/heads/main')
    && reportProductionWorkflow.includes("NEW_VERSION: '20260714044036'")
    && reportProductionWorkflow.includes('REPORT-DEPLOY-${EXPECTED_PROJECT_REF}')
    && reportProductionWorkflow.includes('Dry-run must contain only the Report migration'),
);
ok(
  'Report production workflow validates before deploying only Report functions',
  reportProductionWorkflow.includes('needs: validate')
    && reportProductionWorkflow.includes('supabase db reset --local --no-seed')
    && reportProductionWorkflow.includes('supabase db lint --local --level error')
    && reportProductionWorkflow.includes('supabase test db')
    && reportProductionWorkflow.includes('bash tests/osi-v2-concurrency.test.sh')
    && reportProductionWorkflow.includes('functions deploy osi-v2-report-read')
    && reportProductionWorkflow.includes('functions deploy osi-v2-report-write')
    && !reportProductionWorkflow.includes('functions deploy osi-v2-case-write'),
);
ok(
  'Report rollout enables only its flag after pre-enable smoke',
  reportProductionWorkflow.indexOf('Pre-enable capability, privacy and negative authorization smoke')
      < reportProductionWorkflow.indexOf('Enable only the dedicated Report write flag')
    && reportProductionWorkflow.includes("key='OSI_V2_REPORT_WRITES_ENABLED' and value='false'")
    && reportProductionWorkflow.includes("report_flag is distinct from 'true'")
    && reportProductionWorkflow.includes("broad_write_flag is distinct from 'false'")
    && reportProductionWorkflow.includes("broad_proof_flag is distinct from 'false'"),
);
ok(
  'Report production workflow has no planner-foldable constant error assertions',
  !/cast\s*\(\s*1\s*\/\s*0/i.test(reportProductionWorkflow)
    && !/(?:^|[^\w])\d+\s*\/\s*0(?:[^\w]|$)/m.test(reportProductionWorkflow),
);
ok(
  'Resolution production workflow is manual main-only and exact-migration pinned',
  resolutionProductionWorkflow.includes('workflow_dispatch:')
    && !resolutionProductionWorkflow.includes('pull_request:')
    && !resolutionProductionWorkflow.includes('push:')
    && resolutionProductionWorkflow.includes('refs/heads/main')
    && resolutionProductionWorkflow.includes('NEW_VERSION: "20260714082218"')
    && resolutionProductionWorkflow.includes('RESOLUTION-DEPLOY-${EXPECTED_PROJECT_REF}')
    && resolutionProductionWorkflow.includes('Dry-run only the Resolution lifecycle migration'),
);
ok(
  'Resolution rollout validates before deploying only its scoped functions',
  resolutionProductionWorkflow.includes('needs: validate')
    && resolutionProductionWorkflow.includes('supabase db lint --local --level error')
    && resolutionProductionWorkflow.includes('supabase test db')
    && resolutionProductionWorkflow.includes('bash tests/osi-v2-concurrency.test.sh')
    && resolutionProductionWorkflow.includes('functions deploy osi-v2-case-read')
    && resolutionProductionWorkflow.includes('functions deploy osi-v2-governance-write')
    && !resolutionProductionWorkflow.includes('functions deploy osi-v2-case-write'),
);
ok(
  'Resolution lifecycle activates atomically after pre-enable smoke and fails closed',
  resolutionProductionWorkflow.indexOf('Pre-enable capability privacy and negative smoke')
      < resolutionProductionWorkflow.indexOf('Enable only the complete Resolution lifecycle flag')
    && resolutionProductionWorkflow.includes("key='OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED' and value='false'")
    && resolutionProductionWorkflow.includes('Fail closed after any rollout or smoke failure')
    && resolutionProductionWorkflow.includes('[ "$lifecycle_flag" = "false" ]'),
);
ok(
  'Resolution production workflow has no planner-foldable constant error assertions',
  !/cast\s*\(\s*1\s*\/\s*0/i.test(resolutionProductionWorkflow)
    && !/(?:^|[^\w])\d+\s*\/\s*0(?:[^\w]|$)/m.test(resolutionProductionWorkflow),
);
ok(
  'Native payment production workflow is manual main-only and exact-migration pinned',
  paymentProductionWorkflow.includes('workflow_dispatch:')
    && !paymentProductionWorkflow.includes('pull_request:')
    && !paymentProductionWorkflow.includes('push:')
    && paymentProductionWorkflow.includes('refs/heads/main')
    && paymentProductionWorkflow.includes('NEW_VERSION: "20260715053828"')
    && paymentProductionWorkflow.includes('PAYMENT-DEPLOY-${EXPECTED_PROJECT_REF}')
    && paymentProductionWorkflow.includes('Dry-run only the native SOL payment migration'),
);
ok(
  'Native payment rollout validates before deploying only scoped read and payment functions',
  paymentProductionWorkflow.includes('needs: validate')
    && paymentProductionWorkflow.includes('supabase db lint --local --level error')
    && paymentProductionWorkflow.includes('supabase test db')
    && paymentProductionWorkflow.includes('bash tests/osi-v2-concurrency.test.sh')
    && paymentProductionWorkflow.includes('functions deploy osi-v2-case-read')
    && paymentProductionWorkflow.includes('functions deploy osi-v2-analyst')
    && paymentProductionWorkflow.includes('functions deploy osi-v2-payment')
    && !paymentProductionWorkflow.includes('functions deploy osi-v2-case-write')
    && !paymentProductionWorkflow.includes('functions deploy osi-v2-governance-write'),
);
ok(
  'Native payment flag enables only after closed smoke and fails closed',
  paymentProductionWorkflow.indexOf('Pre-enable capability privacy and negative smoke')
      < paymentProductionWorkflow.indexOf('Enable only the native SOL payment flag')
    && paymentProductionWorkflow.includes("key='OSI_V2_PAYMENT_WRITES_ENABLED' and value='false'")
    && paymentProductionWorkflow.includes('Fail closed after any rollout or smoke failure')
    && paymentProductionWorkflow.includes('[ "$payment_flag" = "false" ]'),
);
ok(
  'Native payment rollout preserves broad gates and never initiates mainnet SOL',
  paymentProductionWorkflow.includes("key='OSI_V2_WRITES_ENABLED'")
    && paymentProductionWorkflow.includes("key='OSI_V2_PROOF_ENABLED'")
    && paymentProductionWorkflow.includes('positive_mainnet_transfer=not_attempted')
    && !paymentProductionWorkflow.includes('signAndSendTransaction'),
);
ok(
  'Native payment production workflow has no planner-foldable constant error assertions',
  !/cast\s*\(\s*1\s*\/\s*0/i.test(paymentProductionWorkflow)
    && !/(?:^|[^\w])\d+\s*\/\s*0(?:[^\w]|$)/m.test(paymentProductionWorkflow),
);
ok(
  'nonce issuance serializes idempotency and rate-limit dimensions',
  allSql.includes("'osi2-idempotency:'")
    && allSql.includes("'osi2-wallet:'")
    && allSql.includes("'osi2-fingerprint:'"),
);
ok(
  'signed receipt insertion and nonce consumption share one SQL function',
  /create function osi_private\.osi_v2_consume_signed_nonce[\s\S]*insert into public\.event_receipts[\s\S]*update public\.osi_nonces/i.test(allSql),
);
ok(
  'receipt-consumption helper is outside exposed API schemas',
  allSql.includes('create schema if not exists osi_private')
    && !/create function public\.osi_v2_consume_signed_nonce/i.test(allSql)
    && !/schemas\s*=\s*\[[^\]]*osi_private/i.test(config),
);

for (const requiredNonceField of [
  'purpose',
  'actor_wallet',
  'target_type',
  'target_id',
  'payload_hash',
  'idempotency_key',
  'expires_at',
  'consumed_at',
  'consumed_by_receipt_id',
]) {
  const nonceStart = schema.indexOf('create table public.osi_nonces');
  const nonceEnd = schema.indexOf('create index osi_nonces_actor', nonceStart);
  const nonceBlock = schema.slice(nonceStart, nonceEnd);
  ok(
    'nonce ledger includes ' + requiredNonceField,
    new RegExp('\\b' + requiredNonceField + '\\b').test(nonceBlock),
  );
}

ok(
  'review successor foreign keys are deferred',
  (schema.match(/deferrable initially deferred/g) || []).length >= 8,
);
ok(
  'support remains isolated from reputation tables',
  !/references\s+public\.support_events/i.test(schema),
);
ok(
  'reward/support constrained to non-custodial SOL records',
  schema.includes("constraint reward_pledges_token_check")
    && schema.includes("constraint support_events_token_check"),
);

const identifiers = [
  ...allSql.matchAll(
    /\b(?:constraint|create\s+(?:unique\s+)?index|create\s+(?:constraint\s+)?trigger|create\s+function)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi,
  ),
].map((match) => match[1]);
const overlong = identifiers.filter((name) => Buffer.byteLength(name, 'utf8') > 63);
ok('explicit PostgreSQL identifiers fit 63 bytes', overlong.length === 0, overlong.join(', '));

console.log(
  (fail ? 'FAILED: ' + fail : 'OK') +
  ' (' + pass + ' assertions passed, ' + fail + ' failed)',
);
process.exit(fail ? 1 : 0);
