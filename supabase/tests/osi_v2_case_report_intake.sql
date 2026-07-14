-- Native Case Report intake, immutable versioning, privacy and authorization.
-- All fixtures live only in the disposable local database transaction.

begin;

create extension if not exists pgtap with schema extensions;
select plan(39);

select is(
  (select value from public.osi_config where key = 'OSI_V2_REPORT_WRITES_ENABLED'),
  'false',
  'Report writes start disabled until the dedicated rollout finishes'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_WRITES_ENABLED'),
  'false',
  'broad V2 writes remain disabled'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_PROOF_ENABLED'),
  'false',
  'broad V2 proof remains disabled'
);
select isnt(
  has_function_privilege(
    'anon',
    'public.osi_v2_prepare_report_version(text,text,uuid,text,text,text,jsonb,text,text)',
    'EXECUTE'
  ),
  true,
  'anonymous clients cannot prepare Report versions directly'
);
select isnt(
  has_function_privilege(
    'authenticated',
    'public.osi_v2_commit_report_version(text,text,text,text,jsonb,text,text,timestamptz)',
    'EXECUTE'
  ),
  true,
  'authenticated clients cannot commit Report versions directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.osi_v2_commit_report_version(text,text,text,text,jsonb,text,text,timestamptz)',
    'EXECUTE'
  ),
  'trusted service role can reach the atomic Report commit wrapper'
);
select isnt(
  has_table_privilege('authenticated', 'public.case_report_versions', 'INSERT'),
  true,
  'authenticated clients have no direct version insert path'
);

select lives_ok(
  $test$
    insert into public.cases (
      id, public_ref, title, category, summary_public, details_restricted,
      submitted_by_wallet, stage, visibility, subject_refs
    ) values (
      '10000000-0000-4000-8000-000000000001', 'OSI-ABCDEF123456',
      'Public Report intake fixture', 'other',
      'A public active Case used to test exact immutable Report submissions.',
      'Restricted Case fixture detail.',
      '11111111111111111111111111111113', 'open_public', 'public', '[]'::jsonb
    )
  $test$,
  'an eligible public active Case fixture is created'
);

update public.osi_config set value = 'true'
 where key = 'OSI_V2_REPORT_WRITES_ENABLED';
update public.osi_config set value = '0'
 where key = 'OSI_V2_REPORT_COOLDOWN_SECONDS';

select lives_ok(
  $test$
    create temporary table osi_report_v1_prepare on commit drop as
    select * from public.osi_v2_prepare_report_version(
      repeat('a', 32), '11111111111111111111111111111112',
      '10000000-0000-4000-8000-000000000001',
      'This initial restricted Report narrative records transaction order, wallet relationships, uncertainty, and evidentiary limits for independent review.',
      'A public-safe summary that remains private until a future publication transition.',
      null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet',
        'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      'report-intake-pgtap-0001', repeat('1', 64)
    )
  $test$,
  'initial Report prepare reserves exact server-generated header and version IDs'
);
select ok(
  (
    select n.purpose = 'CASE_REPORT_VERSION_SUBMITTED'
       and n.target_type = 'report_version'
       and n.target_id::uuid = prepared.version_id
       and n.actor_wallet = '11111111111111111111111111111112'
       and n.payload_hash = prepared.payload_hash
       and n.binding_context->>'report_id' = prepared.report_id::text
       and n.binding_context->>'version_public_ref' = prepared.version_public_ref
      from pg_temp.osi_report_v1_prepare as prepared
      join public.osi_nonces as n on n.nonce = prepared.issued_nonce
  ),
  'persistent nonce binds exact purpose actor version payload and reserved lineage'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_report_version(
      repeat('a', 32),
      'This initial restricted Report narrative records transaction order, wallet relationships, uncertainty, and evidentiary limits for independent review.',
      'A public-safe summary that remains private until a future publication transition.',
      null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet',
        'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      repeat('R', 88), 'OSI2 test CASE_REPORT_VERSION_SUBMITTED v1',
      statement_timestamp()
    )
  $test$,
  'initial confirmed Memo proof creates header version receipt evidence and pointer atomically'
);
select is(
  (select count(*)::integer from public.case_reports
    where case_id = '10000000-0000-4000-8000-000000000001'
      and author_wallet = '11111111111111111111111111111112'),
  1,
  'one exact Case and author has one Report header'
);
select is(
  (select count(*)::integer from public.case_report_versions
    where report_id = (select report_id from pg_temp.osi_report_v1_prepare)),
  1,
  'initial submission creates exactly one immutable version row'
);
select ok(
  (
    select report.current_version_id = prepared.version_id
      from public.case_reports as report
      cross join pg_temp.osi_report_v1_prepare as prepared
     where report.id = prepared.report_id
  ),
  'header current pointer targets exact version 1'
);
select is(
  (select current_published_version_id from public.case_reports
    where id = (select report_id from pg_temp.osi_report_v1_prepare)),
  null::uuid,
  'initial submission does not advance the published pointer'
);
select ok(
  (
    select receipt.event_type = 'CASE_REPORT_VERSION_SUBMITTED'
       and receipt.target_type = 'report_version'
       and receipt.target_id::uuid = prepared.version_id
       and receipt.public_ref = prepared.version_public_ref
       and receipt.actor_wallet = '11111111111111111111111111111112'
       and receipt.actor_role = 'wallet'
       and receipt.proof_type = 'solana_memo'
       and receipt.server_verified is true
       and receipt.tx_sig = repeat('R', 88)
      from public.event_receipts as receipt
      cross join pg_temp.osi_report_v1_prepare as prepared
     where receipt.nonce = repeat('a', 32)
  ),
  'native receipt is bound to exact version author and confirmed Solana Memo'
);
select ok(
  (
    select version.evidence_snapshot_hash =
      osi_private.osi_v2_report_manifest_hash(jsonb_build_array(jsonb_build_object(
        'kind', 'wallet',
        'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )))
      and link.ordinal = 1
      and item.is_public is false
      and item.moderation_state = 'pending'
      from public.case_report_versions as version
      join public.case_report_version_evidence as link
        on link.report_version_id = version.id
      join public.evidence_items as item on item.id = link.evidence_item_id
     where version.id = (select version_id from pg_temp.osi_report_v1_prepare)
  ),
  'version binds the exact ordered private evidence manifest and snapshot hash'
);
select is(
  (
    select idempotent_replay from public.osi_v2_commit_report_version(
      repeat('a', 32),
      'This initial restricted Report narrative records transaction order, wallet relationships, uncertainty, and evidentiary limits for independent review.',
      'A public-safe summary that remains private until a future publication transition.',
      null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet',
        'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      repeat('R', 88), 'OSI2 test CASE_REPORT_VERSION_SUBMITTED v1',
      statement_timestamp()
    )
  ),
  true,
  'exact retry returns the original result without a duplicate effect'
);
select is(
  (select jsonb_build_object(
    'receipts', (select count(*) from public.event_receipts where nonce = repeat('a', 32)),
    'headers', (select count(*) from public.case_reports where id = (select report_id from pg_temp.osi_report_v1_prepare)),
    'versions', (select count(*) from public.case_report_versions where report_id = (select report_id from pg_temp.osi_report_v1_prepare))
  )),
  jsonb_build_object('receipts', 1, 'headers', 1, 'versions', 1),
  'idempotent retry leaves exactly one receipt header and version'
);
select throws_ok(
  $test$
    select * from public.osi_v2_commit_report_version(
      repeat('a', 32),
      'This changed restricted Report narrative is long enough but cannot replace the exact content that was prepared and committed for review.',
      'A public-safe summary that remains private until a future publication transition.',
      null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      repeat('R', 88), 'OSI2 test CASE_REPORT_VERSION_SUBMITTED v1', statement_timestamp()
    )
  $test$,
  '23514',
  'Report content or evidence changed after prepare',
  'changed body cannot reuse a consumed Report nonce'
);
select throws_ok(
  $test$
    update public.case_report_versions
       set body_private = 'A rewritten private body that must be rejected after submission despite having enough characters to satisfy the column check.'
     where id = (select version_id from pg_temp.osi_report_v1_prepare)
  $test$,
  '55000',
  'Report version identity/private content/evidence are immutable',
  'submitted Report body cannot be rewritten'
);
select throws_ok(
  $test$
    delete from public.case_report_versions
     where id = (select version_id from pg_temp.osi_report_v1_prepare)
  $test$,
  '55000',
  'OSI V2 history is append-only: DELETE denied on public.case_report_versions',
  'old Report versions cannot be deleted'
);

select lives_ok(
  $test$
    create temporary table osi_report_v2_prepare on commit drop as
    select * from public.osi_v2_prepare_report_version(
      repeat('b', 32), '11111111111111111111111111111112',
      '10000000-0000-4000-8000-000000000001',
      'This revised restricted Report adds a clearer transaction sequence while retaining uncertainty, source limits, and the immutable prior version.',
      'An updated public-safe summary that remains private before publication.',
      'clarification',
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      'report-revision-pgtap-0002', repeat('2', 64)
    )
  $test$,
  'same author prepares a new immutable revision under the existing header'
);
select ok(
  (
    select version_no = 2
       and supersedes_version_id = (select version_id from pg_temp.osi_report_v1_prepare)
       and report_id = (select report_id from pg_temp.osi_report_v1_prepare)
      from pg_temp.osi_report_v2_prepare
  ),
  'server derives version 2 and exact supersedes linkage'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_report_version(
      repeat('b', 32),
      'This revised restricted Report adds a clearer transaction sequence while retaining uncertainty, source limits, and the immutable prior version.',
      'An updated public-safe summary that remains private before publication.',
      'clarification',
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      repeat('S', 88), 'OSI2 test CASE_REPORT_VERSION_SUBMITTED v2', statement_timestamp()
    )
  $test$,
  'confirmed revision proof creates exact immutable version 2'
);
select is(
  (select count(*)::integer from public.case_report_versions
    where report_id = (select report_id from pg_temp.osi_report_v1_prepare)),
  2,
  'revision appends one row instead of replacing version 1'
);
select is(
  (select body_private from public.case_report_versions
    where id = (select version_id from pg_temp.osi_report_v1_prepare)),
  'This initial restricted Report narrative records transaction order, wallet relationships, uncertainty, and evidentiary limits for independent review.',
  'version 1 content remains byte-for-byte unchanged'
);
select ok(
  (
    select report.current_version_id = prepared.version_id
       and report.current_published_version_id is null
      from public.case_reports as report
      cross join pg_temp.osi_report_v2_prepare as prepared
     where report.id = prepared.report_id
  ),
  'current pointer advances to version 2 while published pointer stays unchanged'
);
select ok(
  (
    select receipt.decision = 'revise'
       and receipt.reason_code = 'clarification'
       and receipt.target_id::uuid = prepared.version_id
       and receipt.tx_sig = repeat('S', 88)
      from public.event_receipts as receipt
      cross join pg_temp.osi_report_v2_prepare as prepared
     where receipt.nonce = repeat('b', 32)
  ),
  'revision receives its own exact immutable receipt and transaction proof'
);
select ok(
  (select bool_and(version.created_by_wallet = report.author_wallet)
    from public.case_report_versions as version
    join public.case_reports as report on report.id = version.report_id
    where report.id = (select report_id from pg_temp.osi_report_v1_prepare)),
  'every version author is derived from the immutable header author'
);
select ok(
  to_regclass('public.case_reports_native_case_author_uidx') is not null,
  'native Case and author lineage uniqueness index exists'
);
select isnt(
  has_table_privilege('anon', 'public.case_report_version_evidence', 'SELECT'),
  true,
  'anonymous clients cannot enumerate private Report evidence links'
);

select lives_ok(
  $test$
    insert into public.cases (
      id, public_ref, title, category, summary_public, details_restricted,
      submitted_by_wallet, stage, visibility, subject_refs
    ) values (
      '10000000-0000-4000-8000-000000000002', 'OSI-PRIVATE123456',
      'Private Report denial fixture', 'other',
      'A private Case that must never disclose whether it can receive a Report.',
      'Restricted private Case fixture detail.',
      '11111111111111111111111111111113', 'initial_review', 'private', '[]'::jsonb
    )
  $test$,
  'private Case denial fixture is created'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_report_version(
      repeat('c', 32), '11111111111111111111111111111112',
      '10000000-0000-4000-8000-000000000002',
      'This restricted Report narrative is long enough but targets a private Case and therefore must be rejected without creating a lineage.',
      null, null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      'report-private-pgtap-0003', repeat('3', 64)
    )
  $test$,
  '42501',
  'Case is not available for Report submission',
  'private or ineligible Case cannot receive a Report'
);
select is(
  (select count(*)::integer from public.case_reports
    where case_id = '10000000-0000-4000-8000-000000000002'),
  0,
  'denied private Case attempt creates no Report header'
);

update public.osi_config set value = 'TRUE'
 where key = 'OSI_V2_REPORT_WRITES_ENABLED';
select is(
  osi_private.osi_v2_report_writes_enabled(),
  false,
  'malformed non-literal feature flag fails closed'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_report_version(
      repeat('d', 32), '11111111111111111111111111111112',
      '10000000-0000-4000-8000-000000000001',
      'This restricted Report narrative is long enough but the malformed dedicated feature flag must keep the entire prepare path safely disabled.',
      null, 'new_evidence',
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      'report-disabled-pgtap-0004', repeat('4', 64)
    )
  $test$,
  '55000',
  'OSI V2 Report writes are disabled',
  'prepare checks the fail-closed flag'
);
select is(
  (select count(*)::integer from public.event_receipts
    where event_type = 'CASE_REPORT_VERSION_SUBMITTED'
      and target_type = 'report_version'),
  2,
  'only the two successful exact versions created native receipts'
);
select is(
  (select count(*)::integer from public.case_report_versions
    where report_id = (select report_id from pg_temp.osi_report_v1_prepare)
      and lifecycle_state = 'submitted'),
  2,
  'submission never publishes resolves closes or selects a winner'
);

select * from finish();
rollback;
