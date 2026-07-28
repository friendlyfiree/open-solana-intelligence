-- V1 legacy write-policy hardening.
--
-- The V1 surface left behind a set of row level security policies that grant
-- unrestricted writes: USING (true) or WITH CHECK (true) on INSERT, UPDATE,
-- DELETE or ALL. On a platform whose product is verifiable public record, an
-- outsider able to insert rows that later render in the Proof Log or the
-- community surfaces is not a cosmetic issue. The tables are empty today,
-- which is exactly why this is cheap to close now rather than after they
-- carry data.
--
-- Only policies with no writer anywhere in the shipped client are dropped.
-- Each one below was checked against assets/js before removal:
--
--   public.config            0 writers, 0 readers
--   public.profiles          0 writers, 1 reader   (read policy kept)
--   public.vouches           0 writers, 1 reader   (read policy kept)
--   public.requests          0 writers, 2 readers  (read + guarded insert kept)
--   public.bounty_boosts     insert has writers and is handled separately in
--                            20260727173000; delete has none and goes here
--   public.osi_consensus()   0 callers in the client and in the Edge functions
--
-- Every statement is guarded on the object existing. These V1 tables were
-- created outside the migration history and live only in production, so a
-- database built from migrations alone does not have them. DROP POLICY IF
-- EXISTS guards the policy, not the table, and still raises 42P01 on a missing
-- relation, which would make this migration unreplayable on a clean database.
--
-- No V2 table, function, receipt, migration record or bootstrap state is
-- touched.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
declare
  -- table name, policy name
  target text[];
  targets text[][] := array[
    -- Any signed-in user could rewrite the entire legacy config table. V2 reads
    -- its configuration from public.osi_config, so this grant protected nothing
    -- while handing over a table that is still publicly readable.
    array['config', 'config_write'],
    -- profiles accepted an insert or an update from anonymous callers against
    -- any row, with no ownership predicate at all.
    array['profiles', 'profiles_insert'],
    array['profiles', 'profiles_update'],
    -- An unrestricted delete for every signed-in user, with nothing in the
    -- client that deletes a vouch.
    array['vouches', 'vouches_delete'],
    -- "add requests" allowed an unconstrained public insert. The guarded
    -- requests_insert policy, which forces approved = false, stays in place and
    -- remains the only insert route.
    array['requests', 'add requests'],
    -- Boost inserts are handled in the follow-up migration; this delete has no
    -- writer at all.
    array['bounty_boosts', 'boosts_delete']
  ];
begin
  foreach target slice 1 in array targets loop
    if to_regclass('public.' || quote_ident(target[1])) is not null then
      execute format(
        'drop policy if exists %I on public.%I', target[2], target[1]
      );
    end if;
  end loop;
end;
$$;

-- A SECURITY DEFINER function reachable by anonymous callers over
-- /rest/v1/rpc/osi_consensus, with no caller in the client or the Edge
-- functions. Revoking execute leaves the function defined and callable by the
-- service role, so nothing that does use it later has to be rewritten.
do $$
begin
  if exists (
    select 1 from pg_proc as proc
      join pg_namespace as ns on ns.oid = proc.pronamespace
     where ns.nspname = 'public' and proc.proname = 'osi_consensus'
       and proc.pronargs = 0
  ) then
    execute 'revoke execute on function public.osi_consensus() from anon';
    execute 'revoke execute on function public.osi_consensus() from authenticated';
    execute 'revoke execute on function public.osi_consensus() from public';
  end if;
end;
$$;

commit;
