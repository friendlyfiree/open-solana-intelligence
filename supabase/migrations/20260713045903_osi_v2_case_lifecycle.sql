-- OSI V2 Case lifecycle: durable signed reads plus the first native Case
-- intake, initial-review and public-open write path.
--
-- This is an additive, Case-scoped rollout. The broad
-- OSI_V2_WRITES_ENABLED and OSI_V2_PROOF_ENABLED gates remain false. Only
-- trusted service-role RPCs can reach the mutations below, and each RPC also
-- requires the exact fail-closed OSI_V2_CASE_WRITES_ENABLED gate.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Private Case content is kept on the Case header because this first slice has
-- no mutable Case-version model. It is immutable after the anchored submission.
-- Reward intent is explicitly non-custodial and non-binding; no pledge/payment
-- row is created by Case intake.
alter table public.cases
  add column details_restricted text not null default ''
    constraint cases_details_restricted_length_check
    check (char_length(btrim(details_restricted)) between 0 and 12000),
  add column reward_intent_lamports bigint
    constraint cases_reward_intent_lamports_check
    check (reward_intent_lamports is null or reward_intent_lamports between 1 and 1000000000000000),
  add column submission_receipt_id uuid unique
    references public.event_receipts (id) on delete restrict,
  add column opened_receipt_id uuid unique
    references public.event_receipts (id) on delete restrict;

comment on column public.cases.details_restricted is
  'Private intake detail visible only through an authorized server projection; immutable after submission.';
comment on column public.cases.reward_intent_lamports is
  'Optional non-binding display intent only. It is not a pledge, transfer, escrow or payment.';

create index cases_submission_receipt_idx
  on public.cases (submission_receipt_id)
  where submission_receipt_id is not null;
create index cases_opened_receipt_idx
  on public.cases (opened_receipt_id)
  where opened_receipt_id is not null;

create function public.osi_v2_guard_case_lifecycle_receipts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.title is distinct from old.title
     or new.category is distinct from old.category
     or new.summary_public is distinct from old.summary_public
     or new.details_restricted is distinct from old.details_restricted
     or new.reward_intent_lamports is distinct from old.reward_intent_lamports
     or new.submission_receipt_id is distinct from old.submission_receipt_id then
    raise exception 'Submitted Case content and submission receipt are immutable'
      using errcode = '55000';
  end if;

  if old.opened_receipt_id is not null
     and new.opened_receipt_id is distinct from old.opened_receipt_id then
    raise exception 'Case opening receipt is write-once'
      using errcode = '55000';
  end if;

  if old.opened_receipt_id is null
     and new.opened_receipt_id is not null
     and not (
       old.stage = 'initial_review'
       and new.stage = 'open_public'
       and new.visibility = 'public'
     ) then
    raise exception 'Opening receipt may be set only by the public-open transition'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_case_lifecycle_receipts
before update on public.cases
for each row execute function public.osi_v2_guard_case_lifecycle_receipts();

-- A native Solana transaction signature can prove only one native receipt.
create unique index event_receipts_native_tx_sig_uidx
  on public.event_receipts (tx_sig)
  where event_version = 'OSI2' and tx_sig is not null;

-- Read authorization is security infrastructure, not a domain event. A
-- signed read consumes one durable row but intentionally creates no receipt.
create table public.osi_read_nonces (
  nonce text primary key
    constraint osi_read_nonces_nonce_format_check
    check (nonce ~ '^[A-Za-z0-9_-]{32,128}$'),
  purpose text not null
    constraint osi_read_nonces_purpose_check
    check (purpose in (
      'CASE_READ_MY_CASES',
      'CASE_READ_AUTHORIZED_CASE',
      'CASE_READ_REVIEW_QUEUE',
      'CASE_READ_MAINTAINER_OVERVIEW'
    )),
  actor_wallet text not null
    constraint osi_read_nonces_actor_wallet_check
    check (
      char_length(actor_wallet) between 32 and 44
      and actor_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  target_type text not null
    constraint osi_read_nonces_target_type_check
    check (target_type in ('wallet_cases', 'case', 'review_queue', 'config')),
  target_id text not null
    constraint osi_read_nonces_target_id_check
    check (char_length(target_id) between 1 and 256),
  request_fingerprint_hash text not null
    constraint osi_read_nonces_fingerprint_check
    check (request_fingerprint_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint osi_read_nonces_expiry_check
    check (expires_at > issued_at and expires_at <= issued_at + interval '120 seconds'),
  constraint osi_read_nonces_consumed_check
    check (consumed_at is null or (consumed_at >= issued_at and consumed_at <= expires_at))
);

create index osi_read_nonces_wallet_issued_idx
  on public.osi_read_nonces (actor_wallet, issued_at desc);
create index osi_read_nonces_fingerprint_issued_idx
  on public.osi_read_nonces (request_fingerprint_hash, issued_at desc);
create index osi_read_nonces_unconsumed_expiry_idx
  on public.osi_read_nonces (expires_at)
  where consumed_at is null;

alter table public.osi_read_nonces enable row level security;
alter table public.osi_read_nonces force row level security;
revoke all privileges on table public.osi_read_nonces from public, anon, authenticated;
grant select, insert, update on table public.osi_read_nonces to service_role;

create function public.osi_v2_guard_read_nonce_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['consumed_at', 'updated_at'])
       is distinct from
     (to_jsonb(old) - array['consumed_at', 'updated_at']) then
    raise exception 'Read nonce binding and expiry are immutable'
      using errcode = '55000';
  end if;
  if old.consumed_at is not null
     or (old.consumed_at is null and new.consumed_at is null) then
    raise exception 'Read nonce may advance exactly once to consumed'
      using errcode = '55000';
  end if;
  return new;
end
$$;

create trigger osi_v2_guard_read_nonce_update
before update on public.osi_read_nonces
for each row execute function public.osi_v2_guard_read_nonce_update();

create trigger osi_v2_reject_read_nonce_delete
before delete on public.osi_read_nonces
for each row execute function public.osi_v2_reject_delete();

create function osi_private.osi_v2_issue_read_nonce(
  p_nonce text,
  p_purpose text,
  p_actor_wallet text,
  p_target_type text,
  p_target_id text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text,
  issued_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  issued_time timestamptz := statement_timestamp();
  wallet_count bigint;
  fingerprint_count bigint;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Read nonce issuance is service-only' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-read-wallet:' || p_actor_wallet, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-read-fingerprint:' || p_request_fingerprint_hash, 0)
  );

  select count(*) into wallet_count
    from public.osi_read_nonces as n
   where n.actor_wallet = p_actor_wallet
     and n.issued_at > issued_time - interval '5 minutes';
  select count(*) into fingerprint_count
    from public.osi_read_nonces as n
   where n.request_fingerprint_hash = p_request_fingerprint_hash
     and n.issued_at > issued_time - interval '5 minutes';

  if wallet_count >= 20 or fingerprint_count >= 40 then
    raise exception 'Read nonce rate limit exceeded' using errcode = 'P0001';
  end if;

  insert into public.osi_read_nonces (
    nonce, purpose, actor_wallet, target_type, target_id,
    request_fingerprint_hash, issued_at, expires_at
  ) values (
    p_nonce, p_purpose, p_actor_wallet, p_target_type, p_target_id,
    p_request_fingerprint_hash, issued_time, issued_time + interval '120 seconds'
  );

  return query select p_nonce, issued_time, issued_time + interval '120 seconds';
end
$$;

create function osi_private.osi_v2_consume_read_nonce(
  p_nonce text,
  p_purpose text,
  p_actor_wallet text,
  p_target_type text,
  p_target_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Read nonce consumption is service-only' using errcode = '42501';
  end if;

  update public.osi_read_nonces
     set consumed_at = statement_timestamp(),
         updated_at = statement_timestamp()
   where nonce = p_nonce
     and purpose = p_purpose
     and actor_wallet = p_actor_wallet
     and target_type = p_target_type
     and target_id = p_target_id
     and consumed_at is null
     and expires_at >= statement_timestamp();

  return found;
end
$$;

-- Conservative V1 compatibility: an already verified+approved V1 analyst is
-- admitted only as a V2 probationary analyst at the minimum 0.50 weight. This
-- does not confer verified/senior V2 status and does not fabricate an on-chain
-- verification receipt. Ambiguous and inactive rows remain untouched.
do $$
begin
  if pg_catalog.to_regclass('public.analysts') is not null then
    execute $compat$
      insert into public.analyst_profiles (
        wallet, status, tier_code, verified, approved, weight_cached,
        created_at, updated_at
      )
      select
        source.row_data->>'wallet',
        'probationary_analyst',
        'probationary',
        true,
        true,
        0.50,
        statement_timestamp(),
        statement_timestamp()
      from (
        select pg_catalog.to_jsonb(legacy_row) as row_data
        from public.analysts as legacy_row
      ) as source
      where source.row_data->>'verified' = 'true'
        and source.row_data->>'approved' = 'true'
        and source.row_data->>'wallet' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      on conflict (wallet) do nothing
    $compat$;
  end if;
end
$$;

-- Only this Case slice is enabled. Broad native V2 writes and generic proof
-- issuance remain disabled. Absence or any value other than literal true
-- fails closed in every RPC below.
-- Class-A anchor actors are exact: the owner wallet anchors CASE_SUBMITTED;
-- the eligible approving analyst or full double-gated maintainer wallet
-- anchors CASE_OPENED through its own active approve_open review.
insert into public.osi_config (key, value, updated_at)
values ('OSI_V2_CASE_WRITES_ENABLED', 'true', statement_timestamp())
on conflict (key) do nothing;

create function osi_private.osi_v2_case_writes_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select value = 'true'
    from public.osi_config
    where key = 'OSI_V2_CASE_WRITES_ENABLED'
  ), false)
$$;

create function osi_private.osi_v2_case_review_quorum(p_case_id uuid)
returns table (
  analyst_count bigint,
  total_weight numeric,
  maintainer_count bigint,
  analyst_ready boolean,
  maintainer_ready boolean,
  ready boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with qualified as (
    select
      review.reviewer_wallet,
      review.weight,
      review.reviewer_role = 'analyst'
        and profile.status in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
        and profile.verified = true
        and profile.approved = true
        and receipt.actor_role in ('analyst', 'senior')
        as analyst_approval,
      review.reviewer_role = 'maintainer'
        and review.weight = 0
        and receipt.actor_role = 'maintainer'
        as maintainer_approval
    from public.case_initial_reviews as review
    left join public.analyst_profiles as profile
      on profile.wallet = review.reviewer_wallet
    join public.event_receipts as receipt
      on receipt.id = review.event_receipt_id
     and receipt.target_type = 'case'
     and receipt.target_id = review.case_id::text
     and receipt.actor_wallet = review.reviewer_wallet
     and receipt.decision = 'approve_open'
     and receipt.event_type in ('CASE_INITIAL_REVIEW_CAST', 'CASE_INITIAL_REVIEW_REVISED')
     and receipt.proof_type = 'wallet_signed_server_verified'
     and receipt.server_verified = true
    where review.case_id = p_case_id
      and review.is_active = true
      and review.decision = 'approve_open'
  ), totals as (
    select
      count(distinct reviewer_wallet) filter (where analyst_approval) as analyst_count,
      coalesce(sum(weight) filter (where analyst_approval), 0) as total_weight,
      count(distinct reviewer_wallet) filter (where maintainer_approval) as maintainer_count
    from qualified
  )
  select
    analyst_count,
    total_weight,
    maintainer_count,
    analyst_count >= 1 and total_weight >= 0.50,
    maintainer_count >= 1,
    (analyst_count >= 1 and total_weight >= 0.50) or maintainer_count >= 1
  from totals
$$;

create function osi_private.osi_v2_issue_case_nonce(
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
  case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype;
  actual_target_id text;
  actual_public_ref text;
  issued_time timestamptz := statement_timestamp();
  ttl_seconds integer;
  window_seconds integer;
  max_per_wallet integer;
  max_per_fingerprint integer;
  wallet_count bigint;
  fingerprint_count bigint;
  has_prior boolean;
  quorum_row record;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Case nonce issuance is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode = '55000';
  end if;
  if p_purpose not in (
    'CASE_SUBMITTED', 'CASE_INITIAL_REVIEW_CAST',
    'CASE_INITIAL_REVIEW_REVISED', 'CASE_OPENED'
  ) then
    raise exception 'Purpose is outside the Case write slice' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-case-idempotency:' || p_idempotency_key, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-case-wallet:' || p_actor_wallet, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-case-fingerprint:' || p_request_fingerprint_hash, 0)
  );

  select n.* into existing
    from public.osi_nonces as n
   where n.idempotency_key = p_idempotency_key
   for update;

  if found then
    if existing.purpose is distinct from p_purpose
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.payload_hash is distinct from p_payload_hash
       or (
         p_purpose <> 'CASE_SUBMITTED'
         and existing.target_id is distinct from p_target_id
       ) then
      raise exception 'Idempotency key is bound to another exact Case action'
        using errcode = '23514';
    end if;
    actual_public_ref := 'OSI-' || upper(substr(replace(existing.target_id, '-', ''), 1, 12));
    return query select existing.nonce, existing.target_id, actual_public_ref,
      existing.issued_at, existing.expires_at, existing.consumed_by_receipt_id, true;
    return;
  end if;

  if p_purpose = 'CASE_SUBMITTED' then
    if p_actor_role <> 'owner' or nullif(p_target_id, '') is not null then
      raise exception 'Case submission requires owner role and a server-generated target'
        using errcode = '42501';
    end if;
    actual_target_id := gen_random_uuid()::text;
  else
    actual_target_id := p_target_id;
    begin
      select * into case_row from public.cases where id = actual_target_id::uuid;
    exception when invalid_text_representation then
      raise exception 'Case target is invalid' using errcode = '22023';
    end;
    if case_row.id is null or case_row.stage <> 'initial_review' or case_row.visibility <> 'private' then
      raise exception 'Case is not eligible for initial review/open' using errcode = '55000';
    end if;
    if case_row.submitted_by_wallet = p_actor_wallet then
      raise exception 'Case owner cannot review or open the same Case' using errcode = '42501';
    end if;

    if p_actor_role in ('analyst', 'senior') then
      select * into profile from public.analyst_profiles where wallet = p_actor_wallet;
      if profile.wallet is null
         or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
         or profile.verified is not true
         or profile.approved is not true then
        raise exception 'Actor is not an eligible analyst' using errcode = '42501';
      end if;
    elsif p_actor_role = 'maintainer' then
      -- The service-only Edge boundary admits this role only after the
      -- configured admin wallet and maintainer auth UUID both match.
      null;
    else
      raise exception 'Actor role is not eligible for Case review' using errcode = '42501';
    end if;

    if p_purpose in ('CASE_INITIAL_REVIEW_CAST', 'CASE_INITIAL_REVIEW_REVISED') then
      select exists (
        select 1 from public.case_initial_reviews
        where case_id = case_row.id and reviewer_wallet = p_actor_wallet
      ) into has_prior;
      if (has_prior and p_purpose <> 'CASE_INITIAL_REVIEW_REVISED')
         or (not has_prior and p_purpose <> 'CASE_INITIAL_REVIEW_CAST') then
        raise exception 'Review purpose does not match its history' using errcode = '23514';
      end if;
    end if;

    if p_purpose = 'CASE_OPENED' then
      select * into quorum_row
        from osi_private.osi_v2_case_review_quorum(case_row.id);
      if p_actor_role = 'maintainer' then
        if quorum_row.maintainer_ready is distinct from true
           or not exists (
             select 1
             from public.case_initial_reviews as review
             join public.event_receipts as receipt on receipt.id = review.event_receipt_id
             where review.case_id = case_row.id
               and review.reviewer_wallet = p_actor_wallet
               and review.reviewer_role = 'maintainer'
               and review.decision = 'approve_open'
               and review.weight = 0
               and review.is_active = true
               and receipt.actor_wallet = p_actor_wallet
               and receipt.actor_role = 'maintainer'
               and receipt.proof_type = 'wallet_signed_server_verified'
               and receipt.server_verified = true
           ) then
          raise exception 'Case opening is not ready for this full maintainer'
            using errcode = '42501';
        end if;
      elsif quorum_row.analyst_ready is distinct from true
         or not exists (
           select 1 from public.case_initial_reviews
           where case_id = case_row.id
             and reviewer_wallet = p_actor_wallet
             and reviewer_role = 'analyst'
             and decision = 'approve_open'
             and is_active = true
         ) then
        raise exception 'Case opening quorum is not ready for this analyst'
          using errcode = '42501';
      end if;
    end if;
  end if;

  actual_public_ref := 'OSI-' || upper(substr(replace(actual_target_id, '-', ''), 1, 12));

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
    raise exception 'Case nonce security configuration is absent or invalid'
      using errcode = '55000';
  end if;

  select count(*) into wallet_count from public.osi_nonces as n
   where n.actor_wallet = p_actor_wallet
     and n.issued_at > issued_time - pg_catalog.make_interval(secs => window_seconds);
  select count(*) into fingerprint_count from public.osi_nonces as n
   where n.request_fingerprint_hash = p_request_fingerprint_hash
     and n.issued_at > issued_time - pg_catalog.make_interval(secs => window_seconds);
  if wallet_count >= max_per_wallet or fingerprint_count >= max_per_fingerprint then
    raise exception 'Case nonce rate limit exceeded' using errcode = 'P0001';
  end if;

  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, issued_at, expires_at
  ) values (
    p_nonce, p_purpose, p_actor_wallet, 'case', actual_target_id, p_payload_hash,
    p_idempotency_key, p_request_fingerprint_hash, issued_time,
    issued_time + pg_catalog.make_interval(secs => ttl_seconds)
  );

  return query select p_nonce, actual_target_id, actual_public_ref, issued_time,
    issued_time + pg_catalog.make_interval(secs => ttl_seconds), null::uuid, false;
end
$$;

create function osi_private.osi_v2_commit_case_submission(
  p_nonce text,
  p_payload_hash text,
  p_title text,
  p_category text,
  p_summary_public text,
  p_details_restricted text,
  p_reward_intent_lamports bigint,
  p_evidence jsonb,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz
)
returns table (
  public_ref text,
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
  new_receipt_id uuid := gen_random_uuid();
  case_id uuid;
  case_ref text;
  evidence_row jsonb;
  evidence_id uuid;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Case submission commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode = '55000';
  end if;

  select * into bound_nonce from public.osi_nonces where nonce = p_nonce for update;
  if bound_nonce.nonce is null or bound_nonce.purpose <> 'CASE_SUBMITTED'
     or bound_nonce.payload_hash <> p_payload_hash then
    raise exception 'Submission nonce binding is invalid' using errcode = '23514';
  end if;
  case_id := bound_nonce.target_id::uuid;
  case_ref := 'OSI-' || upper(substr(replace(bound_nonce.target_id, '-', ''), 1, 12));

  if bound_nonce.consumed_at is not null then
    select * into existing_receipt from public.event_receipts
     where id = bound_nonce.consumed_by_receipt_id;
    if existing_receipt.tx_sig is distinct from p_tx_sig
       or existing_receipt.memo_ref is distinct from p_memo_ref then
      raise exception 'Consumed submission nonce cannot change transaction proof'
        using errcode = '23514';
    end if;
    return query select case_ref, existing_receipt.id, true;
    return;
  end if;
  if statement_timestamp() > bound_nonce.expires_at then
    raise exception 'Submission nonce expired' using errcode = '22023';
  end if;
  if jsonb_typeof(p_evidence) <> 'array' or jsonb_array_length(p_evidence) > 12 then
    raise exception 'Evidence payload is invalid' using errcode = '23514';
  end if;

  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, proof_type, memo_ref, anchor_wallet,
    payload_hash, nonce, tx_sig, server_verified, occurred_at
  ) values (
    new_receipt_id, 'OSI2', 'CASE_SUBMITTED', 'case', bound_nonce.target_id, case_ref,
    bound_nonce.actor_wallet, 'owner', 'submit', 'solana_memo', p_memo_ref,
    bound_nonce.actor_wallet, bound_nonce.payload_hash, bound_nonce.nonce,
    p_tx_sig, true, p_occurred_at
  );

  update public.osi_nonces
     set consumed_at = statement_timestamp(),
         consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce = bound_nonce.nonce and consumed_at is null;
  if not found then raise exception 'Submission nonce consumed concurrently' using errcode = '40001'; end if;

  insert into public.cases (
    id, public_ref, title, category, summary_public, details_restricted,
    reward_intent_lamports, submitted_by_wallet, stage, visibility,
    subject_refs, submission_receipt_id, created_at, updated_at
  ) values (
    case_id, case_ref, p_title, p_category, p_summary_public, p_details_restricted,
    p_reward_intent_lamports, bound_nonce.actor_wallet, 'initial_review', 'private',
    '[]'::jsonb, new_receipt_id, p_occurred_at, p_occurred_at
  );

  for evidence_row in select value from jsonb_array_elements(p_evidence)
  loop
    evidence_id := gen_random_uuid();
    insert into public.evidence_items (
      id, kind, ref, is_public, moderation_state, sha256,
      added_by_wallet, created_at, updated_at
    ) values (
      evidence_id,
      evidence_row->>'kind',
      evidence_row->>'ref',
      false,
      'pending',
      evidence_row->>'sha256',
      bound_nonce.actor_wallet,
      p_occurred_at,
      p_occurred_at
    );
    insert into public.case_evidence_links (
      case_id, evidence_item_id, added_by_wallet, created_at
    ) values (case_id, evidence_id, bound_nonce.actor_wallet, p_occurred_at);
  end loop;

  return query select case_ref, new_receipt_id, false;
end
$$;

create function osi_private.osi_v2_commit_case_review(
  p_nonce text,
  p_payload_hash text,
  p_signature text,
  p_actor_role text,
  p_decision text,
  p_reason_code text
)
returns table (
  public_ref text,
  review_id uuid,
  receipt_id uuid,
  analyst_ready boolean,
  maintainer_ready boolean,
  open_ready boolean,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound_nonce public.osi_nonces%rowtype;
  existing_receipt public.event_receipts%rowtype;
  case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype;
  prior public.case_initial_reviews%rowtype;
  new_receipt_id uuid := gen_random_uuid();
  new_review_id uuid := gen_random_uuid();
  review_role text;
  receipt_role text;
  review_weight numeric;
  quorum_row record;
  prior_exists boolean := false;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Case review commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode = '55000';
  end if;

  select * into bound_nonce from public.osi_nonces where nonce = p_nonce for update;
  if bound_nonce.nonce is null
     or bound_nonce.purpose not in ('CASE_INITIAL_REVIEW_CAST', 'CASE_INITIAL_REVIEW_REVISED')
     or bound_nonce.payload_hash <> p_payload_hash then
    raise exception 'Review nonce binding is invalid' using errcode = '23514';
  end if;

  if bound_nonce.consumed_at is not null then
    select * into existing_receipt from public.event_receipts
     where id = bound_nonce.consumed_by_receipt_id;
    if existing_receipt.signature is distinct from p_signature
       or existing_receipt.decision is distinct from p_decision
       or existing_receipt.reason_code is distinct from p_reason_code
       or existing_receipt.actor_role is distinct from p_actor_role then
      raise exception 'Consumed review nonce cannot change signed decision'
        using errcode = '23514';
    end if;
    select id into new_review_id from public.case_initial_reviews
     where event_receipt_id = existing_receipt.id;
    select * into quorum_row
      from osi_private.osi_v2_case_review_quorum(bound_nonce.target_id::uuid);
    return query select existing_receipt.public_ref, new_review_id,
      existing_receipt.id, quorum_row.analyst_ready,
      quorum_row.maintainer_ready, quorum_row.ready, true;
    return;
  end if;
  if statement_timestamp() > bound_nonce.expires_at then
    raise exception 'Review nonce expired' using errcode = '22023';
  end if;
  if p_decision not in ('approve_open', 'needs_more') then
    raise exception 'Initial rejection outcome is not enabled in this Case slice'
      using errcode = '55000';
  end if;

  select * into case_row from public.cases where id = bound_nonce.target_id::uuid;
  if case_row.id is null or case_row.stage <> 'initial_review' or case_row.visibility <> 'private'
     or case_row.submitted_by_wallet = bound_nonce.actor_wallet then
    raise exception 'Case is not eligible for this reviewer' using errcode = '42501';
  end if;

  if p_actor_role in ('analyst', 'senior') then
    select * into profile from public.analyst_profiles where wallet = bound_nonce.actor_wallet;
    if profile.wallet is null
       or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
       or profile.verified is not true or profile.approved is not true then
      raise exception 'Actor is not an eligible analyst' using errcode = '42501';
    end if;
    review_role := 'analyst';
    receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
    if p_actor_role <> receipt_role then
      raise exception 'Claimed analyst role does not match server profile' using errcode = '42501';
    end if;
    review_weight := profile.weight_cached;
  elsif p_actor_role = 'maintainer' then
    if p_decision <> 'approve_open' then
      raise exception 'Maintainer initial review supports approve_open only'
        using errcode = '42501';
    end if;
    review_role := 'maintainer';
    receipt_role := 'maintainer';
    review_weight := 0;
  else
    raise exception 'Actor role is not eligible for initial review' using errcode = '42501';
  end if;

  select * into prior from public.case_initial_reviews
   where case_id = case_row.id and reviewer_wallet = bound_nonce.actor_wallet and is_active = true
   for update;
  prior_exists := found;
  if (prior_exists and bound_nonce.purpose <> 'CASE_INITIAL_REVIEW_REVISED')
     or (not prior_exists and bound_nonce.purpose <> 'CASE_INITIAL_REVIEW_CAST') then
    raise exception 'Review history changed after nonce issuance' using errcode = '40001';
  end if;

  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, weight, reason_code, proof_type,
    payload_hash, nonce, signature, server_verified, occurred_at
  ) values (
    new_receipt_id, 'OSI2', bound_nonce.purpose, 'case', bound_nonce.target_id,
    case_row.public_ref, bound_nonce.actor_wallet, receipt_role, p_decision,
    case when review_weight = 0 then null else review_weight end,
    p_reason_code, 'wallet_signed_server_verified', bound_nonce.payload_hash,
    bound_nonce.nonce, p_signature, true, statement_timestamp()
  );

  update public.osi_nonces
     set consumed_at = statement_timestamp(),
         consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce = bound_nonce.nonce and consumed_at is null;
  if not found then raise exception 'Review nonce consumed concurrently' using errcode = '40001'; end if;

  if prior_exists then
    update public.case_initial_reviews
       set is_active = false, superseded_by = new_review_id
     where id = prior.id and is_active = true;
  end if;

  insert into public.case_initial_reviews (
    id, case_id, reviewer_wallet, decision, reviewer_role, weight,
    reason_code, is_active, superseded_by, event_receipt_id,
    created_at, updated_at
  ) values (
    new_review_id, case_row.id, bound_nonce.actor_wallet, p_decision,
    review_role, review_weight, p_reason_code, true, null, new_receipt_id,
    statement_timestamp(), statement_timestamp()
  );

  select * into quorum_row from osi_private.osi_v2_case_review_quorum(case_row.id);
  return query select case_row.public_ref, new_review_id, new_receipt_id,
    quorum_row.analyst_ready, quorum_row.maintainer_ready,
    quorum_row.ready, false;
end
$$;

create function osi_private.osi_v2_commit_case_open(
  p_nonce text,
  p_payload_hash text,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz
)
returns table (
  public_ref text,
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
  case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype;
  opening_review public.case_initial_reviews%rowtype;
  quorum_row record;
  new_receipt_id uuid := gen_random_uuid();
  receipt_role text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Case open commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode = '55000';
  end if;

  select * into bound_nonce from public.osi_nonces where nonce = p_nonce for update;
  if bound_nonce.nonce is null or bound_nonce.purpose <> 'CASE_OPENED'
     or bound_nonce.payload_hash <> p_payload_hash then
    raise exception 'Open nonce binding is invalid' using errcode = '23514';
  end if;

  if bound_nonce.consumed_at is not null then
    select * into existing_receipt from public.event_receipts
     where id = bound_nonce.consumed_by_receipt_id;
    if existing_receipt.tx_sig is distinct from p_tx_sig
       or existing_receipt.memo_ref is distinct from p_memo_ref then
      raise exception 'Consumed open nonce cannot change transaction proof'
        using errcode = '23514';
    end if;
    return query select existing_receipt.public_ref, existing_receipt.id, true;
    return;
  end if;
  if statement_timestamp() > bound_nonce.expires_at then
    raise exception 'Open nonce expired' using errcode = '22023';
  end if;

  select * into case_row from public.cases where id = bound_nonce.target_id::uuid for update;
  select * into opening_review from public.case_initial_reviews
   where case_id = case_row.id
     and reviewer_wallet = bound_nonce.actor_wallet
     and decision = 'approve_open'
     and is_active = true;
  select * into quorum_row from osi_private.osi_v2_case_review_quorum(case_row.id);
  if case_row.id is null or case_row.stage <> 'initial_review' or case_row.visibility <> 'private'
     or case_row.submitted_by_wallet = bound_nonce.actor_wallet
     or opening_review.id is null then
    raise exception 'Case opening authorization or quorum is not valid'
      using errcode = '42501';
  end if;
  if opening_review.reviewer_role = 'maintainer' then
    if quorum_row.maintainer_ready is distinct from true then
      raise exception 'Full maintainer opening path is not ready' using errcode = '42501';
    end if;
    receipt_role := 'maintainer';
  elsif opening_review.reviewer_role = 'analyst' then
    select * into profile from public.analyst_profiles where wallet = bound_nonce.actor_wallet;
    if profile.wallet is null
       or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
       or profile.verified is not true or profile.approved is not true
       or quorum_row.analyst_ready is distinct from true then
      raise exception 'Analyst opening path is not ready' using errcode = '42501';
    end if;
    receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  else
    raise exception 'Case opening review role is invalid' using errcode = '42501';
  end if;

  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, proof_type, memo_ref, anchor_wallet,
    payload_hash, nonce, tx_sig, server_verified, occurred_at
  ) values (
    new_receipt_id, 'OSI2', 'CASE_OPENED', 'case', bound_nonce.target_id,
    case_row.public_ref, bound_nonce.actor_wallet, receipt_role, 'open',
    'solana_memo', p_memo_ref, bound_nonce.actor_wallet, bound_nonce.payload_hash,
    bound_nonce.nonce, p_tx_sig, true, p_occurred_at
  );

  update public.osi_nonces
     set consumed_at = statement_timestamp(),
         consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce = bound_nonce.nonce and consumed_at is null;
  if not found then raise exception 'Open nonce consumed concurrently' using errcode = '40001'; end if;

  update public.cases
     set stage = 'open_public', visibility = 'public', opened_receipt_id = new_receipt_id
   where id = case_row.id and stage = 'initial_review' and visibility = 'private';
  if not found then raise exception 'Case open transition changed concurrently' using errcode = '40001'; end if;

  return query select case_row.public_ref, new_receipt_id, false;
end
$$;

-- PostgREST exposes only the configured public API schema. These wrappers are
-- still service-role-only and merely preserve the caller role while entering
-- the non-exposed implementation schema.
create function public.osi_v2_issue_read_nonce(
  p_nonce text, p_purpose text, p_actor_wallet text, p_target_type text,
  p_target_id text, p_request_fingerprint_hash text
)
returns table (issued_nonce text, issued_at timestamptz, expires_at timestamptz)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_issue_read_nonce(
    p_nonce, p_purpose, p_actor_wallet, p_target_type,
    p_target_id, p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_consume_read_nonce(
  p_nonce text, p_purpose text, p_actor_wallet text,
  p_target_type text, p_target_id text
)
returns boolean
language sql security invoker set search_path = ''
as $$
  select osi_private.osi_v2_consume_read_nonce(
    p_nonce, p_purpose, p_actor_wallet, p_target_type, p_target_id
  )
$$;

create function public.osi_v2_issue_case_nonce(
  p_nonce text, p_purpose text, p_actor_wallet text, p_actor_role text,
  p_target_id text, p_payload_hash text, p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, target_id text, public_ref text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_issue_case_nonce(
    p_nonce, p_purpose, p_actor_wallet, p_actor_role, p_target_id,
    p_payload_hash, p_idempotency_key, p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_commit_case_submission(
  p_nonce text, p_payload_hash text, p_title text, p_category text,
  p_summary_public text, p_details_restricted text,
  p_reward_intent_lamports bigint, p_evidence jsonb, p_tx_sig text,
  p_memo_ref text, p_occurred_at timestamptz
)
returns table (public_ref text, receipt_id uuid, idempotent_replay boolean)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_case_submission(
    p_nonce, p_payload_hash, p_title, p_category, p_summary_public,
    p_details_restricted, p_reward_intent_lamports, p_evidence,
    p_tx_sig, p_memo_ref, p_occurred_at
  )
$$;

create function public.osi_v2_commit_case_review(
  p_nonce text, p_payload_hash text, p_signature text, p_actor_role text,
  p_decision text, p_reason_code text
)
returns table (
  public_ref text, review_id uuid, receipt_id uuid,
  analyst_ready boolean, maintainer_ready boolean,
  open_ready boolean, idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_case_review(
    p_nonce, p_payload_hash, p_signature, p_actor_role,
    p_decision, p_reason_code
  )
$$;

create function public.osi_v2_commit_case_open(
  p_nonce text, p_payload_hash text, p_tx_sig text,
  p_memo_ref text, p_occurred_at timestamptz
)
returns table (public_ref text, receipt_id uuid, idempotent_replay boolean)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_case_open(
    p_nonce, p_payload_hash, p_tx_sig, p_memo_ref, p_occurred_at
  )
$$;

revoke all privileges on function osi_private.osi_v2_issue_read_nonce(
  text, text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_consume_read_nonce(
  text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_issue_case_nonce(
  text, text, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_case_submission(
  text, text, text, text, text, text, bigint, jsonb, text, text, timestamptz
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_case_review(
  text, text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_case_open(
  text, text, text, text, timestamptz
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_case_writes_enabled()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_case_review_quorum(uuid)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_issue_read_nonce(
  text, text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_consume_read_nonce(
  text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_issue_case_nonce(
  text, text, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_case_submission(
  text, text, text, text, text, text, bigint, jsonb, text, text, timestamptz
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_case_review(
  text, text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_case_open(
  text, text, text, text, timestamptz
) from public, anon, authenticated;

grant execute on function osi_private.osi_v2_issue_read_nonce(
  text, text, text, text, text, text
) to service_role;
grant execute on function osi_private.osi_v2_consume_read_nonce(
  text, text, text, text, text
) to service_role;
grant execute on function osi_private.osi_v2_issue_case_nonce(
  text, text, text, text, text, text, text, text
) to service_role;
grant execute on function osi_private.osi_v2_commit_case_submission(
  text, text, text, text, text, text, bigint, jsonb, text, text, timestamptz
) to service_role;
grant execute on function osi_private.osi_v2_commit_case_review(
  text, text, text, text, text, text
) to service_role;
grant execute on function osi_private.osi_v2_commit_case_open(
  text, text, text, text, timestamptz
) to service_role;
grant execute on function osi_private.osi_v2_case_writes_enabled()
  to service_role;
grant execute on function osi_private.osi_v2_case_review_quorum(uuid)
  to service_role;
grant execute on function public.osi_v2_issue_read_nonce(
  text, text, text, text, text, text
) to service_role;
grant execute on function public.osi_v2_consume_read_nonce(
  text, text, text, text, text
) to service_role;
grant execute on function public.osi_v2_issue_case_nonce(
  text, text, text, text, text, text, text, text
) to service_role;
grant execute on function public.osi_v2_commit_case_submission(
  text, text, text, text, text, text, bigint, jsonb, text, text, timestamptz
) to service_role;
grant execute on function public.osi_v2_commit_case_review(
  text, text, text, text, text, text
) to service_role;
grant execute on function public.osi_v2_commit_case_open(
  text, text, text, text, timestamptz
) to service_role;

comment on table public.osi_read_nonces is
  'Service-only durable single-use read authorization infrastructure; not a V2 domain entity or Proof Log event.';
comment on function osi_private.osi_v2_issue_case_nonce(
  text, text, text, text, text, text, text, text
) is 'Case-scoped Stage-5 nonce issuance; independent from the disabled broad V2 proof/write gates.';
comment on function osi_private.osi_v2_commit_case_open(
  text, text, text, text, timestamptz
) is 'Atomically consumes a verified CASE_OPENED memo nonce and publishes after either active analyst count+weight quorum or an active full double-gated maintainer approval.';

commit;
