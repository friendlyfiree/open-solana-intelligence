-- OSI V2 Stage-5 nonce issuance and atomic signed-receipt infrastructure.
--
-- This migration does not enable proof issuance or domain writes. It adds the
-- service-only primitives that future action-specific Edge Functions use after
-- recomputing their exact payload hash and verifying the wallet signature.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create schema if not exists osi_private;
revoke all privileges on schema osi_private from public, anon, authenticated;
grant usage on schema osi_private to service_role;

alter table public.osi_nonces
  add column request_fingerprint_hash text not null,
  add constraint osi_nonces_request_fingerprint_hash_check
  check (request_fingerprint_hash ~ '^[0-9a-f]{64}$');

create index osi_nonces_fingerprint_issued_idx
  on public.osi_nonces (request_fingerprint_hash, issued_at desc);

-- Nonce bindings are immutable. The only forward update is the one-time
-- unconsumed -> consumed transition performed in the receipt transaction.
create function public.osi_v2_guard_nonce_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_binding jsonb;
  new_binding jsonb;
begin
  old_binding := to_jsonb(old) - array[
    'consumed_at',
    'consumed_by_receipt_id',
    'updated_at'
  ];
  new_binding := to_jsonb(new) - array[
    'consumed_at',
    'consumed_by_receipt_id',
    'updated_at'
  ];

  if new_binding is distinct from old_binding then
    raise exception 'Nonce purpose, actor, target, payload and expiry are immutable'
      using errcode = '55000';
  end if;

  if old.consumed_at is not null
     and (
       new.consumed_at is distinct from old.consumed_at
       or new.consumed_by_receipt_id
         is distinct from old.consumed_by_receipt_id
     ) then
    raise exception 'Consumed nonce cannot be reused or repointed'
      using errcode = '55000';
  end if;

  if old.consumed_at is null
     and (
       (new.consumed_at is null) <>
       (new.consumed_by_receipt_id is null)
     ) then
    raise exception 'Nonce consumption timestamp and receipt must advance together'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_nonce_update
before update on public.osi_nonces
for each row execute function public.osi_v2_guard_nonce_update();

create function public.osi_v2_issue_nonce(
  p_nonce text,
  p_purpose text,
  p_actor_wallet text,
  p_target_type text,
  p_target_id text,
  p_payload_hash text,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text,
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
  proof_enabled boolean;
  ttl_seconds integer;
  window_seconds integer;
  max_per_wallet integer;
  max_per_fingerprint integer;
  wallet_count bigint;
  fingerprint_count bigint;
  issued_time timestamptz := statement_timestamp();
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Nonce issuance is service-only'
      using errcode = '42501';
  end if;

  select value = 'true'
    into proof_enabled
    from public.osi_config
   where key = 'OSI_V2_PROOF_ENABLED';

  if proof_enabled is distinct from true then
    raise exception 'OSI V2 proof infrastructure is disabled'
      using errcode = '55000';
  end if;

  if public.osi_v2_expected_proof_type(p_purpose)
       is distinct from 'wallet_signed_server_verified' then
    raise exception 'Public nonce issuance accepts class-B purposes only'
      using errcode = '23514';
  end if;

  -- Serialize retries and both rate-limit dimensions before reading counts.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-idempotency:' || p_idempotency_key, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wallet:' || p_actor_wallet, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-fingerprint:' || p_request_fingerprint_hash,
      0
    )
  );

  select *
    into existing
    from public.osi_nonces
   where idempotency_key = p_idempotency_key
   for update;

  if found then
    if existing.purpose is distinct from p_purpose
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.target_type is distinct from p_target_type
       or existing.target_id is distinct from p_target_id
       or existing.payload_hash is distinct from p_payload_hash then
      raise exception 'Idempotency key is already bound to another exact action'
        using errcode = '23514';
    end if;

    return query select
      existing.nonce,
      existing.issued_at,
      existing.expires_at,
      existing.consumed_by_receipt_id,
      true;
    return;
  end if;

  select
    case when value ~ '^[0-9]+$' then value::integer end
    into ttl_seconds
    from public.osi_config
   where key = 'OSI_V2_NONCE_TTL_SECONDS';
  select
    case when value ~ '^[0-9]+$' then value::integer end
    into window_seconds
    from public.osi_config
   where key = 'OSI_V2_NONCE_RATE_WINDOW_SECONDS';
  select
    case when value ~ '^[0-9]+$' then value::integer end
    into max_per_wallet
    from public.osi_config
   where key = 'OSI_V2_NONCE_MAX_PER_WALLET';
  select
    case when value ~ '^[0-9]+$' then value::integer end
    into max_per_fingerprint
    from public.osi_config
   where key = 'OSI_V2_NONCE_MAX_PER_FINGERPRINT';

  if ttl_seconds is null
     or ttl_seconds not between 30 and 300
     or window_seconds is null
     or window_seconds not between 60 and 3600
     or max_per_wallet is null
     or max_per_wallet not between 1 and 100
     or max_per_fingerprint is null
     or max_per_fingerprint not between 1 and 200 then
    raise exception 'Nonce security configuration is absent or invalid'
      using errcode = '55000';
  end if;

  select count(*)
    into wallet_count
    from public.osi_nonces as nonce_row
   where nonce_row.actor_wallet = p_actor_wallet
     and nonce_row.issued_at
       > issued_time - pg_catalog.make_interval(secs => window_seconds);

  if wallet_count >= max_per_wallet then
    raise exception 'Wallet nonce rate limit exceeded'
      using errcode = 'P0001';
  end if;

  select count(*)
    into fingerprint_count
    from public.osi_nonces as nonce_row
   where nonce_row.request_fingerprint_hash = p_request_fingerprint_hash
     and nonce_row.issued_at
       > issued_time - pg_catalog.make_interval(secs => window_seconds);

  if fingerprint_count >= max_per_fingerprint then
    raise exception 'Request nonce rate limit exceeded'
      using errcode = 'P0001';
  end if;

  insert into public.osi_nonces (
    nonce,
    purpose,
    actor_wallet,
    target_type,
    target_id,
    payload_hash,
    idempotency_key,
    request_fingerprint_hash,
    issued_at,
    expires_at
  ) values (
    p_nonce,
    p_purpose,
    p_actor_wallet,
    p_target_type,
    p_target_id,
    p_payload_hash,
    p_idempotency_key,
    p_request_fingerprint_hash,
    issued_time,
    issued_time + pg_catalog.make_interval(secs => ttl_seconds)
  );

  return query select
    p_nonce,
    issued_time,
    issued_time + pg_catalog.make_interval(secs => ttl_seconds),
    null::uuid,
    false;
end
$$;

-- This service-only primitive is intentionally limited to class-B receipts.
-- Future action-specific RPCs call it inside the same transaction as their
-- domain mutation after Edge code has verified the exact canonical signature.
create function osi_private.osi_v2_consume_signed_nonce(
  p_nonce text,
  p_signature text,
  p_actor_role text,
  p_decision text default null,
  p_weight numeric default null,
  p_reason_code text default null,
  p_public_ref text default null
)
returns table (
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
  proof_enabled boolean;
  profile public.analyst_profiles%rowtype;
  expected_actor text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Nonce consumption is service-only'
      using errcode = '42501';
  end if;

  select value = 'true'
    into proof_enabled
    from public.osi_config
   where key = 'OSI_V2_PROOF_ENABLED';
  if proof_enabled is distinct from true then
    raise exception 'OSI V2 proof infrastructure is disabled'
      using errcode = '55000';
  end if;

  select *
    into bound_nonce
    from public.osi_nonces
   where nonce = p_nonce
   for update;

  if not found then
    raise exception 'Unknown nonce'
      using errcode = '22023';
  end if;

  if public.osi_v2_expected_proof_type(bound_nonce.purpose)
       is distinct from 'wallet_signed_server_verified' then
    raise exception 'Signed nonce consumption accepts class-B purposes only'
      using errcode = '23514';
  end if;

  if bound_nonce.consumed_at is not null then
    select *
      into existing_receipt
      from public.event_receipts
     where id = bound_nonce.consumed_by_receipt_id;

    if existing_receipt.id is null
       or existing_receipt.nonce is distinct from p_nonce
       or existing_receipt.signature is distinct from p_signature
       or existing_receipt.actor_role is distinct from p_actor_role
       or existing_receipt.decision is distinct from p_decision
       or existing_receipt.weight is distinct from p_weight
       or existing_receipt.reason_code is distinct from p_reason_code
       or existing_receipt.public_ref is distinct from p_public_ref then
      raise exception 'Consumed nonce cannot be replayed with changed receipt data'
        using errcode = '23514';
    end if;

    return query select existing_receipt.id, true;
    return;
  end if;

  if statement_timestamp() >= bound_nonce.expires_at then
    raise exception 'Nonce expired'
      using errcode = '22023';
  end if;

  if p_actor_role not in ('owner', 'wallet', 'analyst', 'senior') then
    raise exception 'This primitive does not authorize maintainer/service roles'
      using errcode = '42501';
  end if;

  if bound_nonce.purpose like '%_REVIEW_CAST'
     or bound_nonce.purpose like '%_REVIEW_REVISED'
     or bound_nonce.purpose in (
       'CHALLENGE_ADMISSIBILITY_ACCEPTED',
       'CHALLENGE_ADMISSIBILITY_REJECTED'
     ) then
    if p_actor_role not in ('analyst', 'senior') then
      raise exception 'Review/admissibility receipts require an eligible analyst'
        using errcode = '42501';
    end if;
  end if;

  if bound_nonce.purpose in (
    'CASE_WITHDRAWN',
    'CASE_APPEAL_SUBMITTED',
    'OWNER_STATUS_PROOF'
  ) then
    if p_actor_role <> 'owner' or bound_nonce.target_type <> 'case' then
      raise exception 'Case-owner receipt requires the exact Case owner role'
        using errcode = '42501';
    end if;

    select submitted_by_wallet
      into expected_actor
      from public.cases
     where id::text = bound_nonce.target_id;
    if expected_actor is null
       or expected_actor is distinct from bound_nonce.actor_wallet then
      raise exception 'Case-owner receipt actor does not own the exact Case'
        using errcode = '42501';
    end if;
  elsif bound_nonce.purpose = 'CHALLENGE_WITHDRAWN' then
    if p_actor_role <> 'wallet' or bound_nonce.target_type <> 'challenge' then
      raise exception 'Challenge withdrawal requires the challenger wallet'
        using errcode = '42501';
    end if;

    select challenger_wallet
      into expected_actor
      from public.challenges_v2
     where id::text = bound_nonce.target_id;
    if expected_actor is null
       or expected_actor is distinct from bound_nonce.actor_wallet then
      raise exception 'Challenge withdrawal actor is not the challenger'
        using errcode = '42501';
    end if;
  elsif bound_nonce.purpose = 'AI_PACK_OWNER_FEEDBACK_SUBMITTED' then
    raise exception 'AI Pack owner feedback requires its action-specific owner RPC'
      using errcode = '42501';
  end if;

  if p_actor_role in ('analyst', 'senior') then
    select *
      into profile
      from public.analyst_profiles
     where wallet = bound_nonce.actor_wallet;

    if profile.wallet is null
       or profile.status not in (
         'probationary_analyst',
         'verified_analyst',
         'senior_analyst'
       )
       or profile.verified is not true
       or profile.approved is not true
       or (p_actor_role = 'senior' and profile.status <> 'senior_analyst') then
      raise exception 'Actor is not eligible for the claimed analyst role'
        using errcode = '42501';
    end if;

    if p_weight is not null
       and p_weight is distinct from profile.weight_cached then
      raise exception 'Receipt weight must equal the server-derived snapshot'
        using errcode = '23514';
    end if;
  elsif p_weight is not null then
    raise exception 'Non-analyst receipt cannot carry voting weight'
      using errcode = '23514';
  end if;

  insert into public.event_receipts (
    id,
    event_version,
    event_type,
    target_type,
    target_id,
    public_ref,
    actor_wallet,
    actor_role,
    decision,
    weight,
    reason_code,
    proof_type,
    payload_hash,
    nonce,
    signature,
    server_verified,
    occurred_at
  ) values (
    new_receipt_id,
    'OSI2',
    bound_nonce.purpose,
    bound_nonce.target_type,
    bound_nonce.target_id,
    p_public_ref,
    bound_nonce.actor_wallet,
    p_actor_role,
    p_decision,
    p_weight,
    p_reason_code,
    'wallet_signed_server_verified',
    bound_nonce.payload_hash,
    bound_nonce.nonce,
    p_signature,
    true,
    statement_timestamp()
  );

  update public.osi_nonces
     set consumed_at = statement_timestamp(),
         consumed_by_receipt_id = new_receipt_id
   where nonce = bound_nonce.nonce
     and consumed_at is null;

  if not found then
    raise exception 'Nonce was consumed concurrently'
      using errcode = '40001';
  end if;

  return query select new_receipt_id, false;
end
$$;

revoke all privileges on function public.osi_v2_issue_nonce(
  text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.osi_v2_issue_nonce(
  text, text, text, text, text, text, text, text
) to service_role;

revoke all privileges on function osi_private.osi_v2_consume_signed_nonce(
  text, text, text, text, numeric, text, text
) from public, anon, authenticated;
grant execute on function osi_private.osi_v2_consume_signed_nonce(
  text, text, text, text, numeric, text, text
) to service_role;

insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_PROOF_ENABLED', 'false', now()),
  ('OSI_V2_NONCE_TTL_SECONDS', '120', now()),
  ('OSI_V2_NONCE_RATE_WINDOW_SECONDS', '300', now()),
  ('OSI_V2_NONCE_MAX_PER_WALLET', '20', now()),
  ('OSI_V2_NONCE_MAX_PER_FINGERPRINT', '40', now())
on conflict (key) do nothing;

comment on function public.osi_v2_issue_nonce(
  text, text, text, text, text, text, text, text
) is 'Service-only bounded, rate-limited, idempotent Stage-5 nonce issuance.';
comment on function osi_private.osi_v2_consume_signed_nonce(
  text, text, text, text, numeric, text, text
) is 'Service-only atomic class-B nonce consumption and immutable receipt insertion; caller verifies Ed25519 first.';

commit;
