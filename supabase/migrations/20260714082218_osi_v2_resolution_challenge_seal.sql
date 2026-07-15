-- OSI V2 exact primary Report selection, challenge lifecycle and Case seal.
--
-- This migration extends the accepted 32-table model. It does not create a
-- second resolution/challenge model, rewrite V1 data, transfer funds, or
-- enable broad V2 writes. Every mutation is service-only and shares one
-- fail-closed lifecycle flag so challenge intake cannot be disabled while
-- resolution finalization remains live.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.case_resolutions
  add column public_ref text
    constraint case_resolutions_public_ref_check
    check (public_ref is null or public_ref ~ '^OSI-RES-[0-9A-F]{16}$'),
  add column challenge_window_opens_at timestamptz,
  add column selection_quorum_hash text
    constraint case_resolutions_selection_quorum_hash_check
    check (selection_quorum_hash is null or selection_quorum_hash ~ '^[0-9a-f]{64}$'),
  add column final_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  add column seal_quorum_hash text
    constraint case_resolutions_seal_quorum_hash_check
    check (seal_quorum_hash is null or seal_quorum_hash ~ '^[0-9a-f]{64}$'),
  add column seal_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  add column reopened_at timestamptz,
  add column sealed_at timestamptz,
  add constraint case_resolutions_window_order_check
    check (
      challenge_window_opens_at is null
      or (
        challenge_window_ends_at is not null
        and challenge_window_ends_at > challenge_window_opens_at
      )
    ),
  add constraint case_resolutions_native_finalization_check
    check (
      public_ref is null
      or state = 'selection_open'
      or (
        selection_quorum_hash is not null
        and final_receipt_id is not null
        and challenge_window_opens_at is not null
      )
    );

alter table public.resolution_reviews
  add column phase text not null default 'selection'
    constraint resolution_reviews_phase_check
    check (phase in ('selection', 'seal')),
  add column case_id uuid references public.cases (id) on delete restrict,
  add column public_ref text
    constraint resolution_reviews_public_ref_check
    check (public_ref is null or public_ref ~ '^OSI-RRV-[0-9A-F]{16}$'),
  add column reviewer_profile_wallet text
    references public.analyst_profiles (wallet) on delete restrict,
  add column tier_snapshot text
    constraint resolution_reviews_tier_snapshot_check
    check (tier_snapshot is null or tier_snapshot in (
      'probationary', 'analyst_i', 'analyst_ii', 'senior', 'distinguished'
    )),
  add column public_rationale text
    constraint resolution_reviews_public_rationale_check
    check (
      public_rationale is null
      or (
        public_rationale = btrim(public_rationale)
        and char_length(public_rationale) between 10 and 2000
      )
    ),
  add column private_note text
    constraint resolution_reviews_private_note_check
    check (
      private_note is null
      or (
        private_note = btrim(private_note)
        and char_length(private_note) between 1 and 4000
      )
    ),
  add constraint resolution_reviews_native_profile_check
    check (
      public_ref is null
      or (
        case_id is not null
        and reviewer_profile_wallet = reviewer_wallet
        and tier_snapshot is not null
        and public_rationale is not null
      )
    ),
  add constraint resolution_reviews_phase_decision_check
    check (phase <> 'seal' or decision in ('select', 'abstain'));

alter table public.challenges_v2
  add column public_ref text
    constraint challenges_v2_public_ref_check
    check (public_ref is null or public_ref ~ '^OSI-CHL-[0-9A-F]{16}$'),
  add column public_safe_summary text
    constraint challenges_v2_public_safe_summary_check
    check (
      public_safe_summary is null
      or (
        public_safe_summary = btrim(public_safe_summary)
        and char_length(public_safe_summary) between 20 and 2000
      )
    ),
  add column restricted_detail text
    constraint challenges_v2_restricted_detail_check
    check (
      restricted_detail is null
      or (
        restricted_detail = btrim(restricted_detail)
        and char_length(restricted_detail) between 1 and 8000
      )
    ),
  add column evidence_hash text
    constraint challenges_v2_evidence_hash_check
    check (evidence_hash is null or evidence_hash ~ '^[0-9a-f]{64}$'),
  add column outcome_quorum_hash text
    constraint challenges_v2_outcome_quorum_hash_check
    check (outcome_quorum_hash is null or outcome_quorum_hash ~ '^[0-9a-f]{64}$'),
  add column terminal_at timestamptz,
  add constraint challenges_v2_native_content_check
    check (
      public_ref is null
      or (
        public_safe_summary is not null
        and evidence_hash is not null
      )
    ),
  add constraint challenges_v2_terminal_at_check
    check (
      (state in ('accepted', 'rejected', 'withdrawn', 'expired') and terminal_at is not null)
      or (state not in ('accepted', 'rejected', 'withdrawn', 'expired') and terminal_at is null)
    );

alter table public.challenge_reviews
  add column public_ref text
    constraint challenge_reviews_public_ref_check
    check (public_ref is null or public_ref ~ '^OSI-CRV-[0-9A-F]{16}$'),
  add column reviewer_profile_wallet text
    references public.analyst_profiles (wallet) on delete restrict,
  add column tier_snapshot text
    constraint challenge_reviews_tier_snapshot_check
    check (tier_snapshot is null or tier_snapshot in (
      'probationary', 'analyst_i', 'analyst_ii', 'senior', 'distinguished'
    )),
  add column public_rationale text
    constraint challenge_reviews_public_rationale_check
    check (
      public_rationale is null
      or (
        public_rationale = btrim(public_rationale)
        and char_length(public_rationale) between 10 and 2000
      )
    ),
  add column private_note text
    constraint challenge_reviews_private_note_check
    check (
      private_note is null
      or (
        private_note = btrim(private_note)
        and char_length(private_note) between 1 and 4000
      )
    ),
  add constraint challenge_reviews_native_profile_check
    check (
      public_ref is null
      or (
        reviewer_profile_wallet = reviewer_wallet
        and tier_snapshot is not null
        and public_rationale is not null
      )
    );

create unique index case_resolutions_public_ref_uidx
  on public.case_resolutions (public_ref) where public_ref is not null;
create index case_resolutions_case_state_window_idx
  on public.case_resolutions (case_id, state, challenge_window_ends_at);
create unique index resolution_reviews_public_ref_uidx
  on public.resolution_reviews (public_ref) where public_ref is not null;
create index resolution_reviews_phase_quorum_idx
  on public.resolution_reviews (resolution_id, phase, decision, reviewer_wallet)
  where is_active;
create unique index challenges_v2_public_ref_uidx
  on public.challenges_v2 (public_ref) where public_ref is not null;
create index challenges_v2_resolution_state_deadline_idx
  on public.challenges_v2 (resolution_id, state, review_deadline_at)
  where resolution_id is not null;
create unique index challenge_reviews_public_ref_uidx
  on public.challenge_reviews (public_ref) where public_ref is not null;
create index challenge_reviews_merit_quorum_idx
  on public.challenge_reviews (challenge_id, decision, reviewer_wallet)
  where is_active and phase = 'merit';

insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED', 'false', statement_timestamp()),
  ('OSI_V2_CHALLENGE_ADMISSIBILITY_TTL_SECONDS', '86400', statement_timestamp()),
  ('OSI_V2_CHALLENGE_REVIEW_DEADLINE_SECONDS', '259200', statement_timestamp()),
  ('OSI_V2_CHALLENGE_RATE_WINDOW_SECONDS', '3600', statement_timestamp()),
  ('OSI_V2_CHALLENGE_MAX_PER_WALLET', '5', statement_timestamp()),
  ('OSI_V2_CHALLENGE_MAX_PER_FINGERPRINT', '20', statement_timestamp()),
  ('OSI_V2_CHALLENGE_COOLDOWN_SECONDS', '60', statement_timestamp()),
  ('OSI_V2_SEAL_MIN_COUNT', '2', statement_timestamp()),
  ('OSI_V2_SEAL_MIN_WEIGHT', '2.50', statement_timestamp())
on conflict (key) do nothing;

comment on column public.case_resolutions.selection_quorum_hash is
  'Write-once hash of the exact active selection review snapshot used for REPORT_SELECTED_WINNING.';
comment on column public.resolution_reviews.phase is
  'selection chooses an exact published Report version; seal confirms the exact finalized resolution after its clear challenge window.';
comment on column public.challenges_v2.restricted_detail is
  'Restricted challenge material. Never included in an anonymous/public DTO.';

create function osi_private.osi_v2_governance_writes_enabled()
returns boolean
language sql stable security invoker set search_path = ''
as $$
  select coalesce((
    select config.value = 'true'
      from public.osi_config as config
     where config.key = 'OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED'
  ), false)
$$;

create function osi_private.osi_v2_config_integer(
  p_key text,
  p_minimum integer,
  p_maximum integer
)
returns integer
language plpgsql stable security invoker set search_path = ''
as $$
declare value_text text; value_int integer;
begin
  select config.value into value_text
    from public.osi_config as config where config.key = p_key;
  if value_text is null or value_text !~ '^[0-9]+$' then
    raise exception 'OSI governance integer configuration is invalid: %', p_key
      using errcode = '55000';
  end if;
  value_int := value_text::integer;
  if value_int not between p_minimum and p_maximum then
    raise exception 'OSI governance integer configuration is out of range: %', p_key
      using errcode = '55000';
  end if;
  return value_int;
end;
$$;

create function osi_private.osi_v2_governance_payload_hash(
  p_action text,
  p_purpose text,
  p_actor_wallet text,
  p_target_type text,
  p_target_id text,
  p_client_payload jsonb,
  p_server_binding jsonb
)
returns text
language sql immutable security invoker set search_path = ''
as $$
  select encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'action', p_action,
    'actor_wallet', p_actor_wallet,
    'client_payload', p_client_payload,
    'event_type', p_purpose,
    'server_binding', p_server_binding,
    'target_id', p_target_id,
    'target_type', p_target_type
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;

create function osi_private.osi_v2_make_public_ref(p_prefix text, p_id uuid)
returns text
language sql immutable strict security invoker set search_path = ''
as $$
  select p_prefix || upper(substr(replace(p_id::text, '-', ''), 1, 16))
$$;

create function osi_private.osi_v2_eligible_analyst(p_wallet text)
returns boolean
language sql stable security invoker set search_path = ''
as $$
  select exists (
    select 1 from public.analyst_profiles as profile
     where profile.wallet = p_wallet
       and profile.status in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
       and profile.verified is true and profile.approved is true
       and profile.weight_cached between 0.50 and 3.00
  )
$$;

create function osi_private.osi_v2_full_maintainer_binding(
  p_wallet text,
  p_auth_uuid text
)
returns boolean
language sql stable security invoker set search_path = ''
as $$
  select p_auth_uuid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (
      select 1 from public.osi_config as config
       where config.key = 'admin_wallet' and config.value = p_wallet
    )
$$;

create function osi_private.osi_v2_ensure_resolution(p_case_id uuid)
returns public.case_resolutions
language plpgsql security invoker set search_path = ''
as $$
declare
  case_row public.cases%rowtype;
  resolution_row public.case_resolutions%rowtype;
  receipt_id uuid := gen_random_uuid();
  resolution_id uuid := gen_random_uuid();
  resolution_ref text;
  exact_hash text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Resolution creation is service-only' using errcode = '42501';
  end if;
  select resolution.* into resolution_row
    from public.case_resolutions as resolution
   where resolution.case_id = p_case_id
     and resolution.state not in ('reopened', 'resolved_legacy')
   for update;
  if resolution_row.id is not null then return resolution_row; end if;

  select case_item.* into case_row from public.cases as case_item
   where case_item.id = p_case_id for update;
  if case_row.id is null or case_row.visibility <> 'public'
     or case_row.stage not in ('open_public', 'in_review', 'ready_for_finalization', 'reopened')
     or not exists (
       select 1 from public.case_reports as report
       join public.case_report_versions as version
         on version.id = report.current_published_version_id
        and version.report_id = report.id
      where report.case_id = case_row.id
        and version.lifecycle_state = 'published'
     ) then
    raise exception 'Case has no exact published Report available for resolution'
      using errcode = '42501';
  end if;
  if case_row.stage = 'reopened' then
    update public.cases as case_item set stage = 'in_review', updated_at = statement_timestamp()
     where case_item.id = case_row.id and case_item.stage = 'reopened';
    case_row.stage := 'in_review';
  elsif case_row.stage = 'open_public' then
    update public.cases as case_item set stage = 'in_review', updated_at = statement_timestamp()
     where case_item.id = case_row.id and case_item.stage = 'open_public';
    case_row.stage := 'in_review';
  end if;
  if case_row.stage = 'in_review' then
    update public.cases as case_item
       set stage = 'ready_for_finalization', updated_at = statement_timestamp()
     where case_item.id = case_row.id and case_item.stage = 'in_review';
  end if;

  resolution_ref := osi_private.osi_v2_make_public_ref('OSI-RES-', resolution_id);
  exact_hash := encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'case_public_ref', case_row.public_ref,
    'event_type', 'CASE_QUORUM_READY',
    'resolution_public_ref', resolution_ref
  )::text, 'UTF8'), 'sha256'), 'hex');
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_role, proof_type, payload_hash, server_verified, occurred_at, created_at
  ) values (
    receipt_id, 'OSI2', 'CASE_QUORUM_READY', 'case', case_row.id::text,
    case_row.public_ref, 'service', 'system_event', exact_hash, true,
    statement_timestamp(), statement_timestamp()
  );
  insert into public.case_resolutions (
    id, case_id, state, event_receipt_id, public_ref, created_at, updated_at
  ) values (
    resolution_id, case_row.id, 'selection_open', receipt_id, resolution_ref,
    statement_timestamp(), statement_timestamp()
  ) returning * into resolution_row;
  return resolution_row;
end;
$$;

create function osi_private.osi_v2_resolution_quorum(p_resolution_id uuid)
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

create function osi_private.osi_v2_seal_quorum(p_resolution_id uuid)
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
     and review.is_active = true and review.decision = 'select';
  required_count := minimum_count; required_weight := minimum_weight;
  ready := approve_count >= minimum_count and approve_weight >= minimum_weight;
  quorum_hash := encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'resolution_id', p_resolution_id, 'reviews', snapshot,
    'required_count', minimum_count, 'required_weight', minimum_weight
  )::text, 'UTF8'), 'sha256'), 'hex');
  return next;
end;
$$;

create function osi_private.osi_v2_challenge_quorum(p_challenge_id uuid)
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
     and review.is_active = true;
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

create function osi_private.osi_v2_check_challenge_rate(
  p_actor_wallet text,
  p_request_fingerprint_hash text,
  p_now timestamptz
)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare window_seconds integer; wallet_max integer; fingerprint_max integer;
begin
  window_seconds := osi_private.osi_v2_config_integer('OSI_V2_CHALLENGE_RATE_WINDOW_SECONDS', 60, 86400);
  wallet_max := osi_private.osi_v2_config_integer('OSI_V2_CHALLENGE_MAX_PER_WALLET', 1, 100);
  fingerprint_max := osi_private.osi_v2_config_integer('OSI_V2_CHALLENGE_MAX_PER_FINGERPRINT', 1, 500);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-challenge-wallet:' || p_actor_wallet, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-challenge-fingerprint:' || p_request_fingerprint_hash, 0)
  );
  if (select count(*) from public.osi_nonces as nonce
       where nonce.actor_wallet = p_actor_wallet
         and nonce.purpose = 'CHALLENGE_SUBMITTED'
         and nonce.issued_at >= p_now - pg_catalog.make_interval(secs => window_seconds)) >= wallet_max then
    raise exception 'Challenge wallet rate limit exceeded' using errcode = 'P0001';
  end if;
  if (select count(*) from public.osi_nonces as nonce
       where nonce.request_fingerprint_hash = p_request_fingerprint_hash
         and nonce.purpose = 'CHALLENGE_SUBMITTED'
         and nonce.issued_at >= p_now - pg_catalog.make_interval(secs => window_seconds)) >= fingerprint_max then
    raise exception 'Challenge fingerprint rate limit exceeded' using errcode = 'P0001';
  end if;
end;
$$;

create function osi_private.osi_v2_prepare_governance_action(
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
language plpgsql security invoker set search_path = ''
as $$
declare
  existing public.osi_nonces%rowtype;
  case_row public.cases%rowtype;
  resolution_row public.case_resolutions%rowtype;
  version_row public.case_report_versions%rowtype;
  report_row public.case_reports%rowtype;
  challenge_row public.challenges_v2%rowtype;
  evidence_row public.evidence_items%rowtype;
  profile public.analyst_profiles%rowtype;
  resolution_quorum record;
  challenge_quorum record;
  seal_quorum record;
  action_purpose text;
  action_target_type text;
  action_target_id text;
  action_target_ref text;
  receipt_role text;
  snapshot_weight numeric;
  exact_hash text;
  server_binding jsonb := '{}'::jsonb;
  canonical_proof text;
  transport text;
  issued_time timestamptz := statement_timestamp();
  expires_time timestamptz;
  ttl_seconds integer;
  challenge_id uuid;
  review_id uuid;
  evidence_id uuid;
  challenge_quorum_hash text;
  cooldown_seconds integer;
  window_days integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Governance prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_governance_writes_enabled() is distinct from true then
    raise exception 'OSI V2 resolution lifecycle writes are disabled' using errcode = '55000';
  end if;
  if p_action is null or p_action not in (
    'resolution_review', 'resolution_finalize', 'challenge_submit',
    'challenge_admit', 'challenge_review', 'challenge_withdraw',
    'challenge_finalize', 'seal_finalize'
  ) or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Governance action is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-governance-idempotency:' || p_idempotency_key, 0)
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
      raise exception 'Idempotency key is bound to another exact governance action'
        using errcode = '23514';
    end if;
    return query select existing.nonce, existing.purpose,
      existing.target_type, existing.target_id,
      existing.binding_context->>'target_public_ref',
      existing.binding_context->>'actor_role',
      nullif(existing.binding_context->>'weight', '')::numeric,
      existing.payload_hash, existing.binding_context->>'quorum_hash',
      existing.binding_context->>'proof_text',
      public.osi_v2_expected_proof_type(existing.purpose),
      existing.issued_at, existing.expires_at,
      existing.consumed_by_receipt_id, true;
    return;
  end if;

  select profile_row.* into profile from public.analyst_profiles as profile_row
   where profile_row.wallet = p_actor_wallet;

  if p_action = 'resolution_review' then
    if p_payload->>'phase' is null
       or p_payload->>'phase' not in ('selection', 'seal')
       or p_payload->>'decision' is null
       or p_payload->>'decision' not in ('select', 'object', 'abstain')
       or (p_payload->>'phase' = 'seal' and p_payload->>'decision' = 'object')
       or p_payload->>'reason_code' !~ '^[a-z][a-z0-9_:-]{0,95}$'
       or p_payload->>'public_rationale' is null
       or p_payload->>'public_rationale' <> btrim(p_payload->>'public_rationale')
       or char_length(p_payload->>'public_rationale') not between 10 and 2000
       or (p_payload ? 'private_note' and p_payload->>'private_note' is not null and (
         p_payload->>'private_note' <> btrim(p_payload->>'private_note')
         or char_length(p_payload->>'private_note') not between 1 and 4000
       )) then
      raise exception 'Resolution review payload is invalid' using errcode = '22023';
    end if;
    if osi_private.osi_v2_eligible_analyst(p_actor_wallet) is distinct from true then
      raise exception 'Resolution review requires an eligible analyst' using errcode = '42501';
    end if;
    select case_item.* into case_row from public.cases as case_item
     where case_item.public_ref = p_target_ref for update;
    if case_row.id is null then raise exception 'Case is not available' using errcode = '42501'; end if;
    resolution_row := osi_private.osi_v2_ensure_resolution(case_row.id);
    if p_payload->>'phase' = 'selection' then
      select version.* into version_row from public.case_report_versions as version
       where version.version_ref = p_payload->>'report_version_ref';
      select report.* into report_row from public.case_reports as report
       where report.id = version_row.report_id;
      if resolution_row.state <> 'selection_open' or version_row.id is null
         or version_row.lifecycle_state <> 'published'
         or report_row.case_id is distinct from case_row.id
         or report_row.current_published_version_id is distinct from version_row.id then
        raise exception 'Resolution selection requires an exact currently published Case Report version'
          using errcode = '42501';
      end if;
    else
      version_row.id := resolution_row.winning_report_version_id;
      select version.* into version_row from public.case_report_versions as version
       where version.id = resolution_row.winning_report_version_id;
      select report.* into report_row from public.case_reports as report where report.id = version_row.report_id;
      if resolution_row.state <> 'in_challenge_window'
         or p_payload->>'report_version_ref' is distinct from version_row.version_ref
         or resolution_row.challenge_window_ends_at > issued_time
         or exists (
           select 1 from public.challenges_v2 as challenge
            where challenge.resolution_id = resolution_row.id
              and challenge.state in ('open', 'under_review')
         ) then
        raise exception 'Seal review requires a clear ended challenge window' using errcode = '42501';
      end if;
    end if;
    if p_actor_wallet in (case_row.submitted_by_wallet, report_row.author_wallet) then
      raise exception 'Case owner and selected Report author cannot cast this counted review'
        using errcode = '42501';
    end if;
    review_id := gen_random_uuid();
    action_purpose := case when exists (
      select 1 from public.resolution_reviews as review
       where review.resolution_id = resolution_row.id
         and review.reviewer_wallet = p_actor_wallet
         and review.phase = p_payload->>'phase'
    ) then 'RESOLUTION_REVIEW_REVISED' else 'RESOLUTION_REVIEW_CAST' end;
    action_target_type := 'resolution'; action_target_id := resolution_row.id::text;
    action_target_ref := osi_private.osi_v2_make_public_ref('OSI-RRV-', review_id);
    receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
    snapshot_weight := profile.weight_cached;
    server_binding := jsonb_build_object(
      'case_id', case_row.id, 'case_public_ref', case_row.public_ref,
      'phase', p_payload->>'phase', 'report_version_id', version_row.id,
      'report_version_ref', version_row.version_ref,
      'resolution_id', resolution_row.id, 'resolution_public_ref', resolution_row.public_ref,
      'review_id', review_id, 'review_public_ref', action_target_ref,
      'tier_snapshot', profile.tier_code, 'weight', profile.weight_cached
    );

  elsif p_action = 'resolution_finalize' then
    if osi_private.osi_v2_full_maintainer_binding(p_actor_wallet, p_maintainer_auth_uuid) is distinct from true then
      raise exception 'Resolution finalization requires both maintainer gates' using errcode = '42501';
    end if;
    select resolution.* into resolution_row from public.case_resolutions as resolution
     where resolution.public_ref = p_target_ref for update;
    select case_item.* into case_row from public.cases as case_item where case_item.id = resolution_row.case_id;
    select * into resolution_quorum from osi_private.osi_v2_resolution_quorum(resolution_row.id);
    if resolution_row.state <> 'selection_open' or resolution_quorum.leader_version_id is null
       or resolution_quorum.tie_unresolved is true then
      raise exception 'Resolution has no unique server-derived quorum leader' using errcode = '42501';
    end if;
    select version.* into version_row from public.case_report_versions as version
     where version.id = resolution_quorum.leader_version_id;
    window_days := osi_private.osi_v2_config_integer('OSI_V2_CHALLENGE_WINDOW_DAYS', 1, 30);
    action_purpose := 'REPORT_SELECTED_WINNING'; action_target_type := 'resolution';
    action_target_id := resolution_row.id::text; action_target_ref := resolution_row.public_ref;
    receipt_role := 'maintainer'; snapshot_weight := null;
    server_binding := jsonb_build_object(
      'case_id', case_row.id, 'case_public_ref', case_row.public_ref,
      'challenge_window_days', window_days,
      'leader_count', resolution_quorum.leader_count,
      'leader_weight', resolution_quorum.leader_weight,
      'quorum_hash', resolution_quorum.quorum_hash,
      'report_version_id', version_row.id, 'report_version_ref', version_row.version_ref,
      'resolution_id', resolution_row.id, 'resolution_public_ref', resolution_row.public_ref
    );

  elsif p_action = 'challenge_submit' then
    if p_payload->>'reason_code' !~ '^[a-z][a-z0-9_:-]{0,95}$'
       or p_payload->>'public_safe_summary' is null
       or p_payload->>'public_safe_summary' <> btrim(p_payload->>'public_safe_summary')
       or char_length(p_payload->>'public_safe_summary') not between 20 and 2000
       or (p_payload ? 'restricted_detail' and p_payload->>'restricted_detail' is not null and (
         p_payload->>'restricted_detail' <> btrim(p_payload->>'restricted_detail')
         or char_length(p_payload->>'restricted_detail') not between 1 and 8000
       )) or p_payload->>'evidence_item_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Challenge submission payload is invalid' using errcode = '22023';
    end if;
    select resolution.* into resolution_row from public.case_resolutions as resolution
     where resolution.public_ref = p_target_ref for update;
    select case_item.* into case_row from public.cases as case_item where case_item.id = resolution_row.case_id;
    evidence_id := (p_payload->>'evidence_item_id')::uuid;
    select evidence.* into evidence_row from public.evidence_items as evidence where evidence.id = evidence_id;
    if resolution_row.state <> 'in_challenge_window'
       or issued_time < resolution_row.challenge_window_opens_at
       or issued_time >= resolution_row.challenge_window_ends_at
       or evidence_row.id is null
       or not (
         exists (
           select 1 from public.case_evidence_links as link
            where link.case_id = case_row.id and link.evidence_item_id = evidence_row.id
         )
         or exists (
           select 1 from public.case_report_version_evidence as link
            where link.report_version_id = resolution_row.winning_report_version_id
              and link.evidence_item_id = evidence_row.id
         )
       ) then
      raise exception 'Challenge requires an active exact resolution window and existing evidence item'
        using errcode = '42501';
    end if;
    if exists (
      select 1 from public.challenges_v2 as challenge
       where challenge.challenger_wallet = p_actor_wallet
         and challenge.resolution_id = resolution_row.id
         and challenge.state in ('submitted', 'admissibility_review', 'open', 'under_review')
    ) then raise exception 'An active challenge already exists for this wallet and resolution'
      using errcode = '23505'; end if;
    cooldown_seconds := osi_private.osi_v2_config_integer('OSI_V2_CHALLENGE_COOLDOWN_SECONDS', 1, 86400);
    if exists (
      select 1 from public.challenges_v2 as challenge
       where challenge.challenger_wallet = p_actor_wallet
         and challenge.resolution_id = resolution_row.id
         and challenge.created_at > issued_time - pg_catalog.make_interval(secs => cooldown_seconds)
    ) then raise exception 'Challenge cooldown is active' using errcode = 'P0001'; end if;
    perform osi_private.osi_v2_check_challenge_rate(p_actor_wallet, p_request_fingerprint_hash, issued_time);
    challenge_id := gen_random_uuid();
    action_purpose := 'CHALLENGE_SUBMITTED'; action_target_type := 'challenge';
    action_target_id := challenge_id::text;
    action_target_ref := osi_private.osi_v2_make_public_ref('OSI-CHL-', challenge_id);
    receipt_role := 'wallet'; snapshot_weight := null;
    server_binding := jsonb_build_object(
      'case_id', case_row.id, 'case_public_ref', case_row.public_ref,
      'challenge_id', challenge_id, 'challenge_public_ref', action_target_ref,
      'evidence_hash', evidence_row.sha256, 'evidence_item_id', evidence_row.id,
      'resolution_id', resolution_row.id, 'resolution_public_ref', resolution_row.public_ref
    );

  elsif p_action in ('challenge_admit', 'challenge_review', 'challenge_withdraw', 'challenge_finalize') then
    select challenge.* into challenge_row from public.challenges_v2 as challenge
     where challenge.public_ref = p_target_ref for update;
    select resolution.* into resolution_row from public.case_resolutions as resolution
     where resolution.id = challenge_row.resolution_id for update;
    select case_item.* into case_row from public.cases as case_item where case_item.id = resolution_row.case_id;
    select version.* into version_row from public.case_report_versions as version
     where version.id = resolution_row.winning_report_version_id;
    select report.* into report_row from public.case_reports as report where report.id = version_row.report_id;
    if challenge_row.id is null or challenge_row.target_kind <> 'resolution' then
      raise exception 'Challenge is not available' using errcode = '42501';
    end if;
    if p_action <> 'challenge_withdraw'
       and p_actor_wallet in (challenge_row.challenger_wallet, case_row.submitted_by_wallet, report_row.author_wallet) then
      raise exception 'Challenge submitter, Case owner and selected Report author are conflicted'
        using errcode = '42501';
    end if;
    if p_action = 'challenge_admit' then
      if challenge_row.state not in ('submitted', 'admissibility_review')
         or issued_time >= challenge_row.admissibility_ttl_at
         or p_payload->>'decision' is null
         or p_payload->>'decision' not in ('accept', 'reject') then
        raise exception 'Challenge is not available for admissibility' using errcode = '42501';
      end if;
      if p_payload->>'route' = 'maintainer' then
        if osi_private.osi_v2_full_maintainer_binding(p_actor_wallet, p_maintainer_auth_uuid) is distinct from true then
          raise exception 'Maintainer admissibility requires both maintainer gates' using errcode = '42501';
        end if;
        receipt_role := 'maintainer'; snapshot_weight := null;
      elsif p_payload->>'route' = 'analyst' and osi_private.osi_v2_eligible_analyst(p_actor_wallet) then
        receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
        snapshot_weight := profile.weight_cached;
      else raise exception 'Admissibility requires an eligible analyst or full maintainer'
        using errcode = '42501'; end if;
      action_purpose := case when p_payload->>'decision' = 'accept'
        then 'CHALLENGE_ADMISSIBILITY_ACCEPTED' else 'CHALLENGE_ADMISSIBILITY_REJECTED' end;
    elsif p_action = 'challenge_review' then
      if challenge_row.state not in ('open', 'under_review')
         or issued_time >= challenge_row.review_deadline_at
         or p_payload->>'decision' not in ('accept', 'reject')
         or osi_private.osi_v2_eligible_analyst(p_actor_wallet) is distinct from true
         or p_payload->>'reason_code' !~ '^[a-z][a-z0-9_:-]{0,95}$'
         or p_payload->>'public_rationale' is null
         or p_payload->>'public_rationale' <> btrim(p_payload->>'public_rationale')
         or char_length(p_payload->>'public_rationale') not between 10 and 2000 then
        raise exception 'Challenge review payload or actor is invalid' using errcode = '42501';
      end if;
      review_id := gen_random_uuid();
      action_purpose := case when exists (
        select 1 from public.challenge_reviews as review
         where review.challenge_id = challenge_row.id
           and review.reviewer_wallet = p_actor_wallet and review.phase = 'merit'
      ) then 'CHALLENGE_REVIEW_REVISED' else 'CHALLENGE_REVIEW_CAST' end;
      receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
      snapshot_weight := profile.weight_cached;
    elsif p_action = 'challenge_withdraw' then
      if challenge_row.challenger_wallet <> p_actor_wallet
         or challenge_row.state not in ('submitted', 'admissibility_review', 'open', 'under_review') then
        raise exception 'Only the challenger may withdraw an active challenge' using errcode = '42501';
      end if;
      action_purpose := 'CHALLENGE_WITHDRAWN'; receipt_role := 'wallet'; snapshot_weight := null;
    else
      if challenge_row.state <> 'under_review'
         or issued_time >= challenge_row.review_deadline_at
         or osi_private.osi_v2_eligible_analyst(p_actor_wallet) is distinct from true then
        raise exception 'Challenge outcome is not available' using errcode = '42501';
      end if;
      select * into challenge_quorum from osi_private.osi_v2_challenge_quorum(challenge_row.id);
      if challenge_quorum.outcome is null or challenge_quorum.tie_unresolved is true
         or not exists (
           select 1 from public.challenge_reviews as review
            where review.challenge_id = challenge_row.id and review.phase = 'merit'
              and review.reviewer_wallet = p_actor_wallet and review.is_active = true
              and review.decision = challenge_quorum.outcome
         ) then
        raise exception 'Challenge has no unique quorum outcome for this analyst'
          using errcode = '42501';
      end if;
      action_purpose := case when challenge_quorum.outcome = 'accept'
        then 'CHALLENGE_ACCEPTED' else 'CHALLENGE_REJECTED' end;
      receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
      snapshot_weight := null;
      challenge_quorum_hash := challenge_quorum.quorum_hash;
    end if;
    action_target_type := 'challenge'; action_target_id := challenge_row.id::text;
    action_target_ref := challenge_row.public_ref;
    server_binding := jsonb_build_object(
      'case_id', case_row.id, 'case_public_ref', case_row.public_ref,
      'challenge_id', challenge_row.id, 'challenge_public_ref', challenge_row.public_ref,
      'resolution_id', resolution_row.id, 'resolution_public_ref', resolution_row.public_ref,
      'tier_snapshot', profile.tier_code, 'weight', snapshot_weight,
      'review_id', review_id,
      'review_public_ref', case when review_id is null then null
        else osi_private.osi_v2_make_public_ref('OSI-CRV-', review_id) end,
      'quorum_hash', challenge_quorum_hash
    );

  else
    if osi_private.osi_v2_full_maintainer_binding(p_actor_wallet, p_maintainer_auth_uuid) is distinct from true then
      raise exception 'Seal finalization requires both maintainer gates' using errcode = '42501';
    end if;
    select resolution.* into resolution_row from public.case_resolutions as resolution
     where resolution.public_ref = p_target_ref for update;
    select case_item.* into case_row from public.cases as case_item where case_item.id = resolution_row.case_id;
    select * into seal_quorum from osi_private.osi_v2_seal_quorum(resolution_row.id);
    if resolution_row.state <> 'in_challenge_window'
       or resolution_row.challenge_window_ends_at > issued_time
       or seal_quorum.ready is distinct from true
       or exists (
         select 1 from public.challenges_v2 as challenge
          where challenge.resolution_id = resolution_row.id
            and challenge.state in ('open', 'under_review')
       ) then
      raise exception 'Case is not seal-ready' using errcode = '42501';
    end if;
    action_purpose := 'RECORD_SEALED'; action_target_type := 'resolution';
    action_target_id := resolution_row.id::text; action_target_ref := resolution_row.public_ref;
    receipt_role := 'maintainer'; snapshot_weight := null;
    server_binding := jsonb_build_object(
      'case_id', case_row.id, 'case_public_ref', case_row.public_ref,
      'quorum_hash', seal_quorum.quorum_hash,
      'resolution_id', resolution_row.id, 'resolution_public_ref', resolution_row.public_ref,
      'winning_report_version_id', resolution_row.winning_report_version_id
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
    raise exception 'Governance event transport is not canonical' using errcode = '55000';
  end if;
  canonical_proof := concat_ws('|', 'OSI2', action_purpose,
    't=' || action_target_type, 'id=' || action_target_id,
    'ref=' || action_target_ref, 'a=' || p_actor_wallet,
    'h=' || exact_hash, 'n=' || p_nonce,
    'ts=' || floor(extract(epoch from issued_time) * 1000)::bigint,
    'exp=' || floor(extract(epoch from expires_time) * 1000)::bigint
  );
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, action_purpose, p_actor_wallet, action_target_type, action_target_id,
    exact_hash, p_idempotency_key, p_request_fingerprint_hash,
    jsonb_build_object(
      'action', p_action, 'actor_role', receipt_role,
      'client_payload', p_payload, 'maintainer_auth_uuid', coalesce(p_maintainer_auth_uuid, ''),
      'proof_text', canonical_proof, 'quorum_hash', server_binding->>'quorum_hash',
      'server_binding', server_binding, 'target_public_ref', action_target_ref,
      'target_ref', p_target_ref, 'weight', coalesce(snapshot_weight::text, '')
    ), issued_time, expires_time
  );
  return query select p_nonce, action_purpose, action_target_type,
    action_target_id, action_target_ref, receipt_role, snapshot_weight,
    exact_hash, server_binding->>'quorum_hash', canonical_proof, transport,
    issued_time, expires_time, null::uuid, false;
end;
$$;

create function osi_private.osi_v2_commit_governance_action(
  p_nonce text,
  p_payload jsonb,
  p_proof_text text,
  p_signature text default null,
  p_tx_sig text default null,
  p_occurred_at timestamptz default null,
  p_maintainer_auth_uuid text default null
)
returns table (
  action text, purpose text, target_public_ref text,
  case_public_ref text, resolution_public_ref text,
  challenge_public_ref text, state text, receipt_id uuid,
  idempotent_replay boolean
)
language plpgsql security invoker set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  existing_receipt public.event_receipts%rowtype;
  case_row public.cases%rowtype;
  resolution_row public.case_resolutions%rowtype;
  version_row public.case_report_versions%rowtype;
  report_row public.case_reports%rowtype;
  challenge_row public.challenges_v2%rowtype;
  evidence_row public.evidence_items%rowtype;
  profile public.analyst_profiles%rowtype;
  prior_resolution_review public.resolution_reviews%rowtype;
  prior_challenge_review public.challenge_reviews%rowtype;
  resolution_quorum record;
  challenge_quorum record;
  seal_quorum record;
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
  result_case_ref text;
  result_resolution_ref text;
  result_challenge_ref text;
  result_state text;
  review_deadline_seconds integer;
  admissibility_ttl_seconds integer;
  window_days integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Governance commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_governance_writes_enabled() is distinct from true then
    raise exception 'OSI V2 resolution lifecycle writes are disabled' using errcode = '55000';
  end if;
  select nonce.* into bound from public.osi_nonces as nonce
   where nonce.nonce = p_nonce for update;
  if bound.nonce is null or bound.binding_context->>'action' is null then
    raise exception 'Governance nonce binding is invalid' using errcode = '23514';
  end if;
  context := bound.binding_context;
  binding := context->'server_binding';
  action_name := context->>'action';
  receipt_role := context->>'actor_role';
  transport := public.osi_v2_expected_proof_type(bound.purpose);
  if context->'client_payload' is distinct from p_payload
     or context->>'proof_text' is distinct from p_proof_text
     or coalesce(context->>'maintainer_auth_uuid', '')
        is distinct from coalesce(p_maintainer_auth_uuid, '') then
    raise exception 'Governance payload, proof text or maintainer binding changed after prepare'
      using errcode = '23514';
  end if;
  expected_hash := osi_private.osi_v2_governance_payload_hash(
    action_name, bound.purpose, bound.actor_wallet, bound.target_type,
    bound.target_id, p_payload, binding
  );
  if expected_hash is distinct from bound.payload_hash then
    raise exception 'Governance payload hash binding is invalid' using errcode = '23514';
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
      raise exception 'Consumed governance nonce does not match exact retry'
        using errcode = '23514';
    end if;
    return query select action_name, bound.purpose,
      context->>'target_public_ref', binding->>'case_public_ref',
      binding->>'resolution_public_ref', binding->>'challenge_public_ref',
      coalesce((select challenge.state from public.challenges_v2 as challenge
        where challenge.id::text = bound.target_id),
        (select resolution.state from public.case_resolutions as resolution
          where resolution.id::text = bound.target_id)),
      existing_receipt.id, true;
    return;
  end if;
  if statement_timestamp() > bound.expires_at then
    raise exception 'Governance nonce expired' using errcode = '22023';
  end if;
  if transport = 'wallet_signed_server_verified' then
    if p_signature is null or char_length(p_signature) not between 64 and 256
       or p_tx_sig is not null or p_occurred_at is not null then
      raise exception 'Signed governance proof material is invalid' using errcode = '23514';
    end if;
  elsif transport = 'solana_memo' then
    if p_signature is not null or p_tx_sig !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'
       or p_occurred_at is null
       or p_occurred_at > statement_timestamp() + interval '30 seconds'
       or p_occurred_at < bound.issued_at - interval '30 seconds' then
      raise exception 'Memo governance proof material is invalid' using errcode = '23514';
    end if;
  else
    raise exception 'Governance event transport is invalid' using errcode = '55000';
  end if;

  select profile_row.* into profile from public.analyst_profiles as profile_row
   where profile_row.wallet = bound.actor_wallet;

  if action_name = 'resolution_review' then
    select resolution.* into resolution_row from public.case_resolutions as resolution
     where resolution.id = bound.target_id::uuid for update;
    select case_item.* into case_row from public.cases as case_item
     where case_item.id = resolution_row.case_id for update;
    select version.* into version_row from public.case_report_versions as version
     where version.id = (binding->>'report_version_id')::uuid;
    select report.* into report_row from public.case_reports as report where report.id = version_row.report_id;
    if osi_private.osi_v2_eligible_analyst(bound.actor_wallet) is distinct from true
       or profile.tier_code is distinct from binding->>'tier_snapshot'
       or profile.weight_cached is distinct from (binding->>'weight')::numeric
       or bound.actor_wallet in (case_row.submitted_by_wallet, report_row.author_wallet)
       or version_row.version_ref is distinct from binding->>'report_version_ref' then
      raise exception 'Resolution reviewer eligibility or exact binding changed'
        using errcode = '42501';
    end if;
    if p_payload->>'phase' = 'selection' then
      if resolution_row.state <> 'selection_open'
         or version_row.lifecycle_state <> 'published'
         or report_row.current_published_version_id is distinct from version_row.id
         or report_row.case_id is distinct from case_row.id then
        raise exception 'Resolution selection target changed after prepare' using errcode = '40001';
      end if;
    else
      if resolution_row.state <> 'in_challenge_window'
         or resolution_row.winning_report_version_id is distinct from version_row.id
         or resolution_row.challenge_window_ends_at > statement_timestamp()
         or exists (
           select 1 from public.challenges_v2 as challenge
            where challenge.resolution_id = resolution_row.id
              and challenge.state in ('open', 'under_review')
         ) then
        raise exception 'Seal review target is no longer eligible' using errcode = '40001';
      end if;
    end if;
    review_id := (binding->>'review_id')::uuid;
    select review.* into prior_resolution_review from public.resolution_reviews as review
     where review.resolution_id = resolution_row.id
       and review.reviewer_wallet = bound.actor_wallet and review.is_active = true
     for update;
    receipt_weight := profile.weight_cached;
    result_case_ref := case_row.public_ref; result_resolution_ref := resolution_row.public_ref;
    result_state := resolution_row.state;

  elsif action_name = 'resolution_finalize' then
    if osi_private.osi_v2_full_maintainer_binding(bound.actor_wallet, p_maintainer_auth_uuid) is distinct from true then
      raise exception 'Resolution finalization lost a maintainer gate' using errcode = '42501';
    end if;
    select resolution.* into resolution_row from public.case_resolutions as resolution
     where resolution.id = bound.target_id::uuid for update;
    select case_item.* into case_row from public.cases as case_item
     where case_item.id = resolution_row.case_id for update;
    select * into resolution_quorum from osi_private.osi_v2_resolution_quorum(resolution_row.id);
    if resolution_row.state <> 'selection_open'
       or resolution_quorum.leader_version_id::text is distinct from binding->>'report_version_id'
       or resolution_quorum.quorum_hash is distinct from binding->>'quorum_hash'
       or resolution_quorum.tie_unresolved is true then
      raise exception 'Resolution quorum changed after prepare' using errcode = '40001';
    end if;
    window_days := (binding->>'challenge_window_days')::integer;
    result_case_ref := case_row.public_ref; result_resolution_ref := resolution_row.public_ref;

  elsif action_name = 'challenge_submit' then
    select resolution.* into resolution_row from public.case_resolutions as resolution
     where resolution.id = (binding->>'resolution_id')::uuid for update;
    select case_item.* into case_row from public.cases as case_item
     where case_item.id = resolution_row.case_id for update;
    select evidence.* into evidence_row from public.evidence_items as evidence
     where evidence.id = (binding->>'evidence_item_id')::uuid;
    if resolution_row.state <> 'in_challenge_window'
       or statement_timestamp() < resolution_row.challenge_window_opens_at
       or statement_timestamp() >= resolution_row.challenge_window_ends_at
       or evidence_row.sha256 is distinct from binding->>'evidence_hash'
       or not (
         exists (
           select 1 from public.case_evidence_links as link
            where link.case_id = case_row.id and link.evidence_item_id = evidence_row.id
         )
         or exists (
           select 1 from public.case_report_version_evidence as link
            where link.report_version_id = resolution_row.winning_report_version_id
              and link.evidence_item_id = evidence_row.id
         )
       )
       or exists (
         select 1 from public.challenges_v2 as challenge
          where challenge.challenger_wallet = bound.actor_wallet
            and challenge.resolution_id = resolution_row.id
            and challenge.state in ('submitted', 'admissibility_review', 'open', 'under_review')
       ) then
      raise exception 'Challenge target, evidence or active-window binding changed'
        using errcode = '40001';
    end if;
    result_case_ref := case_row.public_ref;
    result_resolution_ref := resolution_row.public_ref;
    result_challenge_ref := binding->>'challenge_public_ref';
    result_state := 'submitted';

  elsif action_name in ('challenge_admit', 'challenge_review', 'challenge_withdraw', 'challenge_finalize') then
    select challenge.* into challenge_row from public.challenges_v2 as challenge
     where challenge.id = bound.target_id::uuid for update;
    select resolution.* into resolution_row from public.case_resolutions as resolution
     where resolution.id = challenge_row.resolution_id for update;
    select case_item.* into case_row from public.cases as case_item
     where case_item.id = resolution_row.case_id for update;
    select version.* into version_row from public.case_report_versions as version
     where version.id = resolution_row.winning_report_version_id;
    select report.* into report_row from public.case_reports as report where report.id = version_row.report_id;
    if challenge_row.public_ref is distinct from binding->>'challenge_public_ref' then
      raise exception 'Challenge identity changed after prepare' using errcode = '40001';
    end if;
    if action_name <> 'challenge_withdraw'
       and bound.actor_wallet in (challenge_row.challenger_wallet, case_row.submitted_by_wallet, report_row.author_wallet) then
      raise exception 'Challenge actor is now conflicted' using errcode = '42501';
    end if;
    if action_name = 'challenge_admit' then
      if challenge_row.state not in ('submitted', 'admissibility_review')
         or statement_timestamp() >= challenge_row.admissibility_ttl_at then
        raise exception 'Challenge admissibility state changed' using errcode = '40001';
      end if;
      if p_payload->>'route' = 'maintainer' then
        if osi_private.osi_v2_full_maintainer_binding(bound.actor_wallet, p_maintainer_auth_uuid) is distinct from true then
          raise exception 'Challenge admissibility lost a maintainer gate' using errcode = '42501';
        end if;
      elsif osi_private.osi_v2_eligible_analyst(bound.actor_wallet) is distinct from true then
        raise exception 'Challenge admissibility analyst is no longer eligible' using errcode = '42501';
      end if;
    elsif action_name = 'challenge_review' then
      if challenge_row.state not in ('open', 'under_review')
         or statement_timestamp() >= challenge_row.review_deadline_at
         or osi_private.osi_v2_eligible_analyst(bound.actor_wallet) is distinct from true
         or profile.tier_code is distinct from binding->>'tier_snapshot'
         or profile.weight_cached is distinct from (binding->>'weight')::numeric then
        raise exception 'Challenge review state or eligibility changed' using errcode = '40001';
      end if;
      review_id := (binding->>'review_id')::uuid;
      select review.* into prior_challenge_review from public.challenge_reviews as review
       where review.challenge_id = challenge_row.id and review.phase = 'merit'
         and review.reviewer_wallet = bound.actor_wallet and review.is_active = true
       for update;
      receipt_weight := profile.weight_cached;
    elsif action_name = 'challenge_withdraw' then
      if challenge_row.challenger_wallet <> bound.actor_wallet
         or challenge_row.state not in ('submitted', 'admissibility_review', 'open', 'under_review') then
        raise exception 'Challenge is no longer withdrawable by this wallet' using errcode = '40001';
      end if;
    else
      select * into challenge_quorum from osi_private.osi_v2_challenge_quorum(challenge_row.id);
      if challenge_row.state <> 'under_review'
         or statement_timestamp() >= challenge_row.review_deadline_at
         or osi_private.osi_v2_eligible_analyst(bound.actor_wallet) is distinct from true
         or challenge_quorum.quorum_hash is distinct from binding->>'quorum_hash'
         or bound.purpose is distinct from case when challenge_quorum.outcome = 'accept'
           then 'CHALLENGE_ACCEPTED' else 'CHALLENGE_REJECTED' end
         or not exists (
           select 1 from public.challenge_reviews as review
            where review.challenge_id = challenge_row.id and review.phase = 'merit'
              and review.reviewer_wallet = bound.actor_wallet and review.is_active = true
              and review.decision = challenge_quorum.outcome
         ) then
        raise exception 'Challenge quorum changed after prepare' using errcode = '40001';
      end if;
    end if;
    result_case_ref := case_row.public_ref; result_resolution_ref := resolution_row.public_ref;
    result_challenge_ref := challenge_row.public_ref; result_state := challenge_row.state;

  else
    if osi_private.osi_v2_full_maintainer_binding(bound.actor_wallet, p_maintainer_auth_uuid) is distinct from true then
      raise exception 'Seal finalization lost a maintainer gate' using errcode = '42501';
    end if;
    select resolution.* into resolution_row from public.case_resolutions as resolution
     where resolution.id = bound.target_id::uuid for update;
    select case_item.* into case_row from public.cases as case_item
     where case_item.id = resolution_row.case_id for update;
    select * into seal_quorum from osi_private.osi_v2_seal_quorum(resolution_row.id);
    if resolution_row.state <> 'in_challenge_window'
       or resolution_row.challenge_window_ends_at > statement_timestamp()
       or seal_quorum.ready is distinct from true
       or seal_quorum.quorum_hash is distinct from binding->>'quorum_hash'
       or exists (
         select 1 from public.challenges_v2 as challenge
          where challenge.resolution_id = resolution_row.id
            and challenge.state in ('open', 'under_review')
       ) then
      raise exception 'Seal quorum or clear-window binding changed after prepare'
        using errcode = '40001';
    end if;
    result_case_ref := case_row.public_ref; result_resolution_ref := resolution_row.public_ref;
  end if;

  decision_value := coalesce(p_payload->>'decision', case
    when bound.purpose = 'REPORT_SELECTED_WINNING' then 'select'
    when bound.purpose = 'CHALLENGE_SUBMITTED' then 'submit'
    when bound.purpose = 'CHALLENGE_WITHDRAWN' then 'withdraw'
    when bound.purpose = 'CHALLENGE_ACCEPTED' then 'accept'
    when bound.purpose = 'CHALLENGE_REJECTED' then 'reject'
    when bound.purpose = 'RECORD_SEALED' then 'seal'
    else 'record' end);
  reason_value := p_payload->>'reason_code';
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, weight, reason_code, proof_type,
    memo_ref, anchor_wallet, payload_hash, nonce, tx_sig, signature,
    server_verified, occurred_at, created_at
  ) values (
    new_receipt_id, 'OSI2', bound.purpose, bound.target_type, bound.target_id,
    case when action_name in ('resolution_review', 'challenge_review')
      then binding->>'review_public_ref' else context->>'target_public_ref' end,
    bound.actor_wallet, receipt_role, decision_value, receipt_weight,
    reason_value, transport, p_proof_text,
    case when transport = 'solana_memo' then bound.actor_wallet else null end,
    bound.payload_hash, bound.nonce, p_tx_sig, p_signature, true,
    coalesce(p_occurred_at, statement_timestamp()), statement_timestamp()
  );
  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(), consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound.nonce and nonce.consumed_at is null;
  if not found then raise exception 'Governance nonce consumed concurrently' using errcode = '40001'; end if;

  if action_name = 'resolution_review' then
    if prior_resolution_review.id is not null then
      update public.resolution_reviews as review
         set is_active = false, superseded_by = review_id, updated_at = statement_timestamp()
       where review.id = prior_resolution_review.id and review.is_active = true;
      if not found then raise exception 'Resolution review changed concurrently' using errcode = '40001'; end if;
    end if;
    insert into public.resolution_reviews (
      id, resolution_id, candidate_report_version_id, reviewer_wallet,
      decision, weight, reason_code, is_active, event_receipt_id,
      phase, case_id, public_ref, reviewer_profile_wallet, tier_snapshot,
      public_rationale, private_note, created_at, updated_at
    ) values (
      review_id, resolution_row.id, version_row.id, bound.actor_wallet,
      p_payload->>'decision', profile.weight_cached, p_payload->>'reason_code',
      true, new_receipt_id, p_payload->>'phase', case_row.id,
      binding->>'review_public_ref', profile.wallet, profile.tier_code,
      p_payload->>'public_rationale', p_payload->>'private_note',
      statement_timestamp(), statement_timestamp()
    );

  elsif action_name = 'resolution_finalize' then
    update public.case_resolutions as resolution
       set state = 'proposed', winning_report_version_id = resolution_quorum.leader_version_id,
           proposed_by_wallet = bound.actor_wallet, finalized_by = 'quorum_maintainer',
           challenge_window_opens_at = p_occurred_at,
           challenge_window_ends_at = p_occurred_at + pg_catalog.make_interval(days => window_days),
           selection_quorum_hash = resolution_quorum.quorum_hash,
           final_receipt_id = new_receipt_id, updated_at = statement_timestamp()
     where resolution.id = resolution_row.id and resolution.state = 'selection_open';
    if not found then raise exception 'Resolution changed concurrently' using errcode = '40001'; end if;
    update public.cases as case_item set stage = 'resolution_proposed', updated_at = statement_timestamp()
     where case_item.id = case_row.id and case_item.stage = 'ready_for_finalization';
    if not found then raise exception 'Case resolution stage changed concurrently' using errcode = '40001'; end if;
    update public.case_resolutions as resolution
       set state = 'in_challenge_window', updated_at = statement_timestamp()
     where resolution.id = resolution_row.id and resolution.state = 'proposed';
    update public.cases as case_item set stage = 'in_challenge_window', updated_at = statement_timestamp()
     where case_item.id = case_row.id and case_item.stage = 'resolution_proposed';
    result_state := 'in_challenge_window';

  elsif action_name = 'challenge_submit' then
    admissibility_ttl_seconds := osi_private.osi_v2_config_integer(
      'OSI_V2_CHALLENGE_ADMISSIBILITY_TTL_SECONDS', 300, 604800
    );
    insert into public.challenges_v2 (
      id, challenger_wallet, reason_code, resolution_id, target_kind,
      evidence_item_id, state, admissibility_ttl_at, cooldown_key,
      submitted_receipt_id, public_ref, public_safe_summary,
      restricted_detail, evidence_hash, created_at, updated_at
    ) values (
      (binding->>'challenge_id')::uuid, bound.actor_wallet, p_payload->>'reason_code',
      resolution_row.id, 'resolution', evidence_row.id, 'submitted',
      bound.issued_at + pg_catalog.make_interval(secs => admissibility_ttl_seconds),
      'resolution:' || resolution_row.id::text || ':wallet:' || bound.actor_wallet,
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
    if prior_challenge_review.id is not null then
      update public.challenge_reviews as review
         set is_active = false, superseded_by = review_id, updated_at = statement_timestamp()
       where review.id = prior_challenge_review.id and review.is_active = true;
      if not found then raise exception 'Challenge review changed concurrently' using errcode = '40001'; end if;
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
    if not found then raise exception 'Challenge withdrawal changed concurrently' using errcode = '40001'; end if;
    result_state := 'withdrawn';

  elsif action_name = 'challenge_finalize' then
    update public.challenges_v2 as challenge
       set state = case when challenge_quorum.outcome = 'accept' then 'accepted' else 'rejected' end,
           resolved_receipt_id = new_receipt_id,
           outcome_quorum_hash = challenge_quorum.quorum_hash,
           terminal_at = p_occurred_at, updated_at = statement_timestamp()
     where challenge.id = challenge_row.id and challenge.state = 'under_review';
    if not found then raise exception 'Challenge outcome changed concurrently' using errcode = '40001'; end if;
    result_state := case when challenge_quorum.outcome = 'accept' then 'accepted' else 'rejected' end;
    if challenge_quorum.outcome = 'accept' then
      update public.case_resolutions as resolution
         set state = 'reopened', reopened_at = p_occurred_at, updated_at = statement_timestamp()
       where resolution.id = resolution_row.id and resolution.state = 'in_challenge_window';
      if not found then raise exception 'Accepted challenge resolution changed concurrently' using errcode = '40001'; end if;
      update public.cases as case_item set stage = 'reopened', updated_at = statement_timestamp()
       where case_item.id = case_row.id and case_item.stage = 'in_challenge_window';
      if not found then raise exception 'Accepted challenge Case changed concurrently' using errcode = '40001'; end if;
    end if;

  else
    update public.case_resolutions as resolution
       set state = 'sealed', seal_quorum_hash = seal_quorum.quorum_hash,
           seal_receipt_id = new_receipt_id, sealed_at = p_occurred_at,
           updated_at = statement_timestamp()
     where resolution.id = resolution_row.id and resolution.state = 'in_challenge_window';
    if not found then raise exception 'Resolution seal changed concurrently' using errcode = '40001'; end if;
    update public.cases as case_item set stage = 'resolved', updated_at = statement_timestamp()
     where case_item.id = case_row.id and case_item.stage = 'in_challenge_window';
    if not found then raise exception 'Case seal stage changed concurrently' using errcode = '40001'; end if;
    update public.cases as case_item
       set stage = 'sealed', sealed_at = p_occurred_at, updated_at = statement_timestamp()
     where case_item.id = case_row.id and case_item.stage = 'resolved';
    if not found then raise exception 'Case seal finalization changed concurrently' using errcode = '40001'; end if;
    result_state := 'sealed';
  end if;

  return query select action_name, bound.purpose, context->>'target_public_ref',
    result_case_ref, result_resolution_ref, result_challenge_ref,
    result_state, new_receipt_id, false;
end;
$$;

create function osi_private.osi_v2_expire_due_challenges(p_limit integer default 100)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare challenge_row public.challenges_v2%rowtype; receipt_id uuid; exact_hash text; expired_count integer := 0;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Challenge expiry is service-only' using errcode = '42501';
  end if;
  if p_limit not between 1 and 500 then
    raise exception 'Challenge expiry batch is invalid' using errcode = '22023';
  end if;
  for challenge_row in
    select challenge.* from public.challenges_v2 as challenge
     where (
       challenge.state in ('submitted', 'admissibility_review')
       and challenge.admissibility_ttl_at <= statement_timestamp()
     ) or (
       challenge.state in ('open', 'under_review')
       and challenge.review_deadline_at <= statement_timestamp()
     )
     order by coalesce(challenge.review_deadline_at, challenge.admissibility_ttl_at), challenge.id
     for update skip locked limit p_limit
  loop
    receipt_id := gen_random_uuid();
    exact_hash := encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
      'challenge_id', challenge_row.id,
      'event_type', 'CHALLENGE_EXPIRED',
      'expired_reason', case when challenge_row.state in ('submitted', 'admissibility_review')
        then 'admissibility_timeout' else 'review_timeout' end,
      'server_time', statement_timestamp()
    )::text, 'UTF8'), 'sha256'), 'hex');
    insert into public.event_receipts (
      id, event_version, event_type, target_type, target_id, public_ref,
      actor_role, decision, reason_code, proof_type, payload_hash,
      server_verified, occurred_at, created_at
    ) values (
      receipt_id, 'OSI2', 'CHALLENGE_EXPIRED', 'challenge', challenge_row.id::text,
      challenge_row.public_ref, 'service', 'expire',
      case when challenge_row.state in ('submitted', 'admissibility_review')
        then 'admissibility_timeout' else 'review_timeout' end,
      'system_event', exact_hash, true, statement_timestamp(), statement_timestamp()
    );
    update public.challenges_v2 as challenge
       set state = 'expired',
           expired_reason = case when challenge_row.state in ('submitted', 'admissibility_review')
             then 'admissibility_timeout' else 'review_timeout' end,
           resolved_receipt_id = receipt_id, terminal_at = statement_timestamp(),
           updated_at = statement_timestamp()
     where challenge.id = challenge_row.id and challenge.state = challenge_row.state;
    if found then expired_count := expired_count + 1; end if;
  end loop;
  return expired_count;
end;
$$;

create or replace function public.osi_v2_guard_resolution()
returns trigger
language plpgsql set search_path = ''
as $$
declare transition_ok boolean;
begin
  if new.id is distinct from old.id or new.case_id is distinct from old.case_id
     or new.event_receipt_id is distinct from old.event_receipt_id
     or new.public_ref is distinct from old.public_ref
     or new.created_at is distinct from old.created_at then
    raise exception 'Resolution identity, Case, reference and creation receipt are immutable'
      using errcode = '55000';
  end if;
  if old.winning_report_version_id is not null
     and new.winning_report_version_id is distinct from old.winning_report_version_id then
    raise exception 'Resolution winner is permanently bound to its exact version' using errcode = '55000';
  end if;
  if old.proposed_by_wallet is not null and new.proposed_by_wallet is distinct from old.proposed_by_wallet then
    raise exception 'Resolution proposer is write-once' using errcode = '55000';
  end if;
  if old.finalized_by is not null and new.finalized_by is distinct from old.finalized_by then
    raise exception 'Resolution finalization mode is write-once' using errcode = '55000';
  end if;
  if old.challenge_window_opens_at is not null
     and new.challenge_window_opens_at is distinct from old.challenge_window_opens_at then
    raise exception 'Challenge window opening is write-once' using errcode = '55000';
  end if;
  if old.challenge_window_ends_at is not null
     and new.challenge_window_ends_at is distinct from old.challenge_window_ends_at then
    raise exception 'Challenge window closing is write-once' using errcode = '55000';
  end if;
  if old.selection_quorum_hash is not null
     and new.selection_quorum_hash is distinct from old.selection_quorum_hash then
    raise exception 'Resolution selection quorum is write-once' using errcode = '55000';
  end if;
  if old.final_receipt_id is not null and new.final_receipt_id is distinct from old.final_receipt_id then
    raise exception 'Resolution final receipt is write-once' using errcode = '55000';
  end if;
  if old.seal_quorum_hash is not null and new.seal_quorum_hash is distinct from old.seal_quorum_hash then
    raise exception 'Resolution seal quorum is write-once' using errcode = '55000';
  end if;
  if old.seal_receipt_id is not null and new.seal_receipt_id is distinct from old.seal_receipt_id then
    raise exception 'Resolution seal receipt is write-once' using errcode = '55000';
  end if;
  if old.reopened_at is not null and new.reopened_at is distinct from old.reopened_at then
    raise exception 'Resolution reopened_at is write-once' using errcode = '55000';
  end if;
  if old.sealed_at is not null and new.sealed_at is distinct from old.sealed_at then
    raise exception 'Resolution sealed_at is write-once' using errcode = '55000';
  end if;
  transition_ok := new.state = old.state
    or (old.state = 'selection_open' and new.state = 'proposed')
    or (old.state = 'proposed' and new.state in ('in_challenge_window', 'reopened'))
    or (old.state = 'in_challenge_window' and new.state in ('sealed', 'reopened'))
    or (old.state = 'sealed' and new.state = 'reopened');
  if not transition_ok then
    raise exception 'Invalid resolution transition: % -> %', old.state, new.state using errcode = '23514';
  end if;
  if old.state = 'selection_open' and new.state = 'proposed' and (
    new.winning_report_version_id is null or new.proposed_by_wallet is null
    or new.finalized_by is null or new.selection_quorum_hash is null
    or new.final_receipt_id is null or new.challenge_window_opens_at is null
    or new.challenge_window_ends_at is null
  ) then raise exception 'Finalized resolution requires exact winner, quorum, receipt and window'
    using errcode = '23514'; end if;
  if new.state = 'in_challenge_window' and (
    new.challenge_window_ends_at is null
    or new.challenge_window_ends_at <= new.challenge_window_opens_at
    or new.challenge_window_ends_at <= statement_timestamp()
  ) then raise exception 'Challenge window must be an ordered future interval'
    using errcode = '23514'; end if;
  if new.state = 'reopened' and new.reopened_at is null then
    raise exception 'Reopened resolution requires reopened_at' using errcode = '23514';
  end if;
  if new.state = 'sealed' and (
    new.seal_quorum_hash is null or new.seal_receipt_id is null or new.sealed_at is null
  ) then raise exception 'Sealed resolution requires exact quorum, receipt and timestamp'
    using errcode = '23514'; end if;
  return new;
end;
$$;

create or replace function public.osi_v2_guard_challenge()
returns trigger
language plpgsql set search_path = ''
as $$
declare transition_ok boolean; bad_faith_transition_ok boolean; old_core jsonb; new_core jsonb;
begin
  old_core := to_jsonb(old) - array[
    'state', 'admitted_by_wallet', 'review_deadline_at', 'expired_reason',
    'bad_faith_state', 'opened_receipt_id', 'resolved_receipt_id',
    'bad_faith_receipt_id', 'outcome_quorum_hash', 'terminal_at', 'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'state', 'admitted_by_wallet', 'review_deadline_at', 'expired_reason',
    'bad_faith_state', 'opened_receipt_id', 'resolved_receipt_id',
    'bad_faith_receipt_id', 'outcome_quorum_hash', 'terminal_at', 'updated_at'
  ];
  if new_core is distinct from old_core then
    raise exception 'Challenge actor, target, evidence and public/restricted content are immutable'
      using errcode = '55000';
  end if;
  transition_ok := new.state = old.state
    or (old.state = 'submitted' and new.state in ('admissibility_review', 'withdrawn', 'expired'))
    or (old.state = 'admissibility_review' and new.state in ('open', 'rejected', 'withdrawn', 'expired'))
    or (old.state = 'open' and new.state in ('under_review', 'withdrawn', 'expired'))
    or (old.state = 'under_review' and new.state in ('accepted', 'rejected', 'withdrawn', 'expired'));
  if not transition_ok then
    raise exception 'Invalid challenge transition: % -> %', old.state, new.state using errcode = '23514';
  end if;
  if old.admitted_by_wallet is not null and new.admitted_by_wallet is distinct from old.admitted_by_wallet then
    raise exception 'Challenge admissibility actor is write-once' using errcode = '55000'; end if;
  if old.opened_receipt_id is not null and new.opened_receipt_id is distinct from old.opened_receipt_id then
    raise exception 'Challenge opening receipt is write-once' using errcode = '55000'; end if;
  if old.resolved_receipt_id is not null and new.resolved_receipt_id is distinct from old.resolved_receipt_id then
    raise exception 'Challenge terminal receipt is write-once' using errcode = '55000'; end if;
  if old.outcome_quorum_hash is not null and new.outcome_quorum_hash is distinct from old.outcome_quorum_hash then
    raise exception 'Challenge outcome quorum is write-once' using errcode = '55000'; end if;
  if old.terminal_at is not null and new.terminal_at is distinct from old.terminal_at then
    raise exception 'Challenge terminal_at is write-once' using errcode = '55000'; end if;
  if new.state in ('accepted', 'rejected', 'withdrawn', 'expired')
     and (new.resolved_receipt_id is null or new.terminal_at is null) then
    raise exception 'Terminal challenge requires exact receipt and timestamp' using errcode = '23514';
  end if;
  if new.state in ('accepted', 'rejected') and old.state = 'under_review'
     and new.outcome_quorum_hash is null then
    raise exception 'Adjudicated challenge requires exact quorum hash' using errcode = '23514';
  end if;
  bad_faith_transition_ok := new.bad_faith_state = old.bad_faith_state
    or (old.bad_faith_state = 'none' and new.bad_faith_state = 'under_review'
      and new.state in ('rejected', 'withdrawn', 'expired'))
    or (old.bad_faith_state = 'under_review'
      and new.bad_faith_state in ('confirmed', 'dismissed')
      and new.state in ('rejected', 'withdrawn', 'expired')
      and new.bad_faith_receipt_id is not null);
  if not bad_faith_transition_ok then
    raise exception 'Invalid challenge bad-faith transition: % -> %', old.bad_faith_state, new.bad_faith_state
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.osi_v2_enforce_review_target_state()
returns trigger
language plpgsql set search_path = ''
as $$
declare target_state text; bad_faith_state_value text; window_end timestamptz;
begin
  if tg_table_name = 'case_initial_reviews' then
    select case_item.stage into target_state from public.cases as case_item where case_item.id = new.case_id;
    if target_state <> 'initial_review' then raise exception 'Case initial review requires initial_review stage' using errcode = '23514'; end if;
  elsif tg_table_name = 'case_report_reviews' then
    select version.lifecycle_state into target_state from public.case_report_versions as version where version.id = new.report_version_id;
    if target_state <> 'in_review' then raise exception 'Case Report review requires in_review version' using errcode = '23514'; end if;
  elsif tg_table_name = 'wire_report_reviews' then
    select version.lifecycle_state into target_state from public.wire_report_versions as version where version.id = new.wire_report_version_id;
    if target_state <> 'in_review' then raise exception 'Wire Report review requires in_review version' using errcode = '23514'; end if;
  elsif tg_table_name = 'resolution_reviews' then
    select resolution.state, resolution.challenge_window_ends_at
      into target_state, window_end from public.case_resolutions as resolution where resolution.id = new.resolution_id;
    if new.phase = 'selection' and target_state <> 'selection_open' then
      raise exception 'Resolution selection review requires selection_open state' using errcode = '23514';
    end if;
    if new.phase = 'seal' and (
      target_state <> 'in_challenge_window' or window_end > statement_timestamp()
      or exists (select 1 from public.challenges_v2 as challenge
        where challenge.resolution_id = new.resolution_id and challenge.state in ('open', 'under_review'))
    ) then raise exception 'Seal review requires a clear ended challenge window' using errcode = '23514'; end if;
  elsif tg_table_name = 'challenge_reviews' then
    select challenge.state, challenge.bad_faith_state into target_state, bad_faith_state_value
      from public.challenges_v2 as challenge where challenge.id = new.challenge_id;
    if new.phase = 'merit' and target_state not in ('open', 'under_review') then
      raise exception 'Challenge merit review requires open/under_review state' using errcode = '23514'; end if;
    if new.phase = 'bad_faith' and (
      target_state not in ('rejected', 'withdrawn', 'expired') or bad_faith_state_value <> 'under_review'
    ) then raise exception 'Bad-faith review requires its separate opened phase' using errcode = '23514'; end if;
  elsif tg_table_name = 'ai_pack_reviews' then
    select version.lifecycle_state into target_state from public.ai_pack_versions as version where version.id = new.pack_version_id;
    if target_state not in ('review_required', 'supported', 'disputed') then raise exception 'AI Pack review requires an active review state' using errcode = '23514'; end if;
  elsif tg_table_name = 'analyst_application_reviews' then
    select application.status into target_state from public.analyst_application_versions as version
    join public.analyst_applications as application on application.id = version.application_id
    where version.id = new.application_version_id;
    if target_state <> 'in_review' then raise exception 'Application review requires in_review state' using errcode = '23514'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.osi_v2_bind_review_receipt()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  target_column text := tg_argv[0]; expected_target_type text := tg_argv[1];
  cast_event text := tg_argv[2]; revised_event text := tg_argv[3];
  target_value uuid; has_history boolean; receipt record; sql_text text;
begin
  target_value := (to_jsonb(new)->>target_column)::uuid;
  select event.event_version, event.event_type, event.target_type, event.target_id,
    event.actor_wallet, event.actor_role, event.decision, event.weight, event.reason_code
    into receipt from public.event_receipts as event where event.id = new.event_receipt_id;
  if receipt.event_version is distinct from 'OSI2' then return new; end if;
  sql_text := format(
    'select exists (select 1 from public.%I as prior where prior.%I = $1
      and prior.reviewer_wallet = $2 and prior.id <> $3', tg_table_name, target_column
  );
  if tg_table_name in ('challenge_reviews', 'resolution_reviews') then
    sql_text := sql_text || ' and prior.phase = $4)';
    execute sql_text into has_history using target_value, new.reviewer_wallet, new.id, new.phase;
  else
    sql_text := sql_text || ')';
    execute sql_text into has_history using target_value, new.reviewer_wallet, new.id;
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
  if tg_table_name = 'case_initial_reviews'
     and to_jsonb(new)->>'reviewer_role' = 'maintainer'
     and receipt.actor_role is distinct from 'maintainer' then
    raise exception 'Maintainer initial review requires maintainer receipt role' using errcode = '42501';
  end if;
  if not (tg_table_name = 'case_initial_reviews' and to_jsonb(new)->>'reviewer_role' = 'maintainer')
     and receipt.actor_role not in ('analyst', 'senior') then
    raise exception 'Counted review receipt requires analyst/senior role' using errcode = '42501';
  end if;
  if has_history and receipt.event_type is distinct from revised_event then
    raise exception 'Revised review requires % receipt', revised_event using errcode = '23514';
  end if;
  if not has_history and receipt.event_type is distinct from cast_event then
    raise exception 'First review requires % receipt', cast_event using errcode = '23514';
  end if;
  return new;
end;
$$;

create function public.osi_v2_prepare_governance_action(
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
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_prepare_governance_action(
    p_nonce, p_action, p_actor_wallet, p_target_ref, p_payload,
    p_idempotency_key, p_request_fingerprint_hash, p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_commit_governance_action(
  p_nonce text, p_payload jsonb, p_proof_text text,
  p_signature text default null, p_tx_sig text default null,
  p_occurred_at timestamptz default null,
  p_maintainer_auth_uuid text default null
)
returns table (
  action text, purpose text, target_public_ref text,
  case_public_ref text, resolution_public_ref text,
  challenge_public_ref text, state text, receipt_id uuid,
  idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_governance_action(
    p_nonce, p_payload, p_proof_text, p_signature, p_tx_sig,
    p_occurred_at, p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_expire_due_challenges(p_limit integer default 100)
returns integer
language sql security invoker set search_path = ''
as $$ select osi_private.osi_v2_expire_due_challenges(p_limit) $$;

revoke all privileges on function osi_private.osi_v2_governance_writes_enabled() from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_config_integer(text, integer, integer) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_governance_payload_hash(text, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_make_public_ref(text, uuid) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_eligible_analyst(text) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_full_maintainer_binding(text, text) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_ensure_resolution(uuid) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_resolution_quorum(uuid) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_seal_quorum(uuid) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_challenge_quorum(uuid) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_check_challenge_rate(text, text, timestamptz) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_governance_action(text, text, text, text, jsonb, text, text, text) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_governance_action(text, jsonb, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_expire_due_challenges(integer) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_prepare_governance_action(text, text, text, text, jsonb, text, text, text) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_governance_action(text, jsonb, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_expire_due_challenges(integer) from public, anon, authenticated;

grant execute on function osi_private.osi_v2_prepare_governance_action(text, text, text, text, jsonb, text, text, text) to service_role;
grant execute on function osi_private.osi_v2_commit_governance_action(text, jsonb, text, text, text, timestamptz, text) to service_role;
grant execute on function osi_private.osi_v2_expire_due_challenges(integer) to service_role;
grant execute on function public.osi_v2_prepare_governance_action(text, text, text, text, jsonb, text, text, text) to service_role;
grant execute on function public.osi_v2_commit_governance_action(text, jsonb, text, text, text, timestamptz, text) to service_role;
grant execute on function public.osi_v2_expire_due_challenges(integer) to service_role;

comment on function public.osi_v2_expire_due_challenges(integer) is
  'Server-only DB-clock expiry. Edge reads/writes invoke it opportunistically; clients cannot choose timestamps or states.';

commit;
