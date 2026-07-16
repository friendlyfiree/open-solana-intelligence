-- OSI V2 bootstrap maintainer quorum (D17) and Path B analyst candidacy (D18).
--
-- D17: a fail-closed, explicitly enabled, self-decaying cold-start channel
-- lets the full double-gated maintainer (configured admin wallet AND
-- authenticated Supabase maintainer identity) finalize exactly three
-- outcomes while the live eligible-analyst count is low: Report publication,
-- resolution/winning-Report selection, and seal. The live tier is computed
-- from the eligible-analyst count inside the deciding transaction:
--   < 20  full maintainer alone
--   20-29 full maintainer + 1 independent analyst
--   30-49 full maintainer + 2 independent analysts, reduced total weight
--   >= 50 bootstrap retired; the original D5 thresholds apply unchanged
-- Every receipt produced through this channel carries the distinct
-- decision_channel 'maintainer_bootstrap' and is never presented as an
-- independent multi-analyst quorum outcome. AI Pack approval and challenge
-- accept/reject are untouched and remain analyst-quorum-only; a database
-- constraint below makes the bootstrap channel unrepresentable for them.
-- With OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED at its default 'false'
-- (or absent/malformed) every governed path behaves exactly as before this
-- migration.
--
-- D18: when a resolution finalize sets winning_report_version_id, the
-- winning version's author wallet is promoted from 'contributor' to
-- 'analyst_candidate' (candidacy only: weight stays 0 and activation still
-- requires the existing reviewed application path). The promotion is a
-- private status side effect of the already-anchored finalize event and
-- creates no receipt, Memo, or Proof Log entry.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED', 'false', statement_timestamp()),
  ('OSI_V2_BOOTSTRAP_TIER3_MIN_WEIGHT', '1.00', statement_timestamp())
on conflict (key) do nothing;

-- Honest provenance: every receipt records the decision channel that
-- produced it. 'standard' is the unchanged normal channel; only the three
-- D17 outcomes may ever carry 'maintainer_bootstrap', and only as an OSI2
-- maintainer action. This makes a bootstrap receipt structurally impossible
-- to confuse with (or fabricate for) an analyst-quorum outcome such as a
-- challenge accept/reject or an AI Pack approval.
alter table public.event_receipts
  add column decision_channel text not null default 'standard'
    constraint event_receipts_decision_channel_check
    check (decision_channel in ('standard', 'maintainer_bootstrap'));

alter table public.event_receipts
  add constraint event_receipts_bootstrap_channel_scope_check
  check (
    decision_channel = 'standard'
    or (
      event_version = 'OSI2'
      and actor_role = 'maintainer'
      and event_type in ('REPORT_PUBLISHED', 'REPORT_SELECTED_WINNING', 'RECORD_SEALED')
    )
  );

comment on column public.event_receipts.decision_channel is
  'Decision channel that produced this receipt. maintainer_bootstrap marks the D17 cold-start maintainer channel and must never be rendered as an independent multi-analyst quorum outcome.';

-- A bootstrap-selected winner is honestly labeled on the resolution row too.
alter table public.case_resolutions
  drop constraint case_resolutions_finalized_by_check;
alter table public.case_resolutions
  add constraint case_resolutions_finalized_by_check
  check (finalized_by is null or finalized_by in ('quorum_maintainer', 'fallback', 'maintainer_bootstrap'));

-- Live bootstrap tier. Computed fresh inside every calling statement so the
-- tier can never go stale mid-transaction; nothing is cached. Fails closed:
-- a missing or malformed flag disables the channel, and a malformed reduced
-- weight aborts instead of guessing.
create function osi_private.osi_v2_bootstrap_tier()
returns table (
  enabled boolean,
  active boolean,
  eligible_analyst_count integer,
  tier text,
  required_analyst_count integer,
  required_analyst_weight numeric
)
language plpgsql stable security invoker set search_path = ''
as $$
declare live_count integer; reduced_weight numeric;
begin
  enabled := coalesce((
    select config.value = 'true' from public.osi_config as config
     where config.key = 'OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED'
  ), false);
  if not enabled then
    active := false; eligible_analyst_count := null; tier := 'disabled';
    required_analyst_count := null; required_analyst_weight := null;
    return next; return;
  end if;
  select config.value::numeric into reduced_weight from public.osi_config as config
   where config.key = 'OSI_V2_BOOTSTRAP_TIER3_MIN_WEIGHT'
     and config.value ~ '^[0-9]+(\.[0-9]+)?$';
  if reduced_weight is null or reduced_weight not between 0.50 and 30 then
    raise exception 'Bootstrap reduced weight configuration is invalid' using errcode = '55000';
  end if;
  select count(*)::integer into live_count from public.analyst_profiles as profile
   where profile.status in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     and profile.approved is true;
  eligible_analyst_count := live_count;
  if live_count < 20 then
    active := true; tier := 'maintainer_only';
    required_analyst_count := 0; required_analyst_weight := 0;
  elsif live_count < 30 then
    active := true; tier := 'maintainer_plus_one';
    required_analyst_count := 1; required_analyst_weight := 0.50;
  elsif live_count < 50 then
    active := true; tier := 'maintainer_plus_two';
    required_analyst_count := 2; required_analyst_weight := reduced_weight;
  else
    active := false; tier := 'retired';
    required_analyst_count := null; required_analyst_weight := null;
  end if;
  return next;
end;
$$;

comment on function osi_private.osi_v2_bootstrap_tier() is
  'D17 live cold-start tier from count(analyst_profiles where status in (probationary_analyst, verified_analyst, senior_analyst) and approved). Self-decaying: active is false at 50+ eligible analysts or whenever the fail-closed flag is not exactly true.';

-- Independent analyst support for one exact named candidate version in the
-- bootstrap selection channel. Reviews cast by the acting maintainer wallet
-- never count, and any active review by that wallet marks it conflicted so
-- one person can never appear on both sides of a decision.
create function osi_private.osi_v2_bootstrap_selection_support(
  p_resolution_id uuid,
  p_version_id uuid,
  p_maintainer_wallet text
)
returns table (
  support_count integer,
  support_weight numeric,
  maintainer_conflicted boolean,
  support_hash text
)
language plpgsql stable security invoker set search_path = ''
as $$
declare snapshot jsonb;
begin
  select count(*)::integer, coalesce(sum(review.weight), 0)::numeric,
    coalesce(jsonb_agg(jsonb_build_object(
      'created_at', review.created_at, 'decision', review.decision,
      'review_public_ref', review.public_ref, 'reviewer_wallet', review.reviewer_wallet,
      'tier', review.tier_snapshot, 'weight', review.weight
    ) order by review.reviewer_wallet), '[]'::jsonb)
    into support_count, support_weight, snapshot
    from public.resolution_reviews as review
   where review.resolution_id = p_resolution_id
     and review.phase = 'selection' and review.is_active = true
     and review.decision = 'select'
     and review.candidate_report_version_id = p_version_id
     and review.reviewer_wallet <> p_maintainer_wallet;
  maintainer_conflicted := exists (
    select 1 from public.resolution_reviews as review
     where review.resolution_id = p_resolution_id
       and review.reviewer_wallet = p_maintainer_wallet
       and review.is_active = true
  );
  support_hash := encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'channel', 'maintainer_bootstrap',
    'report_version_id', p_version_id,
    'resolution_id', p_resolution_id,
    'reviews', snapshot
  )::text, 'UTF8'), 'sha256'), 'hex');
  return next;
end;
$$;

create or replace function osi_private.osi_v2_prepare_governance_action(
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
  bootstrap record;
  bootstrap_support record;
  decision_channel_value text := 'standard';
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
    if resolution_row.id is null and p_payload ? 'report_version_ref' then
      -- D17 cold start: with no eligible analysts, no selection review could
      -- have created the resolution parent. Create it through the existing
      -- service-only path, but only when the bootstrap channel is enabled and
      -- live; with the flag off this request changes nothing and fails
      -- exactly like today.
      select * into bootstrap from osi_private.osi_v2_bootstrap_tier();
      if bootstrap.active is not distinct from true then
        select case_item.* into case_row from public.cases as case_item
         where case_item.public_ref = p_target_ref for update;
        if case_row.id is not null then
          resolution_row := osi_private.osi_v2_ensure_resolution(case_row.id);
        end if;
      end if;
    end if;
    select case_item.* into case_row from public.cases as case_item where case_item.id = resolution_row.case_id;
    select * into resolution_quorum from osi_private.osi_v2_resolution_quorum(resolution_row.id);
    if resolution_row.state = 'selection_open'
       and resolution_quorum.ready_candidate_count = 0
       and p_payload ? 'report_version_ref' then
      -- Explicit D17 bootstrap-channel request: no candidate reached the
      -- original D5 quorum and the full maintainer names one exact published
      -- version. The fail-closed flag and the live tier decide admissibility;
      -- everything below is denied unless every gate passes.
      select * into bootstrap from osi_private.osi_v2_bootstrap_tier();
      if bootstrap.active is distinct from true then
        raise exception 'Resolution has no unique server-derived quorum leader' using errcode = '42501';
      end if;
      select version.* into version_row from public.case_report_versions as version
       where version.version_ref = p_payload->>'report_version_ref';
      select report.* into report_row from public.case_reports as report
       where report.id = version_row.report_id;
      if version_row.id is null or version_row.lifecycle_state <> 'published'
         or report_row.case_id is distinct from case_row.id
         or report_row.current_published_version_id is distinct from version_row.id then
        raise exception 'Bootstrap selection requires an exact currently published Case Report version'
          using errcode = '42501';
      end if;
      if p_actor_wallet in (case_row.submitted_by_wallet, report_row.author_wallet) then
        raise exception 'Bootstrap maintainer cannot decide their own Case or Report'
          using errcode = '42501';
      end if;
      select * into bootstrap_support from osi_private.osi_v2_bootstrap_selection_support(
        resolution_row.id, version_row.id, p_actor_wallet
      );
      if bootstrap_support.maintainer_conflicted is distinct from false
         or bootstrap_support.support_count < bootstrap.required_analyst_count
         or bootstrap_support.support_weight < bootstrap.required_analyst_weight then
        raise exception 'Bootstrap selection support requirements are not met'
          using errcode = '42501';
      end if;
      decision_channel_value := 'maintainer_bootstrap';
      window_days := osi_private.osi_v2_config_integer('OSI_V2_CHALLENGE_WINDOW_DAYS', 1, 30);
      action_purpose := 'REPORT_SELECTED_WINNING'; action_target_type := 'resolution';
      action_target_id := resolution_row.id::text; action_target_ref := resolution_row.public_ref;
      receipt_role := 'maintainer'; snapshot_weight := null;
      server_binding := jsonb_build_object(
        'bootstrap_eligible_count', bootstrap.eligible_analyst_count,
        'bootstrap_required_count', bootstrap.required_analyst_count,
        'bootstrap_required_weight', bootstrap.required_analyst_weight,
        'bootstrap_tier', bootstrap.tier,
        'case_id', case_row.id, 'case_public_ref', case_row.public_ref,
        'challenge_window_days', window_days,
        'decision_channel', 'maintainer_bootstrap',
        'leader_count', bootstrap_support.support_count,
        'leader_weight', bootstrap_support.support_weight,
        'quorum_hash', bootstrap_support.support_hash,
        'report_version_id', version_row.id, 'report_version_ref', version_row.version_ref,
        'resolution_id', resolution_row.id, 'resolution_public_ref', resolution_row.public_ref
      );
    else
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
    end if;

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
    -- The ended challenge window, the blocking-challenge pause and the state
    -- gate are never relaxed by any channel.
    if resolution_row.state <> 'in_challenge_window'
       or resolution_row.challenge_window_ends_at > issued_time
       or exists (
         select 1 from public.challenges_v2 as challenge
          where challenge.resolution_id = resolution_row.id
            and challenge.state in ('open', 'under_review')
       ) then
      raise exception 'Case is not seal-ready' using errcode = '42501';
    end if;
    if seal_quorum.ready is distinct from true then
      -- Normal D5 seal quorum is unavailable. Only the explicit D17 bootstrap
      -- channel may continue, and only the analyst count/weight gate relaxes.
      select * into bootstrap from osi_private.osi_v2_bootstrap_tier();
      if bootstrap.active is distinct from true then
        raise exception 'Case is not seal-ready' using errcode = '42501';
      end if;
      select version.* into version_row from public.case_report_versions as version
       where version.id = resolution_row.winning_report_version_id;
      select report.* into report_row from public.case_reports as report
       where report.id = version_row.report_id;
      if p_actor_wallet in (case_row.submitted_by_wallet, report_row.author_wallet) then
        raise exception 'Bootstrap maintainer cannot decide their own Case or Report'
          using errcode = '42501';
      end if;
      if exists (
           select 1 from public.resolution_reviews as review
            where review.resolution_id = resolution_row.id
              and review.reviewer_wallet = p_actor_wallet
              and review.is_active = true
         )
         or seal_quorum.approve_count < bootstrap.required_analyst_count
         or seal_quorum.approve_weight < bootstrap.required_analyst_weight then
        raise exception 'Bootstrap seal support requirements are not met'
          using errcode = '42501';
      end if;
      decision_channel_value := 'maintainer_bootstrap';
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
    if decision_channel_value = 'maintainer_bootstrap' then
      server_binding := server_binding || jsonb_build_object(
        'bootstrap_eligible_count', bootstrap.eligible_analyst_count,
        'bootstrap_required_count', bootstrap.required_analyst_count,
        'bootstrap_required_weight', bootstrap.required_analyst_weight,
        'bootstrap_tier', bootstrap.tier,
        'decision_channel', 'maintainer_bootstrap'
      );
    end if;
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

create or replace function osi_private.osi_v2_commit_governance_action(
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
  bootstrap record;
  bootstrap_support record;
  receipt_channel text;
  winning_version_id uuid;
  selection_hash text;
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
  receipt_channel := coalesce(binding->>'decision_channel', 'standard');
  if receipt_channel <> 'standard'
     and action_name not in ('resolution_finalize', 'seal_finalize') then
    raise exception 'Bootstrap channel binding is not valid for this action'
      using errcode = '23514';
  end if;
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
    if receipt_channel = 'maintainer_bootstrap' then
      -- Recompute the live tier and the exact independent support inside this
      -- commit transaction; any drift since prepare fails closed.
      select * into bootstrap from osi_private.osi_v2_bootstrap_tier();
      select version.* into version_row from public.case_report_versions as version
       where version.id = (binding->>'report_version_id')::uuid;
      select report.* into report_row from public.case_reports as report
       where report.id = version_row.report_id;
      select * into bootstrap_support from osi_private.osi_v2_bootstrap_selection_support(
        resolution_row.id, version_row.id, bound.actor_wallet
      );
      if resolution_row.state <> 'selection_open'
         or bootstrap.active is distinct from true
         or bootstrap.tier is distinct from binding->>'bootstrap_tier'
         or resolution_quorum.ready_candidate_count <> 0
         or version_row.id is null or version_row.lifecycle_state <> 'published'
         or report_row.case_id is distinct from case_row.id
         or report_row.current_published_version_id is distinct from version_row.id
         or bound.actor_wallet in (case_row.submitted_by_wallet, report_row.author_wallet)
         or bootstrap_support.maintainer_conflicted is distinct from false
         or bootstrap_support.support_hash is distinct from binding->>'quorum_hash'
         or bootstrap_support.support_count < bootstrap.required_analyst_count
         or bootstrap_support.support_weight < bootstrap.required_analyst_weight then
        raise exception 'Bootstrap selection binding changed after prepare' using errcode = '40001';
      end if;
      winning_version_id := version_row.id;
      selection_hash := bootstrap_support.support_hash;
    else
      if resolution_row.state <> 'selection_open'
         or resolution_quorum.leader_version_id::text is distinct from binding->>'report_version_id'
         or resolution_quorum.quorum_hash is distinct from binding->>'quorum_hash'
         or resolution_quorum.tie_unresolved is true then
        raise exception 'Resolution quorum changed after prepare' using errcode = '40001';
      end if;
      winning_version_id := resolution_quorum.leader_version_id;
      selection_hash := resolution_quorum.quorum_hash;
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
         or bound.purpose is distinct from (case when challenge_quorum.outcome = 'accept'
           then 'CHALLENGE_ACCEPTED' else 'CHALLENGE_REJECTED' end)
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
       or seal_quorum.quorum_hash is distinct from binding->>'quorum_hash'
       or exists (
         select 1 from public.challenges_v2 as challenge
          where challenge.resolution_id = resolution_row.id
            and challenge.state in ('open', 'under_review')
       ) then
      raise exception 'Seal quorum or clear-window binding changed after prepare'
        using errcode = '40001';
    end if;
    if receipt_channel = 'maintainer_bootstrap' then
      select * into bootstrap from osi_private.osi_v2_bootstrap_tier();
      select version.* into version_row from public.case_report_versions as version
       where version.id = resolution_row.winning_report_version_id;
      select report.* into report_row from public.case_reports as report
       where report.id = version_row.report_id;
      if seal_quorum.ready is not distinct from true
         or bootstrap.active is distinct from true
         or bootstrap.tier is distinct from binding->>'bootstrap_tier'
         or bound.actor_wallet in (case_row.submitted_by_wallet, report_row.author_wallet)
         or exists (
           select 1 from public.resolution_reviews as review
            where review.resolution_id = resolution_row.id
              and review.reviewer_wallet = bound.actor_wallet
              and review.is_active = true
         )
         or seal_quorum.approve_count < bootstrap.required_analyst_count
         or seal_quorum.approve_weight < bootstrap.required_analyst_weight then
        raise exception 'Bootstrap seal binding changed after prepare' using errcode = '40001';
      end if;
    elsif seal_quorum.ready is distinct from true then
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
    server_verified, occurred_at, created_at, decision_channel
  ) values (
    new_receipt_id, 'OSI2', bound.purpose, bound.target_type, bound.target_id,
    case when action_name in ('resolution_review', 'challenge_review')
      then binding->>'review_public_ref' else context->>'target_public_ref' end,
    bound.actor_wallet, receipt_role, decision_value, receipt_weight,
    reason_value, transport, p_proof_text,
    case when transport = 'solana_memo' then bound.actor_wallet else null end,
    bound.payload_hash, bound.nonce, p_tx_sig, p_signature, true,
    coalesce(p_occurred_at, statement_timestamp()), statement_timestamp(),
    receipt_channel
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
       set state = 'proposed', winning_report_version_id = winning_version_id,
           proposed_by_wallet = bound.actor_wallet,
           finalized_by = case when receipt_channel = 'maintainer_bootstrap'
             then 'maintainer_bootstrap' else 'quorum_maintainer' end,
           challenge_window_opens_at = p_occurred_at,
           challenge_window_ends_at = p_occurred_at + pg_catalog.make_interval(days => window_days),
           selection_quorum_hash = selection_hash,
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


-- Report publication gains the optional maintainer identity parameter needed
-- by the D17 double gate. The functions are recreated with one widened
-- signature (never overloaded, so RPC name resolution stays unambiguous);
-- every existing caller that omits the new parameter behaves exactly as
-- before. Privileges are re-applied below because drop discards them.
drop function public.osi_v2_prepare_report_publication(text, text, uuid, text, text);
drop function public.osi_v2_commit_report_publication(text, text, text, timestamptz);
drop function osi_private.osi_v2_prepare_report_publication(text, text, uuid, text, text);
drop function osi_private.osi_v2_commit_report_publication(text, text, text, timestamptz);

create function osi_private.osi_v2_prepare_report_publication(
  p_nonce text,
  p_actor_wallet text,
  p_version_id uuid,
  p_idempotency_key text,
  p_request_fingerprint_hash text,
  p_maintainer_auth_uuid text default null
)
returns table (
  issued_nonce text, case_public_ref text, report_public_ref text,
  version_public_ref text, actor_role text, payload_hash text,
  quorum_hash text, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.osi_nonces%rowtype;
  version_row public.case_report_versions%rowtype;
  report_row public.case_reports%rowtype;
  case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype;
  quorum record;
  receipt_role text;
  exact_hash text;
  issued_time timestamptz := statement_timestamp();
  ttl_seconds integer;
  bootstrap record;
  bootstrap_binding jsonb := '{}'::jsonb;
  decision_channel_value text := 'standard';
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Report publication prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_report_review_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Report review writes are disabled' using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-publish-idempotency:' || p_idempotency_key, 0)
  );
  select version.* into version_row from public.case_report_versions as version
   where version.id = p_version_id for update;
  select report.* into report_row from public.case_reports as report
   where report.id = version_row.report_id for update;
  select case_item.* into case_row from public.cases as case_item
   where case_item.id = report_row.case_id;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = p_actor_wallet;
  if version_row.id is null or not report_row.native_intake
     or report_row.current_version_id is distinct from version_row.id
     or version_row.lifecycle_state not in ('submitted', 'in_review')
     or case_row.visibility <> 'public'
     or case_row.stage not in ('open_public', 'in_review', 'reopened') then
    raise exception 'Report version is not available for publication' using errcode = '42501';
  end if;
  if p_maintainer_auth_uuid is not null then
    -- D17 bootstrap channel: the full double-gated maintainer finalizes the
    -- publication while the live eligible-analyst count is low. Only the
    -- analyst count/weight gate relaxes; lineage, state, no-self-review and
    -- Stage-5 binding stay exactly as strict as the normal path.
    if osi_private.osi_v2_full_maintainer_binding(p_actor_wallet, p_maintainer_auth_uuid) is distinct from true then
      raise exception 'Bootstrap publication requires both maintainer gates'
        using errcode = '42501';
    end if;
    select * into bootstrap from osi_private.osi_v2_bootstrap_tier();
    if bootstrap.active is distinct from true then
      raise exception 'Bootstrap maintainer quorum is not available'
        using errcode = '42501';
    end if;
    if p_actor_wallet in (report_row.author_wallet, case_row.submitted_by_wallet) then
      raise exception 'Bootstrap maintainer cannot decide their own Case or Report'
        using errcode = '42501';
    end if;
    if exists (
      select 1 from public.case_report_reviews as review
       where review.report_version_id = version_row.id
         and review.reviewer_wallet = p_actor_wallet
         and review.is_active = true
    ) then
      raise exception 'Bootstrap maintainer cannot also be a counted reviewer'
        using errcode = '42501';
    end if;
    select * into quorum from osi_private.osi_v2_report_quorum(version_row.id);
    if quorum.approve_ready is not distinct from true then
      raise exception 'Normal analyst publication quorum is available'
        using errcode = '42501';
    end if;
    if quorum.approve_count < bootstrap.required_analyst_count
       or quorum.approve_weight < bootstrap.required_analyst_weight then
      raise exception 'Bootstrap publication support requirements are not met'
        using errcode = '42501';
    end if;
    receipt_role := 'maintainer';
    decision_channel_value := 'maintainer_bootstrap';
    bootstrap_binding := jsonb_build_object(
      'bootstrap_eligible_count', bootstrap.eligible_analyst_count,
      'bootstrap_required_count', bootstrap.required_analyst_count,
      'bootstrap_required_weight', bootstrap.required_analyst_weight,
      'bootstrap_tier', bootstrap.tier,
      'decision_channel', 'maintainer_bootstrap',
      'maintainer_auth_uuid', p_maintainer_auth_uuid
    );
  else
    if p_actor_wallet in (report_row.author_wallet, case_row.submitted_by_wallet)
       or profile.wallet is null
       or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
       or profile.verified is not true or profile.approved is not true
       or not exists (
         select 1 from public.case_report_reviews as review
          where review.report_version_id = version_row.id
            and review.reviewer_wallet = p_actor_wallet
            and review.is_active = true and review.decision = 'approve'
       ) then
      raise exception 'Publication requires an active approving eligible analyst'
        using errcode = '42501';
    end if;
    select * into quorum from osi_private.osi_v2_report_quorum(version_row.id);
    if quorum.approve_ready is distinct from true then
      raise exception 'Report publication quorum is not ready' using errcode = '42501';
    end if;
    receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  end if;
  exact_hash := osi_private.osi_v2_report_publication_payload_hash(
    version_row.id, version_row.version_ref, p_actor_wallet,
    version_row.body_private, version_row.content_public_safe,
    version_row.evidence_snapshot_hash, quorum.quorum_hash,
    report_row.current_published_version_id
  );
  select n.* into existing from public.osi_nonces as n
   where n.idempotency_key = p_idempotency_key for update;
  if found then
    if existing.purpose <> 'REPORT_PUBLISHED'
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.target_id is distinct from version_row.id::text
       or existing.payload_hash is distinct from exact_hash
       or coalesce(existing.binding_context->>'maintainer_auth_uuid', '')
          is distinct from coalesce(p_maintainer_auth_uuid, '') then
      raise exception 'Idempotency key is bound to another exact Report publication'
        using errcode = '23514';
    end if;
    return query select existing.nonce,
      existing.binding_context->>'case_public_ref',
      existing.binding_context->>'report_public_ref',
      existing.binding_context->>'version_public_ref',
      existing.binding_context->>'actor_role', existing.payload_hash,
      existing.binding_context->>'quorum_hash', existing.issued_at,
      existing.expires_at, existing.consumed_by_receipt_id, true;
    return;
  end if;
  perform osi_private.osi_v2_check_report_review_rate(
    p_actor_wallet, p_request_fingerprint_hash, 'REPORT_PUBLISHED', issued_time
  );
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into ttl_seconds from public.osi_config as config
   where config.key = 'OSI_V2_NONCE_TTL_SECONDS';
  if ttl_seconds is null or ttl_seconds not between 30 and 300 then
    raise exception 'Report publication nonce configuration is invalid' using errcode = '55000';
  end if;
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, 'REPORT_PUBLISHED', p_actor_wallet, 'report_version', version_row.id::text,
    exact_hash, p_idempotency_key, p_request_fingerprint_hash,
    jsonb_build_object(
      'actor_role', receipt_role,
      'case_public_ref', case_row.public_ref,
      'previous_published_version_id', coalesce(report_row.current_published_version_id::text, ''),
      'quorum_hash', quorum.quorum_hash,
      'report_public_ref', report_row.public_ref,
      'version_public_ref', version_row.version_ref
    ) || bootstrap_binding,
    issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds)
  );
  return query select p_nonce, case_row.public_ref, report_row.public_ref,
    version_row.version_ref, receipt_role, exact_hash, quorum.quorum_hash,
    issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds),
    null::uuid, false;
end
$$;

create function osi_private.osi_v2_commit_report_publication(
  p_nonce text,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz,
  p_maintainer_auth_uuid text default null
)
returns table (
  case_public_ref text, report_public_ref text, version_public_ref text,
  actor_role text, quorum_hash text, publication_receipt_id uuid,
  previous_published_version_ref text, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  existing_receipt public.event_receipts%rowtype;
  version_row public.case_report_versions%rowtype;
  report_row public.case_reports%rowtype;
  case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype;
  prior_version public.case_report_versions%rowtype;
  quorum record;
  receipt_role text;
  exact_hash text;
  new_receipt_id uuid := gen_random_uuid();
  bootstrap record;
  receipt_channel text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Report publication commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_report_review_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Report review writes are disabled' using errcode = '55000';
  end if;
  select n.* into bound from public.osi_nonces as n
   where n.nonce = p_nonce for update;
  if bound.nonce is null or bound.purpose <> 'REPORT_PUBLISHED'
     or bound.target_type <> 'report_version' then
    raise exception 'Report publication nonce binding is invalid' using errcode = '23514';
  end if;
  receipt_channel := coalesce(bound.binding_context->>'decision_channel', 'standard');
  if coalesce(bound.binding_context->>'maintainer_auth_uuid', '')
     is distinct from coalesce(p_maintainer_auth_uuid, '') then
    raise exception 'Report publication maintainer binding changed after prepare'
      using errcode = '23514';
  end if;
  if bound.consumed_at is not null then
    select receipt.* into existing_receipt from public.event_receipts as receipt
     where receipt.id = bound.consumed_by_receipt_id;
    if existing_receipt.id is null
       or existing_receipt.event_type <> 'REPORT_PUBLISHED'
       or existing_receipt.tx_sig is distinct from p_tx_sig
       or existing_receipt.memo_ref is distinct from p_memo_ref
       or existing_receipt.payload_hash is distinct from bound.payload_hash then
      raise exception 'Consumed Report publication nonce does not match exact retry'
        using errcode = '23514';
    end if;
    select version.* into version_row from public.case_report_versions as version
     where version.id = bound.target_id::uuid;
    select prior.* into prior_version from public.case_report_versions as prior
     where prior.id = nullif(bound.binding_context->>'previous_published_version_id', '')::uuid;
    return query select bound.binding_context->>'case_public_ref',
      bound.binding_context->>'report_public_ref',
      bound.binding_context->>'version_public_ref', existing_receipt.actor_role,
      bound.binding_context->>'quorum_hash', existing_receipt.id,
      prior_version.version_ref, true;
    return;
  end if;
  if statement_timestamp() > bound.expires_at then
    raise exception 'Report publication nonce expired' using errcode = '22023';
  end if;
  select version.* into version_row from public.case_report_versions as version
   where version.id = bound.target_id::uuid for update;
  select report.* into report_row from public.case_reports as report
   where report.id = version_row.report_id for update;
  select case_item.* into case_row from public.cases as case_item
   where case_item.id = report_row.case_id;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = bound.actor_wallet;
  if version_row.id is null or not report_row.native_intake
     or report_row.current_version_id is distinct from version_row.id
     or version_row.lifecycle_state not in ('submitted', 'in_review')
     or report_row.current_published_version_id is distinct from
       nullif(bound.binding_context->>'previous_published_version_id', '')::uuid
     or case_row.visibility <> 'public'
     or case_row.stage not in ('open_public', 'in_review', 'reopened') then
    raise exception 'Report publication lineage changed after prepare' using errcode = '40001';
  end if;
  if receipt_channel = 'maintainer_bootstrap' then
    if osi_private.osi_v2_full_maintainer_binding(bound.actor_wallet, p_maintainer_auth_uuid) is distinct from true then
      raise exception 'Bootstrap publication lost a maintainer gate' using errcode = '42501';
    end if;
    if bound.actor_wallet in (report_row.author_wallet, case_row.submitted_by_wallet)
       or exists (
         select 1 from public.case_report_reviews as review
          where review.report_version_id = version_row.id
            and review.reviewer_wallet = bound.actor_wallet
            and review.is_active = true
       ) then
      raise exception 'Bootstrap maintainer cannot decide their own Case or Report'
        using errcode = '42501';
    end if;
    receipt_role := 'maintainer';
    if receipt_role is distinct from bound.binding_context->>'actor_role' then
      raise exception 'Publication actor role changed after prepare' using errcode = '42501';
    end if;
    -- Recompute the live tier and support inside this commit transaction.
    select * into bootstrap from osi_private.osi_v2_bootstrap_tier();
    select * into quorum from osi_private.osi_v2_report_quorum(version_row.id);
    if bootstrap.active is distinct from true
       or bootstrap.tier is distinct from bound.binding_context->>'bootstrap_tier'
       or quorum.approve_ready is not distinct from true
       or quorum.quorum_hash is distinct from bound.binding_context->>'quorum_hash'
       or quorum.approve_count < bootstrap.required_analyst_count
       or quorum.approve_weight < bootstrap.required_analyst_weight then
      raise exception 'Report publication quorum changed after prepare' using errcode = '40001';
    end if;
  else
    if bound.actor_wallet in (report_row.author_wallet, case_row.submitted_by_wallet)
       or profile.wallet is null
       or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
       or profile.verified is not true or profile.approved is not true
       or not exists (
         select 1 from public.case_report_reviews as review
          where review.report_version_id = version_row.id
            and review.reviewer_wallet = bound.actor_wallet
            and review.is_active = true and review.decision = 'approve'
       ) then
      raise exception 'Publication requires an active approving eligible analyst'
        using errcode = '42501';
    end if;
    receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
    if receipt_role is distinct from bound.binding_context->>'actor_role' then
      raise exception 'Publication actor role changed after prepare' using errcode = '42501';
    end if;
    select * into quorum from osi_private.osi_v2_report_quorum(version_row.id);
    if quorum.approve_ready is distinct from true
       or quorum.quorum_hash is distinct from bound.binding_context->>'quorum_hash' then
      raise exception 'Report publication quorum changed after prepare' using errcode = '40001';
    end if;
  end if;
  exact_hash := osi_private.osi_v2_report_publication_payload_hash(
    version_row.id, version_row.version_ref, bound.actor_wallet,
    version_row.body_private, version_row.content_public_safe,
    version_row.evidence_snapshot_hash, quorum.quorum_hash,
    report_row.current_published_version_id
  );
  if exact_hash is distinct from bound.payload_hash then
    raise exception 'Report publication payload changed after prepare' using errcode = '23514';
  end if;
  if report_row.current_published_version_id is not null then
    select prior.* into prior_version from public.case_report_versions as prior
     where prior.id = report_row.current_published_version_id
       and prior.report_id = report_row.id for update;
    if prior_version.lifecycle_state <> 'published' then
      raise exception 'Prior published Report pointer is invalid' using errcode = '23503';
    end if;
  end if;
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, weight, reason_code, proof_type,
    memo_ref, anchor_wallet, payload_hash, nonce, tx_sig, signature,
    server_verified, occurred_at, created_at, decision_channel
  ) values (
    new_receipt_id, 'OSI2', 'REPORT_PUBLISHED', 'report_version', version_row.id::text,
    version_row.version_ref, bound.actor_wallet, receipt_role, 'publish', null,
    null, 'solana_memo', p_memo_ref, bound.actor_wallet, exact_hash,
    bound.nonce, p_tx_sig, null, true, p_occurred_at, statement_timestamp(),
    receipt_channel
  );
  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(), consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound.nonce and nonce.consumed_at is null;
  if not found then
    raise exception 'Report publication nonce consumed concurrently' using errcode = '40001';
  end if;
  if receipt_channel = 'maintainer_bootstrap' and version_row.lifecycle_state = 'submitted' then
    update public.case_report_versions as version
       set lifecycle_state = 'in_review', updated_at = statement_timestamp()
     where version.id = version_row.id and version.lifecycle_state = 'submitted';
    if not found then
      raise exception 'Report publication state changed concurrently' using errcode = '40001';
    end if;
  end if;
  update public.case_report_versions as version
     set lifecycle_state = 'published', published_at = p_occurred_at,
         publication_receipt_id = new_receipt_id,
         publication_quorum_hash = quorum.quorum_hash,
         updated_at = statement_timestamp()
   where version.id = version_row.id and version.lifecycle_state = 'in_review';
  if not found then
    raise exception 'Report publication state changed concurrently' using errcode = '40001';
  end if;
  if prior_version.id is not null then
    update public.case_report_versions as version
       set lifecycle_state = 'superseded', superseded_at = p_occurred_at,
           superseded_by_version_id = version_row.id,
           updated_at = statement_timestamp()
     where version.id = prior_version.id and version.lifecycle_state = 'published';
  end if;
  update public.case_reports as report
     set current_published_version_id = version_row.id,
         updated_at = statement_timestamp()
   where report.id = report_row.id
     and report.current_published_version_id is not distinct from prior_version.id;
  if not found then
    raise exception 'Report published pointer changed concurrently' using errcode = '40001';
  end if;
  return query select case_row.public_ref, report_row.public_ref,
    version_row.version_ref, receipt_role, quorum.quorum_hash,
    new_receipt_id, prior_version.version_ref, false;
end
$$;

create function public.osi_v2_prepare_report_publication(
  p_nonce text, p_actor_wallet text, p_version_id uuid,
  p_idempotency_key text, p_request_fingerprint_hash text,
  p_maintainer_auth_uuid text default null
)
returns table (
  issued_nonce text, case_public_ref text, report_public_ref text,
  version_public_ref text, actor_role text, payload_hash text,
  quorum_hash text, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_prepare_report_publication(
    p_nonce, p_actor_wallet, p_version_id, p_idempotency_key,
    p_request_fingerprint_hash, p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_commit_report_publication(
  p_nonce text, p_tx_sig text, p_memo_ref text, p_occurred_at timestamptz,
  p_maintainer_auth_uuid text default null
)
returns table (
  case_public_ref text, report_public_ref text, version_public_ref text,
  actor_role text, quorum_hash text, publication_receipt_id uuid,
  previous_published_version_ref text, idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_report_publication(
    p_nonce, p_tx_sig, p_memo_ref, p_occurred_at, p_maintainer_auth_uuid
  )
$$;

-- D18 Path B: candidacy through a real quorum-selected contribution. The
-- winning version's author moves from contributor to analyst_candidate, the
-- same status an application submission produces. Candidacy only: tier,
-- weight, verified and approved stay untouched, and activation still
-- requires the reviewed application path and its ANALYST_PROBATION Memo.
-- This is a private status side effect of the already-recorded finalize
-- event; it intentionally creates no receipt, Memo, or Proof Log entry.
create function public.osi_v2_promote_winning_author()
returns trigger
language plpgsql
set search_path = ''
as $$
declare winning_author text;
begin
  select version.created_by_wallet into winning_author
    from public.case_report_versions as version
   where version.id = new.winning_report_version_id;
  if winning_author is null then return new; end if;
  insert into public.analyst_profiles (
    wallet, status, tier_code, verified, approved, weight_cached,
    created_at, updated_at
  ) values (
    winning_author, 'analyst_candidate', 'none', false, false, 0,
    statement_timestamp(), statement_timestamp()
  ) on conflict (wallet) do update set
    status = case when public.analyst_profiles.status = 'contributor'
      then 'analyst_candidate' else public.analyst_profiles.status end,
    updated_at = case when public.analyst_profiles.status = 'contributor'
      then statement_timestamp() else public.analyst_profiles.updated_at end;
  return new;
end
$$;

create trigger osi_v2_promote_winning_author
after update of winning_report_version_id on public.case_resolutions
for each row
when (old.winning_report_version_id is null and new.winning_report_version_id is not null)
execute function public.osi_v2_promote_winning_author();

comment on function public.osi_v2_promote_winning_author() is
  'D18 Path B: a finalize that sets winning_report_version_id promotes the winning author from contributor to analyst_candidate. Candidacy only; no governance receipt is created and activation still requires application review.';

revoke all privileges on function osi_private.osi_v2_bootstrap_tier() from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_bootstrap_selection_support(uuid, uuid, text) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_report_publication(text, text, uuid, text, text, text) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_report_publication(text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_prepare_report_publication(text, text, uuid, text, text, text) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_report_publication(text, text, text, timestamptz, text) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_promote_winning_author() from public, anon, authenticated;

grant execute on function osi_private.osi_v2_prepare_report_publication(text, text, uuid, text, text, text) to service_role;
grant execute on function osi_private.osi_v2_commit_report_publication(text, text, text, timestamptz, text) to service_role;
grant execute on function public.osi_v2_prepare_report_publication(text, text, uuid, text, text, text) to service_role;
grant execute on function public.osi_v2_commit_report_publication(text, text, text, timestamptz, text) to service_role;

commit;
