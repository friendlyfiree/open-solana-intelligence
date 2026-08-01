-- Regression coverage for the production Wire prepare failure when the
-- owner-approved optional structured evidence block is left empty.

begin;

create extension if not exists pgtap with schema extensions;
select plan(7);

update public.osi_config set value = 'true'
 where key = 'OSI_V2_WIRE_WRITES_ENABLED';
update public.osi_config set value = '0'
 where key = 'OSI_V2_WIRE_COOLDOWN_SECONDS';

select lives_ok(
  $test$
    create temporary table osi_wire_empty_evidence_prepare on commit drop as
    select * from public.osi_v2_prepare_wire_version(
      repeat('e', 32),
      '11111111111111111111111111111112',
      null,
      'DEX',
      'Public flow',
      'Public transactions show a repeated transfer pattern.',
      '',
      null,
      '[]'::jsonb,
      'wire-empty-evidence-pgtap-0001',
      repeat('1', 64)
    )
  $test$,
  'Wire prepare accepts the minimal required content and empty optional evidence'
);

select is(
  (
    select evidence_manifest_hash
      from pg_temp.osi_wire_empty_evidence_prepare
  ),
  encode(
    extensions.digest(convert_to('[]', 'UTF8'), 'sha256'),
    'hex'
  ),
  'empty Wire evidence receives the deterministic empty-manifest hash'
);

select lives_ok(
  $test$
    select * from public.osi_v2_commit_wire_version(
      repeat('e', 32),
      'DEX',
      'Public flow',
      'Public transactions show a repeated transfer pattern.',
      '',
      null,
      '[]'::jsonb,
      repeat('R', 88),
      'OSI2 test WIRE_REPORT_VERSION_SUBMITTED empty evidence',
      statement_timestamp()
    )
  $test$,
  'Wire commit accepts the exact prepared empty evidence manifest'
);

select is(
  (
    select count(*)::integer
      from public.wire_report_version_evidence
     where wire_report_version_id = (
       select version_id from pg_temp.osi_wire_empty_evidence_prepare
     )
  ),
  0,
  'an empty Wire manifest creates no invented evidence rows'
);

select ok(
  (
    select version.title_public_safe = 'DEX'
       and version.content_public_safe = 'Public flow'
       and version.uncertainties_private = ''
      from public.wire_report_versions as version
     where version.id = (
       select version_id from pg_temp.osi_wire_empty_evidence_prepare
     )
  ),
  'the exact minimal Wire content is persisted without placeholder values'
);

select is(
  osi_private.osi_v2_report_evidence_manifest('[]'::jsonb),
  '[]'::jsonb,
  'Case Reports and Wire Reports share the canonical optional empty evidence manifest'
);

select throws_ok(
  $test$
    select osi_private.osi_v2_wire_evidence_manifest(
      jsonb_build_array(jsonb_build_object(
        'kind', 'url',
        'ref', 'http://example.com',
        'sha256', encode(
          extensions.digest(convert_to('http://example.com', 'UTF8'), 'sha256'),
          'hex'
        )
      ))
    )
  $test$,
  '23514',
  'Report evidence contains an unsupported or malformed reference',
  'supplied Wire evidence still requires a valid HTTPS URL'
);

select * from finish();
rollback;
