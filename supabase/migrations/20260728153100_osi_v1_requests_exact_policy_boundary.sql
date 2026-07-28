-- Focused forward fix for the production-shaped V1 request policy names.
--
-- The preceding hardening migration revoked every browser write privilege, but
-- production carried three authenticated-wide policies named
-- "requests admin read/update/delete" rather than "admin read/update/delete".
-- Remove both historical name variants, retain only approved browser reads,
-- and keep the reusable boundary helper aligned with the production catalog.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function osi_private.osi_v2_apply_legacy_boundary()
returns void
language plpgsql security invoker set search_path='' as $migration$
begin
  if to_regclass('public.onchain_events') is not null then
    execute 'alter table public.onchain_events enable row level security';
    execute 'alter table public.onchain_events force row level security';
    execute 'drop policy if exists "onchain_events insert" on public.onchain_events';
    execute 'revoke insert, update, delete, truncate on table public.onchain_events from public, anon, authenticated';
    execute 'grant select on table public.onchain_events to anon, authenticated';
  end if;

  if to_regclass('public.requests') is not null then
    execute 'alter table public.requests enable row level security';
    execute 'alter table public.requests force row level security';
    execute 'drop policy if exists "read requests" on public.requests';
    execute 'drop policy if exists "admin delete" on public.requests';
    execute 'drop policy if exists "admin read" on public.requests';
    execute 'drop policy if exists "admin update" on public.requests';
    execute 'drop policy if exists "requests admin delete" on public.requests';
    execute 'drop policy if exists "requests admin read" on public.requests';
    execute 'drop policy if exists "requests admin update" on public.requests';
    execute 'drop policy if exists "requests_insert" on public.requests';
    execute 'drop policy if exists "requests_read" on public.requests';
    execute 'drop policy if exists "requests approved public read" on public.requests';
    execute 'revoke insert, update, delete, truncate on table public.requests from public, anon, authenticated';
    execute 'grant select on table public.requests to anon, authenticated';
    execute 'create policy "requests approved public read" on public.requests for select to anon, authenticated using (approved is true)';
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists "osi storage upload" on storage.objects';
    execute 'drop policy if exists "osi storage read" on storage.objects';
  end if;
end
$migration$;

select osi_private.osi_v2_apply_legacy_boundary();
revoke all privileges on function osi_private.osi_v2_apply_legacy_boundary()
  from public,anon,authenticated;
grant execute on function osi_private.osi_v2_apply_legacy_boundary()
  to service_role;
comment on function osi_private.osi_v2_apply_legacy_boundary()
  is 'Idempotent service-role-only legacy policy boundary verifier. Browser roles cannot execute it.';

commit;
