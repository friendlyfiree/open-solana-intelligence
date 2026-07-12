-- OSI V2 rollout step 6 (bounded, fail-closed): controlled legacy -> V2
-- materialization.
--
-- This migration adds private, service-only, idempotent functions that read the
-- deterministic classifications already recorded in `migration_crosswalk` and
-- materialize ONLY the safe, honest subset into the real V2 domain tables. It
-- never invents data, never enables OSI_V2_WRITES_ENABLED / OSI_V2_PROOF_ENABLED,
-- never touches `migration_manual_queue`, never mutates V1, and preserves the
-- exact v2_id already assigned to every classified row.
--
-- Materialized candidates (each fail-closed when the honest payload is absent):
--   A bounty_substantive_detail        -> public.cases (private/draft owner import)
--   B report_unique_bounty_title_match -> public.case_reports + case_report_versions
--                                         (immutable v1 version, submitted, unpublished)
--   D onchain_event_legacy_imported    -> public.event_receipts
--                                         (legacy_imported, server_verified=false)
--
-- Explicitly NOT materialized here (recorded as skips with a reason code):
--   C escalation_pack -> ai_packs/ai_pack_versions
--       The V1 source has no honest creator wallet (created_by is a uuid), no
--       three-layer immutable evidence manifest, no per-layer content and no
--       confidence profile; an honest ai_pack_version cannot be constructed.
--   E bounty_reward_pledge_attached -> reward_pledges
--       reward_pledges has no honest inactive/unverified legacy-import state;
--       every allowed state ('pledged'/'assigned'/'paid'/'cancelled'/'expired')
--       would misrepresent a legacy row as a real, enforceable pledge. No
--       payment, confirmation, escrow, custody or obligation is ever invented.
--
-- Privacy/lifecycle: imported Cases are private + draft (safest allowed state);
-- imported Report versions are immutable and 'submitted' (never published, no
-- publication receipt, current_published_version_id stays null); imported
-- receipts are always legacy_imported / server_verified=false and are never
-- described as native Stage-5 verified. No analyst profile, tier, weight, review,
-- vote, quorum, resolution, challenge, payment or support row is ever created.
--
-- Every legacy read is guarded by to_regclass and performed through to_jsonb so
-- the migration applies cleanly on a fresh local/CI database (no V1 tables) as a
-- safe no-op. check_function_bodies is disabled for this transaction only,
-- because the functions reference run-time TEMP tables and optional V1 tables.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local check_function_bodies = off;

-- Deterministic, collision-safe public reference derived from a Case's assigned
-- v2 uuid (24 chars, matches cases_public_ref_check). Stable across reruns so the
-- same Case always yields the same public_ref and the same event target_id.
create function osi_private.osi_v2_public_ref_for(p_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'OSI-' || upper(substr(replace(p_id::text, '-', ''), 1, 20))
$$;

-- Read-only, privacy-minimized TEMP snapshots of the legacy source rows the
-- materializer needs. Guarded by to_regclass; reads use to_jsonb so absent
-- tables and unknown columns are handled safely. Primary keys + ON CONFLICT DO
-- NOTHING make repeat calls within one transaction a no-op.
create function osi_private.osi_v2_build_materialization_snapshot()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Legacy materialization is service-only' using errcode = '42501';
  end if;

  create temp table if not exists _osi_mat_bounties (
    legacy_id text primary key, title text, target text, detail text,
    created_by text, created_at timestamptz, name_norm text
  ) on commit drop;
  if to_regclass('public.bounties') is not null then
    execute $q$
      insert into pg_temp._osi_mat_bounties
        (legacy_id, title, target, detail, created_by, created_at, name_norm)
      select coalesce(j->>'id', md5(j::text)),
             j->>'title', j->>'target', j->>'detail', j->>'created_by',
             case when coalesce(j->>'created_at', '') ~ '^[0-9]'
                  then (j->>'created_at')::timestamptz else null end,
             osi_private.osi_v2_norm_label(coalesce(j->>'title', j->>'target', j->>'company'))
      from (select to_jsonb(t) j from public.bounties t) s
      on conflict (legacy_id) do nothing
    $q$;
  end if;

  create temp table if not exists _osi_mat_reports (
    legacy_id text primary key, bounty text, body text, wallet text,
    created_at timestamptz, bounty_norm text
  ) on commit drop;
  if to_regclass('public.reports') is not null then
    execute $q$
      insert into pg_temp._osi_mat_reports
        (legacy_id, bounty, body, wallet, created_at, bounty_norm)
      select coalesce(j->>'id', md5(j::text)),
             j->>'bounty',
             coalesce(nullif(btrim(j->>'summary'), ''),
                      nullif(btrim(j->>'offchain'), ''),
                      nullif(btrim(j->>'onchain'), '')),
             j->>'wallet',
             case when coalesce(j->>'created_at', '') ~ '^[0-9]'
                  then (j->>'created_at')::timestamptz else null end,
             osi_private.osi_v2_norm_label(j->>'bounty')
      from (select to_jsonb(t) j from public.reports t) s
      on conflict (legacy_id) do nothing
    $q$;
  end if;

  create temp table if not exists _osi_mat_events (
    legacy_id text primary key, event_type text, item_type text, item_id text,
    actor_wallet text, memo_text text, tx_sig text, created_at timestamptz
  ) on commit drop;
  if to_regclass('public.onchain_events') is not null then
    execute $q$
      insert into pg_temp._osi_mat_events
        (legacy_id, event_type, item_type, item_id, actor_wallet, memo_text, tx_sig, created_at)
      select coalesce(j->>'id', md5(j::text)),
             j->>'event_type', lower(coalesce(j->>'item_type', '')), j->>'item_id',
             j->>'actor_wallet', j->>'memo_text', j->>'tx_sig',
             case when coalesce(j->>'created_at', '') ~ '^[0-9]'
                  then (j->>'created_at')::timestamptz else null end
      from (select to_jsonb(t) j from public.onchain_events t) s
      on conflict (legacy_id) do nothing
    $q$;
  end if;
end
$$;

-- Single source of materialization truth. Pure (no persistent writes): returns
-- one decision row per classified crosswalk entry for the materializable
-- candidates, marking each 'materialize' or 'skip' with an aggregate reason code.
-- Decisions depend only on the immutable V1 source + crosswalk, so preview and
-- apply always agree and a rerun is identical.
create function osi_private.osi_v2_materialize_plan()
returns table (
  candidate text, entity_kind text, legacy_table text, legacy_id text,
  v2_table text, v2_id uuid, decision text, reason_code text,
  target_type text, target_ref text
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Legacy materialization is service-only' using errcode = '42501';
  end if;

  perform osi_private.osi_v2_build_materialization_snapshot();

  return query
  with
  case_dec as (
    select c.legacy_id, c.v2_id,
      (b.created_by ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        and nullif(btrim(coalesce(b.title, b.target)), '') is not null
        and nullif(btrim(coalesce(b.detail, b.target)), '') is not null) as ok,
      case
        when b.created_by is null or b.created_by !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
          then 'case_source_missing_valid_owner_wallet'
        when nullif(btrim(coalesce(b.title, b.target)), '') is null
          then 'case_source_missing_title'
        when nullif(btrim(coalesce(b.detail, b.target)), '') is null
          then 'case_source_missing_summary'
        else 'case_materialized'
      end as reason
    from public.migration_crosswalk c
    join pg_temp._osi_mat_bounties b on b.legacy_id = c.legacy_id
    where c.entity_kind = 'case' and c.v2_table = 'cases'
  ),
  mat_cases as (select cd.legacy_id, cd.v2_id from case_dec cd where cd.ok),
  report_match as (
    select r.legacy_id as report_id, min(b.legacy_id) as bounty_id, count(*) as n
    from pg_temp._osi_mat_reports r
    join pg_temp._osi_mat_bounties b on b.name_norm = r.bounty_norm
    where r.bounty_norm is not null
    group by r.legacy_id
  ),
  report_parent as (
    select rm.report_id, cd.ok as parent_ok, cd.v2_id as case_v2id
    from report_match rm
    join case_dec cd on cd.legacy_id = rm.bounty_id
    where rm.n = 1
  ),
  report_dec as (
    select c.entity_kind, c.legacy_id, c.v2_id, c.v2_table,
      (r.wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        and nullif(btrim(r.body), '') is not null
        and rp.parent_ok is true) as ok,
      case
        when r.wallet is null or r.wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
          then 'case_report_source_missing_valid_author_wallet'
        when nullif(btrim(r.body), '') is null
          then 'case_report_source_missing_body'
        when rp.report_id is null
          then 'case_report_parent_bounty_unmatched'
        when rp.parent_ok is not true
          then 'case_report_parent_case_not_materialized'
        else 'case_report_materialized'
      end as reason
    from public.migration_crosswalk c
    join pg_temp._osi_mat_reports r on r.legacy_id = c.legacy_id
    left join report_parent rp on rp.report_id = r.legacy_id
    where c.entity_kind in ('case_report', 'case_report_version')
  ),
  mat_report_versions as (
    select rd.legacy_id, rd.v2_id from report_dec rd
    where rd.entity_kind = 'case_report_version' and rd.ok
  ),
  event_dec as (
    select c.entity_kind, c.legacy_id, c.v2_id, c.v2_table, c.classification_reason,
           mc.v2_id as case_v2id, mrv.v2_id as rv_v2id
    from public.migration_crosswalk c
    join pg_temp._osi_mat_events e on e.legacy_id = c.legacy_id
    left join mat_cases mc on mc.legacy_id = e.item_id
    left join mat_report_versions mrv on mrv.legacy_id = e.item_id
    where c.entity_kind = 'event_receipt' and c.v2_table = 'event_receipts'
  )
  -- A: substantive bounty -> Case
  select 'A_case'::text, 'case'::text, 'bounties'::text, cd.legacy_id,
         'cases'::text, cd.v2_id,
         case when cd.ok then 'materialize' else 'skip' end, cd.reason,
         null::text, null::text
  from case_dec cd
  union all
  -- B: uniquely matched Report -> Case Report + immutable submitted version
  select 'B_case_report'::text, d.entity_kind, 'reports'::text, d.legacy_id,
         d.v2_table, d.v2_id,
         case when d.ok then 'materialize' else 'skip' end, d.reason,
         null::text, null::text
  from report_dec d
  union all
  -- D: legacy proof-log event -> legacy_imported receipt (only when its item
  -- resolves to a materialized V2 target; otherwise fail-closed, unmapped)
  select 'D_event_receipt'::text, e.entity_kind, 'onchain_events'::text, e.legacy_id,
         'event_receipts'::text, e.v2_id,
         case when e.case_v2id is not null or e.rv_v2id is not null
              then 'materialize' else 'skip' end,
         case when e.case_v2id is not null then 'event_receipt_target_case'
              when e.rv_v2id is not null then 'event_receipt_target_report_version'
              else 'event_receipt_target_unmapped' end,
         case when e.case_v2id is not null then 'case'
              when e.rv_v2id is not null then 'report_version' else null end,
         case when e.case_v2id is not null then osi_private.osi_v2_public_ref_for(e.case_v2id)
              when e.rv_v2id is not null then e.rv_v2id::text else null end
  from event_dec e
  union all
  -- C: escalation pack -> ai_pack/version: fail-closed (no honest manifest/wallet/profile)
  select 'C_ai_pack'::text, c.entity_kind, c.legacy_table, c.legacy_id,
         c.v2_table, c.v2_id, 'skip'::text,
         'ai_pack_source_lacks_manifest_wallet_profile'::text, null::text, null::text
  from public.migration_crosswalk c
  where c.entity_kind in ('ai_pack', 'ai_pack_version')
  union all
  -- E: reward pledge: fail-closed (no honest inactive/unverified legacy state)
  select 'E_reward_pledge'::text, c.entity_kind, c.legacy_table, c.legacy_id,
         c.v2_table, c.v2_id, 'skip'::text,
         'reward_pledge_no_honest_legacy_import_state'::text, null::text, null::text
  from public.migration_crosswalk c
  where c.entity_kind = 'reward_pledge';
end
$$;

-- Read-only preview: aggregate materialize/skip counts and reason codes only.
-- Exposes no bodies, wallets, evidence or raw legacy ids. Changes no data.
create function osi_private.osi_v2_preview_materialization()
returns table (action text, v2_table text, reason_code text, item_count bigint)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Legacy materialization is service-only' using errcode = '42501';
  end if;

  return query
    select case when p.decision = 'materialize' then 'materialize' else 'skip' end,
           p.v2_table, p.reason_code, count(*)::bigint
    from osi_private.osi_v2_materialize_plan() p
    group by 1, 2, 3
    order by 1, 2, 3;
end
$$;

-- Apply the materialization. Service-only, advisory-locked, idempotent. Inserts
-- ONLY into public.cases / case_reports / case_report_versions / event_receipts,
-- exactly the rows osi_v2_materialize_plan() marks 'materialize', reusing the
-- crosswalk-assigned v2_id as each row's primary key. Never writes V1, the manual
-- queue, ai_packs, reward_pledges or any analyst/review/resolution/payment table.
-- Any error aborts the whole call (no partial state); a rerun is a no-op.
create function osi_private.osi_v2_apply_materialization()
returns table (action text, v2_table text, reason_code text, item_count bigint)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Legacy materialization is service-only' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('osi2-legacy-materialization', 0));

  -- Deterministic plan; also builds the read-only V1 snapshots used below.
  create temp table if not exists _osi_mat_plan on commit drop as
    select * from osi_private.osi_v2_materialize_plan();

  -- A: private/draft Cases owned by the legacy bounty creator wallet.
  insert into public.cases
    (id, public_ref, title, category, summary_public, submitted_by_wallet,
     stage, visibility, risk_tier, created_at, updated_at)
  select p.v2_id,
         osi_private.osi_v2_public_ref_for(p.v2_id),
         left(btrim(coalesce(nullif(btrim(b.title), ''), b.target)), 200),
         'legacy_import',
         left(btrim(coalesce(nullif(btrim(b.detail), ''), b.target)), 4000),
         b.created_by,
         'draft', 'private', 'standard',
         coalesce(b.created_at, now()), now()
  from _osi_mat_plan p
  join pg_temp._osi_mat_bounties b on b.legacy_id = p.legacy_id
  where p.v2_table = 'cases' and p.decision = 'materialize'
  on conflict (id) do nothing;

  -- B (header): Case Report attached to its materialized parent Case.
  insert into public.case_reports
    (id, case_id, author_wallet, status, created_at, updated_at)
  select p.v2_id, parent_case.id, r.wallet, 'active',
         coalesce(r.created_at, now()), now()
  from _osi_mat_plan p
  join pg_temp._osi_mat_reports r on r.legacy_id = p.legacy_id
  join pg_temp._osi_mat_bounties b2 on b2.name_norm = r.bounty_norm
  join public.migration_crosswalk cc
    on cc.entity_kind = 'case' and cc.legacy_table = 'bounties'
       and cc.legacy_id = b2.legacy_id
  join public.cases parent_case on parent_case.id = cc.v2_id
  where p.entity_kind = 'case_report' and p.decision = 'materialize'
  on conflict (id) do nothing;

  -- B (receipt): one legacy_imported receipt per imported Report version.
  insert into public.event_receipts
    (id, event_version, event_type, target_type, target_id, actor_role,
     proof_type, payload_hash, server_verified, occurred_at, created_at)
  select (md5('osi2:mat:crv_receipt:' || p.v2_id::text))::uuid,
         'legacy', 'LEGACY_CASE_REPORT_IMPORT', 'report_version', p.v2_id::text,
         'service', 'legacy_imported',
         encode(sha256(convert_to('osi2:report_version:' || p.v2_id::text, 'utf8')), 'hex'),
         false, coalesce(r.created_at, now()), now()
  from _osi_mat_plan p
  join pg_temp._osi_mat_reports r on r.legacy_id = p.legacy_id
  where p.entity_kind = 'case_report_version' and p.decision = 'materialize'
  on conflict (id) do nothing;

  -- B (version): immutable, submitted, unpublished Report version.
  insert into public.case_report_versions
    (id, report_id, version_no, created_by_wallet, body_private, content_public_safe,
     evidence_snapshot_hash, lifecycle_state, event_receipt_id, created_at, updated_at)
  select p.v2_id, parent_header.v2_id, 1, r.wallet,
         left(btrim(r.body), 100000),
         null,
         encode(sha256(convert_to(coalesce(r.body, ''), 'utf8')), 'hex'),
         'submitted',
         (md5('osi2:mat:crv_receipt:' || p.v2_id::text))::uuid,
         coalesce(r.created_at, now()), now()
  from _osi_mat_plan p
  join pg_temp._osi_mat_reports r on r.legacy_id = p.legacy_id
  join public.migration_crosswalk parent_header
    on parent_header.entity_kind = 'case_report'
       and parent_header.legacy_table = 'reports'
       and parent_header.legacy_id = p.legacy_id
  join public.case_reports parent_exists on parent_exists.id = parent_header.v2_id
  where p.entity_kind = 'case_report_version' and p.decision = 'materialize'
  on conflict (id) do nothing;

  -- B (pointer): set current version only after the exact submitted child exists.
  -- current_published_version_id is intentionally left null (no honest legacy
  -- publication state).
  update public.case_reports h
  set current_version_id = v.id, updated_at = now()
  from public.case_report_versions v
  where v.report_id = h.id
    and v.version_no = 1
    and v.lifecycle_state = 'submitted'
    and h.current_version_id is null
    and exists (
      select 1 from _osi_mat_plan p
      where p.entity_kind = 'case_report' and p.v2_id = h.id and p.decision = 'materialize'
    );

  -- D: legacy proof-log receipts for events whose item maps to a V2 target.
  insert into public.event_receipts
    (id, event_version, event_type, target_type, target_id, actor_wallet, actor_role,
     reason_code, proof_type, memo_ref, payload_hash, tx_sig, server_verified,
     occurred_at, created_at)
  select p.v2_id,
         'legacy',
         left('LEGACY_' || upper(regexp_replace(
                coalesce(nullif(btrim(e.event_type), ''), 'EVENT'),
                '[^A-Za-z0-9]+', '_', 'g')), 96),
         p.target_type,
         left(p.target_ref, 256),
         case when e.actor_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
              then e.actor_wallet else null end,
         case when e.actor_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
              then 'wallet' else 'service' end,
         left(nullif(btrim(c.classification_reason), ''), 96),
         'legacy_imported',
         nullif(left(e.memo_text, 512), ''),
         encode(sha256(convert_to(
                'osi2:onchain_event:' || p.legacy_id || ':' || coalesce(e.tx_sig, ''),
                'utf8')), 'hex'),
         case when e.tx_sig ~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$' then e.tx_sig else null end,
         false, coalesce(e.created_at, now()), now()
  from _osi_mat_plan p
  join pg_temp._osi_mat_events e on e.legacy_id = p.legacy_id
  join public.migration_crosswalk c
    on c.entity_kind = 'event_receipt' and c.legacy_table = 'onchain_events'
       and c.legacy_id = p.legacy_id
  where p.v2_table = 'event_receipts' and p.decision = 'materialize'
  on conflict (id) do nothing;

  return query
    select 'materialized'::text, pl.v2_table, pl.reason_code, count(*)::bigint
    from _osi_mat_plan pl
    where pl.decision = 'materialize'
    group by pl.v2_table, pl.reason_code
    union all
    select 'skipped'::text, pl.v2_table, pl.reason_code, count(*)::bigint
    from _osi_mat_plan pl
    where pl.decision = 'skip'
    group by pl.v2_table, pl.reason_code
    order by 1, 2, 3;
end
$$;

-- Service-only access. osi_private already denies USAGE to anon/authenticated;
-- these revoke/grant statements are defense in depth on each function.
revoke all privileges on function osi_private.osi_v2_public_ref_for(uuid)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_build_materialization_snapshot()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_materialize_plan()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_preview_materialization()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_apply_materialization()
  from public, anon, authenticated;

grant execute on function osi_private.osi_v2_public_ref_for(uuid) to service_role;
grant execute on function osi_private.osi_v2_build_materialization_snapshot() to service_role;
grant execute on function osi_private.osi_v2_materialize_plan() to service_role;
grant execute on function osi_private.osi_v2_preview_materialization() to service_role;
grant execute on function osi_private.osi_v2_apply_materialization() to service_role;

comment on function osi_private.osi_v2_preview_materialization() is
  'Service-only read-only preview of legacy->V2 materialization: aggregate materialize/skip counts and reason codes only; no bodies, wallets or raw ids.';
comment on function osi_private.osi_v2_apply_materialization() is
  'Service-only idempotent legacy->V2 materializer. Writes only cases, case_reports, case_report_versions and legacy_imported event_receipts; preserves crosswalk uuids; never touches the manual queue, ai_packs, reward_pledges or any analyst/review/resolution/payment table; never enables V2 write/proof flags.';

commit;
