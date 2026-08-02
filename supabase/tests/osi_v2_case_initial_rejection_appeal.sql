-- Complete normal Case rejection and owner appeal lifecycle.
begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

select isnt(has_function_privilege('anon',
  'public.osi_v2_prepare_case_rejection(text,text,uuid,text,text)','EXECUTE'),true,
  'anonymous clients cannot prepare a Case rejection');
select isnt(has_function_privilege('authenticated',
  'public.osi_v2_commit_case_appeal(text,text,text,jsonb)','EXECUTE'),true,
  'authenticated clients cannot bypass the owner appeal gateway');
select ok(has_function_privilege('service_role',
  'public.osi_v2_commit_case_rejection(text,text,text,timestamptz)','EXECUTE'),
  'service role can commit the exact rejection outcome');
select ok(has_function_privilege('service_role',
  'public.osi_v2_commit_case_appeal(text,text,text,jsonb)','EXECUTE'),
  'service role can commit the exact owner appeal');
select is(public.osi_v2_expected_proof_type('CASE_INITIAL_REVIEW_REJECTED'),'solana_memo',
  'normal Case rejection is class A');
select is(public.osi_v2_expected_proof_type('CASE_APPEAL_SUBMITTED'),
  'wallet_signed_server_verified','owner appeal is class B');

select throws_ok(
  $test$select osi_private.osi_v2_validate_case_appeal(null,null)$test$,
  '23514','Appeal reason is invalid',
  'null appeal input fails closed at the database boundary');
select throws_ok(
  $test$select osi_private.osi_v2_validate_case_appeal(
    'new_evidence',jsonb_build_array(jsonb_build_object(
      'kind','onchain_tx','ref','not-a-solana-signature','sha256',repeat('a',64))))$test$,
  '23514','Appeal transaction evidence is invalid',
  'malformed Solana transaction evidence fails closed at the database boundary');

update public.osi_config set value='false'
 where key='OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED';

insert into public.analyst_profiles(wallet,status,tier_code,verified,approved,weight_cached)
values
 ('22222222222222222222222222222222','verified_analyst','verified',true,true,1.00),
 ('33333333333333333333333333333333','verified_analyst','verified',true,true,1.00);

create temporary table case_fixture on commit drop as
select * from public.osi_v2_issue_case_nonce(
  repeat('s',32),'CASE_SUBMITTED','11111111111111111111111111111112','owner',null,
  repeat('a',64),'case-rejection-fixture-submit',repeat('1',64));
select lives_ok(
  $test$select * from public.osi_v2_commit_case_submission(
    repeat('s',32),repeat('a',64),'Appealable neutral Case','other',
    'A neutral Case used to prove rejection and appeal lifecycle behavior.',
    'Private original intake remains immutable.',null,'[]'::jsonb,repeat('T',88),
    'OSI2 test CASE_SUBMITTED memo',statement_timestamp())$test$,
  'private Case fixture is submitted');

select lives_ok(
  $test$select * from public.osi_v2_issue_case_nonce(
    repeat('r',31)||'1','CASE_INITIAL_REVIEW_CAST',
    '22222222222222222222222222222222','analyst',
    (select target_id from case_fixture),repeat('b',64),
    'case-rejection-review-one',repeat('2',64))$test$,
  'first analyst receives a reject review nonce');
select lives_ok(
  $test$select * from public.osi_v2_commit_case_review_current(
    repeat('r',31)||'1',repeat('b',64),repeat('R',88),'analyst','reject',
    'duplicate_or_out_of_scope')$test$,
  'first exact reject review is recorded');
select is((select reject_ready from public.osi_v2_case_rejection_quorum(
  (select target_id::uuid from case_fixture))),false,
  'one analyst cannot reject a Case');

select lives_ok(
  $test$select * from public.osi_v2_issue_case_nonce(
    repeat('r',31)||'2','CASE_INITIAL_REVIEW_CAST',
    '33333333333333333333333333333333','analyst',
    (select target_id from case_fixture),repeat('c',64),
    'case-rejection-review-two',repeat('3',64))$test$,
  'second analyst receives an independent reject review nonce');
select lives_ok(
  $test$select * from public.osi_v2_commit_case_review_current(
    repeat('r',31)||'2',repeat('c',64),repeat('S',88),'analyst','reject',
    'duplicate_or_out_of_scope')$test$,
  'second exact reject review is recorded');
select ok((select reject_ready and reject_count=2 and reject_weight=2.00
  and not approve_ready from public.osi_v2_case_rejection_quorum(
    (select target_id::uuid from case_fixture))),
  'two independent analysts and weight 2.00 make rejection exclusively ready');

create temporary table rejection_prepare on commit drop as
select * from public.osi_v2_prepare_case_rejection(
  repeat('j',32),'33333333333333333333333333333333',
  (select target_id::uuid from case_fixture),'case-rejection-outcome-0001',repeat('4',64));
select lives_ok(
  $test$select * from public.osi_v2_commit_case_rejection(
    repeat('j',32),repeat('Z',88),'OSI2 test CASE_INITIAL_REVIEW_REJECTED memo',
    statement_timestamp())$test$,
  'counted rejecting analyst anchors the exact rejection');
select is((select stage||':'||visibility from public.cases
  where id=(select target_id::uuid from case_fixture)),'initial_rejected:private',
  'normal rejection stays private and enters the exact terminal state');

select throws_ok(
  $test$select * from public.osi_v2_prepare_case_appeal(
    repeat('x',32),'22222222222222222222222222222222',
    (select target_id::uuid from case_fixture),'new_evidence',jsonb_build_array(
      jsonb_build_object('kind','url','ref','https://example.com/new-proof',
        'sha256',encode(extensions.digest(pg_catalog.convert_to(
          'https://example.com/new-proof','UTF8'),'sha256'),'hex'))),
    'case-appeal-wrong-owner',repeat('5',64))$test$,
  '42501','Only the owner can appeal this rejected Case',
  'a non-owner cannot appeal');

create temporary table appeal_evidence on commit drop as
select jsonb_build_array(jsonb_build_object(
  'kind','url','ref','https://example.com/new-proof',
  'sha256',encode(extensions.digest(pg_catalog.convert_to(
    'https://example.com/new-proof','UTF8'),'sha256'),'hex'))) as body;
select lives_ok(
  $test$select * from public.osi_v2_prepare_case_appeal(
    repeat('p',32),'11111111111111111111111111111112',
    (select target_id::uuid from case_fixture),'new_evidence',
    (select body from appeal_evidence),'case-appeal-owner-0001',repeat('6',64))$test$,
  'owner prepares an exact new-evidence appeal');
select lives_ok(
  $test$select * from public.osi_v2_commit_case_appeal(
    repeat('p',32),repeat('Q',88),'new_evidence',(select body from appeal_evidence))$test$,
  'owner wallet signature commits the appeal atomically');
select is((select stage||':'||visibility from public.cases
  where id=(select target_id::uuid from case_fixture)),'initial_review:private',
  'appeal starts a fresh private initial-review cycle');
select is((select reject_count from public.osi_v2_case_rejection_quorum(
  (select target_id::uuid from case_fixture))),0,
  'pre-appeal reject votes remain history but cannot decide the new cycle');
select ok((select count(*)=1 from public.case_evidence_links as link
  join public.evidence_items as evidence on evidence.id=link.evidence_item_id
  where link.case_id=(select target_id::uuid from case_fixture)
    and evidence.ref='https://example.com/new-proof'
    and evidence.is_public=false and evidence.moderation_state='pending'),
  'appeal appends exactly one private pending evidence item');

select * from finish();
rollback;
