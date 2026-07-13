-- Native V2 analyst identity, immutable applications, exact-version review,
-- and double-gated probationary activation. Broad V2 write/proof flags remain
-- false. This slice has its own fail-closed rollout flag.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

insert into public.osi_config (key, value, updated_at)
values ('OSI_V2_ANALYST_WRITES_ENABLED', 'true', statement_timestamp())
on conflict (key) do nothing;

create function osi_private.osi_v2_valid_profile_expertise(value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(value) = 'array'
    and jsonb_array_length(value) between 1 and 6
    and not exists (
      select 1
      from jsonb_array_elements_text(value) as item(value)
      where item.value not in (
        'blockchain_forensics', 'scam_analysis', 'exploit_research',
        'data_analysis', 'osint', 'protocol_research'
      )
    )
    and jsonb_array_length(value) = (
      select count(distinct item.value)
      from jsonb_array_elements_text(value) as item(value)
    )
$$;

create function osi_private.osi_v2_valid_profile_links(value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(value) = 'array'
    and jsonb_array_length(value) <= 5
    and not exists (
      select 1
      from jsonb_array_elements(value) as item(value)
      where jsonb_typeof(item.value) <> 'object'
         or coalesce(item.value->>'label', '') !~ '^[A-Za-z0-9 ._/-]{1,40}$'
         or coalesce(item.value->>'url', '') !~ '^https://[^[:space:]@/]+(/[^[:space:]]*)?$'
         or char_length(coalesce(item.value->>'url', '')) > 300
         or (item.value - array['label', 'url']) <> '{}'::jsonb
    )
$$;

alter table public.analyst_profiles
  add column expertise_public jsonb not null default '[]'::jsonb,
  add column links_public jsonb not null default '[]'::jsonb,
  add column avatar_sha256 text,
  add column avatar_mime text,
  add column avatar_updated_at timestamptz,
  add constraint analyst_profiles_expertise_public_check
    check (
      expertise_public = '[]'::jsonb
      or osi_private.osi_v2_valid_profile_expertise(expertise_public)
    ),
  add constraint analyst_profiles_links_public_check
    check (osi_private.osi_v2_valid_profile_links(links_public)),
  add constraint analyst_profiles_avatar_sha256_check
    check (avatar_sha256 is null or avatar_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint analyst_profiles_avatar_mime_check
    check (avatar_mime is null or avatar_mime in ('image/png', 'image/jpeg')),
  add constraint analyst_profiles_avatar_fields_check
    check (
      (avatar_url is null and avatar_sha256 is null and avatar_mime is null and avatar_updated_at is null)
      or (avatar_url is not null and avatar_sha256 is not null and avatar_mime is not null and avatar_updated_at is not null)
    );

-- The base review trigger already models zero as the uncounted path, but the
-- original table check accidentally excluded it. This forward correction is
-- required for the canonical maintainer application-review role.
alter table public.analyst_application_reviews
  drop constraint analyst_application_reviews_weight_check;
alter table public.analyst_application_reviews
  add constraint analyst_application_reviews_weight_check
  check (weight = 0 or weight between 0.50 and 3.00);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'osi-analyst-avatars', 'osi-analyst-avatars', true, 524288,
  array['image/png', 'image/jpeg']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- No storage.objects client policy is added. Browser roles therefore have no
-- INSERT/UPDATE/DELETE path. The Edge gateway validates a wallet signature,
-- image bytes and dimensions, then the service role upserts only the
-- sha256(wallet)/avatar object path.

create function osi_private.osi_v2_analyst_writes_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select value = 'true'
    from public.osi_config
    where key = 'OSI_V2_ANALYST_WRITES_ENABLED'
  ), false)
$$;

create function osi_private.osi_v2_application_ref(p_version_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'OSI-APP-' || upper(substr(replace(p_version_id::text, '-', ''), 1, 12))
$$;

create function osi_private.osi_v2_analyst_ref(p_wallet text)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'OSI-ANL-' || upper(substr(encode(extensions.digest(p_wallet, 'sha256'), 'hex'), 1, 12))
$$;

create function osi_private.osi_v2_issue_analyst_nonce(
  p_nonce text,
  p_purpose text,
  p_actor_wallet text,
  p_actor_role text,
  p_target_id text,
  p_payload_hash text,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text,
  target_id text,
  public_ref text,
  application_id uuid,
  version_no integer,
  issued_at timestamptz,
  expires_at timestamptz,
  consumed_receipt_id uuid,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.osi_nonces%rowtype;
  application_row public.analyst_applications%rowtype;
  version_row public.analyst_application_versions%rowtype;
  profile_row public.analyst_profiles%rowtype;
  actual_target text;
  actual_ref text;
  actual_application_id uuid;
  actual_version_no integer;
  issued_time timestamptz := statement_timestamp();
  ttl_seconds integer;
  window_seconds integer;
  max_per_wallet integer;
  max_per_fingerprint integer;
  wallet_count bigint;
  fingerprint_count bigint;
  has_prior boolean;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Analyst nonce issuance is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_analyst_writes_enabled() is distinct from true then
    raise exception 'OSI V2 analyst writes are disabled' using errcode = '55000';
  end if;
  if p_purpose not in (
    'ANALYST_APPLICATION_VERSION_SUBMITTED',
    'ANALYST_APPLICATION_REVIEW_CAST',
    'ANALYST_APPLICATION_REVIEW_REVISED',
    'ANALYST_PROBATION'
  ) then
    raise exception 'Purpose is outside the analyst activation slice' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-analyst-idempotency:' || p_idempotency_key, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-analyst-wallet:' || p_actor_wallet, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-analyst-fingerprint:' || p_request_fingerprint_hash, 0)
  );

  select n.* into existing
    from public.osi_nonces as n
   where n.idempotency_key = p_idempotency_key
   for update;
  if found then
    if existing.purpose is distinct from p_purpose
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.payload_hash is distinct from p_payload_hash
       or (p_target_id is not null and existing.target_id is distinct from p_target_id) then
      raise exception 'Idempotency key is bound to another exact analyst action'
        using errcode = '23514';
    end if;
    actual_ref := case
      when existing.target_type = 'application_version'
        then osi_private.osi_v2_application_ref(existing.target_id::uuid)
      else osi_private.osi_v2_analyst_ref(existing.target_id)
    end;
    if existing.target_type = 'application_version' then
      select version.application_id, version.version_no
        into actual_application_id, actual_version_no
        from public.analyst_application_versions as version
       where version.id = existing.target_id::uuid;
    end if;
    return query select existing.nonce, existing.target_id, actual_ref,
      actual_application_id, actual_version_no, existing.issued_at,
      existing.expires_at, existing.consumed_by_receipt_id, true;
    return;
  end if;

  if p_purpose = 'ANALYST_APPLICATION_VERSION_SUBMITTED' then
    if p_actor_role <> 'wallet' or nullif(p_target_id, '') is not null then
      raise exception 'Application submission requires a wallet and server target'
        using errcode = '42501';
    end if;
    select application.* into application_row
      from public.analyst_applications as application
     where application.applicant_wallet = p_actor_wallet
       and application.status in ('submitted', 'in_review', 'revision_requested')
     order by application.created_at desc
     limit 1
     for update;
    if application_row.id is not null
       and application_row.status <> 'revision_requested' then
      raise exception 'Current application is already under review' using errcode = '55000';
    end if;
    select profile.* into profile_row
      from public.analyst_profiles as profile
     where profile.wallet = p_actor_wallet;
    if profile_row.status in ('probationary_analyst', 'verified_analyst', 'senior_analyst') then
      raise exception 'An active analyst cannot open a candidate application'
        using errcode = '42501';
    end if;
    actual_target := gen_random_uuid()::text;
    actual_ref := osi_private.osi_v2_application_ref(actual_target::uuid);
    actual_application_id := application_row.id;
    if application_row.id is null then
      actual_version_no := 1;
    else
      select coalesce(max(version.version_no), 0) + 1
        into actual_version_no
        from public.analyst_application_versions as version
       where version.application_id = application_row.id;
    end if;

  elsif p_purpose in ('ANALYST_APPLICATION_REVIEW_CAST', 'ANALYST_APPLICATION_REVIEW_REVISED') then
    if p_actor_role <> 'maintainer' then
      raise exception 'Application operations review requires full maintainer role'
        using errcode = '42501';
    end if;
    begin
      select version.* into version_row
        from public.analyst_application_versions as version
       where version.id = p_target_id::uuid;
    exception when invalid_text_representation then
      raise exception 'Application version target is invalid' using errcode = '22023';
    end;
    select application.* into application_row
      from public.analyst_applications as application
     where application.id = version_row.application_id
       and application.current_version_id = version_row.id
       and application.status = 'in_review';
    if application_row.id is null or application_row.applicant_wallet = p_actor_wallet then
      raise exception 'Application version is not reviewable by this actor'
        using errcode = '42501';
    end if;
    select exists (
      select 1
      from public.analyst_application_reviews as review
      where review.application_version_id = version_row.id
        and review.reviewer_wallet = p_actor_wallet
    ) into has_prior;
    if (has_prior and p_purpose <> 'ANALYST_APPLICATION_REVIEW_REVISED')
       or (not has_prior and p_purpose <> 'ANALYST_APPLICATION_REVIEW_CAST') then
      raise exception 'Application review purpose does not match history'
        using errcode = '23514';
    end if;
    actual_target := version_row.id::text;
    actual_ref := osi_private.osi_v2_application_ref(version_row.id);
    actual_application_id := application_row.id;
    actual_version_no := version_row.version_no;

  else
    if p_actor_role <> 'maintainer' then
      raise exception 'Probation activation requires full maintainer role'
        using errcode = '42501';
    end if;
    select profile.* into profile_row
      from public.analyst_profiles as profile
     where profile.wallet = p_target_id;
    select application.* into application_row
      from public.analyst_applications as application
     where application.applicant_wallet = p_target_id
       and application.status = 'in_review'
       and exists (
         select 1
         from public.analyst_application_reviews as review
         join public.event_receipts as receipt on receipt.id = review.event_receipt_id
         where review.application_version_id = application.current_version_id
           and review.reviewer_wallet = p_actor_wallet
           and review.decision = 'approve'
           and review.weight = 0
           and review.is_active = true
           and receipt.actor_role = 'maintainer'
           and receipt.server_verified = true
       )
     order by application.created_at desc
     limit 1;
    if profile_row.wallet is null or application_row.id is null
       or p_actor_wallet = p_target_id
       or profile_row.status not in ('contributor', 'analyst_candidate') then
      raise exception 'Candidate is not ready for probation activation'
        using errcode = '42501';
    end if;
    actual_target := p_target_id;
    actual_ref := osi_private.osi_v2_analyst_ref(p_target_id);
    actual_application_id := application_row.id;
    select version.version_no into actual_version_no
      from public.analyst_application_versions as version
     where version.id = application_row.current_version_id;
  end if;

  select case when value ~ '^[0-9]+$' then value::integer end into ttl_seconds
    from public.osi_config where key = 'OSI_V2_NONCE_TTL_SECONDS';
  select case when value ~ '^[0-9]+$' then value::integer end into window_seconds
    from public.osi_config where key = 'OSI_V2_NONCE_RATE_WINDOW_SECONDS';
  select case when value ~ '^[0-9]+$' then value::integer end into max_per_wallet
    from public.osi_config where key = 'OSI_V2_NONCE_MAX_PER_WALLET';
  select case when value ~ '^[0-9]+$' then value::integer end into max_per_fingerprint
    from public.osi_config where key = 'OSI_V2_NONCE_MAX_PER_FINGERPRINT';
  if ttl_seconds is null or ttl_seconds not between 30 and 300
     or window_seconds is null or window_seconds not between 60 and 3600
     or max_per_wallet is null or max_per_wallet not between 1 and 100
     or max_per_fingerprint is null or max_per_fingerprint not between 1 and 200 then
    raise exception 'Analyst nonce security configuration is absent or invalid'
      using errcode = '55000';
  end if;

  select count(*) into wallet_count
    from public.osi_nonces as n
   where n.actor_wallet = p_actor_wallet
     and n.issued_at > issued_time - pg_catalog.make_interval(secs => window_seconds);
  select count(*) into fingerprint_count
    from public.osi_nonces as n
   where n.request_fingerprint_hash = p_request_fingerprint_hash
     and n.issued_at > issued_time - pg_catalog.make_interval(secs => window_seconds);
  if wallet_count >= max_per_wallet or fingerprint_count >= max_per_fingerprint then
    raise exception 'Analyst nonce rate limit exceeded' using errcode = 'P0001';
  end if;

  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, issued_at, expires_at
  ) values (
    p_nonce, p_purpose, p_actor_wallet,
    case when p_purpose = 'ANALYST_PROBATION' then 'analyst' else 'application_version' end,
    actual_target, p_payload_hash, p_idempotency_key, p_request_fingerprint_hash,
    issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds)
  );

  return query select p_nonce, actual_target, actual_ref, actual_application_id,
    actual_version_no, issued_time,
    issued_time + pg_catalog.make_interval(secs => ttl_seconds), null::uuid, false;
end
$$;

create function osi_private.osi_v2_commit_analyst_application(
  p_nonce text,
  p_payload_hash text,
  p_signature text,
  p_handle text,
  p_display_name text,
  p_bio text,
  p_expertise_public jsonb,
  p_links_public jsonb,
  p_details_restricted jsonb,
  p_avatar_url text,
  p_avatar_sha256 text,
  p_avatar_mime text
)
returns table (
  application_id uuid,
  application_version_id uuid,
  public_ref text,
  version_no integer,
  status text,
  receipt_id uuid,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound_nonce public.osi_nonces%rowtype;
  existing_receipt public.event_receipts%rowtype;
  application_row public.analyst_applications%rowtype;
  new_application_id uuid;
  new_version_id uuid;
  new_version_no integer;
  new_receipt_id uuid := gen_random_uuid();
  revision_of uuid;
  application_ref text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Application commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_analyst_writes_enabled() is distinct from true then
    raise exception 'OSI V2 analyst writes are disabled' using errcode = '55000';
  end if;
  select n.* into bound_nonce
    from public.osi_nonces as n
   where n.nonce = p_nonce
   for update;
  if bound_nonce.nonce is null
     or bound_nonce.purpose <> 'ANALYST_APPLICATION_VERSION_SUBMITTED'
     or bound_nonce.target_type <> 'application_version'
     or bound_nonce.payload_hash <> p_payload_hash then
    raise exception 'Application nonce binding is invalid' using errcode = '23514';
  end if;
  new_version_id := bound_nonce.target_id::uuid;
  application_ref := osi_private.osi_v2_application_ref(new_version_id);

  if bound_nonce.consumed_at is not null then
    select receipt.* into existing_receipt
      from public.event_receipts as receipt
     where receipt.id = bound_nonce.consumed_by_receipt_id;
    if existing_receipt.signature is distinct from p_signature then
      raise exception 'Consumed application nonce cannot change signature'
        using errcode = '23514';
    end if;
    select version.application_id, version.version_no
      into new_application_id, new_version_no
      from public.analyst_application_versions as version
     where version.event_receipt_id = existing_receipt.id;
    return query select new_application_id, new_version_id, application_ref,
      new_version_no, 'in_review'::text, existing_receipt.id, true;
    return;
  end if;
  if statement_timestamp() > bound_nonce.expires_at then
    raise exception 'Application nonce expired' using errcode = '22023';
  end if;
  if not osi_private.osi_v2_valid_profile_expertise(p_expertise_public)
     or not osi_private.osi_v2_valid_profile_links(p_links_public)
     or jsonb_typeof(p_details_restricted) <> 'object' then
    raise exception 'Application profile payload is invalid' using errcode = '23514';
  end if;

  select application.* into application_row
    from public.analyst_applications as application
   where application.applicant_wallet = bound_nonce.actor_wallet
     and application.status in ('submitted', 'in_review', 'revision_requested')
   order by application.created_at desc
   limit 1
   for update;
  if application_row.id is null then
    new_application_id := gen_random_uuid();
    new_version_no := 1;
  elsif application_row.status = 'revision_requested' then
    new_application_id := application_row.id;
    revision_of := application_row.current_version_id;
    select coalesce(max(version.version_no), 0) + 1 into new_version_no
      from public.analyst_application_versions as version
     where version.application_id = application_row.id;
  else
    raise exception 'Application state changed after nonce issuance' using errcode = '40001';
  end if;

  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, proof_type, payload_hash, nonce,
    signature, server_verified, occurred_at
  ) values (
    new_receipt_id, 'OSI2', 'ANALYST_APPLICATION_VERSION_SUBMITTED',
    'application_version', new_version_id::text, application_ref,
    bound_nonce.actor_wallet, 'wallet',
    case when new_version_no = 1 then 'submit' else 'revise' end,
    'wallet_signed_server_verified', bound_nonce.payload_hash,
    bound_nonce.nonce, p_signature, true, statement_timestamp()
  );

  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(),
         consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound_nonce.nonce and nonce.consumed_at is null;
  if not found then
    raise exception 'Application nonce consumed concurrently' using errcode = '40001';
  end if;

  if application_row.id is null then
    insert into public.analyst_applications (
      id, applicant_wallet, origin, status, current_version_id,
      event_receipt_id, created_at, updated_at
    ) values (
      new_application_id, bound_nonce.actor_wallet, 'path_a_direct',
      'submitted', null, new_receipt_id, statement_timestamp(), statement_timestamp()
    );
  end if;

  insert into public.analyst_application_versions (
    id, application_id, version_no, expertise_public, details_restricted,
    created_by_wallet, supersedes_version_id, revision_reason_code,
    submitted_at, event_receipt_id, created_at
  ) values (
    new_version_id, new_application_id, new_version_no, p_expertise_public,
    p_details_restricted, bound_nonce.actor_wallet, revision_of,
    case when revision_of is null then null else 'maintainer_revision_requested' end,
    statement_timestamp(), new_receipt_id, statement_timestamp()
  );

  update public.analyst_applications as application
     set current_version_id = new_version_id,
         status = 'in_review',
         updated_at = statement_timestamp()
   where application.id = new_application_id;

  insert into public.analyst_profiles (
    wallet, handle, display_name, bio, expertise_public, links_public,
    avatar_url, avatar_sha256, avatar_mime, avatar_updated_at,
    status, tier_code, verified, approved, weight_cached,
    created_at, updated_at
  ) values (
    bound_nonce.actor_wallet, p_handle, p_display_name, p_bio,
    p_expertise_public, p_links_public, p_avatar_url, p_avatar_sha256,
    p_avatar_mime, case when p_avatar_url is null then null else statement_timestamp() end,
    'analyst_candidate', 'none', false, false, 0,
    statement_timestamp(), statement_timestamp()
  ) on conflict (wallet) do update set
    handle = excluded.handle,
    display_name = excluded.display_name,
    bio = excluded.bio,
    expertise_public = excluded.expertise_public,
    links_public = excluded.links_public,
    avatar_url = coalesce(excluded.avatar_url, public.analyst_profiles.avatar_url),
    avatar_sha256 = coalesce(excluded.avatar_sha256, public.analyst_profiles.avatar_sha256),
    avatar_mime = coalesce(excluded.avatar_mime, public.analyst_profiles.avatar_mime),
    avatar_updated_at = case when excluded.avatar_url is null
      then public.analyst_profiles.avatar_updated_at else excluded.avatar_updated_at end,
    status = case when public.analyst_profiles.status = 'contributor'
      then 'analyst_candidate' else public.analyst_profiles.status end,
    updated_at = statement_timestamp();

  return query select new_application_id, new_version_id, application_ref,
    new_version_no, 'in_review'::text, new_receipt_id, false;
end
$$;

-- Extend the canonical exact-review binder for the modeled uncounted
-- maintainer application-review route. Counted analyst reviews are unchanged.
create or replace function public.osi_v2_bind_review_receipt()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_column text := tg_argv[0];
  expected_target_type text := tg_argv[1];
  cast_event text := tg_argv[2];
  revised_event text := tg_argv[3];
  target_value uuid;
  has_history boolean;
  maintainer_review boolean;
  receipt record;
  sql_text text;
begin
  target_value := (to_jsonb(new)->>target_column)::uuid;
  maintainer_review := (
    tg_table_name = 'case_initial_reviews'
    and to_jsonb(new)->>'reviewer_role' = 'maintainer'
  ) or (
    tg_table_name = 'analyst_application_reviews'
    and new.weight = 0
  );

  select event_version, event_type, target_type, target_id, actor_wallet,
         actor_role, decision, weight, reason_code
    into receipt
    from public.event_receipts
   where id = new.event_receipt_id;
  if receipt.event_version is distinct from 'OSI2' then return new; end if;

  sql_text := format(
    'select exists (select 1 from public.%I as prior
      where prior.%I = $1 and prior.reviewer_wallet = $2 and prior.id <> $3',
    tg_table_name, target_column
  );
  if tg_table_name = 'challenge_reviews' then
    sql_text := sql_text || ' and prior.phase = $4)';
    execute sql_text into has_history
      using target_value, new.reviewer_wallet, new.id, new.phase;
  else
    sql_text := sql_text || ')';
    execute sql_text into has_history
      using target_value, new.reviewer_wallet, new.id;
  end if;

  if receipt.target_type is distinct from expected_target_type
     or receipt.target_id is distinct from target_value::text
     or receipt.actor_wallet is distinct from new.reviewer_wallet
     or receipt.decision is distinct from new.decision
     or receipt.reason_code is distinct from new.reason_code
     or (new.weight > 0 and receipt.weight is distinct from new.weight)
     or (new.weight = 0 and receipt.weight is not null) then
    raise exception 'Review receipt is not bound to exact reviewer, target, decision, weight and reason'
      using errcode = '23514';
  end if;
  if maintainer_review and receipt.actor_role is distinct from 'maintainer' then
    raise exception 'Maintainer review requires maintainer receipt role'
      using errcode = '42501';
  end if;
  if not maintainer_review and receipt.actor_role not in ('analyst', 'senior') then
    raise exception 'Counted review receipt requires analyst/senior role'
      using errcode = '42501';
  end if;
  if has_history and receipt.event_type is distinct from revised_event then
    raise exception 'Revised review requires % receipt', revised_event using errcode = '23514';
  end if;
  if not has_history and receipt.event_type is distinct from cast_event then
    raise exception 'First review requires % receipt', cast_event using errcode = '23514';
  end if;
  return new;
end
$$;

create function public.osi_v2_bind_application_version_receipt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.event_receipts as receipt
    where receipt.id = new.event_receipt_id
      and receipt.event_version = 'OSI2'
      and receipt.event_type = 'ANALYST_APPLICATION_VERSION_SUBMITTED'
      and receipt.target_type = 'application_version'
      and receipt.target_id = new.id::text
      and receipt.actor_wallet = new.created_by_wallet
      and receipt.actor_role = 'wallet'
      and receipt.proof_type = 'wallet_signed_server_verified'
      and receipt.server_verified = true
  ) then
    raise exception 'Application version requires its exact signed receipt'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger osi_v2_bind_application_version_receipt
before insert on public.analyst_application_versions
for each row execute function public.osi_v2_bind_application_version_receipt();

revoke all privileges on function public.osi_v2_bind_application_version_receipt()
  from public, anon, authenticated;

create function osi_private.osi_v2_commit_application_review(
  p_nonce text,
  p_payload_hash text,
  p_signature text,
  p_decision text,
  p_reason_code text
)
returns table (
  application_id uuid,
  application_version_id uuid,
  review_id uuid,
  status text,
  receipt_id uuid,
  activation_ready boolean,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound_nonce public.osi_nonces%rowtype;
  existing_receipt public.event_receipts%rowtype;
  version_row public.analyst_application_versions%rowtype;
  application_row public.analyst_applications%rowtype;
  prior public.analyst_application_reviews%rowtype;
  new_receipt_id uuid := gen_random_uuid();
  new_review_id uuid := gen_random_uuid();
  next_status text;
  prior_exists boolean;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Application review commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_analyst_writes_enabled() is distinct from true then
    raise exception 'OSI V2 analyst writes are disabled' using errcode = '55000';
  end if;
  select nonce.* into bound_nonce
    from public.osi_nonces as nonce
   where nonce.nonce = p_nonce
   for update;
  if bound_nonce.nonce is null
     or bound_nonce.purpose not in (
       'ANALYST_APPLICATION_REVIEW_CAST', 'ANALYST_APPLICATION_REVIEW_REVISED'
     )
     or bound_nonce.target_type <> 'application_version'
     or bound_nonce.payload_hash <> p_payload_hash then
    raise exception 'Application review nonce binding is invalid' using errcode = '23514';
  end if;
  if p_decision not in ('approve', 'reject', 'request_revision') then
    raise exception 'Application review decision is invalid' using errcode = '23514';
  end if;

  if bound_nonce.consumed_at is not null then
    select receipt.* into existing_receipt
      from public.event_receipts as receipt
     where receipt.id = bound_nonce.consumed_by_receipt_id;
    if existing_receipt.signature is distinct from p_signature
       or existing_receipt.decision is distinct from p_decision
       or existing_receipt.reason_code is distinct from p_reason_code then
      raise exception 'Consumed review nonce cannot change signed decision'
        using errcode = '23514';
    end if;
    select review.id into new_review_id
      from public.analyst_application_reviews as review
     where review.event_receipt_id = existing_receipt.id;
    select version.application_id into application_row.id
      from public.analyst_application_versions as version
     where version.id = bound_nonce.target_id::uuid;
    next_status := case when p_decision = 'reject' then 'rejected'
      when p_decision = 'request_revision' then 'revision_requested'
      else 'in_review' end;
    return query select application_row.id, bound_nonce.target_id::uuid,
      new_review_id, next_status, existing_receipt.id,
      p_decision = 'approve', true;
    return;
  end if;
  if statement_timestamp() > bound_nonce.expires_at then
    raise exception 'Application review nonce expired' using errcode = '22023';
  end if;

  select version.* into version_row
    from public.analyst_application_versions as version
   where version.id = bound_nonce.target_id::uuid;
  select application.* into application_row
    from public.analyst_applications as application
   where application.id = version_row.application_id
     and application.current_version_id = version_row.id
     and application.status = 'in_review'
   for update;
  if application_row.id is null
     or application_row.applicant_wallet = bound_nonce.actor_wallet then
    raise exception 'Application is not reviewable by this actor' using errcode = '42501';
  end if;

  select review.* into prior
    from public.analyst_application_reviews as review
   where review.application_version_id = version_row.id
     and review.reviewer_wallet = bound_nonce.actor_wallet
     and review.is_active = true
   for update;
  prior_exists := found;
  if (prior_exists and bound_nonce.purpose <> 'ANALYST_APPLICATION_REVIEW_REVISED')
     or (not prior_exists and bound_nonce.purpose <> 'ANALYST_APPLICATION_REVIEW_CAST') then
    raise exception 'Application review history changed after nonce issuance'
      using errcode = '40001';
  end if;

  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, reason_code, proof_type,
    payload_hash, nonce, signature, server_verified, occurred_at
  ) values (
    new_receipt_id, 'OSI2', bound_nonce.purpose, 'application_version',
    version_row.id::text, osi_private.osi_v2_application_ref(version_row.id),
    bound_nonce.actor_wallet, 'maintainer', p_decision, p_reason_code,
    'wallet_signed_server_verified', bound_nonce.payload_hash,
    bound_nonce.nonce, p_signature, true, statement_timestamp()
  );
  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(),
         consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound_nonce.nonce and nonce.consumed_at is null;
  if not found then
    raise exception 'Application review nonce consumed concurrently' using errcode = '40001';
  end if;

  if prior_exists then
    update public.analyst_application_reviews as review
       set is_active = false, superseded_by = new_review_id
     where review.id = prior.id and review.is_active = true;
  end if;
  insert into public.analyst_application_reviews (
    id, application_version_id, reviewer_wallet, decision, weight,
    reason_code, is_active, superseded_by, event_receipt_id,
    created_at, updated_at
  ) values (
    new_review_id, version_row.id, bound_nonce.actor_wallet, p_decision, 0,
    p_reason_code, true, null, new_receipt_id,
    statement_timestamp(), statement_timestamp()
  );

  next_status := case when p_decision = 'reject' then 'rejected'
    when p_decision = 'request_revision' then 'revision_requested'
    else 'in_review' end;
  if next_status <> 'in_review' then
    update public.analyst_applications as application
       set status = next_status, updated_at = statement_timestamp()
     where application.id = application_row.id;
  end if;
  return query select application_row.id, version_row.id, new_review_id,
    next_status, new_receipt_id, p_decision = 'approve', false;
end
$$;

create function osi_private.osi_v2_commit_analyst_probation(
  p_nonce text,
  p_payload_hash text,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz
)
returns table (
  analyst_wallet text,
  application_id uuid,
  status text,
  tier_code text,
  weight numeric,
  receipt_id uuid,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound_nonce public.osi_nonces%rowtype;
  existing_receipt public.event_receipts%rowtype;
  application_row public.analyst_applications%rowtype;
  profile_row public.analyst_profiles%rowtype;
  new_receipt_id uuid := gen_random_uuid();
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Analyst probation commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_analyst_writes_enabled() is distinct from true then
    raise exception 'OSI V2 analyst writes are disabled' using errcode = '55000';
  end if;
  select nonce.* into bound_nonce
    from public.osi_nonces as nonce
   where nonce.nonce = p_nonce
   for update;
  if bound_nonce.nonce is null
     or bound_nonce.purpose <> 'ANALYST_PROBATION'
     or bound_nonce.target_type <> 'analyst'
     or bound_nonce.payload_hash <> p_payload_hash then
    raise exception 'Analyst probation nonce binding is invalid' using errcode = '23514';
  end if;

  if bound_nonce.consumed_at is not null then
    select receipt.* into existing_receipt
      from public.event_receipts as receipt
     where receipt.id = bound_nonce.consumed_by_receipt_id;
    if existing_receipt.tx_sig is distinct from p_tx_sig
       or existing_receipt.memo_ref is distinct from p_memo_ref then
      raise exception 'Consumed probation nonce cannot change transaction proof'
        using errcode = '23514';
    end if;
    select application.* into application_row
      from public.analyst_applications as application
     where application.applicant_wallet = bound_nonce.target_id
       and application.status = 'approved'
     order by application.updated_at desc limit 1;
    return query select bound_nonce.target_id, application_row.id,
      'probationary_analyst'::text, 'probationary'::text, 0.50::numeric,
      existing_receipt.id, true;
    return;
  end if;
  if statement_timestamp() > bound_nonce.expires_at then
    raise exception 'Analyst probation nonce expired' using errcode = '22023';
  end if;

  select profile.* into profile_row
    from public.analyst_profiles as profile
   where profile.wallet = bound_nonce.target_id
   for update;
  select application.* into application_row
    from public.analyst_applications as application
   where application.applicant_wallet = bound_nonce.target_id
     and application.status = 'in_review'
     and exists (
       select 1
       from public.analyst_application_reviews as review
       join public.event_receipts as receipt on receipt.id = review.event_receipt_id
       where review.application_version_id = application.current_version_id
         and review.reviewer_wallet = bound_nonce.actor_wallet
         and review.decision = 'approve'
         and review.weight = 0
         and review.is_active = true
         and receipt.actor_role = 'maintainer'
         and receipt.server_verified = true
     )
   order by application.created_at desc limit 1
   for update;
  if profile_row.wallet is null or application_row.id is null
     or profile_row.status not in ('contributor', 'analyst_candidate')
     or application_row.applicant_wallet = bound_nonce.actor_wallet then
    raise exception 'Probation activation authorization is invalid'
      using errcode = '42501';
  end if;

  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, weight, proof_type, memo_ref,
    anchor_wallet, payload_hash, nonce, tx_sig, server_verified, occurred_at
  ) values (
    new_receipt_id, 'OSI2', 'ANALYST_PROBATION', 'analyst',
    profile_row.wallet, osi_private.osi_v2_analyst_ref(profile_row.wallet),
    bound_nonce.actor_wallet, 'maintainer', 'probation', 0.50,
    'solana_memo', p_memo_ref, bound_nonce.actor_wallet,
    bound_nonce.payload_hash, bound_nonce.nonce, p_tx_sig, true, p_occurred_at
  );
  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(),
         consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound_nonce.nonce and nonce.consumed_at is null;
  if not found then
    raise exception 'Probation nonce consumed concurrently' using errcode = '40001';
  end if;

  update public.analyst_profiles as profile
     set status = 'probationary_analyst',
         tier_code = 'probationary',
         verified = true,
         approved = true,
         weight_cached = 0.50,
         verified_by = bound_nonce.actor_wallet,
         verified_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where profile.wallet = profile_row.wallet;
  update public.analyst_applications as application
     set status = 'approved', updated_at = statement_timestamp()
   where application.id = application_row.id;

  return query select profile_row.wallet, application_row.id,
    'probationary_analyst'::text, 'probationary'::text, 0.50::numeric,
    new_receipt_id, false;
end
$$;

create function public.osi_v2_issue_analyst_nonce(
  p_nonce text, p_purpose text, p_actor_wallet text, p_actor_role text,
  p_target_id text, p_payload_hash text, p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, target_id text, public_ref text, application_id uuid,
  version_no integer, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_issue_analyst_nonce(
    p_nonce, p_purpose, p_actor_wallet, p_actor_role, p_target_id,
    p_payload_hash, p_idempotency_key, p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_commit_analyst_application(
  p_nonce text, p_payload_hash text, p_signature text, p_handle text,
  p_display_name text, p_bio text, p_expertise_public jsonb,
  p_links_public jsonb, p_details_restricted jsonb, p_avatar_url text,
  p_avatar_sha256 text, p_avatar_mime text
)
returns table (
  application_id uuid, application_version_id uuid, public_ref text,
  version_no integer, status text, receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_analyst_application(
    p_nonce, p_payload_hash, p_signature, p_handle, p_display_name, p_bio,
    p_expertise_public, p_links_public, p_details_restricted,
    p_avatar_url, p_avatar_sha256, p_avatar_mime
  )
$$;

create function public.osi_v2_commit_application_review(
  p_nonce text, p_payload_hash text, p_signature text,
  p_decision text, p_reason_code text
)
returns table (
  application_id uuid, application_version_id uuid, review_id uuid,
  status text, receipt_id uuid, activation_ready boolean,
  idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_application_review(
    p_nonce, p_payload_hash, p_signature, p_decision, p_reason_code
  )
$$;

create function public.osi_v2_commit_analyst_probation(
  p_nonce text, p_payload_hash text, p_tx_sig text,
  p_memo_ref text, p_occurred_at timestamptz
)
returns table (
  analyst_wallet text, application_id uuid, status text, tier_code text,
  weight numeric, receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_analyst_probation(
    p_nonce, p_payload_hash, p_tx_sig, p_memo_ref, p_occurred_at
  )
$$;

revoke all privileges on function osi_private.osi_v2_valid_profile_expertise(jsonb)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_valid_profile_links(jsonb)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_analyst_writes_enabled()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_application_ref(uuid)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_analyst_ref(text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_issue_analyst_nonce(
  text, text, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_analyst_application(
  text, text, text, text, text, text, jsonb, jsonb, jsonb, text, text, text
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_application_review(
  text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_analyst_probation(
  text, text, text, text, timestamptz
) from public, anon, authenticated;

revoke all privileges on function public.osi_v2_issue_analyst_nonce(
  text, text, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_analyst_application(
  text, text, text, text, text, text, jsonb, jsonb, jsonb, text, text, text
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_application_review(
  text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_analyst_probation(
  text, text, text, text, timestamptz
) from public, anon, authenticated;

grant execute on function osi_private.osi_v2_analyst_writes_enabled()
  to service_role;
grant execute on function public.osi_v2_issue_analyst_nonce(
  text, text, text, text, text, text, text, text
) to service_role;
grant execute on function public.osi_v2_commit_analyst_application(
  text, text, text, text, text, text, jsonb, jsonb, jsonb, text, text, text
) to service_role;
grant execute on function public.osi_v2_commit_application_review(
  text, text, text, text, text
) to service_role;
grant execute on function public.osi_v2_commit_analyst_probation(
  text, text, text, text, timestamptz
) to service_role;

commit;
