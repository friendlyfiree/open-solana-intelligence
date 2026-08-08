begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

select is((select value from public.osi_config where key='OSI_V2_PROFILE_WRITES_ENABLED'), 'false', 'profile writes fail closed');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.wallet_profiles'::regclass), 'wallet profiles use forced RLS');
select ok(not has_table_privilege('anon','public.wallet_profiles','SELECT') and not has_table_privilege('authenticated','public.wallet_profiles','SELECT'), 'browser roles cannot read the service table');
select ok(not has_table_privilege('anon','public.wallet_profiles','INSERT') and not has_table_privilege('authenticated','public.wallet_profiles','UPDATE'), 'browser roles cannot mutate profiles');
select ok(has_table_privilege('service_role','public.wallet_profiles','SELECT,INSERT,UPDATE'), 'service role has the exact table operations');
select ok(not has_function_privilege('anon','public.osi_v2_issue_profile_nonce(text,text,text,text,text,text,text)','EXECUTE'), 'anon cannot issue profile nonces');
select ok(not has_function_privilege('authenticated','public.osi_v2_commit_wallet_profile_update(text,text,text,text,text,text,text,boolean,text,text,text,text)','EXECUTE'), 'authenticated cannot bypass the gateway commit');
select ok(has_function_privilege('service_role','osi_private.osi_v2_issue_profile_nonce(text,text,text,text,text,text,text)','EXECUTE'), 'service role can reach the private nonce function');
select ok(has_function_privilege('service_role','osi_private.osi_v2_commit_wallet_profile_update(text,text,text,text,text,text,text,boolean,text,text,text,text)','EXECUTE'), 'service role can reach the private commit function');
select is(public.osi_v2_expected_proof_type('WALLET_PROFILE_UPDATED'),'wallet_signed_server_verified','profile event has exact Class-B proof');
select ok(exists(select 1 from storage.buckets where id='osi-profile-avatars' and public and file_size_limit=524288 and allowed_mime_types @> array['image/png','image/jpeg']), 'avatar bucket is public-read with strict upload bounds');
select is((select value from public.osi_config where key='OSI_V2_PROFILE_AVATAR_ORIGIN'),'https://afibxpniwfnavdobecrn.supabase.co','avatar origin is the exact owned project');
select is((select count(*) from pg_policies where schemaname='storage' and tablename='objects' and (qual like '%osi-profile-avatars%' or with_check like '%osi-profile-avatars%')),0::bigint,'no browser storage mutation policy was opened');
select ok((select rolbypassrls from pg_roles where rolname='service_role') and has_table_privilege('service_role','storage.objects','INSERT,UPDATE,DELETE'),'only the trusted service upload path bypasses storage RLS');

update public.osi_config set value='true' where key='OSI_V2_PROFILE_WRITES_ENABLED';
insert into public.analyst_profiles(wallet,handle,display_name,bio,avatar_url,avatar_sha256,avatar_mime,avatar_updated_at,status,tier_code,verified,approved,weight_cached)
values('11111111111111111111111111111111','old_analyst','Old Analyst','Original bio.','https://example.com/analyst-avatar.png',repeat('9',64),'image/png',statement_timestamp(),'contributor','none',false,false,0);

select lives_ok($sql$
  select * from public.osi_v2_issue_profile_nonce(
    'profile_nonce_000000000000000000000000000001','WALLET_PROFILE_UPDATED',
    '11111111111111111111111111111111','wallet',repeat('a',64),
    'profile-idempotency-000000000001',repeat('b',64)
  )
$sql$,'owner profile nonce is issued');
select is((select profile_target_revision from public.osi_nonces where nonce='profile_nonce_000000000000000000000000000001'),0,'new profile nonce separately binds revision zero');

select lives_ok($sql$
  select * from public.osi_v2_commit_wallet_profile_update(
    'profile_nonce_000000000000000000000000000001',repeat('a',64),repeat('c',88),
    'chain_owner','Chain Owner','Public-source researcher.','public',true,
    'keep',null,null,null
  )
$sql$,'signed owner profile revision commits transactionally');
set constraints all immediate;

select is((select revision from public.wallet_profiles where wallet='11111111111111111111111111111111'),1,'first committed profile is revision one');
select ok((select visibility='public' and attribute_public_cases and first_published_at is not null from public.wallet_profiles where wallet='11111111111111111111111111111111'),'public visibility and Case attribution are explicit');
select ok(exists(select 1 from public.event_receipts r join public.wallet_profiles p on p.last_update_receipt_id=r.id where p.wallet='11111111111111111111111111111111' and r.event_type='WALLET_PROFILE_UPDATED' and r.target_type='profile' and r.target_id=p.id::text and r.server_verified),'profile receipt targets the profile UUID, not the revision binding');
select ok((select handle='chain_owner' and display_name='Chain Owner' and bio='Public-source researcher.' and avatar_url='https://example.com/analyst-avatar.png' from public.analyst_profiles where wallet='11111111111111111111111111111111'),'profile identity mirrors while keep preserves an existing analyst avatar');
select ok((select status='contributor' and tier_code='none' and not verified and not approved and weight_cached=0 from public.analyst_profiles where wallet='11111111111111111111111111111111'),'identity mirror cannot change analyst authority');
select throws_ok($sql$
  update public.analyst_profiles set handle='divergent_analyst' where wallet='11111111111111111111111111111111'
$sql$,'23514',null,'analyst identity cannot diverge from an already-published wallet handle');
select is((select idempotent_replay from public.osi_v2_commit_wallet_profile_update(
  'profile_nonce_000000000000000000000000000001',repeat('a',64),repeat('c',88),
  'chain_owner','Chain Owner','Public-source researcher.','public',true,'keep',null,null,null
)),true,'exact retry returns the original result');
select throws_ok($sql$
  select * from public.osi_v2_commit_wallet_profile_update(
    'profile_nonce_000000000000000000000000000001',repeat('a',64),repeat('d',88),
    'chain_owner','Chain Owner','Public-source researcher.','public',true,'keep',null,null,null
  )
$sql$,'23514',null,'changed signature cannot replay a consumed nonce');

select lives_ok($sql$
  select * from public.osi_v2_issue_profile_nonce(
    'profile_nonce_000000000000000000000000000002','WALLET_PROFILE_UPDATED',
    '11111111111111111111111111111111','wallet',repeat('e',64),
    'profile-idempotency-000000000002',repeat('f',64)
  )
$sql$,'a second nonce binds the exact current profile revision');
select is((select profile_target_revision from public.osi_nonces where nonce='profile_nonce_000000000000000000000000000002'),1,'update nonce separately binds the exact current revision');
select throws_ok($sql$
  select * from public.osi_v2_commit_wallet_profile_update(
    'profile_nonce_000000000000000000000000000002',repeat('e',64),repeat('g',88),
    'renamed_owner','Chain Owner','Public-source researcher.','public',true,'keep',null,null,null
  )
$sql$,'23514',null,'a handle cannot change after first publication');
select is((select handle from public.wallet_profiles where wallet='11111111111111111111111111111111'),'chain_owner','failed rename leaves the published handle and revision intact');
select throws_ok($sql$
  update public.wallet_profiles set first_published_at=first_published_at + interval '1 second'
  where wallet='11111111111111111111111111111111'
$sql$,'23514','Published profile first_published_at is immutable','first publication timestamp cannot be cleared or rewritten');

insert into public.analyst_profiles(wallet,handle,display_name,status,tier_code,verified,approved,weight_cached)
values('22222222222222222222222222222222','active_analyst','Active Analyst','probationary_analyst','probationary',true,true,0.50);
select lives_ok($sql$
  select * from public.osi_v2_issue_profile_nonce(
    'profile_nonce_000000000000000000000000000003','WALLET_PROFILE_UPDATED',
    '22222222222222222222222222222222','wallet',repeat('1',64),
    'profile-idempotency-000000000003',repeat('2',64)
  )
$sql$,'active analyst owner can prepare an exact profile update');
select throws_ok($sql$
  select * from public.osi_v2_commit_wallet_profile_update(
    'profile_nonce_000000000000000000000000000003',repeat('1',64),repeat('h',88),
    null,'Active Analyst','Public analyst identity.','public',true,'keep',null,null,null
  )
$sql$,'23514','Active analyst profile requires a handle','active analyst canonical handle cannot be cleared through wallet profile mirroring');

select * from finish();
rollback;
