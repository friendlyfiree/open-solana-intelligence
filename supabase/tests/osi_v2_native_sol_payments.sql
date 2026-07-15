-- Native SOL reward pledge, finalized reward payment and voluntary support.
-- All fixtures and flag changes roll back in the disposable pgTAP database.

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select is((select value from public.osi_config where key='OSI_V2_PAYMENT_WRITES_ENABLED'),
  'false','native SOL payment mutations start fail-closed');
select isnt(has_function_privilege('authenticated',
  'public.osi_v2_prepare_payment(text,text,text,text,jsonb,text,text)','EXECUTE'),true,
  'authenticated browser cannot call payment prepare RPC directly');
select isnt(has_function_privilege('anon',
  'public.osi_v2_commit_payment(text,text,bigint,timestamptz,text,jsonb)','EXECUTE'),true,
  'anonymous browser cannot call payment commit RPC directly');
select isnt(has_function_privilege('authenticated',
  'public.osi_v2_record_payment_failure(text,text,text)','EXECUTE'),true,
  'authenticated browser cannot claim a server-derived payment failure directly');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.reward_pledges'::regclass),
  'reward pledges remain FORCE RLS');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.reward_payments'::regclass),
  'reward payments remain FORCE RLS');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.support_events'::regclass),
  'support events remain FORCE RLS');

create temporary table v1_money_counts (
  relation_name text primary key,
  row_count bigint not null
) on commit drop;
do $test$
declare
  relation_name text;
  current_count bigint;
begin
  foreach relation_name in array array['bounties', 'onchain_events'] loop
    if to_regclass(format('public.%I', relation_name)) is not null then
      execute format('select count(*) from public.%I', relation_name) into current_count;
      insert into pg_temp.v1_money_counts values (relation_name, current_count);
    end if;
  end loop;
end
$test$;

update public.osi_config set value='true' where key='OSI_V2_PAYMENT_WRITES_ENABLED';
update public.osi_config set value='600' where key='OSI_V2_PAYMENT_RATE_WINDOW_SECONDS';
update public.osi_config set value='100' where key='OSI_V2_PAYMENT_MAX_PER_WALLET';
update public.osi_config set value='200' where key='OSI_V2_PAYMENT_MAX_PER_FINGERPRINT';

insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '41000000-0000-4000-8000-000000000001','OSI-PAYPRIVATE0001','Private pledge fixture','other',
 'Public-safe summary that remains unavailable while this Case is private.','Restricted private payment fixture.',
 '11111111111111111111111111111112','initial_review','private','standard','[]'::jsonb
);

select throws_ok($test$
 select * from public.osi_v2_prepare_pledge(repeat('a',43),'create',
  '11111111111111111111111111111113','OSI-PAYPRIVATE0001',1000000000,
  'payment-wrong-owner-0001',repeat('1',64))
$test$,'42501','Only the exact Case owner may mutate its pledge',
 'wrong Case owner cannot create a pledge');

create temporary table pledge_create on commit drop as
select * from public.osi_v2_prepare_pledge(repeat('b',43),'create',
 '11111111111111111111111111111112','OSI-PAYPRIVATE0001',1000000000,
 'payment-pledge-create-0001',repeat('2',64));
select ok((select nonce.purpose='REWARD_PLEDGE_CREATED' and nonce.target_type='reward'
 and nonce.target_id=prepared.pledge_id::text and nonce.actor_wallet='11111111111111111111111111111112'
 and nonce.payload_hash=prepared.payload_hash
 from pg_temp.pledge_create prepared join public.osi_nonces nonce on nonce.nonce=prepared.issued_nonce),
 'pledge nonce binds exact purpose actor target and payload hash');
select lives_ok($test$
 select * from public.osi_v2_commit_pledge(repeat('b',43),'create',1000000000,
  (select proof_text from pg_temp.pledge_create),repeat('S',88))
$test$,'owner creates a wallet-signed server-verified pledge without moving SOL');
set constraints all immediate;
set constraints all deferred;
select ok((select receipt.event_type='REWARD_PLEDGE_CREATED'
 and receipt.proof_type='wallet_signed_server_verified' and receipt.tx_sig is null
 and receipt.actor_role='owner' and receipt.verification_metadata->>'amount_lamports'='1000000000'
 from public.reward_pledges pledge join public.event_receipts receipt on receipt.id=pledge.created_receipt_id
 where pledge.case_id='41000000-0000-4000-8000-000000000001'),
 'pledge creation receipt is Class B and exact-amount bound');

create temporary table pledge_revise on commit drop as
select * from public.osi_v2_prepare_pledge(repeat('c',43),'revise',
 '11111111111111111111111111111112','OSI-PAYPRIVATE0001',750000000,
 'payment-pledge-revise-0001',repeat('3',64));
select lives_ok($test$
 select * from public.osi_v2_commit_pledge(repeat('c',43),'revise',750000000,
  (select proof_text from pg_temp.pledge_revise),repeat('T',88))
$test$,'owner may revise a private pre-open pledge while preserving history');
select ok((select amount_lamports=750000000 and revision_no=2 and state='pledged'
 from public.reward_pledges where case_id='41000000-0000-4000-8000-000000000001'),
 'private pledge revision changes the current amount and advances revision number');
select is((select count(*)::integer from public.event_receipts
 where target_id=(select id::text from public.reward_pledges where case_id='41000000-0000-4000-8000-000000000001')
 and event_type in ('REWARD_PLEDGE_CREATED','REWARD_PLEDGE_REVISED')),2,
 'pledge revision keeps immutable creation and revision receipts');
select throws_ok($test$
 select * from public.osi_v2_prepare_payment(repeat('o',43),'reward','11111111111111111111111111111112',
  'OSI-PAYPRIVATE0001','{"amount_lamports":"1"}'::jsonb,
  'payment-reward-before-seal-0001',repeat('4',64))
$test$,'42501','Reward is not ready for this exact owner, winner and outstanding pledge',
 'reward payment is rejected before Case sealing');

create temporary table pledge_withdraw on commit drop as
select * from public.osi_v2_prepare_pledge(repeat('d',43),'withdraw',
 '11111111111111111111111111111112','OSI-PAYPRIVATE0001',1,
 'payment-pledge-withdraw-0001',repeat('4',64));
select lives_ok($test$
 select * from public.osi_v2_commit_pledge(repeat('d',43),'withdraw',750000000,
  (select proof_text from pg_temp.pledge_withdraw),repeat('U',88))
$test$,'owner may withdraw a private pre-open pledge with a new signed receipt');
select ok((select state='cancelled' and revision_no=3 and withdrawn_at is not null
 from public.reward_pledges where case_id='41000000-0000-4000-8000-000000000001'),
 'withdrawn pledge has a server-derived cancelled state and retained amount history');
select throws_ok($test$
 select * from public.osi_v2_prepare_pledge(repeat('e',43),'revise',
  '11111111111111111111111111111112','OSI-PAYPRIVATE0001',900000000,
  'payment-pledge-after-withdraw-0001',repeat('5',64))
$test$,'42501','Pledge revision is not allowed in the current Case state',
 'withdrawn pledge cannot be silently revived or overwritten');

-- Sealed Case fixture. Legacy receipts are used only to arrange a previously
-- completed governance state; all payment effects below are native OSI2.
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '42000000-0000-4000-8000-000000000001','OSI-PAYSEALED0001','Sealed reward fixture','other',
 'Public sealed Case used for exact reward payment tests.','Restricted sealed fixture.',
 '11111111111111111111111111111115','resolved','public','standard','[]'::jsonb
);
insert into public.event_receipts (
 id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,
 decision,proof_type,payload_hash,server_verified,occurred_at
) values
 ('42100000-0000-4000-8000-000000000001','legacy','LEGACY_REPORT_IMPORTED','report_version',
  '42300000-0000-4000-8000-000000000001','OSI-RV-PAYSEALED00010001','11111111111111111111111111111116',
  'wallet','submit','legacy_imported',repeat('6',64),false,statement_timestamp()),
 ('42100000-0000-4000-8000-000000000002','legacy','LEGACY_REPORT_PUBLISHED','report_version',
  '42300000-0000-4000-8000-000000000001','OSI-RV-PAYSEALED00010001','11111111111111111111111111111116',
  'wallet','publish','legacy_imported',repeat('7',64),false,statement_timestamp()),
 ('42100000-0000-4000-8000-000000000003','legacy','LEGACY_RESOLUTION_FINAL','resolution',
  '42400000-0000-4000-8000-000000000001','OSI-RES-ABCDEF1234567890','44444444444444444444444444444444',
  'maintainer','seal','legacy_imported',repeat('8',64),false,statement_timestamp()),
 ('42100000-0000-4000-8000-000000000004','legacy','LEGACY_REWARD_PLEDGE','reward',
  '42500000-0000-4000-8000-000000000001','OSI-PAYSEALED0001','11111111111111111111111111111115',
  'owner','pledge','legacy_imported',repeat('9',64),false,statement_timestamp());
insert into public.case_reports (id,case_id,author_wallet,status,public_ref,native_intake)
values ('42200000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000001',
 '11111111111111111111111111111116','active','OSI-RPT-PAYSEALED0001',false);
insert into public.case_report_versions (
 id,report_id,version_no,version_ref,created_by_wallet,body_private,content_public_safe,
 evidence_snapshot_hash,lifecycle_state,published_at,publication_receipt_id,event_receipt_id
) values (
 '42300000-0000-4000-8000-000000000001','42200000-0000-4000-8000-000000000001',1,
 'OSI-RV-PAYSEALED00010001','11111111111111111111111111111116','Immutable sealed winning version.',
 'Public-safe sealed winning version.',repeat('a',64),'published',statement_timestamp(),
 '42100000-0000-4000-8000-000000000002','42100000-0000-4000-8000-000000000001');
update public.case_reports set current_version_id='42300000-0000-4000-8000-000000000001',
 current_published_version_id='42300000-0000-4000-8000-000000000001'
 where id='42200000-0000-4000-8000-000000000001';
set local session_replication_role=replica;
insert into public.case_resolutions (
 id,case_id,winning_report_version_id,proposed_by_wallet,state,finalized_by,event_receipt_id
) values (
 '42400000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000001',
 '42300000-0000-4000-8000-000000000001','44444444444444444444444444444444',
 'sealed','quorum_maintainer','42100000-0000-4000-8000-000000000003');
set local session_replication_role=origin;
insert into public.reward_pledges (
 id,case_id,pledger_wallet,amount_lamports,state,created_receipt_id,revision_no
) values (
 '42500000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000001',
 '11111111111111111111111111111115',1000000000,'pledged',
 '42100000-0000-4000-8000-000000000004',1);
update public.cases set stage='sealed',sealed_at=statement_timestamp()
 where id='42000000-0000-4000-8000-000000000001';
select ok((select state='assigned'
 and winning_report_version_id='42300000-0000-4000-8000-000000000001'
 and sealed_amount_lamports=1000000000
 from public.reward_pledges where id='42500000-0000-4000-8000-000000000001'),
 'Case sealing atomically freezes the exact pledged amount and winning Report version');

select throws_ok($test$
 select * from public.osi_v2_prepare_payment(repeat('f',43),'reward','11111111111111111111111111111114',
  'OSI-PAYSEALED0001','{"amount_lamports":"400000000"}'::jsonb,
  'payment-reward-wrong-owner-0001',repeat('b',64))
$test$,'42501','Reward is not ready for this exact owner, winner and outstanding pledge',
 'wrong Case owner cannot prepare the sealed reward transfer');

create temporary table reward_part_one on commit drop as
select * from public.osi_v2_prepare_payment(repeat('g',43),'reward','11111111111111111111111111111115',
 'OSI-PAYSEALED0001','{"amount_lamports":"400000000"}'::jsonb,
 'payment-reward-part-one-0001',repeat('c',64));
select ok((select purpose='REWARD_PAYMENT_CONFIRMED' and actor_role='owner'
 and total_lamports=400000000 and recipient_manifest->0->>'wallet'='11111111111111111111111111111116'
 and recipient_manifest->0->>'target_ref'='OSI-RV-PAYSEALED00010001'
 from pg_temp.reward_part_one),
 'reward prepare derives the exact sealed winning version author and partial amount');
select ok((select nonce.target_type='reward' and nonce.target_id=prepared.payment_id::text
 and nonce.binding_context->>'pledge_id'='42500000-0000-4000-8000-000000000001'
 and nonce.binding_context->>'resolution_id'='42400000-0000-4000-8000-000000000001'
 and nonce.payload_hash=prepared.payload_hash
 from pg_temp.reward_part_one prepared join public.osi_nonces nonce on nonce.nonce=prepared.issued_nonce),
 'reward nonce binds payment, pledge, resolution, target and payload');
select throws_ok($test$
 select * from public.osi_v2_prepare_payment(repeat('u',43),'reward','11111111111111111111111111111115',
  'OSI-PAYSEALED0001','{"amount_lamports":"400000000"}'::jsonb,
  'payment-reward-overlap-0001',repeat('a',64))
$test$,'23514','An exact reward payment is already awaiting verification',
 'a second reward intent cannot be prepared while the exact pledge awaits verification');
select lives_ok($test$
 select * from public.osi_v2_record_payment_submission(repeat('g',43),repeat('A',88))
$test$,'submitted reward transaction is persisted as awaiting finality');
select ok((select state='submitted' and confirmed_at is null and event_receipt_id is null
 from public.reward_payments where intent_nonce=repeat('g',43)),
 'awaiting-finality reward is not confirmed or paid');
select lives_ok($test$
 select * from public.osi_v2_commit_payment(repeat('g',43),repeat('A',88),500001,
  statement_timestamp(),'finalized','{"fixture":"trusted_rpc"}'::jsonb)
$test$,'finalized exact partial reward commits through the server-only path');
set constraints all immediate;
set constraints all deferred;
select ok((select pledge.state='assigned' and sum(payment.amount_lamports)=400000000
 from public.reward_pledges pledge join public.reward_payments payment on payment.pledge_id=pledge.id
 where pledge.id='42500000-0000-4000-8000-000000000001' and payment.state='confirmed'
 group by pledge.state),
 'partial confirmed total leaves the pledge assigned and 600000000 lamports outstanding');
select ok((select receipt.event_type='REWARD_PAYMENT_CONFIRMED' and receipt.proof_type='solana_memo'
 and receipt.server_verified and receipt.actor_role='owner' and receipt.tx_sig=repeat('A',88)
 and receipt.verification_metadata->>'finality'='finalized'
 and receipt.verification_metadata->>'total_lamports'='400000000'
 from public.reward_payments payment join public.event_receipts receipt on receipt.id=payment.event_receipt_id
 where payment.intent_nonce=repeat('g',43)),
 'partial reward receipt is exact Class A finalized transfer proof');
select ok((select idempotent_replay from public.osi_v2_commit_payment(repeat('g',43),repeat('A',88),500001,
 statement_timestamp(),'finalized','{"fixture":"trusted_rpc"}'::jsonb)),
 'exact finalized reward retry returns the original receipt idempotently');
select throws_ok($test$
 select * from public.osi_v2_commit_payment(repeat('g',43),repeat('B',88),500001,
  statement_timestamp(),'finalized','{"fixture":"trusted_rpc"}'::jsonb)
$test$,'23514','Consumed payment nonce is bound to another transaction',
 'nonce replay with a different transaction signature is rejected');

create temporary table reward_part_two on commit drop as
select * from public.osi_v2_prepare_payment(repeat('h',43),'reward','11111111111111111111111111111115',
 'OSI-PAYSEALED0001','{"amount_lamports":"600000000"}'::jsonb,
 'payment-reward-part-two-0001',repeat('d',64));
select lives_ok($test$
 select * from public.osi_v2_commit_payment(repeat('h',43),repeat('C',88),500002,
  statement_timestamp(),'finalized','{"fixture":"trusted_rpc"}'::jsonb)
$test$,'second finalized partial reward fulfills the exact sealed amount');
select ok((select pledge.state='paid' and sum(payment.amount_lamports)=pledge.amount_lamports
 from public.reward_pledges pledge join public.reward_payments payment on payment.pledge_id=pledge.id
 where pledge.id='42500000-0000-4000-8000-000000000001' and payment.state='confirmed'
 group by pledge.state,pledge.amount_lamports),
 'full confirmed total derives fulfilled state without exceeding the pledge');
select throws_ok($test$
 select * from public.osi_v2_prepare_payment(repeat('i',43),'reward','11111111111111111111111111111115',
  'OSI-PAYSEALED0001','{"amount_lamports":"1"}'::jsonb,
  'payment-reward-overpay-0001',repeat('e',64))
$test$,'42501','Reward is not ready for this exact owner, winner and outstanding pledge',
 'fulfilled reward cannot be overpaid');

insert into public.analyst_profiles (wallet,status,tier_code,verified,approved,weight_cached)
values
 ('22222222222222222222222222222222','probationary_analyst','probationary',true,true,0.50),
 ('22222222222222222222222222222223','probationary_analyst','probationary',true,true,1.00);
select throws_ok($test$
 select * from public.osi_v2_prepare_payment(repeat('j',43),'support','11111111111111111111111111111116',
  'OSI-RV-PAYSEALED00010001',jsonb_build_object('recipients',jsonb_build_array(jsonb_build_object(
   'target_type','report_author','target_ref','OSI-RV-PAYSEALED00010001','amount_lamports','10000000'))),
  'payment-support-self-0001',repeat('f',64))
$test$,'42501','Support recipient is unavailable or is the payer',
 'Report author self-support is rejected');
select throws_ok($test$
 select * from public.osi_v2_prepare_payment(repeat('k',43),'support','11111111111111111111111111111117',
  '44444444444444444444444444444444',jsonb_build_object('recipients',jsonb_build_array(jsonb_build_object(
   'target_type','analyst','target_ref','44444444444444444444444444444444','amount_lamports','10000000'))),
  'payment-maintainer-not-analyst-0001',repeat('1',64))
$test$,'42501','Support recipient is unavailable or is the payer',
 'maintainer wallet without an eligible analyst profile cannot receive analyst support');

create temporary table analyst_support on commit drop as
select * from public.osi_v2_prepare_payment(repeat('l',43),'support','11111111111111111111111111111117',
 '22222222222222222222222222222222',jsonb_build_object('recipients',jsonb_build_array(jsonb_build_object(
  'target_type','analyst','target_ref','22222222222222222222222222222222','amount_lamports','25000000'))),
 'payment-analyst-support-0001',repeat('2',64));
select ok((select payment_kind='support' and actor_role='wallet' and total_lamports=25000000
 and recipient_manifest->0->>'wallet'='22222222222222222222222222222222'
 from pg_temp.analyst_support),
 'verified analyst support recipient and amount are server-derived');
select lives_ok($test$
 select * from public.osi_v2_commit_payment(repeat('l',43),repeat('D',88),500003,
  statement_timestamp(),'finalized','{"fixture":"trusted_rpc"}'::jsonb)
$test$,'finalized verified analyst support commits independently of reward');
select ok((select event.state='confirmed' and event.support_type='analyst'
 and event.amount_lamports=25000000 and event.finality='finalized'
 and receipt.event_type='SUPPORT_PAYMENT_CONFIRMED'
 from public.support_events event join public.event_receipts receipt on receipt.id=event.event_receipt_id
 where event.intent_nonce=repeat('l',43)),
 'confirmed support has its own authoritative row and Class A receipt');

create temporary table failed_support on commit drop as
select * from public.osi_v2_prepare_payment(repeat('p',43),'support','11111111111111111111111111111117',
 '22222222222222222222222222222222',jsonb_build_object('recipients',jsonb_build_array(jsonb_build_object(
  'target_type','analyst','target_ref','22222222222222222222222222222222','amount_lamports','2'))),
 'payment-failed-support-0001',repeat('4',64));
select lives_ok($test$
 select * from public.osi_v2_record_payment_failure(repeat('p',43),repeat('E',88),'memo_mismatch')
$test$,'trusted transaction verification failure is persisted without claiming payment');
select ok((select event.state='failed' and event.verification_error='memo_mismatch'
 and event.confirmed_at is null and event.event_receipt_id is null
 from public.support_events event where event.intent_nonce=repeat('p',43)),
 'definitively invalid support remains unpaid and has no Class A receipt');

create temporary table second_target_support on commit drop as
select * from public.osi_v2_prepare_payment(repeat('q',43),'support','11111111111111111111111111111117',
 '22222222222222222222222222222223',jsonb_build_object('recipients',jsonb_build_array(jsonb_build_object(
  'target_type','analyst','target_ref','22222222222222222222222222222223','amount_lamports','1'))),
 'payment-second-support-target-0001',repeat('3',64));
select throws_ok($test$
 select * from public.osi_v2_record_payment_submission(repeat('q',43),repeat('D',88))
$test$,'23505','duplicate key value violates unique constraint "support_events_tx_sig_uidx"',
 'same transaction signature cannot satisfy two support targets');

create temporary table duplicate_support on commit drop as
select * from public.osi_v2_prepare_payment(repeat('m',43),'support','11111111111111111111111111111117',
 '22222222222222222222222222222222',jsonb_build_object('recipients',jsonb_build_array(jsonb_build_object(
  'target_type','analyst','target_ref','22222222222222222222222222222222','amount_lamports','1'))),
 'payment-cross-purpose-tx-0001',repeat('3',64));
select throws_ok($test$
 select * from public.osi_v2_record_payment_submission(repeat('m',43),repeat('A',88))
$test$,'23505','A transaction cannot be both support and reward',
 'same transaction signature cannot satisfy reward and support');
select throws_ok($test$
 select * from public.osi_v2_prepare_payment(repeat('n',43),'support','11111111111111111111111111111117',
  '22222222222222222222222222222222',jsonb_build_object('recipients',jsonb_build_array(jsonb_build_object(
   'target_type','analyst','target_ref','22222222222222222222222222222222','amount_lamports','2'))),
  'payment-cross-purpose-tx-0001',repeat('3',64))
$test$,'23514','Idempotency key is bound to another exact payment intent',
 'changed payload cannot replay an existing payment idempotency key');

select is((select count(*)::integer from public.reward_payments where state='confirmed'),2,
 'only the two exact reward transfers are confirmed');
select is((select count(*)::integer from public.support_events where state='confirmed'),1,
 'only the exact verified analyst support is confirmed');
do $test$
declare
  snapshot record;
  current_count bigint;
begin
  for snapshot in select * from pg_temp.v1_money_counts loop
    execute format('select count(*) from public.%I', snapshot.relation_name) into current_count;
    if current_count <> snapshot.row_count then
      raise exception 'V1 relation % changed from % rows to % rows',
        snapshot.relation_name, snapshot.row_count, current_count;
    end if;
  end loop;
end
$test$;
select pass('existing V1 bounty and onchain event rows remain unchanged');

select * from finish();
rollback;
