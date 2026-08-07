-- OSI V2 Case and Report public-safe visibility, publication capability and
-- long-form intake limits.
--
-- Three defects are fixed here, all additive and forward-only.
--
-- 1. Structured intake evidence never became readable. Case intake and Report
--    intake insert their wallet, transaction and HTTPS references as
--    evidence_items with moderation_state='pending' and is_public=false, and no
--    transition ever promoted them. The Wire slice already promotes its exact
--    version evidence inside its publication commit
--    (20260718130000_osi_v2_wire_phase2.sql). The Case public-open commit and
--    the Case Report publication commit did not, so every public projection
--    filtered the entire manifest away and the public Case/Report showed no
--    wallets, no transactions and no links. Both commits now promote exactly
--    the manifest the reviewers approved, in the same transaction as the
--    outcome receipt, using the Wire pattern verbatim.
--
-- 2. Nothing exposed a server-derived answer to "may this exact wallet anchor
--    CASE_OPENED on this exact Case". The browser re-derived it from raw review
--    weights, which are not SAS-aware, so an eligible analyst whose credential
--    genuinely counted could be shown no publish control while a wallet whose
--    credential did not count could be shown one that the write path then
--    refused. osi_v2_case_opening_capabilities() is the read-only mirror of the
--    write-path gate, exactly as osi_v2_report_publication_capabilities() is for
--    Report publication. It issues no nonce, writes no row and delegates the
--    counted quorum to the canonical SAS-aware Case quorum functions.
--
-- 3. Long-form research did not fit. The Case and Report text bounds are widened
--    to the owner-approved minimums. Widening a CHECK is non-destructive: every
--    existing row that satisfied the narrow bound still satisfies the wide one.
--
-- No column, table, constraint or function is dropped except where a constraint
-- is immediately re-added in the same statement with a wider bound, and no row
-- is deleted. The backfill at the end only promotes evidence that a completed,
-- receipted publication transition should already have promoted; it never
-- touches a 'blocked' item and never makes a private Case public.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '300s';

-- ---------------------------------------------------------------------------
-- 1. Long-form text bounds.
--
-- Storage layer first. Every one of these is a widening: 1..4000 becomes
-- 1..10000 and so on, so no stored value can be invalidated by this migration.
-- ---------------------------------------------------------------------------

alter table public.cases
  drop constraint cases_summary_public_length_check,
  add constraint cases_summary_public_length_check
    check (char_length(btrim(summary_public)) between 1 and 10000),
  drop constraint cases_details_restricted_length_check,
  add constraint cases_details_restricted_length_check
    check (char_length(btrim(details_restricted)) between 0 and 25000);

comment on column public.cases.summary_public is
  'Public-safe Case summary, up to 10000 characters. Readable by the owner, an eligible analyst and a full maintainer during review, and by anyone once the Case is public.';
comment on column public.cases.details_restricted is
  'Private intake detail, up to 25000 characters, visible only through an authorized server projection; immutable after submission.';

alter table public.case_report_reviews
  drop constraint case_report_reviews_public_rationale_check,
  add constraint case_report_reviews_public_rationale_check
    check (
      public_rationale is null
      or (
        public_rationale = btrim(public_rationale)
        and char_length(public_rationale) between 10 and 10000
      )
    ),
  drop constraint case_report_reviews_private_note_check,
  add constraint case_report_reviews_private_note_check
    check (
      private_note is null
      or (
        private_note = btrim(private_note)
        and char_length(private_note) between 1 and 10000
      )
    );

alter table public.resolution_reviews
  drop constraint resolution_reviews_public_rationale_check,
  add constraint resolution_reviews_public_rationale_check
    check (
      public_rationale is null
      or (
        public_rationale = btrim(public_rationale)
        and char_length(public_rationale) between 10 and 10000
      )
    ),
  drop constraint resolution_reviews_private_note_check,
  add constraint resolution_reviews_private_note_check
    check (
      private_note is null
      or (
        private_note = btrim(private_note)
        and char_length(private_note) between 1 and 10000
      )
    );

alter table public.challenge_reviews
  drop constraint challenge_reviews_public_rationale_check,
  add constraint challenge_reviews_public_rationale_check
    check (
      public_rationale is null
      or (
        public_rationale = btrim(public_rationale)
        and char_length(public_rationale) between 10 and 10000
      )
    ),
  drop constraint challenge_reviews_private_note_check,
  add constraint challenge_reviews_private_note_check
    check (
      private_note is null
      or (
        private_note = btrim(private_note)
        and char_length(private_note) between 1 and 10000
      )
    );

alter table public.challenges_v2
  drop constraint challenges_v2_public_safe_summary_check,
  add constraint challenges_v2_public_safe_summary_check
    check (
      public_safe_summary is null
      or (
        public_safe_summary = btrim(public_safe_summary)
        and char_length(public_safe_summary) between 20 and 10000
      )
    ),
  drop constraint challenges_v2_restricted_detail_check,
  add constraint challenges_v2_restricted_detail_check
    check (
      restricted_detail is null
      or (
        restricted_detail = btrim(restricted_detail)
        and char_length(restricted_detail) between 1 and 10000
      )
    );

alter table public.wire_report_reviews
  drop constraint wire_report_reviews_public_rationale_check,
  add constraint wire_report_reviews_public_rationale_check
    check (
      public_rationale is null
      or (
        public_rationale = btrim(public_rationale)
        and char_length(public_rationale) between 10 and 10000
      )
    ),
  drop constraint wire_report_reviews_private_note_check,
  add constraint wire_report_reviews_private_note_check
    check (
      private_note is null
      or (
        private_note = btrim(private_note)
        and char_length(private_note) between 1 and 10000
      )
    );

alter table public.wire_report_versions
  drop constraint wire_report_versions_uncertainties_check,
  add constraint wire_report_versions_uncertainties_check
    check (
      uncertainties_private is null
      or (
        uncertainties_private = btrim(uncertainties_private)
        and char_length(uncertainties_private) between 0 and 10000
      )
    );

-- Validator functions next. These raise before the storage layer is reached, so
-- widening the constraints without widening them would change nothing.

create or replace function osi_private.osi_v2_validate_report_content(
  p_body_private text,
  p_content_public_safe text,
  p_revision_reason_code text,
  p_is_revision boolean
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_body_private is null
     or p_body_private is distinct from btrim(p_body_private)
     or char_length(p_body_private) not between 80 and 100000 then
    raise exception 'Report narrative must contain between 80 and 100000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_content_public_safe is not null
     and (
       p_content_public_safe is distinct from btrim(p_content_public_safe)
       or char_length(p_content_public_safe) not between 1 and 10000
     ) then
    raise exception 'Public-safe summary must contain between 1 and 10000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_is_revision then
    if p_revision_reason_code not in (
      'author_correction', 'new_evidence', 'clarification', 'review_response'
    ) then
      raise exception 'A revision requires an allowed reason code'
        using errcode = '23514';
    end if;
  elsif p_revision_reason_code is not null then
    raise exception 'Initial Report version cannot claim a revision reason'
      using errcode = '23514';
  end if;
  return true;
end
$$;

create or replace function osi_private.osi_v2_validate_wire_content(
  p_title_public_safe text,
  p_content_public_safe text,
  p_body_private text,
  p_uncertainties_private text,
  p_revision_reason_code text,
  p_is_revision boolean
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_title_public_safe is null
     or p_title_public_safe is distinct from btrim(p_title_public_safe)
     or char_length(p_title_public_safe) not between 3 and 160 then
    raise exception 'Wire title must contain between 3 and 160 trimmed characters'
      using errcode = '23514';
  end if;
  if p_content_public_safe is null
     or p_content_public_safe is distinct from btrim(p_content_public_safe)
     or char_length(p_content_public_safe) not between 10 and 10000 then
    raise exception 'Wire summary must contain between 10 and 10000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_body_private is null
     or p_body_private is distinct from btrim(p_body_private)
     or char_length(p_body_private) not between 20 and 100000 then
    raise exception 'Wire analysis must contain between 20 and 100000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_uncertainties_private is not null
     and (
       p_uncertainties_private is distinct from btrim(p_uncertainties_private)
       or char_length(p_uncertainties_private) > 10000
     ) then
    raise exception 'Wire uncertainties must be empty or contain at most 10000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_is_revision then
    if p_revision_reason_code not in (
      'author_correction', 'new_evidence', 'clarification', 'review_response'
    ) then
      raise exception 'A Wire revision requires an allowed reason code'
        using errcode = '23514';
    end if;
  elsif p_revision_reason_code is not null then
    raise exception 'Initial Wire version cannot claim a revision reason'
      using errcode = '23514';
  end if;
  return true;
end
$$;

-- The two functions below are reproduced verbatim from their current reviewed
-- definitions. The only changes are the five widened numeric bounds; the diff
-- against the source migration is exactly five lines.
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
       or char_length(p_payload->>'public_rationale') not between 10 and 10000
       or (p_payload ? 'private_note' and p_payload->>'private_note' is not null and (
         p_payload->>'private_note' <> btrim(p_payload->>'private_note')
         or char_length(p_payload->>'private_note') not between 1 and 10000
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
       or char_length(p_payload->>'public_safe_summary') not between 20 and 10000
       or (p_payload ? 'restricted_detail' and p_payload->>'restricted_detail' is not null and (
         p_payload->>'restricted_detail' <> btrim(p_payload->>'restricted_detail')
         or char_length(p_payload->>'restricted_detail') not between 1 and 10000
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
         or char_length(p_payload->>'public_rationale') not between 10 and 10000 then
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

create or replace function osi_private.osi_v2_prepare_report_review(
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
  issued_nonce text, purpose text, case_public_ref text,
  report_public_ref text, version_public_ref text,
  review_public_ref text, actor_role text, payload_hash text,
  issued_at timestamptz, expires_at timestamptz,
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
  event_type text;
  receipt_role text;
  review_id uuid := gen_random_uuid();
  review_ref text;
  exact_hash text;
  issued_time timestamptz := statement_timestamp();
  ttl_seconds integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Report review prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_report_review_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Report review writes are disabled' using errcode = '55000';
  end if;
  if p_decision not in ('approve', 'reject', 'request_revision', 'abstain')
     or p_reason_code is null or p_reason_code !~ '^[a-z][a-z0-9_:-]{0,95}$'
     or p_public_rationale is null or p_public_rationale <> btrim(p_public_rationale)
     or char_length(p_public_rationale) not between 10 and 10000
     or (p_private_note is not null and (
       p_private_note <> btrim(p_private_note) or char_length(p_private_note) not between 1 and 10000
     )) then
    raise exception 'Report review payload is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-review-idempotency:' || p_idempotency_key, 0)
  );
  select version.* into version_row from public.case_report_versions as version
   where version.id = p_version_id for update;
  select report.* into report_row from public.case_reports as report
   where report.id = version_row.report_id for update;
  select case_item.* into case_row from public.cases as case_item
   where case_item.id = report_row.case_id;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = p_actor_wallet;
  if version_row.id is null or report_row.id is null or not report_row.native_intake
     or report_row.current_version_id is distinct from version_row.id
     or version_row.version_ref is null
     or version_row.lifecycle_state not in ('submitted', 'in_review')
     or case_row.visibility <> 'public'
     or case_row.stage not in ('open_public', 'in_review', 'reopened') then
    raise exception 'Report version is not available for review' using errcode = '42501';
  end if;
  if p_actor_wallet in (report_row.author_wallet, case_row.submitted_by_wallet) then
    raise exception 'Report author and Case owner cannot review this Report' using errcode = '42501';
  end if;
  if profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true
     or profile.weight_cached not between 0.50 and 3.00 then
    raise exception 'Actor is not an eligible Report analyst' using errcode = '42501';
  end if;
  event_type := case when exists (
    select 1 from public.case_report_reviews as review
     where review.report_version_id = version_row.id
       and review.reviewer_wallet = p_actor_wallet
  ) then 'CASE_REPORT_REVIEW_REVISED' else 'CASE_REPORT_REVIEW_CAST' end;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  exact_hash := osi_private.osi_v2_report_review_payload_hash(
    event_type, version_row.id, version_row.version_ref, p_actor_wallet,
    p_decision, p_reason_code, p_public_rationale, p_private_note
  );

  select n.* into existing from public.osi_nonces as n
   where n.idempotency_key = p_idempotency_key for update;
  if found then
    if existing.purpose is distinct from event_type
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.target_type <> 'report_version'
       or existing.target_id is distinct from version_row.id::text
       or existing.payload_hash is distinct from exact_hash then
      raise exception 'Idempotency key is bound to another exact Report review'
        using errcode = '23514';
    end if;
    return query select existing.nonce, existing.purpose,
      existing.binding_context->>'case_public_ref',
      existing.binding_context->>'report_public_ref',
      existing.binding_context->>'version_public_ref',
      existing.binding_context->>'review_public_ref',
      existing.binding_context->>'actor_role', existing.payload_hash,
      existing.issued_at, existing.expires_at,
      existing.consumed_by_receipt_id, true;
    return;
  end if;

  perform osi_private.osi_v2_check_report_review_rate(
    p_actor_wallet, p_request_fingerprint_hash, event_type, issued_time
  );
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into ttl_seconds from public.osi_config as config
   where config.key = 'OSI_V2_NONCE_TTL_SECONDS';
  if ttl_seconds is null or ttl_seconds not between 30 and 300 then
    raise exception 'Report review nonce configuration is invalid' using errcode = '55000';
  end if;
  review_ref := 'OSI-RVW-' || upper(substr(replace(review_id::text, '-', ''), 1, 16));
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, event_type, p_actor_wallet, 'report_version', version_row.id::text,
    exact_hash, p_idempotency_key, p_request_fingerprint_hash,
    jsonb_build_object(
      'actor_role', receipt_role,
      'case_public_ref', case_row.public_ref,
      'report_public_ref', report_row.public_ref,
      'review_id', review_id,
      'review_public_ref', review_ref,
      'tier_snapshot', profile.tier_code,
      'version_public_ref', version_row.version_ref
    ),
    issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds)
  );
  return query select p_nonce, event_type, case_row.public_ref,
    report_row.public_ref, version_row.version_ref, review_ref, receipt_role,
    exact_hash, issued_time,
    issued_time + pg_catalog.make_interval(secs => ttl_seconds),
    null::uuid, false;
end
$$;

create or replace function osi_private.osi_v2_commit_case_open_outcome(
  p_nonce text,p_tx_sig text,p_memo_ref text,p_occurred_at timestamptz
)
returns table(public_ref text,receipt_id uuid,idempotent_replay boolean)
language plpgsql security invoker set search_path = ''
as $$
declare bound public.osi_nonces%rowtype; existing_receipt public.event_receipts%rowtype;
  case_row public.cases%rowtype; profile public.analyst_profiles%rowtype;
  quorum record; rejection record; receipt_role text; exact_hash text;
  new_receipt_id uuid:=gen_random_uuid();
begin
  if current_user not in ('postgres','service_role','supabase_admin') then
    raise exception 'Case open commit is service-only' using errcode='42501'; end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode='55000'; end if;
  select * into bound from public.osi_nonces where nonce=p_nonce for update;
  if bound.nonce is null or bound.purpose<>'CASE_OPENED' or bound.target_type<>'case' then
    raise exception 'Case open nonce is invalid' using errcode='23514'; end if;
  if bound.consumed_at is not null then
    select * into existing_receipt from public.event_receipts where id=bound.consumed_by_receipt_id;
    if existing_receipt.event_type<>'CASE_OPENED' or existing_receipt.tx_sig is distinct from p_tx_sig
       or existing_receipt.memo_ref is distinct from p_memo_ref then
      raise exception 'Consumed open nonce changed proof' using errcode='23514'; end if;
    return query select existing_receipt.public_ref,existing_receipt.id,true; return;
  end if;
  if statement_timestamp()>bound.expires_at then raise exception 'Open nonce expired' using errcode='22023'; end if;
  select * into case_row from public.cases where id=bound.target_id::uuid for update;
  if case_row.id is null or case_row.stage<>'initial_review' or case_row.visibility<>'private'
     or case_row.submitted_by_wallet=bound.actor_wallet then
    raise exception 'Case open lineage changed' using errcode='40001'; end if;
  select * into quorum from osi_private.osi_v2_case_review_quorum(case_row.id);
  select * into rejection from osi_private.osi_v2_case_rejection_quorum(case_row.id);
  if rejection.reject_ready is true or rejection.quorum_hash<>bound.binding_context->>'quorum_hash' then
    raise exception 'Opening quorum changed or is contested' using errcode='40001'; end if;
  receipt_role:=bound.binding_context->>'actor_role';
  if receipt_role='maintainer' then
    if quorum.maintainer_ready is distinct from true or not exists(
      select 1 from public.case_initial_reviews as review
       where review.case_id=case_row.id and review.reviewer_wallet=bound.actor_wallet
         and review.reviewer_role='maintainer' and review.decision='approve_open'
         and review.is_active=true
         and review.created_at>osi_private.osi_v2_case_review_cycle_started_at(case_row.id)
    ) then raise exception 'Maintainer opening path changed' using errcode='40001'; end if;
  elsif receipt_role in ('analyst','senior') then
    select * into profile from public.analyst_profiles where wallet=bound.actor_wallet;
    if profile.wallet is null or profile.status not in ('probationary_analyst','verified_analyst','senior_analyst')
       or profile.verified is not true or profile.approved is not true
       or quorum.analyst_ready is distinct from true or not exists(
         select 1 from public.case_initial_reviews as review
          where review.case_id=case_row.id and review.reviewer_wallet=bound.actor_wallet
            and review.reviewer_role='analyst' and review.decision='approve_open'
            and review.is_active=true
            and review.created_at>osi_private.osi_v2_case_review_cycle_started_at(case_row.id)
            and osi_private.osi_v2_sas_review_counts('case_initial',review.id)
       ) then raise exception 'Analyst opening path changed' using errcode='40001'; end if;
    if receipt_role<>(case when profile.status='senior_analyst' then 'senior' else 'analyst' end) then
      raise exception 'Opening actor role changed' using errcode='40001'; end if;
  else raise exception 'Opening role is invalid' using errcode='42501'; end if;
  exact_hash:=osi_private.osi_v2_case_outcome_payload_hash(
    case_row.id,case_row.public_ref,bound.actor_wallet,receipt_role,'open',rejection.quorum_hash);
  if exact_hash<>bound.payload_hash then raise exception 'Opening payload changed' using errcode='23514'; end if;
  insert into public.event_receipts(
    id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,
    decision,proof_type,memo_ref,anchor_wallet,payload_hash,nonce,tx_sig,server_verified,occurred_at
  ) values(
    new_receipt_id,'OSI2','CASE_OPENED','case',case_row.id::text,case_row.public_ref,
    bound.actor_wallet,receipt_role,'open','solana_memo',p_memo_ref,bound.actor_wallet,
    exact_hash,bound.nonce,p_tx_sig,true,p_occurred_at);
  update public.osi_nonces set consumed_at=statement_timestamp(),consumed_by_receipt_id=new_receipt_id,
    updated_at=statement_timestamp() where nonce=bound.nonce and consumed_at is null;
  if not found then raise exception 'Open nonce consumed concurrently' using errcode='40001'; end if;
  update public.cases set stage='open_public',visibility='public',opened_receipt_id=new_receipt_id,
    updated_at=statement_timestamp() where id=case_row.id and stage='initial_review' and visibility='private';
  if not found then raise exception 'Case open changed concurrently' using errcode='40001'; end if;
  -- The approve-open decision that authorized this transition reviewed the
  -- exact intake manifest, so the manifest becomes public-safe in the same
  -- transaction as the outcome receipt. This mirrors
  -- osi_private.osi_v2_commit_wire_publication. A 'blocked' item is never
  -- promoted, and evidence linked after this transition stays pending until a
  -- later authorized transition promotes it.
  update public.evidence_items as evidence
     set moderation_state='approved',is_public=true,updated_at=statement_timestamp()
    from public.case_evidence_links as link
   where link.case_id=case_row.id
     and link.evidence_item_id=evidence.id
     and evidence.moderation_state='pending';
  return query select case_row.public_ref,new_receipt_id,false;
end
$$;
create or replace function osi_private.osi_v2_commit_report_publication(
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
  -- Late RPC recovery: a publication transaction is valid when its verified
  -- mainnet block time falls inside the original nonce window. Commit time is
  -- not a valid reason to discard an otherwise exact transaction. Carried
  -- forward verbatim from 20260801092744_report_publication_rpc_recovery.sql,
  -- which patched this guard into the running definition.
  if p_occurred_at is null
     or p_occurred_at < bound.issued_at
     or p_occurred_at > bound.expires_at then
    raise exception 'Report publication transaction outside issuance window'
      using errcode = '22023';
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
     set consumed_at = p_occurred_at, consumed_by_receipt_id = new_receipt_id,
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
  -- The analyst quorum (or the D17 maintainer bootstrap channel) approved this
  -- exact version together with its exact evidence manifest, so the manifest
  -- becomes public-safe in the same transaction as the publication receipt.
  -- Without this the public Report projection filtered every wallet,
  -- transaction and source link away. This mirrors
  -- osi_private.osi_v2_commit_wire_publication; a 'blocked' item is never
  -- promoted.
  update public.evidence_items as evidence
     set moderation_state = 'approved', is_public = true,
         updated_at = statement_timestamp()
    from public.case_report_version_evidence as link
   where link.report_version_id = version_row.id
     and link.evidence_item_id = evidence.id
     and evidence.moderation_state = 'pending';
  return query select case_row.public_ref, report_row.public_ref,
    version_row.version_ref, receipt_role, quorum.quorum_hash,
    new_receipt_id, prior_version.version_ref, false;
end
$$;


create or replace function osi_private.osi_v2_prepare_wire_review(
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
     or char_length(p_public_rationale) not between 10 and 10000
     or (p_private_note is not null and (
       p_private_note <> btrim(p_private_note)
       or char_length(p_private_note) not between 1 and 10000
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


create or replace function osi_private.osi_v2_prepare_wire_governance_action(
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
       or char_length(p_payload->>'public_safe_summary') not between 20 and 10000
       or (p_payload ? 'restricted_detail' and p_payload->>'restricted_detail' is not null and (
         p_payload->>'restricted_detail' <> btrim(p_payload->>'restricted_detail')
         or char_length(p_payload->>'restricted_detail') not between 1 and 10000
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
         or char_length(p_payload->>'public_rationale') not between 10 and 10000
         or (p_payload ? 'private_note' and p_payload->>'private_note' is not null and (
           p_payload->>'private_note' <> btrim(p_payload->>'private_note')
           or char_length(p_payload->>'private_note') not between 1 and 10000
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


-- ---------------------------------------------------------------------------
-- 3. Server-derived Case opening capability.
--
-- The exact read-only mirror of the osi_v2_prepare_case_open_outcome gate. It
-- issues no nonce, writes no row and delegates every counted decision to the
-- canonical SAS-aware Case quorum functions, so a surface that renders this
-- projection cannot offer a control the write path would refuse, and cannot
-- hide one it would allow.
-- ---------------------------------------------------------------------------
create function osi_private.osi_v2_case_opening_capabilities(
  p_actor_wallet text,
  p_case_ids uuid[],
  p_maintainer_auth_uuid text default null
)
returns table (
  case_id uuid,
  case_public_ref text,
  stage text,
  visibility text,
  actor_is_eligible_analyst boolean,
  actor_is_full_maintainer boolean,
  actor_is_case_owner boolean,
  can_cast_initial_review boolean,
  initial_review_reason_code text,
  can_anchor_public_open boolean,
  public_open_reason_code text,
  decision_channel text,
  actor_active_decision text,
  analyst_quorum_ready boolean,
  maintainer_path_ready boolean,
  analyst_approve_count integer,
  analyst_approve_weight numeric,
  required_analyst_count integer,
  required_analyst_weight numeric,
  reject_ready boolean,
  reject_count integer,
  reject_weight numeric,
  case_writes_enabled boolean,
  sas_enforcement_enabled boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  requested_ids uuid[];
  target record;
  quorum record;
  rejection record;
  writes_enabled boolean;
  sas_enforcing boolean;
  eligible_analyst boolean;
  full_maintainer boolean;
  owner_conflict boolean;
  reviewable boolean;
  actor_decision text;
  actor_counted_approval boolean;
  review_allowed boolean;
  review_reason text;
  open_allowed boolean;
  open_reason text;
  open_channel text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Case capability projection is service-only'
      using errcode = '42501';
  end if;
  if p_actor_wallet is null
     or char_length(p_actor_wallet) not between 32 and 44
     or p_actor_wallet !~ '^[1-9A-HJ-NP-Za-km-z]+$' then
    raise exception 'Case capability actor wallet is invalid'
      using errcode = '22023';
  end if;
  if p_case_ids is null
     or coalesce(array_length(p_case_ids, 1), 0) = 0
     or array_length(p_case_ids, 1) > 1000 then
    raise exception 'Case capability target list is invalid'
      using errcode = '22023';
  end if;
  select array_agg(distinct requested.id order by requested.id)
    into requested_ids
    from unnest(p_case_ids) as requested(id)
   where requested.id is not null;
  if requested_ids is null then
    raise exception 'Case capability target list is invalid'
      using errcode = '22023';
  end if;

  writes_enabled := osi_private.osi_v2_case_writes_enabled() is true;
  sas_enforcing := osi_private.osi_v2_sas_enforcement_enabled() is true;
  select exists (
    select 1
      from public.analyst_profiles as profile
     where profile.wallet = p_actor_wallet
       and profile.status in (
         'probationary_analyst', 'verified_analyst', 'senior_analyst'
       )
       and profile.verified is true
       and profile.approved is true
       and profile.weight_cached between 0.50 and 3.00
  ) into eligible_analyst;
  full_maintainer := coalesce(
    osi_private.osi_v2_full_maintainer_binding(
      p_actor_wallet,
      p_maintainer_auth_uuid
    ),
    false
  );

  for target in
    select case_item.id, case_item.public_ref, case_item.stage,
      case_item.visibility, case_item.submitted_by_wallet
    from public.cases as case_item
    where case_item.id = any(requested_ids)
    order by case_item.id
  loop
    select * into quorum
      from osi_private.osi_v2_case_review_quorum(target.id);
    select * into rejection
      from osi_private.osi_v2_case_rejection_quorum(target.id);

    owner_conflict := p_actor_wallet = target.submitted_by_wallet;
    reviewable := target.stage = 'initial_review' and target.visibility = 'private';

    select review.decision into actor_decision
      from public.case_initial_reviews as review
     where review.case_id = target.id
       and review.reviewer_wallet = p_actor_wallet
       and review.is_active is true
       and review.created_at
           > osi_private.osi_v2_case_review_cycle_started_at(target.id)
     order by review.created_at desc
     limit 1;

    -- An analyst opening claim requires that this wallet's own approval is one
    -- of the approvals the SAS-aware quorum actually counted. A maintainer
    -- bootstrap approval carries weight zero and is checked on its own row.
    select exists (
      select 1
        from public.case_initial_reviews as review
       where review.case_id = target.id
         and review.reviewer_wallet = p_actor_wallet
         and review.is_active is true
         and review.decision = 'approve_open'
         and review.created_at
             > osi_private.osi_v2_case_review_cycle_started_at(target.id)
         and (
           case
             when full_maintainer and review.reviewer_role = 'maintainer'
               then review.weight = 0
             else review.reviewer_role = 'analyst'
               and osi_private.osi_v2_sas_review_counts('case_initial', review.id)
           end
         )
    ) into actor_counted_approval;

    review_allowed :=
      writes_enabled
      and reviewable
      and not owner_conflict
      and (eligible_analyst or full_maintainer);
    review_reason := case
      when not writes_enabled then 'case_writes_disabled'
      when not reviewable then 'case_not_in_initial_review'
      when owner_conflict then 'case_owner_conflict'
      when not (eligible_analyst or full_maintainer) then 'not_eligible_reviewer'
      else null
    end;

    -- Maintainer bootstrap is checked first only so the reason code names the
    -- cold-start path when both are live; the analyst path is never blocked by
    -- the presence of a maintainer approval.
    open_channel := case
      when eligible_analyst
        and quorum.analyst_ready is true
        and actor_counted_approval
        and coalesce(actor_decision, '') = 'approve_open'
        then 'standard'
      when full_maintainer
        and quorum.maintainer_ready is true
        and actor_counted_approval
        and coalesce(actor_decision, '') = 'approve_open'
        then 'maintainer_bootstrap'
      else null
    end;
    open_allowed :=
      writes_enabled
      and reviewable
      and not owner_conflict
      and rejection.reject_ready is not true
      and open_channel is not null;
    open_reason := case
      when not writes_enabled then 'case_writes_disabled'
      when not reviewable then 'case_not_in_initial_review'
      when owner_conflict then 'case_owner_conflict'
      when rejection.reject_ready is true then 'rejection_quorum_ready'
      when not (eligible_analyst or full_maintainer) then 'not_eligible_reviewer'
      when coalesce(actor_decision, '') <> 'approve_open'
        then 'no_active_approve_open_review'
      when not actor_counted_approval then 'approval_not_counted'
      when eligible_analyst and quorum.analyst_ready is not true
        then 'analyst_open_quorum_not_ready'
      when full_maintainer and quorum.maintainer_ready is not true
        then 'maintainer_open_path_not_ready'
      when open_channel is null then 'open_path_unavailable'
      else null
    end;
    if open_allowed then open_reason := null; end if;

    case_id := target.id;
    case_public_ref := target.public_ref;
    stage := target.stage;
    visibility := target.visibility;
    actor_is_eligible_analyst := eligible_analyst;
    actor_is_full_maintainer := full_maintainer;
    actor_is_case_owner := owner_conflict;
    can_cast_initial_review := review_allowed;
    initial_review_reason_code := review_reason;
    can_anchor_public_open := open_allowed;
    public_open_reason_code := open_reason;
    decision_channel := case when open_allowed then open_channel else null end;
    actor_active_decision := actor_decision;
    analyst_quorum_ready := quorum.analyst_ready is true;
    maintainer_path_ready := quorum.maintainer_ready is true;
    analyst_approve_count := coalesce(quorum.analyst_count, 0)::integer;
    analyst_approve_weight := coalesce(quorum.total_weight, 0)::numeric;
    required_analyst_count := 1;
    required_analyst_weight := 0.50::numeric;
    reject_ready := rejection.reject_ready is true;
    reject_count := coalesce(rejection.reject_count, 0)::integer;
    reject_weight := coalesce(rejection.reject_weight, 0)::numeric;
    case_writes_enabled := writes_enabled;
    sas_enforcement_enabled := sas_enforcing;
    return next;
  end loop;
end
$$;

comment on function osi_private.osi_v2_case_opening_capabilities(text, uuid[], text) is
  'Service-only, side-effect-free exact Case opening capability projection. Counted quorum is delegated to the SAS-aware canonical Case quorum functions, so it can never disagree with the write path.';

create function public.osi_v2_case_opening_capabilities(
  p_actor_wallet text,
  p_case_ids uuid[],
  p_maintainer_auth_uuid text default null
)
returns table (
  case_id uuid,
  case_public_ref text,
  stage text,
  visibility text,
  actor_is_eligible_analyst boolean,
  actor_is_full_maintainer boolean,
  actor_is_case_owner boolean,
  can_cast_initial_review boolean,
  initial_review_reason_code text,
  can_anchor_public_open boolean,
  public_open_reason_code text,
  decision_channel text,
  actor_active_decision text,
  analyst_quorum_ready boolean,
  maintainer_path_ready boolean,
  analyst_approve_count integer,
  analyst_approve_weight numeric,
  required_analyst_count integer,
  required_analyst_weight numeric,
  reject_ready boolean,
  reject_count integer,
  reject_weight numeric,
  case_writes_enabled boolean,
  sas_enforcement_enabled boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
    from osi_private.osi_v2_case_opening_capabilities(
      p_actor_wallet,
      p_case_ids,
      p_maintainer_auth_uuid
    )
$$;

comment on function public.osi_v2_case_opening_capabilities(text, uuid[], text) is
  'Service-role-only PostgREST wrapper for the exact side-effect-free Case opening capability projection.';

revoke all privileges on function
  osi_private.osi_v2_case_opening_capabilities(text, uuid[], text)
  from public, anon, authenticated;
revoke all privileges on function
  public.osi_v2_case_opening_capabilities(text, uuid[], text)
  from public, anon, authenticated;
grant execute on function
  osi_private.osi_v2_case_opening_capabilities(text, uuid[], text)
  to service_role;
grant execute on function
  public.osi_v2_case_opening_capabilities(text, uuid[], text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Backfill for records published before the promotion existed.
--
-- These two statements do only what the corresponding publication transition
-- would have done if it had contained the promotion at the time it ran. They
-- are bounded by an already-completed, receipted transition:
--
--   * Case evidence: only Cases whose visibility is already 'public' and whose
--     stage is already one of the public stages, i.e. a confirmed CASE_OPENED
--     Memo already exists. A private Case is never touched.
--   * Report evidence: only versions whose lifecycle_state is 'published' or
--     'superseded' and which carry a publication receipt, i.e. a confirmed
--     REPORT_PUBLISHED Memo already exists. An unpublished version is never
--     touched.
--
-- Neither statement can widen visibility beyond what a completed publication
-- already made public, neither deletes or rewrites content, and neither touches
-- a 'blocked' item.
-- ---------------------------------------------------------------------------

update public.evidence_items as evidence
   set moderation_state = 'approved', is_public = true,
       updated_at = statement_timestamp()
  from public.case_evidence_links as link
  join public.cases as case_item on case_item.id = link.case_id
 where link.evidence_item_id = evidence.id
   and evidence.moderation_state = 'pending'
   and case_item.visibility = 'public'
   and case_item.archived_at is null
   and case_item.category <> 'legacy_import'
   and case_item.stage in (
     'open_public', 'in_review', 'ready_for_finalization', 'resolution_proposed',
     'in_challenge_window', 'resolved', 'sealed', 'archived', 'reopened', 'halted'
   );

update public.evidence_items as evidence
   set moderation_state = 'approved', is_public = true,
       updated_at = statement_timestamp()
  from public.case_report_version_evidence as link
  join public.case_report_versions as version on version.id = link.report_version_id
 where link.evidence_item_id = evidence.id
   and evidence.moderation_state = 'pending'
   and version.lifecycle_state in ('published', 'superseded')
   and version.publication_receipt_id is not null;

commit;
