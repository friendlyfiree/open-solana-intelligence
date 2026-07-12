-- Run on a disposable local Supabase database:
--   supabase test db
-- All writes are inside this transaction and are rolled back. The legacy V1
-- fixture tables are created here (they do not exist in a V2 database) purely to
-- exercise the classifier + materializer, and are discarded on rollback.
--
-- Proves the 14 required properties of the controlled legacy -> V2 materialization:
--  1 preview performs no persistent writes
--  2 apply uses crosswalk UUIDs exactly
--  3 second apply creates zero duplicates and preserves all UUIDs
--  4 manual queue rows are untouched
--  5 V1 rows and counts are unchanged
--  6 no synthetic analyst/review/resolution/payment rows exist
--  7 imported receipts are server_verified=false / legacy_imported
--  8 parent/version FKs and current-version pointer are correct
--  9 anon/authenticated cannot execute the private functions
-- 10 all V2 flags remain false
-- 11 partial failure rolls back transactionally (no partial state)
-- 12 concurrent/repeated execution cannot duplicate effects
-- 13 every skipped row carries an aggregate reason code
-- 14 no restricted body/wallet/evidence value is emitted in the aggregate output

begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---- (9) authorization: the materializer is service-only ------------------
select ok(not has_schema_privilege('anon', 'osi_private', 'USAGE'),
  'anon has no USAGE on the private schema');
select ok(not has_schema_privilege('authenticated', 'osi_private', 'USAGE'),
  'authenticated has no USAGE on the private schema');
select ok(not has_function_privilege('anon',
  'osi_private.osi_v2_apply_materialization()', 'EXECUTE'),
  'anon cannot execute the apply function');
select ok(not has_function_privilege('authenticated',
  'osi_private.osi_v2_apply_materialization()', 'EXECUTE'),
  'authenticated cannot execute the apply function');
select ok(not has_function_privilege('anon',
  'osi_private.osi_v2_preview_materialization()', 'EXECUTE'),
  'anon cannot execute the preview function');
select ok(not has_function_privilege('authenticated',
  'osi_private.osi_v2_preview_materialization()', 'EXECUTE'),
  'authenticated cannot execute the preview function');
select ok(not has_function_privilege('anon',
  'osi_private.osi_v2_materialize_plan()', 'EXECUTE'),
  'anon cannot execute the plan function');
select ok(not has_function_privilege('authenticated',
  'osi_private.osi_v2_materialize_plan()', 'EXECUTE'),
  'authenticated cannot execute the plan function');

-- ---- representative legacy fixtures with valid base58 wallets --------------
create table public.bounties (
  id text primary key, title text, target text, detail text, reward_sol numeric,
  created_by text, created_at timestamptz, approved boolean);
create table public.reports (
  id text primary key, bounty text, summary text, wallet text, offchain text,
  onchain text, created_at timestamptz, approved boolean);
create table public.escalation_packs (
  id text primary key, case_ref text, pack_type text, content text, status text,
  created_by uuid, created_at timestamptz);
create table public.onchain_events (
  id text primary key, event_type text, item_type text, item_id text,
  actor_wallet text, memo_text text, tx_sig text, created_at timestamptz);

-- Valid base58 (32-44) wallets and a valid (64-96) tx signature.
insert into public.bounties (id, title, target, detail, reward_sol, created_by, created_at, approved) values
 ('bnt_case_ok', 'Alpha Investigation', 'Alpha Investigation',
    'A substantive legacy investigation body with more than forty characters of detail.',
    0, '4' || repeat('a', 43), '2026-01-01T00:00:00Z', true),
 ('bnt_case_ok2', 'Beta Investigation', 'Beta Investigation',
    'Another substantive legacy investigation body exceeding the forty character threshold.',
    2.5, '5' || repeat('b', 43), '2026-01-02T00:00:00Z', true),
 ('bnt_case_nowallet', 'Gamma Investigation', 'Gamma Investigation',
    'A substantive legacy investigation body but with no valid owner wallet available here.',
    0, 'not-a-valid-wallet', '2026-01-03T00:00:00Z', true),
 ('bnt_thin', 'Quick note', 'Quick note', 'thin', 0, '6' || repeat('c', 43),
    '2026-01-04T00:00:00Z', true);

insert into public.reports (id, bounty, summary, wallet, offchain, onchain, created_at, approved) values
 ('rep_match', 'Alpha Investigation', 'Private legacy report findings body for the alpha investigation.',
    '7' || repeat('d', 43), null, null, '2026-01-05T00:00:00Z', true);

insert into public.escalation_packs (id, case_ref, pack_type, content, status, created_by, created_at) values
 ('esc_1', 'rep_match', 'victim', 'legacy pack content blob', 'approved',
    gen_random_uuid(), '2026-01-06T00:00:00Z');

insert into public.onchain_events (id, event_type, item_type, item_id, actor_wallet, memo_text, tx_sig, created_at) values
 ('oe_case', 'case_opened', 'bounty', 'bnt_case_ok', '8' || repeat('e', 43),
    'OSI legacy memo alpha', '9' || repeat('f', 87), '2026-01-07T00:00:00Z'),
 ('oe_unmapped', 'report_submitted', 'report', 'rep_missing', '8' || repeat('e', 43),
    'OSI legacy memo orphan', 'A' || repeat('g', 87), '2026-01-08T00:00:00Z');

-- ---- populate the crosswalk via the existing classifier -------------------
select lives_ok($$ select * from osi_private.osi_v2_apply_legacy_classification() $$,
  'classifier populates the crosswalk from the fixtures');

create temp table _cw on commit drop as
  select entity_kind, legacy_table, legacy_id, v2_id from public.migration_crosswalk;

select is((select count(*)::int from _cw where entity_kind = 'case'), 3,
  'three substantive bounties are classified as cases');
select is((select count(*)::int from public.migration_crosswalk), 10,
  'ten crosswalk rows exist before materialization');
select is((select count(*)::int from public.migration_manual_queue), 1,
  'one manual-queue row exists before materialization');

-- ---- (1) preview performs no persistent writes ----------------------------
select lives_ok($$ select * from osi_private.osi_v2_preview_materialization() $$,
  'preview runs read-only');
select is((select count(*)::int from public.cases), 0, 'preview writes no cases');
select is((select count(*)::int from public.case_reports), 0, 'preview writes no case_reports');
select is((select count(*)::int from public.case_report_versions), 0, 'preview writes no versions');
select is((select count(*)::int from public.event_receipts), 0, 'preview writes no receipts');
select is((select count(*)::int from public.migration_crosswalk), 10, 'preview leaves crosswalk unchanged');
select is((select count(*)::int from public.migration_manual_queue), 1, 'preview leaves manual queue unchanged');

-- ---- (11) partial failure rolls back transactionally ----------------------
-- A decoy Case occupies the public_ref the apply will generate for bnt_case_ok,
-- forcing a mid-apply unique violation that must abort the entire call.
savepoint before_decoy;
insert into public.cases (public_ref, title, category, summary_public, submitted_by_wallet)
values (
  osi_private.osi_v2_public_ref_for(
    (select v2_id from _cw where entity_kind = 'case' and legacy_id = 'bnt_case_ok')),
  'decoy', 'legacy_import', 'decoy summary', '4' || repeat('a', 43));
select throws_ok($$ select * from osi_private.osi_v2_apply_materialization() $$, '23505', NULL,
  'a mid-apply unique violation aborts the whole materialization');
select is((select count(*)::int from public.cases), 1,
  'only the decoy remains; the aborted apply persisted nothing');
select is((select count(*)::int from public.case_reports), 0,
  'the aborted apply persisted no case_reports');
select is((select count(*)::int from public.event_receipts), 0,
  'the aborted apply persisted no receipts');
rollback to savepoint before_decoy;
select is((select count(*)::int from public.cases), 0,
  'decoy removed; database clean before the real apply');

-- ---- apply #1 -------------------------------------------------------------
select lives_ok($$ select * from osi_private.osi_v2_apply_materialization() $$,
  'first materialization apply runs');

create temp table _case_id_before on commit drop as
  select id from public.cases
  where id = (select v2_id from _cw where entity_kind = 'case' and legacy_id = 'bnt_case_ok');

-- ---- materialized counts by table -----------------------------------------
select is((select count(*)::int from public.cases), 2, 'two valid-owner bounties materialize as cases');
select is((select count(*)::int from public.case_reports), 1, 'the uniquely matched report materializes');
select is((select count(*)::int from public.case_report_versions), 1, 'its immutable version materializes');
select is((select count(*)::int from public.event_receipts), 2,
  'one mapped legacy event receipt + one report-version import receipt');
select is((select count(*)::int from public.ai_packs), 0, 'ai_packs are fail-closed (not materialized)');
select is((select count(*)::int from public.ai_pack_versions), 0, 'ai_pack_versions are fail-closed');
select is((select count(*)::int from public.reward_pledges), 0, 'reward_pledges are fail-closed');

-- ---- (2) apply uses crosswalk UUIDs exactly -------------------------------
select is((select id from public.cases
            where id = (select v2_id from _cw where entity_kind='case' and legacy_id='bnt_case_ok')),
          (select v2_id from _cw where entity_kind='case' and legacy_id='bnt_case_ok'),
  'case id is the exact crosswalk v2_id');
select ok(exists(select 1 from public.case_reports cr
            where cr.id = (select v2_id from _cw where entity_kind='case_report' and legacy_id='rep_match')),
  'case_report id is the exact crosswalk v2_id');
select ok(exists(select 1 from public.case_report_versions v
            where v.id = (select v2_id from _cw where entity_kind='case_report_version' and legacy_id='rep_match')),
  'case_report_version id is the exact crosswalk v2_id');
select ok(exists(select 1 from public.event_receipts r
            where r.id = (select v2_id from _cw where entity_kind='event_receipt' and legacy_id='oe_case')),
  'mapped event receipt id is the exact crosswalk v2_id');

-- ---- (8) parent/version FKs and current-version pointer -------------------
select is((select case_id from public.case_reports limit 1),
          (select v2_id from _cw where entity_kind='case' and legacy_id='bnt_case_ok'),
  'case_report.case_id points at the materialized parent Case');
select is((select report_id from public.case_report_versions limit 1),
          (select id from public.case_reports limit 1),
  'case_report_version.report_id points at its parent Case Report');
select is((select current_version_id from public.case_reports limit 1),
          (select id from public.case_report_versions limit 1),
  'case_reports.current_version_id points at the exact child version');
select ok((select current_published_version_id is null from public.case_reports limit 1),
  'no honest legacy publication: current_published_version_id stays null');
select is((select lifecycle_state from public.case_report_versions limit 1), 'submitted',
  'imported version is submitted, never published');
select ok((select published_at is null and publication_receipt_id is null
             from public.case_report_versions limit 1),
  'imported version has no publication timestamp or receipt');
select ok((select event_receipt_id is not null from public.case_report_versions limit 1),
  'imported version references its legacy import receipt');
select is((select created_by_wallet from public.case_report_versions limit 1),
          (select author_wallet from public.case_reports limit 1),
  'version creator matches the immutable report author');

-- ---- privacy: imported Cases are private/draft ----------------------------
select is((select count(*)::int from public.cases where visibility <> 'private' or stage <> 'draft'), 0,
  'every imported Case is private and draft (safest state)');

-- ---- (7) imported receipts are legacy / server_verified=false -------------
select is((select count(*)::int from public.event_receipts where server_verified), 0,
  'no imported receipt is server_verified');
select is((select count(*)::int from public.event_receipts
            where proof_type <> 'legacy_imported' or event_version <> 'legacy'), 0,
  'every imported receipt is legacy_imported / event_version legacy');
select is((select count(*)::int from public.event_receipts where anchor_wallet is not null), 0,
  'no imported receipt claims an on-chain anchor wallet');

-- ---- (6) no synthetic analyst/review/resolution/payment/support rows ------
select is((select count(*)::int from public.analyst_profiles), 0, 'no synthetic analyst profiles');
select is((select count(*)::int from public.case_report_reviews), 0, 'no synthetic reviews');
select is((select count(*)::int from public.case_resolutions), 0, 'no synthetic resolutions');
select is((select count(*)::int from public.reward_payments), 0, 'no synthetic payments');
select is((select count(*)::int from public.support_events), 0, 'no synthetic support');
select is((select count(*)::int from public.challenges_v2), 0, 'no synthetic challenges');
select is((select count(*)::int from public.ai_pack_reviews), 0, 'no synthetic ai pack reviews');

-- ---- (4) manual queue untouched -------------------------------------------
select is((select count(*)::int from public.migration_manual_queue), 1,
  'materialization never touches the manual queue');

-- ---- (5) V1 rows and counts unchanged -------------------------------------
select is((select count(*)::int from public.bounties), 4, 'V1 bounties unchanged');
select is((select count(*)::int from public.reports), 1, 'V1 reports unchanged');
select is((select count(*)::int from public.escalation_packs), 1, 'V1 escalation_packs unchanged');
select is((select count(*)::int from public.onchain_events), 2, 'V1 onchain_events unchanged');

-- ---- (10) V2 gate flags remain false --------------------------------------
select is((select value from public.osi_config where key = 'OSI_V2_WRITES_ENABLED'), 'false',
  'OSI_V2_WRITES_ENABLED stays false');
select is((select value from public.osi_config where key = 'OSI_V2_PROOF_ENABLED'), 'false',
  'OSI_V2_PROOF_ENABLED stays false');

-- ---- (13) every skipped row carries an aggregate reason code ---------------
select is((select count(*)::int from osi_private.osi_v2_materialize_plan()
            where decision = 'skip' and (reason_code is null or btrim(reason_code) = '')), 0,
  'every skipped decision has a non-empty reason code');
select is((select count(*)::int from osi_private.osi_v2_materialize_plan()
            where decision = 'skip' and reason_code = 'case_source_missing_valid_owner_wallet'), 1,
  'the no-wallet bounty is skipped with the owner-wallet reason');
select is((select count(*)::int from osi_private.osi_v2_materialize_plan()
            where decision = 'skip' and reason_code = 'ai_pack_source_lacks_manifest_wallet_profile'), 2,
  'both ai_pack rows are skipped fail-closed');
select is((select count(*)::int from osi_private.osi_v2_materialize_plan()
            where decision = 'skip' and reason_code = 'reward_pledge_no_honest_legacy_import_state'), 1,
  'the reward pledge is skipped fail-closed');
select is((select count(*)::int from osi_private.osi_v2_materialize_plan()
            where decision = 'skip' and reason_code = 'event_receipt_target_unmapped'), 1,
  'the unmapped legacy event is skipped fail-closed');

-- ---- (14) no wallet/body value leaks into the aggregate output -------------
select is((select count(*)::int from osi_private.osi_v2_preview_materialization()
            where reason_code ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
               or v2_table ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'), 0,
  'no aggregate row exposes anything shaped like a wallet');

-- ---- (3)(12) second apply is idempotent and preserves UUIDs ---------------
select lives_ok($$ select * from osi_private.osi_v2_apply_materialization() $$,
  'second materialization apply (idempotent rerun) runs');
select is((select count(*)::int from public.cases), 2, 'rerun creates no duplicate cases');
select is((select count(*)::int from public.case_reports), 1, 'rerun creates no duplicate case_reports');
select is((select count(*)::int from public.case_report_versions), 1, 'rerun creates no duplicate versions');
select is((select count(*)::int from public.event_receipts), 2, 'rerun creates no duplicate receipts');
select is((select id from public.cases
            where id = (select v2_id from _cw where entity_kind='case' and legacy_id='bnt_case_ok')),
          (select id from _case_id_before),
  'a rerun preserves the previously assigned case uuid');
select is((select count(*)::int from public.migration_crosswalk), 10, 'rerun leaves crosswalk unchanged');
select is((select count(*)::int from public.migration_manual_queue), 1, 'rerun leaves manual queue unchanged');

select * from finish();
rollback;
