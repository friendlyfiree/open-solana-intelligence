-- V1 legacy write-policy hardening.
--
-- The V1 surface left behind a set of row level security policies that grant
-- unrestricted writes to anon or to any signed-in user: USING (true) or
-- WITH CHECK (true) on INSERT, UPDATE, DELETE or ALL. On a platform whose
-- product is verifiable public record, an outsider able to insert rows that
-- later render in the Proof Log or the community surfaces is not a cosmetic
-- issue. The tables are empty today, which is exactly why this is cheap to
-- close now rather than after they carry data.
--
-- Only policies with no writer anywhere in the shipped client are dropped.
-- Each one below was checked against assets/js before removal:
--
--   public.config            0 writers, 0 readers
--   public.profiles          0 writers, 1 reader   (read policy kept)
--   public.vouches           0 writers, 1 reader   (read policy kept)
--   public.requests          0 writers, 2 readers  (read + guarded insert kept)
--   public.bounty_boosts     insert has 2 writers and is kept; delete has none
--   public.osi_consensus()   0 callers in the client and in the Edge functions
--
-- Deliberately left alone, because they carry live writers and removing them
-- would break a working path rather than close a hole:
--   request_votes insert/delete, bounty_boosts insert, onchain_events insert,
--   challenges insert, and the guarded application-style inserts on
--   analysts, bounties and reports, which intentionally allow an unapproved
--   row and constrain it with a WITH CHECK predicate.
--
-- No V2 table, function, receipt, migration record or bootstrap state is
-- touched. Every statement is idempotent.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Any signed-in user could rewrite the entire legacy config table. V2 reads
-- its configuration from public.osi_config, so this grant protects nothing
-- and hands over a table that is still publicly readable.
drop policy if exists config_write on public.config;

-- profiles accepted an insert or an update from anonymous callers against any
-- row, with no ownership predicate at all.
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;

-- An unrestricted delete for every signed-in user, with nothing in the client
-- that deletes a vouch.
drop policy if exists vouches_delete on public.vouches;

-- "add requests" allowed an unconstrained public insert. The guarded
-- requests_insert policy, which forces approved = false, stays in place and
-- remains the only insert route.
drop policy if exists "add requests" on public.requests;

-- Boost inserts stay; the unrestricted delete has no writer.
drop policy if exists boosts_delete on public.bounty_boosts;

-- A SECURITY DEFINER function reachable by anonymous callers over
-- /rest/v1/rpc/osi_consensus, with no caller in the client or the Edge
-- functions. Revoking execute leaves the function defined and callable by the
-- service role, so nothing that does use it later has to be rewritten.
revoke execute on function public.osi_consensus() from anon;
revoke execute on function public.osi_consensus() from authenticated;
revoke execute on function public.osi_consensus() from public;

commit;
