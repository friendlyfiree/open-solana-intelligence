-- OSI V2 fail-closed exposure baseline.
--
-- No anon/authenticated policy is intentionally created here. Fine-grained
-- owner/analyst/public-safe policies arrive in the next independently reviewed
-- slice. Until then, only the service role may access these tables.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'event_receipts',
    'cases',
    'case_reports',
    'case_report_versions',
    'wire_reports',
    'wire_report_versions',
    'evidence_items',
    'case_evidence_links',
    'case_report_version_evidence',
    'wire_report_version_evidence',
    'ai_pack_version_evidence',
    'case_initial_reviews',
    'case_report_reviews',
    'wire_report_reviews',
    'resolution_reviews',
    'challenge_reviews',
    'ai_pack_reviews',
    'analyst_application_reviews',
    'case_resolutions',
    'challenges_v2',
    'analyst_applications',
    'analyst_application_versions',
    'analyst_profiles',
    'analyst_contributions',
    'analyst_reputation_snapshots',
    'ai_packs',
    'ai_pack_versions',
    'ai_pack_owner_feedback',
    'reward_pledges',
    'reward_payments',
    'support_events',
    'osi_nonces',
    'migration_crosswalk',
    'migration_manual_queue'
  ]
  loop
    execute format(
      'alter table public.%I enable row level security',
      table_name
    );
    execute format(
      'alter table public.%I force row level security',
      table_name
    );
    execute format(
      'revoke all privileges on table public.%I from public, anon, authenticated',
      table_name
    );
    execute format(
      'grant select, insert, update, delete on table public.%I to service_role',
      table_name
    );
  end loop;
end
$$;

-- osi_config is reused by V1, so its existing policies/grants are preserved.
-- Enabling RLS is idempotent and protects a clean local database where the
-- minimal compatible table was created by the schema migration.
alter table public.osi_config enable row level security;

-- Helper/trigger functions are not public RPC endpoints.
do $$
declare
  helper regprocedure;
begin
  for helper in
    select procedure.oid::regprocedure
    from pg_proc as procedure
    join pg_namespace as namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname like 'osi_v2_%'
  loop
    execute format(
      'revoke all privileges on function %s from public, anon, authenticated',
      helper
    );
    execute format(
      'grant execute on function %s to service_role',
      helper
    );
  end loop;
end
$$;

-- All V2 switches fail closed. A later verified rollout changes them through
-- the modeled CONFIG_CHANGED path; this migration never enables writes or UI.
insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_SCHEMA_READY', 'false', now()),
  ('OSI_V2_WRITES_ENABLED', 'false', now()),
  ('OSI_V2_FALLBACK_GOVERNANCE', 'false', now()),
  ('OSI_V2_UI', '{}', now()),
  ('OSI_V2_CASE_OPEN_MIN_COUNT', '1', now()),
  ('OSI_V2_CASE_OPEN_MIN_WEIGHT', '0.50', now()),
  ('OSI_V2_CASE_REJECT_MIN_COUNT', '2', now()),
  ('OSI_V2_CASE_REJECT_MIN_WEIGHT', '2.00', now()),
  ('OSI_V2_REPORT_STANDARD_MIN_COUNT', '2', now()),
  ('OSI_V2_REPORT_STANDARD_MIN_WEIGHT', '2.00', now()),
  ('OSI_V2_REPORT_HIGH_MIN_COUNT', '3', now()),
  ('OSI_V2_REPORT_HIGH_MIN_WEIGHT', '4.00', now()),
  ('OSI_V2_RESOLUTION_STANDARD_MIN_COUNT', '2', now()),
  ('OSI_V2_RESOLUTION_STANDARD_MIN_WEIGHT', '2.50', now()),
  ('OSI_V2_RESOLUTION_HIGH_MIN_COUNT', '3', now()),
  ('OSI_V2_RESOLUTION_HIGH_MIN_WEIGHT', '4.50', now()),
  ('OSI_V2_AI_PACK_MIN_COUNT', '2', now()),
  ('OSI_V2_AI_PACK_MIN_WEIGHT', '2.50', now()),
  ('OSI_V2_CHALLENGE_MIN_COUNT', '2', now()),
  ('OSI_V2_CHALLENGE_MIN_WEIGHT', '2.50', now()),
  ('OSI_V2_SEAL_MIN_COUNT', '2', now()),
  ('OSI_V2_SEAL_MIN_WEIGHT', '2.50', now()),
  ('OSI_V2_CHALLENGE_WINDOW_DAYS', '7', now())
on conflict (key) do nothing;

comment on table public.challenges_v2 is
  'Physical V2 challenge table; logical blueprint name is challenges. V1 public.challenges remains untouched.';
comment on table public.osi_nonces is
  'Stage-5 single-use nonce and idempotency ledger. Service-only; not one of the 32 domain tables.';
comment on table public.migration_crosswalk is
  'Auditable V1-to-V2 classification crosswalk. Service-only migration infrastructure.';
comment on table public.migration_manual_queue is
  'Ambiguous legacy rows awaiting explicit classification; mappings are never guessed.';
comment on table public.event_receipts is
  'Immutable Proof Log provenance. Native OSI2 receipts are server-verified; legacy imports are not.';

commit;
