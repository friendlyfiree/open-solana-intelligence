-- Additive owner-controlled wallet profiles. No legacy rows are imported and
-- the write flag remains fail-closed until the separately reviewed rollout.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_PROFILE_WRITES_ENABLED', 'false', statement_timestamp()),
  ('OSI_V2_PROFILE_AVATAR_ORIGIN', 'https://afibxpniwfnavdobecrn.supabase.co', statement_timestamp());

create or replace function public.osi_v2_expected_proof_type(p_event_type text)
returns text language sql immutable strict set search_path = '' as $$
  select case
    when p_event_type = any (array[
      'CASE_INITIAL_REVIEW_CAST','CASE_INITIAL_REVIEW_REVISED','CASE_WITHDRAWN',
      'CASE_APPEAL_SUBMITTED','CASE_REPORT_REVIEW_CAST','CASE_REPORT_REVIEW_REVISED',
      'WIRE_REPORT_REVIEW_CAST','WIRE_REPORT_REVIEW_REVISED','RESOLUTION_REVIEW_CAST',
      'RESOLUTION_REVIEW_REVISED','CHALLENGE_SUBMITTED','CHALLENGE_ADMISSIBILITY_ACCEPTED',
      'CHALLENGE_ADMISSIBILITY_REJECTED','CHALLENGE_REVIEW_CAST','CHALLENGE_REVIEW_REVISED',
      'CHALLENGE_WITHDRAWN','CHALLENGE_BAD_FAITH_REVIEW_CAST','CHALLENGE_BAD_FAITH_REVIEW_REVISED',
      'AI_PACK_REVIEW_CAST','AI_PACK_REVIEW_REVISED','AI_PACK_OWNER_FEEDBACK_SUBMITTED',
      'ANALYST_APPLICATION_VERSION_SUBMITTED','ANALYST_APPLICATION_REVIEW_CAST',
      'ANALYST_APPLICATION_REVIEW_REVISED','OWNER_STATUS_PROOF','REWARD_PLEDGE_CREATED',
      'REWARD_PLEDGE_REVISED','REWARD_PLEDGE_WITHDRAWN','WALLET_PROFILE_UPDATED'
    ]::text[]) then 'wallet_signed_server_verified'
    when p_event_type = any (array[
      'CASE_SUBMITTED','CASE_OPENED','CASE_SAFETY_BLOCKED','CASE_SAFETY_LIFTED',
      'CASE_INITIAL_REVIEW_REJECTED','CASE_RESUMED','CASE_REPORT_VERSION_SUBMITTED',
      'REPORT_PUBLISHED','REPORT_REJECTED','WIRE_REPORT_VERSION_SUBMITTED',
      'WIRE_REPORT_PUBLISHED','WIRE_PROMOTED','RESOLUTION_PROPOSED','REPORT_SELECTED_WINNING',
      'CHALLENGE_ACCEPTED','CHALLENGE_REJECTED','CHALLENGE_BAD_FAITH_CONFIRMED',
      'CHALLENGE_BAD_FAITH_DISMISSED','CASE_RESOLVED','CASE_REOPENED','RECORD_SEALED',
      'CASE_HALTED','ANALYST_PROBATION','ANALYST_SENIOR','ANALYST_VERIFIED','ANALYST_REVOKED',
      'AI_PACK_APPROVED','AI_PACK_REJECTED','REWARD_PLEDGED','REWARD_PAID','SUPPORT_SENT',
      'REWARD_PAYMENT_CONFIRMED','SUPPORT_PAYMENT_CONFIRMED','CONFIG_CHANGED'
    ]::text[]) then 'solana_memo'
    when p_event_type = any (array[
      'CASE_QUORUM_READY','CHALLENGE_EXPIRED','PACK_SUBMITTED','PACK_ATTACHED',
      'PACK_SUPERSEDED','PACK_STALE','REWARD_ASSIGNED','ANALYST_CANDIDATE'
    ]::text[]) then 'system_event'
    else null
  end
$$;

alter table public.event_receipts drop constraint event_receipts_target_type_check;
alter table public.event_receipts add constraint event_receipts_target_type_check check (target_type in (
  'case','report_version','wire_version','resolution','challenge','pack_version',
  'pack_owner_feedback','analyst','application_version','reward','support','config','profile'
));
alter table public.osi_nonces drop constraint osi_nonces_target_type_check;
alter table public.osi_nonces add constraint osi_nonces_target_type_check check (target_type in (
  'case','report_version','wire_version','resolution','challenge','pack_version',
  'pack_owner_feedback','analyst','application_version','reward','support','config','profile'
));
alter table public.osi_nonces add column profile_target_revision integer
  constraint osi_nonces_profile_target_revision_check check (
    (target_type = 'profile' and profile_target_revision is not null and profile_target_revision >= 0)
    or (target_type <> 'profile' and profile_target_revision is null)
  );

create function osi_private.osi_v2_profile_writes_enabled()
returns boolean language sql stable set search_path = '' as $$
  select value = 'true' from public.osi_config where key = 'OSI_V2_PROFILE_WRITES_ENABLED'
$$;

create function osi_private.osi_v2_profile_ref(p_id uuid)
returns text language sql immutable set search_path = '' as $$
  select 'OSI-PRF-' || upper(substr(replace(p_id::text, '-', ''), 1, 16))
$$;

create function osi_private.osi_v2_profile_avatar_url_valid(p_wallet text, p_url text, p_sha256 text)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(p_url = (
    select rtrim(value, '/') || '/storage/v1/object/public/osi-profile-avatars/'
      || encode(extensions.digest(p_wallet, 'sha256'), 'hex') || '/' || p_sha256
    from public.osi_config where key = 'OSI_V2_PROFILE_AVATAR_ORIGIN'
  ), false)
$$;

create table public.wallet_profiles (
  id uuid primary key,
  public_ref text not null unique check (public_ref ~ '^OSI-PRF-[A-F0-9]{16}$'),
  wallet text not null unique check (char_length(wallet) between 32 and 44 and wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'),
  handle text check (handle is null or handle ~ '^[a-z0-9_]{2,32}$'),
  display_name text check (display_name is null or char_length(display_name) between 2 and 80),
  bio text check (bio is null or char_length(bio) between 1 and 600),
  avatar_url text check (avatar_url is null or avatar_url ~ '^https://'),
  avatar_sha256 text check (avatar_sha256 is null or avatar_sha256 ~ '^[0-9a-f]{64}$'),
  avatar_mime text check (avatar_mime is null or avatar_mime in ('image/png','image/jpeg')),
  avatar_updated_at timestamptz,
  visibility text not null default 'private' check (visibility in ('private','public')),
  attribute_public_cases boolean not null default false,
  revision integer not null check (revision >= 1),
  first_published_at timestamptz,
  last_update_receipt_id uuid not null unique references public.event_receipts(id) on delete restrict,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint wallet_profiles_avatar_consistency check (
    (avatar_url is null and avatar_sha256 is null and avatar_mime is null and avatar_updated_at is null)
    or (avatar_url is not null and avatar_sha256 is not null and avatar_mime is not null and avatar_updated_at is not null
      and osi_private.osi_v2_profile_avatar_url_valid(wallet, avatar_url, avatar_sha256))
  ),
  constraint wallet_profiles_public_identity check (
    visibility <> 'public' or ((handle is not null or display_name is not null) and first_published_at is not null)
  ),
  constraint wallet_profiles_case_attribution check (not attribute_public_cases or visibility = 'public')
);
create unique index wallet_profiles_handle_lower_uidx on public.wallet_profiles(lower(handle)) where handle is not null;
create index wallet_profiles_public_attribution_idx on public.wallet_profiles(visibility, attribute_public_cases) where visibility = 'public';
alter table public.wallet_profiles enable row level security;
alter table public.wallet_profiles force row level security;
revoke all on table public.wallet_profiles from public, anon, authenticated;
grant select, insert, update on table public.wallet_profiles to service_role;

create function osi_private.osi_v2_guard_profile_handle()
returns trigger language plpgsql set search_path = '' as $$
declare normalized text;
begin
  if new.handle is null then return new; end if;
  normalized := lower(new.handle);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osi2-profile-handle:' || normalized, 0));
  if tg_table_name = 'wallet_profiles' and exists (
    select 1 from public.analyst_profiles a where lower(a.handle) = normalized and a.wallet <> new.wallet
  ) then raise exception 'Profile handle is already in use' using errcode = '23505'; end if;
  if tg_table_name = 'analyst_profiles' and exists (
    select 1 from public.wallet_profiles p where lower(p.handle) = normalized and p.wallet <> new.wallet
  ) then raise exception 'Profile handle is already in use' using errcode = '23505'; end if;
  if tg_table_name = 'analyst_profiles' and exists (
    select 1 from public.wallet_profiles p
    where p.wallet = new.wallet and p.first_published_at is not null
      and p.handle is distinct from normalized
  ) then raise exception 'A published wallet profile handle is authoritative' using errcode = '23514'; end if;
  new.handle := normalized;
  return new;
end $$;
create trigger wallet_profiles_handle_guard before insert or update of handle on public.wallet_profiles
for each row execute function osi_private.osi_v2_guard_profile_handle();
create trigger analyst_profiles_wallet_handle_guard before insert or update of handle on public.analyst_profiles
for each row execute function osi_private.osi_v2_guard_profile_handle();

create function osi_private.osi_v2_guard_wallet_profile_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1
       or (new.visibility = 'public') is distinct from (new.first_published_at is not null) then
      raise exception 'Initial profile publication state is invalid' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.wallet <> old.wallet or new.public_ref <> old.public_ref or new.created_at <> old.created_at then
    raise exception 'Wallet profile identity is immutable' using errcode = '23514';
  end if;
  if old.first_published_at is not null and new.handle is distinct from old.handle then
    raise exception 'A published profile handle is immutable' using errcode = '23514';
  end if;
  if old.first_published_at is not null and new.first_published_at is distinct from old.first_published_at then
    raise exception 'Published profile first_published_at is immutable' using errcode = '23514';
  end if;
  if old.first_published_at is null and new.first_published_at is not null and new.visibility <> 'public' then
    raise exception 'First publication requires a public transition' using errcode = '23514';
  end if;
  if new.revision <> old.revision + 1 or new.last_update_receipt_id = old.last_update_receipt_id then
    raise exception 'Wallet profile updates require the next signed revision' using errcode = '23514';
  end if;
  new.updated_at := statement_timestamp();
  return new;
end $$;
create trigger wallet_profiles_update_guard before insert or update on public.wallet_profiles
for each row execute function osi_private.osi_v2_guard_wallet_profile_update();

create function osi_private.osi_v2_issue_profile_nonce(
  p_nonce text, p_purpose text, p_actor_wallet text, p_actor_role text,
  p_payload_hash text, p_idempotency_key text, p_request_fingerprint_hash text
) returns table (
  issued_nonce text, target_id text, public_ref text, profile_id uuid,
  expected_revision integer, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
) language plpgsql security invoker set search_path = '' as $$
declare existing public.osi_nonces%rowtype; profile public.wallet_profiles%rowtype;
  actual_id uuid; expected integer; target text; issued timestamptz := statement_timestamp();
  ttl integer; window_s integer; wallet_max integer; fingerprint_max integer;
begin
  if current_user not in ('postgres','service_role','supabase_admin') then raise exception 'Profile nonce issuance is service-only' using errcode='42501'; end if;
  if osi_private.osi_v2_profile_writes_enabled() is distinct from true then raise exception 'OSI V2 profile writes are disabled' using errcode='55000'; end if;
  if p_purpose <> 'WALLET_PROFILE_UPDATED' or p_actor_role <> 'wallet' then raise exception 'Invalid profile write authority' using errcode='42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osi2-profile-idempotency:' || p_idempotency_key,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osi2-profile-wallet:' || p_actor_wallet,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osi2-profile-fingerprint:' || p_request_fingerprint_hash,0));
  select n.* into existing
    from public.osi_nonces as n
   where n.idempotency_key=p_idempotency_key
   for update;
  if found then
    if existing.purpose<>p_purpose or existing.actor_wallet<>p_actor_wallet or existing.payload_hash<>p_payload_hash or existing.target_type<>'profile' then
      raise exception 'Idempotency key is bound to another exact profile action' using errcode='23514';
    end if;
    actual_id := existing.target_id::uuid;
    expected := existing.profile_target_revision;
    if expected is null then raise exception 'Existing profile nonce has no revision binding' using errcode='23514'; end if;
    return query select existing.nonce, existing.target_id, osi_private.osi_v2_profile_ref(actual_id), actual_id, expected, existing.issued_at, existing.expires_at, existing.consumed_by_receipt_id, true;
    return;
  end if;
  select * into profile from public.wallet_profiles where wallet=p_actor_wallet for update;
  actual_id := coalesce(profile.id, gen_random_uuid()); expected := coalesce(profile.revision,0); target := actual_id::text;
  select value::integer into ttl from public.osi_config where key='OSI_V2_NONCE_TTL_SECONDS' and value ~ '^[0-9]+$';
  select value::integer into window_s from public.osi_config where key='OSI_V2_NONCE_RATE_WINDOW_SECONDS' and value ~ '^[0-9]+$';
  select value::integer into wallet_max from public.osi_config where key='OSI_V2_NONCE_MAX_PER_WALLET' and value ~ '^[0-9]+$';
  select value::integer into fingerprint_max from public.osi_config where key='OSI_V2_NONCE_MAX_PER_FINGERPRINT' and value ~ '^[0-9]+$';
  if ttl not between 30 and 300 or window_s not between 60 and 3600 or wallet_max not between 1 and 100 or fingerprint_max not between 1 and 200 then
    raise exception 'Profile nonce security configuration is absent or invalid' using errcode='55000';
  end if;
  if (select count(*) from public.osi_nonces as n where n.actor_wallet=p_actor_wallet and n.issued_at>issued-pg_catalog.make_interval(secs=>window_s)) >= wallet_max
    or (select count(*) from public.osi_nonces as n where n.request_fingerprint_hash=p_request_fingerprint_hash and n.issued_at>issued-pg_catalog.make_interval(secs=>window_s)) >= fingerprint_max then
    raise exception 'Profile nonce rate limit exceeded' using errcode='P0001';
  end if;
  insert into public.osi_nonces(nonce,purpose,actor_wallet,target_type,target_id,payload_hash,idempotency_key,issued_at,expires_at,request_fingerprint_hash,profile_target_revision)
  values(p_nonce,p_purpose,p_actor_wallet,'profile',target,p_payload_hash,p_idempotency_key,issued,issued+pg_catalog.make_interval(secs=>ttl),p_request_fingerprint_hash,expected);
  return query select p_nonce,target,osi_private.osi_v2_profile_ref(actual_id),actual_id,expected,issued,issued+pg_catalog.make_interval(secs=>ttl),null::uuid,false;
end $$;

create function osi_private.osi_v2_commit_wallet_profile_update(
  p_nonce text, p_payload_hash text, p_signature text, p_handle text, p_display_name text,
  p_bio text, p_visibility text, p_attribute_public_cases boolean, p_avatar_action text,
  p_avatar_url text, p_avatar_sha256 text, p_avatar_mime text
) returns table(profile_id uuid, public_ref text, revision integer, receipt_id uuid, idempotent_replay boolean)
language plpgsql security invoker set search_path = '' as $$
declare bound public.osi_nonces%rowtype; current_profile public.wallet_profiles%rowtype;
  expected integer; actual_id uuid; new_receipt uuid := gen_random_uuid(); next_revision integer;
  final_avatar_url text; final_avatar_hash text; final_avatar_mime text; final_avatar_at timestamptz;
begin
  if current_user not in ('postgres','service_role','supabase_admin') then raise exception 'Profile commit is service-only' using errcode='42501'; end if;
  if osi_private.osi_v2_profile_writes_enabled() is distinct from true then raise exception 'OSI V2 profile writes are disabled' using errcode='55000'; end if;
  select * into bound from public.osi_nonces where nonce=p_nonce for update;
  if bound.nonce is null or bound.purpose<>'WALLET_PROFILE_UPDATED' or bound.target_type<>'profile' or bound.payload_hash<>p_payload_hash then raise exception 'Profile nonce binding is invalid' using errcode='23514'; end if;
  actual_id:=bound.target_id::uuid; expected:=bound.profile_target_revision;
  if expected is null then raise exception 'Profile nonce revision binding is absent' using errcode='23514'; end if;
  if bound.consumed_at is not null then
    if not exists(select 1 from public.event_receipts r where r.id=bound.consumed_by_receipt_id and r.signature=p_signature and r.payload_hash=p_payload_hash) then raise exception 'Consumed profile nonce cannot be replayed with changed proof' using errcode='23514'; end if;
    return query select actual_id,osi_private.osi_v2_profile_ref(actual_id),expected+1,bound.consumed_by_receipt_id,true; return;
  end if;
  if statement_timestamp()>bound.expires_at then raise exception 'Profile nonce expired' using errcode='22023'; end if;
  if p_handle is not null and p_handle !~ '^[a-z0-9_]{2,32}$' then raise exception 'Profile handle is invalid' using errcode='23514'; end if;
  if p_display_name is not null and char_length(p_display_name) not between 2 and 80 then raise exception 'Profile display name is invalid' using errcode='23514'; end if;
  if p_bio is not null and char_length(p_bio) not between 1 and 600 then raise exception 'Profile bio is invalid' using errcode='23514'; end if;
  if p_visibility not in ('private','public') or (p_visibility='public' and p_handle is null and p_display_name is null) or (p_attribute_public_cases and p_visibility<>'public') then raise exception 'Profile visibility is invalid' using errcode='23514'; end if;
  if p_avatar_action not in ('keep','replace','remove') then raise exception 'Profile avatar action is invalid' using errcode='23514'; end if;
  if p_handle is null and exists (
    select 1 from public.analyst_profiles a
    where a.wallet=bound.actor_wallet
      and a.status in ('probationary_analyst','verified_analyst','senior_analyst')
  ) then raise exception 'Active analyst profile requires a handle' using errcode='23514'; end if;
  select * into current_profile from public.wallet_profiles where id=actual_id and wallet=bound.actor_wallet for update;
  if expected=0 and current_profile.id is not null or expected>0 and (current_profile.id is null or current_profile.revision<>expected) then raise exception 'Profile revision changed after nonce issuance' using errcode='40001'; end if;
  if p_avatar_action='keep' then final_avatar_url:=current_profile.avatar_url; final_avatar_hash:=current_profile.avatar_sha256; final_avatar_mime:=current_profile.avatar_mime; final_avatar_at:=current_profile.avatar_updated_at;
  elsif p_avatar_action='remove' then final_avatar_url:=null; final_avatar_hash:=null; final_avatar_mime:=null; final_avatar_at:=null;
  else
    if p_avatar_url is null or p_avatar_url !~ '^https://' or p_avatar_sha256 !~ '^[0-9a-f]{64}$' or p_avatar_mime not in ('image/png','image/jpeg') then raise exception 'Profile avatar binding is invalid' using errcode='23514'; end if;
    final_avatar_url:=p_avatar_url; final_avatar_hash:=p_avatar_sha256; final_avatar_mime:=p_avatar_mime; final_avatar_at:=statement_timestamp();
  end if;
  insert into public.event_receipts(id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,decision,proof_type,payload_hash,nonce,signature,server_verified,occurred_at)
  values(new_receipt,'OSI2','WALLET_PROFILE_UPDATED','profile',bound.target_id,osi_private.osi_v2_profile_ref(actual_id),bound.actor_wallet,'wallet',case when expected=0 then 'create' else 'update' end,'wallet_signed_server_verified',bound.payload_hash,bound.nonce,p_signature,true,statement_timestamp());
  update public.osi_nonces set consumed_at=statement_timestamp(),consumed_by_receipt_id=new_receipt,updated_at=statement_timestamp() where nonce=bound.nonce and consumed_at is null;
  if not found then raise exception 'Profile nonce consumed concurrently' using errcode='40001'; end if;
  next_revision:=expected+1;
  if expected=0 then
    insert into public.wallet_profiles(id,public_ref,wallet,handle,display_name,bio,avatar_url,avatar_sha256,avatar_mime,avatar_updated_at,visibility,attribute_public_cases,revision,first_published_at,last_update_receipt_id)
    values(actual_id,osi_private.osi_v2_profile_ref(actual_id),bound.actor_wallet,p_handle,p_display_name,p_bio,final_avatar_url,final_avatar_hash,final_avatar_mime,final_avatar_at,p_visibility,p_attribute_public_cases,next_revision,case when p_visibility='public' then statement_timestamp() end,new_receipt);
  else
    update public.wallet_profiles set handle=p_handle,display_name=p_display_name,bio=p_bio,avatar_url=final_avatar_url,avatar_sha256=final_avatar_hash,avatar_mime=final_avatar_mime,avatar_updated_at=final_avatar_at,visibility=p_visibility,attribute_public_cases=p_attribute_public_cases,revision=next_revision,first_published_at=coalesce(first_published_at,case when p_visibility='public' then statement_timestamp() end),last_update_receipt_id=new_receipt where id=actual_id;
  end if;
  update public.analyst_profiles set
    handle=p_handle, display_name=p_display_name, bio=p_bio,
    avatar_url=case when expected=0 and p_avatar_action='keep' then avatar_url else final_avatar_url end,
    avatar_sha256=case when expected=0 and p_avatar_action='keep' then avatar_sha256 else final_avatar_hash end,
    avatar_mime=case when expected=0 and p_avatar_action='keep' then avatar_mime else final_avatar_mime end,
    avatar_updated_at=case when expected=0 and p_avatar_action='keep' then avatar_updated_at else final_avatar_at end,
    updated_at=statement_timestamp()
  where wallet=bound.actor_wallet;
  return query select actual_id,osi_private.osi_v2_profile_ref(actual_id),next_revision,new_receipt,false;
end $$;

create function public.osi_v2_issue_profile_nonce(text,text,text,text,text,text,text)
returns table(issued_nonce text,target_id text,public_ref text,profile_id uuid,expected_revision integer,issued_at timestamptz,expires_at timestamptz,consumed_receipt_id uuid,idempotent_replay boolean)
language sql set search_path='' as $$ select * from osi_private.osi_v2_issue_profile_nonce($1,$2,$3,$4,$5,$6,$7) $$;
create function public.osi_v2_commit_wallet_profile_update(text,text,text,text,text,text,text,boolean,text,text,text,text)
returns table(profile_id uuid,public_ref text,revision integer,receipt_id uuid,idempotent_replay boolean)
language sql set search_path='' as $$ select * from osi_private.osi_v2_commit_wallet_profile_update($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) $$;

revoke all on function osi_private.osi_v2_profile_writes_enabled() from public,anon,authenticated;
revoke all on function osi_private.osi_v2_profile_ref(uuid) from public,anon,authenticated;
revoke all on function osi_private.osi_v2_profile_avatar_url_valid(text,text,text) from public,anon,authenticated;
revoke all on function osi_private.osi_v2_guard_profile_handle() from public,anon,authenticated;
revoke all on function osi_private.osi_v2_guard_wallet_profile_update() from public,anon,authenticated;
revoke all on function osi_private.osi_v2_issue_profile_nonce(text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function osi_private.osi_v2_commit_wallet_profile_update(text,text,text,text,text,text,text,boolean,text,text,text,text) from public,anon,authenticated;
revoke all on function public.osi_v2_issue_profile_nonce(text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.osi_v2_commit_wallet_profile_update(text,text,text,text,text,text,text,boolean,text,text,text,text) from public,anon,authenticated;
grant execute on function osi_private.osi_v2_profile_writes_enabled() to service_role;
grant execute on function osi_private.osi_v2_profile_ref(uuid) to service_role;
grant execute on function osi_private.osi_v2_profile_avatar_url_valid(text,text,text) to service_role;
grant execute on function osi_private.osi_v2_guard_profile_handle() to service_role;
grant execute on function osi_private.osi_v2_guard_wallet_profile_update() to service_role;
grant execute on function osi_private.osi_v2_issue_profile_nonce(text,text,text,text,text,text,text) to service_role;
grant execute on function osi_private.osi_v2_commit_wallet_profile_update(text,text,text,text,text,text,text,boolean,text,text,text,text) to service_role;
grant execute on function public.osi_v2_issue_profile_nonce(text,text,text,text,text,text,text) to service_role;
grant execute on function public.osi_v2_commit_wallet_profile_update(text,text,text,text,text,text,text,boolean,text,text,text,text) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('osi-profile-avatars','osi-profile-avatars',true,524288,array['image/png','image/jpeg']);

commit;
