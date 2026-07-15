-- Exact primary Report selection, challenge lifecycle and process seal.
-- Every fixture and config change rolls back with this pgTAP transaction.

begin;
create extension if not exists pgtap with schema extensions;
select plan(75);

create function pg_temp.add_published_report(
  p_case_id uuid, p_report_id uuid, p_version_id uuid,
  p_report_ref text, p_version_ref text, p_author text
) returns void language plpgsql as $$
declare submitted_receipt uuid := gen_random_uuid(); published_receipt uuid := gen_random_uuid();
begin
  insert into public.event_receipts (
    id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,
    actor_role,decision,proof_type,payload_hash,server_verified,occurred_at
  ) values
    (submitted_receipt,'legacy','LEGACY_REPORT_IMPORTED','report_version',p_version_id::text,
      p_version_ref,p_author,'wallet','submit','legacy_imported',repeat('a',64),false,statement_timestamp()),
    (published_receipt,'legacy','LEGACY_REPORT_PUBLISHED','report_version',p_version_id::text,
      p_version_ref,p_author,'wallet','publish','legacy_imported',repeat('b',64),false,statement_timestamp());
  insert into public.case_reports (
    id,case_id,author_wallet,status,public_ref,native_intake
  ) values (p_report_id,p_case_id,p_author,'active',p_report_ref,false);
  insert into public.case_report_versions (
    id,report_id,version_no,version_ref,created_by_wallet,body_private,
    content_public_safe,evidence_snapshot_hash,lifecycle_state,published_at,
    publication_receipt_id,event_receipt_id
  ) values (
    p_version_id,p_report_id,1,p_version_ref,p_author,
    'Immutable restricted fixture body for exact resolution governance.',
    'Public-safe fixture summary for independent process review.',repeat('c',64),
    'published',statement_timestamp(),published_receipt,submitted_receipt
  );
  update public.case_reports set current_version_id=p_version_id,
    current_published_version_id=p_version_id where id=p_report_id;
end $$;

create function pg_temp.add_unpublished_report(
  p_case_id uuid, p_report_id uuid, p_version_id uuid,
  p_report_ref text, p_version_ref text, p_author text
) returns void language plpgsql as $$
declare submitted_receipt uuid := gen_random_uuid();
begin
  insert into public.event_receipts (
    id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,
    actor_role,decision,proof_type,payload_hash,server_verified,occurred_at
  ) values (submitted_receipt,'legacy','LEGACY_REPORT_IMPORTED','report_version',p_version_id::text,
    p_version_ref,p_author,'wallet','submit','legacy_imported',repeat('d',64),false,statement_timestamp());
  insert into public.case_reports (id,case_id,author_wallet,status,public_ref,native_intake)
    values (p_report_id,p_case_id,p_author,'active',p_report_ref,false);
  insert into public.case_report_versions (
    id,report_id,version_no,version_ref,created_by_wallet,body_private,
    evidence_snapshot_hash,lifecycle_state,event_receipt_id
  ) values (p_version_id,p_report_id,1,p_version_ref,p_author,
    'Unpublished immutable fixture body.',repeat('e',64),'in_review',submitted_receipt);
  update public.case_reports set current_version_id=p_version_id where id=p_report_id;
end $$;

create function pg_temp.commit_signed_governance(
  p_action text,p_wallet text,p_target_ref text,p_payload jsonb,p_idem text,
  p_auth text default null
) returns text language plpgsql as $$
declare prepared record; committed record; nonce_value text;
begin
  nonce_value := substr(encode(extensions.digest(convert_to('nonce:'||p_idem,'UTF8'),'sha256'),'hex'),1,43);
  select * into prepared from public.osi_v2_prepare_governance_action(
    nonce_value,p_action,p_wallet,p_target_ref,p_payload,p_idem,
    encode(extensions.digest(convert_to('fingerprint:'||p_idem,'UTF8'),'sha256'),'hex'),p_auth
  );
  select * into committed from public.osi_v2_commit_governance_action(
    prepared.issued_nonce,p_payload,prepared.proof_text,repeat('S',88),null,null,p_auth
  );
  return committed.target_public_ref;
end $$;

create function pg_temp.commit_memo_governance(
  p_action text,p_wallet text,p_target_ref text,p_payload jsonb,p_idem text,
  p_auth text,p_tx_character text
) returns text language plpgsql as $$
declare prepared record; committed record; nonce_value text;
begin
  nonce_value := substr(encode(extensions.digest(convert_to('nonce:'||p_idem,'UTF8'),'sha256'),'hex'),1,43);
  select * into prepared from public.osi_v2_prepare_governance_action(
    nonce_value,p_action,p_wallet,p_target_ref,p_payload,p_idem,
    encode(extensions.digest(convert_to('fingerprint:'||p_idem,'UTF8'),'sha256'),'hex'),p_auth
  );
  select * into committed from public.osi_v2_commit_governance_action(
    prepared.issued_nonce,p_payload,prepared.proof_text,null,repeat(p_tx_character,88),
    statement_timestamp(),p_auth
  );
  return committed.target_public_ref;
end $$;

select is((select value from public.osi_config where key='OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED'),
  'false','resolution challenge and seal mutations start fail-closed');
select isnt(has_function_privilege('authenticated',
  'public.osi_v2_prepare_governance_action(text,text,text,text,jsonb,text,text,text)','EXECUTE'),true,
  'authenticated browser cannot call governance prepare RPC');
select isnt(has_function_privilege('anon',
  'public.osi_v2_commit_governance_action(text,jsonb,text,text,text,timestamptz,text)','EXECUTE'),true,
  'anonymous browser cannot call governance commit RPC');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.case_resolutions'::regclass),
  'resolution table remains FORCE RLS default-deny');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.challenges_v2'::regclass),
  'challenge table remains FORCE RLS default-deny');

update public.osi_config set value='true'
 where key='OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED';
insert into public.osi_config (key, value) values
  ('admin_wallet', '44444444444444444444444444444444')
on conflict (key) do update set value=excluded.value;

insert into public.analyst_profiles (wallet,status,tier_code,verified,approved,weight_cached) values
 ('22222222222222222222222222222222','probationary_analyst','probationary',true,true,1.50),
 ('22222222222222222222222222222223','probationary_analyst','probationary',true,true,1.00),
 ('22222222222222222222222222222224','probationary_analyst','probationary',true,true,2.00),
 ('22222222222222222222222222222225','probationary_analyst','probationary',true,true,0.50),
 ('11111111111111111111111111111113','probationary_analyst','probationary',true,true,1.00),
 ('11111111111111111111111111111114','probationary_analyst','probationary',true,true,1.00),
 ('33333333333333333333333333333333','probationary_analyst','probationary',true,true,0.50);

insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '30000000-0000-4000-8000-000000000001','OSI-AAAACCCC0001','Standard resolution fixture','other',
 'Public summary for the standard resolution fixture.','Restricted standard fixture.',
 '11111111111111111111111111111113','open_public','public','standard','[]'::jsonb
);
select pg_temp.add_published_report(
 '30000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',
 '32000000-0000-4000-8000-000000000001','OSI-RPT-AAAACCCC0001','OSI-RV-AAAACCCC00010001',
 '11111111111111111111111111111114');
select pg_temp.add_published_report(
 '30000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000002',
 '32000000-0000-4000-8000-000000000002','OSI-RPT-AAAACCCC0002','OSI-RV-AAAACCCC00010002',
 '11111111111111111111111111111115');
select pg_temp.add_unpublished_report(
 '30000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000003',
 '32000000-0000-4000-8000-000000000003','OSI-RPT-AAAACCCC0003','OSI-RV-AAAACCCC00010003',
 '11111111111111111111111111111116');

select throws_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222222',
  'OSI-AAAACCCC0001',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00010003',
  'decision','select','reason_code','unpublished_target','public_rationale','This unpublished version must never be selectable.','private_note',null),
  'gov-unpublished-version-0001')
$test$,'42501','Resolution selection requires an exact currently published Case Report version',
 'unpublished exact Report version is rejected');
select throws_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','11111111111111111111111111111113',
  'OSI-AAAACCCC0001',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00010001',
  'decision','select','reason_code','owner_conflict','public_rationale','The Case owner cannot cast a counted resolution review.','private_note',null),
  'gov-owner-conflict-0001')
$test$,'42501','Case owner and selected Report author cannot cast this counted review',
 'Case owner resolution review is rejected');
select throws_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','11111111111111111111111111111114',
  'OSI-AAAACCCC0001',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00010001',
  'decision','select','reason_code','author_conflict','public_rationale','The exact Report author cannot review their own version.','private_note',null),
  'gov-author-conflict-0001')
$test$,'42501','Case owner and selected Report author cannot cast this counted review',
 'exact Report author self-review is rejected');

select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222222',
  'OSI-AAAACCCC0001',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00010001',
  'decision','select','reason_code','primary_support','public_rationale','The exact published version has independent support.','private_note','restricted note one'),
  'gov-standard-review-one-0001')
$test$,'eligible analyst casts an exact-version selection review');
select ok((select stage='ready_for_finalization' from public.cases where public_ref='OSI-AAAACCCC0001'),
 'first resolution review creates parent then advances Case to ready_for_finalization');
select ok((select state='selection_open' and winning_report_version_id is null
 from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000001'),
 'resolution begins selection_open with no invented winner');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222222',
  'OSI-AAAACCCC0001',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00010001',
  'decision','abstain','reason_code','review_revision','public_rationale','The analyst revises the active decision while preserving history.','private_note',null),
  'gov-standard-review-revision-0001')
$test$,'review revision creates a new immutable history row');
select is((select count(*)::integer from public.resolution_reviews where reviewer_wallet='22222222222222222222222222222222'),
 2,'both original and revised resolution reviews remain');
select ok((select count(*)=1 and bool_and(decision='abstain') from public.resolution_reviews
 where reviewer_wallet='22222222222222222222222222222222' and is_active),
 'only the latest revised resolution review is active and counted');

select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222223',
  'OSI-AAAACCCC0001',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00010001',
  'decision','select','reason_code','primary_support','public_rationale','First active analyst supports the exact candidate.','private_note',null),
  'gov-standard-review-two-0001')
$test$,'first active supporting analyst commits');
select ok((select leader_count=0 and leader_weight=0 and required_count=2 and required_weight=2.50
 from osi_private.osi_v2_resolution_quorum((select id from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000001'))),
 'standard count and weight gates both remain unmet after one analyst');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222224',
  'OSI-AAAACCCC0001',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00010001',
  'decision','select','reason_code','primary_support','public_rationale','Second active analyst establishes count and weight quorum.','private_note',null),
  'gov-standard-review-three-0001')
$test$,'second active supporting analyst commits');
select ok((select leader_version_ref='OSI-RV-AAAACCCC00010001' and leader_count=2
 and leader_weight=3.00 and tie_unresolved=false
 from osi_private.osi_v2_resolution_quorum((select id from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000001'))),
 'standard quorum derives one deterministic exact leader');

select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('w',43),'resolution_finalize',
  '44444444444444444444444444444444',(select public_ref from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000001'),
  '{}'::jsonb,'gov-wallet-only-finalize-0001',repeat('f',64),null)
$test$,'42501','Resolution finalization requires both maintainer gates','wallet-only maintainer cannot finalize');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('x',43),'resolution_finalize',
  '55555555555555555555555555555555',(select public_ref from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000001'),
  '{}'::jsonb,'gov-auth-only-finalize-0001',repeat('f',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Resolution finalization requires both maintainer gates','auth-only maintainer cannot finalize');

create temporary table resolution_final_prepare on commit drop as
select * from public.osi_v2_prepare_governance_action(
 repeat('y',43),'resolution_finalize','44444444444444444444444444444444',
 (select public_ref from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000001'),
 '{}'::jsonb,'gov-resolution-finalize-0001',repeat('1',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
select throws_ok($test$
 select * from public.osi_v2_commit_governance_action(repeat('y',43),'{}'::jsonb,
  (select proof_text from pg_temp.resolution_final_prepare)||'changed',null,repeat('A',88),statement_timestamp(),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'23514','Governance payload, proof text or maintainer binding changed after prepare',
 'wrong final Memo text is rejected');
select lives_ok($test$
 select * from public.osi_v2_commit_governance_action(repeat('y',43),'{}'::jsonb,
  (select proof_text from pg_temp.resolution_final_prepare),null,repeat('A',88),statement_timestamp(),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'full maintainer finalizes only the unique server-derived leader');
select ok((select winning_report_version_id='32000000-0000-4000-8000-000000000001'
 and state='in_challenge_window' and challenge_window_ends_at-challenge_window_opens_at=interval '7 days'
 from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000001'),
 'final resolution is permanently bound to exact version with seven-day window');
select ok((select receipt.event_type='REPORT_SELECTED_WINNING' and receipt.target_type='resolution'
 and receipt.actor_wallet='44444444444444444444444444444444' and receipt.actor_role='maintainer'
 and receipt.proof_type='solana_memo' and receipt.server_verified and receipt.tx_sig=repeat('A',88)
 from public.case_resolutions resolution join public.event_receipts receipt on receipt.id=resolution.final_receipt_id
 where resolution.case_id='30000000-0000-4000-8000-000000000001'),
 'REPORT_SELECTED_WINNING receipt has exact maintainer actor target and Memo proof class');
select is((select stage from public.cases where public_ref='OSI-AAAACCCC0001'),'in_challenge_window',
 'primary Report selection does not auto-seal the Case');
select is((select count(*)::integer from public.reward_payments),0,
 'resolution selection never invents a paid state');
select ok((select idempotent_replay from public.osi_v2_commit_governance_action(
 repeat('y',43),'{}'::jsonb,(select proof_text from pg_temp.resolution_final_prepare),null,repeat('A',88),
 (select occurred_at from public.event_receipts where tx_sig=repeat('A',88)),
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
 'exact finalization retry returns the original receipt idempotently');
select throws_ok($test$
 select * from public.osi_v2_commit_governance_action(repeat('y',43),'{"changed":true}'::jsonb,
  (select proof_text from pg_temp.resolution_final_prepare),null,repeat('A',88),statement_timestamp(),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'23514','Governance payload, proof text or maintainer binding changed after prepare',
 'changed replay payload is rejected');

insert into public.evidence_items (id,kind,ref,is_public,moderation_state,sha256,added_by_wallet)
 values ('33000000-0000-4000-8000-000000000001','wallet','66666666666666666666666666666666',
 true,'approved',repeat('6',64),'33333333333333333333333333333333');
insert into public.case_evidence_links (case_id,evidence_item_id,added_by_wallet)
 values ('30000000-0000-4000-8000-000000000001','33000000-0000-4000-8000-000000000001',
 '33333333333333333333333333333333');
select lives_ok($test$
 select pg_temp.commit_signed_governance('challenge_submit','33333333333333333333333333333333',
  (select public_ref from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000001'),
  jsonb_build_object('reason_code','material_evidence_challenge','public_safe_summary',
  'New linked evidence materially challenges the selected exact version.',
  'restricted_detail','Restricted evidence context.','evidence_item_id','33000000-0000-4000-8000-000000000001'),
  'gov-challenge-submit-0001')
$test$,'any connected wallet can submit one evidence-bound challenge');
select ok((select state='submitted' and target_kind='resolution' and resolution_id is not null
 and num_nonnulls(case_id,case_report_version_id,wire_report_version_id,ai_pack_version_id,resolution_id)=1
 from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'),
 'challenge has exactly one typed resolution target');
select ok(not exists(select 1 from public.challenges_v2 where state in ('open','under_review')
 and challenger_wallet='33333333333333333333333333333333'),
 'submitted challenge is non-blocking');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('z',43),'challenge_submit',
  '33333333333333333333333333333333',(select public_ref from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000001'),
  jsonb_build_object('reason_code','duplicate','public_safe_summary','A duplicate active challenge must be rejected safely.',
  'restricted_detail',null,'evidence_item_id','33000000-0000-4000-8000-000000000001'),
  'gov-challenge-duplicate-0001',repeat('2',64),null)
$test$,'23505','An active challenge already exists for this wallet and resolution',
 'duplicate active wallet and exact target challenge is rejected');

select throws_ok($test$
 select pg_temp.commit_signed_governance('challenge_admit','33333333333333333333333333333333',
  (select public_ref from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'),
  '{"decision":"accept","route":"analyst"}'::jsonb,'gov-challenge-self-admit-0001')
$test$,'42501','Challenge submitter, Case owner and selected Report author are conflicted',
 'challenger cannot admit their own challenge');
select throws_ok($test$
 select pg_temp.commit_signed_governance('challenge_admit','11111111111111111111111111111114',
  (select public_ref from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'),
  '{"decision":"accept","route":"analyst"}'::jsonb,'gov-challenge-author-admit-0001')
$test$,'42501','Challenge submitter, Case owner and selected Report author are conflicted',
 'selected Report author cannot admit the challenge');
select throws_ok($test$
 select pg_temp.commit_signed_governance('challenge_admit','44444444444444444444444444444444',
  (select public_ref from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'),
  '{"decision":"accept","route":"maintainer"}'::jsonb,'gov-challenge-wallet-only-admit-0001')
$test$,'42501','Maintainer admissibility requires both maintainer gates',
 'wallet-only maintainer cannot admit a challenge');
select lives_ok($test$
 select pg_temp.commit_signed_governance('challenge_admit','44444444444444444444444444444444',
  (select public_ref from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'),
  '{"decision":"accept","route":"maintainer"}'::jsonb,'gov-challenge-full-admit-0001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'full double-gated maintainer admits without analyst weight');
select ok((select state='open' and opened_receipt_id is not null and review_deadline_at>statement_timestamp()
 from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'),
 'admitted challenge becomes blocking with a server deadline');

select lives_ok($test$
 select pg_temp.commit_signed_governance('challenge_review','22222222222222222222222222222223',
  (select public_ref from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'),
  jsonb_build_object('decision','accept','reason_code','material_issue_confirmed','public_rationale',
  'The new evidence materially affects the selected exact version.','private_note','restricted merit note'),
  'gov-challenge-review-one-0001')
$test$,'first independent analyst reviews challenge merits');
select ok((select outcome is null and outcome_count=0 and required_count=2 and required_weight=2.50
 from osi_private.osi_v2_challenge_quorum((select id from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'))),
 'one analyst cannot decide a challenge even when review is active');
select lives_ok($test$
 select pg_temp.commit_signed_governance('challenge_review','22222222222222222222222222222224',
  (select public_ref from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'),
  jsonb_build_object('decision','accept','reason_code','material_issue_confirmed','public_rationale',
  'A second independent review confirms the material process issue.','private_note',null),
  'gov-challenge-review-two-0001')
$test$,'second independent analyst reaches count and weight merit quorum');
select ok((select outcome='accept' and outcome_count=2 and outcome_weight=3.00 and tie_unresolved=false
 from osi_private.osi_v2_challenge_quorum((select id from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'))),
 'challenge outcome requires two analysts and weight 2.50');
select lives_ok($test$
 select pg_temp.commit_memo_governance('challenge_finalize','22222222222222222222222222222223',
  (select public_ref from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'),
  '{}'::jsonb,'gov-challenge-finalize-0001',null,'B')
$test$,'quorum-side analyst anchors the accepted challenge outcome');
select ok((select challenge.state='accepted' and challenge.terminal_at is not null
 and receipt.event_type='CHALLENGE_ACCEPTED' and receipt.proof_type='solana_memo'
 from public.challenges_v2 challenge join public.event_receipts receipt on receipt.id=challenge.resolved_receipt_id
 where challenge.challenger_wallet='33333333333333333333333333333333'),
 'accepted challenge has immutable terminal state and class-A receipt');
select ok((select resolution.state='reopened' and resolution.winning_report_version_id='32000000-0000-4000-8000-000000000001'
 from public.case_resolutions resolution where resolution.case_id='30000000-0000-4000-8000-000000000001'),
 'accepted challenge reopens safely while preserving historical exact winner');
select is((select stage from public.cases where public_ref='OSI-AAAACCCC0001'),'reopened',
 'accepted resolution challenge reopens the Case for a new quorum cycle');
select is((select bad_faith_state from public.challenges_v2 where challenger_wallet='33333333333333333333333333333333'),
 'none','accepted challenge creates no automatic penalty or bad-faith finding');

-- High-risk count and weight gates plus withdrawal/cooldown/inadmissibility.
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,submitted_by_wallet,
 stage,visibility,risk_tier,subject_refs
) values ('30000000-0000-4000-8000-000000000003','OSI-AAAACCCC0003','High risk fixture','other',
 'Public summary for high-risk quorum.','Restricted high-risk fixture.',
 '11111111111111111111111111111118','open_public','public','high','[]'::jsonb);
select pg_temp.add_published_report(
 '30000000-0000-4000-8000-000000000003','31000000-0000-4000-8000-000000000005',
 '32000000-0000-4000-8000-000000000005','OSI-RPT-AAAACCCC0005','OSI-RV-AAAACCCC00030001',
 '11111111111111111111111111111116');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222222',
  'OSI-AAAACCCC0003',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00030001',
  'decision','select','reason_code','high_risk_review','public_rationale','First high-risk analyst review supports the exact candidate.','private_note',null),
  'gov-high-review-one-0001');
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222223',
  'OSI-AAAACCCC0003',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00030001',
  'decision','select','reason_code','high_risk_review','public_rationale','Second high-risk analyst review supports the exact candidate.','private_note',null),
  'gov-high-review-two-0001')
$test$,'two analysts can review a high-risk candidate without deciding it');
select ok((select leader_version_id is null and required_count=3 and required_weight=4.50
 from osi_private.osi_v2_resolution_quorum((select id from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000003'))),
 'high-risk resolution remains unready until both 3-count and 4.50-weight gates pass');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222224',
  'OSI-AAAACCCC0003',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00030001',
  'decision','select','reason_code','high_risk_review','public_rationale','Third high-risk analyst completes count and weight quorum.','private_note',null),
  'gov-high-review-three-0001')
$test$,'third analyst completes high-risk quorum');
select ok((select leader_version_ref='OSI-RV-AAAACCCC00030001' and leader_count=3 and leader_weight=4.50
 from osi_private.osi_v2_resolution_quorum((select id from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000003'))),
 'high-risk exact leader appears only after both stronger gates pass');
select lives_ok($test$
 select pg_temp.commit_memo_governance('resolution_finalize','44444444444444444444444444444444',
  (select public_ref from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000003'),
  '{}'::jsonb,'gov-high-finalize-0001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','D')
$test$,'full maintainer finalizes the high-risk analyst leader');

insert into public.case_evidence_links (case_id,evidence_item_id,added_by_wallet)
 values ('30000000-0000-4000-8000-000000000003','33000000-0000-4000-8000-000000000001',
 '66666666666666666666666666666666');
select lives_ok($test$
 select pg_temp.commit_signed_governance('challenge_submit','66666666666666666666666666666666',
  (select public_ref from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000003'),
  jsonb_build_object('reason_code','withdraw_fixture','public_safe_summary','This evidence-backed challenge will be withdrawn by its submitter.',
  'restricted_detail',null,'evidence_item_id','33000000-0000-4000-8000-000000000001'),
  'gov-withdraw-submit-0001')
$test$,'challenge submitter opens a withdrawable non-terminal challenge');
select lives_ok($test$
 select pg_temp.commit_signed_governance('challenge_withdraw','66666666666666666666666666666666',
  (select public_ref from public.challenges_v2 where challenger_wallet='66666666666666666666666666666666'),
  '{}'::jsonb,'gov-withdraw-commit-0001')
$test$,'challenger withdraws their own non-terminal challenge');
select ok((select state='withdrawn' and terminal_at is not null and bad_faith_state='none'
 from public.challenges_v2 where challenger_wallet='66666666666666666666666666666666'),
 'withdrawal is terminal and creates no automatic penalty');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('m',43),'challenge_submit',
  '66666666666666666666666666666666',(select public_ref from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000003'),
  jsonb_build_object('reason_code','cooldown_retry','public_safe_summary','Immediate challenge resubmission must respect the server cooldown.',
  'restricted_detail',null,'evidence_item_id','33000000-0000-4000-8000-000000000001'),
  'gov-cooldown-retry-0001',repeat('4',64),null)
$test$,'P0001','Challenge cooldown is active','same wallet and exact target cooldown is enforced');
select lives_ok($test$
 select pg_temp.commit_signed_governance('challenge_submit','77777777777777777777777777777777',
  (select public_ref from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000003'),
  jsonb_build_object('reason_code','inadmissible_fixture','public_safe_summary','This separate challenge is submitted for admissibility review.',
  'restricted_detail',null,'evidence_item_id','33000000-0000-4000-8000-000000000001'),
  'gov-inadmissible-submit-0001')
$test$,'a second wallet may submit against the same resolution');
select lives_ok($test$
 select pg_temp.commit_signed_governance('challenge_admit','22222222222222222222222222222222',
  (select public_ref from public.challenges_v2 where challenger_wallet='77777777777777777777777777777777'),
  '{"decision":"reject","route":"analyst"}'::jsonb,'gov-inadmissible-reject-0001')
$test$,'eligible independent analyst rejects inadmissible challenge');
select ok((select challenge.state='rejected' and challenge.bad_faith_state='none'
 and resolution.state='in_challenge_window'
 from public.challenges_v2 challenge join public.case_resolutions resolution on resolution.id=challenge.resolution_id
 where challenge.challenger_wallet='77777777777777777777777777777777'),
 'admissibility rejection preserves resolution and applies no penalty');

-- Equal count and equal weight has no deterministic leader to finalize.
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,submitted_by_wallet,
 stage,visibility,risk_tier,subject_refs
) values ('30000000-0000-4000-8000-000000000004','OSI-AAAACCCC0004','Tie fixture','other',
 'Public summary for exact tie behavior.','Restricted tie fixture.',
 '11111111111111111111111111111118','open_public','public','standard','[]'::jsonb);
select pg_temp.add_published_report(
 '30000000-0000-4000-8000-000000000004','31000000-0000-4000-8000-000000000006',
 '32000000-0000-4000-8000-000000000006','OSI-RPT-AAAACCCC0006','OSI-RV-AAAACCCC00040001',
 '11111111111111111111111111111116');
select pg_temp.add_published_report(
 '30000000-0000-4000-8000-000000000004','31000000-0000-4000-8000-000000000007',
 '32000000-0000-4000-8000-000000000007','OSI-RPT-AAAACCCC0007','OSI-RV-AAAACCCC00040002',
 '11111111111111111111111111111117');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222222','OSI-AAAACCCC0004',
  jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00040001','decision','select','reason_code','tie_support','public_rationale','Analyst support contributes to exact candidate one.','private_note',null),'gov-tie-one-0001');
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222223','OSI-AAAACCCC0004',
  jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00040001','decision','select','reason_code','tie_support','public_rationale','Second support completes candidate one quorum.','private_note',null),'gov-tie-two-0001');
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222224','OSI-AAAACCCC0004',
  jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00040002','decision','select','reason_code','tie_support','public_rationale','Analyst support contributes to exact candidate two.','private_note',null),'gov-tie-three-0001');
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222225','OSI-AAAACCCC0004',
  jsonb_build_object('phase','selection','report_version_ref','OSI-RV-AAAACCCC00040002','decision','select','reason_code','tie_support','public_rationale','Second support completes candidate two quorum.','private_note',null),'gov-tie-four-0001')
$test$,'two exact candidates independently reach equal standard quorum');
select ok((select tie_unresolved and leader_version_id is null and ready_candidate_count=2
 from osi_private.osi_v2_resolution_quorum((select id from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000004'))),
 'equal count and weight remains an unresolved tie');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('t',43),'resolution_finalize',
  '44444444444444444444444444444444',(select public_ref from public.case_resolutions where case_id='30000000-0000-4000-8000-000000000004'),
  '{}'::jsonb,'gov-tie-finalize-0001',repeat('5',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Resolution has no unique server-derived quorum leader','maintainer cannot finalize an exact tie');

-- Past-window seal fixture. Replica mode is used only to arrange elapsed
-- server time; the actual seal reviews and finalization use production RPCs.
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,submitted_by_wallet,
 stage,visibility,risk_tier,subject_refs
) values ('30000000-0000-4000-8000-000000000002','OSI-AAAACCCC0002','Seal fixture','other',
 'Public summary for the seal fixture.','Restricted seal fixture.',
 '11111111111111111111111111111113','in_challenge_window','public','standard','[]'::jsonb);
select pg_temp.add_published_report(
 '30000000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000004',
 '32000000-0000-4000-8000-000000000004','OSI-RPT-AAAACCCC0004','OSI-RV-AAAACCCC00020001',
 '11111111111111111111111111111115');
insert into public.event_receipts (
 id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,
 decision,proof_type,payload_hash,server_verified,occurred_at
) values
 ('34000000-0000-4000-8000-000000000001','legacy','LEGACY_RESOLUTION_IMPORTED','resolution',
  '35000000-0000-4000-8000-000000000001','OSI-RES-AAAACCCC00020001',
  '44444444444444444444444444444444','maintainer','select','legacy_imported',repeat('7',64),false,statement_timestamp()),
 ('34000000-0000-4000-8000-000000000002','legacy','LEGACY_RESOLUTION_FINAL','resolution',
  '35000000-0000-4000-8000-000000000001','OSI-RES-AAAACCCC00020001',
  '44444444444444444444444444444444','maintainer','select','legacy_imported',repeat('8',64),false,statement_timestamp()),
 ('34000000-0000-4000-8000-000000000004','legacy','LEGACY_RESOLUTION_REVIEW','resolution',
  '35000000-0000-4000-8000-000000000001',null,
  '22222222222222222222222222222222','analyst','select','legacy_imported',repeat('b',64),false,statement_timestamp()),
 ('34000000-0000-4000-8000-000000000005','legacy','LEGACY_RESOLUTION_REVIEW','resolution',
  '35000000-0000-4000-8000-000000000001',null,
  '22222222222222222222222222222223','analyst','select','legacy_imported',repeat('c',64),false,statement_timestamp());
set local session_replication_role=replica;
insert into public.case_resolutions (
 id,case_id,winning_report_version_id,proposed_by_wallet,challenge_window_opens_at,
 challenge_window_ends_at,state,finalized_by,event_receipt_id,public_ref,
 selection_quorum_hash,final_receipt_id
) values ('35000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002',
 '32000000-0000-4000-8000-000000000004','44444444444444444444444444444444',
 statement_timestamp()-interval '8 days',statement_timestamp()-interval '1 day',
 'in_challenge_window','quorum_maintainer','34000000-0000-4000-8000-000000000001',
 'OSI-RES-AAAACCCC00020001',repeat('9',64),'34000000-0000-4000-8000-000000000002');
insert into public.resolution_reviews (
 id,resolution_id,candidate_report_version_id,reviewer_wallet,decision,weight,
 reason_code,is_active,event_receipt_id,phase,created_at,updated_at
) values
 ('37000000-0000-4000-8000-000000000001','35000000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000004','22222222222222222222222222222222',
  'select',1.50,'selection_fixture',true,'34000000-0000-4000-8000-000000000004',
  'selection',statement_timestamp()-interval '8 days',statement_timestamp()-interval '8 days'),
 ('37000000-0000-4000-8000-000000000002','35000000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000004','22222222222222222222222222222223',
  'select',1.00,'selection_fixture',true,'34000000-0000-4000-8000-000000000005',
  'selection',statement_timestamp()-interval '8 days',statement_timestamp()-interval '8 days');
set local session_replication_role=origin;

select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('u',43),'resolution_review',
  '22222222222222222222222222222222','OSI-AAAACCCC0002',
  jsonb_build_object('phase','seal','report_version_ref','OSI-RV-AAAACCCC00010001',
   'decision','select','reason_code','wrong_seal_target','public_rationale',
   'A seal review cannot substitute a different exact Report version.','private_note',null),
  'gov-seal-wrong-version-0001',repeat('4',64),null)
$test$,'42501','Seal review requires a clear ended challenge window',
 'seal review rejects a different exact Report version');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222222',
  'OSI-AAAACCCC0002',jsonb_build_object('phase','seal','report_version_ref','OSI-RV-AAAACCCC00020001',
  'decision','select','reason_code','process_window_complete','public_rationale',
  'The exact process window ended without an active blocking challenge.','private_note',null),
  'gov-seal-review-one-0001')
$test$,'first eligible analyst casts exact seal review');
select ok((select ready=false and approve_count=1 and approve_weight=1.50
 from osi_private.osi_v2_seal_quorum('35000000-0000-4000-8000-000000000001')),
 'maintainer cannot replace missing second analyst seal vote');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222223',
  'OSI-AAAACCCC0002',jsonb_build_object('phase','seal','report_version_ref','OSI-RV-AAAACCCC00020001',
  'decision','select','reason_code','process_window_complete','public_rationale',
  'A second analyst confirms the exact process window is complete.','private_note',null),
  'gov-seal-review-two-0001')
$test$,'second eligible analyst casts exact seal review');
select ok((select ready and approve_count=2 and approve_weight=2.50
 from osi_private.osi_v2_seal_quorum('35000000-0000-4000-8000-000000000001')),
 'seal requires exact two-analyst and 2.50 weight quorum');
select ok(
 (select count(*)=2 from public.resolution_reviews
   where resolution_id='35000000-0000-4000-8000-000000000001' and phase='selection' and is_active=false)
 and (select count(*)=2 and bool_and(receipt.event_type='RESOLUTION_REVIEW_CAST')
   from public.resolution_reviews review join public.event_receipts receipt on receipt.id=review.event_receipt_id
   where review.resolution_id='35000000-0000-4000-8000-000000000001' and review.phase='seal' and review.is_active),
 'first seal reviews are distinct casts while prior selection history is retained');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('q',43),'seal_finalize',
  '44444444444444444444444444444444','OSI-RES-AAAACCCC00020001','{}'::jsonb,
  'gov-seal-wallet-only-0001',repeat('3',64),null)
$test$,'42501','Seal finalization requires both maintainer gates','seal finalization requires full maintainer');
select lives_ok($test$
 select pg_temp.commit_memo_governance('seal_finalize','44444444444444444444444444444444',
  'OSI-RES-AAAACCCC00020001','{}'::jsonb,'gov-seal-finalize-0001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','C')
$test$,'full maintainer anchors the quorum-ready process seal');
select ok((select resolution.state='sealed' and case_item.stage='sealed' and case_item.sealed_at is not null
 and receipt.event_type='RECORD_SEALED' and receipt.proof_type='solana_memo'
 from public.case_resolutions resolution join public.cases case_item on case_item.id=resolution.case_id
 join public.event_receipts receipt on receipt.id=resolution.seal_receipt_id
 where resolution.id='35000000-0000-4000-8000-000000000001'),
 'RECORD_SEALED exact Memo atomically seals resolution and Case');
select is((select count(*)::integer from public.reward_payments),0,
 'process seal never creates or confirms a payment');

-- Bounded expiry is server-clock driven and produces an honest system receipt.
insert into public.event_receipts (
 id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,
 decision,proof_type,payload_hash,server_verified,occurred_at
) values ('34000000-0000-4000-8000-000000000003','legacy','LEGACY_CHALLENGE_IMPORTED','challenge',
 '36000000-0000-4000-8000-000000000001','OSI-CHL-AAAACCCC00020001',
 '77777777777777777777777777777777','wallet','submit','legacy_imported',repeat('a',64),false,statement_timestamp());
insert into public.challenges_v2 (
 id,challenger_wallet,reason_code,resolution_id,target_kind,evidence_item_id,state,
 admissibility_ttl_at,cooldown_key,submitted_receipt_id,public_ref,public_safe_summary,evidence_hash
) values ('36000000-0000-4000-8000-000000000001','77777777777777777777777777777777',
 'expiry_fixture','35000000-0000-4000-8000-000000000001','resolution',
 '33000000-0000-4000-8000-000000000001','submitted',statement_timestamp()-interval '1 second',
 'resolution:expiry-fixture-wallet','34000000-0000-4000-8000-000000000003',
 'OSI-CHL-AAAACCCC00020001','This challenge fixture expires by its server deadline.',repeat('6',64));
select is(public.osi_v2_expire_due_challenges(10),1,'server expiry closes one due non-terminal challenge');
select ok((select challenge.state='expired' and challenge.expired_reason='admissibility_timeout'
 and challenge.terminal_at is not null and receipt.event_type='CHALLENGE_EXPIRED'
 and receipt.proof_type='system_event' and receipt.server_verified
 from public.challenges_v2 challenge join public.event_receipts receipt on receipt.id=challenge.resolved_receipt_id
 where challenge.id='36000000-0000-4000-8000-000000000001'),
 'expired challenge records immutable timeout and system proof without penalty');

select is((select value from public.osi_config where key='OSI_V2_WRITES_ENABLED'),'false',
 'broad V2 write flag remains false');
select is((select value from public.osi_config where key='OSI_V2_PROOF_ENABLED'),'false',
 'broad proof flag remains false');

select * from finish();
rollback;
