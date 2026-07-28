-- pgTAP coverage for the V1 legacy write-policy hardening.
--
-- The point of these assertions is not that some policies were deleted. It is
-- that the unrestricted write routes are gone while every read route and every
-- write route that the shipped client actually uses is still there. A hardening
-- migration that quietly removed a live path would be a worse outcome than the
-- hole it closed.
begin;
select plan(18);

create or replace function pg_temp.policy_count(p_table text, p_policy text)
returns integer language sql stable as $$
  select count(*)::integer from pg_policies
   where schemaname = 'public' and tablename = p_table and policyname = p_policy;
$$;

-- Unrestricted write routes are gone.
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

-- Read routes the client depends on are untouched.
select is(pg_temp.policy_count('config', 'config_read'), 1,
  'legacy config stays publicly readable');
select is(pg_temp.policy_count('profiles', 'profiles_read'), 1,
  'the profile read route the client uses is untouched');
select is(pg_temp.policy_count('vouches', 'vouches_read'), 1,
  'the vouch read route is untouched');
select is(pg_temp.policy_count('requests', 'requests_read'), 1,
  'the approved-request read route is untouched');
select is(pg_temp.policy_count('bounty_boosts', 'boosts_read'), 1,
  'the boost read route is untouched');

-- The legacy counters identify a voter by a client-chosen string, so their
-- write routes could only be closed, not tightened. Read stays open.
select is(pg_temp.policy_count('request_votes', 'votes_insert'), 0,
  'anonymous vote stuffing is closed');
select is(pg_temp.policy_count('request_votes', 'votes_delete'), 0,
  'anonymous deletion of someone else vote is closed');
select is(pg_temp.policy_count('bounty_boosts', 'boosts_insert'), 0,
  'anonymous boost stuffing is closed');
select is(pg_temp.policy_count('request_votes', 'votes_read'), 1,
  'vote counts stay readable');

-- The SECURITY DEFINER function is no longer reachable without the service role.
select ok(
  not has_function_privilege('anon', 'public.osi_consensus()', 'execute'),
  'anonymous callers can no longer execute the SECURITY DEFINER consensus function');

-- The whole point, stated once: no unrestricted write route survives anywhere
-- in the public schema.
select is(
  (select count(*)::integer from pg_policies
    where schemaname = 'public' and cmd <> 'SELECT'
      and (qual = 'true' or with_check = 'true')), 0,
  'no policy in the public schema grants an unrestricted write');

select * from finish();
rollback;
