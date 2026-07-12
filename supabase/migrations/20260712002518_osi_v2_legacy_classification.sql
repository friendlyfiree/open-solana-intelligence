-- OSI V2 rollout step 5: read-only legacy migration classification.
--
-- Adds a private, service-only, idempotent classifier that READS the legacy V1
-- tables and WRITES ONLY to the two infrastructure tables
-- `migration_crosswalk` and `migration_manual_queue`. It never writes to any V2
-- domain table, never enables or requires OSI_V2_WRITES_ENABLED /
-- OSI_V2_PROOF_ENABLED, and never invents a mapping.
--
-- The functions live in the private `osi_private` schema (service-only) and are
-- additionally guarded by a current_user check. Every legacy read is guarded by
-- to_regclass and performed through to_jsonb(row), so:
--   * the migration is pure DDL and applies cleanly even where no V1 table
--     exists (fresh local/CI database) -- the classifier is then a safe no-op;
--   * unknown/variant legacy columns can never break the classifier;
--   * wallet-keyed legacy rows are identified by a stable non-reversible
--     surrogate (md5), so no wallet value is ever copied into the crosswalk,
--     the manual queue, a log, a preview result, or test output.
--
-- Idempotency uses primary-keyed TEMP snapshots plus INSERT ... ON CONFLICT DO
-- NOTHING; the classifier performs no DROP, TRUNCATE, or DELETE. Session-scoped
-- TEMP tables use ON COMMIT DROP. check_function_bodies is disabled for this
-- transaction only, because the functions reference TEMP tables (created at run
-- time) and optional V1 tables that do not exist when the functions are created.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local check_function_bodies = off;

-- Normalize a free-text label (bounty title / report parent) to a match key.
create function osi_private.osi_v2_norm_label(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    regexp_replace(lower(btrim(coalesce(p_text, ''))), '[^a-z0-9]+', '', 'g'),
    ''
  )
$$;

-- Build read-only, privacy-minimized TEMP snapshots of the legacy tables.
-- Guarded by to_regclass; reads use to_jsonb(row) so absent tables and unknown
-- columns are handled safely. Primary keys + ON CONFLICT DO NOTHING make repeat
-- calls within one transaction a no-op (no drop/truncate needed). Wallet-keyed
-- rows are stored only under a non-reversible surrogate id.
create function osi_private.osi_v2_build_legacy_snapshot()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  anc text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Legacy classification is service-only' using errcode = '42501';
  end if;

  create temp table if not exists _osi_snap_bounties (
    legacy_id text primary key, name_norm text, detail_len int, reward numeric
  ) on commit drop;
  if to_regclass('public.bounties') is not null then
    execute $q$
      insert into pg_temp._osi_snap_bounties (legacy_id, name_norm, detail_len, reward)
      select coalesce(j->>'id', md5(j::text)),
             osi_private.osi_v2_norm_label(coalesce(j->>'title', j->>'target', j->>'company')),
             char_length(btrim(coalesce(j->>'detail', ''))),
             case when coalesce(j->>'reward_sol', '') ~ '^[0-9]+(\.[0-9]+)?$'
                  then (j->>'reward_sol')::numeric else 0 end
      from (select to_jsonb(t) j from public.bounties t) s
      on conflict (legacy_id) do nothing
    $q$;
  end if;

  create temp table if not exists _osi_snap_reports (
    legacy_id text primary key, bounty_norm text
  ) on commit drop;
  if to_regclass('public.reports') is not null then
    execute $q$
      insert into pg_temp._osi_snap_reports (legacy_id, bounty_norm)
      select coalesce(j->>'id', md5(j::text)),
             osi_private.osi_v2_norm_label(j->>'bounty')
      from (select to_jsonb(t) j from public.reports t) s
      on conflict (legacy_id) do nothing
    $q$;
  end if;

  create temp table if not exists _osi_snap_packs (
    legacy_id text primary key, report_ref text
  ) on commit drop;
  if to_regclass('public.escalation_packs') is not null then
    execute $q$
      insert into pg_temp._osi_snap_packs (legacy_id, report_ref)
      select coalesce(j->>'id', md5(j::text)), j->>'case_ref'
      from (select to_jsonb(t) j from public.escalation_packs t) s
      on conflict (legacy_id) do nothing
    $q$;
  end if;

  create temp table if not exists _osi_snap_events (
    legacy_id text primary key, item_type text, item_id text
  ) on commit drop;
  if to_regclass('public.onchain_events') is not null then
    execute $q$
      insert into pg_temp._osi_snap_events (legacy_id, item_type, item_id)
      select coalesce(j->>'id', md5(j::text)),
             lower(coalesce(j->>'item_type', '')),
             j->>'item_id'
      from (select to_jsonb(t) j from public.onchain_events t) s
      on conflict (legacy_id) do nothing
    $q$;
  end if;

  create temp table if not exists _osi_snap_analysts (
    legacy_id text primary key, verified boolean, approved boolean
  ) on commit drop;
  if to_regclass('public.analysts') is not null then
    -- wallet is the natural key; store only a non-reversible surrogate.
    execute $q$
      insert into pg_temp._osi_snap_analysts (legacy_id, verified, approved)
      select md5('osi2:analysts:' || coalesce(j->>'wallet', j::text)),
             coalesce(nullif(j->>'verified', '')::boolean, false),
             coalesce(nullif(j->>'approved', '')::boolean, false)
      from (select to_jsonb(t) j from public.analysts t) s
      on conflict (legacy_id) do nothing
    $q$;
  end if;

  -- Ancillary tables have no unambiguous V2 domain target and may contain wallet
  -- values; each row is accounted for under a hashed surrogate id, never guessed.
  create temp table if not exists _osi_snap_ancillary (
    legacy_table text, legacy_id text, primary key (legacy_table, legacy_id)
  ) on commit drop;
  foreach anc in array
    array['profiles', 'requests', 'request_votes', 'bounty_boosts', 'vouches', 'challenges']
  loop
    if to_regclass('public.' || anc) is not null then
      execute format($q$
        insert into pg_temp._osi_snap_ancillary (legacy_table, legacy_id)
        select %L, md5(%L || ':' || (to_jsonb(t))::text)
        from public.%I t
        on conflict (legacy_table, legacy_id) do nothing
      $q$, anc, anc, anc);
    end if;
  end loop;
end
$$;

-- Single source of classification truth. Returns one row per intended decision.
-- kind = 'crosswalk' (with entity_kind/v2_table/confidence/classification_reason)
--        or 'queue'   (with candidate_kinds/reason_code). Pure; no persistent write.
create function osi_private.osi_v2_legacy_decisions()
returns table (
  kind text, entity_kind text, legacy_table text, legacy_id text, v2_table text,
  confidence text, classification_reason text, candidate_kinds text[], reason_code text
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Legacy classification is service-only' using errcode = '42501';
  end if;

  perform osi_private.osi_v2_build_legacy_snapshot();

  return query
  with
    b as (select s.legacy_id, s.name_norm, s.detail_len, s.reward
          from pg_temp._osi_snap_bounties s),
    rp as (select s.legacy_id, s.bounty_norm from pg_temp._osi_snap_reports s),
    pk as (select s.legacy_id, s.report_ref from pg_temp._osi_snap_packs s),
    ev as (select s.legacy_id, s.item_type, s.item_id from pg_temp._osi_snap_events s),
    an as (select s.legacy_id, s.verified, s.approved from pg_temp._osi_snap_analysts s),
    anc as (select s.legacy_table, s.legacy_id from pg_temp._osi_snap_ancillary s),
    rm as (
      select r.legacy_id,
             (r.bounty_norm is null) as is_standalone,
             case when r.bounty_norm is null then 0
                  else (select count(*) from b where b.name_norm = r.bounty_norm) end as match_count
      from rp r
    ),
    report_unique as (select m.legacy_id from rm m where m.is_standalone = false and m.match_count = 1),
    case_bounty as (select bb.legacy_id from b bb where bb.detail_len >= 40)
  -- Substantive bounty -> Case.
  select 'crosswalk'::text, 'case'::text, 'bounties'::text, b.legacy_id::text, 'cases'::text,
         'high'::text, 'bounty_substantive_detail'::text, null::text[], null::text
  from b where b.detail_len >= 40
  union all
  -- Optional reward on a substantive bounty -> attached future reward_pledge.
  select 'crosswalk', 'reward_pledge', 'bounties', b.legacy_id, 'reward_pledges',
         'medium', 'bounty_reward_pledge_attached', null, null
  from b where b.detail_len >= 40 and b.reward > 0
  union all
  -- Report with exactly one bounty title match -> Case Report + version.
  select 'crosswalk', v.entity_kind, 'reports', ru.legacy_id, v.v2_table,
         'medium', 'report_unique_bounty_title_match', null, null
  from report_unique ru
  cross join (values ('case_report', 'case_reports'),
                     ('case_report_version', 'case_report_versions')) as v(entity_kind, v2_table)
  union all
  -- Escalation pack maps only when its Report safely mapped to a Case.
  select 'crosswalk', v.entity_kind, 'escalation_packs', p.legacy_id, v.v2_table,
         'medium', 'escalation_pack_report_mapped', null, null
  from pk p
  cross join (values ('ai_pack', 'ai_packs'),
                     ('ai_pack_version', 'ai_pack_versions')) as v(entity_kind, v2_table)
  where exists (select 1 from report_unique ru where ru.legacy_id = p.report_ref)
  union all
  -- Every onchain event -> future event_receipt, always legacy_imported and
  -- server_verified=false. Confidence reflects whether its item resolves.
  select 'crosswalk', 'event_receipt', 'onchain_events', e.legacy_id, 'event_receipts',
         case when exists (select 1 from case_bounty cb where cb.legacy_id = e.item_id)
                or exists (select 1 from report_unique ru where ru.legacy_id = e.item_id)
              then 'high' else 'low' end,
         'onchain_event_legacy_imported:server_verified_false'
           || case when e.item_type <> '' then ':item_' || e.item_type else '' end,
         null, null
  from ev e
  union all
  -- Thin/ambiguous bounty -> manual queue.
  select 'queue', null, 'bounties', b.legacy_id, null, null, null,
         array['case'], 'bounty_thin_detail_manual'
  from b where b.detail_len < 40
  union all
  -- Standalone report -> manual queue (case vs wire_report).
  select 'queue', null, 'reports', m.legacy_id, null, null, null,
         array['case', 'wire_report'], 'report_standalone_case_vs_wire'
  from rm m where m.is_standalone = true
  union all
  -- Report whose bounty matches nothing -> manual queue (case vs wire_report).
  select 'queue', null, 'reports', m.legacy_id, null, null, null,
         array['case', 'wire_report'], 'report_ambiguous_bounty_match'
  from rm m where m.is_standalone = false and m.match_count = 0
  union all
  -- Report whose bounty matches more than one bounty -> manual queue.
  select 'queue', null, 'reports', m.legacy_id, null, null, null,
         array['case_report'], 'report_duplicate_bounty_match'
  from rm m where m.is_standalone = false and m.match_count > 1
  union all
  -- Escalation pack whose Report did not map -> manual queue.
  select 'queue', null, 'escalation_packs', p.legacy_id, null, null, null,
         array['ai_pack'], 'escalation_pack_report_unmapped'
  from pk p where not exists (select 1 from report_unique ru where ru.legacy_id = p.report_ref)
  union all
  -- Analysts classify conservatively; uncertain history can never add weight.
  select 'queue', null, 'analysts', a.legacy_id, null, null, null,
         array['analyst_profile'],
         case when a.verified and a.approved then 'analyst_conservative_no_weight'
              else 'analyst_conservative_unverified' end
  from an a
  union all
  -- Ancillary rows are accounted for, never guessed or silently discarded.
  select 'queue', null, g.legacy_table, g.legacy_id, null, null, null,
         mp.candidate_kinds, mp.reason_code
  from anc g
  join (values
    ('profiles',      array['analyst_profile']::text[],  'profile_identity_manual'),
    ('requests',      array['retire_or_archive']::text[], 'request_retire_pending'),
    ('request_votes', array['retire_or_archive']::text[], 'request_vote_retire_pending'),
    ('bounty_boosts', array['retire_or_archive']::text[], 'bounty_boost_retire_pending'),
    ('vouches',       array['review_history']::text[],    'vouch_review_history_pending'),
    ('challenges',    array['challenge']::text[],         'legacy_challenge_pending')
  ) as mp(tbl, candidate_kinds, reason_code) on mp.tbl = g.legacy_table;
end
$$;

-- Read-only preview: aggregate classification counts and reason codes only.
-- Exposes no bodies, wallet values, or raw legacy ids. Changes no data.
create function osi_private.osi_v2_preview_legacy_classification()
returns table (action text, scope text, reason_code text, item_count bigint)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Legacy classification is service-only' using errcode = '42501';
  end if;

  return query
    select case when d.kind = 'crosswalk' then 'crosswalk' else 'manual_queue' end,
           coalesce(d.v2_table, 'queue'),
           coalesce(d.classification_reason, d.reason_code),
           count(*)::bigint
    from osi_private.osi_v2_legacy_decisions() d
    group by 1, 2, 3
    order by 1, 2, 3;
end
$$;

-- Apply the classification. Service-only, advisory-locked, idempotent. Writes
-- ONLY migration_crosswalk and migration_manual_queue. Preserves previously
-- assigned V2 uuids and never silently reclassifies an existing decision.
create function osi_private.osi_v2_apply_legacy_classification()
returns table (action text, scope text, reason_code text, item_count bigint)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Legacy classification is service-only' using errcode = '42501';
  end if;

  -- Prevent concurrent classification runs within overlapping transactions.
  perform pg_advisory_xact_lock(hashtextextended('osi2-legacy-classification', 0));

  -- Crosswalk: only for legacy rows not already queued; on-conflict-do-nothing
  -- preserves existing rows and their assigned v2_id on every rerun.
  insert into public.migration_crosswalk
    (entity_kind, legacy_table, legacy_id, v2_table, v2_id, confidence, classification_reason)
  select d.entity_kind, d.legacy_table, d.legacy_id, d.v2_table,
         gen_random_uuid(), d.confidence, d.classification_reason
  from osi_private.osi_v2_legacy_decisions() d
  where d.kind = 'crosswalk'
    and not exists (
      select 1 from public.migration_manual_queue q
      where q.legacy_table = d.legacy_table and q.legacy_id = d.legacy_id
    )
  on conflict (legacy_table, legacy_id, entity_kind) do nothing;

  -- Manual queue: only for legacy rows not already crosswalked.
  insert into public.migration_manual_queue
    (legacy_table, legacy_id, candidate_kinds, reason_code, status)
  select d.legacy_table, d.legacy_id, d.candidate_kinds, d.reason_code, 'pending'
  from osi_private.osi_v2_legacy_decisions() d
  where d.kind = 'queue'
    and not exists (
      select 1 from public.migration_crosswalk c
      where c.legacy_table = d.legacy_table and c.legacy_id = d.legacy_id
    )
  on conflict (legacy_table, legacy_id) do nothing;

  return query
    select 'crosswalk'::text, c.v2_table, c.classification_reason, count(*)::bigint
    from public.migration_crosswalk c
    group by c.v2_table, c.classification_reason
    union all
    select 'manual_queue'::text, 'queue'::text, q.reason_code, count(*)::bigint
    from public.migration_manual_queue q
    group by q.reason_code
    order by 1, 2, 3;
end
$$;

-- Service-only access. osi_private already denies USAGE to anon/authenticated;
-- these revoke/grant statements are defense in depth on each function.
revoke all privileges on function osi_private.osi_v2_norm_label(text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_build_legacy_snapshot()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_legacy_decisions()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_preview_legacy_classification()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_apply_legacy_classification()
  from public, anon, authenticated;

grant execute on function osi_private.osi_v2_norm_label(text) to service_role;
grant execute on function osi_private.osi_v2_build_legacy_snapshot() to service_role;
grant execute on function osi_private.osi_v2_legacy_decisions() to service_role;
grant execute on function osi_private.osi_v2_preview_legacy_classification() to service_role;
grant execute on function osi_private.osi_v2_apply_legacy_classification() to service_role;

comment on function osi_private.osi_v2_preview_legacy_classification() is
  'Service-only read-only preview of V1->V2 classification: aggregate counts and reason codes only; no bodies, wallets, or raw ids.';
comment on function osi_private.osi_v2_apply_legacy_classification() is
  'Service-only idempotent V1->V2 classifier. Writes only migration_crosswalk and migration_manual_queue; never a V2 domain table; preserves assigned uuids.';

commit;
