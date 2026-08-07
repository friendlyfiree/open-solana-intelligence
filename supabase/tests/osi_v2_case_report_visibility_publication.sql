-- Case and Report public-safe visibility, analyst publication authority, and
-- long-form intake bounds.
--
-- Every fixture rolls back with this disposable pgTAP transaction. The suite
-- proves the three defects fixed in
-- 20260807090000_osi_v2_case_report_visibility_publication.sql are actually
-- fixed at the database boundary, and that the privacy boundary they sit next
-- to did not move:
--
--   * intake evidence stays private and pending until an authorized publication
--     transition promotes it, and IS promoted by that transition;
--   * an eligible analyst can genuinely reach the public-open transition, and a
--     wallet the write path would refuse is told exactly why by the same
--     capability projection the UI reads;
--   * the widened long-form bounds accept the new maximums and still refuse
--     input beyond them rather than truncating it.

begin;
create extension if not exists pgtap with schema extensions;
select plan(51);

-- ---------------------------------------------------------------------------
-- Privilege boundary for the new capability projection.
-- ---------------------------------------------------------------------------
select isnt(has_function_privilege('anon',
  'public.osi_v2_case_opening_capabilities(text,uuid[],text)','EXECUTE'),true,
  'anonymous clients cannot read the Case opening capability projection');
select isnt(has_function_privilege('authenticated',
  'public.osi_v2_case_opening_capabilities(text,uuid[],text)','EXECUTE'),true,
  'authenticated clients cannot read the Case opening capability projection');
select ok(has_function_privilege('service_role',
  'public.osi_v2_case_opening_capabilities(text,uuid[],text)','EXECUTE'),
  'trusted server code can read the Case opening capability projection');

-- ---------------------------------------------------------------------------
-- Widened long-form bounds. A widening must accept the new maximum and still
-- refuse anything past it; content is never silently trimmed to fit.
-- ---------------------------------------------------------------------------
select lives_ok(
  $test$insert into public.cases (
    id, public_ref, title, category, summary_public, details_restricted,
    submitted_by_wallet, stage, visibility, risk_tier, subject_refs
  ) values (
    '30000000-0000-4000-8000-000000000009','OSI-LONGFORM0001',
    'Long form bound fixture','other', repeat('s',10000), repeat('d',25000),
    '11111111111111111111111111111119','draft','private','standard','[]'::jsonb
  )$test$,
  'a 10000 character public summary and a 25000 character restricted detail are accepted');
select throws_ok(
  $test$insert into public.cases (
    id, public_ref, title, category, summary_public, details_restricted,
    submitted_by_wallet, stage, visibility, risk_tier, subject_refs
  ) values (
    '30000000-0000-4000-8000-000000000010','OSI-LONGFORM0002',
    'Over bound fixture','other', repeat('s',10001), '',
    '11111111111111111111111111111119','draft','private','standard','[]'::jsonb
  )$test$,
  '23514',
  'new row for relation "cases" violates check constraint "cases_summary_public_length_check"',
  'a public summary past the widened bound is refused rather than truncated');
select lives_ok(
  $test$select osi_private.osi_v2_validate_report_content(
    repeat('b',80), repeat('p',10000), null, false)$test$,
  'a 10000 character public-safe Report summary is accepted');
select throws_ok(
  $test$select osi_private.osi_v2_validate_report_content(
    repeat('b',80), repeat('p',10001), null, false)$test$,
  '23514','Public-safe summary must contain between 1 and 10000 trimmed characters',
  'a public-safe Report summary past the widened bound is refused with an exact error');
select lives_ok(
  $test$select osi_private.osi_v2_validate_report_content(
    repeat('b',100000), null, null, false)$test$,
  'a 100000 character restricted Report narrative is accepted unchanged');
select lives_ok(
  $test$select osi_private.osi_v2_validate_wire_content(
    'Wire bound fixture', repeat('w',10000), repeat('a',100),
    repeat('u',10000), null, false)$test$,
  'the widened Wire summary and uncertainty bounds are accepted');

-- ---------------------------------------------------------------------------
-- Case fixture: private intake with a full structured manifest.
-- ---------------------------------------------------------------------------
update public.osi_config set value='false'
 where key='OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED';

insert into public.analyst_profiles(wallet,status,tier_code,verified,approved,weight_cached)
values ('22222222222222222222222222222232','probationary_analyst','probationary',true,true,1.00);

create temporary table visibility_case on commit drop as
select * from public.osi_v2_issue_case_nonce(
  repeat('v',32),'CASE_SUBMITTED','11111111111111111111111111111117','owner',null,
  repeat('a',64),'case-visibility-fixture-submit',repeat('7',64));

create temporary table intake_manifest on commit drop as
select jsonb_build_array(
  jsonb_build_object('kind','wallet','ref','11111111111111111111111111111118',
    'sha256',encode(extensions.digest(pg_catalog.convert_to(
      '11111111111111111111111111111118','UTF8'),'sha256'),'hex')),
  jsonb_build_object('kind','onchain_tx','ref',repeat('K',88),
    'sha256',encode(extensions.digest(pg_catalog.convert_to(
      repeat('K',88),'UTF8'),'sha256'),'hex')),
  jsonb_build_object('kind','url','ref','https://example.org/case-source',
    'sha256',encode(extensions.digest(pg_catalog.convert_to(
      'https://example.org/case-source','UTF8'),'sha256'),'hex'))
) as body;

select lives_ok(
  $test$select * from public.osi_v2_commit_case_submission(
    repeat('v',32),repeat('a',64),'Structured intake visibility Case','other',
    'A neutral public-safe summary that must remain readable at every authorized stage.',
    'Restricted intake detail that never enters an anonymous projection.',
    null,(select body from intake_manifest),repeat('V',88),
    'OSI2 test CASE_SUBMITTED memo',statement_timestamp())$test$,
  'a Case is submitted with wallet, transaction and HTTPS references');

select is(
  (select count(*)::integer from public.case_evidence_links as link
     join public.evidence_items as evidence on evidence.id=link.evidence_item_id
    where link.case_id=(select target_id::uuid from visibility_case)),
  3,
  'all three structured intake references are persisted, not dropped');
select ok(
  (select bool_and(evidence.is_public=false and evidence.moderation_state='pending')
     from public.case_evidence_links as link
     join public.evidence_items as evidence on evidence.id=link.evidence_item_id
    where link.case_id=(select target_id::uuid from visibility_case)),
  'intake evidence starts private and pending while the Case is in private review');
select ok(
  (select summary_public like 'A neutral public-safe summary%'
      and details_restricted like 'Restricted intake detail%'
     from public.cases where id=(select target_id::uuid from visibility_case)),
  'the exact submitted summary and restricted detail are stored on the Case row');

-- ---------------------------------------------------------------------------
-- Capability projection before any review exists.
-- ---------------------------------------------------------------------------
select is(
  (select public_open_reason_code from public.osi_v2_case_opening_capabilities(
    '22222222222222222222222222222232',
    array[(select target_id::uuid from visibility_case)])),
  'no_active_approve_open_review',
  'an eligible analyst with no review is told the exact missing prerequisite');
select ok(
  (select can_cast_initial_review and not can_anchor_public_open
     from public.osi_v2_case_opening_capabilities(
       '22222222222222222222222222222232',
       array[(select target_id::uuid from visibility_case)])),
  'an eligible analyst may review but may not yet anchor the public open');
select ok(
  (select actor_is_case_owner and not can_cast_initial_review
      and not can_anchor_public_open
      and public_open_reason_code='case_owner_conflict'
     from public.osi_v2_case_opening_capabilities(
       '11111111111111111111111111111117',
       array[(select target_id::uuid from visibility_case)])),
  'the Case owner is refused both the review and the opening path by exact reason');
select ok(
  (select not actor_is_eligible_analyst and not can_cast_initial_review
      and not can_anchor_public_open
      and public_open_reason_code='not_eligible_reviewer'
     from public.osi_v2_case_opening_capabilities(
       '99999999999999999999999999999999',
       array[(select target_id::uuid from visibility_case)])),
  'an unregistered wallet is refused with the exact not-eligible reason');

-- ---------------------------------------------------------------------------
-- Analyst review, then the analyst opening path end to end.
-- ---------------------------------------------------------------------------
select lives_ok(
  $test$select * from public.osi_v2_issue_case_nonce(
    repeat('w',32),'CASE_INITIAL_REVIEW_CAST','22222222222222222222222222222232',
    'analyst',(select target_id from visibility_case),repeat('b',64),
    'case-visibility-review-0001',repeat('8',64))$test$,
  'the eligible analyst receives an exact initial-review nonce');
select lives_ok(
  $test$select * from public.osi_v2_commit_case_review_current(
    repeat('w',32),repeat('b',64),repeat('W',88),'analyst','approve_open',
    'public_scope_clear')$test$,
  'the eligible analyst records a wallet-signed approve-open review');
select ok(
  (select analyst_ready and not maintainer_ready
     from osi_private.osi_v2_case_review_quorum(
       (select target_id::uuid from visibility_case))),
  'one counted analyst at weight 1.00 satisfies the analyst opening threshold alone');
select ok(
  (select can_anchor_public_open and decision_channel='standard'
      and public_open_reason_code is null
      and actor_active_decision='approve_open'
     from public.osi_v2_case_opening_capabilities(
       '22222222222222222222222222222232',
       array[(select target_id::uuid from visibility_case)])),
  'the approving analyst is now authorized to anchor the public open on the standard channel');
-- A second eligible analyst who cast no review must not be able to ride the
-- first analyst's quorum. Opening authority belongs to the wallet that owns the
-- active counted approval, never to whoever happens to be eligible.
insert into public.analyst_profiles(wallet,status,tier_code,verified,approved,weight_cached)
values ('22222222222222222222222222222235','probationary_analyst','probationary',true,true,1.00);
select ok(
  (select actor_is_eligible_analyst and analyst_quorum_ready
      and not can_anchor_public_open
      and public_open_reason_code='no_active_approve_open_review'
     from public.osi_v2_case_opening_capabilities(
       '22222222222222222222222222222235',
       array[(select target_id::uuid from visibility_case)])),
  'a ready analyst quorum does not transfer opening authority to an analyst who did not approve');
select throws_ok(
  $test$select * from public.osi_v2_prepare_case_open_outcome(
    repeat('y',32),'99999999999999999999999999999999','analyst',
    (select target_id::uuid from visibility_case),
    'case-visibility-open-denied',repeat('9',64))$test$,
  '42501','Current analyst opening path is not ready',
  'the write path refuses an unauthorized wallet even though a quorum exists');
select throws_ok(
  $test$select * from public.osi_v2_prepare_case_open_outcome(
    repeat('z',32),'11111111111111111111111111111117','analyst',
    (select target_id::uuid from visibility_case),
    'case-visibility-open-owner',repeat('0',64))$test$,
  '42501','Case is not openable by this actor',
  'the Case owner can never anchor the public open on their own Case');

create temporary table visibility_open on commit drop as
select * from public.osi_v2_prepare_case_open_outcome(
  repeat('x',32),'22222222222222222222222222222232','analyst',
  (select target_id::uuid from visibility_case),
  'case-visibility-open-0001',repeat('6',64));
select is((select actor_role from visibility_open),'analyst',
  'the prepared opening receipt role is the analyst, not the maintainer');
select lives_ok(
  $test$select * from public.osi_v2_commit_case_open_outcome(
    repeat('x',32),repeat('X',88),'OSI2 test CASE_OPENED memo',statement_timestamp())$test$,
  'the eligible analyst anchors CASE_OPENED with a confirmed Memo');
select is(
  (select stage||':'||visibility from public.cases
    where id=(select target_id::uuid from visibility_case)),
  'open_public:public',
  'the analyst opening path alone makes the Case public');
select ok(
  (select receipt.actor_wallet='22222222222222222222222222222232'
      and receipt.actor_role='analyst' and receipt.proof_type='solana_memo'
      and receipt.server_verified
     from public.cases as case_row
     join public.event_receipts as receipt on receipt.id=case_row.opened_receipt_id
    where case_row.id=(select target_id::uuid from visibility_case)),
  'the CASE_OPENED receipt attributes the analyst wallet and a server-verified Memo');

-- The defect this suite exists for: the manifest the analyst reviewed becomes
-- public-safe in the same transaction as the outcome receipt.
select ok(
  (select bool_and(evidence.is_public and evidence.moderation_state='approved')
     from public.case_evidence_links as link
     join public.evidence_items as evidence on evidence.id=link.evidence_item_id
    where link.case_id=(select target_id::uuid from visibility_case)),
  'CASE_OPENED promotes the reviewed intake manifest to public-safe');
select is(
  (select count(*)::integer from public.case_evidence_links as link
     join public.evidence_items as evidence on evidence.id=link.evidence_item_id
    where link.case_id=(select target_id::uuid from visibility_case)
      and evidence.ref in ('11111111111111111111111111111118',
        'https://example.org/case-source')),
  2,
  'the exact submitted wallet and source references survive publication unchanged');

-- A second private Case proves the promotion is bound to the transition and is
-- not a blanket rule over the evidence table.
create temporary table private_case on commit drop as
select * from public.osi_v2_issue_case_nonce(
  repeat('q',32),'CASE_SUBMITTED','11111111111111111111111111111116','owner',null,
  repeat('c',64),'case-visibility-private-submit',repeat('5',64));
select lives_ok(
  $test$select * from public.osi_v2_commit_case_submission(
    repeat('q',32),repeat('c',64),'Still private Case','other',
    'A neutral public-safe summary for a Case that is still in private review.',
    '',null,(select body from intake_manifest),repeat('Y',88),
    'OSI2 test CASE_SUBMITTED memo two',statement_timestamp())$test$,
  'a second Case is submitted and remains in private initial review');
select ok(
  (select bool_and(evidence.is_public=false and evidence.moderation_state='pending')
     from public.case_evidence_links as link
     join public.evidence_items as evidence on evidence.id=link.evidence_item_id
    where link.case_id=(select target_id::uuid from private_case)),
  'evidence on a still-private Case is not promoted by another Case opening');

-- ---------------------------------------------------------------------------
-- Report publication promotes its exact reviewed manifest.
-- ---------------------------------------------------------------------------
update public.osi_config set value='true'
 where key in ('OSI_V2_REPORT_WRITES_ENABLED','OSI_V2_REPORT_REVIEW_WRITES_ENABLED');
update public.osi_config set value='0'
 where key in ('OSI_V2_REPORT_COOLDOWN_SECONDS','OSI_V2_REPORT_REVIEW_COOLDOWN_SECONDS');

-- Report publication needs the full standard quorum. These two analysts carry
-- weight 1.00 each, so this fixture clears the weight gate under either the
-- 2.00 design default or the D21 calibrated 1.00. What it always proves is the
-- half that never moves: one analyst can never publish alone.
insert into public.analyst_profiles(wallet,status,tier_code,verified,approved,weight_cached)
values
  ('22222222222222222222222222222233','probationary_analyst','probationary',true,true,1.00),
  ('22222222222222222222222222222234','probationary_analyst','probationary',true,true,1.00);

create temporary table report_manifest on commit drop as
select jsonb_build_array(
  jsonb_build_object('kind','wallet','ref','11111111111111111111111111111115',
    'sha256',encode(extensions.digest(pg_catalog.convert_to(
      '11111111111111111111111111111115','UTF8'),'sha256'),'hex')),
  jsonb_build_object('kind','url','ref','https://example.org/report-source',
    'sha256',encode(extensions.digest(pg_catalog.convert_to(
      'https://example.org/report-source','UTF8'),'sha256'),'hex'))
) as body;

create temporary table report_prepared on commit drop as
select * from public.osi_v2_prepare_report_version(
  repeat('m',32),'11111111111111111111111111111114',
  (select target_id::uuid from visibility_case),
  'This restricted narrative describes the exact transaction order, the wallet relationships, the evidentiary limits and the remaining uncertainty for independent analyst review.',
  'A public-safe finding summary that must remain readable with its manifest after publication.',
  null,(select body from report_manifest),
  'report-visibility-fixture-0001',repeat('4',64));
select lives_ok(
  $test$select * from public.osi_v2_commit_report_version(
    repeat('m',32),
    'This restricted narrative describes the exact transaction order, the wallet relationships, the evidentiary limits and the remaining uncertainty for independent analyst review.',
    'A public-safe finding summary that must remain readable with its manifest after publication.',
    null,(select body from report_manifest),repeat('M',88),
    'OSI2 test CASE_REPORT_VERSION_SUBMITTED',statement_timestamp())$test$,
  'a Report version is submitted with its own structured manifest');
select ok(
  (select bool_and(evidence.is_public=false and evidence.moderation_state='pending')
     from public.case_report_version_evidence as link
     join public.evidence_items as evidence on evidence.id=link.evidence_item_id
    where link.report_version_id=(select version_id from report_prepared)),
  'Report evidence starts private and pending while the version is unpublished');

select lives_ok(
  $test$select * from public.osi_v2_prepare_report_review(
    repeat('n',32),'22222222222222222222222222222233',
    (select version_id from report_prepared),'approve','evidence_reviewed',
    'The exact Report version and its evidence manifest were reviewed against public sources.',
    null,'report-visibility-review-0001',repeat('3',64))$test$,
  'an independent eligible analyst prepares an approving Report review');
select lives_ok(
  $test$select * from public.osi_v2_commit_report_review(
    repeat('n',32),'approve','evidence_reviewed',
    'The exact Report version and its evidence manifest were reviewed against public sources.',
    null,repeat('N',88),'OSI2 test CASE_REPORT_REVIEW_CAST')$test$,
  'the approving Report review is recorded');
select throws_ok(
  $test$select * from public.osi_v2_prepare_report_publication(
    repeat('r',32),'22222222222222222222222222222233',
    (select version_id from report_prepared),
    'report-visibility-publish-early',repeat('1',64))$test$,
  '42501','Report publication quorum is not ready',
  'one approving analyst cannot publish a standard-risk Report alone');
select lives_ok(
  $test$select * from public.osi_v2_prepare_report_review(
    repeat('o',32),'22222222222222222222222222222234',
    (select version_id from report_prepared),'approve','evidence_reviewed',
    'The second independent analyst reviewed the same exact version and manifest.',
    null,'report-visibility-review-0002',repeat('0',64))$test$,
  'a second independent analyst prepares an approving Report review');
select lives_ok(
  $test$select * from public.osi_v2_commit_report_review(
    repeat('o',32),'approve','evidence_reviewed',
    'The second independent analyst reviewed the same exact version and manifest.',
    null,repeat('O',88),'OSI2 test CASE_REPORT_REVIEW_CAST two')$test$,
  'the second approving Report review completes the standard quorum');
select lives_ok(
  $test$select * from public.osi_v2_prepare_report_publication(
    repeat('r',32),'22222222222222222222222222222233',
    (select version_id from report_prepared),
    'report-visibility-publish-0001',repeat('2',64))$test$,
  'an approving analyst prepares the exact quorum-bound publication');
select lives_ok(
  $test$select * from public.osi_v2_commit_report_publication(
    repeat('r',32),repeat('R',88),'OSI2 test REPORT_PUBLISHED exact version',
    statement_timestamp())$test$,
  'the confirmed REPORT_PUBLISHED Memo publishes the exact version');
select ok(
  (select bool_and(evidence.is_public and evidence.moderation_state='approved')
     from public.case_report_version_evidence as link
     join public.evidence_items as evidence on evidence.id=link.evidence_item_id
    where link.report_version_id=(select version_id from report_prepared)),
  'REPORT_PUBLISHED promotes the exact reviewed Report manifest to public-safe');
select is(
  (select content_public_safe from public.case_report_versions
    where id=(select version_id from report_prepared)),
  'A public-safe finding summary that must remain readable with its manifest after publication.',
  'the published public-safe summary is the exact submitted text, unchanged');
select ok(
  (select body_private like 'This restricted narrative describes%'
     from public.case_report_versions
    where id=(select version_id from report_prepared)),
  'the restricted narrative is retained privately and is never rewritten by publication');

-- ---------------------------------------------------------------------------
-- D21 cold-start weight-gate calibration.
--
-- The standard weight gate moved 2.00 -> 1.00 so two analysts at the 0.50
-- probationary floor can publish. The whole safety of that change rests on the
-- count gate being untouched and unreachable from configuration, so that is
-- what these assertions prove: weight can be tuned, the P3 floor cannot.
-- ---------------------------------------------------------------------------
select is(
  (select value from public.osi_config where key='OSI_V2_REPORT_STANDARD_MIN_WEIGHT'),
  '1.00', 'the standard Report weight gate runs at the D21 calibrated 1.00');
select is(
  (select value from public.osi_config where key='OSI_V2_WIRE_STANDARD_MIN_WEIGHT'),
  '1.00', 'the standard Wire weight gate runs at the D21 calibrated 1.00');
select is(
  (select value from public.osi_config where key='OSI_V2_REPORT_STANDARD_MIN_ANALYSTS'),
  '2', 'the standard Report count gate stays at the P3 floor of two analysts');

-- The gate the quorum function actually applies, not just the stored string.
select is(
  (select required_weight from osi_private.osi_v2_report_quorum(
     (select version_id from report_prepared))),
  1.00::numeric, 'the quorum function applies the calibrated 1.00 weight gate');
select is(
  (select required_count from osi_private.osi_v2_report_quorum(
     (select version_id from report_prepared))),
  2, 'the quorum function still demands two independent analysts');

-- A single analyst can never become sufficient by configuration. Lowering the
-- count gate below two is refused outright rather than quietly accepted, so no
-- operator can turn the weight calibration into a solo-publication path.
update public.osi_config set value='1' where key='OSI_V2_REPORT_STANDARD_MIN_ANALYSTS';
select throws_ok(
  $test$select * from osi_private.osi_v2_report_quorum(
    (select version_id from report_prepared))$test$,
  '55000', 'Report quorum configuration is absent or invalid',
  'a count gate below two independent analysts is refused, not honoured');
update public.osi_config set value='2' where key='OSI_V2_REPORT_STANDARD_MIN_ANALYSTS';

-- 1.00 is the floor of the accepted weight range, so the calibration cannot be
-- pushed further down without the same fail-closed refusal.
update public.osi_config set value='0.50' where key='OSI_V2_REPORT_STANDARD_MIN_WEIGHT';
select throws_ok(
  $test$select * from osi_private.osi_v2_report_quorum(
    (select version_id from report_prepared))$test$,
  '55000', 'Report quorum configuration is absent or invalid',
  'a weight gate below 1.00 is refused, so 1.00 is a real floor');
update public.osi_config set value='1.00' where key='OSI_V2_REPORT_STANDARD_MIN_WEIGHT';

select * from finish();
rollback;
