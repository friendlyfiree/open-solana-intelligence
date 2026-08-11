-- Target-specific Resolution / seal finalization capabilities.
--
-- This is a side-effect-free mirror of the effective governance write gate.
-- It deliberately reports the unchanged standard quorum and D17 maintainer
-- bootstrap as separate channels. The browser never counts analysts, sums
-- weights, guesses the live D17 tier, or decides whether a conflict exists.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create function osi_private.osi_v2_governance_finalize_capabilities(
  p_actor_wallet text,
  p_case_ids uuid[],
  p_maintainer_auth_uuid text default null
)
returns table (
  case_id uuid,
  case_public_ref text,
  action text,
  target_public_ref text,
  report_version_ref text,
  standard_quorum_ready boolean,
  can_finalize_via_standard_quorum boolean,
  bootstrap_enabled boolean,
  bootstrap_active boolean,
  bootstrap_tier text,
  eligible_analyst_count integer,
  bootstrap_required_analyst_count integer,
  bootstrap_required_analyst_weight numeric,
  bootstrap_actual_support_count integer,
  bootstrap_actual_support_weight numeric,
  bootstrap_actor_conflicted boolean,
  bootstrap_can_finalize boolean,
  bootstrap_reason_code text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  requested_ids uuid[];
  target record;
  candidate record;
  resolution_row public.case_resolutions%rowtype;
  resolution_quorum record;
  seal_quorum record;
  bootstrap record;
  support record;
  writes_enabled boolean;
  full_maintainer boolean;
  lifecycle_ready boolean;
  has_blocker boolean;
  selected_author text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Governance finalize capability projection is service-only'
      using errcode = '42501';
  end if;
  if p_actor_wallet is null
     or char_length(p_actor_wallet) not between 32 and 44
     or p_actor_wallet !~ '^[1-9A-HJ-NP-Za-km-z]+$' then
    raise exception 'Governance finalize capability actor wallet is invalid'
      using errcode = '22023';
  end if;
  if p_case_ids is null
     or coalesce(array_length(p_case_ids, 1), 0) = 0
     or array_length(p_case_ids, 1) > 1000 then
    raise exception 'Governance finalize capability target list is invalid'
      using errcode = '22023';
  end if;
  select array_agg(distinct requested.id order by requested.id)
    into requested_ids
    from unnest(p_case_ids) as requested(id)
   where requested.id is not null;
  if requested_ids is null then
    raise exception 'Governance finalize capability target list is invalid'
      using errcode = '22023';
  end if;

  writes_enabled := osi_private.osi_v2_governance_writes_enabled() is true;
  full_maintainer := coalesce(
    osi_private.osi_v2_full_maintainer_binding(
      p_actor_wallet,
      p_maintainer_auth_uuid
    ),
    false
  );
  select * into bootstrap from osi_private.osi_v2_bootstrap_tier();

  for target in
    select case_item.*
      from public.cases as case_item
     where case_item.id = any(requested_ids)
     order by case_item.id
  loop
    resolution_row := null;
    select resolution.* into resolution_row
      from public.case_resolutions as resolution
     where resolution.case_id = target.id
       and resolution.state not in ('reopened', 'resolved_legacy')
     order by resolution.created_at desc
     limit 1;

    select null::uuid as leader_version_id,
      null::text as leader_version_ref,
      0::integer as leader_count,
      0::numeric as leader_weight,
      0::integer as required_count,
      0::numeric as required_weight,
      0::integer as ready_candidate_count,
      false::boolean as tie_unresolved,
      null::text as quorum_hash
      into resolution_quorum;
    if resolution_row.id is not null then
      select * into resolution_quorum
        from osi_private.osi_v2_resolution_quorum(resolution_row.id);
    end if;

    for candidate in
      -- D17 may name only the exact current published version. The standard
      -- channel is different: once an immutable exact version became the
      -- quorum leader, a later publication may supersede it without erasing
      -- that completed quorum. Emit that leader as a standard-only row so the
      -- capability projection continues to mirror the canonical write gate.
      select version.id, version.version_ref, report.author_wallet,
        true as bootstrap_candidate
        from public.case_reports as report
        join public.case_report_versions as version
          on version.id = report.current_published_version_id
         and version.report_id = report.id
       where report.case_id = target.id
         and version.lifecycle_state = 'published'
      union all
      select version.id, version.version_ref, report.author_wallet,
        false as bootstrap_candidate
        from public.case_report_versions as version
        join public.case_reports as report on report.id = version.report_id
       where resolution_row.id is not null
         and version.id = resolution_quorum.leader_version_id
         and not (
           version.lifecycle_state = 'published'
           and report.current_published_version_id = version.id
         )
       order by version_ref
    loop
      select 0::integer as support_count,
        0::numeric as support_weight,
        false::boolean as maintainer_conflicted,
        null::text as support_hash
        into support;
      if resolution_row.id is not null then
        select * into support
          from osi_private.osi_v2_bootstrap_selection_support(
            resolution_row.id,
            candidate.id,
            p_actor_wallet
          );
      end if;
      lifecycle_ready := target.visibility = 'public'
        and (
          (
            resolution_row.id is null
            and target.stage in (
              'open_public', 'in_review', 'ready_for_finalization', 'reopened'
            )
          )
          or resolution_row.state = 'selection_open'
        );

      case_id := target.id;
      case_public_ref := target.public_ref;
      action := 'resolution_finalize';
      target_public_ref := coalesce(resolution_row.public_ref, target.public_ref);
      report_version_ref := candidate.version_ref;
      standard_quorum_ready := resolution_row.id is not null
        and resolution_quorum.leader_version_id = candidate.id
        and resolution_quorum.tie_unresolved is distinct from true;
      can_finalize_via_standard_quorum := writes_enabled
        and full_maintainer
        and lifecycle_ready
        and standard_quorum_ready;
      bootstrap_enabled := bootstrap.enabled is true;
      bootstrap_active := bootstrap.active is true;
      bootstrap_tier := bootstrap.tier;
      eligible_analyst_count := bootstrap.eligible_analyst_count;
      bootstrap_required_analyst_count := bootstrap.required_analyst_count;
      bootstrap_required_analyst_weight := bootstrap.required_analyst_weight;
      bootstrap_actual_support_count := coalesce(support.support_count, 0);
      bootstrap_actual_support_weight := coalesce(support.support_weight, 0);
      bootstrap_actor_conflicted := target.submitted_by_wallet = p_actor_wallet
        or candidate.author_wallet = p_actor_wallet
        or coalesce(support.maintainer_conflicted, false);
      bootstrap_can_finalize := writes_enabled
        and full_maintainer
        and lifecycle_ready
        and candidate.bootstrap_candidate is true
        and bootstrap.active is true
        and coalesce(resolution_quorum.ready_candidate_count, 0) = 0
        and bootstrap_actor_conflicted is false
        and bootstrap_actual_support_count >= bootstrap.required_analyst_count
        and bootstrap_actual_support_weight >= bootstrap.required_analyst_weight;
      bootstrap_reason_code := case
        when not writes_enabled then 'governance_writes_disabled'
        when not full_maintainer then 'full_maintainer_gate_required'
        when not lifecycle_ready then 'resolution_not_selection_ready'
        when standard_quorum_ready then 'standard_quorum_ready'
        when resolution_quorum.tie_unresolved is true then 'standard_quorum_tie_unresolved'
        when coalesce(resolution_quorum.ready_candidate_count, 0) > 0
          then 'standard_quorum_exists'
        when candidate.bootstrap_candidate is distinct from true
          then 'bootstrap_candidate_not_current'
        when bootstrap.enabled is distinct from true then 'bootstrap_disabled'
        when bootstrap.active is distinct from true then 'bootstrap_retired'
        when bootstrap_actor_conflicted then 'actor_conflict'
        when bootstrap_actual_support_count < bootstrap.required_analyst_count
          then 'bootstrap_support_count_required'
        when bootstrap_actual_support_weight < bootstrap.required_analyst_weight
          then 'bootstrap_support_weight_required'
        else 'ready'
      end;
      return next;
    end loop;

    if resolution_row.id is not null
       and resolution_row.winning_report_version_id is not null then
      select * into seal_quorum
        from osi_private.osi_v2_seal_quorum(resolution_row.id);
      select report.author_wallet into selected_author
        from public.case_report_versions as version
        join public.case_reports as report on report.id = version.report_id
       where version.id = resolution_row.winning_report_version_id;
      select version.version_ref into report_version_ref
        from public.case_report_versions as version
       where version.id = resolution_row.winning_report_version_id;
      has_blocker := exists (
        select 1
          from public.challenges_v2 as challenge
         where challenge.resolution_id = resolution_row.id
           and challenge.state in ('open', 'under_review')
      );
      lifecycle_ready := resolution_row.state = 'in_challenge_window'
        and resolution_row.challenge_window_ends_at <= statement_timestamp()
        and not has_blocker;

      case_id := target.id;
      case_public_ref := target.public_ref;
      action := 'seal_finalize';
      target_public_ref := resolution_row.public_ref;
      standard_quorum_ready := seal_quorum.ready is true;
      can_finalize_via_standard_quorum := writes_enabled
        and full_maintainer
        and lifecycle_ready
        and standard_quorum_ready;
      bootstrap_enabled := bootstrap.enabled is true;
      bootstrap_active := bootstrap.active is true;
      bootstrap_tier := bootstrap.tier;
      eligible_analyst_count := bootstrap.eligible_analyst_count;
      bootstrap_required_analyst_count := bootstrap.required_analyst_count;
      bootstrap_required_analyst_weight := bootstrap.required_analyst_weight;
      bootstrap_actual_support_count := coalesce(seal_quorum.approve_count, 0);
      bootstrap_actual_support_weight := coalesce(seal_quorum.approve_weight, 0);
      bootstrap_actor_conflicted := target.submitted_by_wallet = p_actor_wallet
        or selected_author = p_actor_wallet
        or exists (
          select 1
            from public.resolution_reviews as review
           where review.resolution_id = resolution_row.id
             and review.reviewer_wallet = p_actor_wallet
             and review.is_active is true
        );
      bootstrap_can_finalize := writes_enabled
        and full_maintainer
        and lifecycle_ready
        and seal_quorum.ready is distinct from true
        and bootstrap.active is true
        and bootstrap_actor_conflicted is false
        and bootstrap_actual_support_count >= bootstrap.required_analyst_count
        and bootstrap_actual_support_weight >= bootstrap.required_analyst_weight;
      bootstrap_reason_code := case
        when not writes_enabled then 'governance_writes_disabled'
        when not full_maintainer then 'full_maintainer_gate_required'
        when not lifecycle_ready and has_blocker then 'blocking_challenge_active'
        when not lifecycle_ready then 'challenge_window_not_ended'
        when standard_quorum_ready then 'standard_quorum_ready'
        when bootstrap.enabled is distinct from true then 'bootstrap_disabled'
        when bootstrap.active is distinct from true then 'bootstrap_retired'
        when bootstrap_actor_conflicted then 'actor_conflict'
        when bootstrap_actual_support_count < bootstrap.required_analyst_count
          then 'bootstrap_support_count_required'
        when bootstrap_actual_support_weight < bootstrap.required_analyst_weight
          then 'bootstrap_support_weight_required'
        else 'ready'
      end;
      return next;
    end if;
  end loop;
end;
$$;

comment on function osi_private.osi_v2_governance_finalize_capabilities(text, uuid[], text) is
  'Service-only, side-effect-free target capability projection for standard Resolution/seal quorum and the distinct D17 maintainer-bootstrap channel. Mirrors the effective write gate without client threshold arithmetic.';

create function public.osi_v2_governance_finalize_capabilities(
  p_actor_wallet text,
  p_case_ids uuid[],
  p_maintainer_auth_uuid text default null
)
returns table (
  case_id uuid,
  case_public_ref text,
  action text,
  target_public_ref text,
  report_version_ref text,
  standard_quorum_ready boolean,
  can_finalize_via_standard_quorum boolean,
  bootstrap_enabled boolean,
  bootstrap_active boolean,
  bootstrap_tier text,
  eligible_analyst_count integer,
  bootstrap_required_analyst_count integer,
  bootstrap_required_analyst_weight numeric,
  bootstrap_actual_support_count integer,
  bootstrap_actual_support_weight numeric,
  bootstrap_actor_conflicted boolean,
  bootstrap_can_finalize boolean,
  bootstrap_reason_code text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
    from osi_private.osi_v2_governance_finalize_capabilities(
      p_actor_wallet,
      p_case_ids,
      p_maintainer_auth_uuid
    )
$$;

comment on function public.osi_v2_governance_finalize_capabilities(text, uuid[], text) is
  'Service-role-only PostgREST wrapper for target-specific Resolution and seal finalization capabilities.';

revoke all privileges on function
  osi_private.osi_v2_governance_finalize_capabilities(text, uuid[], text)
  from public, anon, authenticated;
revoke all privileges on function
  public.osi_v2_governance_finalize_capabilities(text, uuid[], text)
  from public, anon, authenticated;
grant execute on function
  osi_private.osi_v2_governance_finalize_capabilities(text, uuid[], text)
  to service_role;
grant execute on function
  public.osi_v2_governance_finalize_capabilities(text, uuid[], text)
  to service_role;

commit;
