-- Native Wire Phase 1 intake, immutable lineage, privacy, and replay safety.
-- All fixtures live only in this disposable local database transaction.

begin;

create extension if not exists pgtap with schema extensions;
select plan(34);

select is(
  (select value from public.osi_config where key = 'OSI_V2_WIRE_WRITES_ENABLED'),
  'false',
  'Wire writes start disabled until their dedicated rollout finishes'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_WRITES_ENABLED'),
  'false',
  'broad V2 writes remain disabled'
);
select isnt(
  has_function_privilege(
    'anon',
    'public.osi_v2_prepare_wire_version(text,text,text,text,text,text,text,text,jsonb,text,text)',
    'EXECUTE'
  ),
  true,
  'anonymous clients cannot prepare Wire versions directly'
);
select isnt(
  has_function_privilege(
    'authenticated',
    'public.osi_v2_commit_wire_version(text,text,text,text,text,text,jsonb,text,text,timestamptz)',
    'EXECUTE'
  ),
  true,
  'authenticated clients cannot commit Wire versions directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.osi_v2_commit_wire_version(text,text,text,text,text,text,jsonb,text,text,timestamptz)',
    'EXECUTE'
  ),
  'trusted service role can reach the atomic Wire commit wrapper'
);
select isnt(
  has_table_privilege('authenticated', 'public.wire_report_versions', 'INSERT'),
  true,
  'authenticated clients have no direct Wire version insert path'
);

update public.osi_config set value = 'true'
 where key = 'OSI_V2_WIRE_WRITES_ENABLED';
update public.osi_config set value = '0'
 where key = 'OSI_V2_WIRE_COOLDOWN_SECONDS';

select lives_ok(
  $test$
    create temporary table osi_wire_v1_prepare on commit drop as
    select * from public.osi_v2_prepare_wire_version(
      repeat('w', 32),
      '11111111111111111111111111111112',
      null,
      'Treasury transfer sequence for independent review',
      'A public-safe summary describes a linked transfer sequence without asserting guilt or identity.',
      'The detailed analysis records transaction order, wallet relationships, alternative explanations, and the exact source trail for independent review.',
      'Attribution remains uncertain and exchange ownership has not been independently confirmed.',
      null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet',
        'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      'wire-intake-pgtap-0001',
      repeat('1', 64)
    )
  $test$,
  'initial Wire prepare reserves exact server-generated header and version IDs'
);
select ok(
  (
    select n.purpose = 'WIRE_REPORT_VERSION_SUBMITTED'
       and n.target_type = 'wire_version'
       and n.target_id::uuid = prepared.version_id
       and n.actor_wallet = '11111111111111111111111111111112'
       and n.payload_hash = prepared.payload_hash
       and n.binding_context->>'wire_report_id' = prepared.wire_report_id::text
       and n.binding_context->>'version_public_ref' = prepared.version_public_ref
      from pg_temp.osi_wire_v1_prepare as prepared
      join public.osi_nonces as n on n.nonce = prepared.issued_nonce
  ),
  'persistent nonce binds exact purpose actor version payload and reserved Wire lineage'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_wire_version(
      repeat('w', 32),
      'Treasury transfer sequence for independent review',
      'A public-safe summary describes a linked transfer sequence without asserting guilt or identity.',
      'The detailed analysis records transaction order, wallet relationships, alternative explanations, and the exact source trail for independent review.',
      'Attribution remains uncertain and exchange ownership has not been independently confirmed.',
      null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet',
        'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      repeat('R', 88),
      'OSI2 test WIRE_REPORT_VERSION_SUBMITTED v1',
      statement_timestamp()
    )
  $test$,
  'initial confirmed Memo proof creates Wire header version receipt evidence and pointer atomically'
);
select is(
  (select count(*)::integer from public.wire_reports
    where author_wallet = '11111111111111111111111111111112'
      and native_intake),
  1,
  'one initial submission creates one native Wire header'
);
select is(
  (select count(*)::integer from public.wire_report_versions
    where wire_report_id = (select wire_report_id from pg_temp.osi_wire_v1_prepare)),
  1,
  'initial submission creates exactly one immutable Wire version'
);
select ok(
  (
    select report.current_version_id = prepared.version_id
       and report.current_published_version_id is null
       and report.promoted_to_case_id is null
      from public.wire_reports as report
      cross join pg_temp.osi_wire_v1_prepare as prepared
     where report.id = prepared.wire_report_id
  ),
  'Phase 1 advances only the current version pointer'
);
select ok(
  (
    select receipt.event_type = 'WIRE_REPORT_VERSION_SUBMITTED'
       and receipt.target_type = 'wire_version'
       and receipt.target_id::uuid = prepared.version_id
       and receipt.public_ref = prepared.version_public_ref
       and receipt.actor_wallet = '11111111111111111111111111111112'
       and receipt.actor_role = 'wallet'
       and receipt.proof_type = 'solana_memo'
       and receipt.server_verified is true
       and receipt.tx_sig = repeat('R', 88)
      from public.event_receipts as receipt
      cross join pg_temp.osi_wire_v1_prepare as prepared
     where receipt.nonce = repeat('w', 32)
  ),
  'native Wire receipt is bound to exact version author and confirmed Memo'
);
select ok(
  (
    select version.evidence_snapshot_hash =
      osi_private.osi_v2_wire_manifest_hash(jsonb_build_array(jsonb_build_object(
        'kind', 'wallet',
        'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )))
      and link.ordinal = 1
      and item.is_public is false
      and item.moderation_state = 'pending'
      from public.wire_report_versions as version
      join public.wire_report_version_evidence as link
        on link.wire_report_version_id = version.id
      join public.evidence_items as item on item.id = link.evidence_item_id
     where version.id = (select version_id from pg_temp.osi_wire_v1_prepare)
  ),
  'Wire version binds an ordered private evidence manifest and snapshot hash'
);
select is(
  (
    select idempotent_replay from public.osi_v2_commit_wire_version(
      repeat('w', 32),
      'Treasury transfer sequence for independent review',
      'A public-safe summary describes a linked transfer sequence without asserting guilt or identity.',
      'The detailed analysis records transaction order, wallet relationships, alternative explanations, and the exact source trail for independent review.',
      'Attribution remains uncertain and exchange ownership has not been independently confirmed.',
      null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet',
        'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      repeat('R', 88),
      'OSI2 test WIRE_REPORT_VERSION_SUBMITTED v1',
      statement_timestamp()
    )
  ),
  true,
  'exact Wire retry returns the original result'
);
select is(
  (select jsonb_build_object(
    'receipts', (select count(*) from public.event_receipts where nonce = repeat('w', 32)),
    'headers', (select count(*) from public.wire_reports where id = (select wire_report_id from pg_temp.osi_wire_v1_prepare)),
    'versions', (select count(*) from public.wire_report_versions where wire_report_id = (select wire_report_id from pg_temp.osi_wire_v1_prepare))
  )),
  jsonb_build_object('receipts', 1, 'headers', 1, 'versions', 1),
  'idempotent Wire retry creates no duplicate effect'
);
select throws_ok(
  $test$
    select * from public.osi_v2_commit_wire_version(
      repeat('w', 32),
      'Changed treasury transfer sequence for review',
      'A public-safe summary describes a linked transfer sequence without asserting guilt or identity.',
      'The detailed analysis records transaction order, wallet relationships, alternative explanations, and the exact source trail for independent review.',
      'Attribution remains uncertain and exchange ownership has not been independently confirmed.',
      null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      repeat('R', 88), 'OSI2 test WIRE_REPORT_VERSION_SUBMITTED v1', statement_timestamp()
    )
  $test$,
  '23514',
  'Wire content or evidence changed after prepare',
  'changed Wire content cannot reuse a consumed nonce'
);
select throws_ok(
  $test$
    update public.wire_report_versions
       set body_private = 'A rewritten private body that must be rejected after submission despite satisfying the minimum length requirement for the column.'
     where id = (select version_id from pg_temp.osi_wire_v1_prepare)
  $test$,
  '55000',
  'Report version identity/private content/evidence are immutable',
  'submitted Wire analysis cannot be rewritten'
);
select throws_ok(
  $test$
    delete from public.wire_report_versions
     where id = (select version_id from pg_temp.osi_wire_v1_prepare)
  $test$,
  '55000',
  'OSI V2 history is append-only: DELETE denied on public.wire_report_versions',
  'old Wire versions cannot be deleted'
);

select lives_ok(
  $test$
    create temporary table osi_wire_v2_prepare on commit drop as
    select * from public.osi_v2_prepare_wire_version(
      repeat('x', 32),
      '11111111111111111111111111111112',
      (select wire_report_public_ref from pg_temp.osi_wire_v1_prepare),
      'Clarified treasury transfer sequence for review',
      'An updated public-safe summary describes the transfer sequence and keeps attribution uncertain.',
      'The revised analysis adds an exact transaction-order explanation while preserving the prior immutable version and alternative explanations.',
      'Attribution and exchange ownership remain uncertain after the additional source review.',
      'clarification',
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet',
        'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      'wire-revision-pgtap-0002', repeat('2', 64)
    )
  $test$,
  'the exact author prepares a revision under the native Wire reference'
);
select ok(
  (
    select version_no = 2
       and supersedes_version_id = (select version_id from pg_temp.osi_wire_v1_prepare)
       and wire_report_id = (select wire_report_id from pg_temp.osi_wire_v1_prepare)
      from pg_temp.osi_wire_v2_prepare
  ),
  'server derives Wire version 2 and the exact supersedes link'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_wire_version(
      repeat('x', 32),
      'Clarified treasury transfer sequence for review',
      'An updated public-safe summary describes the transfer sequence and keeps attribution uncertain.',
      'The revised analysis adds an exact transaction-order explanation while preserving the prior immutable version and alternative explanations.',
      'Attribution and exchange ownership remain uncertain after the additional source review.',
      'clarification',
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      repeat('S', 88), 'OSI2 test WIRE_REPORT_VERSION_SUBMITTED v2', statement_timestamp()
    )
  $test$,
  'confirmed revision proof creates exact immutable Wire version 2'
);
select is(
  (select count(*)::integer from public.wire_report_versions
    where wire_report_id = (select wire_report_id from pg_temp.osi_wire_v1_prepare)),
  2,
  'Wire revision appends instead of replacing version 1'
);
select is(
  (select title_public_safe from public.wire_report_versions
    where id = (select version_id from pg_temp.osi_wire_v1_prepare)),
  'Treasury transfer sequence for independent review',
  'Wire version 1 content remains byte-for-byte unchanged'
);
select ok(
  (
    select report.current_version_id = prepared.version_id
       and report.current_published_version_id is null
       and report.promoted_to_case_id is null
      from public.wire_reports as report
      cross join pg_temp.osi_wire_v2_prepare as prepared
     where report.id = prepared.wire_report_id
  ),
  'current pointer advances to version 2 without publication or promotion'
);
select ok(
  (
    select receipt.decision = 'revise'
       and receipt.reason_code = 'clarification'
       and receipt.target_id::uuid = prepared.version_id
       and receipt.tx_sig = repeat('S', 88)
      from public.event_receipts as receipt
      cross join pg_temp.osi_wire_v2_prepare as prepared
     where receipt.nonce = repeat('x', 32)
  ),
  'Wire revision receives its own exact immutable receipt'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_wire_version(
      repeat('y', 32),
      '11111111111111111111111111111113',
      (select wire_report_public_ref from pg_temp.osi_wire_v1_prepare),
      'Unauthorized revision attempt for exact Wire lineage',
      'This summary is long enough but another wallet must not learn or revise the private lineage.',
      'This detailed analysis is long enough to reach validation but the server must deny the wrong author before any new version is reserved.',
      'The wrong wallet has no authority to state or replace the original author uncertainty.',
      'clarification',
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111113',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111113', 'UTF8'), 'sha256'), 'hex')
      )),
      'wire-wrong-author-0003', repeat('3', 64)
    )
  $test$,
  '42501',
  'Wire Report is not available for revision',
  'another wallet cannot revise or confirm an unpublished Wire lineage'
);
select isnt(
  has_table_privilege('anon', 'public.wire_report_version_evidence', 'SELECT'),
  true,
  'anonymous clients cannot enumerate private Wire evidence links'
);
select is(
  (select count(*)::integer from public.wire_reports
    where current_published_version_id is not null),
  0,
  'Phase 1 creates no public Wire pointer'
);
select is(
  (select count(*)::integer from public.wire_report_reviews),
  0,
  'Phase 1 creates no governance review rows'
);

update public.osi_config set value = 'TRUE'
 where key = 'OSI_V2_WIRE_WRITES_ENABLED';
select is(
  osi_private.osi_v2_wire_writes_enabled(),
  false,
  'malformed non-literal Wire feature flag fails closed'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_wire_version(
      repeat('z', 32),
      '11111111111111111111111111111112',
      null,
      'Disabled Wire intake attempt for review',
      'This public-safe summary is long enough but the malformed flag must keep intake disabled.',
      'This detailed analysis is long enough but must never reserve a version while the exact feature flag is malformed or disabled.',
      'The uncertainty statement is present but cannot weaken the dedicated fail-closed gate.',
      null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111112',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111112', 'UTF8'), 'sha256'), 'hex')
      )),
      'wire-disabled-pgtap-0004', repeat('4', 64)
    )
  $test$,
  '55000',
  'OSI V2 Wire writes are disabled',
  'Wire prepare checks the fail-closed flag first'
);
select is(
  (select count(*)::integer from public.event_receipts
    where event_type = 'WIRE_REPORT_VERSION_SUBMITTED'
      and target_type = 'wire_version'),
  2,
  'only the two successful exact Wire versions created receipts'
);
select is(
  (select count(*)::integer from public.wire_report_versions
    where lifecycle_state = 'submitted'),
  2,
  'Phase 1 versions remain submitted and private'
);

select * from finish();
rollback;
