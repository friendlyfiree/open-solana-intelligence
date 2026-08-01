-- OSI V2 workflow recovery: optional Report evidence and canonical,
-- side-effect-free Report review/publication capabilities.
--
-- This migration is additive. It does not enable any feature flag, mutate a
-- domain row, or weaken Stage-5 proof, replay, double-maintainer, conflict, SAS,
-- quorum, or publication requirements.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. A Case Report may carry zero structured evidence references. The exact
--    empty manifest is the canonical JSON array [] and therefore receives the
--    deterministic SHA-256 already produced by osi_v2_report_manifest_hash().
--    Non-empty references retain every existing validation and the limit of 12.
-- ---------------------------------------------------------------------------
create or replace function osi_private.osi_v2_report_evidence_manifest(
  p_evidence jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  manifest jsonb;
begin
  if p_evidence is null
     or jsonb_typeof(p_evidence) <> 'array'
     or jsonb_array_length(p_evidence) > 12 then
    raise exception 'Report evidence must contain between 0 and 12 references'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_evidence) as item(value)
    where jsonb_typeof(item.value) <> 'object'
       or item.value->>'kind' not in ('onchain_tx', 'wallet', 'url')
       or nullif(btrim(item.value->>'ref'), '') is null
       or item.value->>'ref' is distinct from btrim(item.value->>'ref')
       or item.value->>'sha256' !~ '^[0-9a-f]{64}$'
       or item.value->>'sha256' is distinct from encode(
         extensions.digest(
           pg_catalog.convert_to(item.value->>'ref', 'UTF8'),
           'sha256'
         ),
         'hex'
       )
       or (item.value->>'kind' = 'url' and item.value->>'ref' !~ '^https://')
       or (
         item.value->>'kind' = 'wallet'
         and (
           char_length(item.value->>'ref') not between 32 and 44
           or item.value->>'ref' !~ '^[1-9A-HJ-NP-Za-km-z]+$'
         )
       )
       or (
         item.value->>'kind' = 'onchain_tx'
         and (
           char_length(item.value->>'ref') not between 64 and 88
           or item.value->>'ref' !~ '^[1-9A-HJ-NP-Za-km-z]+$'
         )
       )
  ) then
    raise exception 'Report evidence contains an unsupported or malformed reference'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_evidence) as item(value)
    group by item.value->>'kind', item.value->>'ref'
    having count(*) > 1
  ) then
    raise exception 'Report evidence references must be unique within a version'
      using errcode = '23514';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'ordinal', item.ordinality,
        'kind', item.value->>'kind',
        'ref', item.value->>'ref',
        'sha256', item.value->>'sha256'
      )
      order by item.ordinality
    ),
    '[]'::jsonb
  )
  into manifest
  from jsonb_array_elements(p_evidence) with ordinality as item(value, ordinality);

  return manifest;
end
$$;

comment on function osi_private.osi_v2_report_evidence_manifest(jsonb) is
  'Canonical ordered Case Report evidence manifest. Accepts 0-12 validated references; empty input returns exact [] and never invents a placeholder.';

-- ---------------------------------------------------------------------------
-- 2. One canonical, read-only capability projection for Report queue and write
--    preflight surfaces. It delegates counted quorum to
--    osi_private.osi_v2_report_quorum(), so SAS enforcement, exact-version
--    receipts, analyst eligibility snapshots, count gates and weight gates stay
--    identical to the write transaction. It issues no nonce and writes no row.
-- ---------------------------------------------------------------------------
create function osi_private.osi_v2_report_publication_capabilities(
  p_actor_wallet text,
  p_version_ids uuid[],
  p_maintainer_auth_uuid text default null
)
returns table (
  version_id uuid,
  version_public_ref text,
  case_public_ref text,
  report_public_ref text,
  lifecycle_state text,
  risk_tier text,
  actor_is_eligible_analyst boolean,
  actor_is_full_maintainer boolean,
  can_cast_analyst_review boolean,
  analyst_review_reason_code text,
  can_publish_via_standard_quorum boolean,
  standard_publication_reason_code text,
  can_publish_via_maintainer_bootstrap boolean,
  maintainer_bootstrap_reason_code text,
  decision_channel text,
  standard_quorum_ready boolean,
  approve_count integer,
  approve_weight numeric,
  reject_count integer,
  reject_weight numeric,
  required_count integer,
  required_weight numeric,
  sas_enforcement_enabled boolean,
  bootstrap_enabled boolean,
  bootstrap_active boolean,
  bootstrap_tier text,
  eligible_analyst_count integer,
  bootstrap_required_analyst_count integer,
  bootstrap_required_analyst_weight numeric
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
  bootstrap record;
  review_writes_enabled boolean;
  eligible_analyst boolean;
  full_maintainer boolean;
  sas_enforcing boolean;
  target_available boolean;
  report_author_conflict boolean;
  case_owner_conflict boolean;
  has_active_review boolean;
  has_active_approve boolean;
  review_allowed boolean;
  standard_allowed boolean;
  bootstrap_allowed boolean;
  review_reason text;
  standard_reason text;
  bootstrap_reason text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Report capability projection is service-only'
      using errcode = '42501';
  end if;
  if p_actor_wallet is null
     or char_length(p_actor_wallet) not between 32 and 44
     or p_actor_wallet !~ '^[1-9A-HJ-NP-Za-km-z]+$' then
    raise exception 'Report capability actor wallet is invalid'
      using errcode = '22023';
  end if;
  if p_version_ids is null
     or coalesce(array_length(p_version_ids, 1), 0) = 0
     or array_length(p_version_ids, 1) > 1000 then
    raise exception 'Report capability target list is invalid'
      using errcode = '22023';
  end if;

  select array_agg(distinct requested.id order by requested.id)
    into requested_ids
    from unnest(p_version_ids) as requested(id)
   where requested.id is not null;
  if requested_ids is null then
    raise exception 'Report capability target list is invalid'
      using errcode = '22023';
  end if;

  review_writes_enabled :=
    osi_private.osi_v2_report_review_writes_enabled() is true;
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
  select * into bootstrap from osi_private.osi_v2_bootstrap_tier();

  for target in
    select
      version.id as version_id,
      version.version_ref as version_public_ref,
      version.lifecycle_state,
      report.id as report_id,
      report.public_ref as report_public_ref,
      report.current_version_id,
      report.author_wallet,
      report.native_intake,
      case_item.public_ref as case_public_ref,
      case_item.submitted_by_wallet,
      case_item.visibility,
      case_item.stage,
      case_item.risk_tier
    from public.case_report_versions as version
    join public.case_reports as report on report.id = version.report_id
    join public.cases as case_item on case_item.id = report.case_id
    where version.id = any(requested_ids)
    order by version.id
  loop
    -- This is the same SAS-aware quorum function used by publication prepare
    -- and commit. A credential-enforcement failure therefore contributes zero
    -- here exactly as it does in the write path.
    select * into quorum
      from osi_private.osi_v2_report_quorum(target.version_id);

    target_available :=
      target.native_intake is true
      and target.current_version_id is not distinct from target.version_id
      and target.lifecycle_state in ('submitted', 'in_review')
      and target.visibility = 'public'
      and target.stage in ('open_public', 'in_review', 'reopened');
    report_author_conflict := p_actor_wallet = target.author_wallet;
    case_owner_conflict := p_actor_wallet = target.submitted_by_wallet;
    select exists (
      select 1
        from public.case_report_reviews as review
       where review.report_version_id = target.version_id
         and review.reviewer_wallet = p_actor_wallet
         and review.is_active is true
    ) into has_active_review;
    select exists (
      select 1
        from public.case_report_reviews as review
       where review.report_version_id = target.version_id
         and review.reviewer_wallet = p_actor_wallet
         and review.is_active is true
         and review.decision = 'approve'
    ) into has_active_approve;

    review_allowed :=
      review_writes_enabled
      and target_available
      and eligible_analyst
      and not report_author_conflict
      and not case_owner_conflict;
    review_reason := case
      when not review_writes_enabled then 'report_review_writes_disabled'
      when not target_available then 'report_version_not_awaiting_review'
      when report_author_conflict then 'report_author_conflict'
      when case_owner_conflict then 'case_owner_conflict'
      when not eligible_analyst then 'analyst_not_eligible'
      else null
    end;

    standard_allowed :=
      review_writes_enabled
      and target_available
      and eligible_analyst
      and not report_author_conflict
      and not case_owner_conflict
      and has_active_approve
      and quorum.approve_ready is true;
    standard_reason := case
      when not review_writes_enabled then 'report_review_writes_disabled'
      when not target_available then 'report_version_not_awaiting_review'
      when report_author_conflict then 'report_author_conflict'
      when case_owner_conflict then 'case_owner_conflict'
      when not eligible_analyst then 'analyst_not_eligible'
      when not has_active_approve then 'active_approve_review_required'
      when quorum.approve_ready is distinct from true then 'analyst_quorum_not_ready'
      else null
    end;

    bootstrap_allowed :=
      review_writes_enabled
      and target_available
      and full_maintainer
      and bootstrap.active is true
      and not report_author_conflict
      and not case_owner_conflict
      and not has_active_review
      and quorum.approve_ready is distinct from true
      and quorum.approve_count >= bootstrap.required_analyst_count
      and quorum.approve_weight >= bootstrap.required_analyst_weight;
    bootstrap_reason := case
      when not review_writes_enabled then 'report_review_writes_disabled'
      when not target_available then 'report_version_not_awaiting_review'
      when not full_maintainer then 'maintainer_double_gate_required'
      when bootstrap.enabled is distinct from true then 'maintainer_bootstrap_disabled'
      when bootstrap.active is distinct from true then 'maintainer_bootstrap_unavailable'
      when report_author_conflict then 'report_author_conflict'
      when case_owner_conflict then 'case_owner_conflict'
      when has_active_review then 'maintainer_already_counted_reviewer'
      when quorum.approve_ready is true then 'standard_analyst_quorum_available'
      when quorum.approve_count < bootstrap.required_analyst_count
        or quorum.approve_weight < bootstrap.required_analyst_weight
        then 'bootstrap_support_not_met'
      else null
    end;

    return query select
      target.version_id::uuid,
      target.version_public_ref::text,
      target.case_public_ref::text,
      target.report_public_ref::text,
      target.lifecycle_state::text,
      quorum.risk_tier::text,
      eligible_analyst,
      full_maintainer,
      review_allowed,
      review_reason,
      standard_allowed,
      standard_reason,
      bootstrap_allowed,
      bootstrap_reason,
      case
        when bootstrap_allowed then 'maintainer_bootstrap'::text
        when standard_allowed then 'standard'::text
        else null::text
      end,
      quorum.approve_ready is true,
      quorum.approve_count::integer,
      quorum.approve_weight::numeric,
      quorum.reject_count::integer,
      quorum.reject_weight::numeric,
      quorum.required_count::integer,
      quorum.required_weight::numeric,
      sas_enforcing,
      bootstrap.enabled is true,
      bootstrap.active is true,
      bootstrap.tier::text,
      bootstrap.eligible_analyst_count::integer,
      bootstrap.required_analyst_count::integer,
      bootstrap.required_analyst_weight::numeric;
  end loop;
end
$$;

comment on function osi_private.osi_v2_report_publication_capabilities(
  text, uuid[], text
) is
  'Service-only, side-effect-free exact Report capability projection. Analyst review and maintainer_bootstrap are independent; counted quorum is delegated to the SAS-aware canonical Report quorum.';

create function public.osi_v2_report_publication_capabilities(
  p_actor_wallet text,
  p_version_ids uuid[],
  p_maintainer_auth_uuid text default null
)
returns table (
  version_id uuid,
  version_public_ref text,
  case_public_ref text,
  report_public_ref text,
  lifecycle_state text,
  risk_tier text,
  actor_is_eligible_analyst boolean,
  actor_is_full_maintainer boolean,
  can_cast_analyst_review boolean,
  analyst_review_reason_code text,
  can_publish_via_standard_quorum boolean,
  standard_publication_reason_code text,
  can_publish_via_maintainer_bootstrap boolean,
  maintainer_bootstrap_reason_code text,
  decision_channel text,
  standard_quorum_ready boolean,
  approve_count integer,
  approve_weight numeric,
  reject_count integer,
  reject_weight numeric,
  required_count integer,
  required_weight numeric,
  sas_enforcement_enabled boolean,
  bootstrap_enabled boolean,
  bootstrap_active boolean,
  bootstrap_tier text,
  eligible_analyst_count integer,
  bootstrap_required_analyst_count integer,
  bootstrap_required_analyst_weight numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
    from osi_private.osi_v2_report_publication_capabilities(
      p_actor_wallet,
      p_version_ids,
      p_maintainer_auth_uuid
    )
$$;

comment on function public.osi_v2_report_publication_capabilities(
  text, uuid[], text
) is
  'Service-role-only PostgREST wrapper for the exact side-effect-free Report capability projection.';

revoke all privileges on function osi_private.osi_v2_report_evidence_manifest(jsonb)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_report_publication_capabilities(
  text, uuid[], text
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_report_publication_capabilities(
  text, uuid[], text
) from public, anon, authenticated;

grant execute on function osi_private.osi_v2_report_evidence_manifest(jsonb)
  to service_role;
grant execute on function osi_private.osi_v2_report_publication_capabilities(
  text, uuid[], text
) to service_role;
grant execute on function public.osi_v2_report_publication_capabilities(
  text, uuid[], text
) to service_role;

commit;
