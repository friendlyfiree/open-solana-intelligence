-- OSI V2 — D19 Step 4: make the SAS credential load-bearing in governance.
--
-- Phase 1 (20260716120000_osi_v2_sas_credential.sql) built the scaffolding: the
-- per-wallet cache, the per-review snapshot table, the recorder helpers and the
-- guarded predicate osi_private.osi_v2_sas_review_counts(), which every live
-- quorum/weight computation already calls. What was missing is everything that
-- makes enforcement real once the flag is turned on:
--
--   1. the predicate counted any snapshot recorded 'verified', even one taken
--      under a credential/schema/issuer OSI no longer publishes, and even while
--      SAS itself was unconfigured;
--   2. osi_private.osi_v2_bootstrap_selection_support() counts analyst
--      selection reviews toward the D17 bootstrap threshold and was never
--      gated, so ungated analyst weight could still reach a bootstrap
--      resolution outcome;
--   3. the transaction-local osi_v2.sas_bypass hook was global, so anything
--      that ever set it would also neutralize the gate for challenge verdicts
--      and AI Pack approval;
--   4. a snapshot left 'pending_verification' by an RPC failure at cast time
--      had no recovery path, and nothing could ever re-check it;
--   5. nothing could tell a reader whether a given review's authority was
--      SAS-verified on chain or excluded for want of a credential.
--
-- SAFETY-CRITICAL INVARIANT, UNCHANGED: with
-- OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED false (still the shipped default,
-- and this migration does not change it) every predicate below short-circuits
-- to TRUE and every new helper returns zero rows before touching any SAS table,
-- so all quorum results stay identical to current main regardless of any
-- wallet's credential state.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Currently published credential coordinates. A snapshot is authoritative
--    only for the exact credential, schema and issuer OSI publishes right now;
--    a snapshot taken under retired coordinates is stale authority, never a
--    substitute for a fresh on-chain answer.
-- ---------------------------------------------------------------------------
create function osi_private.osi_v2_sas_expected()
returns table (credential text, schema text, issuer text)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    nullif((select value from public.osi_config where key = 'OSI_V2_SAS_CREDENTIAL_PUBKEY'), ''),
    nullif((select value from public.osi_config where key = 'OSI_V2_SAS_SCHEMA_PUBKEY'), ''),
    nullif((select value from public.osi_config where key = 'OSI_V2_SAS_ISSUER_PUBKEY'), '')
$$;

comment on function osi_private.osi_v2_sas_expected() is
  'D19 currently published SAS credential/schema/issuer. A per-review snapshot counts only when it was taken under exactly these coordinates.';

-- ---------------------------------------------------------------------------
-- 2. Hardened counting predicate. Same signature, same flag-off tautology, and
--    strictly stronger whenever enforcement is on:
--      * SAS must be fully configured (absent coordinates cannot verify
--        anything, so nothing counts);
--      * the snapshot must be 'verified';
--      * the snapshot must be bound to the currently published coordinates.
--    The bootstrap bypass is narrowed to the review kinds the D17 cold-start
--    channel actually decides. It can never reach a challenge verdict or AI
--    Pack approval, in either flag state.
-- ---------------------------------------------------------------------------
create or replace function osi_private.osi_v2_sas_review_counts(
  p_review_kind text,
  p_review_id uuid
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  expected record;
begin
  -- Fail-open BEFORE touching any SAS table when enforcement is off, so quorum
  -- results are identical to main and no read of the new tables is planned.
  if not osi_private.osi_v2_sas_enforcement_enabled() then
    return true;
  end if;
  -- Transaction-local bypass for the D17 maintainer_bootstrap channel, limited
  -- to the review kinds that channel actually decides. 'challenge' and
  -- 'ai_pack' are deliberately absent: bootstrap is maintainer cold-start
  -- authority for opening, publishing and selecting, and must never reach a
  -- challenge verdict or AI Pack approval as a side effect.
  if coalesce(current_setting('osi_v2.sas_bypass', true), '') = 'on'
     and p_review_kind in ('case_initial', 'case_report', 'resolution', 'wire_report') then
    return true;
  end if;
  if p_review_id is null then
    return false;
  end if;
  select * into expected from osi_private.osi_v2_sas_expected();
  -- Unconfigured SAS cannot verify anyone: withhold weight rather than invent it.
  if expected.credential is null or expected.schema is null or expected.issuer is null then
    return false;
  end if;
  return exists (
    select 1
    from public.osi_v2_sas_review_verifications as v
    where v.review_kind = p_review_kind
      and v.review_id = p_review_id
      and v.verification_state = 'verified'
      and v.checked_credential = expected.credential
      and v.checked_schema = expected.schema
      and v.checked_issuer = expected.issuer
  );
end
$$;

comment on function osi_private.osi_v2_sas_review_counts(text, uuid) is
  'D19 counting predicate. TRUE unconditionally when enforcement is off. When on, a review counts only if its snapshot is verified under the currently published SAS credential, schema and issuer. Bootstrap bypass never applies to challenge or ai_pack.';

-- ---------------------------------------------------------------------------
-- 3. Snapshot recorder: keep resolved snapshots immutable under the coordinates
--    they were taken with, but allow a fresh live result to replace a snapshot
--    whose coordinates are no longer the published ones. Without this a
--    credential rotation would leave every historic snapshot permanently
--    uncountable and unrepairable, and a pending_verification snapshot left by
--    an RPC failure could never be resolved.
-- ---------------------------------------------------------------------------
create or replace function osi_private.osi_v2_sas_record_review_verification(
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
  existing record;
  expected record;
  bound_to_current boolean;
begin
  if p_review_kind not in (
    'case_initial', 'case_report', 'resolution', 'challenge', 'wire_report', 'ai_pack'
  ) then
    raise exception 'Unknown review kind %', p_review_kind using errcode = '22023';
  end if;

  select v.verification_state, v.checked_credential, v.checked_schema, v.checked_issuer
    into existing
    from public.osi_v2_sas_review_verifications as v
   where v.review_kind = p_review_kind
     and v.review_id = p_review_id;

  if existing.verification_state is not null then
    select * into expected from osi_private.osi_v2_sas_expected();
    bound_to_current :=
      expected.credential is not null
      and existing.checked_credential is not distinct from expected.credential
      and existing.checked_schema is not distinct from expected.schema
      and existing.checked_issuer is not distinct from expected.issuer;
    -- A resolved snapshot taken under the currently published coordinates is
    -- immutable history and never changes retroactively.
    if existing.verification_state in ('verified', 'invalid', 'revoked', 'expired')
       and bound_to_current then
      return existing.verification_state;
    end if;
    update public.osi_v2_sas_review_verifications as v set
      verification_state = p_state,
      reviewer_wallet = p_wallet,
      checked_credential = p_credential,
      checked_schema = p_schema,
      checked_issuer = p_issuer,
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

comment on function osi_private.osi_v2_sas_record_review_verification(
  text, uuid, text, text, text, text, text, integer, text, text) is
  'D19 per-review snapshot recorder. A resolved snapshot bound to the currently published SAS coordinates is immutable. An unresolved snapshot, or one bound to retired coordinates, may be replaced by a fresh live result.';

-- ---------------------------------------------------------------------------
-- 4. Gate the D17 bootstrap selection support tally. It counts analyst
--    selection reviews toward the reduced bootstrap threshold, so leaving it
--    ungated would let an analyst with no live credential still push a
--    bootstrap resolution outcome. Body is otherwise unchanged.
-- ---------------------------------------------------------------------------
create or replace function osi_private.osi_v2_bootstrap_selection_support(
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
     and review.reviewer_wallet <> p_maintainer_wallet
     and osi_private.osi_v2_sas_review_counts('resolution', review.id);
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

-- ---------------------------------------------------------------------------
-- 5. Lazy re-check worklist. Given a governance target, return the analyst
--    reviews whose SAS snapshot cannot currently count, so the trusted server
--    layer can perform one bounded live on-chain check per distinct wallet
--    before a quorum-dependent transition is computed.
--
--    Returns ZERO rows whenever enforcement is off, so the flag-off path stays
--    a provable no-op even if a caller forgets to check the flag first.
--    Maintainer rows on a Case are never listed: the D5/D17 maintainer channel
--    carries weight zero and is not subject to the analyst credential gate.
-- ---------------------------------------------------------------------------
create function osi_private.osi_v2_sas_reviews_needing_recheck(
  p_target_type text,
  p_target_id uuid,
  p_limit integer default 200
)
returns table (review_kind text, review_id uuid, reviewer_wallet text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  bounded integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  expected record;
begin
  if not osi_private.osi_v2_sas_enforcement_enabled() then
    return;
  end if;
  if p_target_id is null then
    return;
  end if;
  select * into expected from osi_private.osi_v2_sas_expected();

  -- Column aliases below deliberately avoid the OUT parameter names so no
  -- reference in this query can be ambiguous.
  return query
  with candidates as (
    select 'case_initial'::text as kind, r.id as rid, r.reviewer_wallet as wallet
      from public.case_initial_reviews as r
     where p_target_type = 'case'
       and r.case_id = p_target_id
       and r.is_active = true
       and r.reviewer_role = 'analyst'
    union all
    select 'case_report', r.id, r.reviewer_wallet
      from public.case_report_reviews as r
     where p_target_type = 'report_version'
       and r.report_version_id = p_target_id
       and r.is_active = true
    union all
    select 'resolution', r.id, r.reviewer_wallet
      from public.resolution_reviews as r
     where p_target_type = 'resolution'
       and r.resolution_id = p_target_id
       and r.is_active = true
    union all
    select 'challenge', r.id, r.reviewer_wallet
      from public.challenge_reviews as r
     where p_target_type = 'challenge'
       and r.challenge_id = p_target_id
       and r.is_active = true
    union all
    select 'wire_report', r.id, r.reviewer_wallet
      from public.wire_report_reviews as r
     where p_target_type = 'wire_version'
       and r.wire_report_version_id = p_target_id
       and r.is_active = true
    union all
    select 'ai_pack', r.id, r.reviewer_wallet
      from public.ai_pack_reviews as r
     where p_target_type = 'pack_version'
       and r.pack_version_id = p_target_id
       and r.is_active = true
  )
  select candidate.kind, candidate.rid, candidate.wallet
    from candidates as candidate
    left join public.osi_v2_sas_review_verifications as v
      on v.review_kind = candidate.kind
     and v.review_id = candidate.rid
   where v.review_id is null
      or v.verification_state in ('unchecked', 'pending_verification')
      or expected.credential is null
      or v.checked_credential is distinct from expected.credential
      or v.checked_schema is distinct from expected.schema
      or v.checked_issuer is distinct from expected.issuer
   order by candidate.wallet, candidate.rid
   limit bounded;
end
$$;

comment on function osi_private.osi_v2_sas_reviews_needing_recheck(text, uuid, integer) is
  'D19 lazy re-check worklist: active analyst reviews on one governance target whose SAS snapshot is absent, unresolved, or bound to retired credential coordinates. Empty whenever enforcement is off.';

-- ---------------------------------------------------------------------------
-- 6. Honest authority projection for the surfaces that show a decision weight.
--    Answers, per review: is enforcement on, did this review count toward
--    quorum and weight, and what state its snapshot is in. Keyed by review id
--    because case_initial_reviews has no public_ref column. The projection
--    carries no wallet, signature, nonce, payload hash, private note, rationale
--    or internal error detail; callers map the answer back onto rows they are
--    already authorized to render.
-- ---------------------------------------------------------------------------
create function osi_private.osi_v2_sas_review_authority(
  p_review_kind text,
  p_review_ids uuid[]
)
returns table (
  review_id uuid,
  enforcement_enabled boolean,
  counted boolean,
  verification_state text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  enforcing boolean := osi_private.osi_v2_sas_enforcement_enabled();
  ids uuid[];
begin
  -- Bounded, validated input: at most 400 review ids per call.
  if p_review_ids is null or array_length(p_review_ids, 1) is null
     or array_length(p_review_ids, 1) > 400 then
    return;
  end if;
  if p_review_kind not in (
    'case_initial', 'case_report', 'resolution', 'challenge', 'wire_report', 'ai_pack'
  ) then
    return;
  end if;
  select array_agg(distinct requested.rid) into ids
    from unnest(p_review_ids) as requested(rid)
   where requested.rid is not null;
  if ids is null then
    return;
  end if;

  -- The alias below deliberately avoids the OUT parameter names.
  return query
  select
    requested.rid,
    enforcing,
    osi_private.osi_v2_sas_review_counts(p_review_kind, requested.rid),
    case
      when not enforcing then 'not_enforced'
      else coalesce((
        select v.verification_state
          from public.osi_v2_sas_review_verifications as v
         where v.review_kind = p_review_kind and v.review_id = requested.rid
      ), 'unchecked')
    end
  from unnest(ids) as requested(rid);
end
$$;

comment on function osi_private.osi_v2_sas_review_authority(text, uuid[]) is
  'D19 public-safe per-review authority projection for weight surfaces. Returns only enforcement state, whether the review counted, and the snapshot state. No wallet, signature, nonce, payload hash, note or error detail.';

-- ---------------------------------------------------------------------------
-- 7. Service-role-only public wrappers for the Edge layer.
-- ---------------------------------------------------------------------------
create function public.osi_v2_sas_reviews_needing_recheck(
  p_target_type text,
  p_target_id uuid,
  p_limit integer default 200
)
returns table (review_kind text, review_id uuid, reviewer_wallet text)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_sas_reviews_needing_recheck(p_target_type, p_target_id, p_limit)
$$;

create function public.osi_v2_sas_review_authority(
  p_review_kind text,
  p_review_ids uuid[]
)
returns table (
  review_id uuid,
  enforcement_enabled boolean,
  counted boolean,
  verification_state text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_sas_review_authority(p_review_kind, p_review_ids)
$$;

-- ---------------------------------------------------------------------------
-- 8. Least-privilege grants for every SAS helper, including the ones replaced
--    above (CREATE OR REPLACE preserves grants, but re-running this keeps the
--    whole family consistent and service-role only).
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

-- OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED is deliberately NOT written here.
-- It stays exactly as production has it (false). Only the guarded
-- osi-v2-sas-enforcement-production.yml workflow, dispatched by a human with a
-- typed confirmation, may flip it.

commit;
