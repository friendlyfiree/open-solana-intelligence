-- Run on a disposable local Supabase database:
--   supabase test db
-- All writes are inside this transaction and are rolled back. The legacy V1
-- fixture tables are created here (they do not exist in a V2 database) purely to
-- exercise the classifier, and are discarded on rollback.

begin;

create extension if not exists pgtap with schema extensions;
select plan(38);

-- ---- authorization: the classifier is service-only ------------------------
select ok(
  not has_schema_privilege('anon', 'osi_private', 'USAGE'),
  'anon has no USAGE on the private classification schema');
select ok(
  not has_schema_privilege('authenticated', 'osi_private', 'USAGE'),
  'authenticated has no USAGE on the private classification schema');
select ok(
  not has_function_privilege(
    'anon', 'osi_private.osi_v2_apply_legacy_classification()', 'EXECUTE'),
  'anon cannot execute the apply function');
select ok(
  not has_function_privilege(
    'authenticated', 'osi_private.osi_v2_apply_legacy_classification()', 'EXECUTE'),
  'authenticated cannot execute the apply function');
select ok(
  not has_function_privilege(
    'anon', 'osi_private.osi_v2_preview_legacy_classification()', 'EXECUTE'),
  'anon cannot execute the preview function');
select ok(
  not has_function_privilege(
    'authenticated', 'osi_private.osi_v2_preview_legacy_classification()', 'EXECUTE'),
  'authenticated cannot execute the preview function');

-- ---- representative legacy fixtures (test-only, rolled back) ---------------
create table public.bounties (id text primary key, title text, target text, detail text, reward_sol numeric, approved boolean);
create table public.reports (id text primary key, bounty text, summary text, wallet text, approved boolean);
create table public.escalation_packs (id text primary key, case_ref text, status text);
create table public.onchain_events (id text primary key, event_type text, item_type text, item_id text, actor_wallet text);
create table public.analysts (wallet text primary key, verified boolean, approved boolean);
create table public.profiles (id text primary key, wallet text);
create table public.requests (id text primary key, name text);
create table public.request_votes (id text primary key, request_id text, voter text);
create table public.bounty_boosts (id text primary key, bounty_id text, wallet text);
create table public.vouches (id text primary key, item_id text);
create table public.challenges (id text primary key, item_type text, item_id text, status text);

insert into public.bounties values
 ('bnt_1','Solana drainer cluster','Solana drainer cluster','Map the wallet cluster behind a known drainer and document the reused off-ramp infrastructure for victims.',0,true),
 ('bnt_2','Treasury movement trace','Treasury movement trace','Trace the treasury movement out of the project multisig and grade every hop with public evidence.',2.5,true),
 ('bnt_3','quick one','quick one','thin',0,true),
 ('bnt_4a','Dup Title Alpha','Dup Title Alpha','First substantive investigation with a deliberately duplicated public title for the matching test.',0,true),
 ('bnt_4b','Dup Title Alpha','Dup Title Alpha','Second substantive investigation sharing the same normalized public title as the first one here.',0,true);
insert into public.reports values
 ('rep_1','Solana drainer cluster','private findings body A','wal_author_1',true),
 ('rep_2','','private wire finding body B','wal_author_2',true),
 ('rep_3','No Such Bounty Title','private findings body C','wal_author_3',true),
 ('rep_4','Dup Title Alpha','private findings body D','wal_author_4',true);
insert into public.escalation_packs values ('esc_1','rep_1','approved'),('esc_2','rep_2','review_required');
insert into public.onchain_events values
 ('oe_1','REPORT_PUBLISHED','report','rep_1','wal_x'),
 ('oe_2','CASE_OPENED','bounty','bnt_1','wal_y'),
 ('oe_3','REPORT_SUBMITTED','report','rep_missing','wal_z'),
 ('oe_4','CONFIG_CHANGED','','','wal_w');
insert into public.analysts values ('wal_analyst_1',false,false),('wal_analyst_2',true,true);
insert into public.profiles values ('prof_1','wal_profile_1');
insert into public.requests values ('req_1','Community request');
insert into public.request_votes values ('rv_1','req_1','wal_voter_1'),('rv_2','req_1','wal_voter_2');
insert into public.bounty_boosts values ('boost_1','bnt_1','wal_boost_1'),('boost_2','bnt_2','wal_boost_2');
insert into public.vouches values ('vou_1','rep_1');
insert into public.challenges values ('chx_1','report','rep_1','open');

-- ---- apply (service role path via postgres in the test session) -----------
select lives_ok(
  $$ select * from osi_private.osi_v2_apply_legacy_classification() $$,
  'first classification apply runs');

create temp table _uuid_before on commit drop as
select v2_id from public.migration_crosswalk
where legacy_table = 'bounties' and legacy_id = 'bnt_1' and entity_kind = 'case';

select lives_ok(
  $$ select * from osi_private.osi_v2_apply_legacy_classification() $$,
  'second classification apply (idempotent rerun) runs');

-- ---- safe unique mapping --------------------------------------------------
select is((select count(*)::int from public.migration_crosswalk where entity_kind = 'case'),
  4, 'each substantive bounty maps to a Case crosswalk');
select is((select count(*)::int from public.migration_crosswalk where entity_kind = 'reward_pledge'),
  1, 'a reward-enabled substantive bounty attaches a reward_pledge classification');
select is((select count(*)::int from public.migration_crosswalk where entity_kind = 'case_report'),
  1, 'a uniquely matched Report maps to a Case Report');
select is((select count(*)::int from public.migration_crosswalk where entity_kind = 'case_report_version'),
  1, 'a uniquely matched Report maps to a Case Report version');
select is((select count(*)::int from public.migration_crosswalk where entity_kind = 'ai_pack'),
  1, 'an escalation pack on a mapped Report maps to an ai_pack');
select is((select count(*)::int from public.migration_crosswalk where entity_kind = 'ai_pack_version'),
  1, 'an escalation pack on a mapped Report maps to an ai_pack_version');
select is((select count(*)::int from public.migration_crosswalk where entity_kind = 'event_receipt'),
  4, 'every onchain event maps to a legacy event_receipt classification');
select is((select count(*)::int from public.migration_crosswalk
           where entity_kind = 'event_receipt'
             and classification_reason like 'onchain_event_legacy_imported:server_verified_false%'),
  4, 'every event classification is legacy_imported / server_verified=false');

-- ---- ambiguous, standalone and duplicate rows are queued ------------------
select is((select count(*)::int from public.migration_manual_queue where reason_code = 'bounty_thin_detail_manual'),
  1, 'a thin/reward-enabled bounty is queued for manual review');
select is((select count(*)::int from public.migration_manual_queue where reason_code = 'report_standalone_case_vs_wire'),
  1, 'a standalone Report is queued with case vs wire candidates');
select is((select count(*)::int from public.migration_manual_queue where reason_code = 'report_ambiguous_bounty_match'),
  1, 'a Report matching no bounty is queued');
select is((select count(*)::int from public.migration_manual_queue where reason_code = 'report_duplicate_bounty_match'),
  1, 'a Report matching duplicate bounty titles is queued');
select is((select count(*)::int from public.migration_manual_queue where reason_code = 'escalation_pack_report_unmapped'),
  1, 'an escalation pack on an unmapped Report is queued');
select is((select count(*)::int from public.migration_manual_queue where reason_code like 'analyst_conservative%'),
  2, 'analyst rows are queued conservatively, never auto-weighted');
select is((select count(*)::int from public.migration_manual_queue
           where legacy_table in ('profiles','requests','request_votes','bounty_boosts','vouches','challenges')),
  8, 'every ancillary legacy row is accounted for in the queue');
select ok((select array['case_report'] = candidate_kinds
           from public.migration_manual_queue where reason_code = 'report_duplicate_bounty_match'),
  'duplicate-title Report keeps the exact candidate kind');

-- ---- idempotency: no duplicates, preserved V2 uuid ------------------------
select is(
  (select v2_id from public.migration_crosswalk
    where legacy_table='bounties' and legacy_id='bnt_1' and entity_kind='case'),
  (select v2_id from _uuid_before),
  'a rerun preserves the previously assigned V2 uuid');
select is((select count(*)::int from public.migration_crosswalk), 13,
  'a rerun creates no duplicate crosswalk rows');
select is((select count(*)::int from public.migration_manual_queue), 15,
  'a rerun creates no duplicate queue rows');

-- ---- no V2 domain table receives a row ------------------------------------
select is((select count(*)::int from public.cases), 0, 'classification writes no cases row');
select is((select count(*)::int from public.case_reports), 0, 'classification writes no case_reports row');
select is((select count(*)::int from public.case_report_versions), 0, 'classification writes no case_report_versions row');
select is((select count(*)::int from public.event_receipts), 0, 'classification writes no event_receipts row');
select is((select count(*)::int from public.reward_pledges), 0, 'classification writes no reward_pledges row');
select is((select count(*)::int from public.ai_packs), 0, 'classification writes no ai_packs row');
select is((select count(*)::int from public.ai_pack_versions), 0, 'classification writes no ai_pack_versions row');
select is((select count(*)::int from public.challenges_v2), 0, 'classification writes no challenges_v2 row');
select is((select count(*)::int from public.analyst_profiles), 0, 'classification writes no analyst_profiles row');

-- ---- full accounting: every legacy row is classified or queued, never both -
select is(
  (select count(distinct legacy_table || '|' || legacy_id)::int from public.migration_crosswalk)
  + (select count(*)::int from public.migration_manual_queue),
  25,
  'every legacy fixture row is either classified or queued (nothing lost)');
select ok(
  not exists (
    select 1 from public.migration_crosswalk c
    join public.migration_manual_queue q
      on q.legacy_table = c.legacy_table and q.legacy_id = c.legacy_id),
  'no legacy row is both classified and queued');

select * from finish();
rollback;
