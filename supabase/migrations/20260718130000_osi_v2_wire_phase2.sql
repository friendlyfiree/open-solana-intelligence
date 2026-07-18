-- OSI V2 The Wire Phase 2: review, publication, public records, challenge,
-- voluntary support and promotion into the normal Case lifecycle.
--
-- This migration is additive. It does not publish an existing private Wire
-- version, enable a feature flag, create a reward, rewrite immutable evidence,
-- or expose any table directly to anon/authenticated roles. Every mutation is
-- service-only and fails closed unless OSI_V2_WIRE_WRITES_ENABLED is exactly
-- true. Native SOL support additionally requires the existing payment flag.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_WIRE_STANDARD_MIN_COUNT', '2', statement_timestamp()),
  ('OSI_V2_WIRE_STANDARD_MIN_WEIGHT', '2.00', statement_timestamp())
on conflict (key) do nothing;

-- The shared lazy expiry worker remains byte-for-byte equivalent for every
-- pre-existing challenge target. Wire-targeted rows additionally require the
-- dedicated Wire gate so another governance request cannot mutate them while
-- the Wire lane is disabled.
create or replace function osi_private.osi_v2_expire_due_challenges(
  p_limit integer default 100
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  challenge_row public.challenges_v2%rowtype;
  receipt_id uuid;
  exact_hash text;
  expired_count integer := 0;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Challenge expiry is service-only' using errcode = '42501';
  end if;
  if p_limit not between 1 and 500 then
    raise exception 'Challenge expiry batch is invalid' using errcode = '22023';
  end if;
  for challenge_row in
    select challenge.*
      from public.challenges_v2 as challenge
     where (
       (
         challenge.state in ('submitted', 'admissibility_review')
         and challenge.admissibility_ttl_at <= statement_timestamp()
       ) or (
         challenge.state in ('open', 'under_review')
         and challenge.review_deadline_at <= statement_timestamp()
       )
     )
       and (
         challenge.wire_report_version_id is null
         or osi_private.osi_v2_wire_writes_enabled() is true
       )
     order by coalesce(
       challenge.review_deadline_at, challenge.admissibility_ttl_at
     ), challenge.id
     for update skip locked
     limit p_limit
  loop
    receipt_id := gen_random_uuid();
    exact_hash := encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
      'challenge_id', challenge_row.id,
      'event_type', 'CHALLENGE_EXPIRED',
      'expired_reason', case
        when challenge_row.state in ('submitted', 'admissibility_review')
          then 'admissibility_timeout'
        else 'review_timeout'
      end,
      'server_time', statement_timestamp()
    )::text, 'UTF8'), 'sha256'), 'hex');
    insert into public.event_receipts (
      id, event_version, event_type, target_type, target_id, public_ref,
      actor_role, decision, reason_code, proof_type, payload_hash,
      server_verified, occurred_at, created_at
    ) values (
      receipt_id, 'OSI2', 'CHALLENGE_EXPIRED', 'challenge',
      challenge_row.id::text, challenge_row.public_ref, 'service', 'expire',
      case when challenge_row.state in ('submitted', 'admissibility_review')
        then 'admissibility_timeout' else 'review_timeout' end,
      'system_event', exact_hash, true, statement_timestamp(), statement_timestamp()
    );
    update public.challenges_v2 as challenge
       set state = 'expired',
           expired_reason = case
             when challenge_row.state in ('submitted', 'admissibility_review')
               then 'admissibility_timeout'
             else 'review_timeout'
           end,
           resolved_receipt_id = receipt_id,
           terminal_at = statement_timestamp(),
           updated_at = statement_timestamp()
     where challenge.id = challenge_row.id
       and challenge.state = challenge_row.state;
    if found then
      expired_count := expired_count + 1;
    end if;
  end loop;
  return expired_count;
end;
$$;

alter table public.wire_report_reviews
  add column public_ref text
    constraint wire_report_reviews_public_ref_check
    check (public_ref is null or public_ref ~ '^OSI-WRV-[0-9A-F]{16}$'),
  add column reviewer_profile_wallet text
    references public.analyst_profiles (wallet) on delete restrict,
  add column tier_snapshot text
    constraint wire_report_reviews_tier_snapshot_check
    check (tier_snapshot is null or tier_snapshot in (
      'probationary', 'analyst_i', 'analyst_ii', 'senior', 'distinguished'
    )),
  add column public_rationale text
    constraint wire_report_reviews_public_rationale_check
    check (
      public_rationale is null
      or (
        public_rationale = btrim(public_rationale)
        and char_length(public_rationale) between 10 and 2000
      )
    ),
  add column private_note text
    constraint wire_report_reviews_private_note_check
    check (
      private_note is null
      or (
        private_note = btrim(private_note)
        and char_length(private_note) between 1 and 4000
      )
    ),
  add constraint wire_report_reviews_native_profile_check
    check (
      public_ref is null
      or (
        reviewer_profile_wallet = reviewer_wallet
        and tier_snapshot is not null
        and public_rationale is not null
      )
    );

alter table public.wire_report_versions
  add column publication_quorum_hash text
    constraint wire_report_versions_publication_quorum_hash_check
    check (publication_quorum_hash is null or publication_quorum_hash ~ '^[0-9a-f]{64}$'),
  add column contested_at timestamptz,
  add column contested_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  add constraint wire_report_versions_contested_shape_check
    check ((contested_at is null) = (contested_receipt_id is null));

create unique index wire_report_reviews_public_ref_uidx
  on public.wire_report_reviews (public_ref)
  where public_ref is not null;
create index wire_report_reviews_active_quorum_idx
  on public.wire_report_reviews (
    wire_report_version_id, decision, reviewer_wallet
  ) where is_active;
create index wire_report_versions_contested_idx
  on public.wire_report_versions (contested_at)
  where contested_at is not null;
create index support_events_wire_state_idx
  on public.support_events (wire_report_version_id, state)
  where wire_report_version_id is not null;

comment on column public.wire_report_versions.publication_quorum_hash is
  'Write-once hash of the exact active counted Wire review snapshot bound to WIRE_REPORT_PUBLISHED.';
comment on column public.wire_report_versions.contested_at is
  'Set once when a challenge against this exact immutable published Wire version is accepted. The version and public pointer are preserved; correction remains a new version.';
comment on column public.wire_report_reviews.private_note is
  'Restricted analyst note. Never returned by an anonymous/public Wire projection.';

-- D17 Phase-2 amendment: the existing bootstrap channel may also finalize a
-- Wire publication. It remains impossible for challenges, support or
-- promotion to claim that decision channel.
alter table public.event_receipts
  drop constraint event_receipts_bootstrap_channel_scope_check;
alter table public.event_receipts
  add constraint event_receipts_bootstrap_channel_scope_check
  check (
    decision_channel = 'standard'
    or (
      event_version = 'OSI2'
      and actor_role = 'maintainer'
      and event_type in (
        'REPORT_PUBLISHED', 'WIRE_REPORT_PUBLISHED',
        'REPORT_SELECTED_WINNING', 'RECORD_SEALED'
      )
    )
  );

create function osi_private.osi_v2_wire_action_rate(
  p_actor_wallet text,
  p_request_fingerprint_hash text,
  p_purpose text,
  p_now timestamptz
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  window_seconds integer;
  wallet_max integer;
  fingerprint_max integer;
  cooldown_seconds integer;
begin
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into window_seconds from public.osi_config as config
   where config.key = 'OSI_V2_WIRE_RATE_WINDOW_SECONDS';
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into wallet_max from public.osi_config as config
   where config.key = 'OSI_V2_WIRE_MAX_PER_WALLET';
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into fingerprint_max from public.osi_config as config
   where config.key = 'OSI_V2_WIRE_MAX_PER_FINGERPRINT';
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into cooldown_seconds from public.osi_config as config
   where config.key = 'OSI_V2_WIRE_COOLDOWN_SECONDS';
  if window_seconds is null or window_seconds not between 60 and 86400
     or wallet_max is null or wallet_max not between 1 and 100
     or fingerprint_max is null or fingerprint_max not between 1 and 500
     or cooldown_seconds is null or cooldown_seconds not between 0 and 3600 then
    raise exception 'Wire action rate configuration is absent or invalid'
      using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-action-wallet:' || p_actor_wallet, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-action-fingerprint:' || p_request_fingerprint_hash, 0)
  );
  if exists (
    select 1 from public.osi_nonces as nonce
     where nonce.actor_wallet = p_actor_wallet
       and nonce.purpose = p_purpose
       and nonce.issued_at > p_now - pg_catalog.make_interval(secs => cooldown_seconds)
  ) then
    raise exception 'Wire action cooldown is active' using errcode = 'P0001';
  end if;
  if (select count(*) from public.osi_nonces as nonce
       where nonce.actor_wallet = p_actor_wallet
         and nonce.purpose like 'WIRE_%'
         and nonce.issued_at >= p_now - pg_catalog.make_interval(secs => window_seconds)) >= wallet_max
     or (select count(*) from public.osi_nonces as nonce
       where nonce.request_fingerprint_hash = p_request_fingerprint_hash
         and nonce.purpose like 'WIRE_%'
         and nonce.issued_at >= p_now - pg_catalog.make_interval(secs => window_seconds)) >= fingerprint_max then
    raise exception 'Wire action rate limit exceeded' using errcode = 'P0001';
  end if;
end;
$$;

create function osi_private.osi_v2_wire_bootstrap_support(
  p_version_id uuid,
  p_maintainer_wallet text
)
returns table (
  support_count integer,
  support_weight numeric,
  maintainer_conflicted boolean,
  support_hash text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  snapshot jsonb;
begin
  select count(*)::integer, coalesce(sum(review.weight), 0)::numeric,
    coalesce(jsonb_agg(jsonb_build_object(
      'decision', review.decision,
      'public_ref', review.public_ref,
      'reviewer_wallet', review.reviewer_wallet,
      'tier_snapshot', review.tier_snapshot,
      'weight', review.weight
    ) order by review.reviewer_wallet), '[]'::jsonb)
    into support_count, support_weight, snapshot
    from public.wire_report_reviews as review
    join public.analyst_profiles as profile
      on profile.wallet = review.reviewer_wallet
    join public.event_receipts as receipt
      on receipt.id = review.event_receipt_id
     and receipt.event_version = 'OSI2'
     and receipt.event_type in ('WIRE_REPORT_REVIEW_CAST', 'WIRE_REPORT_REVIEW_REVISED')
     and receipt.target_type = 'wire_version'
     and receipt.target_id = review.wire_report_version_id::text
     and receipt.actor_wallet = review.reviewer_wallet
     and receipt.decision = review.decision
     and receipt.weight = review.weight
     and receipt.reason_code is not distinct from review.reason_code
     and receipt.proof_type = 'wallet_signed_server_verified'
     and receipt.server_verified = true
   where review.wire_report_version_id = p_version_id
     and review.is_active = true
     and review.decision = 'approve'
     and review.public_ref is not null
     and review.reviewer_wallet <> p_maintainer_wallet
     and profile.status in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     and profile.verified = true and profile.approved = true
     and osi_private.osi_v2_sas_review_counts('wire_report', review.id);
  maintainer_conflicted := exists (
    select 1 from public.wire_report_reviews as review
     where review.wire_report_version_id = p_version_id
       and review.reviewer_wallet = p_maintainer_wallet
       and review.is_active = true
  );
  support_hash := encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'channel', 'maintainer_bootstrap',
    'reviews', snapshot,
    'version_id', p_version_id
  )::text, 'UTF8'), 'sha256'), 'hex');
  return next;
end;
$$;

create function osi_private.osi_v2_prepare_wire_publication(
  p_nonce text,
  p_actor_wallet text,
  p_version_id uuid,
  p_idempotency_key text,
  p_request_fingerprint_hash text,
  p_maintainer_auth_uuid text default null
)
returns table (
  issued_nonce text, purpose text, wire_report_public_ref text,
  version_public_ref text, actor_role text, decision_channel text,
  payload_hash text, quorum_hash text, proof_text text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.osi_nonces%rowtype;
  version_row public.wire_report_versions%rowtype;
  report_row public.wire_reports%rowtype;
  profile public.analyst_profiles%rowtype;
  quorum record;
  bootstrap record;
  support record;
  prior_published_id uuid;
  role_value text;
  channel_value text;
  bootstrap_tier_value text;
  quorum_hash_value text;
  exact_hash text;
  canonical_proof text;
  issued_time timestamptz := statement_timestamp();
  ttl_seconds integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Wire publication prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_wire_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Wire writes are disabled' using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-publication-idempotency:' || p_idempotency_key, 0)
  );
  select version.* into version_row from public.wire_report_versions as version
   where version.id = p_version_id for update;
  select report.* into report_row from public.wire_reports as report
   where report.id = version_row.wire_report_id for update;
  select nonce.* into existing from public.osi_nonces as nonce
   where nonce.idempotency_key = p_idempotency_key for update;
  if found then
    if existing.purpose <> 'WIRE_REPORT_PUBLISHED'
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.target_type <> 'wire_version'
       or existing.target_id is distinct from p_version_id::text
       or existing.binding_context->>'version_public_ref'
          is distinct from version_row.version_ref
       or existing.binding_context->>'wire_report_public_ref'
          is distinct from report_row.public_ref
       or coalesce(existing.binding_context->>'maintainer_auth_uuid', '')
          is distinct from coalesce(p_maintainer_auth_uuid, '') then
      raise exception 'Idempotency key is bound to another exact Wire publication'
        using errcode = '23514';
    end if;
    return query select existing.nonce, existing.purpose,
      existing.binding_context->>'wire_report_public_ref',
      existing.binding_context->>'version_public_ref',
      existing.binding_context->>'actor_role',
      existing.binding_context->>'decision_channel', existing.payload_hash,
      existing.binding_context->>'quorum_hash', existing.binding_context->>'proof_text',
      existing.issued_at, existing.expires_at,
      existing.consumed_by_receipt_id, true;
    return;
  end if;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = p_actor_wallet;
  if version_row.id is null or report_row.id is null or not report_row.native_intake
     or report_row.current_version_id is distinct from version_row.id
     or version_row.version_ref is null
     or version_row.lifecycle_state not in ('submitted', 'in_review')
     or p_actor_wallet = report_row.author_wallet then
    raise exception 'Wire version is not available for publication by this actor'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.wire_report_version_evidence as link
     where link.wire_report_version_id = version_row.id
  ) or exists (
    select 1
      from public.wire_report_version_evidence as link
      join public.evidence_items as evidence on evidence.id = link.evidence_item_id
     where link.wire_report_version_id = version_row.id
       and evidence.moderation_state = 'blocked'
  ) then
    raise exception 'Wire publication requires linked evidence with no safety block'
      using errcode = '42501';
  end if;
  select * into quorum from osi_private.osi_v2_wire_quorum(version_row.id);
  if quorum.approve_ready and exists (
    select 1 from public.wire_report_reviews as review
     where review.wire_report_version_id = version_row.id
       and review.reviewer_wallet = p_actor_wallet
       and review.decision = 'approve' and review.is_active = true
       and osi_private.osi_v2_sas_review_counts('wire_report', review.id)
  ) and osi_private.osi_v2_eligible_analyst(p_actor_wallet) then
    role_value := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
    channel_value := 'standard';
    quorum_hash_value := quorum.quorum_hash;
  else
    if osi_private.osi_v2_full_maintainer_binding(
      p_actor_wallet, p_maintainer_auth_uuid
    ) is distinct from true then
      raise exception 'Wire publication requires counted quorum or both maintainer gates'
        using errcode = '42501';
    end if;
    select * into bootstrap from osi_private.osi_v2_bootstrap_tier();
    select * into support from osi_private.osi_v2_wire_bootstrap_support(
      version_row.id, p_actor_wallet
    );
    if quorum.approve_ready
       or bootstrap.active is distinct from true
       or support.maintainer_conflicted
       or support.support_count < bootstrap.required_analyst_count
       or support.support_weight < bootstrap.required_analyst_weight then
      raise exception 'Wire bootstrap publication requirements are not met'
        using errcode = '42501';
    end if;
    role_value := 'maintainer';
    channel_value := 'maintainer_bootstrap';
    bootstrap_tier_value := bootstrap.tier;
    quorum_hash_value := support.support_hash;
  end if;
  prior_published_id := report_row.current_published_version_id;
  exact_hash := osi_private.osi_v2_wire_publication_payload_hash(
    version_row.id, version_row.version_ref, p_actor_wallet,
    version_row.title_public_safe, version_row.content_public_safe,
    version_row.body_private, version_row.uncertainties_private,
    version_row.evidence_snapshot_hash, quorum_hash_value, prior_published_id
  );
  perform osi_private.osi_v2_wire_action_rate(
    p_actor_wallet, p_request_fingerprint_hash, 'WIRE_REPORT_PUBLISHED', issued_time
  );
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into ttl_seconds from public.osi_config as config
   where config.key = 'OSI_V2_NONCE_TTL_SECONDS';
  if ttl_seconds is null or ttl_seconds not between 30 and 300 then
    raise exception 'Wire publication nonce configuration is invalid' using errcode = '55000';
  end if;
  canonical_proof := concat_ws('|', 'OSI2', '1', 'WIRE_REPORT_PUBLISHED',
    't=wire_version', 'id=' || version_row.version_ref,
    'a=' || p_actor_wallet, 'r=' || role_value, 'd=publish',
    'n=' || p_nonce, 'h=' || exact_hash,
    'ts=' || floor(extract(epoch from issued_time))::bigint,
    'exp=' || floor(extract(epoch from (
      issued_time + pg_catalog.make_interval(secs => ttl_seconds)
    )))::bigint);
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, 'WIRE_REPORT_PUBLISHED', p_actor_wallet, 'wire_version',
    version_row.id::text, exact_hash, p_idempotency_key,
    p_request_fingerprint_hash, jsonb_build_object(
      'actor_role', role_value,
      'bootstrap_tier', bootstrap_tier_value,
      'decision_channel', channel_value,
      'maintainer_auth_uuid', p_maintainer_auth_uuid,
      'previous_published_version_id', prior_published_id,
      'proof_text', canonical_proof,
      'quorum_hash', quorum_hash_value,
      'version_public_ref', version_row.version_ref,
      'wire_report_public_ref', report_row.public_ref
    ), issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds)
  );
  return query select p_nonce, 'WIRE_REPORT_PUBLISHED'::text,
    report_row.public_ref, version_row.version_ref, role_value, channel_value,
    exact_hash, quorum_hash_value, canonical_proof, issued_time,
    issued_time + pg_catalog.make_interval(secs => ttl_seconds), null::uuid, false;
end;
$$;

create function osi_private.osi_v2_commit_wire_publication(
  p_nonce text,
  p_tx_sig text,
  p_proof_text text,
  p_occurred_at timestamptz,
  p_maintainer_auth_uuid text default null
)
returns table (
  wire_report_public_ref text, version_public_ref text,
  decision_channel text, receipt_id uuid, lifecycle_state text,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  existing_receipt public.event_receipts%rowtype;
  version_row public.wire_report_versions%rowtype;
  prior_version public.wire_report_versions%rowtype;
  report_row public.wire_reports%rowtype;
  profile public.analyst_profiles%rowtype;
  quorum record;
  bootstrap record;
  support record;
  binding jsonb;
  channel_value text;
  expected_hash text;
  new_receipt_id uuid := gen_random_uuid();
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Wire publication commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_wire_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Wire writes are disabled' using errcode = '55000';
  end if;
  if p_tx_sig !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$' or p_occurred_at is null then
    raise exception 'Confirmed Wire publication Memo proof is invalid' using errcode = '22023';
  end if;
  select nonce.* into bound from public.osi_nonces as nonce
   where nonce.nonce = p_nonce for update;
  if bound.nonce is null or bound.purpose <> 'WIRE_REPORT_PUBLISHED'
     or bound.target_type <> 'wire_version' then
    raise exception 'Wire publication nonce binding is invalid' using errcode = '23514';
  end if;
  binding := bound.binding_context;
  channel_value := binding->>'decision_channel';
  if bound.consumed_at is not null then
    select receipt.* into existing_receipt from public.event_receipts as receipt
     where receipt.id = bound.consumed_by_receipt_id;
    select version.* into version_row from public.wire_report_versions as version
     where version.id = bound.target_id::uuid;
    if existing_receipt.id is null
       or existing_receipt.event_version <> 'OSI2'
       or existing_receipt.event_type <> 'WIRE_REPORT_PUBLISHED'
       or existing_receipt.target_type <> 'wire_version'
       or existing_receipt.target_id is distinct from bound.target_id
       or existing_receipt.public_ref is distinct from binding->>'version_public_ref'
       or existing_receipt.actor_wallet is distinct from bound.actor_wallet
       or existing_receipt.actor_role is distinct from binding->>'actor_role'
       or existing_receipt.decision <> 'publish'
       or existing_receipt.decision_channel is distinct from channel_value
       or existing_receipt.proof_type <> 'solana_memo'
       or existing_receipt.memo_ref is distinct from p_proof_text
       or existing_receipt.anchor_wallet is distinct from bound.actor_wallet
       or existing_receipt.payload_hash is distinct from bound.payload_hash
       or existing_receipt.nonce is distinct from bound.nonce
       or existing_receipt.tx_sig is distinct from p_tx_sig
       or existing_receipt.server_verified is distinct from true
       or existing_receipt.occurred_at is distinct from p_occurred_at
       or version_row.id is null
       or version_row.publication_receipt_id is distinct from existing_receipt.id then
      raise exception 'Consumed Wire publication nonce cannot change its exact proof'
        using errcode = '23514';
    end if;
    return query select binding->>'wire_report_public_ref',
      binding->>'version_public_ref', existing_receipt.decision_channel,
      existing_receipt.id, version_row.lifecycle_state, true;
    return;
  end if;
  if statement_timestamp() > bound.expires_at
     or p_proof_text is distinct from binding->>'proof_text'
     or p_occurred_at < bound.issued_at - interval '30 seconds'
     or p_occurred_at > bound.expires_at
     or p_occurred_at > statement_timestamp() + interval '30 seconds' then
    raise exception 'Wire publication proof is expired or changed' using errcode = '23514';
  end if;
  select version.* into version_row from public.wire_report_versions as version
   where version.id = bound.target_id::uuid for update;
  select report.* into report_row from public.wire_reports as report
   where report.id = version_row.wire_report_id for update;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = bound.actor_wallet;
  if version_row.id is null or report_row.id is null or not report_row.native_intake
     or report_row.current_version_id is distinct from version_row.id
     or version_row.lifecycle_state not in ('submitted', 'in_review')
     or bound.actor_wallet = report_row.author_wallet
     or report_row.current_published_version_id::text
        is distinct from nullif(binding->>'previous_published_version_id', '') then
    raise exception 'Wire publication lineage changed after prepare' using errcode = '40001';
  end if;
  if channel_value = 'standard' then
    select * into quorum from osi_private.osi_v2_wire_quorum(version_row.id);
    if not quorum.approve_ready
       or quorum.quorum_hash is distinct from binding->>'quorum_hash'
       or osi_private.osi_v2_eligible_analyst(bound.actor_wallet) is distinct from true
       or not exists (
         select 1 from public.wire_report_reviews as review
          where review.wire_report_version_id = version_row.id
            and review.reviewer_wallet = bound.actor_wallet
            and review.decision = 'approve' and review.is_active = true
            and osi_private.osi_v2_sas_review_counts('wire_report', review.id)
       ) then
      raise exception 'Wire publication quorum changed after prepare' using errcode = '40001';
    end if;
  elsif channel_value = 'maintainer_bootstrap' then
    if p_maintainer_auth_uuid is distinct from binding->>'maintainer_auth_uuid'
       or osi_private.osi_v2_full_maintainer_binding(
         bound.actor_wallet, p_maintainer_auth_uuid
       ) is distinct from true then
      raise exception 'Wire bootstrap publication lost a maintainer gate'
        using errcode = '42501';
    end if;
    select * into quorum from osi_private.osi_v2_wire_quorum(version_row.id);
    select * into bootstrap from osi_private.osi_v2_bootstrap_tier();
    select * into support from osi_private.osi_v2_wire_bootstrap_support(
      version_row.id, bound.actor_wallet
    );
    if quorum.approve_ready or bootstrap.active is distinct from true
       or bootstrap.tier is distinct from binding->>'bootstrap_tier'
       or support.maintainer_conflicted
       or support.support_hash is distinct from binding->>'quorum_hash'
       or support.support_count < bootstrap.required_analyst_count
       or support.support_weight < bootstrap.required_analyst_weight then
      raise exception 'Wire bootstrap requirements changed after prepare'
        using errcode = '40001';
    end if;
  else
    raise exception 'Wire publication channel is invalid' using errcode = '23514';
  end if;
  expected_hash := osi_private.osi_v2_wire_publication_payload_hash(
    version_row.id, version_row.version_ref, bound.actor_wallet,
    version_row.title_public_safe, version_row.content_public_safe,
    version_row.body_private, version_row.uncertainties_private,
    version_row.evidence_snapshot_hash, binding->>'quorum_hash',
    report_row.current_published_version_id
  );
  if expected_hash is distinct from bound.payload_hash then
    raise exception 'Wire publication payload changed after prepare' using errcode = '40001';
  end if;
  if not exists (
    select 1 from public.wire_report_version_evidence as link
     where link.wire_report_version_id = version_row.id
  ) or exists (
    select 1
      from public.wire_report_version_evidence as link
      join public.evidence_items as evidence on evidence.id = link.evidence_item_id
     where link.wire_report_version_id = version_row.id
       and evidence.moderation_state = 'blocked'
  ) then
    raise exception 'Wire publication evidence changed or was safety blocked'
      using errcode = '40001';
  end if;
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, proof_type, memo_ref, anchor_wallet,
    payload_hash, nonce, tx_sig, server_verified, occurred_at, created_at,
    decision_channel
  ) values (
    new_receipt_id, 'OSI2', 'WIRE_REPORT_PUBLISHED', 'wire_version',
    version_row.id::text, version_row.version_ref, bound.actor_wallet,
    binding->>'actor_role', 'publish', 'solana_memo', p_proof_text,
    bound.actor_wallet, bound.payload_hash, bound.nonce, p_tx_sig, true,
    p_occurred_at, statement_timestamp(), channel_value
  );
  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(), consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound.nonce and nonce.consumed_at is null;
  if not found then
    raise exception 'Wire publication nonce consumed concurrently' using errcode = '40001';
  end if;
  update public.evidence_items as evidence
     set moderation_state = 'approved', is_public = true,
         updated_at = statement_timestamp()
    from public.wire_report_version_evidence as link
   where link.wire_report_version_id = version_row.id
     and link.evidence_item_id = evidence.id
     and evidence.moderation_state in ('pending', 'approved')
     and (evidence.moderation_state <> 'approved' or evidence.is_public is distinct from true);
  if exists (
    select 1
      from public.wire_report_version_evidence as link
      join public.evidence_items as evidence on evidence.id = link.evidence_item_id
     where link.wire_report_version_id = version_row.id
       and (evidence.moderation_state <> 'approved' or evidence.is_public is distinct from true)
  ) then
    raise exception 'Wire publication evidence did not become public-safe'
      using errcode = '40001';
  end if;
  if version_row.lifecycle_state = 'submitted' then
    update public.wire_report_versions as version
       set lifecycle_state = 'in_review', updated_at = statement_timestamp()
     where version.id = version_row.id and version.lifecycle_state = 'submitted';
  end if;
  update public.wire_report_versions as version
     set lifecycle_state = 'published', published_at = p_occurred_at,
         publication_receipt_id = new_receipt_id,
         publication_quorum_hash = binding->>'quorum_hash',
         updated_at = statement_timestamp()
   where version.id = version_row.id and version.lifecycle_state = 'in_review';
  if not found then
    raise exception 'Wire publication state changed concurrently' using errcode = '40001';
  end if;
  if report_row.current_published_version_id is not null then
    select version.* into prior_version from public.wire_report_versions as version
     where version.id = report_row.current_published_version_id for update;
    update public.wire_report_versions as version
       set lifecycle_state = 'superseded', superseded_at = p_occurred_at,
           superseded_by_version_id = version_row.id,
           updated_at = statement_timestamp()
     where version.id = prior_version.id and version.lifecycle_state = 'published';
    if not found then
      raise exception 'Prior Wire publication changed concurrently' using errcode = '40001';
    end if;
  end if;
  update public.wire_reports as report
     set current_published_version_id = version_row.id,
         updated_at = statement_timestamp()
   where report.id = report_row.id
     and report.current_published_version_id is not distinct from report_row.current_published_version_id;
  if not found then
    raise exception 'Wire publication pointer changed concurrently' using errcode = '40001';
  end if;
  return query select report_row.public_ref, version_row.version_ref,
    channel_value, new_receipt_id, 'published'::text, false;
end;
$$;

create function osi_private.osi_v2_wire_review_payload_hash(
  p_event_type text,
  p_version_id uuid,
  p_version_ref text,
  p_actor_wallet text,
  p_decision text,
  p_reason_code text,
  p_public_rationale text,
  p_private_note text
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'actor_wallet', p_actor_wallet,
    'decision', p_decision,
    'event_type', p_event_type,
    'private_note', p_private_note,
    'public_rationale', p_public_rationale,
    'reason_code', p_reason_code,
    'version_id', p_version_id,
    'version_ref', p_version_ref
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;

create function osi_private.osi_v2_wire_publication_payload_hash(
  p_version_id uuid,
  p_version_ref text,
  p_actor_wallet text,
  p_title text,
  p_public_summary text,
  p_body text,
  p_uncertainties text,
  p_evidence_hash text,
  p_quorum_hash text,
  p_previous_published_version_id uuid
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'actor_wallet', p_actor_wallet,
    'body_private', p_body,
    'content_public_safe', p_public_summary,
    'event_type', 'WIRE_REPORT_PUBLISHED',
    'evidence_snapshot_hash', p_evidence_hash,
    'previous_published_version_id', p_previous_published_version_id,
    'quorum_hash', p_quorum_hash,
    'title_public_safe', p_title,
    'uncertainties_private', p_uncertainties,
    'version_id', p_version_id,
    'version_ref', p_version_ref
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;

create function osi_private.osi_v2_wire_quorum(p_version_id uuid)
returns table (
  version_id uuid,
  version_public_ref text,
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
  version_row public.wire_report_versions%rowtype;
  minimum_count integer;
  minimum_weight numeric;
  approval_count integer;
  approval_weight numeric;
  rejection_count integer;
  rejection_weight numeric;
  snapshot jsonb;
begin
  select version.* into version_row
    from public.wire_report_versions as version
   where version.id = p_version_id;
  if version_row.id is null then
    raise exception 'Wire version is not available' using errcode = '42501';
  end if;
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into minimum_count from public.osi_config as config
   where config.key = 'OSI_V2_WIRE_STANDARD_MIN_COUNT';
  select case when config.value ~ '^[0-9]+(?:\.[0-9]+)?$' then config.value::numeric end
    into minimum_weight from public.osi_config as config
   where config.key = 'OSI_V2_WIRE_STANDARD_MIN_WEIGHT';
  if minimum_count is null or minimum_count not between 2 and 10
     or minimum_weight is null or minimum_weight not between 1 and 20 then
    raise exception 'Wire quorum configuration is absent or invalid'
      using errcode = '55000';
  end if;
  with counted as (
    select review.public_ref, review.reviewer_wallet, review.decision,
      review.weight, review.tier_snapshot, review.created_at
      from public.wire_report_reviews as review
      join public.analyst_profiles as profile
        on profile.wallet = review.reviewer_wallet
      join public.event_receipts as receipt
        on receipt.id = review.event_receipt_id
       and receipt.event_version = 'OSI2'
       and receipt.event_type in ('WIRE_REPORT_REVIEW_CAST', 'WIRE_REPORT_REVIEW_REVISED')
       and receipt.target_type = 'wire_version'
       and receipt.target_id = review.wire_report_version_id::text
       and receipt.actor_wallet = review.reviewer_wallet
       and receipt.decision = review.decision
       and receipt.weight = review.weight
       and receipt.reason_code is not distinct from review.reason_code
       and receipt.proof_type = 'wallet_signed_server_verified'
       and receipt.server_verified = true
     where review.wire_report_version_id = p_version_id
       and review.is_active = true
       and review.public_ref is not null
       and profile.status in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
       and profile.verified = true
       and profile.approved = true
       and osi_private.osi_v2_sas_review_counts('wire_report', review.id)
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
  return query select version_row.id, version_row.version_ref,
    approval_count, approval_weight, rejection_count, rejection_weight,
    minimum_count, minimum_weight,
    approval_count >= minimum_count and approval_weight >= minimum_weight,
    rejection_count >= minimum_count and rejection_weight >= minimum_weight,
    encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
      'reviews', snapshot,
      'threshold_count', minimum_count,
      'threshold_weight', minimum_weight,
      'version_id', version_row.id,
      'version_ref', version_row.version_ref
    )::text, 'UTF8'), 'sha256'), 'hex');
end;
$$;

-- Preserve exact immutable content while allowing the Wire-only publication
-- and accepted-challenge markers to be written once by controlled RPCs.
create or replace function public.osi_v2_guard_report_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_core jsonb;
  new_core jsonb;
begin
  old_core := to_jsonb(old) - array[
    'content_public_safe', 'lifecycle_state', 'published_at', 'superseded_at',
    'superseded_by_version_id', 'publication_receipt_id',
    'publication_quorum_hash', 'contested_at', 'contested_receipt_id', 'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'content_public_safe', 'lifecycle_state', 'published_at', 'superseded_at',
    'superseded_by_version_id', 'publication_receipt_id',
    'publication_quorum_hash', 'contested_at', 'contested_receipt_id', 'updated_at'
  ];
  if new_core is distinct from old_core then
    raise exception 'Report version identity/private content/evidence are immutable'
      using errcode = '55000';
  end if;
  if new.content_public_safe is distinct from old.content_public_safe
     and old.lifecycle_state <> 'draft' then
    raise exception 'Submitted Report public-safe content is immutable'
      using errcode = '55000';
  end if;
  if not public.osi_v2_valid_report_version_transition(old.lifecycle_state, new.lifecycle_state) then
    raise exception 'Invalid Report version transition: % -> %', old.lifecycle_state, new.lifecycle_state
      using errcode = '23514';
  end if;
  if old.published_at is not null and new.published_at is distinct from old.published_at then
    raise exception 'Report published_at is write-once' using errcode = '55000';
  end if;
  if old.publication_receipt_id is not null
     and new.publication_receipt_id is distinct from old.publication_receipt_id then
    raise exception 'Report publication receipt is write-once' using errcode = '55000';
  end if;
  if to_jsonb(old)->>'publication_quorum_hash' is not null
     and to_jsonb(new)->>'publication_quorum_hash'
       is distinct from to_jsonb(old)->>'publication_quorum_hash' then
    raise exception 'Report publication quorum hash is write-once' using errcode = '55000';
  end if;
  if old.superseded_by_version_id is not null
     and new.superseded_by_version_id is distinct from old.superseded_by_version_id then
    raise exception 'Report supersession link is write-once' using errcode = '55000';
  end if;
  if to_jsonb(old)->>'contested_at' is not null and (
    to_jsonb(new)->>'contested_at' is distinct from to_jsonb(old)->>'contested_at'
    or to_jsonb(new)->>'contested_receipt_id'
      is distinct from to_jsonb(old)->>'contested_receipt_id'
  ) then
    raise exception 'Wire accepted-challenge marker is write-once' using errcode = '55000';
  end if;
  if (to_jsonb(new)->>'contested_at' is null)
     is distinct from (to_jsonb(new)->>'contested_receipt_id' is null) then
    raise exception 'Wire accepted-challenge marker requires timestamp and receipt'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create function osi_private.osi_v2_prepare_wire_review(
  p_nonce text,
  p_actor_wallet text,
  p_version_id uuid,
  p_decision text,
  p_reason_code text,
  p_public_rationale text,
  p_private_note text,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, purpose text, wire_report_public_ref text,
  version_public_ref text, review_public_ref text, actor_role text,
  payload_hash text, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.osi_nonces%rowtype;
  version_row public.wire_report_versions%rowtype;
  report_row public.wire_reports%rowtype;
  profile public.analyst_profiles%rowtype;
  event_type text;
  receipt_role text;
  review_id uuid := gen_random_uuid();
  review_ref text;
  exact_hash text;
  issued_time timestamptz := statement_timestamp();
  ttl_seconds integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Wire review prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_wire_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Wire writes are disabled' using errcode = '55000';
  end if;
  if p_decision not in ('approve', 'reject', 'request_revision', 'abstain')
     or p_reason_code is null or p_reason_code !~ '^[a-z][a-z0-9_:-]{0,95}$'
     or p_public_rationale is null or p_public_rationale <> btrim(p_public_rationale)
     or char_length(p_public_rationale) not between 10 and 2000
     or (p_private_note is not null and (
       p_private_note <> btrim(p_private_note)
       or char_length(p_private_note) not between 1 and 4000
     )) then
    raise exception 'Wire review payload is invalid' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-review-idempotency:' || p_idempotency_key, 0)
  );
  select nonce.* into existing from public.osi_nonces as nonce
   where nonce.idempotency_key = p_idempotency_key for update;
  if found then
    if existing.purpose not in ('WIRE_REPORT_REVIEW_CAST', 'WIRE_REPORT_REVIEW_REVISED')
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.target_type <> 'wire_version'
       or existing.target_id is distinct from p_version_id::text then
      raise exception 'Idempotency key is bound to another exact Wire review'
        using errcode = '23514';
    end if;
    exact_hash := osi_private.osi_v2_wire_review_payload_hash(
      existing.purpose, p_version_id,
      existing.binding_context->>'version_public_ref', p_actor_wallet,
      p_decision, p_reason_code, p_public_rationale, p_private_note
    );
    if existing.payload_hash is distinct from exact_hash then
      raise exception 'Idempotency key is bound to another exact Wire review'
        using errcode = '23514';
    end if;
    return query select existing.nonce, existing.purpose,
      existing.binding_context->>'wire_report_public_ref',
      existing.binding_context->>'version_public_ref',
      existing.binding_context->>'review_public_ref',
      existing.binding_context->>'actor_role', existing.payload_hash,
      existing.issued_at, existing.expires_at,
      existing.consumed_by_receipt_id, true;
    return;
  end if;
  select version.* into version_row from public.wire_report_versions as version
   where version.id = p_version_id for update;
  select report.* into report_row from public.wire_reports as report
   where report.id = version_row.wire_report_id for update;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = p_actor_wallet;
  if version_row.id is null or report_row.id is null or not report_row.native_intake
     or report_row.current_version_id is distinct from version_row.id
     or version_row.version_ref is null
     or version_row.lifecycle_state not in ('submitted', 'in_review') then
    raise exception 'Wire version is not available for review' using errcode = '42501';
  end if;
  if p_actor_wallet = report_row.author_wallet then
    raise exception 'Wire author cannot review this Wire version' using errcode = '42501';
  end if;
  if profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true
     or profile.weight_cached not between 0.50 and 3.00 then
    raise exception 'Actor is not an eligible Wire analyst' using errcode = '42501';
  end if;
  event_type := case when exists (
    select 1 from public.wire_report_reviews as review
     where review.wire_report_version_id = version_row.id
       and review.reviewer_wallet = p_actor_wallet
  ) then 'WIRE_REPORT_REVIEW_REVISED' else 'WIRE_REPORT_REVIEW_CAST' end;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  exact_hash := osi_private.osi_v2_wire_review_payload_hash(
    event_type, version_row.id, version_row.version_ref, p_actor_wallet,
    p_decision, p_reason_code, p_public_rationale, p_private_note
  );
  perform osi_private.osi_v2_wire_action_rate(
    p_actor_wallet, p_request_fingerprint_hash, event_type, issued_time
  );
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into ttl_seconds from public.osi_config as config
   where config.key = 'OSI_V2_NONCE_TTL_SECONDS';
  if ttl_seconds is null or ttl_seconds not between 30 and 300 then
    raise exception 'Wire review nonce configuration is invalid' using errcode = '55000';
  end if;
  review_ref := 'OSI-WRV-' || upper(substr(replace(review_id::text, '-', ''), 1, 16));
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, event_type, p_actor_wallet, 'wire_version', version_row.id::text,
    exact_hash, p_idempotency_key, p_request_fingerprint_hash,
    jsonb_build_object(
      'actor_role', receipt_role,
      'review_id', review_id,
      'review_public_ref', review_ref,
      'tier_snapshot', profile.tier_code,
      'version_public_ref', version_row.version_ref,
      'wire_report_public_ref', report_row.public_ref
    ), issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds)
  );
  return query select p_nonce, event_type, report_row.public_ref,
    version_row.version_ref, review_ref, receipt_role, exact_hash,
    issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds),
    null::uuid, false;
end;
$$;

create function osi_private.osi_v2_commit_wire_review(
  p_nonce text,
  p_decision text,
  p_reason_code text,
  p_public_rationale text,
  p_private_note text,
  p_signature text,
  p_message text
)
returns table (
  wire_report_public_ref text, version_public_ref text,
  review_public_ref text, actor_role text, decision text, weight numeric,
  tier_snapshot text, receipt_id uuid, approve_count integer,
  approve_weight numeric, required_count integer, required_weight numeric,
  approve_ready boolean, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  receipt public.event_receipts%rowtype;
  version_row public.wire_report_versions%rowtype;
  report_row public.wire_reports%rowtype;
  profile public.analyst_profiles%rowtype;
  prior public.wire_report_reviews%rowtype;
  review_row public.wire_report_reviews%rowtype;
  quorum record;
  expected_purpose text;
  receipt_role text;
  exact_hash text;
  new_review_id uuid;
  new_receipt_id uuid := gen_random_uuid();
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Wire review commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_wire_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Wire writes are disabled' using errcode = '55000';
  end if;
  select nonce.* into bound from public.osi_nonces as nonce
   where nonce.nonce = p_nonce for update;
  if bound.nonce is null
     or bound.purpose not in ('WIRE_REPORT_REVIEW_CAST', 'WIRE_REPORT_REVIEW_REVISED')
     or bound.target_type <> 'wire_version' then
    raise exception 'Wire review nonce binding is invalid' using errcode = '23514';
  end if;
  exact_hash := osi_private.osi_v2_wire_review_payload_hash(
    bound.purpose, bound.target_id::uuid,
    bound.binding_context->>'version_public_ref', bound.actor_wallet,
    p_decision, p_reason_code, p_public_rationale, p_private_note
  );
  if exact_hash is distinct from bound.payload_hash then
    raise exception 'Wire review payload changed after prepare' using errcode = '23514';
  end if;
  if bound.consumed_at is not null then
    select event.* into receipt from public.event_receipts as event
     where event.id = bound.consumed_by_receipt_id;
    select review.* into review_row from public.wire_report_reviews as review
     where review.event_receipt_id = receipt.id;
    if receipt.id is null or review_row.id is null
       or receipt.signature is distinct from p_signature
       or receipt.memo_ref is distinct from p_message
       or receipt.payload_hash is distinct from exact_hash
       or review_row.decision is distinct from p_decision
       or review_row.reason_code is distinct from p_reason_code
       or review_row.public_rationale is distinct from p_public_rationale
       or review_row.private_note is distinct from p_private_note then
      raise exception 'Consumed Wire review nonce does not match exact retry'
        using errcode = '23514';
    end if;
    select * into quorum from osi_private.osi_v2_wire_quorum(review_row.wire_report_version_id);
    return query select bound.binding_context->>'wire_report_public_ref',
      bound.binding_context->>'version_public_ref', review_row.public_ref,
      receipt.actor_role, review_row.decision, review_row.weight,
      review_row.tier_snapshot, receipt.id, quorum.approve_count,
      quorum.approve_weight, quorum.required_count, quorum.required_weight,
      quorum.approve_ready, true;
    return;
  end if;
  if statement_timestamp() > bound.expires_at then
    raise exception 'Wire review nonce expired' using errcode = '22023';
  end if;
  select version.* into version_row from public.wire_report_versions as version
   where version.id = bound.target_id::uuid for update;
  select report.* into report_row from public.wire_reports as report
   where report.id = version_row.wire_report_id for update;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = bound.actor_wallet;
  if version_row.id is null or not report_row.native_intake
     or report_row.current_version_id is distinct from version_row.id
     or version_row.version_ref is distinct from bound.binding_context->>'version_public_ref'
     or version_row.lifecycle_state not in ('submitted', 'in_review') then
    raise exception 'Wire version is not available for review' using errcode = '42501';
  end if;
  if bound.actor_wallet = report_row.author_wallet then
    raise exception 'Wire author cannot review this Wire version' using errcode = '42501';
  end if;
  if profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true
     or profile.weight_cached not between 0.50 and 3.00
     or profile.tier_code is distinct from bound.binding_context->>'tier_snapshot' then
    raise exception 'Actor is not an eligible Wire analyst' using errcode = '42501';
  end if;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  if receipt_role is distinct from bound.binding_context->>'actor_role' then
    raise exception 'Wire review actor role changed after prepare' using errcode = '42501';
  end if;
  select review.* into prior from public.wire_report_reviews as review
   where review.wire_report_version_id = version_row.id
     and review.reviewer_wallet = bound.actor_wallet
     and review.is_active = true for update;
  expected_purpose := case when exists (
    select 1 from public.wire_report_reviews as history
     where history.wire_report_version_id = version_row.id
       and history.reviewer_wallet = bound.actor_wallet
  ) then 'WIRE_REPORT_REVIEW_REVISED' else 'WIRE_REPORT_REVIEW_CAST' end;
  if bound.purpose is distinct from expected_purpose then
    raise exception 'Wire review history changed after prepare' using errcode = '40001';
  end if;
  new_review_id := (bound.binding_context->>'review_id')::uuid;
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, weight, reason_code, proof_type,
    memo_ref, anchor_wallet, payload_hash, nonce, tx_sig, signature,
    server_verified, occurred_at, created_at, decision_channel
  ) values (
    new_receipt_id, 'OSI2', bound.purpose, 'wire_version', version_row.id::text,
    version_row.version_ref, bound.actor_wallet, receipt_role, p_decision,
    profile.weight_cached, p_reason_code, 'wallet_signed_server_verified',
    p_message, null, exact_hash, bound.nonce, null, p_signature,
    true, statement_timestamp(), statement_timestamp(), 'standard'
  );
  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(), consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound.nonce and nonce.consumed_at is null;
  if not found then
    raise exception 'Wire review nonce consumed concurrently' using errcode = '40001';
  end if;
  if prior.id is not null then
    update public.wire_report_reviews as review
       set is_active = false, superseded_by = new_review_id,
           updated_at = statement_timestamp()
     where review.id = prior.id and review.is_active = true;
    if not found then
      raise exception 'Wire review changed concurrently' using errcode = '40001';
    end if;
  end if;
  if version_row.lifecycle_state = 'submitted' then
    update public.wire_report_versions as version
       set lifecycle_state = 'in_review', updated_at = statement_timestamp()
     where version.id = version_row.id and version.lifecycle_state = 'submitted';
    if not found then
      raise exception 'Wire review state changed concurrently' using errcode = '40001';
    end if;
  end if;
  insert into public.wire_report_reviews (
    id, wire_report_version_id, reviewer_wallet, decision, weight, reason_code,
    is_active, superseded_by, event_receipt_id, public_ref,
    reviewer_profile_wallet, tier_snapshot, public_rationale, private_note,
    created_at, updated_at
  ) values (
    new_review_id, version_row.id, bound.actor_wallet, p_decision,
    profile.weight_cached, p_reason_code, true, null, new_receipt_id,
    bound.binding_context->>'review_public_ref', profile.wallet,
    profile.tier_code, p_public_rationale, p_private_note,
    statement_timestamp(), statement_timestamp()
  ) returning * into review_row;
  if p_decision = 'request_revision' then
    update public.wire_report_versions as version
       set lifecycle_state = 'revision_requested', updated_at = statement_timestamp()
     where version.id = version_row.id and version.lifecycle_state = 'in_review';
  end if;
  select * into quorum from osi_private.osi_v2_wire_quorum(version_row.id);
  return query select report_row.public_ref, version_row.version_ref,
    review_row.public_ref, receipt_role, review_row.decision,
    review_row.weight, review_row.tier_snapshot, new_receipt_id,
    quorum.approve_count, quorum.approve_weight,
    quorum.required_count, quorum.required_weight, quorum.approve_ready, false;
end;
$$;

create function osi_private.osi_v2_prepare_wire_governance_action(
  p_nonce text,
  p_action text,
  p_actor_wallet text,
  p_target_ref text,
  p_payload jsonb,
  p_idempotency_key text,
  p_request_fingerprint_hash text,
  p_maintainer_auth_uuid text default null
)
returns table (
  issued_nonce text, purpose text, target_type text, target_id text,
  target_public_ref text, actor_role text, weight numeric,
  payload_hash text, quorum_hash text, proof_text text, proof_type text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.osi_nonces%rowtype;
  version_row public.wire_report_versions%rowtype;
  report_row public.wire_reports%rowtype;
  challenge_row public.challenges_v2%rowtype;
  evidence_row public.evidence_items%rowtype;
  profile public.analyst_profiles%rowtype;
  challenge_quorum record;
  action_purpose text;
  action_target_type text;
  action_target_id text;
  action_target_ref text;
  receipt_role text;
  snapshot_weight numeric;
  server_binding jsonb := '{}'::jsonb;
  exact_hash text;
  canonical_proof text;
  transport text;
  issued_time timestamptz := statement_timestamp();
  expires_time timestamptz;
  ttl_seconds integer;
  challenge_id uuid;
  review_id uuid;
  case_id uuid;
  case_ref text;
  cooldown_seconds integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Wire governance prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_wire_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Wire writes are disabled' using errcode = '55000';
  end if;
  if p_action not in (
    'challenge_submit', 'challenge_admit', 'challenge_review',
    'challenge_withdraw', 'challenge_finalize', 'wire_promote'
  ) or jsonb_typeof(p_payload) <> 'object'
     or p_actor_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    raise exception 'Wire governance action is invalid' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-governance-idempotency:' || p_idempotency_key, 0)
  );
  select nonce.* into existing from public.osi_nonces as nonce
   where nonce.idempotency_key = p_idempotency_key for update;
  if found then
    if existing.actor_wallet is distinct from p_actor_wallet
       or existing.binding_context->>'action' is distinct from p_action
       or existing.binding_context->>'target_ref' is distinct from p_target_ref
       or existing.binding_context->'client_payload' is distinct from p_payload
       or coalesce(existing.binding_context->>'maintainer_auth_uuid', '')
          is distinct from coalesce(p_maintainer_auth_uuid, '') then
      raise exception 'Idempotency key is bound to another exact Wire governance action'
        using errcode = '23514';
    end if;
    return query select existing.nonce, existing.purpose,
      existing.target_type, existing.target_id,
      existing.binding_context->>'target_public_ref',
      existing.binding_context->>'actor_role',
      nullif(existing.binding_context->>'weight', '')::numeric,
      existing.payload_hash,
      existing.binding_context->'server_binding'->>'quorum_hash',
      existing.binding_context->>'proof_text',
      public.osi_v2_expected_proof_type(existing.purpose),
      existing.issued_at, existing.expires_at,
      existing.consumed_by_receipt_id, true;
    return;
  end if;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = p_actor_wallet;

  if p_action = 'challenge_submit' then
    if p_payload->>'reason_code' !~ '^[a-z][a-z0-9_:-]{0,95}$'
       or p_payload->>'public_safe_summary' is null
       or p_payload->>'public_safe_summary' <> btrim(p_payload->>'public_safe_summary')
       or char_length(p_payload->>'public_safe_summary') not between 20 and 2000
       or (p_payload ? 'restricted_detail' and p_payload->>'restricted_detail' is not null and (
         p_payload->>'restricted_detail' <> btrim(p_payload->>'restricted_detail')
         or char_length(p_payload->>'restricted_detail') not between 1 and 8000
       ))
       or p_payload->>'evidence_ordinal' !~ '^([1-9]|1[0-2])$'
       or p_payload->>'evidence_sha256' !~ '^[0-9a-f]{64}$' then
      raise exception 'Wire challenge submission payload is invalid' using errcode = '22023';
    end if;
    select version.* into version_row from public.wire_report_versions as version
     where version.version_ref = p_target_ref for update;
    select report.* into report_row from public.wire_reports as report
     where report.id = version_row.wire_report_id for update;
    select evidence.* into evidence_row
      from public.wire_report_version_evidence as exact_link
      join public.evidence_items as evidence
        on evidence.id = exact_link.evidence_item_id
     where exact_link.wire_report_version_id = version_row.id
       and exact_link.ordinal = (p_payload->>'evidence_ordinal')::integer
       and evidence.sha256 = p_payload->>'evidence_sha256';
    if version_row.id is null or version_row.lifecycle_state <> 'published'
       or report_row.current_published_version_id is distinct from version_row.id
       or not report_row.native_intake or evidence_row.id is null
       or evidence_row.is_public is distinct from true
       or evidence_row.moderation_state <> 'approved'
       or not exists (
         select 1 from public.wire_report_version_evidence as link
          where link.wire_report_version_id = version_row.id
            and link.evidence_item_id = evidence_row.id
       ) then
      raise exception 'Challenge requires one exact current published Wire version and linked evidence'
        using errcode = '42501';
    end if;
    if exists (
      select 1 from public.challenges_v2 as challenge
       where challenge.challenger_wallet = p_actor_wallet
         and challenge.wire_report_version_id = version_row.id
         and challenge.state in ('submitted', 'admissibility_review', 'open', 'under_review')
    ) then
      raise exception 'An active challenge already exists for this wallet and Wire version'
        using errcode = '23505';
    end if;
    cooldown_seconds := osi_private.osi_v2_config_integer(
      'OSI_V2_CHALLENGE_COOLDOWN_SECONDS', 1, 86400
    );
    if exists (
      select 1 from public.challenges_v2 as challenge
       where challenge.challenger_wallet = p_actor_wallet
         and challenge.wire_report_version_id = version_row.id
         and challenge.created_at > issued_time
           - pg_catalog.make_interval(secs => cooldown_seconds)
    ) then
      raise exception 'Wire challenge cooldown is active' using errcode = 'P0001';
    end if;
    perform osi_private.osi_v2_check_challenge_rate(
      p_actor_wallet, p_request_fingerprint_hash, issued_time
    );
    challenge_id := gen_random_uuid();
    action_purpose := 'CHALLENGE_SUBMITTED';
    action_target_type := 'challenge';
    action_target_id := challenge_id::text;
    action_target_ref := osi_private.osi_v2_make_public_ref('OSI-CHL-', challenge_id);
    receipt_role := 'wallet';
    server_binding := jsonb_build_object(
      'challenge_id', challenge_id,
      'challenge_public_ref', action_target_ref,
      'decision_channel', 'standard',
      'evidence_hash', evidence_row.sha256,
      'evidence_item_id', evidence_row.id,
      'version_id', version_row.id,
      'version_public_ref', version_row.version_ref,
      'wire_report_id', report_row.id,
      'wire_report_public_ref', report_row.public_ref
    );

  elsif p_action in (
    'challenge_admit', 'challenge_review', 'challenge_withdraw', 'challenge_finalize'
  ) then
    select challenge.* into challenge_row from public.challenges_v2 as challenge
     where challenge.public_ref = p_target_ref for update;
    select version.* into version_row from public.wire_report_versions as version
     where version.id = challenge_row.wire_report_version_id;
    select report.* into report_row from public.wire_reports as report
     where report.id = version_row.wire_report_id;
    if challenge_row.id is null or challenge_row.target_kind <> 'wire_report_version'
       or version_row.id is null or report_row.id is null then
      raise exception 'Wire challenge is not available' using errcode = '42501';
    end if;
    if p_action <> 'challenge_withdraw'
       and p_actor_wallet in (challenge_row.challenger_wallet, report_row.author_wallet) then
      raise exception 'Wire challenger and author are conflicted from adjudication'
        using errcode = '42501';
    end if;
    if p_action = 'challenge_admit' then
      if challenge_row.state not in ('submitted', 'admissibility_review')
         or issued_time >= challenge_row.admissibility_ttl_at
         or p_payload->>'decision' not in ('accept', 'reject') then
        raise exception 'Wire challenge is not available for admissibility'
          using errcode = '42501';
      end if;
      if osi_private.osi_v2_full_maintainer_binding(
        p_actor_wallet, p_maintainer_auth_uuid
      ) then
        receipt_role := 'maintainer';
      elsif osi_private.osi_v2_eligible_analyst(p_actor_wallet) then
        receipt_role := case when profile.status = 'senior_analyst'
          then 'senior' else 'analyst' end;
        snapshot_weight := profile.weight_cached;
      else
        raise exception 'Wire admissibility requires an eligible analyst or full maintainer'
          using errcode = '42501';
      end if;
      action_purpose := case when p_payload->>'decision' = 'accept'
        then 'CHALLENGE_ADMISSIBILITY_ACCEPTED'
        else 'CHALLENGE_ADMISSIBILITY_REJECTED' end;
    elsif p_action = 'challenge_review' then
      if challenge_row.state not in ('open', 'under_review')
         or issued_time >= challenge_row.review_deadline_at
         or osi_private.osi_v2_eligible_analyst(p_actor_wallet) is distinct from true
         or p_payload->>'decision' not in ('accept', 'reject')
         or p_payload->>'reason_code' !~ '^[a-z][a-z0-9_:-]{0,95}$'
         or p_payload->>'public_rationale' is null
         or p_payload->>'public_rationale' <> btrim(p_payload->>'public_rationale')
         or char_length(p_payload->>'public_rationale') not between 10 and 2000
         or (p_payload ? 'private_note' and p_payload->>'private_note' is not null and (
           p_payload->>'private_note' <> btrim(p_payload->>'private_note')
           or char_length(p_payload->>'private_note') not between 1 and 4000
         )) then
        raise exception 'Wire challenge review payload or actor is invalid'
          using errcode = '42501';
      end if;
      review_id := gen_random_uuid();
      action_purpose := case when exists (
        select 1 from public.challenge_reviews as review
         where review.challenge_id = challenge_row.id
           and review.reviewer_wallet = p_actor_wallet and review.phase = 'merit'
      ) then 'CHALLENGE_REVIEW_REVISED' else 'CHALLENGE_REVIEW_CAST' end;
      receipt_role := case when profile.status = 'senior_analyst'
        then 'senior' else 'analyst' end;
      snapshot_weight := profile.weight_cached;
      server_binding := server_binding || jsonb_build_object(
        'review_id', review_id,
        'review_public_ref', osi_private.osi_v2_make_public_ref('OSI-CRV-', review_id),
        'tier_snapshot', profile.tier_code,
        'weight', snapshot_weight
      );
    elsif p_action = 'challenge_withdraw' then
      if challenge_row.challenger_wallet <> p_actor_wallet
         or challenge_row.state not in (
           'submitted', 'admissibility_review', 'open', 'under_review'
         ) then
        raise exception 'Only the challenger may withdraw this active Wire challenge'
          using errcode = '42501';
      end if;
      action_purpose := 'CHALLENGE_WITHDRAWN';
      receipt_role := 'wallet';
    else
      if challenge_row.state <> 'under_review'
         or issued_time >= challenge_row.review_deadline_at
         or osi_private.osi_v2_eligible_analyst(p_actor_wallet) is distinct from true then
        raise exception 'Wire challenge outcome is not available' using errcode = '42501';
      end if;
      select * into challenge_quorum
        from osi_private.osi_v2_challenge_quorum(challenge_row.id);
      if challenge_quorum.outcome is null or challenge_quorum.tie_unresolved
         or not exists (
           select 1 from public.challenge_reviews as review
            where review.challenge_id = challenge_row.id and review.phase = 'merit'
              and review.reviewer_wallet = p_actor_wallet and review.is_active = true
              and review.decision = challenge_quorum.outcome
         ) then
        raise exception 'Wire challenge has no unique analyst quorum outcome'
          using errcode = '42501';
      end if;
      action_purpose := case when challenge_quorum.outcome = 'accept'
        then 'CHALLENGE_ACCEPTED' else 'CHALLENGE_REJECTED' end;
      receipt_role := case when profile.status = 'senior_analyst'
        then 'senior' else 'analyst' end;
      server_binding := server_binding || jsonb_build_object(
        'quorum_hash', challenge_quorum.quorum_hash
      );
    end if;
    action_target_type := 'challenge';
    action_target_id := challenge_row.id::text;
    action_target_ref := challenge_row.public_ref;
    server_binding := server_binding || jsonb_build_object(
      'challenge_id', challenge_row.id,
      'challenge_public_ref', challenge_row.public_ref,
      'decision_channel', 'standard',
      'version_id', version_row.id,
      'version_public_ref', version_row.version_ref,
      'wire_report_id', report_row.id,
      'wire_report_public_ref', report_row.public_ref
    );

  else
    if osi_private.osi_v2_case_writes_enabled() is distinct from true then
      raise exception 'OSI V2 Case writes are disabled' using errcode = '55000';
    end if;
    if p_payload <> '{}'::jsonb then
      raise exception 'Wire promotion accepts no client-derived Case fields'
        using errcode = '22023';
    end if;
    select version.* into version_row from public.wire_report_versions as version
     where version.version_ref = p_target_ref for update;
    select report.* into report_row from public.wire_reports as report
     where report.id = version_row.wire_report_id for update;
    if version_row.id is null or version_row.lifecycle_state <> 'published'
       or report_row.current_published_version_id is distinct from version_row.id
       or report_row.promoted_to_case_id is not null then
      raise exception 'Only one exact current published Wire version may be promoted'
        using errcode = '42501';
    end if;
    if osi_private.osi_v2_eligible_analyst(p_actor_wallet) then
      receipt_role := case when profile.status = 'senior_analyst'
        then 'senior' else 'analyst' end;
    elsif osi_private.osi_v2_full_maintainer_binding(
      p_actor_wallet, p_maintainer_auth_uuid
    ) then
      receipt_role := 'maintainer';
    else
      raise exception 'Wire promotion requires an eligible analyst or full maintainer'
        using errcode = '42501';
    end if;
    case_id := gen_random_uuid();
    case_ref := 'OSI-' || upper(substr(replace(case_id::text, '-', ''), 1, 12));
    action_purpose := 'WIRE_PROMOTED';
    action_target_type := 'wire_version';
    action_target_id := version_row.id::text;
    action_target_ref := version_row.version_ref;
    server_binding := jsonb_build_object(
      'case_id', case_id,
      'case_public_ref', case_ref,
      'decision_channel', 'standard',
      'version_id', version_row.id,
      'version_public_ref', version_row.version_ref,
      'wire_report_id', report_row.id,
      'wire_report_public_ref', report_row.public_ref
    );
  end if;

  ttl_seconds := osi_private.osi_v2_config_integer('OSI_V2_NONCE_TTL_SECONDS', 30, 300);
  expires_time := issued_time + pg_catalog.make_interval(secs => ttl_seconds);
  exact_hash := osi_private.osi_v2_governance_payload_hash(
    p_action, action_purpose, p_actor_wallet, action_target_type,
    action_target_id, p_payload, server_binding
  );
  transport := public.osi_v2_expected_proof_type(action_purpose);
  if transport not in ('wallet_signed_server_verified', 'solana_memo') then
    raise exception 'Wire governance event transport is not canonical'
      using errcode = '55000';
  end if;
  canonical_proof := concat_ws('|', 'OSI2', action_purpose,
    't=' || action_target_type, 'id=' || action_target_id,
    'ref=' || action_target_ref, 'a=' || p_actor_wallet,
    'h=' || exact_hash, 'n=' || p_nonce,
    'ts=' || floor(extract(epoch from issued_time) * 1000)::bigint,
    'exp=' || floor(extract(epoch from expires_time) * 1000)::bigint
  );
  if p_action <> 'challenge_submit' then
    perform osi_private.osi_v2_wire_action_rate(
      p_actor_wallet, p_request_fingerprint_hash, action_purpose, issued_time
    );
  end if;
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, action_purpose, p_actor_wallet, action_target_type, action_target_id,
    exact_hash, p_idempotency_key, p_request_fingerprint_hash,
    jsonb_build_object(
      'action', p_action, 'actor_role', receipt_role,
      'client_payload', p_payload,
      'maintainer_auth_uuid', coalesce(p_maintainer_auth_uuid, ''),
      'proof_text', canonical_proof, 'server_binding', server_binding,
      'target_public_ref', action_target_ref, 'target_ref', p_target_ref,
      'weight', coalesce(snapshot_weight::text, '')
    ), issued_time, expires_time
  );
  return query select p_nonce, action_purpose, action_target_type,
    action_target_id, action_target_ref, receipt_role, snapshot_weight,
    exact_hash, server_binding->>'quorum_hash', canonical_proof, transport,
    issued_time, expires_time, null::uuid, false;
end;
$$;

create function osi_private.osi_v2_commit_wire_governance_action(
  p_nonce text,
  p_payload jsonb,
  p_signature text,
  p_tx_sig text,
  p_proof_text text,
  p_occurred_at timestamptz,
  p_maintainer_auth_uuid text default null
)
returns table (
  action text, purpose text, target_public_ref text,
  wire_report_public_ref text, version_public_ref text,
  challenge_public_ref text, case_public_ref text, state text,
  receipt_id uuid, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  existing_receipt public.event_receipts%rowtype;
  version_row public.wire_report_versions%rowtype;
  report_row public.wire_reports%rowtype;
  challenge_row public.challenges_v2%rowtype;
  evidence_row public.evidence_items%rowtype;
  profile public.analyst_profiles%rowtype;
  prior_review public.challenge_reviews%rowtype;
  challenge_quorum record;
  context jsonb;
  binding jsonb;
  action_name text;
  receipt_role text;
  transport text;
  expected_hash text;
  review_id uuid;
  new_receipt_id uuid := gen_random_uuid();
  decision_value text;
  reason_value text;
  receipt_weight numeric;
  result_challenge_ref text;
  result_case_ref text;
  result_state text;
  review_deadline_seconds integer;
  admissibility_ttl_seconds integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Wire governance commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_wire_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Wire writes are disabled' using errcode = '55000';
  end if;
  select nonce.* into bound from public.osi_nonces as nonce
   where nonce.nonce = p_nonce for update;
  if bound.nonce is null or bound.binding_context->>'action' is null then
    raise exception 'Wire governance nonce binding is invalid' using errcode = '23514';
  end if;
  context := bound.binding_context;
  binding := context->'server_binding';
  action_name := context->>'action';
  receipt_role := context->>'actor_role';
  transport := public.osi_v2_expected_proof_type(bound.purpose);
  if binding->>'decision_channel' is distinct from 'standard' then
    raise exception 'Bootstrap channel is unreachable for Wire challenges and promotion'
      using errcode = '23514';
  end if;
  if context->'client_payload' is distinct from p_payload
     or context->>'proof_text' is distinct from p_proof_text
     or coalesce(context->>'maintainer_auth_uuid', '')
        is distinct from coalesce(p_maintainer_auth_uuid, '') then
    raise exception 'Wire governance payload, proof or maintainer binding changed'
      using errcode = '23514';
  end if;
  expected_hash := osi_private.osi_v2_governance_payload_hash(
    action_name, bound.purpose, bound.actor_wallet, bound.target_type,
    bound.target_id, p_payload, binding
  );
  if expected_hash is distinct from bound.payload_hash then
    raise exception 'Wire governance payload hash binding is invalid'
      using errcode = '23514';
  end if;
  if bound.consumed_at is not null then
    select receipt.* into existing_receipt from public.event_receipts as receipt
     where receipt.id = bound.consumed_by_receipt_id;
    if existing_receipt.id is null
       or existing_receipt.event_type is distinct from bound.purpose
       or existing_receipt.payload_hash is distinct from bound.payload_hash
       or existing_receipt.memo_ref is distinct from p_proof_text
       or existing_receipt.signature is distinct from p_signature
       or existing_receipt.tx_sig is distinct from p_tx_sig then
      raise exception 'Consumed Wire governance nonce does not match exact retry'
        using errcode = '23514';
    end if;
    return query select action_name, bound.purpose,
      context->>'target_public_ref', binding->>'wire_report_public_ref',
      binding->>'version_public_ref', binding->>'challenge_public_ref',
      binding->>'case_public_ref',
      coalesce((select challenge.state from public.challenges_v2 as challenge
        where challenge.id::text = bound.target_id),
        case when action_name = 'wire_promote' then 'initial_review' end),
      existing_receipt.id, true;
    return;
  end if;
  if statement_timestamp() > bound.expires_at then
    raise exception 'Wire governance nonce expired' using errcode = '22023';
  end if;
  if transport = 'wallet_signed_server_verified' then
    if p_signature is null or char_length(p_signature) not between 64 and 256
       or p_tx_sig is not null or p_occurred_at is not null then
      raise exception 'Signed Wire governance proof material is invalid'
        using errcode = '23514';
    end if;
  elsif transport = 'solana_memo' then
    if p_signature is not null or p_tx_sig !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'
       or p_occurred_at is null
       or p_occurred_at > statement_timestamp() + interval '30 seconds'
       or p_occurred_at < bound.issued_at - interval '30 seconds' then
      raise exception 'Memo Wire governance proof material is invalid'
        using errcode = '23514';
    end if;
  else
    raise exception 'Wire governance event transport is invalid' using errcode = '55000';
  end if;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = bound.actor_wallet;

  if action_name = 'challenge_submit' then
    select version.* into version_row from public.wire_report_versions as version
     where version.id = (binding->>'version_id')::uuid for update;
    select report.* into report_row from public.wire_reports as report
     where report.id = version_row.wire_report_id for update;
    select evidence.* into evidence_row from public.evidence_items as evidence
     where evidence.id = (binding->>'evidence_item_id')::uuid;
    if version_row.lifecycle_state <> 'published'
       or report_row.current_published_version_id is distinct from version_row.id
       or evidence_row.sha256 is distinct from binding->>'evidence_hash'
       or evidence_row.is_public is distinct from true
       or evidence_row.moderation_state <> 'approved'
       or not exists (
         select 1 from public.wire_report_version_evidence as link
          where link.wire_report_version_id = version_row.id
            and link.evidence_item_id = evidence_row.id
       )
       or exists (
         select 1 from public.challenges_v2 as challenge
          where challenge.challenger_wallet = bound.actor_wallet
            and challenge.wire_report_version_id = version_row.id
            and challenge.state in ('submitted', 'admissibility_review', 'open', 'under_review')
       ) then
      raise exception 'Wire challenge target or evidence binding changed'
        using errcode = '40001';
    end if;
    result_challenge_ref := binding->>'challenge_public_ref';
    result_state := 'submitted';

  elsif action_name in (
    'challenge_admit', 'challenge_review', 'challenge_withdraw', 'challenge_finalize'
  ) then
    select challenge.* into challenge_row from public.challenges_v2 as challenge
     where challenge.id = bound.target_id::uuid for update;
    select version.* into version_row from public.wire_report_versions as version
     where version.id = challenge_row.wire_report_version_id for update;
    select report.* into report_row from public.wire_reports as report
     where report.id = version_row.wire_report_id for update;
    if challenge_row.public_ref is distinct from binding->>'challenge_public_ref'
       or challenge_row.target_kind <> 'wire_report_version' then
      raise exception 'Wire challenge identity changed after prepare'
        using errcode = '40001';
    end if;
    if action_name <> 'challenge_withdraw'
       and bound.actor_wallet in (challenge_row.challenger_wallet, report_row.author_wallet) then
      raise exception 'Wire challenge actor is now conflicted' using errcode = '42501';
    end if;
    if action_name = 'challenge_admit' then
      if challenge_row.state not in ('submitted', 'admissibility_review')
         or statement_timestamp() >= challenge_row.admissibility_ttl_at then
        raise exception 'Wire challenge admissibility state changed'
          using errcode = '40001';
      end if;
      if receipt_role = 'maintainer' then
        if osi_private.osi_v2_full_maintainer_binding(
          bound.actor_wallet, p_maintainer_auth_uuid
        ) is distinct from true then
          raise exception 'Wire admissibility lost a maintainer gate'
            using errcode = '42501';
        end if;
      elsif osi_private.osi_v2_eligible_analyst(bound.actor_wallet) is distinct from true then
        raise exception 'Wire admissibility analyst is no longer eligible'
          using errcode = '42501';
      end if;
      receipt_weight := nullif(context->>'weight', '')::numeric;
    elsif action_name = 'challenge_review' then
      if challenge_row.state not in ('open', 'under_review')
         or statement_timestamp() >= challenge_row.review_deadline_at
         or osi_private.osi_v2_eligible_analyst(bound.actor_wallet) is distinct from true
         or profile.tier_code is distinct from binding->>'tier_snapshot'
         or profile.weight_cached is distinct from (binding->>'weight')::numeric then
        raise exception 'Wire challenge review eligibility changed'
          using errcode = '40001';
      end if;
      review_id := (binding->>'review_id')::uuid;
      select review.* into prior_review from public.challenge_reviews as review
       where review.challenge_id = challenge_row.id and review.phase = 'merit'
         and review.reviewer_wallet = bound.actor_wallet and review.is_active = true
       for update;
      receipt_weight := profile.weight_cached;
    elsif action_name = 'challenge_withdraw' then
      if challenge_row.challenger_wallet <> bound.actor_wallet
         or challenge_row.state not in (
           'submitted', 'admissibility_review', 'open', 'under_review'
         ) then
        raise exception 'Wire challenge is no longer withdrawable by this wallet'
          using errcode = '40001';
      end if;
    else
      select * into challenge_quorum
        from osi_private.osi_v2_challenge_quorum(challenge_row.id);
      if challenge_row.state <> 'under_review'
         or statement_timestamp() >= challenge_row.review_deadline_at
         or osi_private.osi_v2_eligible_analyst(bound.actor_wallet) is distinct from true
         or challenge_quorum.quorum_hash is distinct from binding->>'quorum_hash'
         or bound.purpose is distinct from (case when challenge_quorum.outcome = 'accept'
           then 'CHALLENGE_ACCEPTED' else 'CHALLENGE_REJECTED' end)
         or not exists (
           select 1 from public.challenge_reviews as review
            where review.challenge_id = challenge_row.id and review.phase = 'merit'
              and review.reviewer_wallet = bound.actor_wallet and review.is_active = true
              and review.decision = challenge_quorum.outcome
         ) then
        raise exception 'Wire challenge quorum changed after prepare'
          using errcode = '40001';
      end if;
    end if;
    result_challenge_ref := challenge_row.public_ref;
    result_state := challenge_row.state;

  else
    if osi_private.osi_v2_case_writes_enabled() is distinct from true then
      raise exception 'OSI V2 Case writes are disabled' using errcode = '55000';
    end if;
    select version.* into version_row from public.wire_report_versions as version
     where version.id = bound.target_id::uuid for update;
    select report.* into report_row from public.wire_reports as report
     where report.id = version_row.wire_report_id for update;
    if version_row.lifecycle_state <> 'published'
       or report_row.current_published_version_id is distinct from version_row.id
       or report_row.promoted_to_case_id is not null then
      raise exception 'Wire promotion target changed after prepare'
        using errcode = '40001';
    end if;
    if receipt_role in ('analyst', 'senior') then
      if osi_private.osi_v2_eligible_analyst(bound.actor_wallet) is distinct from true then
        raise exception 'Wire promotion analyst is no longer eligible'
          using errcode = '42501';
      end if;
    elsif receipt_role = 'maintainer' then
      if osi_private.osi_v2_full_maintainer_binding(
        bound.actor_wallet, p_maintainer_auth_uuid
      ) is distinct from true then
        raise exception 'Wire promotion lost a maintainer gate' using errcode = '42501';
      end if;
    else
      raise exception 'Wire promotion actor role is invalid' using errcode = '42501';
    end if;
    result_case_ref := binding->>'case_public_ref';
    result_state := 'initial_review';
  end if;

  decision_value := coalesce(p_payload->>'decision', case
    when bound.purpose = 'CHALLENGE_SUBMITTED' then 'submit'
    when bound.purpose = 'CHALLENGE_WITHDRAWN' then 'withdraw'
    when bound.purpose = 'CHALLENGE_ACCEPTED' then 'accept'
    when bound.purpose = 'CHALLENGE_REJECTED' then 'reject'
    when bound.purpose = 'WIRE_PROMOTED' then 'promote'
    else 'record' end);
  reason_value := p_payload->>'reason_code';
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, weight, reason_code, proof_type,
    memo_ref, anchor_wallet, payload_hash, nonce, tx_sig, signature,
    server_verified, occurred_at, created_at, decision_channel
  ) values (
    new_receipt_id, 'OSI2', bound.purpose, bound.target_type, bound.target_id,
    case when action_name = 'challenge_review'
      then binding->>'review_public_ref' else context->>'target_public_ref' end,
    bound.actor_wallet, receipt_role, decision_value, receipt_weight,
    reason_value, transport, p_proof_text,
    case when transport = 'solana_memo' then bound.actor_wallet else null end,
    bound.payload_hash, bound.nonce, p_tx_sig, p_signature, true,
    coalesce(p_occurred_at, statement_timestamp()), statement_timestamp(), 'standard'
  );
  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(), consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound.nonce and nonce.consumed_at is null;
  if not found then
    raise exception 'Wire governance nonce consumed concurrently' using errcode = '40001';
  end if;

  if action_name = 'challenge_submit' then
    admissibility_ttl_seconds := osi_private.osi_v2_config_integer(
      'OSI_V2_CHALLENGE_ADMISSIBILITY_TTL_SECONDS', 300, 604800
    );
    insert into public.challenges_v2 (
      id, challenger_wallet, reason_code, wire_report_version_id, target_kind,
      evidence_item_id, state, admissibility_ttl_at, cooldown_key,
      submitted_receipt_id, public_ref, public_safe_summary,
      restricted_detail, evidence_hash, created_at, updated_at
    ) values (
      (binding->>'challenge_id')::uuid, bound.actor_wallet,
      p_payload->>'reason_code', version_row.id, 'wire_report_version',
      evidence_row.id, 'submitted',
      bound.issued_at + pg_catalog.make_interval(secs => admissibility_ttl_seconds),
      'wire:' || version_row.id::text || ':wallet:' || bound.actor_wallet,
      new_receipt_id, binding->>'challenge_public_ref',
      p_payload->>'public_safe_summary', p_payload->>'restricted_detail',
      evidence_row.sha256, statement_timestamp(), statement_timestamp()
    );

  elsif action_name = 'challenge_admit' then
    if challenge_row.state = 'submitted' then
      update public.challenges_v2 as challenge
         set state = 'admissibility_review', updated_at = statement_timestamp()
       where challenge.id = challenge_row.id and challenge.state = 'submitted';
    end if;
    if p_payload->>'decision' = 'accept' then
      review_deadline_seconds := osi_private.osi_v2_config_integer(
        'OSI_V2_CHALLENGE_REVIEW_DEADLINE_SECONDS', 3600, 1209600
      );
      update public.challenges_v2 as challenge
         set state = 'open', admitted_by_wallet = bound.actor_wallet,
             review_deadline_at = statement_timestamp()
               + pg_catalog.make_interval(secs => review_deadline_seconds),
             opened_receipt_id = new_receipt_id, updated_at = statement_timestamp()
       where challenge.id = challenge_row.id and challenge.state = 'admissibility_review';
      result_state := 'open';
    else
      update public.challenges_v2 as challenge
         set state = 'rejected', admitted_by_wallet = bound.actor_wallet,
             resolved_receipt_id = new_receipt_id, terminal_at = statement_timestamp(),
             updated_at = statement_timestamp()
       where challenge.id = challenge_row.id and challenge.state = 'admissibility_review';
      result_state := 'rejected';
    end if;

  elsif action_name = 'challenge_review' then
    if prior_review.id is not null then
      update public.challenge_reviews as review
         set is_active = false, superseded_by = review_id,
             updated_at = statement_timestamp()
       where review.id = prior_review.id and review.is_active = true;
      if not found then
        raise exception 'Wire challenge review changed concurrently'
          using errcode = '40001';
      end if;
    end if;
    insert into public.challenge_reviews (
      id, challenge_id, phase, reviewer_wallet, decision, weight, reason_code,
      is_active, event_receipt_id, public_ref, reviewer_profile_wallet,
      tier_snapshot, public_rationale, private_note, created_at, updated_at
    ) values (
      review_id, challenge_row.id, 'merit', bound.actor_wallet,
      p_payload->>'decision', profile.weight_cached, p_payload->>'reason_code',
      true, new_receipt_id, binding->>'review_public_ref', profile.wallet,
      profile.tier_code, p_payload->>'public_rationale', p_payload->>'private_note',
      statement_timestamp(), statement_timestamp()
    );
    if challenge_row.state = 'open' then
      update public.challenges_v2 as challenge
         set state = 'under_review', updated_at = statement_timestamp()
       where challenge.id = challenge_row.id and challenge.state = 'open';
    end if;
    result_state := 'under_review';

  elsif action_name = 'challenge_withdraw' then
    update public.challenges_v2 as challenge
       set state = 'withdrawn', resolved_receipt_id = new_receipt_id,
           terminal_at = statement_timestamp(), updated_at = statement_timestamp()
     where challenge.id = challenge_row.id
       and challenge.state in ('submitted', 'admissibility_review', 'open', 'under_review');
    if not found then
      raise exception 'Wire challenge withdrawal changed concurrently'
        using errcode = '40001';
    end if;
    result_state := 'withdrawn';

  elsif action_name = 'challenge_finalize' then
    update public.challenges_v2 as challenge
       set state = case when challenge_quorum.outcome = 'accept'
              then 'accepted' else 'rejected' end,
           resolved_receipt_id = new_receipt_id,
           outcome_quorum_hash = challenge_quorum.quorum_hash,
           terminal_at = p_occurred_at, updated_at = statement_timestamp()
     where challenge.id = challenge_row.id and challenge.state = 'under_review';
    if not found then
      raise exception 'Wire challenge outcome changed concurrently'
        using errcode = '40001';
    end if;
    result_state := case when challenge_quorum.outcome = 'accept'
      then 'accepted' else 'rejected' end;
    if challenge_quorum.outcome = 'accept' and version_row.contested_at is null then
      update public.wire_report_versions as version
         set contested_at = p_occurred_at, contested_receipt_id = new_receipt_id,
             updated_at = statement_timestamp()
       where version.id = version_row.id and version.contested_at is null;
      if not found then
        raise exception 'Wire accepted-challenge marker changed concurrently'
          using errcode = '40001';
      end if;
    end if;

  else
    insert into public.cases (
      id, public_ref, title, category, summary_public, details_restricted,
      reward_intent_lamports, submitted_by_wallet, stage, visibility,
      risk_tier, subject_refs, submission_receipt_id, created_at, updated_at
    ) values (
      (binding->>'case_id')::uuid, binding->>'case_public_ref',
      version_row.title_public_safe, 'other', version_row.content_public_safe,
      'Promoted from immutable published Wire version ' || version_row.version_ref ||
        '. The normal Case initial-review and public-open rules still apply.',
      null, bound.actor_wallet, 'initial_review', 'private', 'standard',
      jsonb_build_array(jsonb_build_object(
        'kind', 'wire_report_version', 'ref', version_row.version_ref
      )), new_receipt_id, p_occurred_at, p_occurred_at
    );
    insert into public.case_evidence_links (
      case_id, evidence_item_id, added_by_wallet, created_at
    )
    select (binding->>'case_id')::uuid, link.evidence_item_id,
      bound.actor_wallet, p_occurred_at
      from public.wire_report_version_evidence as link
     where link.wire_report_version_id = version_row.id;
    update public.wire_reports as report
       set promoted_to_case_id = (binding->>'case_id')::uuid,
           updated_at = statement_timestamp()
     where report.id = report_row.id and report.promoted_to_case_id is null;
    if not found then
      raise exception 'Wire promotion link changed concurrently' using errcode = '40001';
    end if;
  end if;

  return query select action_name, bound.purpose,
    context->>'target_public_ref', binding->>'wire_report_public_ref',
    binding->>'version_public_ref', result_challenge_ref, result_case_ref,
    result_state, new_receipt_id, false;
end;
$$;

create function osi_private.osi_v2_list_public_wire_reports(
  p_limit integer default 40,
  p_before timestamptz default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare result_value jsonb;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Public Wire projection is service-only' using errcode = '42501';
  end if;
  if p_limit not between 1 and 100 then
    raise exception 'Public Wire page limit is invalid' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(row_value order by published_at desc), '[]'::jsonb)
    into result_value
    from (
      select version.published_at, jsonb_build_object(
        'author', jsonb_build_object(
          'display_name', profile.display_name,
          'handle', profile.handle,
          'wallet', report.author_wallet
        ),
        'challenge_state', case when version.contested_at is not null
          then 'challenge_upheld_under_re_review' else null end,
        'challenge_count', (
          select count(*) from public.challenges_v2 as challenge
           where challenge.wire_report_version_id = version.id
             and challenge.state in ('submitted', 'admissibility_review', 'open', 'under_review')
        ),
        'contested_at', version.contested_at,
        'evidence_count', (
          select count(*)
            from public.wire_report_version_evidence as link
            join public.evidence_items as evidence on evidence.id = link.evidence_item_id
           where link.wire_report_version_id = version.id
             and evidence.is_public = true
             and evidence.moderation_state = 'approved'
        ),
        'is_current_published', report.current_published_version_id = version.id,
        'promoted', report.promoted_to_case_id is not null and exists (
          select 1 from public.event_receipts as promotion
           where promotion.event_version = 'OSI2'
             and promotion.event_type = 'WIRE_PROMOTED'
             and promotion.target_type = 'wire_version'
             and promotion.target_id = version.id::text
             and promotion.proof_type = 'solana_memo'
             and promotion.server_verified = true
        ),
        'proof_log', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'actor_role', receipt.actor_role,
            'actor_wallet', receipt.actor_wallet,
            'decision', receipt.decision,
            'decision_channel', receipt.decision_channel,
            'event_type', receipt.event_type,
            'label', case
              when receipt.event_type = 'SUPPORT_PAYMENT_CONFIRMED'
                then 'SOL transfer verified on Solana'
              when receipt.proof_type = 'solana_memo' then 'Memo-anchored on Solana'
              when receipt.proof_type = 'wallet_signed_server_verified' then 'Wallet-signed and server-verified'
              when receipt.proof_type = 'system_event' then 'System event'
              else 'Legacy / not server-verified' end,
            'occurred_at', receipt.occurred_at,
            'proof_type', receipt.proof_type,
            'payment_proof', case when receipt.event_type = 'SUPPORT_PAYMENT_CONFIRMED'
              then jsonb_build_object(
                'block_time', receipt.verification_metadata->'block_time',
                'cluster', receipt.verification_metadata->>'cluster',
                'finality', receipt.verification_metadata->>'finality',
                'memo_verified', receipt.verification_metadata->'memo_verified',
                'payer_wallet', receipt.verification_metadata->>'payer_wallet',
                'recipient_manifest', receipt.verification_metadata->'recipient_manifest',
                'slot', receipt.verification_metadata->>'slot',
                'system_program_transfers_verified', receipt.verification_metadata->'system_program_transfers_verified',
                'total_lamports', receipt.verification_metadata->>'total_lamports'
              ) else null end,
            'public_ref', receipt.public_ref,
            'reason_code', receipt.reason_code,
            'receipt_id', receipt.id,
            'tx_sig', receipt.tx_sig,
            'weight', receipt.weight
          ) order by receipt.occurred_at), '[]'::jsonb)
          from public.event_receipts as receipt
         where receipt.event_version = 'OSI2'
           and receipt.server_verified = true
           and (
             (
               receipt.target_type = 'wire_version'
               and receipt.target_id = version.id::text
               and receipt.event_type in (
                 'WIRE_REPORT_VERSION_SUBMITTED',
                 'WIRE_REPORT_REVIEW_CAST', 'WIRE_REPORT_REVIEW_REVISED',
                 'WIRE_REPORT_PUBLISHED', 'WIRE_PROMOTED'
               )
             )
             or (
               receipt.target_type = 'challenge'
               and receipt.event_type in (
                 'CHALLENGE_SUBMITTED',
                 'CHALLENGE_ADMISSIBILITY_ACCEPTED',
                 'CHALLENGE_ADMISSIBILITY_REJECTED',
                 'CHALLENGE_REVIEW_CAST', 'CHALLENGE_REVIEW_REVISED',
                 'CHALLENGE_WITHDRAWN', 'CHALLENGE_ACCEPTED',
                 'CHALLENGE_REJECTED', 'CHALLENGE_EXPIRED'
               )
               and receipt.target_id in (
               select challenge.id::text from public.challenges_v2 as challenge
                where challenge.wire_report_version_id = version.id
               )
             )
             or (
               receipt.event_type = 'SUPPORT_PAYMENT_CONFIRMED'
               and receipt.target_type = 'support'
               and receipt.proof_type = 'solana_memo'
               and receipt.id in (
               select support.event_receipt_id from public.support_events as support
                where support.wire_report_version_id = version.id
                  and support.state = 'confirmed'
                  and support.id::text = receipt.target_id
                  and support.from_wallet = receipt.actor_wallet
                  and support.tx_sig = receipt.tx_sig
               )
             )
           )
        ),
        'publication_channel', publication.decision_channel,
        'publication_proof', jsonb_build_object(
          'actor_role', publication.actor_role,
          'actor_wallet', publication.actor_wallet,
          'decision_channel', publication.decision_channel,
          'event_type', publication.event_type,
          'label', 'Memo-anchored on Solana',
          'occurred_at', publication.occurred_at,
          'proof_type', publication.proof_type,
          'public_ref', publication.public_ref,
          'receipt_id', publication.id,
          'tx_sig', publication.tx_sig
        ),
        'published_at', version.published_at,
        'review_count', (
          select count(*)
            from public.wire_report_reviews as review
            join public.event_receipts as review_receipt
              on review_receipt.id = review.event_receipt_id
             and review_receipt.event_version = 'OSI2'
             and review_receipt.event_type in ('WIRE_REPORT_REVIEW_CAST', 'WIRE_REPORT_REVIEW_REVISED')
             and review_receipt.target_type = 'wire_version'
             and review_receipt.target_id = version.id::text
             and review_receipt.actor_wallet = review.reviewer_wallet
             and review_receipt.proof_type = 'wallet_signed_server_verified'
             and review_receipt.server_verified = true
           where review.wire_report_version_id = version.id
             and review.public_ref is not null
        ),
        'summary', version.content_public_safe,
        'support_lamports', coalesce((
          select sum(support.amount_lamports)
            from public.support_events as support
            join public.event_receipts as support_receipt
              on support_receipt.id = support.event_receipt_id
             and support_receipt.event_version = 'OSI2'
             and support_receipt.event_type = 'SUPPORT_PAYMENT_CONFIRMED'
             and support_receipt.target_type = 'support'
             and support_receipt.target_id = support.id::text
             and support_receipt.actor_wallet = support.from_wallet
             and support_receipt.tx_sig = support.tx_sig
             and support_receipt.proof_type = 'solana_memo'
             and support_receipt.server_verified = true
             and support_receipt.verification_metadata->>'cluster' = 'mainnet-beta'
             and support_receipt.verification_metadata->>'finality' = 'finalized'
             and support_receipt.verification_metadata->'memo_verified' = 'true'::jsonb
             and support_receipt.verification_metadata->'system_program_transfers_verified' = 'true'::jsonb
           where support.wire_report_version_id = version.id
             and support.state = 'confirmed'
        ), 0),
        'title', version.title_public_safe,
        'version_no', version.version_no,
        'version_public_ref', version.version_ref,
        'wire_report_public_ref', report.public_ref
      ) as row_value
      from public.wire_reports as report
      join public.wire_report_versions as version
        on version.wire_report_id = report.id
       and version.lifecycle_state in ('published', 'superseded')
       and version.published_at is not null
      join public.event_receipts as publication
        on publication.id = version.publication_receipt_id
       and publication.event_version = 'OSI2'
       and publication.event_type = 'WIRE_REPORT_PUBLISHED'
       and publication.target_type = 'wire_version'
       and publication.target_id = version.id::text
       and publication.public_ref = version.version_ref
       and publication.decision = 'publish'
       and publication.decision_channel in ('standard', 'maintainer_bootstrap')
       and publication.proof_type = 'solana_memo'
       and publication.server_verified = true
      left join public.analyst_profiles as profile
        on profile.wallet = report.author_wallet
       and profile.status in (
         'probationary_analyst', 'verified_analyst', 'senior_analyst'
       )
       and profile.verified = true
       and profile.approved = true
     where report.native_intake = true
       and (p_before is null or version.published_at < p_before)
     order by version.published_at desc
     limit p_limit
    ) as page;
  return result_value;
end;
$$;

create function osi_private.osi_v2_get_public_wire_report(p_version_ref text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  version_row public.wire_report_versions%rowtype;
  report_row public.wire_reports%rowtype;
  publication public.event_receipts%rowtype;
  author_profile public.analyst_profiles%rowtype;
  promoted_case public.cases%rowtype;
  evidence_value jsonb;
  reviews_value jsonb;
  challenges_value jsonb;
  support_value jsonb;
  proof_value jsonb;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Public Wire detail is service-only' using errcode = '42501';
  end if;
  select version.* into version_row from public.wire_report_versions as version
   where version.version_ref = p_version_ref
     and version.lifecycle_state in ('published', 'superseded')
     and version.published_at is not null;
  select report.* into report_row from public.wire_reports as report
   where report.id = version_row.wire_report_id and report.native_intake = true;
  select receipt.* into publication from public.event_receipts as receipt
   where receipt.id = version_row.publication_receipt_id
     and receipt.event_version = 'OSI2'
     and receipt.event_type = 'WIRE_REPORT_PUBLISHED'
     and receipt.target_type = 'wire_version'
     and receipt.target_id = version_row.id::text
     and receipt.public_ref = version_row.version_ref
     and receipt.decision = 'publish'
     and receipt.decision_channel in ('standard', 'maintainer_bootstrap')
     and receipt.proof_type = 'solana_memo'
     and receipt.server_verified = true;
  if version_row.id is null or report_row.id is null or publication.id is null then
    return null;
  end if;
  select profile.* into author_profile from public.analyst_profiles as profile
   where profile.wallet = report_row.author_wallet
     and profile.status in (
       'probationary_analyst', 'verified_analyst', 'senior_analyst'
     )
     and profile.verified = true
     and profile.approved = true;
  if report_row.promoted_to_case_id is not null and exists (
    select 1 from public.event_receipts as promotion
     where promotion.event_version = 'OSI2'
       and promotion.event_type = 'WIRE_PROMOTED'
       and promotion.target_type = 'wire_version'
       and promotion.target_id = version_row.id::text
       and promotion.proof_type = 'solana_memo'
       and promotion.server_verified = true
  ) then
    select case_item.* into promoted_case from public.cases as case_item
     where case_item.id = report_row.promoted_to_case_id
       and case_item.visibility = 'public';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', evidence.kind,
    'ordinal', link.ordinal,
    'ref', evidence.ref,
    'sha256', evidence.sha256
  ) order by link.ordinal), '[]'::jsonb)
    into evidence_value
    from public.wire_report_version_evidence as link
    join public.evidence_items as evidence on evidence.id = link.evidence_item_id
   where link.wire_report_version_id = version_row.id
     and evidence.is_public = true
     and evidence.moderation_state = 'approved';
  select coalesce(jsonb_agg(jsonb_build_object(
    'active', review.is_active,
    'actor_role', receipt.actor_role,
    'created_at', review.created_at,
    'decision', review.decision,
    'proof_type', receipt.proof_type,
    'public_rationale', review.public_rationale,
    'reason_code', review.reason_code,
    'receipt_id', receipt.id,
    'review_public_ref', review.public_ref,
    'reviewer', jsonb_build_object(
      'display_name', profile.display_name,
      'handle', profile.handle,
      'wallet', review.reviewer_wallet
    ),
    'tier_snapshot', review.tier_snapshot,
    'weight', review.weight
  ) order by review.created_at), '[]'::jsonb)
    into reviews_value
    from public.wire_report_reviews as review
    join public.event_receipts as receipt
      on receipt.id = review.event_receipt_id
     and receipt.event_version = 'OSI2'
     and receipt.event_type in ('WIRE_REPORT_REVIEW_CAST', 'WIRE_REPORT_REVIEW_REVISED')
     and receipt.target_type = 'wire_version'
     and receipt.target_id = review.wire_report_version_id::text
     and receipt.actor_wallet = review.reviewer_wallet
     and receipt.decision = review.decision
     and receipt.weight = review.weight
     and receipt.proof_type = 'wallet_signed_server_verified'
     and receipt.server_verified = true
    left join public.analyst_profiles as profile
      on profile.wallet = review.reviewer_wallet
     and profile.status in (
       'probationary_analyst', 'verified_analyst', 'senior_analyst'
     )
     and profile.verified = true
     and profile.approved = true
   where review.wire_report_version_id = version_row.id
     and review.public_ref is not null;
  select coalesce(jsonb_agg(jsonb_build_object(
    'admitted_by_wallet', challenge.admitted_by_wallet,
    'challenge_public_ref', challenge.public_ref,
    'challenger_wallet', challenge.challenger_wallet,
    'created_at', challenge.created_at,
    'public_safe_summary', challenge.public_safe_summary,
    'reason_code', challenge.reason_code,
    'reviews', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'active', review.is_active,
        'actor_role', receipt.actor_role,
        'created_at', review.created_at,
        'decision', review.decision,
        'proof_type', receipt.proof_type,
        'public_rationale', review.public_rationale,
        'receipt_id', receipt.id,
        'review_public_ref', review.public_ref,
        'reviewer', jsonb_build_object(
          'display_name', profile.display_name,
          'handle', profile.handle,
          'wallet', review.reviewer_wallet
        ),
        'tier_snapshot', review.tier_snapshot,
        'weight', review.weight
      ) order by review.created_at), '[]'::jsonb)
      from public.challenge_reviews as review
      join public.event_receipts as receipt
        on receipt.id = review.event_receipt_id
       and receipt.event_version = 'OSI2'
       and receipt.event_type in ('CHALLENGE_REVIEW_CAST', 'CHALLENGE_REVIEW_REVISED')
       and receipt.target_type = 'challenge'
       and receipt.target_id = challenge.id::text
       and receipt.actor_wallet = review.reviewer_wallet
       and receipt.decision = review.decision
       and receipt.weight = review.weight
       and receipt.proof_type = 'wallet_signed_server_verified'
       and receipt.server_verified = true
      left join public.analyst_profiles as profile
        on profile.wallet = review.reviewer_wallet
       and profile.status in (
         'probationary_analyst', 'verified_analyst', 'senior_analyst'
       )
       and profile.verified = true
       and profile.approved = true
      where review.challenge_id = challenge.id and review.phase = 'merit'
    ),
    'state', challenge.state,
    'terminal_at', challenge.terminal_at
  ) order by challenge.created_at desc), '[]'::jsonb)
    into challenges_value
    from public.challenges_v2 as challenge
   where challenge.wire_report_version_id = version_row.id
     and challenge.public_ref is not null;
  select coalesce(jsonb_agg(jsonb_build_object(
    'amount_lamports', support.amount_lamports,
    'confirmed_at', receipt.occurred_at,
    'from_wallet', support.from_wallet,
    'proof_type', receipt.proof_type,
    'label', case
      when receipt.event_type = 'SUPPORT_PAYMENT_CONFIRMED'
        then 'SOL transfer verified on Solana'
      when receipt.proof_type = 'solana_memo' then 'Memo-anchored on Solana'
      when receipt.proof_type = 'wallet_signed_server_verified'
        then 'Wallet-signed and server-verified'
      when receipt.proof_type = 'system_event' then 'System event'
      else 'Legacy / not server-verified' end,
    'payment_proof', case when receipt.event_type = 'SUPPORT_PAYMENT_CONFIRMED'
      then jsonb_build_object(
        'block_time', receipt.verification_metadata->'block_time',
        'cluster', receipt.verification_metadata->>'cluster',
        'finality', receipt.verification_metadata->>'finality',
        'memo_verified', receipt.verification_metadata->'memo_verified',
        'payer_wallet', receipt.verification_metadata->>'payer_wallet',
        'recipient_manifest', receipt.verification_metadata->'recipient_manifest',
        'slot', receipt.verification_metadata->>'slot',
        'system_program_transfers_verified', receipt.verification_metadata->'system_program_transfers_verified',
        'total_lamports', receipt.verification_metadata->>'total_lamports'
      ) else null end,
    'receipt_id', receipt.id,
    'tx_sig', support.tx_sig
  ) order by receipt.occurred_at desc), '[]'::jsonb)
    into support_value
    from public.support_events as support
    join public.event_receipts as receipt on receipt.id = support.event_receipt_id
   where support.wire_report_version_id = version_row.id
     and support.state = 'confirmed'
     and receipt.event_type = 'SUPPORT_PAYMENT_CONFIRMED'
     and receipt.target_type = 'support'
     and receipt.target_id = support.id::text
     and receipt.actor_wallet = support.from_wallet
     and receipt.tx_sig = support.tx_sig
     and receipt.proof_type = 'solana_memo'
     and receipt.server_verified = true
     and receipt.verification_metadata->>'cluster' = 'mainnet-beta'
     and receipt.verification_metadata->>'finality' = 'finalized'
     and receipt.verification_metadata->'memo_verified' = 'true'::jsonb
     and receipt.verification_metadata->'system_program_transfers_verified' = 'true'::jsonb;
  select coalesce(jsonb_agg(jsonb_build_object(
    'actor_role', receipt.actor_role,
    'actor_wallet', receipt.actor_wallet,
    'decision', receipt.decision,
    'decision_channel', receipt.decision_channel,
    'event_type', receipt.event_type,
    'occurred_at', receipt.occurred_at,
    'proof_type', receipt.proof_type,
    'label', case
      when receipt.event_type = 'SUPPORT_PAYMENT_CONFIRMED'
        then 'SOL transfer verified on Solana'
      when receipt.proof_type = 'solana_memo' then 'Memo-anchored on Solana'
      when receipt.proof_type = 'wallet_signed_server_verified'
        then 'Wallet-signed and server-verified'
      when receipt.proof_type = 'system_event' then 'System event'
      else 'Legacy / not server-verified' end,
    'payment_proof', case when receipt.event_type = 'SUPPORT_PAYMENT_CONFIRMED'
      then jsonb_build_object(
        'block_time', receipt.verification_metadata->'block_time',
        'cluster', receipt.verification_metadata->>'cluster',
        'finality', receipt.verification_metadata->>'finality',
        'memo_verified', receipt.verification_metadata->'memo_verified',
        'payer_wallet', receipt.verification_metadata->>'payer_wallet',
        'recipient_manifest', receipt.verification_metadata->'recipient_manifest',
        'slot', receipt.verification_metadata->>'slot',
        'system_program_transfers_verified', receipt.verification_metadata->'system_program_transfers_verified',
        'total_lamports', receipt.verification_metadata->>'total_lamports'
      ) else null end,
    'public_ref', receipt.public_ref,
    'reason_code', receipt.reason_code,
    'receipt_id', receipt.id,
    'tx_sig', receipt.tx_sig,
    'weight', receipt.weight
  ) order by receipt.occurred_at), '[]'::jsonb)
    into proof_value
    from public.event_receipts as receipt
   where receipt.event_version = 'OSI2' and receipt.server_verified = true
     and (
       (
         receipt.target_type = 'wire_version'
         and receipt.target_id = version_row.id::text
         and receipt.event_type in (
           'WIRE_REPORT_VERSION_SUBMITTED',
           'WIRE_REPORT_REVIEW_CAST', 'WIRE_REPORT_REVIEW_REVISED',
           'WIRE_REPORT_PUBLISHED', 'WIRE_PROMOTED'
         )
       )
       or (
         receipt.target_type = 'challenge'
         and receipt.event_type in (
           'CHALLENGE_SUBMITTED',
           'CHALLENGE_ADMISSIBILITY_ACCEPTED',
           'CHALLENGE_ADMISSIBILITY_REJECTED',
           'CHALLENGE_REVIEW_CAST', 'CHALLENGE_REVIEW_REVISED',
           'CHALLENGE_WITHDRAWN', 'CHALLENGE_ACCEPTED',
           'CHALLENGE_REJECTED', 'CHALLENGE_EXPIRED'
         )
         and receipt.target_id in (
         select challenge.id::text from public.challenges_v2 as challenge
          where challenge.wire_report_version_id = version_row.id
         )
       )
       or (
         receipt.event_type = 'SUPPORT_PAYMENT_CONFIRMED'
         and receipt.target_type = 'support'
         and receipt.proof_type = 'solana_memo'
         and receipt.id in (
         select support.event_receipt_id from public.support_events as support
          where support.wire_report_version_id = version_row.id
            and support.state = 'confirmed'
            and support.id::text = receipt.target_id
            and support.from_wallet = receipt.actor_wallet
            and support.tx_sig = receipt.tx_sig
         )
       )
     );
  return jsonb_build_object(
    'analysis', version_row.body_private,
    'author', jsonb_build_object(
      'display_name', author_profile.display_name,
      'handle', author_profile.handle,
      'wallet', report_row.author_wallet
    ),
    'challenge_state', case when version_row.contested_at is not null
      then 'challenge_upheld_under_re_review' else null end,
    'challenges', challenges_value,
    'contested_at', version_row.contested_at,
    'evidence', evidence_value,
    'promoted', report_row.promoted_to_case_id is not null and exists (
      select 1 from public.event_receipts as promotion
       where promotion.event_version = 'OSI2'
         and promotion.event_type = 'WIRE_PROMOTED'
         and promotion.target_type = 'wire_version'
         and promotion.target_id = version_row.id::text
         and promotion.proof_type = 'solana_memo'
         and promotion.server_verified = true
    ),
    'promoted_case_public_ref', promoted_case.public_ref,
    'is_current_published', report_row.current_published_version_id = version_row.id,
    'proof_log', proof_value,
    'publication', jsonb_build_object(
      'actor_role', publication.actor_role,
      'actor_wallet', publication.actor_wallet,
      'decision_channel', publication.decision_channel,
      'occurred_at', publication.occurred_at,
      'proof_type', publication.proof_type,
      'receipt_id', publication.id,
      'tx_sig', publication.tx_sig
    ),
    'published_at', version_row.published_at,
    'reviews', reviews_value,
    'summary', version_row.content_public_safe,
    'support', support_value,
    'title', version_row.title_public_safe,
    'uncertainties', version_row.uncertainties_private,
    'version_no', version_row.version_no,
    'version_public_ref', version_row.version_ref,
    'wire_report_public_ref', report_row.public_ref
  );
end;
$$;

create function osi_private.osi_v2_list_wire_review_queue(
  p_actor_wallet text,
  p_maintainer_auth_uuid text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare result_value jsonb;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Wire review queue is service-only' using errcode = '42501';
  end if;
  if p_limit not between 1 and 100
     or not (
       osi_private.osi_v2_eligible_analyst(p_actor_wallet)
       or osi_private.osi_v2_full_maintainer_binding(
         p_actor_wallet, p_maintainer_auth_uuid
       )
     ) then
    raise exception 'Wire review queue actor is not eligible' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(row_value order by created_at), '[]'::jsonb)
    into result_value
    from (
      select version.created_at, jsonb_build_object(
        'analysis', version.body_private,
        'author_wallet', report.author_wallet,
        'evidence', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'kind', evidence.kind, 'ordinal', link.ordinal,
            'ref', evidence.ref, 'sha256', evidence.sha256
          ) order by link.ordinal), '[]'::jsonb)
          from public.wire_report_version_evidence as link
          join public.evidence_items as evidence on evidence.id = link.evidence_item_id
          where link.wire_report_version_id = version.id
        ),
        'lifecycle_state', version.lifecycle_state,
        'my_active_review', (
          select jsonb_build_object(
            'decision', review.decision,
            'private_note', review.private_note,
            'public_rationale', review.public_rationale,
            'reason_code', review.reason_code,
            'review_public_ref', review.public_ref,
            'weight', review.weight
          ) from public.wire_report_reviews as review
          where review.wire_report_version_id = version.id
            and review.reviewer_wallet = p_actor_wallet and review.is_active = true
        ),
        'quorum', (select to_jsonb(quorum) - 'version_id'
          from osi_private.osi_v2_wire_quorum(version.id) as quorum),
        'summary', version.content_public_safe,
        'title', version.title_public_safe,
        'uncertainties', version.uncertainties_private,
        'version_no', version.version_no,
        'version_public_ref', version.version_ref,
        'wire_report_public_ref', report.public_ref
      ) as row_value
      from public.wire_reports as report
      join public.wire_report_versions as version
        on version.id = report.current_version_id
       and version.wire_report_id = report.id
     where report.native_intake = true
       and report.author_wallet <> p_actor_wallet
       and version.lifecycle_state in ('submitted', 'in_review')
     order by version.created_at
     limit p_limit
    ) as queue;
  return result_value;
end;
$$;

-- The shared finalized-payment commit RPC predates the Wire flag. Reassert the
-- second gate in the immutable support-row transition itself so a prepared
-- Wire support intent cannot finalize after either dedicated flag is disabled.
create or replace function public.osi_v2_guard_support_event()
returns trigger language plpgsql set search_path = '' as $$
declare
  old_core jsonb;
  new_core jsonb;
  receipt public.event_receipts%rowtype;
  bound public.osi_nonces%rowtype;
begin
  if new.wire_report_version_id is not null and (
    osi_private.osi_v2_wire_writes_enabled() is distinct from true
    or osi_private.osi_v2_payment_writes_enabled() is distinct from true
  ) then
    raise exception 'Wire and payment writes must both be enabled'
      using errcode = '55000';
  end if;
  old_core := to_jsonb(old) - array['tx_sig','state','event_receipt_id','confirmed_at','slot','block_time','finality','verification_error','updated_at'];
  new_core := to_jsonb(new) - array['tx_sig','state','event_receipt_id','confirmed_at','slot','block_time','finality','verification_error','updated_at'];
  if new_core is distinct from old_core then
    raise exception 'Support sender, recipient manifest, type and amount are immutable' using errcode = '55000';
  end if;
  if old.tx_sig is not null and new.tx_sig is distinct from old.tx_sig then
    raise exception 'Support transaction signature is write-once' using errcode = '55000';
  end if;
  if old.event_receipt_id is not null and new.event_receipt_id is distinct from old.event_receipt_id then
    raise exception 'Support receipt is write-once' using errcode = '55000';
  end if;
  if not (new.state = old.state or (old.state = 'submitted' and new.state in ('confirmed','failed'))) then
    raise exception 'Invalid support transition: % -> %', old.state, new.state using errcode = '23514';
  end if;
  if old.state <> 'confirmed' and new.state = 'confirmed' then
    if new.wire_report_version_id is not null then
      if not exists (
        select 1
          from public.wire_report_versions as version
          join public.wire_reports as report
            on report.id = version.wire_report_id
           and report.current_published_version_id = version.id
         where version.id = new.wire_report_version_id
           and version.lifecycle_state = 'published'
           and report.native_intake = true
           and report.author_wallet = new.target_wallet
           and new.from_wallet <> report.author_wallet
      ) then
        raise exception 'Wire support requires the exact current published author target'
          using errcode = '23514';
      end if;
      select nonce.* into bound from public.osi_nonces as nonce
       where nonce.nonce = new.intent_nonce;
      if bound.nonce is null
         or bound.purpose <> 'SUPPORT_PAYMENT_CONFIRMED'
         or bound.target_type <> 'support'
         or bound.target_id is distinct from new.id::text
         or bound.actor_wallet is distinct from new.from_wallet
         or bound.binding_context->>'payment_kind' <> 'wire_support'
         or (bound.binding_context->>'context_wire_version_id')::uuid
            is distinct from new.wire_report_version_id
         or bound.binding_context->'recipient_manifest' is distinct from new.recipient_manifest
         or bound.binding_context->>'manifest_hash' is distinct from new.manifest_hash
         or (bound.binding_context->>'total_lamports')::bigint
            is distinct from new.amount_lamports then
        raise exception 'Wire support nonce lost its exact server-derived target binding'
          using errcode = '23514';
      end if;
    end if;
    select event.* into receipt from public.event_receipts as event where event.id = new.event_receipt_id;
    if receipt.event_version is distinct from 'OSI2'
       or receipt.event_type is distinct from 'SUPPORT_PAYMENT_CONFIRMED'
       or receipt.target_type is distinct from 'support'
       or receipt.target_id is distinct from new.id::text
       or receipt.actor_wallet is distinct from new.from_wallet
       or receipt.tx_sig is distinct from new.tx_sig
       or receipt.proof_type is distinct from 'solana_memo'
       or receipt.server_verified is distinct from true
       or receipt.verification_metadata->>'cluster' is distinct from 'mainnet-beta'
       or receipt.verification_metadata->>'finality' is distinct from 'finalized'
       or receipt.verification_metadata->'memo_verified' is distinct from 'true'::jsonb
       or receipt.verification_metadata->'system_program_transfers_verified' is distinct from 'true'::jsonb then
      raise exception 'Confirmed support requires exact verified transfer receipt' using errcode = '23514';
    end if;
    if new.wire_report_version_id is not null and (
      receipt.public_ref is distinct from bound.binding_context->>'target_public_ref'
      or receipt.memo_ref is distinct from bound.binding_context->>'memo'
      or receipt.anchor_wallet is distinct from new.from_wallet
      or receipt.payload_hash is distinct from bound.payload_hash
      or receipt.nonce is distinct from bound.nonce
      or receipt.verification_metadata->>'payment_kind' is distinct from 'wire_support'
      or receipt.verification_metadata->>'payer_wallet' is distinct from new.from_wallet
      or receipt.verification_metadata->'recipient_manifest' is distinct from new.recipient_manifest
      or receipt.verification_metadata->>'manifest_hash' is distinct from new.manifest_hash
      or receipt.verification_metadata->>'total_lamports'
         is distinct from new.amount_lamports::text
      or receipt.verification_metadata->>'target_public_ref'
         is distinct from bound.binding_context->>'target_public_ref'
    ) then
      raise exception 'Confirmed Wire support receipt changed its exact payment binding'
        using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

create function osi_private.osi_v2_prepare_wire_support(
  p_nonce text,
  p_payer_wallet text,
  p_version_ref text,
  p_amount_lamports bigint,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, purpose text, payment_id uuid, payment_kind text,
  target_public_ref text, actor_role text, recipient_manifest jsonb,
  manifest_hash text, total_lamports bigint, payload_hash text, memo text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.osi_nonces%rowtype;
  version_row public.wire_report_versions%rowtype;
  report_row public.wire_reports%rowtype;
  actual_payment_id uuid := gen_random_uuid();
  server_manifest jsonb;
  server_binding jsonb;
  actual_manifest_hash text;
  exact_hash text;
  canonical_memo text;
  issued_time timestamptz := statement_timestamp();
  expires_time timestamptz;
  ttl_seconds integer;
  max_lamports bigint;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Wire support prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_wire_writes_enabled() is distinct from true
     or osi_private.osi_v2_payment_writes_enabled() is distinct from true then
    raise exception 'Wire and payment writes must both be enabled' using errcode = '55000';
  end if;
  if p_payer_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or p_amount_lamports is null or p_amount_lamports <= 0 then
    raise exception 'Wire support input is invalid' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-support-idempotency:' || p_idempotency_key, 0)
  );
  select nonce.* into existing from public.osi_nonces as nonce
   where nonce.idempotency_key = p_idempotency_key for update;
  if found then
    if existing.actor_wallet is distinct from p_payer_wallet
       or existing.binding_context->>'payment_kind' <> 'wire_support'
       or existing.binding_context->>'target_ref_input' is distinct from p_version_ref
       or (existing.binding_context->>'total_lamports')::bigint
          is distinct from p_amount_lamports then
      raise exception 'Idempotency key is bound to another exact Wire support intent'
        using errcode = '23514';
    end if;
    return query select existing.nonce, existing.purpose,
      existing.target_id::uuid, 'wire_support'::text,
      existing.binding_context->>'target_public_ref',
      existing.binding_context->>'actor_role',
      existing.binding_context->'recipient_manifest',
      existing.binding_context->>'manifest_hash',
      (existing.binding_context->>'total_lamports')::bigint,
      existing.payload_hash, existing.binding_context->>'memo',
      existing.issued_at, existing.expires_at,
      existing.consumed_by_receipt_id, true;
    return;
  end if;
  select version.* into version_row from public.wire_report_versions as version
   where version.version_ref = p_version_ref for update;
  select report.* into report_row from public.wire_reports as report
   where report.id = version_row.wire_report_id for update;
  select case when config.value ~ '^[0-9]+$' then config.value::bigint end
    into max_lamports from public.osi_config as config
   where config.key = 'OSI_V2_PAYMENT_MAX_LAMPORTS';
  if max_lamports is null or max_lamports not between 1 and 100000000000 then
    raise exception 'Payment amount configuration is absent or invalid'
      using errcode = '55000';
  end if;
  if version_row.id is null or version_row.lifecycle_state <> 'published'
     or report_row.current_published_version_id is distinct from version_row.id
     or report_row.author_wallet = p_payer_wallet
     or p_amount_lamports > max_lamports then
    raise exception 'Wire support target, payer or amount is not eligible'
      using errcode = '42501';
  end if;
  server_manifest := jsonb_build_array(jsonb_build_object(
    'amount_lamports', p_amount_lamports::text,
    'ordinal', 1,
    'recipient_type', 'report_author',
    'target_ref', version_row.version_ref,
    'wallet', report_row.author_wallet
  ));
  actual_manifest_hash := osi_private.osi_v2_payment_hash(server_manifest);
  server_binding := jsonb_build_object(
    'context_wire_version_id', version_row.id,
    'wire_report_id', report_row.id,
    'wire_report_public_ref', report_row.public_ref,
    'wire_report_version_ref', version_row.version_ref
  );
  exact_hash := osi_private.osi_v2_payment_hash(jsonb_build_object(
    'manifest_hash', actual_manifest_hash,
    'payer_wallet', p_payer_wallet,
    'payment_id', actual_payment_id,
    'payment_kind', 'wire_support',
    'recipient_manifest', server_manifest,
    'server_binding', server_binding,
    'target_public_ref', version_row.version_ref,
    'total_lamports', p_amount_lamports::text
  ));
  perform osi_private.osi_v2_payment_rate_limit(
    p_payer_wallet, p_request_fingerprint_hash, issued_time
  );
  ttl_seconds := osi_private.osi_v2_payment_config_integer(
    'OSI_V2_PAYMENT_NONCE_TTL_SECONDS', 30, 300
  );
  expires_time := issued_time + pg_catalog.make_interval(secs => ttl_seconds);
  canonical_memo := concat_ws('|', 'OSI2', '1', 'SUPPORT_PAYMENT_CONFIRMED',
    't=support', 'id=' || version_row.version_ref, 'a=' || p_payer_wallet,
    'r=wallet', 'd=sent', 'n=' || p_nonce, 'h=' || exact_hash,
    'ts=' || floor(extract(epoch from issued_time))::bigint);
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, 'SUPPORT_PAYMENT_CONFIRMED', p_payer_wallet, 'support',
    actual_payment_id::text, exact_hash, p_idempotency_key,
    p_request_fingerprint_hash, server_binding || jsonb_build_object(
      'actor_role', 'wallet', 'manifest_hash', actual_manifest_hash,
      'memo', canonical_memo, 'payment_kind', 'wire_support',
      'recipient_manifest', server_manifest, 'target_public_ref', version_row.version_ref,
      'target_ref_input', p_version_ref, 'total_lamports', p_amount_lamports::text
    ), issued_time, expires_time
  );
  return query select p_nonce, 'SUPPORT_PAYMENT_CONFIRMED'::text,
    actual_payment_id, 'wire_support'::text, version_row.version_ref,
    'wallet'::text, server_manifest, actual_manifest_hash,
    p_amount_lamports, exact_hash, canonical_memo,
    issued_time, expires_time, null::uuid, false;
end;
$$;

create function osi_private.osi_v2_record_wire_support_submission(
  p_nonce text,
  p_tx_sig text
)
returns table (
  payment_id uuid, payment_kind text, state text,
  tx_sig text, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  existing_support public.support_events%rowtype;
  manifest jsonb;
  recipient jsonb;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Wire support submission is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_wire_writes_enabled() is distinct from true
     or osi_private.osi_v2_payment_writes_enabled() is distinct from true then
    raise exception 'Wire and payment writes must both be enabled' using errcode = '55000';
  end if;
  if p_tx_sig !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$' then
    raise exception 'Transaction signature is invalid' using errcode = '22023';
  end if;
  select nonce.* into bound from public.osi_nonces as nonce
   where nonce.nonce = p_nonce for update;
  if bound.nonce is null or bound.purpose <> 'SUPPORT_PAYMENT_CONFIRMED'
     or bound.binding_context->>'payment_kind' <> 'wire_support'
     or bound.consumed_at is not null
     or statement_timestamp() > bound.expires_at + interval '120 seconds' then
    raise exception 'Wire support intent is unavailable or expired'
      using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-payment-tx:' || p_tx_sig, 0)
  );
  select support.* into existing_support from public.support_events as support
   where support.intent_nonce = bound.nonce for update;
  if existing_support.id is not null then
    if existing_support.tx_sig is distinct from p_tx_sig then
      raise exception 'Wire support intent is bound to another transaction'
        using errcode = '23514';
    end if;
    return query select existing_support.id, 'wire_support'::text,
      existing_support.state, existing_support.tx_sig, true;
    return;
  end if;
  manifest := bound.binding_context->'recipient_manifest';
  recipient := manifest->0;
  insert into public.support_events (
    id, support_type, case_report_version_id, wire_report_version_id,
    analyst_wallet, target_wallet, from_wallet, amount_lamports,
    tx_sig, state, intent_nonce, case_id, context_report_version_id,
    recipient_manifest, manifest_hash, cluster
  ) values (
    bound.target_id::uuid, 'report_author', null,
    (bound.binding_context->>'context_wire_version_id')::uuid,
    null, recipient->>'wallet', bound.actor_wallet,
    (bound.binding_context->>'total_lamports')::bigint,
    p_tx_sig, 'submitted', bound.nonce, null, null,
    manifest, bound.binding_context->>'manifest_hash', 'mainnet-beta'
  ) returning * into existing_support;
  return query select existing_support.id, 'wire_support'::text,
    existing_support.state, existing_support.tx_sig, false;
end;
$$;

create function public.osi_v2_prepare_wire_review(
  p_nonce text, p_actor_wallet text, p_version_id uuid, p_decision text,
  p_reason_code text, p_public_rationale text, p_private_note text,
  p_idempotency_key text, p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, purpose text, wire_report_public_ref text,
  version_public_ref text, review_public_ref text, actor_role text,
  payload_hash text, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = '' as $$
  select * from osi_private.osi_v2_prepare_wire_review(
    p_nonce, p_actor_wallet, p_version_id, p_decision, p_reason_code,
    p_public_rationale, p_private_note, p_idempotency_key,
    p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_commit_wire_review(
  p_nonce text, p_decision text, p_reason_code text,
  p_public_rationale text, p_private_note text,
  p_signature text, p_message text
)
returns table (
  wire_report_public_ref text, version_public_ref text,
  review_public_ref text, actor_role text, decision text, weight numeric,
  tier_snapshot text, receipt_id uuid, approve_count integer,
  approve_weight numeric, required_count integer, required_weight numeric,
  approve_ready boolean, idempotent_replay boolean
)
language sql security invoker set search_path = '' as $$
  select * from osi_private.osi_v2_commit_wire_review(
    p_nonce, p_decision, p_reason_code, p_public_rationale,
    p_private_note, p_signature, p_message
  )
$$;

create function public.osi_v2_prepare_wire_publication(
  p_nonce text, p_actor_wallet text, p_version_id uuid,
  p_idempotency_key text, p_request_fingerprint_hash text,
  p_maintainer_auth_uuid text default null
)
returns table (
  issued_nonce text, purpose text, wire_report_public_ref text,
  version_public_ref text, actor_role text, decision_channel text,
  payload_hash text, quorum_hash text, proof_text text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = '' as $$
  select * from osi_private.osi_v2_prepare_wire_publication(
    p_nonce, p_actor_wallet, p_version_id, p_idempotency_key,
    p_request_fingerprint_hash, p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_commit_wire_publication(
  p_nonce text, p_tx_sig text, p_proof_text text,
  p_occurred_at timestamptz, p_maintainer_auth_uuid text default null
)
returns table (
  wire_report_public_ref text, version_public_ref text,
  decision_channel text, receipt_id uuid, lifecycle_state text,
  idempotent_replay boolean
)
language sql security invoker set search_path = '' as $$
  select * from osi_private.osi_v2_commit_wire_publication(
    p_nonce, p_tx_sig, p_proof_text, p_occurred_at, p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_prepare_wire_governance_action(
  p_nonce text, p_action text, p_actor_wallet text, p_target_ref text,
  p_payload jsonb, p_idempotency_key text, p_request_fingerprint_hash text,
  p_maintainer_auth_uuid text default null
)
returns table (
  issued_nonce text, purpose text, target_type text, target_id text,
  target_public_ref text, actor_role text, weight numeric,
  payload_hash text, quorum_hash text, proof_text text, proof_type text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = '' as $$
  select * from osi_private.osi_v2_prepare_wire_governance_action(
    p_nonce, p_action, p_actor_wallet, p_target_ref, p_payload,
    p_idempotency_key, p_request_fingerprint_hash, p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_commit_wire_governance_action(
  p_nonce text, p_payload jsonb, p_signature text, p_tx_sig text,
  p_proof_text text, p_occurred_at timestamptz,
  p_maintainer_auth_uuid text default null
)
returns table (
  action text, purpose text, target_public_ref text,
  wire_report_public_ref text, version_public_ref text,
  challenge_public_ref text, case_public_ref text, state text,
  receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = '' as $$
  select * from osi_private.osi_v2_commit_wire_governance_action(
    p_nonce, p_payload, p_signature, p_tx_sig, p_proof_text,
    p_occurred_at, p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_list_public_wire_reports(
  p_limit integer default 40, p_before timestamptz default null
)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  select osi_private.osi_v2_list_public_wire_reports(p_limit, p_before)
$$;

create function public.osi_v2_get_public_wire_report(p_version_ref text)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  select osi_private.osi_v2_get_public_wire_report(p_version_ref)
$$;

create function public.osi_v2_list_wire_review_queue(
  p_actor_wallet text, p_maintainer_auth_uuid text default null,
  p_limit integer default 50
)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  select osi_private.osi_v2_list_wire_review_queue(
    p_actor_wallet, p_maintainer_auth_uuid, p_limit
  )
$$;

create function public.osi_v2_prepare_wire_support(
  p_nonce text, p_payer_wallet text, p_version_ref text,
  p_amount_lamports bigint, p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, purpose text, payment_id uuid, payment_kind text,
  target_public_ref text, actor_role text, recipient_manifest jsonb,
  manifest_hash text, total_lamports bigint, payload_hash text, memo text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = '' as $$
  select * from osi_private.osi_v2_prepare_wire_support(
    p_nonce, p_payer_wallet, p_version_ref, p_amount_lamports,
    p_idempotency_key, p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_record_wire_support_submission(
  p_nonce text, p_tx_sig text
)
returns table (
  payment_id uuid, payment_kind text, state text,
  tx_sig text, idempotent_replay boolean
)
language sql security invoker set search_path = '' as $$
  select * from osi_private.osi_v2_record_wire_support_submission(p_nonce, p_tx_sig)
$$;

revoke all privileges on function public.osi_v2_guard_report_version()
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_guard_support_event()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_wire_action_rate(text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_wire_bootstrap_support(uuid, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_wire_review_payload_hash(text, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_wire_publication_payload_hash(uuid, text, text, text, text, text, text, text, text, uuid)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_wire_quorum(uuid)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_wire_review(text, text, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_wire_review(text, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_wire_publication(text, text, uuid, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_wire_publication(text, text, text, timestamptz, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_wire_governance_action(text, text, text, text, jsonb, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_wire_governance_action(text, jsonb, text, text, text, timestamptz, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_list_public_wire_reports(integer, timestamptz)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_get_public_wire_report(text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_list_wire_review_queue(text, text, integer)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_wire_support(text, text, text, bigint, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_record_wire_support_submission(text, text)
  from public, anon, authenticated;

revoke all privileges on function public.osi_v2_prepare_wire_review(text, text, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_wire_review(text, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_prepare_wire_publication(text, text, uuid, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_wire_publication(text, text, text, timestamptz, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_prepare_wire_governance_action(text, text, text, text, jsonb, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_wire_governance_action(text, jsonb, text, text, text, timestamptz, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_list_public_wire_reports(integer, timestamptz)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_get_public_wire_report(text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_list_wire_review_queue(text, text, integer)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_prepare_wire_support(text, text, text, bigint, text, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_record_wire_support_submission(text, text)
  from public, anon, authenticated;

grant execute on function osi_private.osi_v2_wire_action_rate(text, text, text, timestamptz)
  to service_role;
grant execute on function osi_private.osi_v2_wire_bootstrap_support(uuid, text)
  to service_role;
grant execute on function osi_private.osi_v2_wire_review_payload_hash(text, uuid, text, text, text, text, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_wire_publication_payload_hash(uuid, text, text, text, text, text, text, text, text, uuid)
  to service_role;
grant execute on function osi_private.osi_v2_wire_quorum(uuid)
  to service_role;
grant execute on function osi_private.osi_v2_prepare_wire_review(text, text, uuid, text, text, text, text, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_commit_wire_review(text, text, text, text, text, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_prepare_wire_publication(text, text, uuid, text, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_commit_wire_publication(text, text, text, timestamptz, text)
  to service_role;
grant execute on function osi_private.osi_v2_prepare_wire_governance_action(text, text, text, text, jsonb, text, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_commit_wire_governance_action(text, jsonb, text, text, text, timestamptz, text)
  to service_role;
grant execute on function osi_private.osi_v2_list_public_wire_reports(integer, timestamptz)
  to service_role;
grant execute on function osi_private.osi_v2_get_public_wire_report(text)
  to service_role;
grant execute on function osi_private.osi_v2_list_wire_review_queue(text, text, integer)
  to service_role;
grant execute on function osi_private.osi_v2_prepare_wire_support(text, text, text, bigint, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_record_wire_support_submission(text, text)
  to service_role;

grant execute on function public.osi_v2_prepare_wire_review(text, text, uuid, text, text, text, text, text, text)
  to service_role;
grant execute on function public.osi_v2_commit_wire_review(text, text, text, text, text, text, text)
  to service_role;
grant execute on function public.osi_v2_prepare_wire_publication(text, text, uuid, text, text, text)
  to service_role;
grant execute on function public.osi_v2_commit_wire_publication(text, text, text, timestamptz, text)
  to service_role;
grant execute on function public.osi_v2_prepare_wire_governance_action(text, text, text, text, jsonb, text, text, text)
  to service_role;
grant execute on function public.osi_v2_commit_wire_governance_action(text, jsonb, text, text, text, timestamptz, text)
  to service_role;
grant execute on function public.osi_v2_list_public_wire_reports(integer, timestamptz)
  to service_role;
grant execute on function public.osi_v2_get_public_wire_report(text)
  to service_role;
grant execute on function public.osi_v2_list_wire_review_queue(text, text, integer)
  to service_role;
grant execute on function public.osi_v2_prepare_wire_support(text, text, text, bigint, text, text)
  to service_role;
grant execute on function public.osi_v2_record_wire_support_submission(text, text)
  to service_role;
grant execute on function public.osi_v2_guard_support_event()
  to service_role;

comment on function osi_private.osi_v2_get_public_wire_report(text) is
  'Exact published-version allowlist. It exposes no unpublished version, private review note, restricted challenge detail, signature, nonce, payload hash or private promoted Case reference.';
comment on function osi_private.osi_v2_commit_wire_publication(text, text, text, timestamptz, text) is
  'Advances the Wire published pointer only after rechecking normal analyst quorum or the explicitly labeled self-retiring D17 bootstrap tier.';
comment on function osi_private.osi_v2_commit_wire_governance_action(text, jsonb, text, text, text, timestamptz, text) is
  'Commits typed Wire challenges or promotion. Challenge decisions are structurally standard-channel only; promotion creates a private initial_review Case without reward.';

commit;
