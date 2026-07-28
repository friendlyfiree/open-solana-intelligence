-- pgTAP coverage for the V1 legacy write-policy hardening.
--
-- The point of these assertions is not that some policies were deleted. It is
-- that no unrestricted write route survives, while every read route and every
-- guarded write route the shipped client actually uses is still there. A
-- hardening migration that quietly removed a live path would be a worse
-- outcome than the hole it closed.
--
-- The V1 tables these policies sat on were created outside the migration
-- history and exist only in production, so a database built from migrations
-- alone does not have them. Each assertion is therefore written as an
-- invariant that is true in both places: the hole is closed where the table
-- exists, and there is nothing to close where it does not.
begin;
select plan(14);

create or replace function pg_temp.policy_count(p_table text, p_policy text)
returns integer language sql stable as $$
  select count(*)::integer from pg_policies
   where schemaname = 'public' and tablename = p_table and policyname = p_policy;
$$;

create or replace function pg_temp.table_here(p_table text)
returns boolean language sql stable as $$
  select to_regclass('public.' || quote_ident(p_table)) is not null;
$$;

-- Unrestricted write routes are gone wherever their table exists.
select is(pg_temp.policy_count('config', 'config_write'), 0,
  'the unrestricted ALL policy on the legacy config table is gone');
select is(pg_temp.policy_count('profiles', 'profiles_insert'), 0,
  'anonymous callers can no longer insert an arbitrary profile row');
select is(pg_temp.policy_count('profiles', 'profiles_update'), 0,
  'anonymous callers can no longer update an arbitrary profile row');
select is(pg_temp.policy_count('vouches', 'vouches_delete'), 0,
  'the unrestricted vouch delete is gone');
select is(pg_temp.policy_count('requests', 'add requests'), 0,
  'the unconstrained public request insert is gone');
select is(pg_temp.policy_count('bounty_boosts', 'boosts_delete'), 0,
  'the unrestricted boost delete is gone');

-- The legacy counters identify a voter by a client-chosen string, so their
-- write routes could only be closed, not tightened.
select is(pg_temp.policy_count('request_votes', 'votes_insert'), 0,
  'anonymous vote stuffing is closed');
select is(pg_temp.policy_count('request_votes', 'votes_delete'), 0,
  'anonymous deletion of someone else vote is closed');
select is(pg_temp.policy_count('bounty_boosts', 'boosts_insert'), 0,
  'anonymous boost stuffing is closed');

-- Read routes the client depends on are untouched wherever they apply.
select ok(
  not pg_temp.table_here('profiles') or pg_temp.policy_count('profiles', 'profiles_read') = 1,
  'the profile read route the client uses is untouched');
select ok(
  not pg_temp.table_here('requests') or pg_temp.policy_count('requests', 'requests_read') = 1,
  'the approved-request read route is untouched');
select ok(
  not pg_temp.table_here('request_votes') or pg_temp.policy_count('request_votes', 'votes_read') = 1,
  'vote counts stay readable');

-- The SECURITY DEFINER function is no longer reachable without the service role.
select ok(
  not exists (
    select 1 from pg_proc as proc
      join pg_namespace as ns on ns.oid = proc.pronamespace
     where ns.nspname = 'public' and proc.proname = 'osi_consensus' and proc.pronargs = 0
  )
  or not has_function_privilege('anon', 'public.osi_consensus()', 'execute'),
  'anonymous callers can no longer execute the SECURITY DEFINER consensus function');

-- The whole point, stated once, and true on any database this runs against.
select is(
  (select count(*)::integer from pg_policies
    where schemaname = 'public' and cmd <> 'SELECT'
      and (qual = 'true' or with_check = 'true')), 0,
  'no policy in the public schema grants an unrestricted write');

select * from finish();
rollback;
