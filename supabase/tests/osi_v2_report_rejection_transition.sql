-- Exact Report rejection transition: authority, quorum, grants and lifecycle.
-- All fixtures roll back with this disposable pgTAP transaction.

begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- Authorization boundary first: these are service-only proof functions and no
-- browser-reachable role may execute them.
select isnt(
  has_function_privilege(
    'anon',
    'public.osi_v2_prepare_report_rejection(text,text,uuid,text,text)',
    'EXECUTE'
  ),
  true,
  'anonymous clients cannot prepare a Report rejection'
);
select isnt(
  has_function_privilege(
    'authenticated',
    'public.osi_v2_commit_report_rejection(text,text,text,timestamptz)',
    'EXECUTE'
  ),
  true,
  'authenticated clients cannot bypass the Edge gateway to reject'
);
select is(
  has_function_privilege(
    'service_role',
    'public.osi_v2_prepare_report_rejection(text,text,uuid,text,text)',
    'EXECUTE'
  ),
  true,
  'trusted server code can prepare a Report rejection'
);
select is(
  has_function_privilege(
    'service_role',
    'public.osi_v2_commit_report_rejection(text,text,text,timestamptz)',
    'EXECUTE'
  ),
  true,
  'trusted server code can commit a Report rejection'
);

-- REPORT_REJECTED must already be a modeled class-A outcome. If either of these
-- regressed, the receipt insert inside the commit would fail at runtime.
select is(
  public.osi_v2_expected_proof_type('REPORT_REJECTED'),
  'solana_memo',
  'REPORT_REJECTED is a Memo-anchored class-A outcome'
);
select is(
  public.osi_v2_valid_report_version_transition('in_review', 'rejected'),
  true,
  'in_review to rejected is a modeled Report version transition'
);
select is(
  public.osi_v2_valid_report_version_transition('published', 'rejected'),
  false,
  'a published version can never be turned into a rejection'
);
select is(
  public.osi_v2_valid_report_version_transition('rejected', 'superseded'),
  true,
  'a rejected version can still be superseded by a later revision'
);

-- The payload binding is deterministic, distinct from publication, and moves
-- with the quorum snapshot.
select is(
  osi_private.osi_v2_report_rejection_payload_hash(
    '30000000-0000-4000-8000-000000000001', 'OSI-RV-000000000000000A',
    '11111111111111111111111111111114', 'restricted body', null,
    repeat('a', 64), repeat('b', 64)
  ),
  osi_private.osi_v2_report_rejection_payload_hash(
    '30000000-0000-4000-8000-000000000001', 'OSI-RV-000000000000000A',
    '11111111111111111111111111111114', 'restricted body', null,
    repeat('a', 64), repeat('b', 64)
  ),
  'the rejection payload hash is deterministic for one exact input'
);
select isnt(
  osi_private.osi_v2_report_rejection_payload_hash(
    '30000000-0000-4000-8000-000000000001', 'OSI-RV-000000000000000A',
    '11111111111111111111111111111114', 'restricted body', null,
    repeat('a', 64), repeat('b', 64)
  ),
  osi_private.osi_v2_report_rejection_payload_hash(
    '30000000-0000-4000-8000-000000000001', 'OSI-RV-000000000000000A',
    '11111111111111111111111111111114', 'restricted body', null,
    repeat('a', 64), repeat('c', 64)
  ),
  'a changed quorum snapshot changes the rejection payload hash'
);
select isnt(
  osi_private.osi_v2_report_rejection_payload_hash(
    '30000000-0000-4000-8000-000000000001', 'OSI-RV-000000000000000A',
    '11111111111111111111111111111114', 'restricted body', null,
    repeat('a', 64), repeat('b', 64)
  ),
  osi_private.osi_v2_report_publication_payload_hash(
    '30000000-0000-4000-8000-000000000001', 'OSI-RV-000000000000000A',
    '11111111111111111111111111111114', 'restricted body', null,
    repeat('a', 64), repeat('b', 64), null
  ),
  'a rejection proof can never be replayed as a publication proof'
);

-- Writes stay behind the existing dedicated Report review flag, so the new
-- transition cannot become reachable before that gate is deliberately opened.
select is(
  (select value from public.osi_config where key = 'OSI_V2_REPORT_REVIEW_WRITES_ENABLED'),
  'false',
  'Report rejection ships behind the same disabled Report review flag'
);
select throws_ok(
  $test$
    select * from osi_private.osi_v2_prepare_report_rejection(
      'nonce-rejection-disabled-flag-0001',
      '11111111111111111111111111111114',
      '30000000-0000-4000-8000-000000000001',
      'report-reject:disabled-flag-fixture',
      repeat('d', 64)
    )
  $test$,
  '55000',
  'OSI V2 Report review writes are disabled',
  'rejection prepare fails closed while the Report review flag is false'
);
select throws_ok(
  $test$
    select * from osi_private.osi_v2_commit_report_rejection(
      'nonce-rejection-disabled-flag-0001', repeat('1', 88),
      'OSI2|1|REPORT_REJECTED|t=report_version', now()
    )
  $test$,
  '55000',
  'OSI V2 Report review writes are disabled',
  'rejection commit fails closed while the Report review flag is false'
);

select * from finish();
rollback;
