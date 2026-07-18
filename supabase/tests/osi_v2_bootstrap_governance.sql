-- D17 bootstrap maintainer quorum and D18 Path B analyst candidacy.
-- Every fixture and config change rolls back with this pgTAP transaction.

begin;
create extension if not exists pgtap with schema extensions;
select plan(86);

-- ---------------------------------------------------------------------------
-- Shared fixture helpers (same shapes as the accepted governance suite).
-- ---------------------------------------------------------------------------
create temporary sequence pg_temp.filler_seq;
-- Drive the live eligible-analyst count without ever deleting (history is
-- append-only): insert fresh filler analysts to raise it, revoke surplus
-- ones (a legal forward transition) to lower it.
create function pg_temp.set_filler_analysts(n integer) returns void
language plpgsql as $$
declare cur integer; i integer; w text;
begin
  select count(*) into cur from public.analyst_profiles
   where wallet like 'Bt%' and status = 'probationary_analyst' and approved;
  if cur < n then
    for i in 1..(n - cur) loop
      insert into public.analyst_profiles (wallet, status, tier_code, verified, approved, weight_cached)
      values ('Bt' || lpad(replace(nextval('pg_temp.filler_seq')::text, '0', 'A'), 30, 'x'),
        'probationary_analyst', 'probationary', true, true, 0.50);
    end loop;
  elsif cur > n then
    for w in
      select wallet from public.analyst_profiles
       where wallet like 'Bt%' and status = 'probationary_analyst' and approved
       order by wallet limit (cur - n)
    loop
      update public.analyst_profiles
         set status = 'revoked', tier_code = 'none', verified = false,
             approved = false, weight_cached = 0
       where wallet = w;
    end loop;
  end if;
end $$;

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
    'Immutable restricted fixture body for exact bootstrap governance.',
    'Public-safe fixture summary for cold-start process review.',repeat('c',64),
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

-- ---------------------------------------------------------------------------
-- 1. Fail-closed posture and live tier boundaries.
-- ---------------------------------------------------------------------------
select is((select value from public.osi_config where key='OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED'),
  'false','bootstrap maintainer quorum ships disabled by default');
select is((select value from public.osi_config where key='OSI_V2_BOOTSTRAP_TIER3_MIN_WEIGHT'),
  '1.00','tier-3 reduced weight threshold ships with its reviewed default');
select ok((select count(*)=1 from information_schema.columns
  where table_schema='public' and table_name='event_receipts' and column_name='decision_channel'),
  'event receipts carry an explicit decision channel column');
select ok((select enabled=false and active=false and tier='disabled'
  from osi_private.osi_v2_bootstrap_tier()),
  'absent or false flag keeps the bootstrap tier fully disabled');

update public.osi_config set value='true'
 where key in ('OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED',
   'OSI_V2_REPORT_WRITES_ENABLED','OSI_V2_REPORT_REVIEW_WRITES_ENABLED');
update public.osi_config set value='0'
 where key in ('OSI_V2_REPORT_COOLDOWN_SECONDS','OSI_V2_REPORT_REVIEW_COOLDOWN_SECONDS');
insert into public.osi_config (key, value) values
  ('admin_wallet', '44444444444444444444444444444444')
on conflict (key) do update set value=excluded.value;

update public.osi_config set value='true'
 where key='OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED';

select pg_temp.set_filler_analysts(0);
select ok((select active and tier='maintainer_only' and eligible_analyst_count=0
  and required_analyst_count=0 and required_analyst_weight=0
  from osi_private.osi_v2_bootstrap_tier()),
  'at 0 eligible analysts the full maintainer alone is the required signer');
select pg_temp.set_filler_analysts(19);
select ok((select active and tier='maintainer_only' and eligible_analyst_count=19
  and required_analyst_count=0 and required_analyst_weight=0
  from osi_private.osi_v2_bootstrap_tier()),
  'at 19 eligible analysts the full maintainer alone is still the required signer');
select pg_temp.set_filler_analysts(20);
select ok((select active and tier='maintainer_plus_one' and eligible_analyst_count=20
  and required_analyst_count=1 and required_analyst_weight=0.50
  from osi_private.osi_v2_bootstrap_tier()),
  'at 20 eligible analysts one independent analyst must co-sign');
select pg_temp.set_filler_analysts(29);
select ok((select active and tier='maintainer_plus_one' and eligible_analyst_count=29
  and required_analyst_count=1 and required_analyst_weight=0.50
  from osi_private.osi_v2_bootstrap_tier()),
  'at 29 eligible analysts one independent analyst still co-signs');
select pg_temp.set_filler_analysts(30);
select ok((select active and tier='maintainer_plus_two' and eligible_analyst_count=30
  and required_analyst_count=2 and required_analyst_weight=1.00
  from osi_private.osi_v2_bootstrap_tier()),
  'at 30 eligible analysts two independent analysts and the reduced weight apply');
select pg_temp.set_filler_analysts(49);
select ok((select active and tier='maintainer_plus_two' and eligible_analyst_count=49
  and required_analyst_count=2 and required_analyst_weight=1.00
  from osi_private.osi_v2_bootstrap_tier()),
  'at 49 eligible analysts the maintainer-plus-two rule still applies');
select pg_temp.set_filler_analysts(50);
select ok((select enabled and active=false and tier='retired' and eligible_analyst_count=50
  from osi_private.osi_v2_bootstrap_tier()),
  'at 50 eligible analysts the bootstrap retires itself with no remaining effect');
insert into public.analyst_profiles (wallet, status, tier_code, verified, approved, weight_cached) values
  ('Ca111111111111111111111111111111','analyst_candidate','none',false,false,0),
  ('Ca111111111111111111111111111112','contributor','none',false,false,0);
select pg_temp.set_filler_analysts(19);
select ok((select tier='maintainer_only' and eligible_analyst_count=19
  from osi_private.osi_v2_bootstrap_tier()),
  'candidates and contributors never count toward the live eligible-analyst tier');
update public.osi_config set value='abc' where key='OSI_V2_BOOTSTRAP_TIER3_MIN_WEIGHT';
select throws_ok($test$
  select * from osi_private.osi_v2_bootstrap_tier()
$test$,'55000','Bootstrap reduced weight configuration is invalid',
  'malformed reduced weight configuration fails the whole channel closed');
update public.osi_config set value='1.00' where key='OSI_V2_BOOTSTRAP_TIER3_MIN_WEIGHT';

-- ---------------------------------------------------------------------------
-- 2. Flag-off regression: the original D5 behavior is untouched.
-- ---------------------------------------------------------------------------
select pg_temp.set_filler_analysts(0);
update public.osi_config set value='false'
 where key='OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED';

insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '40000000-0000-4000-8000-000000000001','OSI-BBBBDDDD0001','Cold start fixture one','other',
 'Public summary for the first cold-start fixture.','Restricted fixture one.',
 '11111111111111111111111111111121','open_public','public','standard','[]'::jsonb
);
select pg_temp.add_published_report(
 '40000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001',
 '42000000-0000-4000-8000-000000000001','OSI-RPT-BBBBDDDD0001','OSI-RV-BBBBDDDD00010001',
 '11111111111111111111111111111122');

select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('f',43),'resolution_finalize',
  '44444444444444444444444444444444','OSI-BBBBDDDD0001',
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00010001'),
  'boot-flag-off-finalize-0001',repeat('1',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Resolution is not available',
 'flag off keeps the exact original cold-start failure for a bootstrap-shaped request');
select ok(not exists (select 1 from public.case_resolutions
  where case_id='40000000-0000-4000-8000-000000000001'),
 'flag off leaves zero resolution side effects behind');

-- Native intake fixture for publication checks.
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '40000000-0000-4000-8000-000000000002','OSI-BBBBDDDD0002','Native publication fixture','other',
 'Public summary for the native publication fixture.','Restricted fixture two.',
 '11111111111111111111111111111131','open_public','public','standard','[]'::jsonb
);
create temporary table cn1_prepare on commit drop as
select * from public.osi_v2_prepare_report_version(
  repeat('g',32),'11111111111111111111111111111132','40000000-0000-4000-8000-000000000002',
  'This immutable restricted Report describes transaction order, relationships, limits, and uncertainty for cold-start publication review.',
  'A public-safe summary for the bootstrap publication fixture.',
  null,
  jsonb_build_array(jsonb_build_object(
    'kind','wallet','ref','11111111111111111111111111111133',
    'sha256',encode(extensions.digest(convert_to('11111111111111111111111111111133','UTF8'),'sha256'),'hex')
  )),
  'boot-native-report-0001',repeat('2',64)
);
select lives_ok($test$
 select * from public.osi_v2_commit_report_version(
  repeat('g',32),
  'This immutable restricted Report describes transaction order, relationships, limits, and uncertainty for cold-start publication review.',
  'A public-safe summary for the bootstrap publication fixture.',
  null,
  jsonb_build_array(jsonb_build_object(
    'kind','wallet','ref','11111111111111111111111111111133',
    'sha256',encode(extensions.digest(convert_to('11111111111111111111111111111133','UTF8'),'sha256'),'hex')
  )),
  repeat('R',88),'OSI2 test CASE_REPORT_VERSION_SUBMITTED',statement_timestamp())
$test$,'native Report version fixture is committed for publication checks');
select throws_ok($test$
 select * from public.osi_v2_prepare_report_publication(
  repeat('h',32),'44444444444444444444444444444444',
  (select version_id from pg_temp.cn1_prepare),
  'boot-flag-off-publication-0001',repeat('3',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Bootstrap maintainer quorum is not available',
 'flag off refuses the maintainer publication channel fail-closed');

update public.osi_config set value='true'
 where key='OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED';

-- ---------------------------------------------------------------------------
-- 3. Tier < 20: full maintainer alone, double gate never relaxed.
-- ---------------------------------------------------------------------------
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('i',43),'resolution_finalize',
  '44444444444444444444444444444444','OSI-BBBBDDDD0001',
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00010001'),
  'boot-wallet-only-finalize-0001',repeat('4',64),null)
$test$,'42501','Resolution finalization requires both maintainer gates',
 'tier below 20 still denies the wallet-only half maintainer');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('j',43),'resolution_finalize',
  '55555555555555555555555555555555','OSI-BBBBDDDD0001',
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00010001'),
  'boot-auth-only-finalize-0001',repeat('5',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Resolution finalization requires both maintainer gates',
 'tier below 20 still denies the auth-only half maintainer');

select pg_temp.add_unpublished_report(
 '40000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000002',
 '42000000-0000-4000-8000-000000000002','OSI-RPT-BBBBDDDD0002','OSI-RV-BBBBDDDD00010002',
 '11111111111111111111111111111123');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('k',43),'resolution_finalize',
  '44444444444444444444444444444444','OSI-BBBBDDDD0001',
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00010002'),
  'boot-unpublished-finalize-0001',repeat('6',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Bootstrap selection requires an exact currently published Case Report version',
 'bootstrap selection rejects an unpublished exact version');

insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '40000000-0000-4000-8000-000000000003','OSI-BBBBDDDD0003','Maintainer authored fixture','other',
 'Public summary for the maintainer-authored fixture.','Restricted fixture three.',
 '11111111111111111111111111111124','open_public','public','standard','[]'::jsonb
);
select pg_temp.add_published_report(
 '40000000-0000-4000-8000-000000000003','41000000-0000-4000-8000-000000000003',
 '42000000-0000-4000-8000-000000000003','OSI-RPT-BBBBDDDD0003','OSI-RV-BBBBDDDD00030001',
 '44444444444444444444444444444444');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('l',43),'resolution_finalize',
  '44444444444444444444444444444444','OSI-BBBBDDDD0003',
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00030001'),
  'boot-self-author-finalize-0001',repeat('7',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Bootstrap maintainer cannot decide their own Case or Report',
 'bootstrap maintainer cannot select their own authored Report');

insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '40000000-0000-4000-8000-000000000004','OSI-BBBBDDDD0004','Maintainer owned fixture','other',
 'Public summary for the maintainer-owned fixture.','Restricted fixture four.',
 '44444444444444444444444444444444','open_public','public','standard','[]'::jsonb
);
select pg_temp.add_published_report(
 '40000000-0000-4000-8000-000000000004','41000000-0000-4000-8000-000000000004',
 '42000000-0000-4000-8000-000000000004','OSI-RPT-BBBBDDDD0004','OSI-RV-BBBBDDDD00040001',
 '11111111111111111111111111111125');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('m',43),'resolution_finalize',
  '44444444444444444444444444444444','OSI-BBBBDDDD0004',
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00040001'),
  'boot-self-owner-finalize-0001',repeat('8',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Bootstrap maintainer cannot decide their own Case or Report',
 'bootstrap maintainer cannot decide a Case they submitted');

select lives_ok($test$
 select pg_temp.commit_memo_governance('resolution_finalize','44444444444444444444444444444444',
  'OSI-BBBBDDDD0001',jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00010001'),
  'boot-tier1-finalize-0001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A')
$test$,'tier below 20 full maintainer finalizes one exact published version');
select ok((select resolution.winning_report_version_id='42000000-0000-4000-8000-000000000001'
 and resolution.finalized_by='maintainer_bootstrap' and resolution.state='in_challenge_window'
 and resolution.challenge_window_ends_at-resolution.challenge_window_opens_at=interval '7 days'
 from public.case_resolutions as resolution
 where resolution.case_id='40000000-0000-4000-8000-000000000001'),
 'bootstrap selection binds the exact version with the honest finalization mode and full window');
select ok((select receipt.event_type='REPORT_SELECTED_WINNING' and receipt.decision_channel='maintainer_bootstrap'
 and receipt.actor_role='maintainer' and receipt.actor_wallet='44444444444444444444444444444444'
 and receipt.proof_type='solana_memo' and receipt.server_verified and receipt.weight is null
 from public.case_resolutions as resolution
 join public.event_receipts as receipt on receipt.id=resolution.final_receipt_id
 where resolution.case_id='40000000-0000-4000-8000-000000000001'),
 'bootstrap selection receipt carries the distinct maintainer_bootstrap decision channel');
select is((select stage from public.cases where public_ref='OSI-BBBBDDDD0001'),
 'in_challenge_window','bootstrap selection opens the same unshortened challenge window');
select ok((select profile.status='analyst_candidate' and profile.weight_cached=0
 and profile.tier_code='none' and profile.verified=false and profile.approved=false
 from public.analyst_profiles as profile
 where profile.wallet='11111111111111111111111111111122')
 and not exists (select 1 from public.analyst_applications
   where applicant_wallet='11111111111111111111111111111122'),
 'Path B promotes the winning author with no application to analyst_candidate at weight zero');
select is((select count(*)::integer from public.event_receipts
 where target_type='analyst' and target_id='11111111111111111111111111111122'),
 0,'Path B candidacy creates no governance receipt or Proof Log entry');
select is((select count(*)::integer from public.reward_payments),0,
 'bootstrap selection never invents a paid state');

-- Seal through the bootstrap channel after the window truly ends.
set local session_replication_role=replica;
update public.case_resolutions
   set challenge_window_opens_at=statement_timestamp()-interval '8 days',
       challenge_window_ends_at=statement_timestamp()-interval '1 day'
 where case_id='40000000-0000-4000-8000-000000000001';
set local session_replication_role=origin;

select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('o',43),'seal_finalize',
  '44444444444444444444444444444444',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000001'),
  '{}'::jsonb,'boot-wallet-only-seal-0001',repeat('9',64),null)
$test$,'42501','Seal finalization requires both maintainer gates',
 'tier below 20 still denies the wallet-only half maintainer at seal');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('q',43),'seal_finalize',
  '55555555555555555555555555555555',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000001'),
  '{}'::jsonb,'boot-auth-only-seal-0001',repeat('a',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Seal finalization requires both maintainer gates',
 'tier below 20 still denies the auth-only half maintainer at seal');
select lives_ok($test$
 select pg_temp.commit_memo_governance('seal_finalize','44444444444444444444444444444444',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000001'),
  '{}'::jsonb,'boot-tier1-seal-0001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','B')
$test$,'tier below 20 full maintainer seals after a clear ended window');
select ok((select resolution.state='sealed' and case_item.stage='sealed'
 and receipt.event_type='RECORD_SEALED' and receipt.decision_channel='maintainer_bootstrap'
 and receipt.actor_role='maintainer' and receipt.proof_type='solana_memo'
 from public.case_resolutions as resolution
 join public.cases as case_item on case_item.id=resolution.case_id
 join public.event_receipts as receipt on receipt.id=resolution.seal_receipt_id
 where resolution.case_id='40000000-0000-4000-8000-000000000001'),
 'bootstrap seal is honestly labeled and atomically seals resolution and Case');

-- A blocking admissible challenge still pauses the bootstrap seal.
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '40000000-0000-4000-8000-000000000005','OSI-BBBBDDDD0005','Blocking challenge fixture','other',
 'Public summary for the blocking challenge fixture.','Restricted fixture five.',
 '11111111111111111111111111111126','open_public','public','standard','[]'::jsonb
);
select pg_temp.add_published_report(
 '40000000-0000-4000-8000-000000000005','41000000-0000-4000-8000-000000000005',
 '42000000-0000-4000-8000-000000000005','OSI-RPT-BBBBDDDD0005','OSI-RV-BBBBDDDD00050001',
 '11111111111111111111111111111127');
select lives_ok($test$
 select pg_temp.commit_memo_governance('resolution_finalize','44444444444444444444444444444444',
  'OSI-BBBBDDDD0005',jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00050001'),
  'boot-tier1-finalize-0002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','C')
$test$,'second cold-start selection prepares the blocking challenge scenario');
insert into public.evidence_items (id,kind,ref,is_public,moderation_state,sha256,added_by_wallet)
 values ('43000000-0000-4000-8000-000000000001','wallet','66666666666666666666666666666666',
 true,'approved',repeat('6',64),'11111111111111111111111111111128');
insert into public.case_evidence_links (case_id,evidence_item_id,added_by_wallet)
 values ('40000000-0000-4000-8000-000000000005','43000000-0000-4000-8000-000000000001',
 '11111111111111111111111111111128');
select lives_ok($test$
 select pg_temp.commit_signed_governance('challenge_submit','11111111111111111111111111111128',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000005'),
  jsonb_build_object('reason_code','bootstrap_challenge_fixture','public_safe_summary',
  'This evidence-bound challenge contests the cold-start selected version.',
  'restricted_detail',null,'evidence_item_id','43000000-0000-4000-8000-000000000001'),
  'boot-challenge-submit-0001')
$test$,'any wallet may still challenge a bootstrap-selected resolution');
select lives_ok($test$
 select pg_temp.commit_signed_governance('challenge_admit','44444444444444444444444444444444',
  (select public_ref from public.challenges_v2 where challenger_wallet='11111111111111111111111111111128'),
  '{"decision":"accept","route":"maintainer"}'::jsonb,'boot-challenge-admit-0001',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'maintainer admissibility keeps its unchanged pre-existing route');
set local session_replication_role=replica;
update public.case_resolutions
   set challenge_window_opens_at=statement_timestamp()-interval '8 days',
       challenge_window_ends_at=statement_timestamp()-interval '1 day'
 where case_id='40000000-0000-4000-8000-000000000005';
set local session_replication_role=origin;
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('r',43),'seal_finalize',
  '44444444444444444444444444444444',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000005'),
  '{}'::jsonb,'boot-blocked-seal-0001',repeat('b',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Case is not seal-ready',
 'an admissible open challenge still pauses the bootstrap seal');

-- ---------------------------------------------------------------------------
-- 4. Tier < 20 Report publication through the bootstrap channel.
-- ---------------------------------------------------------------------------
select throws_ok($test$
 select * from public.osi_v2_prepare_report_publication(
  repeat('s',32),'44444444444444444444444444444444',
  (select version_id from pg_temp.cn1_prepare),
  'boot-wallet-only-publication-0001',repeat('c',64))
$test$,'42501','Publication requires an active approving eligible analyst',
 'admin wallet without the maintainer identity gets no publication authority');
select throws_ok($test$
 select * from public.osi_v2_prepare_report_publication(
  repeat('t',32),'55555555555555555555555555555555',
  (select version_id from pg_temp.cn1_prepare),
  'boot-auth-only-publication-0001',repeat('d',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Bootstrap publication requires both maintainer gates',
 'auth-only half maintainer cannot reach the bootstrap publication channel');
create temporary table boot_publication_prepare on commit drop as
select * from public.osi_v2_prepare_report_publication(
  repeat('u',32),'44444444444444444444444444444444',
  (select version_id from pg_temp.cn1_prepare),
  'boot-tier1-publication-0001',repeat('e',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
select ok((select actor_role='maintainer' from pg_temp.boot_publication_prepare),
 'tier below 20 full maintainer prepares the bootstrap publication');
select throws_ok($test$
 select * from public.osi_v2_commit_report_publication(
  (select issued_nonce from pg_temp.boot_publication_prepare),repeat('T',88),
  'OSI2 test REPORT_PUBLISHED bootstrap channel',statement_timestamp(),null)
$test$,'23514','Report publication maintainer binding changed after prepare',
 'the bootstrap publication commit cannot drop the maintainer identity');
select lives_ok($test$
 select * from public.osi_v2_commit_report_publication(
  (select issued_nonce from pg_temp.boot_publication_prepare),repeat('T',88),
  'OSI2 test REPORT_PUBLISHED bootstrap channel',statement_timestamp(),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'tier below 20 full maintainer publishes through the bootstrap channel');
select ok((select version.lifecycle_state='published' and receipt.decision_channel='maintainer_bootstrap'
 and receipt.actor_role='maintainer' and receipt.event_type='REPORT_PUBLISHED'
 and receipt.proof_type='solana_memo' and receipt.server_verified
 from public.case_report_versions as version
 join public.event_receipts as receipt on receipt.id=version.publication_receipt_id
 where version.id=(select version_id from pg_temp.cn1_prepare)),
 'bootstrap publication receipt carries the distinct maintainer_bootstrap channel');
select is((select idempotent_replay from public.osi_v2_commit_report_publication(
  (select issued_nonce from pg_temp.boot_publication_prepare),repeat('T',88),
  'OSI2 test REPORT_PUBLISHED bootstrap channel',
  (select occurred_at from public.event_receipts where tx_sig=repeat('T',88)),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
 true,'exact bootstrap publication retry returns the original receipt idempotently');

-- ---------------------------------------------------------------------------
-- 5. Tier 20-29: one independent analyst must genuinely co-sign.
-- ---------------------------------------------------------------------------
insert into public.analyst_profiles (wallet, status, tier_code, verified, approved, weight_cached) values
 ('22222222222222222222222222222231','probationary_analyst','probationary',true,true,0.60),
 ('22222222222222222222222222222232','probationary_analyst','probationary',true,true,0.60),
 ('22222222222222222222222222222233','probationary_analyst','probationary',true,true,1.40);
select pg_temp.set_filler_analysts(17);
select ok((select tier='maintainer_plus_one' and eligible_analyst_count=20
 from osi_private.osi_v2_bootstrap_tier()),
 'behavioral tier-2 fixture reaches exactly 20 eligible analysts');

insert into public.analyst_profiles (wallet, status, tier_code, verified, approved, weight_cached) values
 ('11111111111111111111111111111142','contributor','none',false,false,0);
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '40000000-0000-4000-8000-000000000006','OSI-BBBBDDDD0006','Tier two fixture','other',
 'Public summary for the tier-two fixture.','Restricted fixture six.',
 '11111111111111111111111111111141','open_public','public','standard','[]'::jsonb
);
select pg_temp.add_published_report(
 '40000000-0000-4000-8000-000000000006','41000000-0000-4000-8000-000000000006',
 '42000000-0000-4000-8000-000000000006','OSI-RPT-BBBBDDDD0006','OSI-RV-BBBBDDDD00060001',
 '11111111111111111111111111111142');
select pg_temp.add_published_report(
 '40000000-0000-4000-8000-000000000006','41000000-0000-4000-8000-000000000007',
 '42000000-0000-4000-8000-000000000007','OSI-RPT-BBBBDDDD0007','OSI-RV-BBBBDDDD00060002',
 '11111111111111111111111111111143');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('v',43),'resolution_finalize',
  '44444444444444444444444444444444','OSI-BBBBDDDD0006',
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00060001'),
  'boot-tier2-unsupported-0001',repeat('f',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Bootstrap selection support requirements are not met',
 'tier 20-29 refuses the maintainer alone without one independent analyst');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222231',
  'OSI-BBBBDDDD0006',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-BBBBDDDD00060001',
  'decision','select','reason_code','tier_two_support','public_rationale',
  'One independent analyst supports the exact candidate version.','private_note',null),
  'boot-tier2-review-0001')
$test$,'one independent analyst casts the tier-2 co-signing selection review');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('w',43),'resolution_finalize',
  '44444444444444444444444444444444',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000006'),
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00060002'),
  'boot-tier2-wrong-version-0001',repeat('0',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Bootstrap selection support requirements are not met',
 'analyst support binds the exact version and never transfers to another candidate');
select lives_ok($test$
 select pg_temp.commit_memo_governance('resolution_finalize','44444444444444444444444444444444',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000006'),
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00060001'),
  'boot-tier2-finalize-0001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','D')
$test$,'tier 20-29 maintainer plus one independent analyst finalizes the exact version');
select ok((select resolution.finalized_by='maintainer_bootstrap'
 and resolution.winning_report_version_id='42000000-0000-4000-8000-000000000006'
 and receipt.decision_channel='maintainer_bootstrap'
 from public.case_resolutions as resolution
 join public.event_receipts as receipt on receipt.id=resolution.final_receipt_id
 where resolution.case_id='40000000-0000-4000-8000-000000000006'),
 'tier-2 bootstrap selection stays honestly labeled');
select is((select status from public.analyst_profiles where wallet='11111111111111111111111111111142'),
 'analyst_candidate','Path B promotes an existing contributor row to analyst_candidate');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('x',43),'resolution_finalize',
  '44444444444444444444444444444444','OSI-RES-AAAABBBBCCCCDDDD','{}'::jsonb,
  'boot-tier2-wallet-only-0001',repeat('a0',32),null)
$test$,'42501','Resolution finalization requires both maintainer gates',
 'tier 20-29 still denies the wallet-only half maintainer');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('y',43),'resolution_finalize',
  '55555555555555555555555555555555','OSI-RES-AAAABBBBCCCCDDDD','{}'::jsonb,
  'boot-tier2-auth-only-0001',repeat('a1',32),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Resolution finalization requires both maintainer gates',
 'tier 20-29 still denies the auth-only half maintainer');

-- The acting maintainer can never also count as the co-signing analyst.
insert into public.analyst_profiles (wallet, status, tier_code, verified, approved, weight_cached) values
 ('44444444444444444444444444444444','probationary_analyst','probationary',true,true,0.60);
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '40000000-0000-4000-8000-000000000007','OSI-BBBBDDDD0007','Maintainer reviewer conflict','other',
 'Public summary for the reviewer-conflict fixture.','Restricted fixture seven.',
 '11111111111111111111111111111144','open_public','public','standard','[]'::jsonb
);
select pg_temp.add_published_report(
 '40000000-0000-4000-8000-000000000007','41000000-0000-4000-8000-000000000008',
 '42000000-0000-4000-8000-000000000008','OSI-RPT-BBBBDDDD0008','OSI-RV-BBBBDDDD00070001',
 '11111111111111111111111111111145');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','44444444444444444444444444444444',
  'OSI-BBBBDDDD0007',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-BBBBDDDD00070001',
  'decision','select','reason_code','conflict_fixture','public_rationale',
  'The admin wallet review exists only to prove the double-role denial.','private_note',null),
  'boot-conflict-review-0001')
$test$,'admin wallet with an analyst profile casts a counted review fixture');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('z',43),'resolution_finalize',
  '44444444444444444444444444444444',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000007'),
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00070001'),
  'boot-conflict-finalize-0001',repeat('a2',32),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Bootstrap selection support requirements are not met',
 'one person can never appear as both bootstrap maintainer and counted analyst');
update public.analyst_profiles
   set status='revoked', tier_code='none', verified=false, approved=false, weight_cached=0
 where wallet='44444444444444444444444444444444';

-- Tier-2 publication needs one genuine independent approval.
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '40000000-0000-4000-8000-000000000008','OSI-BBBBDDDD0008','Tier two publication fixture','other',
 'Public summary for the tier-two publication fixture.','Restricted fixture eight.',
 '11111111111111111111111111111133','open_public','public','standard','[]'::jsonb
);
create temporary table cn2_prepare on commit drop as
select * from public.osi_v2_prepare_report_version(
  repeat('1',32),'11111111111111111111111111111134','40000000-0000-4000-8000-000000000008',
  'This immutable restricted Report supports the tier-two bootstrap publication scenario with structured uncertainty notes.',
  'A public-safe summary for the tier-two publication fixture.',
  null,
  jsonb_build_array(jsonb_build_object(
    'kind','wallet','ref','11111111111111111111111111111135',
    'sha256',encode(extensions.digest(convert_to('11111111111111111111111111111135','UTF8'),'sha256'),'hex')
  )),
  'boot-native-report-0002',repeat('a3',32)
);
select lives_ok($test$
 select * from public.osi_v2_commit_report_version(
  repeat('1',32),
  'This immutable restricted Report supports the tier-two bootstrap publication scenario with structured uncertainty notes.',
  'A public-safe summary for the tier-two publication fixture.',
  null,
  jsonb_build_array(jsonb_build_object(
    'kind','wallet','ref','11111111111111111111111111111135',
    'sha256',encode(extensions.digest(convert_to('11111111111111111111111111111135','UTF8'),'sha256'),'hex')
  )),
  repeat('U',88),'OSI2 test CASE_REPORT_VERSION_SUBMITTED tier two',statement_timestamp())
$test$,'tier-two native Report version fixture is committed');
select throws_ok($test$
 select * from public.osi_v2_prepare_report_publication(
  repeat('2',32),'44444444444444444444444444444444',
  (select version_id from pg_temp.cn2_prepare),
  'boot-tier2-publication-unsupported-0001',repeat('a4',32),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Bootstrap publication support requirements are not met',
 'tier 20-29 publication refuses the maintainer alone without one approving analyst');
select lives_ok($test$
 create temporary table boot_review_prepare on commit drop as
 select * from public.osi_v2_prepare_report_review(
  repeat('3',32),'22222222222222222222222222222231',
  (select version_id from pg_temp.cn2_prepare),
  'approve','evidence_reviewed',
  'The exact evidence chain was reviewed independently for the tier-two scenario.',null,
  'boot-tier2-review-approve-0001',repeat('a5',32));
 select * from public.osi_v2_commit_report_review(
  repeat('3',32),'approve','evidence_reviewed',
  'The exact evidence chain was reviewed independently for the tier-two scenario.',null,
  repeat('s',88),'OSI2 test CASE_REPORT_REVIEW_CAST tier two')
$test$,'one independent analyst approves the tier-two version');
select lives_ok($test$
 create temporary table boot_publication_prepare_two on commit drop as
 select * from public.osi_v2_prepare_report_publication(
  repeat('4',32),'44444444444444444444444444444444',
  (select version_id from pg_temp.cn2_prepare),
  'boot-tier2-publication-0001',repeat('a6',32),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 select * from public.osi_v2_commit_report_publication(
  (select issued_nonce from pg_temp.boot_publication_prepare_two),repeat('V',88),
  'OSI2 test REPORT_PUBLISHED tier two bootstrap',statement_timestamp(),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'tier 20-29 maintainer plus one approving analyst publishes');
select ok((select receipt.decision_channel='maintainer_bootstrap' and receipt.actor_role='maintainer'
 from public.case_report_versions as version
 join public.event_receipts as receipt on receipt.id=version.publication_receipt_id
 where version.id=(select version_id from pg_temp.cn2_prepare)),
 'tier-2 bootstrap publication receipt keeps the distinct channel');

-- When a real analyst quorum exists the bootstrap channel refuses to act.
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '40000000-0000-4000-8000-000000000009','OSI-BBBBDDDD0009','Quorum available fixture','other',
 'Public summary for the quorum-available fixture.','Restricted fixture nine.',
 '11111111111111111111111111111135','open_public','public','standard','[]'::jsonb
);
create temporary table cn3_prepare on commit drop as
select * from public.osi_v2_prepare_report_version(
  repeat('5',32),'11111111111111111111111111111136','40000000-0000-4000-8000-000000000009',
  'This immutable restricted Report reaches a genuine independent analyst quorum before any bootstrap attempt.',
  'A public-safe summary for the quorum-available fixture.',
  null,
  jsonb_build_array(jsonb_build_object(
    'kind','wallet','ref','11111111111111111111111111111137',
    'sha256',encode(extensions.digest(convert_to('11111111111111111111111111111137','UTF8'),'sha256'),'hex')
  )),
  'boot-native-report-0003',repeat('a7',32)
);
select lives_ok($test$
 select * from public.osi_v2_commit_report_version(
  repeat('5',32),
  'This immutable restricted Report reaches a genuine independent analyst quorum before any bootstrap attempt.',
  'A public-safe summary for the quorum-available fixture.',
  null,
  jsonb_build_array(jsonb_build_object(
    'kind','wallet','ref','11111111111111111111111111111137',
    'sha256',encode(extensions.digest(convert_to('11111111111111111111111111111137','UTF8'),'sha256'),'hex')
  )),
  repeat('W',88),'OSI2 test CASE_REPORT_VERSION_SUBMITTED quorum ready',statement_timestamp())
$test$,'quorum-available native Report version fixture is committed');
select lives_ok($test$
 select * from public.osi_v2_prepare_report_review(
  repeat('6',32),'22222222222222222222222222222231',
  (select version_id from pg_temp.cn3_prepare),
  'approve','evidence_reviewed',
  'First independent approval toward the genuine analyst quorum.',null,
  'boot-quorum-review-0001',repeat('a8',32));
 select * from public.osi_v2_commit_report_review(
  repeat('6',32),'approve','evidence_reviewed',
  'First independent approval toward the genuine analyst quorum.',null,
  repeat('s',88),'OSI2 test CASE_REPORT_REVIEW_CAST quorum one');
 select * from public.osi_v2_prepare_report_review(
  repeat('7',32),'22222222222222222222222222222233',
  (select version_id from pg_temp.cn3_prepare),
  'approve','evidence_reviewed',
  'Second independent approval completes the genuine analyst quorum.',null,
  'boot-quorum-review-0002',repeat('a9',32));
 select * from public.osi_v2_commit_report_review(
  repeat('7',32),'approve','evidence_reviewed',
  'Second independent approval completes the genuine analyst quorum.',null,
  repeat('s',88),'OSI2 test CASE_REPORT_REVIEW_CAST quorum two')
$test$,'two independent analysts reach the real publication quorum');
select throws_ok($test$
 select * from public.osi_v2_prepare_report_publication(
  repeat('8',32),'44444444444444444444444444444444',
  (select version_id from pg_temp.cn3_prepare),
  'boot-quorum-available-publication-0001',repeat('b0',32),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Normal analyst publication quorum is available',
 'the bootstrap channel refuses to replace an available real analyst quorum');

-- ---------------------------------------------------------------------------
-- 6. Tier 30-49: two independent analysts and the reduced weight threshold.
-- ---------------------------------------------------------------------------
select pg_temp.set_filler_analysts(27);
select ok((select tier='maintainer_plus_two' and eligible_analyst_count=30
 from osi_private.osi_v2_bootstrap_tier()),
 'behavioral tier-3 fixture reaches exactly 30 eligible analysts');
insert into public.analyst_profiles (wallet, status, tier_code, verified, approved, weight_cached) values
 ('11111111111111111111111111111147','contributor','none',false,false,0);
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '40000000-0000-4000-8000-000000000010','OSI-BBBBDDDD0010','Tier three fixture','other',
 'Public summary for the tier-three fixture.','Restricted fixture ten.',
 '11111111111111111111111111111146','open_public','public','standard','[]'::jsonb
);
select pg_temp.add_published_report(
 '40000000-0000-4000-8000-000000000010','41000000-0000-4000-8000-000000000010',
 '42000000-0000-4000-8000-000000000010','OSI-RPT-BBBBDDDD0010','OSI-RV-BBBBDDDD00100001',
 '11111111111111111111111111111147');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222231',
  'OSI-BBBBDDDD0010',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-BBBBDDDD00100001',
  'decision','select','reason_code','tier_three_support','public_rationale',
  'First independent analyst supports the tier-three candidate.','private_note',null),
  'boot-tier3-review-0001')
$test$,'first tier-3 independent analyst casts the selection review');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('A',43),'resolution_finalize',
  '44444444444444444444444444444444',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000010'),
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00100001'),
  'boot-tier3-one-analyst-0001',repeat('b1',32),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Bootstrap selection support requirements are not met',
 'tier 30-49 refuses a single analyst co-signer');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222232',
  'OSI-BBBBDDDD0010',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-BBBBDDDD00100001',
  'decision','select','reason_code','tier_three_support','public_rationale',
  'Second independent analyst supports the tier-three candidate.','private_note',null),
  'boot-tier3-review-0002')
$test$,'second tier-3 independent analyst casts the selection review');
update public.osi_config set value='1.50' where key='OSI_V2_BOOTSTRAP_TIER3_MIN_WEIGHT';
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('B',43),'resolution_finalize',
  '44444444444444444444444444444444',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000010'),
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00100001'),
  'boot-tier3-underweight-0001',repeat('b2',32),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Bootstrap selection support requirements are not met',
 'the reduced weight threshold is still a real enforced gate');
update public.osi_config set value='1.00' where key='OSI_V2_BOOTSTRAP_TIER3_MIN_WEIGHT';
select lives_ok($test$
 select pg_temp.commit_memo_governance('resolution_finalize','44444444444444444444444444444444',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000010'),
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00100001'),
  'boot-tier3-finalize-0001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','E')
$test$,'tier 30-49 maintainer plus two analysts at reduced weight finalizes');
select ok((select resolution.finalized_by='maintainer_bootstrap' and receipt.decision_channel='maintainer_bootstrap'
 from public.case_resolutions as resolution
 join public.event_receipts as receipt on receipt.id=resolution.final_receipt_id
 where resolution.case_id='40000000-0000-4000-8000-000000000010'),
 'tier-3 bootstrap selection stays honestly labeled');
select is((select status from public.analyst_profiles where wallet='11111111111111111111111111111147'),
 'analyst_candidate','Path B also promotes the tier-3 winning contributor');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('C',43),'resolution_finalize',
  '44444444444444444444444444444444','OSI-RES-AAAABBBBCCCCDDDD','{}'::jsonb,
  'boot-tier3-wallet-only-0001',repeat('b3',32),null)
$test$,'42501','Resolution finalization requires both maintainer gates',
 'tier 30-49 still denies the wallet-only half maintainer');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('D',43),'resolution_finalize',
  '55555555555555555555555555555555','OSI-RES-AAAABBBBCCCCDDDD','{}'::jsonb,
  'boot-tier3-auth-only-0001',repeat('b4',32),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Resolution finalization requires both maintainer gates',
 'tier 30-49 still denies the auth-only half maintainer');

-- ---------------------------------------------------------------------------
-- 7. Tier 50+: the bootstrap has no remaining effect at all.
-- ---------------------------------------------------------------------------
select pg_temp.set_filler_analysts(47);
select ok((select enabled and active=false and tier='retired' and eligible_analyst_count=50
 from osi_private.osi_v2_bootstrap_tier()),
 'behavioral retirement fixture reaches exactly 50 eligible analysts');
insert into public.cases (
 id,public_ref,title,category,summary_public,details_restricted,
 submitted_by_wallet,stage,visibility,risk_tier,subject_refs
) values (
 '40000000-0000-4000-8000-000000000011','OSI-BBBBDDDD0011','Retired tier fixture','other',
 'Public summary for the retired-tier fixture.','Restricted fixture eleven.',
 '11111111111111111111111111111151','open_public','public','standard','[]'::jsonb
);
select pg_temp.add_published_report(
 '40000000-0000-4000-8000-000000000011','41000000-0000-4000-8000-000000000011',
 '42000000-0000-4000-8000-000000000011','OSI-RPT-BBBBDDDD0011','OSI-RV-BBBBDDDD00110001',
 '11111111111111111111111111111152');
select lives_ok($test$
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222231',
  'OSI-BBBBDDDD0011',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-BBBBDDDD00110001',
  'decision','select','reason_code','retired_fixture','public_rationale',
  'Support below the original quorum must no longer unlock any maintainer path.','private_note',null),
  'boot-retired-review-0001');
 select pg_temp.commit_signed_governance('resolution_review','22222222222222222222222222222232',
  'OSI-BBBBDDDD0011',jsonb_build_object('phase','selection','report_version_ref','OSI-RV-BBBBDDDD00110001',
  'decision','select','reason_code','retired_fixture','public_rationale',
  'A second supporter still stays below the original D5 weight threshold.','private_note',null),
  'boot-retired-review-0002')
$test$,'two analysts support the candidate below the original D5 thresholds');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('E',43),'resolution_finalize',
  '44444444444444444444444444444444',
  (select public_ref from public.case_resolutions where case_id='40000000-0000-4000-8000-000000000011'),
  jsonb_build_object('report_version_ref','OSI-RV-BBBBDDDD00110001'),
  'boot-retired-finalize-0001',repeat('b5',32),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Resolution has no unique server-derived quorum leader',
 'at 50 or more analysts only the original D5 thresholds remain with no substitution');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('F',43),'resolution_finalize',
  '44444444444444444444444444444444','OSI-RES-AAAABBBBCCCCDDDD','{}'::jsonb,
  'boot-retired-wallet-only-0001',repeat('b6',32),null)
$test$,'42501','Resolution finalization requires both maintainer gates',
 'the retired tier still denies the wallet-only half maintainer');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('G',43),'resolution_finalize',
  '55555555555555555555555555555555','OSI-RES-AAAABBBBCCCCDDDD','{}'::jsonb,
  'boot-retired-auth-only-0001',repeat('b7',32),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Resolution finalization requires both maintainer gates',
 'the retired tier still denies the auth-only half maintainer');

-- ---------------------------------------------------------------------------
-- 8. Challenge outcomes and AI Pack approval are provably unreachable.
-- ---------------------------------------------------------------------------
select pg_temp.set_filler_analysts(0);
update public.analyst_profiles
   set status='revoked', tier_code='none', verified=false, approved=false, weight_cached=0
 where wallet in ('22222222222222222222222222222231','22222222222222222222222222222232',
   '22222222222222222222222222222233');
select ok((select eligible_analyst_count=0 and tier='maintainer_only'
 from osi_private.osi_v2_bootstrap_tier()),
 'unreachability checks run with the flag on and zero eligible analysts');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('H',43),'challenge_review',
  '44444444444444444444444444444444',
  (select public_ref from public.challenges_v2 where challenger_wallet='11111111111111111111111111111128'),
  jsonb_build_object('decision','reject','reason_code','maintainer_attempt','public_rationale',
  'The maintainer must never review challenge merits through any channel.','private_note',null),
  'boot-challenge-review-denied-0001',repeat('b8',32),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Challenge review payload or actor is invalid',
 'challenge merit review still requires an eligible analyst at analyst count zero');
select throws_ok($test$
 select * from public.osi_v2_prepare_governance_action(repeat('J',43),'challenge_finalize',
  '44444444444444444444444444444444',
  (select public_ref from public.challenges_v2 where challenger_wallet='11111111111111111111111111111128'),
  '{}'::jsonb,'boot-challenge-finalize-denied-0001',repeat('A',64),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
$test$,'42501','Challenge outcome is not available',
 'challenge accept or reject still requires the full analyst quorum path');
select is((
  select string_agg(ns.nspname || '.' || proc.proname, ',' order by ns.nspname, proc.proname)
    from pg_proc as proc
    join pg_namespace as ns on ns.oid = proc.pronamespace
   where ns.nspname in ('public','osi_private')
     and proc.proname <> 'osi_v2_bootstrap_tier'
     and proc.prosrc like '%osi_v2_bootstrap_tier%'
),
 'osi_private.osi_v2_commit_governance_action,osi_private.osi_v2_commit_report_publication,osi_private.osi_v2_commit_wire_publication,osi_private.osi_v2_prepare_governance_action,osi_private.osi_v2_prepare_report_publication,osi_private.osi_v2_prepare_wire_publication',
 'only accepted D17 outcome functions and its Wire-publication amendment can reach the bootstrap tier');
select throws_ok($test$
 insert into public.event_receipts (
  event_version,event_type,target_type,target_id,actor_wallet,actor_role,
  decision,proof_type,memo_ref,anchor_wallet,payload_hash,nonce,tx_sig,
  server_verified,occurred_at,decision_channel
 ) values (
  'OSI2','CHALLENGE_ACCEPTED','challenge','49000000-0000-4000-8000-000000000001',
  '44444444444444444444444444444444','maintainer','accept','solana_memo',
  'memo fixture','44444444444444444444444444444444',repeat('f',64),
  substr(repeat('zx',32),1,43),repeat('Y',88),true,statement_timestamp(),'maintainer_bootstrap'
 )
$test$,'23514',null,
 'a challenge outcome receipt can never carry the bootstrap channel even by direct write');
select throws_ok($test$
 insert into public.event_receipts (
  event_version,event_type,target_type,target_id,actor_wallet,actor_role,
  decision,proof_type,memo_ref,anchor_wallet,payload_hash,nonce,tx_sig,
  server_verified,occurred_at,decision_channel
 ) values (
  'OSI2','AI_PACK_APPROVED','pack_version','49000000-0000-4000-8000-000000000002',
  '44444444444444444444444444444444','maintainer','approve','solana_memo',
  'memo fixture','44444444444444444444444444444444',repeat('f',64),
  substr(repeat('xz',32),1,43),repeat('X',88),true,statement_timestamp(),'maintainer_bootstrap'
 )
$test$,'23514',null,
 'an AI Pack approval receipt can never carry the bootstrap channel even by direct write');

select is((select value from public.osi_config where key='OSI_V2_WRITES_ENABLED'),'false',
 'broad V2 write flag remains false');
select is((select value from public.osi_config where key='OSI_V2_PROOF_ENABLED'),'false',
 'broad proof flag remains false');

select * from finish();
rollback;
