-- OSI V2 — D19 SAS Verified Analyst credential (mandatory review-authority gate).
--
-- Additive, fail-closed slice. It introduces:
--   * config keys for the SAS Credential/Schema/issuer pubkeys and the two D19
--     feature flags (issuance live-capable, enforcement shipped OFF);
--   * two service-only telemetry/state tables (FORCE RLS, service-role only)
--     recording per-wallet last-known credential state and, per counted review
--     event, the verification state that applied at cast time;
--   * bounded, side-effect helper functions the Edge layer calls to record
--     shadow-validation telemetry and issuance/reconciliation outcomes;
--   * a single guarded predicate helper, osi_v2_sas_review_counts(), that
--     returns TRUE unconditionally whenever enforcement is off;
--   * CREATE OR REPLACE of the five live quorum-computation functions with that
--     one predicate added to their count/weight tally queries only.
--
-- SAFETY-CRITICAL INVARIANT: with OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED
-- false (the shipped default), osi_v2_sas_review_counts() short-circuits to TRUE
-- before ever referencing the new tables, so all five quorum functions are
-- behaviorally identical to current main regardless of any wallet's credential
-- state. No production write path or existing counted outcome changes here.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Config: pubkeys (public on-chain addresses, seeded empty until Step 0) and
--    the two D19 flags. All values fail closed: absent/empty pubkeys => issuance
--    is a no-op; enforcement flag ships false.
-- ---------------------------------------------------------------------------
insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_SAS_PROGRAM_ID', '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG', now()),
  ('OSI_V2_SAS_CREDENTIAL_PUBKEY', '', now()),
  ('OSI_V2_SAS_SCHEMA_PUBKEY', '', now()),
  ('OSI_V2_SAS_ISSUER_PUBKEY', '', now()),
  -- Issuance is purely additive and cannot change any counted outcome, so it is
  -- live-capable by default; the code still no-ops when the pubkeys are absent.
  ('OSI_V2_SAS_CREDENTIAL_ISSUANCE_ENABLED', 'true', now()),
  -- Enforcement ships OFF. Turning it on is a separate, prospective-only rollout.
  ('OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED', 'false', now()),
  -- Bounded-timeout and staleness knobs for the live verifier / lazy re-check.
  ('OSI_V2_SAS_VERIFY_TIMEOUT_MS', '2500', now()),
  ('OSI_V2_SAS_STALE_SECONDS', '900', now()),
  -- Public verifier rate limits (unauthenticated endpoint).
  ('OSI_V2_SAS_VERIFY_RATE_WINDOW_SECONDS', '60', now()),
  ('OSI_V2_SAS_VERIFY_MAX_PER_FINGERPRINT', '30', now()),
  ('OSI_V2_SAS_VERIFY_MAX_PER_WALLET', '60', now())
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Per-wallet last-known credential state cache + issuance ledger.
--    This is a cache/index only; SAS on chain is always the authoritative source.
-- ---------------------------------------------------------------------------
create table public.osi_v2_sas_wallet_credentials (
  wallet text primary key
    constraint osi_v2_sas_wallet_credentials_wallet_check
    check (
      char_length(wallet) between 32 and 44
      and wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  verification_state text not null default 'unchecked'
    constraint osi_v2_sas_wallet_credentials_state_check
    check (verification_state in (
      'unchecked', 'pending_verification', 'verified', 'invalid', 'revoked', 'expired'
    )),
  checked_credential text
    constraint osi_v2_sas_wallet_credentials_credential_check
    check (checked_credential is null or char_length(checked_credential) between 32 and 44),
  checked_schema text
    constraint osi_v2_sas_wallet_credentials_schema_check
    check (checked_schema is null or char_length(checked_schema) between 32 and 44),
  checked_issuer text
    constraint osi_v2_sas_wallet_credentials_issuer_check
    check (checked_issuer is null or char_length(checked_issuer) between 32 and 44),
  attestation_pubkey text
    constraint osi_v2_sas_wallet_credentials_attestation_check
    check (attestation_pubkey is null or char_length(attestation_pubkey) between 32 and 44),
  credential_expiry timestamptz,
  issuance_state text not null default 'none'
    constraint osi_v2_sas_wallet_credentials_issuance_state_check
    check (issuance_state in ('none', 'issued', 'revoked', 'failed')),
  issuance_tx_sig text
    constraint osi_v2_sas_wallet_credentials_issuance_sig_check
    check (issuance_tx_sig is null or char_length(issuance_tx_sig) between 32 and 128),
  issued_at timestamptz,
  revoked_at timestamptz,
  last_checked_at timestamptz,
  latency_ms integer
    constraint osi_v2_sas_wallet_credentials_latency_check
    check (latency_ms is null or latency_ms between 0 and 600000),
  last_result text
    constraint osi_v2_sas_wallet_credentials_result_check
    check (last_result is null or char_length(last_result) <= 200),
  last_error text
    constraint osi_v2_sas_wallet_credentials_error_check
    check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index osi_v2_sas_wallet_credentials_state_idx
  on public.osi_v2_sas_wallet_credentials (verification_state);
create index osi_v2_sas_wallet_credentials_checked_idx
  on public.osi_v2_sas_wallet_credentials (last_checked_at);

comment on table public.osi_v2_sas_wallet_credentials is
  'D19 service-only cache/index of the last-known SAS OSI_VERIFIED_ANALYST state per wallet, plus issuance ledger. SAS on chain is authoritative; rows here may be stale. No secrets or PII.';

-- ---------------------------------------------------------------------------
-- 3. Per-review verification snapshot. Typed FK per target (challenges_v2
--    convention) across all six review tables (four live + wire/ai_pack forward-
--    compatible). Records the verification state that applied when the review was
--    cast; a resolved snapshot is immutable (prospective-only invariant).
-- ---------------------------------------------------------------------------
create table public.osi_v2_sas_review_verifications (
  id uuid primary key default gen_random_uuid(),
  review_kind text not null
    constraint osi_v2_sas_review_verifications_kind_check
    check (review_kind in (
      'case_initial', 'case_report', 'resolution', 'challenge', 'wire_report', 'ai_pack'
    )),
  case_initial_review_id uuid
    references public.case_initial_reviews (id) on delete cascade,
  case_report_review_id uuid
    references public.case_report_reviews (id) on delete cascade,
  resolution_review_id uuid
    references public.resolution_reviews (id) on delete cascade,
  challenge_review_id uuid
    references public.challenge_reviews (id) on delete cascade,
  wire_report_review_id uuid
    references public.wire_report_reviews (id) on delete cascade,
  ai_pack_review_id uuid
    references public.ai_pack_reviews (id) on delete cascade,
  -- Uniform lookup key derived from whichever typed FK is set; kept consistent
  -- automatically so the guarded predicate can join on (review_kind, review_id).
  review_id uuid generated always as (
    coalesce(
      case_initial_review_id,
      case_report_review_id,
      resolution_review_id,
      challenge_review_id,
      wire_report_review_id,
      ai_pack_review_id
    )
  ) stored,
  reviewer_wallet text not null
    constraint osi_v2_sas_review_verifications_wallet_check
    check (
      char_length(reviewer_wallet) between 32 and 44
      and reviewer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  verification_state text not null default 'unchecked'
    constraint osi_v2_sas_review_verifications_state_check
    check (verification_state in (
      'unchecked', 'pending_verification', 'verified', 'invalid', 'revoked', 'expired'
    )),
  checked_credential text
    constraint osi_v2_sas_review_verifications_credential_check
    check (checked_credential is null or char_length(checked_credential) between 32 and 44),
  checked_schema text
    constraint osi_v2_sas_review_verifications_schema_check
    check (checked_schema is null or char_length(checked_schema) between 32 and 44),
  checked_issuer text
    constraint osi_v2_sas_review_verifications_issuer_check
    check (checked_issuer is null or char_length(checked_issuer) between 32 and 44),
  latency_ms integer
    constraint osi_v2_sas_review_verifications_latency_check
    check (latency_ms is null or latency_ms between 0 and 600000),
  last_result text
    constraint osi_v2_sas_review_verifications_result_check
    check (last_result is null or char_length(last_result) <= 200),
  last_error text
    constraint osi_v2_sas_review_verifications_error_check
    check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint osi_v2_sas_review_verifications_exactly_one_target_check
    check (
      num_nonnulls(
        case_initial_review_id,
        case_report_review_id,
        resolution_review_id,
        challenge_review_id,
        wire_report_review_id,
        ai_pack_review_id
      ) = 1
    ),
  constraint osi_v2_sas_review_verifications_kind_consistency_check
    check (
      (review_kind = 'case_initial' and case_initial_review_id is not null)
      or (review_kind = 'case_report' and case_report_review_id is not null)
      or (review_kind = 'resolution' and resolution_review_id is not null)
      or (review_kind = 'challenge' and challenge_review_id is not null)
      or (review_kind = 'wire_report' and wire_report_review_id is not null)
      or (review_kind = 'ai_pack' and ai_pack_review_id is not null)
    )
);

create unique index osi_v2_sas_review_verifications_kind_review_uidx
  on public.osi_v2_sas_review_verifications (review_kind, review_id);
create index osi_v2_sas_review_verifications_case_initial_idx
  on public.osi_v2_sas_review_verifications (case_initial_review_id)
  where case_initial_review_id is not null;
create index osi_v2_sas_review_verifications_case_report_idx
  on public.osi_v2_sas_review_verifications (case_report_review_id)
  where case_report_review_id is not null;
create index osi_v2_sas_review_verifications_resolution_idx
  on public.osi_v2_sas_review_verifications (resolution_review_id)
  where resolution_review_id is not null;
create index osi_v2_sas_review_verifications_challenge_idx
  on public.osi_v2_sas_review_verifications (challenge_review_id)
  where challenge_review_id is not null;
create index osi_v2_sas_review_verifications_wire_report_idx
  on public.osi_v2_sas_review_verifications (wire_report_review_id)
  where wire_report_review_id is not null;
create index osi_v2_sas_review_verifications_ai_pack_idx
  on public.osi_v2_sas_review_verifications (ai_pack_review_id)
  where ai_pack_review_id is not null;
create index osi_v2_sas_review_verifications_wallet_idx
  on public.osi_v2_sas_review_verifications (reviewer_wallet);
create index osi_v2_sas_review_verifications_state_idx
  on public.osi_v2_sas_review_verifications (verification_state);

comment on table public.osi_v2_sas_review_verifications is
  'D19 service-only per-review SAS verification snapshot (state at cast time). Resolved snapshots are immutable; only unchecked/pending_verification may transition. Enforcement counts a review only when its snapshot is verified. No secrets or PII.';

-- Append-only rate-limit ledger for the unauthenticated public verifier.
create table public.osi_v2_sas_verify_events (
  id uuid primary key default gen_random_uuid(),
  request_fingerprint_hash text not null
    constraint osi_v2_sas_verify_events_fingerprint_check
    check (char_length(request_fingerprint_hash) between 16 and 128),
  wallet text
    constraint osi_v2_sas_verify_events_wallet_check
    check (wallet is null or (char_length(wallet) between 32 and 44
      and wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$')),
  created_at timestamptz not null default now()
);
create index osi_v2_sas_verify_events_fingerprint_idx
  on public.osi_v2_sas_verify_events (request_fingerprint_hash, created_at);
create index osi_v2_sas_verify_events_wallet_idx
  on public.osi_v2_sas_verify_events (wallet, created_at);

comment on table public.osi_v2_sas_verify_events is
  'D19 service-only rate-limit ledger for the unauthenticated public SAS verifier. No secrets or PII (fingerprint is a keyed hash).';

-- ---------------------------------------------------------------------------
-- 4. Fail-closed exposure: enable + force RLS, revoke from client roles, grant
--    only service_role (which bypasses RLS). Mirrors osi_v2_default_deny.
-- ---------------------------------------------------------------------------
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'osi_v2_sas_wallet_credentials',
    'osi_v2_sas_review_verifications',
    'osi_v2_sas_verify_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format(
      'revoke all privileges on table public.%I from public, anon, authenticated',
      table_name
    );
    execute format(
      'grant select, insert, update, delete on table public.%I to service_role',
      table_name
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Flag helpers.
-- ---------------------------------------------------------------------------
create function osi_private.osi_v2_sas_enforcement_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select value = 'true'
    from public.osi_config
    where key = 'OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED'
  ), false)
$$;

create function osi_private.osi_v2_sas_configured()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce((select nullif(value, '') is not null from public.osi_config
       where key = 'OSI_V2_SAS_CREDENTIAL_PUBKEY'), false)
    and coalesce((select nullif(value, '') is not null from public.osi_config
       where key = 'OSI_V2_SAS_SCHEMA_PUBKEY'), false)
    and coalesce((select nullif(value, '') is not null from public.osi_config
       where key = 'OSI_V2_SAS_ISSUER_PUBKEY'), false)
$$;

create function osi_private.osi_v2_sas_issuance_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  -- Live-capable only when both the flag is on AND Step 0 pubkeys are present.
  -- Absent pubkeys => a safe, logged no-op at the Edge layer, never a crash.
  select coalesce((
    select value = 'true'
    from public.osi_config
    where key = 'OSI_V2_SAS_CREDENTIAL_ISSUANCE_ENABLED'
  ), false)
  and osi_private.osi_v2_sas_configured()
$$;

-- Guarded per-review predicate. Returns TRUE unconditionally when enforcement is
-- off, BEFORE referencing the verification table, so quorum results are identical
-- to current main. When on, a review counts only if its snapshot is 'verified'.
create function osi_private.osi_v2_sas_review_counts(
  p_review_kind text,
  p_review_id uuid
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  -- Fail-open BEFORE touching the verification table when enforcement is off, so
  -- quorum results are identical to main and no read of the new table is planned.
  if not osi_private.osi_v2_sas_enforcement_enabled() then
    return true;
  end if;
  -- Transaction-local bypass for the D17 maintainer_bootstrap channel. Bootstrap
  -- decisions are maintainer authority, never subject to the analyst credential
  -- gate; a future bootstrap rollout may set this around its finalize compute.
  -- When enforcement is off this line is never reached, so the shipped default is
  -- unaffected.
  if coalesce(current_setting('osi_v2.sas_bypass', true), '') = 'on' then
    return true;
  end if;
  if p_review_id is null then
    return false;
  end if;
  return exists (
    select 1
    from public.osi_v2_sas_review_verifications as v
    where v.review_kind = p_review_kind
      and v.review_id = p_review_id
      and v.verification_state = 'verified'
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Service-only recording helpers (shadow validation + issuance telemetry).
-- ---------------------------------------------------------------------------

-- Upsert the per-wallet cache. This is a cache/index, so it always reflects the
-- latest check; it is not the immutable per-review snapshot.
create function osi_private.osi_v2_sas_record_wallet_state(
  p_wallet text,
  p_state text,
  p_credential text default null,
  p_schema text default null,
  p_issuer text default null,
  p_attestation text default null,
  p_expiry timestamptz default null,
  p_latency_ms integer default null,
  p_result text default null,
  p_error text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.osi_v2_sas_wallet_credentials as w (
    wallet, verification_state, checked_credential, checked_schema, checked_issuer,
    attestation_pubkey, credential_expiry, last_checked_at, latency_ms,
    last_result, last_error, updated_at
  )
  values (
    p_wallet, p_state, p_credential, p_schema, p_issuer,
    p_attestation, p_expiry, now(), p_latency_ms,
    left(p_result, 200), left(p_error, 500), now()
  )
  on conflict (wallet) do update set
    verification_state = excluded.verification_state,
    checked_credential = coalesce(excluded.checked_credential, w.checked_credential),
    checked_schema = coalesce(excluded.checked_schema, w.checked_schema),
    checked_issuer = coalesce(excluded.checked_issuer, w.checked_issuer),
    attestation_pubkey = excluded.attestation_pubkey,
    credential_expiry = excluded.credential_expiry,
    last_checked_at = excluded.last_checked_at,
    latency_ms = excluded.latency_ms,
    last_result = excluded.last_result,
    last_error = excluded.last_error,
    updated_at = now();
end
$$;

-- Record the Step 1 issuance / reconciliation outcome on the wallet ledger.
create function osi_private.osi_v2_sas_record_issuance(
  p_wallet text,
  p_issuance_state text,
  p_tx_sig text default null,
  p_attestation text default null,
  p_error text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.osi_v2_sas_wallet_credentials as w (
    wallet, issuance_state, issuance_tx_sig, attestation_pubkey,
    issued_at, revoked_at, last_error, updated_at
  )
  values (
    p_wallet, p_issuance_state, p_tx_sig, p_attestation,
    case when p_issuance_state = 'issued' then now() end,
    case when p_issuance_state = 'revoked' then now() end,
    left(p_error, 500), now()
  )
  on conflict (wallet) do update set
    issuance_state = excluded.issuance_state,
    issuance_tx_sig = coalesce(excluded.issuance_tx_sig, w.issuance_tx_sig),
    attestation_pubkey = coalesce(excluded.attestation_pubkey, w.attestation_pubkey),
    issued_at = case when excluded.issuance_state = 'issued' then now() else w.issued_at end,
    revoked_at = case when excluded.issuance_state = 'revoked' then now() else w.revoked_at end,
    last_error = coalesce(excluded.last_error, w.last_error),
    updated_at = now();
end
$$;

-- Record / transition the immutable per-review snapshot. A snapshot that is
-- already resolved (verified/invalid/revoked/expired) is NEVER rewritten; only
-- unchecked/pending_verification may move forward (lazy re-check). Returns the
-- resolved verification_state.
create function osi_private.osi_v2_sas_record_review_verification(
  p_review_kind text,
  p_review_id uuid,
  p_wallet text,
  p_state text,
  p_credential text default null,
  p_schema text default null,
  p_issuer text default null,
  p_latency_ms integer default null,
  p_result text default null,
  p_error text default null
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_state text;
begin
  if p_review_kind not in (
    'case_initial', 'case_report', 'resolution', 'challenge', 'wire_report', 'ai_pack'
  ) then
    raise exception 'Unknown review kind %', p_review_kind using errcode = '22023';
  end if;

  select v.verification_state into existing_state
    from public.osi_v2_sas_review_verifications as v
   where v.review_kind = p_review_kind
     and v.review_id = p_review_id;

  if existing_state is not null then
    -- Resolved snapshots are immutable history and never change retroactively.
    if existing_state in ('verified', 'invalid', 'revoked', 'expired') then
      return existing_state;
    end if;
    update public.osi_v2_sas_review_verifications as v set
      verification_state = p_state,
      reviewer_wallet = p_wallet,
      checked_credential = coalesce(p_credential, v.checked_credential),
      checked_schema = coalesce(p_schema, v.checked_schema),
      checked_issuer = coalesce(p_issuer, v.checked_issuer),
      latency_ms = p_latency_ms,
      last_result = left(p_result, 200),
      last_error = left(p_error, 500),
      updated_at = now()
    where v.review_kind = p_review_kind
      and v.review_id = p_review_id;
    return p_state;
  end if;

  insert into public.osi_v2_sas_review_verifications (
    review_kind,
    case_initial_review_id,
    case_report_review_id,
    resolution_review_id,
    challenge_review_id,
    wire_report_review_id,
    ai_pack_review_id,
    reviewer_wallet, verification_state,
    checked_credential, checked_schema, checked_issuer,
    latency_ms, last_result, last_error
  )
  values (
    p_review_kind,
    case when p_review_kind = 'case_initial' then p_review_id end,
    case when p_review_kind = 'case_report' then p_review_id end,
    case when p_review_kind = 'resolution' then p_review_id end,
    case when p_review_kind = 'challenge' then p_review_id end,
    case when p_review_kind = 'wire_report' then p_review_id end,
    case when p_review_kind = 'ai_pack' then p_review_id end,
    p_wallet, p_state,
    p_credential, p_schema, p_issuer,
    p_latency_ms, left(p_result, 200), left(p_error, 500)
  );
  return p_state;
end
$$;

-- Bounded rate limit for the unauthenticated public verifier. Reuses the
-- window/count pattern of osi_v2_check_report_review_rate. Raises with a message
-- containing 'rate limit' (the Edge maps that to HTTP 429), else records a hit.
create function osi_private.osi_v2_sas_check_verify_rate(
  p_request_fingerprint_hash text,
  p_wallet text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  window_seconds integer;
  max_per_fingerprint integer;
  max_per_wallet integer;
  fingerprint_count bigint;
  wallet_count bigint;
  window_start timestamptz;
begin
  -- Read osi_config directly (service_role calls this function directly, and
  -- osi_v2_config_integer is not granted to service_role).
  select case when value ~ '^[0-9]+$' then value::integer end into window_seconds
    from public.osi_config where key = 'OSI_V2_SAS_VERIFY_RATE_WINDOW_SECONDS';
  select case when value ~ '^[0-9]+$' then value::integer end into max_per_fingerprint
    from public.osi_config where key = 'OSI_V2_SAS_VERIFY_MAX_PER_FINGERPRINT';
  select case when value ~ '^[0-9]+$' then value::integer end into max_per_wallet
    from public.osi_config where key = 'OSI_V2_SAS_VERIFY_MAX_PER_WALLET';
  window_seconds := least(greatest(coalesce(window_seconds, 60), 1), 3600);
  max_per_fingerprint := least(greatest(coalesce(max_per_fingerprint, 30), 1), 100000);
  max_per_wallet := least(greatest(coalesce(max_per_wallet, 60), 1), 100000);
  window_start := now() - make_interval(secs => window_seconds);

  select count(*) into fingerprint_count
    from public.osi_v2_sas_verify_events as ev
   where ev.request_fingerprint_hash = p_request_fingerprint_hash
     and ev.created_at >= window_start;
  if fingerprint_count >= max_per_fingerprint then
    raise exception 'SAS verify rate limit exceeded' using errcode = '53400';
  end if;

  if p_wallet is not null then
    select count(*) into wallet_count
      from public.osi_v2_sas_verify_events as ev
     where ev.wallet = p_wallet
       and ev.created_at >= window_start;
    if wallet_count >= max_per_wallet then
      raise exception 'SAS verify rate limit exceeded' using errcode = '53400';
    end if;
  end if;

  insert into public.osi_v2_sas_verify_events (request_fingerprint_hash, wallet)
  values (p_request_fingerprint_hash, p_wallet);
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Public (service-role only) wrappers for the Edge layer.
-- ---------------------------------------------------------------------------
create function public.osi_v2_sas_check_verify_rate(
  p_request_fingerprint_hash text,
  p_wallet text
)
returns void
language sql
security invoker
set search_path = ''
as $$
  select osi_private.osi_v2_sas_check_verify_rate(p_request_fingerprint_hash, p_wallet)
$$;
create function public.osi_v2_sas_settings()
returns table (
  program_id text,
  credential_pubkey text,
  schema_pubkey text,
  issuer_pubkey text,
  issuance_enabled boolean,
  enforcement_enabled boolean,
  configured boolean,
  verify_timeout_ms integer,
  stale_seconds integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (select value from public.osi_config where key = 'OSI_V2_SAS_PROGRAM_ID'),
    nullif((select value from public.osi_config where key = 'OSI_V2_SAS_CREDENTIAL_PUBKEY'), ''),
    nullif((select value from public.osi_config where key = 'OSI_V2_SAS_SCHEMA_PUBKEY'), ''),
    nullif((select value from public.osi_config where key = 'OSI_V2_SAS_ISSUER_PUBKEY'), ''),
    osi_private.osi_v2_sas_issuance_enabled(),
    osi_private.osi_v2_sas_enforcement_enabled(),
    osi_private.osi_v2_sas_configured(),
    -- Read osi_config directly (not via osi_v2_config_integer) so this invoker
    -- function works when called directly by service_role from the Edge layer.
    coalesce((select case when value ~ '^[0-9]+$' then value::integer end
      from public.osi_config where key = 'OSI_V2_SAS_VERIFY_TIMEOUT_MS'), 2500),
    coalesce((select case when value ~ '^[0-9]+$' then value::integer end
      from public.osi_config where key = 'OSI_V2_SAS_STALE_SECONDS'), 900)
$$;

create function public.osi_v2_sas_record_wallet_state(
  p_wallet text,
  p_state text,
  p_credential text default null,
  p_schema text default null,
  p_issuer text default null,
  p_attestation text default null,
  p_expiry timestamptz default null,
  p_latency_ms integer default null,
  p_result text default null,
  p_error text default null
)
returns void
language sql
security invoker
set search_path = ''
as $$
  select osi_private.osi_v2_sas_record_wallet_state(
    p_wallet, p_state, p_credential, p_schema, p_issuer, p_attestation,
    p_expiry, p_latency_ms, p_result, p_error)
$$;

create function public.osi_v2_sas_record_issuance(
  p_wallet text,
  p_issuance_state text,
  p_tx_sig text default null,
  p_attestation text default null,
  p_error text default null
)
returns void
language sql
security invoker
set search_path = ''
as $$
  select osi_private.osi_v2_sas_record_issuance(
    p_wallet, p_issuance_state, p_tx_sig, p_attestation, p_error)
$$;

create function public.osi_v2_sas_record_review_verification(
  p_review_kind text,
  p_review_id uuid,
  p_wallet text,
  p_state text,
  p_credential text default null,
  p_schema text default null,
  p_issuer text default null,
  p_latency_ms integer default null,
  p_result text default null,
  p_error text default null
)
returns text
language sql
security invoker
set search_path = ''
as $$
  select osi_private.osi_v2_sas_record_review_verification(
    p_review_kind, p_review_id, p_wallet, p_state, p_credential, p_schema,
    p_issuer, p_latency_ms, p_result, p_error)
$$;

-- ---------------------------------------------------------------------------
-- 8. Least-privilege grants for the new functions (service-role only).
-- ---------------------------------------------------------------------------
do $$
declare
  helper regprocedure;
begin
  for helper in
    select procedure.oid::regprocedure
    from pg_proc as procedure
    join pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where procedure.proname like 'osi_v2_sas_%'
      and namespace.nspname in ('public', 'osi_private')
  loop
    execute format('revoke all privileges on function %s from public, anon, authenticated', helper);
    execute format('grant execute on function %s to service_role', helper);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Quorum enforcement gate. CREATE OR REPLACE keeps each function's existing
--    signature and grants. Each replacement is the current-main body with exactly
--    one guarded conjunct added to its count/weight tally query:
--    osi_private.osi_v2_sas_review_counts(<kind>, review.id). That conjunct is a
--    tautology whenever enforcement is off, so results stay identical to main.
-- ---------------------------------------------------------------------------

-- (a) Report publication quorum.
create or replace function osi_private.osi_v2_report_quorum(p_version_id uuid)
returns table (
  version_id uuid,
  version_public_ref text,
  risk_tier text,
  approve_count integer,
  approve_weight numeric,
  reject_count integer,
  reject_weight numeric,
  required_count integer,
  required_weight numeric,
  approve_ready boolean,
  reject_ready boolean,
  quorum_hash text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  version_row public.case_report_versions%rowtype;
  case_risk text;
  minimum_count integer;
  minimum_weight numeric;
  approval_count integer;
  approval_weight numeric;
  rejection_count integer;
  rejection_weight numeric;
  snapshot jsonb;
begin
  select version.* into version_row
    from public.case_report_versions as version
   where version.id = p_version_id;
  if version_row.id is null then
    raise exception 'Report version is not available' using errcode = '42501';
  end if;

  select case_row.risk_tier into case_risk
    from public.case_reports as report
    join public.cases as case_row on case_row.id = report.case_id
   where report.id = version_row.report_id;

  if case_risk = 'high' then
    select case when config.value ~ '^[0-9]+$' then config.value::integer end
      into minimum_count from public.osi_config as config
     where config.key = 'OSI_V2_REPORT_HIGH_MIN_ANALYSTS';
    select case when config.value ~ '^[0-9]+(?:\.[0-9]+)?$' then config.value::numeric end
      into minimum_weight from public.osi_config as config
     where config.key = 'OSI_V2_REPORT_HIGH_MIN_WEIGHT';
  else
    select case when config.value ~ '^[0-9]+$' then config.value::integer end
      into minimum_count from public.osi_config as config
     where config.key = 'OSI_V2_REPORT_STANDARD_MIN_ANALYSTS';
    select case when config.value ~ '^[0-9]+(?:\.[0-9]+)?$' then config.value::numeric end
      into minimum_weight from public.osi_config as config
     where config.key = 'OSI_V2_REPORT_STANDARD_MIN_WEIGHT';
  end if;
  if minimum_count is null or minimum_count not between 2 and 10
     or minimum_weight is null or minimum_weight not between 1 and 20 then
    raise exception 'Report quorum configuration is absent or invalid'
      using errcode = '55000';
  end if;

  with counted as (
    select
      review.public_ref,
      review.reviewer_wallet,
      review.decision,
      review.weight,
      review.tier_snapshot,
      review.created_at
    from public.case_report_reviews as review
    join public.analyst_profiles as profile
      on profile.wallet = review.reviewer_wallet
    join public.event_receipts as receipt
      on receipt.id = review.event_receipt_id
     and receipt.event_version = 'OSI2'
     and receipt.event_type in ('CASE_REPORT_REVIEW_CAST', 'CASE_REPORT_REVIEW_REVISED')
     and receipt.target_type = 'report_version'
     and receipt.target_id = review.report_version_id::text
     and receipt.actor_wallet = review.reviewer_wallet
     and receipt.decision = review.decision
     and receipt.weight = review.weight
     and receipt.reason_code is not distinct from review.reason_code
     and receipt.proof_type = 'wallet_signed_server_verified'
     and receipt.server_verified = true
    where review.report_version_id = p_version_id
      and review.is_active = true
      and review.public_ref is not null
      and profile.status in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
      and profile.verified = true
      and profile.approved = true
      and osi_private.osi_v2_sas_review_counts('case_report', review.id)
  )
  select
    count(*) filter (where counted.decision = 'approve')::integer,
    coalesce(sum(counted.weight) filter (where counted.decision = 'approve'), 0),
    count(*) filter (where counted.decision = 'reject')::integer,
    coalesce(sum(counted.weight) filter (where counted.decision = 'reject'), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'decision', counted.decision,
      'public_ref', counted.public_ref,
      'reviewer_wallet', counted.reviewer_wallet,
      'tier_snapshot', counted.tier_snapshot,
      'weight', counted.weight
    ) order by counted.reviewer_wallet) filter (
      where counted.decision in ('approve', 'reject')
    ), '[]'::jsonb)
    into approval_count, approval_weight, rejection_count, rejection_weight, snapshot
    from counted;

  return query select
    version_row.id,
    version_row.version_ref,
    case_risk,
    approval_count,
    approval_weight,
    rejection_count,
    rejection_weight,
    minimum_count,
    minimum_weight,
    approval_count >= minimum_count and approval_weight >= minimum_weight,
    rejection_count >= minimum_count and rejection_weight >= minimum_weight,
    encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
      'risk_tier', case_risk,
      'reviews', snapshot,
      'threshold_count', minimum_count,
      'threshold_weight', minimum_weight,
      'version_id', version_row.id,
      'version_ref', version_row.version_ref
    )::text, 'UTF8'), 'sha256'), 'hex');
end
$$;

-- (b) Case initial-review quorum.
create or replace function osi_private.osi_v2_case_review_quorum(p_case_id uuid)
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
      -- The credential gate applies only to genuine analyst reviews. Maintainer
      -- approve_open (weight 0) rows are the D5/D17 maintainer-authority channel
      -- and are never subject to this check, in either flag state.
      and (
        review.reviewer_role <> 'analyst'
        or osi_private.osi_v2_sas_review_counts('case_initial', review.id)
      )
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

-- (c) Resolution (winning-Report selection) quorum.
create or replace function osi_private.osi_v2_resolution_quorum(p_resolution_id uuid)
returns table (
  leader_version_id uuid, leader_version_ref text,
  leader_count integer, leader_weight numeric,
  required_count integer, required_weight numeric,
  ready_candidate_count integer, tie_unresolved boolean,
  quorum_hash text
)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  resolution_row public.case_resolutions%rowtype;
  case_risk text;
  minimum_count integer;
  minimum_weight numeric;
  top_row record;
  second_row record;
  ready_count integer;
  snapshot jsonb;
begin
  select resolution.* into resolution_row from public.case_resolutions as resolution
   where resolution.id = p_resolution_id;
  select case_item.risk_tier into case_risk from public.cases as case_item
   where case_item.id = resolution_row.case_id;
  if resolution_row.id is null then
    raise exception 'Resolution is not available' using errcode = '42501';
  end if;
  if case_risk = 'high' then
    minimum_count := osi_private.osi_v2_config_integer('OSI_V2_RESOLUTION_HIGH_MIN_COUNT', 2, 10);
    select config.value::numeric into minimum_weight from public.osi_config as config
     where config.key = 'OSI_V2_RESOLUTION_HIGH_MIN_WEIGHT'
       and config.value ~ '^[0-9]+(\.[0-9]+)?$';
  else
    minimum_count := osi_private.osi_v2_config_integer('OSI_V2_RESOLUTION_STANDARD_MIN_COUNT', 2, 10);
    select config.value::numeric into minimum_weight from public.osi_config as config
     where config.key = 'OSI_V2_RESOLUTION_STANDARD_MIN_WEIGHT'
       and config.value ~ '^[0-9]+(\.[0-9]+)?$';
  end if;
  if minimum_weight is null or minimum_weight not between 1 and 30 then
    raise exception 'Resolution weight configuration is invalid' using errcode = '55000';
  end if;

  with tallies as (
    select review.candidate_report_version_id as version_id,
      count(*)::integer as analyst_count,
      coalesce(sum(review.weight), 0)::numeric as total_weight
      from public.resolution_reviews as review
     where review.resolution_id = p_resolution_id
       and review.phase = 'selection' and review.is_active = true
       and review.decision = 'select'
       and osi_private.osi_v2_sas_review_counts('resolution', review.id)
     group by review.candidate_report_version_id
  ), ready as (
    select tally.*, version.version_ref
      from tallies as tally
      join public.case_report_versions as version on version.id = tally.version_id
     where tally.analyst_count >= minimum_count
       and tally.total_weight >= minimum_weight
     order by tally.total_weight desc, tally.analyst_count desc, version.version_ref
  )
  select * into top_row from ready limit 1;
  with tallies as (
    select review.candidate_report_version_id as version_id,
      count(*)::integer as analyst_count,
      coalesce(sum(review.weight), 0)::numeric as total_weight
      from public.resolution_reviews as review
     where review.resolution_id = p_resolution_id
       and review.phase = 'selection' and review.is_active = true
       and review.decision = 'select'
       and osi_private.osi_v2_sas_review_counts('resolution', review.id)
     group by review.candidate_report_version_id
  ), ready as (
    select tally.*, version.version_ref
      from tallies as tally
      join public.case_report_versions as version on version.id = tally.version_id
     where tally.analyst_count >= minimum_count
       and tally.total_weight >= minimum_weight
     order by tally.total_weight desc, tally.analyst_count desc, version.version_ref
  )
  select * into second_row from ready offset 1 limit 1;
  with tallies as (
    select review.candidate_report_version_id,
      count(*)::integer as analyst_count, sum(review.weight)::numeric as total_weight
      from public.resolution_reviews as review
     where review.resolution_id = p_resolution_id and review.phase = 'selection'
       and review.is_active = true and review.decision = 'select'
       and osi_private.osi_v2_sas_review_counts('resolution', review.id)
     group by review.candidate_report_version_id
  ) select count(*)::integer into ready_count from tallies
     where analyst_count >= minimum_count and total_weight >= minimum_weight;

  select coalesce(jsonb_agg(jsonb_build_object(
    'candidate_version_id', review.candidate_report_version_id,
    'created_at', review.created_at,
    'decision', review.decision,
    'review_public_ref', review.public_ref,
    'reviewer_wallet', review.reviewer_wallet,
    'tier', review.tier_snapshot,
    'weight', review.weight
  ) order by review.reviewer_wallet), '[]'::jsonb) into snapshot
  from public.resolution_reviews as review
  where review.resolution_id = p_resolution_id
    and review.phase = 'selection' and review.is_active = true;

  tie_unresolved := top_row.version_id is not null and second_row.version_id is not null
    and top_row.total_weight = second_row.total_weight
    and top_row.analyst_count = second_row.analyst_count;
  quorum_hash := encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'resolution_id', p_resolution_id,
    'reviews', snapshot,
    'required_count', minimum_count,
    'required_weight', minimum_weight
  )::text, 'UTF8'), 'sha256'), 'hex');
  leader_version_id := case when tie_unresolved then null else top_row.version_id end;
  leader_version_ref := case when tie_unresolved then null else top_row.version_ref end;
  leader_count := coalesce(top_row.analyst_count, 0);
  leader_weight := coalesce(top_row.total_weight, 0);
  required_count := minimum_count;
  required_weight := minimum_weight;
  ready_candidate_count := coalesce(ready_count, 0);
  return next;
end;
$$;

-- (d) Seal quorum.
create or replace function osi_private.osi_v2_seal_quorum(p_resolution_id uuid)
returns table (
  approve_count integer, approve_weight numeric,
  required_count integer, required_weight numeric,
  ready boolean, quorum_hash text
)
language plpgsql stable security invoker set search_path = ''
as $$
declare snapshot jsonb; minimum_count integer; minimum_weight numeric;
begin
  minimum_count := osi_private.osi_v2_config_integer('OSI_V2_SEAL_MIN_COUNT', 2, 10);
  select config.value::numeric into minimum_weight from public.osi_config as config
   where config.key = 'OSI_V2_SEAL_MIN_WEIGHT' and config.value ~ '^[0-9]+(\.[0-9]+)?$';
  if minimum_weight is null or minimum_weight not between 1 and 30 then
    raise exception 'Seal weight configuration is invalid' using errcode = '55000';
  end if;
  select count(*)::integer, coalesce(sum(review.weight), 0)::numeric,
    coalesce(jsonb_agg(jsonb_build_object(
      'created_at', review.created_at, 'decision', review.decision,
      'review_public_ref', review.public_ref, 'reviewer_wallet', review.reviewer_wallet,
      'tier', review.tier_snapshot, 'weight', review.weight
    ) order by review.reviewer_wallet), '[]'::jsonb)
    into approve_count, approve_weight, snapshot
    from public.resolution_reviews as review
   where review.resolution_id = p_resolution_id and review.phase = 'seal'
     and review.is_active = true and review.decision = 'select'
     and osi_private.osi_v2_sas_review_counts('resolution', review.id);
  required_count := minimum_count; required_weight := minimum_weight;
  ready := approve_count >= minimum_count and approve_weight >= minimum_weight;
  quorum_hash := encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'resolution_id', p_resolution_id, 'reviews', snapshot,
    'required_count', minimum_count, 'required_weight', minimum_weight
  )::text, 'UTF8'), 'sha256'), 'hex');
  return next;
end;
$$;

-- (e) Challenge merit quorum.
create or replace function osi_private.osi_v2_challenge_quorum(p_challenge_id uuid)
returns table (
  outcome text, outcome_count integer, outcome_weight numeric,
  required_count integer, required_weight numeric,
  tie_unresolved boolean, quorum_hash text
)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  minimum_count integer;
  minimum_weight numeric;
  accept_count integer; accept_weight numeric;
  reject_count integer; reject_weight numeric;
  accept_ready boolean; reject_ready boolean;
  snapshot jsonb;
begin
  minimum_count := osi_private.osi_v2_config_integer('OSI_V2_CHALLENGE_MIN_COUNT', 2, 10);
  select config.value::numeric into minimum_weight from public.osi_config as config
   where config.key = 'OSI_V2_CHALLENGE_MIN_WEIGHT' and config.value ~ '^[0-9]+(\.[0-9]+)?$';
  if minimum_weight is null or minimum_weight not between 1 and 30 then
    raise exception 'Challenge weight configuration is invalid' using errcode = '55000';
  end if;
  select count(*) filter (where review.decision = 'accept')::integer,
    coalesce(sum(review.weight) filter (where review.decision = 'accept'), 0)::numeric,
    count(*) filter (where review.decision = 'reject')::integer,
    coalesce(sum(review.weight) filter (where review.decision = 'reject'), 0)::numeric,
    coalesce(jsonb_agg(jsonb_build_object(
      'created_at', review.created_at, 'decision', review.decision,
      'review_public_ref', review.public_ref, 'reviewer_wallet', review.reviewer_wallet,
      'tier', review.tier_snapshot, 'weight', review.weight
    ) order by review.reviewer_wallet), '[]'::jsonb)
    into accept_count, accept_weight, reject_count, reject_weight, snapshot
    from public.challenge_reviews as review
   where review.challenge_id = p_challenge_id and review.phase = 'merit'
     and review.is_active = true
     and osi_private.osi_v2_sas_review_counts('challenge', review.id);
  accept_ready := accept_count >= minimum_count and accept_weight >= minimum_weight;
  reject_ready := reject_count >= minimum_count and reject_weight >= minimum_weight;
  tie_unresolved := accept_ready and reject_ready
    and accept_weight = reject_weight and accept_count = reject_count;
  if tie_unresolved or (not accept_ready and not reject_ready) then outcome := null;
  elsif accept_ready and (not reject_ready or accept_weight > reject_weight
    or (accept_weight = reject_weight and accept_count > reject_count)) then outcome := 'accept';
  else outcome := 'reject'; end if;
  outcome_count := case when outcome = 'accept' then accept_count when outcome = 'reject' then reject_count else 0 end;
  outcome_weight := case when outcome = 'accept' then accept_weight when outcome = 'reject' then reject_weight else 0 end;
  required_count := minimum_count; required_weight := minimum_weight;
  quorum_hash := encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'challenge_id', p_challenge_id, 'reviews', snapshot,
    'required_count', minimum_count, 'required_weight', minimum_weight
  )::text, 'UTF8'), 'sha256'), 'hex');
  return next;
end;
$$;

commit;
