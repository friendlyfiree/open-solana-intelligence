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
const lifecycle = sqlByFile[expectedFiles.at(-1)] || '';
const allSql = migrationFiles.map((name) => sqlByFile[name]).join('\n');
const config = fs.readFileSync(path.join(root, 'supabase', 'config.toml'), 'utf8');
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
  'exact ordered migration set',
  JSON.stringify(migrationFiles) === JSON.stringify(expectedFiles),
  migrationFiles.join(', '),
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
for (const functionName of ['osi-analyst-intake', 'osi-ai-pack']) {
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

const classMatches = [...integrity.matchAll(
  /when\s+p_event_type\s*=\s*any\s*\(array\[([\s\S]*?)\]::text\[\]\)\s*then\s*'([^']+)'/g,
)];
const registry = {};
for (const match of classMatches) {
  registry[match[2]] = [...match[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)]
    .map((event) => event[1]);
}
ok(
  '25 class-B events',
  (registry.wallet_signed_server_verified || []).length === 25,
);
ok('32 class-A events', (registry.solana_memo || []).length === 32);
ok('8 system events', (registry.system_event || []).length === 8);
const allEvents = Object.values(registry).flat();
ok('65 canonical events', allEvents.length === 65);
ok('canonical event classes do not overlap', new Set(allEvents).size === 65);
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
  'Case opening rechecks both analyst count and weight',
  /count\(distinct review\.reviewer_wallet\) >= 1[\s\S]*sum\(review\.weight\)[\s\S]*>= 0\.50/i.test(lifecycle)
    && /osi_v2_commit_case_open[\s\S]*osi_v2_case_review_quorum/i.test(lifecycle),
);
ok(
  'maintainer acknowledgement has zero review weight and cannot issue CASE_OPENED',
  lifecycle.includes("review_weight := 0")
    && lifecycle.includes("Maintainer status alone cannot open a Case"),
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
