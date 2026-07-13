-- Native analyst profile, immutable application, exact-version review, and
-- probation activation integration tests. Disposable local database only.

begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

select is(
  (select value from public.osi_config where key = 'OSI_V2_WRITES_ENABLED'),
  'false',
  'broad V2 writes remain disabled'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_PROOF_ENABLED'),
  'false',
  'broad V2 proof writes remain disabled'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_ANALYST_WRITES_ENABLED'),
  'false',
  'analyst writes fail closed after migration'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_FALLBACK_GOVERNANCE'),
  'false',
  'fallback governance remains disabled'
);

select ok(
  (select relrowsecurity and relforcerowsecurity
     from pg_class where oid = 'public.analyst_profiles'::regclass),
  'analyst profiles retain enabled and forced RLS'
);
select ok(
  (select relrowsecurity and relforcerowsecurity
     from pg_class where oid = 'public.analyst_applications'::regclass),
  'analyst application headers retain enabled and forced RLS'
);
select ok(
  (select relrowsecurity and relforcerowsecurity
     from pg_class where oid = 'public.analyst_application_versions'::regclass),
  'restricted immutable versions retain enabled and forced RLS'
);
select ok(
  (select relrowsecurity and relforcerowsecurity
     from pg_class where oid = 'public.analyst_application_reviews'::regclass),
  'application reviews retain enabled and forced RLS'
);
select isnt(
  has_table_privilege('anon', 'public.analyst_application_versions', 'SELECT'),
  true,
  'anonymous clients cannot read restricted application versions'
);
select isnt(
  has_table_privilege('authenticated', 'public.analyst_application_reviews', 'INSERT'),
  true,
  'authenticated clients cannot insert review outcomes'
);
select isnt(
  has_function_privilege(
    'authenticated',
    'public.osi_v2_commit_analyst_application(text,text,text,text,text,text,jsonb,jsonb,jsonb,text,text,text)',
    'EXECUTE'
  ),
  true,
  'authenticated clients cannot bypass the analyst Edge gateway'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.osi_v2_commit_analyst_probation(text,text,text,text,timestamptz)',
    'EXECUTE'
  ),
  'trusted service role can reach the probation commit wrapper'
);
select is(
  (
    select public and file_size_limit = 524288
       and allowed_mime_types = array['image/png', 'image/jpeg']::text[]
      from storage.buckets where id = 'osi-analyst-avatars'
  ),
  true,
  'avatar bucket has exact public-read MIME and size limits'
);
select is(
  (
    select count(*)::integer
      from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
       and cmd in ('INSERT', 'UPDATE', 'DELETE')
       and (qual ilike '%osi-analyst-avatars%' or with_check ilike '%osi-analyst-avatars%')
  ),
  0,
  'browser roles receive no direct avatar mutation policy'
);

update public.osi_config
   set value = 'true', updated_at = statement_timestamp()
 where key = 'OSI_V2_ANALYST_WRITES_ENABLED';

select lives_ok(
  $test$
    create temporary table osi_application_nonce_v1 on commit drop as
    select * from public.osi_v2_issue_analyst_nonce(
      repeat('a', 32), 'ANALYST_APPLICATION_VERSION_SUBMITTED',
      '44444444444444444444444444444444', 'wallet', null,
      repeat('1', 64), 'analyst-application-v1-0001', repeat('2', 64)
    )
  $test$,
  'applicant receives a server-generated exact-version nonce'
);
select is(
  (
    select jsonb_build_object(
      'purpose', nonce.purpose,
      'actor_wallet', nonce.actor_wallet,
      'target_type', nonce.target_type,
      'target_matches', nonce.target_id = issued.target_id,
      'payload_hash', nonce.payload_hash,
      'public_ref_matches', issued.public_ref = osi_private.osi_v2_application_ref(nonce.target_id::uuid),
      'version_no', issued.version_no
    )
      from pg_temp.osi_application_nonce_v1 as issued
      join public.osi_nonces as nonce on nonce.nonce = issued.issued_nonce
  ),
  jsonb_build_object(
    'purpose', 'ANALYST_APPLICATION_VERSION_SUBMITTED',
    'actor_wallet', '44444444444444444444444444444444',
    'target_type', 'application_version',
    'target_matches', true,
    'payload_hash', repeat('1', 64),
    'public_ref_matches', true,
    'version_no', 1
  ),
  'nonce persists exact purpose, actor, target and payload binding'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_analyst_application(
      repeat('a', 32), repeat('1', 64), repeat('S', 88),
      'chain_sleuth', 'Chain Sleuth',
      'Independent Solana transaction researcher focused on attributable public evidence.',
      '["blockchain_forensics", "osint"]'::jsonb,
      '[{"label":"Research","url":"https://example.com/work"}]'::jsonb,
      '{"motivation":"Review public incident evidence with reproducible methods.","experience":"Published transaction research.","proof_urls":["https://example.com/proof"]}'::jsonb,
      null, null, null
    )
  $test$,
  'first immutable application version commits atomically'
);
select is(
  (
    select application.status || ':' || version.version_no::text
      from public.analyst_applications as application
      join public.analyst_application_versions as version
        on version.id = application.current_version_id
     where application.applicant_wallet = '44444444444444444444444444444444'
  ),
  'in_review:1',
  'new application enters exact-version review'
);
select is(
  (
    select profile.status || ':' || profile.weight_cached::text
      from public.analyst_profiles as profile
     where profile.wallet = '44444444444444444444444444444444'
  ),
  'analyst_candidate:0.00',
  'application creates a non-eligible candidate profile'
);
select ok(
  (
    select receipt.event_type = 'ANALYST_APPLICATION_VERSION_SUBMITTED'
       and receipt.target_id = version.id::text
       and receipt.actor_wallet = application.applicant_wallet
       and receipt.proof_type = 'wallet_signed_server_verified'
       and receipt.server_verified is true
      from public.analyst_applications as application
      join public.analyst_application_versions as version
        on version.id = application.current_version_id
      join public.event_receipts as receipt on receipt.id = version.event_receipt_id
     where application.applicant_wallet = '44444444444444444444444444444444'
  ),
  'version receipt binds exact version and applicant'
);
select is(
  (
    select idempotent_replay
      from public.osi_v2_commit_analyst_application(
        repeat('a', 32), repeat('1', 64), repeat('S', 88),
        'chain_sleuth', 'Chain Sleuth',
        'Independent Solana transaction researcher focused on attributable public evidence.',
        '["blockchain_forensics", "osint"]'::jsonb,
        '[{"label":"Research","url":"https://example.com/work"}]'::jsonb,
        '{"motivation":"Review public incident evidence with reproducible methods."}'::jsonb,
        null, null, null
      )
  ),
  true,
  'exact application replay returns the original result'
);
select throws_ok(
  $test$
    select * from public.osi_v2_commit_analyst_application(
      repeat('a', 32), repeat('9', 64), repeat('S', 88),
      'chain_sleuth', 'Chain Sleuth',
      'Independent Solana transaction researcher focused on attributable public evidence.',
      '["osint"]'::jsonb, '[]'::jsonb, '{}'::jsonb,
      null, null, null
    )
  $test$,
  '23514',
  'Application nonce binding is invalid',
  'application replay with a different payload hash is rejected'
);
select throws_ok(
  $test$
    select * from public.osi_v2_issue_analyst_nonce(
      repeat('b', 32), 'ANALYST_APPLICATION_REVIEW_CAST',
      '44444444444444444444444444444444', 'maintainer',
      (select current_version_id::text from public.analyst_applications
        where applicant_wallet = '44444444444444444444444444444444'),
      repeat('3', 64), 'analyst-self-review-0001', repeat('4', 64)
    )
  $test$,
  '42501',
  'Application version is not reviewable by this actor',
  'applicant cannot review their own exact version'
);
select throws_ok(
  $test$
    select * from public.osi_v2_issue_analyst_nonce(
      repeat('c', 32), 'ANALYST_APPLICATION_REVIEW_CAST',
      '55555555555555555555555555555555', 'wallet',
      (select current_version_id::text from public.analyst_applications
        where applicant_wallet = '44444444444444444444444444444444'),
      repeat('3', 64), 'analyst-normal-review-0001', repeat('5', 64)
    )
  $test$,
  '42501',
  'Application operations review requires full maintainer role',
  'normal wallet cannot issue an application review'
);

select lives_ok(
  $test$
    select * from public.osi_v2_issue_analyst_nonce(
      repeat('d', 32), 'ANALYST_APPLICATION_REVIEW_CAST',
      '66666666666666666666666666666666', 'maintainer',
      (select current_version_id::text from public.analyst_applications
        where applicant_wallet = '44444444444444444444444444444444'),
      repeat('6', 64), 'analyst-revision-request-0001', repeat('7', 64)
    )
  $test$,
  'maintainer receives an exact-version revision-request nonce'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_application_review(
      repeat('d', 32), repeat('6', 64), repeat('R', 88),
      'request_revision', 'more_public_work_samples'
    )
  $test$,
  'maintainer revision request is recorded as immutable weight-zero review'
);
select is(
  (
    select application.status from public.analyst_applications as application
     where application.applicant_wallet = '44444444444444444444444444444444'
  ),
  'revision_requested',
  'revision request advances only the application header state'
);
select is(
  (
    select review.weight
      from public.analyst_application_reviews as review
     where review.reviewer_wallet = '66666666666666666666666666666666'
       and review.decision = 'request_revision'
  ),
  0.00::numeric,
  'maintainer application review fabricates no analyst voting weight'
);

select lives_ok(
  $test$
    create temporary table osi_application_nonce_v2 on commit drop as
    select * from public.osi_v2_issue_analyst_nonce(
      repeat('e', 32), 'ANALYST_APPLICATION_VERSION_SUBMITTED',
      '44444444444444444444444444444444', 'wallet', null,
      repeat('8', 64), 'analyst-application-v2-0001', repeat('9', 64)
    )
  $test$,
  'revision receives a new server-generated exact-version nonce'
);
select is(
  (select version_no from pg_temp.osi_application_nonce_v2),
  2,
  'revision nonce is bound to version two'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_analyst_application(
      repeat('e', 32), repeat('8', 64), repeat('V', 88),
      'chain_sleuth', 'Chain Sleuth',
      'Independent Solana transaction researcher with expanded public work samples.',
      '["blockchain_forensics", "data_analysis", "osint"]'::jsonb,
      '[{"label":"Research","url":"https://example.com/work-v2"}]'::jsonb,
      '{"motivation":"Review public incident evidence with reproducible methods.","experience":"Expanded public transaction research.","proof_urls":["https://example.com/proof-v2"]}'::jsonb,
      null, null, null
    )
  $test$,
  'revision creates a second immutable application version'
);
select is(
  (
    select count(*)::integer from public.analyst_application_versions as version
    join public.analyst_applications as application on application.id = version.application_id
    where application.applicant_wallet = '44444444444444444444444444444444'
  ),
  2,
  'prior application version remains preserved'
);
select is(
  (
    select version.version_no
      from public.analyst_applications as application
      join public.analyst_application_versions as version
        on version.id = application.current_version_id
     where application.applicant_wallet = '44444444444444444444444444444444'
  ),
  2,
  'header advances to the new exact version'
);
select is(
  (
    select count(*)::integer
      from public.analyst_application_reviews as review
      join public.analyst_application_versions as version
        on version.id = review.application_version_id
     where version.version_no = 1
       and review.decision = 'request_revision'
  ),
  1,
  'historical review remains bound to version one'
);

select lives_ok(
  $test$
    select * from public.osi_v2_issue_analyst_nonce(
      repeat('f', 32), 'ANALYST_APPLICATION_REVIEW_CAST',
      '66666666666666666666666666666666', 'maintainer',
      (select current_version_id::text from public.analyst_applications
        where applicant_wallet = '44444444444444444444444444444444'),
      repeat('a', 64), 'analyst-approval-v2-0001', repeat('b', 64)
    )
  $test$,
  'maintainer receives the exact version-two approval nonce'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_application_review(
      repeat('f', 32), repeat('a', 64), repeat('A', 88),
      'approve', 'meets_probationary_baseline'
    )
  $test$,
  'maintainer approval is recorded without activating before Memo proof'
);
select is(
  (
    select profile.status || ':' || profile.weight_cached::text
      from public.analyst_profiles as profile
     where profile.wallet = '44444444444444444444444444444444'
  ),
  'analyst_candidate:0.00',
  'approval alone cannot fabricate eligibility before ANALYST_PROBATION Memo'
);

select lives_ok(
  $test$
    select * from public.osi_v2_issue_analyst_nonce(
      repeat('g', 32), 'ANALYST_PROBATION',
      '66666666666666666666666666666666', 'maintainer',
      '44444444444444444444444444444444', repeat('c', 64),
      'analyst-probation-0001', repeat('d', 64)
    )
  $test$,
  'approving maintainer receives exact candidate probation nonce'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_analyst_probation(
      repeat('g', 32), repeat('c', 64), repeat('T', 88),
      'OSI2 test ANALYST_PROBATION memo', statement_timestamp()
    )
  $test$,
  'confirmed ANALYST_PROBATION Memo activates the candidate atomically'
);
select is(
  (
    select jsonb_build_object(
      'status', profile.status,
      'tier', profile.tier_code,
      'verified', profile.verified,
      'approved', profile.approved,
      'weight', profile.weight_cached,
      'verified_by', profile.verified_by
    )
      from public.analyst_profiles as profile
     where profile.wallet = '44444444444444444444444444444444'
  ),
  jsonb_build_object(
    'status', 'probationary_analyst',
    'tier', 'probationary',
    'verified', true,
    'approved', true,
    'weight', 0.50::numeric,
    'verified_by', '66666666666666666666666666666666'
  ),
  'probation status, tier and exact 0.50 weight are server-derived'
);
select is(
  (
    select application.status from public.analyst_applications as application
     where application.applicant_wallet = '44444444444444444444444444444444'
  ),
  'approved',
  'application becomes approved only with probation activation'
);
select ok(
  (
    select receipt.event_type = 'ANALYST_PROBATION'
       and receipt.target_type = 'analyst'
       and receipt.target_id = profile.wallet
       and receipt.actor_wallet = '66666666666666666666666666666666'
       and receipt.actor_role = 'maintainer'
       and receipt.proof_type = 'solana_memo'
       and receipt.server_verified is true
       and receipt.weight = 0.50
      from public.analyst_profiles as profile
      join public.event_receipts as receipt on receipt.id = profile.verified_receipt_id
     where profile.wallet = '44444444444444444444444444444444'
  ),
  'probation receipt binds exact analyst, actor, role, proof and derived weight'
);
select is(
  (
    select idempotent_replay from public.osi_v2_commit_analyst_probation(
      repeat('g', 32), repeat('c', 64), repeat('T', 88),
      'OSI2 test ANALYST_PROBATION memo', statement_timestamp()
    )
  ),
  true,
  'probation replay returns the original activation'
);
select throws_ok(
  $test$
    select * from public.osi_v2_commit_analyst_probation(
      repeat('g', 32), repeat('e', 64), repeat('T', 88),
      'OSI2 test ANALYST_PROBATION memo', statement_timestamp()
    )
  $test$,
  '23514',
  'Analyst probation nonce binding is invalid',
  'probation replay with a different payload hash is rejected'
);
select throws_ok(
  $test$
    update public.analyst_application_versions
       set details_restricted = '{"rewritten":true}'::jsonb
     where id = (
       select current_version_id from public.analyst_applications
       where applicant_wallet = '44444444444444444444444444444444'
     )
  $test$,
  '55000',
  'OSI V2 immutable row: UPDATE denied on public.analyst_application_versions',
  'submitted application version cannot be rewritten'
);
select throws_ok(
  $test$
    update public.analyst_application_reviews
       set decision = 'reject'
     where reviewer_wallet = '66666666666666666666666666666666'
       and decision = 'approve'
  $test$,
  '55000',
  'Historical review decision/weight/target are immutable',
  'historical review decision cannot be overwritten'
);

select * from finish();
rollback;
