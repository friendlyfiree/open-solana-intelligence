-- Immutable Case Report review, weighted quorum and exact publication.
-- All fixtures roll back with this disposable pgTAP transaction.

begin;
create extension if not exists pgtap with schema extensions;
select plan(54);

select is(
  (select value from public.osi_config where key = 'OSI_V2_REPORT_REVIEW_WRITES_ENABLED'),
  'false',
  'Report review and publication start behind their own disabled flag'
);
select isnt(
  has_function_privilege(
    'authenticated',
    'public.osi_v2_commit_report_review(text,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  true,
  'authenticated clients cannot bypass the Edge gateway to commit a review'
);
select isnt(
  has_function_privilege(
    'anon',
    'public.osi_v2_commit_report_publication(text,text,text,timestamptz)',
    'EXECUTE'
  ),
  true,
  'anonymous clients cannot bypass the Edge gateway to publish'
);

select lives_ok(
  $test$
    insert into public.cases (
      id, public_ref, title, category, summary_public, details_restricted,
      submitted_by_wallet, stage, visibility, risk_tier, subject_refs
    ) values (
      '20000000-0000-4000-8000-000000000001', 'OSI-AAAABBBBCCCC',
      'Report governance fixture', 'other',
      'A public Case used for exact Report review and publication tests.',
      'Restricted Case detail that never enters a public Report projection.',
      '11111111111111111111111111111113', 'open_public', 'public', 'standard', '[]'::jsonb
    )
  $test$,
  'public standard-risk Case fixture is created'
);

update public.osi_config set value = 'true'
 where key in ('OSI_V2_REPORT_WRITES_ENABLED', 'OSI_V2_REPORT_REVIEW_WRITES_ENABLED');
update public.osi_config set value = '0'
 where key in ('OSI_V2_REPORT_COOLDOWN_SECONDS', 'OSI_V2_REPORT_REVIEW_COOLDOWN_SECONDS');

select lives_ok(
  $test$
    create temporary table report_prepare on commit drop as
    select * from public.osi_v2_prepare_report_version(
      repeat('a', 32), '11111111111111111111111111111112',
      '20000000-0000-4000-8000-000000000001',
      'This immutable restricted Report describes transaction order, wallet relationships, evidentiary limits, and uncertainty for independent analyst review.',
      'A public-safe summary for the exact Report version after publication.',
      null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111114',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111114', 'UTF8'), 'sha256'), 'hex')
      )),
      'report-governance-fixture-0001', repeat('1', 64)
    )
  $test$,
  'exact Report version is prepared through the native intake path'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_report_version(
      repeat('a', 32),
      'This immutable restricted Report describes transaction order, wallet relationships, evidentiary limits, and uncertainty for independent analyst review.',
      'A public-safe summary for the exact Report version after publication.',
      null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111114',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111114', 'UTF8'), 'sha256'), 'hex')
      )),
      repeat('R', 88), 'OSI2 test CASE_REPORT_VERSION_SUBMITTED', statement_timestamp()
    )
  $test$,
  'native Report version is committed before governance begins'
);

select lives_ok(
  $test$
    insert into public.analyst_profiles (
      wallet, status, tier_code, verified, approved, weight_cached
    ) values
      ('22222222222222222222222222222222', 'probationary_analyst', 'probationary', true, true, 3.00),
      ('22222222222222222222222222222223', 'probationary_analyst', 'probationary', true, true, 1.00),
      ('22222222222222222222222222222225', 'probationary_analyst', 'probationary', true, true, 0.50),
      ('11111111111111111111111111111112', 'probationary_analyst', 'probationary', true, true, 1.00),
      ('11111111111111111111111111111113', 'probationary_analyst', 'probationary', true, true, 1.00)
  $test$,
  'eligible analyst fixtures include author and Case-owner exclusion subjects'
);

select throws_ok(
  $test$
    select * from public.osi_v2_prepare_report_review(
      repeat('n', 32), '22222222222222222222222222222224',
      (select version_id from pg_temp.report_prepare),
      'approve', 'evidence_reviewed',
      'This unregistered wallet must not be admitted as an analyst reviewer.', null,
      'report-review-normal-wallet-0001', repeat('2', 64)
    )
  $test$,
  '42501',
  'Actor is not an eligible Report analyst',
  'ordinary wallet cannot prepare a counted Report review'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_report_review(
      repeat('o', 32), '11111111111111111111111111111112',
      (select version_id from pg_temp.report_prepare),
      'approve', 'self_review',
      'The Report author must remain excluded even with an eligible analyst profile.', null,
      'report-review-author-denied-0001', repeat('3', 64)
    )
  $test$,
  '42501',
  'Report author and Case owner cannot review this Report',
  'Report author cannot review the exact authored version'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_report_review(
      repeat('c', 32), '11111111111111111111111111111113',
      (select version_id from pg_temp.report_prepare),
      'approve', 'owner_review',
      'The Case owner must remain excluded from decisive Report governance.', null,
      'report-review-owner-denied-0001', repeat('4', 64)
    )
  $test$,
  '42501',
  'Report author and Case owner cannot review this Report',
  'Case owner cannot review a Report attached to their Case'
);

select lives_ok(
  $test$
    create temporary table review_one_prepare on commit drop as
    select * from public.osi_v2_prepare_report_review(
      repeat('d', 32), '22222222222222222222222222222222',
      (select version_id from pg_temp.report_prepare),
      'approve', 'evidence_reviewed',
      'The transaction ordering, source limits, and uncertainty were independently reviewed.',
      'Restricted clustering observation for authorized analysts and full maintainer only.',
      'report-review-analyst-one-0001', repeat('5', 64)
    )
  $test$,
  'first eligible analyst prepares an exact-version review'
);
select ok(
  (
    select nonce.purpose = 'CASE_REPORT_REVIEW_CAST'
       and nonce.actor_wallet = '22222222222222222222222222222222'
       and nonce.target_type = 'report_version'
       and nonce.target_id::uuid = (select version_id from pg_temp.report_prepare)
       and nonce.payload_hash = prepared.payload_hash
       and nonce.binding_context->>'version_public_ref' = prepared.version_public_ref
       and nonce.binding_context->>'actor_role' = 'analyst'
      from pg_temp.review_one_prepare as prepared
      join public.osi_nonces as nonce on nonce.nonce = prepared.issued_nonce
  ),
  'review nonce binds exact version actor role purpose and payload hash'
);
select lives_ok(
  $test$
    create temporary table review_one_commit on commit drop as
    select * from public.osi_v2_commit_report_review(
      repeat('d', 32), 'approve', 'evidence_reviewed',
      'The transaction ordering, source limits, and uncertainty were independently reviewed.',
      'Restricted clustering observation for authorized analysts and full maintainer only.',
      repeat('s', 88), 'OSI2 test CASE_REPORT_REVIEW_CAST'
    )
  $test$,
  'wallet-signed review commits atomically after Edge verification'
);
select ok(
  (
    select receipt.event_type = 'CASE_REPORT_REVIEW_CAST'
       and receipt.target_id::uuid = (select version_id from pg_temp.report_prepare)
       and receipt.actor_wallet = '22222222222222222222222222222222'
       and receipt.actor_role = 'analyst'
       and receipt.proof_type = 'wallet_signed_server_verified'
       and receipt.server_verified = true
       and review.weight = 3.00
       and review.tier_snapshot = 'probationary'
       and review.private_note is not null
      from public.case_report_reviews as review
      join public.event_receipts as receipt on receipt.id = review.event_receipt_id
     where review.public_ref = (select review_public_ref from pg_temp.review_one_prepare)
  ),
  'review receipt and row preserve exact actor proof type weight tier and restricted note'
);
select ok(
  (
    select approve_count = 1 and approve_weight = 3.00
       and required_count = 2 and required_weight = 2.00
       and approve_ready is false
      from osi_private.osi_v2_report_quorum((select version_id from pg_temp.report_prepare))
  ),
  'weight gate alone cannot bypass the independent analyst count gate'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_report_publication(
      repeat('b', 32), '22222222222222222222222222222222',
      (select version_id from pg_temp.report_prepare),
      'report-publication-before-quorum-0001', repeat('b', 64)
    )
  $test$,
  '42501',
  'Report publication quorum is not ready',
  'publication is rejected before both standard quorum gates pass'
);
select is(
  (
    select idempotent_replay from public.osi_v2_commit_report_review(
      repeat('d', 32), 'approve', 'evidence_reviewed',
      'The transaction ordering, source limits, and uncertainty were independently reviewed.',
      'Restricted clustering observation for authorized analysts and full maintainer only.',
      repeat('s', 88), 'OSI2 test CASE_REPORT_REVIEW_CAST'
    )
  ),
  true,
  'exact Report review retry returns the original result'
);
select throws_ok(
  $test$
    select * from public.osi_v2_commit_report_review(
      repeat('d', 32), 'approve', 'evidence_reviewed',
      'A changed rationale cannot reuse the exact consumed review nonce.',
      'Restricted clustering observation for authorized analysts and full maintainer only.',
      repeat('s', 88), 'OSI2 test CASE_REPORT_REVIEW_CAST'
    )
  $test$,
  '23514',
  'Report review payload changed after prepare',
  'changed review payload cannot replay a consumed nonce'
);

select lives_ok(
  $test$
    create temporary table review_two_prepare on commit drop as
    select * from public.osi_v2_prepare_report_review(
      repeat('e', 32), '22222222222222222222222222222223',
      (select version_id from pg_temp.report_prepare),
      'approve', 'independent_review',
      'A second independent analyst checked the exact evidence order and stated limitations.',
      null, 'report-review-analyst-two-0001', repeat('6', 64)
    )
  $test$,
  'second independent analyst prepares an approval'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_report_review(
      repeat('e', 32), 'approve', 'independent_review',
      'A second independent analyst checked the exact evidence order and stated limitations.',
      null, repeat('t', 88), 'OSI2 test CASE_REPORT_REVIEW_CAST second'
    )
  $test$,
  'second independent approval commits'
);
select ok(
  (
    select approve_count = 2 and approve_weight = 4.00
       and required_count = 2 and required_weight = 2.00
       and approve_ready is true
      from osi_private.osi_v2_report_quorum((select version_id from pg_temp.report_prepare))
  ),
  'standard publication is ready only after both count and weight gates pass'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_report_publication(
      repeat('m', 32), '33333333333333333333333333333333',
      (select version_id from pg_temp.report_prepare),
      'report-publication-maintainer-only-0001', repeat('8', 64)
    )
  $test$,
  '42501',
  'Publication requires an active approving eligible analyst',
  'maintainer status cannot replace analyst eligibility approval or quorum participation'
);

select lives_ok(
  $test$
    create temporary table review_revision_prepare on commit drop as
    select * from public.osi_v2_prepare_report_review(
      repeat('f', 32), '22222222222222222222222222222222',
      (select version_id from pg_temp.report_prepare),
      'approve', 'evidence_rechecked',
      'The same analyst rechecked the exact version and clarified the public-safe rationale.',
      'Updated restricted observation; the prior row must remain immutable history.',
      'report-review-analyst-one-0002', repeat('7', 64)
    )
  $test$,
  'analyst prepares a revised review without rewriting prior history'
);
select is(
  (select purpose from pg_temp.review_revision_prepare),
  'CASE_REPORT_REVIEW_REVISED',
  'review history deterministically changes the event type to revised'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_report_review(
      repeat('f', 32), 'approve', 'evidence_rechecked',
      'The same analyst rechecked the exact version and clarified the public-safe rationale.',
      'Updated restricted observation; the prior row must remain immutable history.',
      repeat('u', 88), 'OSI2 test CASE_REPORT_REVIEW_REVISED'
    )
  $test$,
  'revised review appends a successor row'
);
select ok(
  (select count(*) = 2
      and count(*) filter (where is_active) = 1
      and count(*) filter (where not is_active and superseded_by is not null) = 1
     from public.case_report_reviews
    where report_version_id = (select version_id from pg_temp.report_prepare)
      and reviewer_wallet = '22222222222222222222222222222222'),
  'review revision preserves one immutable prior row and one active successor'
);

select lives_ok(
  $test$
    create temporary table publication_prepare on commit drop as
    select * from public.osi_v2_prepare_report_publication(
      repeat('p', 32), '22222222222222222222222222222222',
      (select version_id from pg_temp.report_prepare),
      'report-publication-standard-0001', repeat('8', 64)
    )
  $test$,
  'active approving analyst prepares exact quorum-bound publication'
);
select ok(
  (
    select nonce.purpose = 'REPORT_PUBLISHED'
       and nonce.target_id::uuid = (select version_id from pg_temp.report_prepare)
       and nonce.payload_hash = prepared.payload_hash
       and nonce.binding_context->>'quorum_hash' = prepared.quorum_hash
       and nonce.binding_context->>'version_public_ref' = prepared.version_public_ref
      from pg_temp.publication_prepare as prepared
      join public.osi_nonces as nonce on nonce.nonce = prepared.issued_nonce
  ),
  'publication nonce binds exact version actor payload and frozen quorum hash'
);
select lives_ok(
  $test$
    create temporary table publication_commit on commit drop as
    select * from public.osi_v2_commit_report_publication(
      repeat('p', 32), repeat('P', 88),
      'OSI2 test REPORT_PUBLISHED exact version and quorum', statement_timestamp()
    )
  $test$,
  'confirmed REPORT_PUBLISHED Memo advances publication atomically'
);
select ok(
  (
    select receipt.event_type = 'REPORT_PUBLISHED'
       and receipt.target_id::uuid = version.id
       and receipt.actor_wallet = '22222222222222222222222222222222'
       and receipt.actor_role = 'analyst'
       and receipt.proof_type = 'solana_memo'
       and receipt.tx_sig = repeat('P', 88)
       and receipt.server_verified = true
       and version.lifecycle_state = 'published'
       and version.publication_quorum_hash = (select quorum_hash from pg_temp.publication_prepare)
      from public.case_report_versions as version
      join public.event_receipts as receipt on receipt.id = version.publication_receipt_id
     where version.id = (select version_id from pg_temp.report_prepare)
  ),
  'publication receipt shows exact analyst actor role Memo proof and quorum hash'
);
select ok(
  (
    select report.current_published_version_id = (select version_id from pg_temp.report_prepare)
       and report.current_version_id = (select version_id from pg_temp.report_prepare)
      from public.case_reports as report
     where report.id = (select report_id from pg_temp.report_prepare)
  ),
  'published pointer advances to the exact immutable version'
);
select ok(
  (select stage = 'open_public' and visibility = 'public'
     from public.cases where id = '20000000-0000-4000-8000-000000000001'),
  'Report publication does not resolve close or otherwise mutate the parent Case lifecycle'
);
select is(
  (
    select idempotent_replay from public.osi_v2_commit_report_publication(
      repeat('p', 32), repeat('P', 88),
      'OSI2 test REPORT_PUBLISHED exact version and quorum', statement_timestamp()
    )
  ),
  true,
  'exact publication retry returns the original receipt without duplication'
);
select throws_ok(
  $test$
    select * from public.osi_v2_commit_report_publication(
      repeat('p', 32), repeat('Q', 88),
      'OSI2 test REPORT_PUBLISHED exact version and quorum', statement_timestamp()
    )
  $test$,
  '23514',
  'Consumed Report publication nonce does not match exact retry',
  'a different transaction cannot replay a consumed publication nonce'
);
select is(
  (select count(*)::integer from public.event_receipts
    where event_type = 'REPORT_PUBLISHED'
      and target_id = (select version_id::text from pg_temp.report_prepare)),
  1,
  'publication replay leaves exactly one immutable REPORT_PUBLISHED receipt'
);

select lives_ok(
  $test$
    insert into public.cases (
      id, public_ref, title, category, summary_public, details_restricted,
      submitted_by_wallet, stage, visibility, risk_tier, subject_refs
    ) values (
      '20000000-0000-4000-8000-000000000002', 'OSI-DDDDEEEEFFFF',
      'High-risk quorum fixture', 'other',
      'A high-risk public Case used only to prove stricter Report thresholds.',
      'Restricted high-risk Case detail.',
      '11111111111111111111111111111115', 'open_public', 'public', 'high', '[]'::jsonb
    );
    create temporary table high_report_prepare on commit drop as
    select * from public.osi_v2_prepare_report_version(
      repeat('h', 32), '11111111111111111111111111111116',
      '20000000-0000-4000-8000-000000000002',
      'This high-risk immutable Report has enough restricted narrative for the threshold fixture and remains unpublished throughout the test.',
      null, null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111117',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111117', 'UTF8'), 'sha256'), 'hex')
      )),
      'report-high-risk-fixture-0001', repeat('9', 64)
    );
    select * from public.osi_v2_commit_report_version(
      repeat('h', 32),
      'This high-risk immutable Report has enough restricted narrative for the threshold fixture and remains unpublished throughout the test.',
      null, null,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111117',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111117', 'UTF8'), 'sha256'), 'hex')
      )),
      repeat('H', 88), 'OSI2 test high-risk Report submission', statement_timestamp()
    );
  $test$,
  'high-risk exact Report fixture is committed'
);
select ok(
  (
    select risk_tier = 'high' and required_count = 3 and required_weight = 4.00
       and approve_ready is false
      from osi_private.osi_v2_report_quorum((select version_id from pg_temp.high_report_prepare))
  ),
  'high-risk Report requires at least three analysts and 4.00 approve weight'
);

select lives_ok(
  $test$
    create temporary table high_review_one on commit drop as
    select * from public.osi_v2_prepare_report_review(
      repeat('q', 32), '22222222222222222222222222222222',
      (select version_id from pg_temp.high_report_prepare),
      'approve', 'high_risk_checked',
      'The first high-risk analyst independently checked the exact restricted version.',
      null, 'report-high-review-one-0001', repeat('a', 64)
    );
    select * from public.osi_v2_commit_report_review(
      repeat('q', 32), 'approve', 'high_risk_checked',
      'The first high-risk analyst independently checked the exact restricted version.',
      null, repeat('q', 88), 'OSI2 test high-risk review one'
    );
  $test$,
  'first high-risk approval commits with server-derived weight 3.00'
);
select lives_ok(
  $test$
    create temporary table high_review_two on commit drop as
    select * from public.osi_v2_prepare_report_review(
      repeat('r', 32), '22222222222222222222222222222223',
      (select version_id from pg_temp.high_report_prepare),
      'approve', 'high_risk_checked',
      'The second high-risk analyst independently checked the exact restricted version.',
      null, 'report-high-review-two-0001', repeat('c', 64)
    );
    select * from public.osi_v2_commit_report_review(
      repeat('r', 32), 'approve', 'high_risk_checked',
      'The second high-risk analyst independently checked the exact restricted version.',
      null, repeat('r', 88), 'OSI2 test high-risk review two'
    );
  $test$,
  'second high-risk approval reaches weight 4.00 but not the count gate'
);
select ok(
  (
    select approve_count = 2 and approve_weight = 4.00
       and required_count = 3 and required_weight = 4.00
       and approve_ready is false
      from osi_private.osi_v2_report_quorum((select version_id from pg_temp.high_report_prepare))
  ),
  'two high-risk analysts fail even when their approve weight reaches 4.00'
);
select lives_ok(
  $test$
    create temporary table high_review_three on commit drop as
    select * from public.osi_v2_prepare_report_review(
      repeat('s', 32), '22222222222222222222222222222225',
      (select version_id from pg_temp.high_report_prepare),
      'approve', 'high_risk_checked',
      'The third independent analyst completes the high-risk count gate without client weight.',
      null, 'report-high-review-three-0001', repeat('d', 64)
    );
    select * from public.osi_v2_commit_report_review(
      repeat('s', 32), 'approve', 'high_risk_checked',
      'The third independent analyst completes the high-risk count gate without client weight.',
      null, repeat('v', 88), 'OSI2 test high-risk review three'
    );
  $test$,
  'third high-risk approval commits with server-derived weight 0.50'
);
select ok(
  (
    select approve_count = 3 and approve_weight = 4.50
       and required_count = 3 and required_weight = 4.00
       and approve_ready is true
      from osi_private.osi_v2_report_quorum((select version_id from pg_temp.high_report_prepare))
  ),
  'high-risk publication becomes ready only after count three and weight 4.00 both pass'
);

select lives_ok(
  $test$
    create temporary table corrected_report_prepare on commit drop as
    select * from public.osi_v2_prepare_report_version(
      repeat('x', 32), '11111111111111111111111111111112',
      '20000000-0000-4000-8000-000000000001',
      'This corrected immutable Report version preserves the prior publication while clarifying transaction order, source limits, and uncertainty.',
      'A corrected public-safe summary replaces the current public version only after fresh quorum.',
      (select report_public_ref from pg_temp.report_prepare),
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111114',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111114', 'UTF8'), 'sha256'), 'hex')
      )),
      'author_correction', 'report-correction-fixture-0001', repeat('e', 64)
    );
    select * from public.osi_v2_commit_report_version(
      repeat('x', 32),
      'This corrected immutable Report version preserves the prior publication while clarifying transaction order, source limits, and uncertainty.',
      'A corrected public-safe summary replaces the current public version only after fresh quorum.',
      'author_correction',
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet', 'ref', '11111111111111111111111111111114',
        'sha256', encode(extensions.digest(convert_to('11111111111111111111111111111114', 'UTF8'), 'sha256'), 'hex')
      )),
      repeat('C', 88), 'OSI2 test corrected Report submission', statement_timestamp()
    );
  $test$,
  'author appends a corrected immutable version without rewriting the published one'
);
select lives_ok(
  $test$
    create temporary table corrected_review_one on commit drop as
    select * from public.osi_v2_prepare_report_review(
      repeat('i', 32), '22222222222222222222222222222222',
      (select version_id from pg_temp.corrected_report_prepare),
      'approve', 'correction_checked',
      'The first analyst independently reviewed the corrected exact version and its limits.',
      null, 'report-correction-review-one-0001', repeat('f', 64)
    );
    select * from public.osi_v2_commit_report_review(
      repeat('i', 32), 'approve', 'correction_checked',
      'The first analyst independently reviewed the corrected exact version and its limits.',
      null, repeat('i', 88), 'OSI2 test corrected review one'
    );
  $test$,
  'first analyst approves the corrected exact version'
);
select lives_ok(
  $test$
    create temporary table corrected_review_two on commit drop as
    select * from public.osi_v2_prepare_report_review(
      repeat('j', 32), '22222222222222222222222222222223',
      (select version_id from pg_temp.corrected_report_prepare),
      'approve', 'correction_checked',
      'The second analyst independently reviewed the corrected exact version and its limits.',
      null, 'report-correction-review-two-0001', repeat('0', 64)
    );
    select * from public.osi_v2_commit_report_review(
      repeat('j', 32), 'approve', 'correction_checked',
      'The second analyst independently reviewed the corrected exact version and its limits.',
      null, repeat('j', 88), 'OSI2 test corrected review two'
    );
  $test$,
  'second analyst completes fresh quorum for the corrected exact version'
);
select lives_ok(
  $test$
    create temporary table corrected_publication_prepare on commit drop as
    select * from public.osi_v2_prepare_report_publication(
      repeat('k', 32), '22222222222222222222222222222222',
      (select version_id from pg_temp.corrected_report_prepare),
      'report-correction-publication-0001', repeat('9', 64)
    );
    select * from public.osi_v2_commit_report_publication(
      repeat('k', 32), repeat('Z', 88),
      'OSI2 test corrected REPORT_PUBLISHED exact version and quorum', statement_timestamp()
    );
  $test$,
  'fresh quorum publication advances the current public pointer to the correction'
);
select ok(
  (
    select header.current_published_version_id = corrected.version_id
       and prior.lifecycle_state = 'superseded'
       and prior.superseded_by_version_id = corrected.version_id
       and prior.published_at is not null
       and prior.superseded_at is not null
       and prior.publication_receipt_id is not null
      from public.case_reports as header
      cross join pg_temp.corrected_report_prepare as corrected
      join public.case_report_versions as prior
        on prior.id = (select version_id from pg_temp.report_prepare)
     where header.id = corrected.report_id
  ),
  'corrected publication preserves the old published row and its proof while advancing lineage'
);
select ok(
  (select stage = 'open_public' and visibility = 'public'
     from public.cases where id = '20000000-0000-4000-8000-000000000001'),
  'corrected publication still leaves the parent Case lifecycle unchanged'
);

update public.osi_config set value = 'TRUE'
 where key = 'OSI_V2_REPORT_REVIEW_WRITES_ENABLED';
select is(
  osi_private.osi_v2_report_review_writes_enabled(),
  false,
  'malformed review flag fails closed'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_report_review(
      repeat('z', 32), '22222222222222222222222222222223',
      (select version_id from pg_temp.high_report_prepare),
      'approve', 'disabled',
      'The malformed dedicated flag must stop this otherwise valid analyst review.',
      null, 'report-review-disabled-0001', repeat('0', 64)
    )
  $test$,
  '55000',
  'OSI V2 Report review writes are disabled',
  'malformed dedicated flag blocks every review mutation'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_REPORT_WRITES_ENABLED'),
  'true',
  'review rollout flag remains independent from Report intake flag'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_WRITES_ENABLED'),
  'false',
  'broad V2 writes remain disabled throughout Report governance'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_PROOF_ENABLED'),
  'false',
  'broad V2 proof remains disabled throughout Report governance'
);
select isnt(
  has_table_privilege('anon', 'public.case_report_reviews', 'SELECT'),
  true,
  'anonymous clients cannot read review rows or restricted analyst notes directly'
);

select * from finish();
rollback;
