-- V1 legacy counter tables become read-only.
--
-- request_votes and bounty_boosts still carried unrestricted insert and delete
-- policies for anonymous callers. Unlike the policies removed in
-- 20260727170000, these two do have writers in the shipped client, so they were
-- left alone there and are handled separately here, with the reasoning stated
-- rather than assumed.
--
-- They cannot be tightened, only closed. Both tables identify a voter by a
-- client-chosen string, voterId(), with nothing tying it to a wallet signature
-- or an auth session. There is no predicate a WITH CHECK or USING clause could
-- carry that would make the count mean anything: any visitor can inflate it,
-- and any visitor can delete someone else's row. A public counter that anyone
-- can forge is worse than no counter on a platform whose product is a record
-- other people are asked to trust.
--
-- Closing them costs nothing today. Both tables are empty, the V1 requests and
-- bounties lists that render the controls are empty too, so neither control is
-- reachable in the shipped UI. V2 records support through support_events, which
-- is wallet-signed and server-verified, and that is the lane the product
-- actually uses.
--
-- Read access is deliberately kept, so anything that lists these tables keeps
-- working and simply shows a count nobody can move.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Anonymous vote stuffing and anonymous vote deletion.
drop policy if exists "add votes" on public.request_votes;
drop policy if exists "remove votes" on public.request_votes;
drop policy if exists votes_insert on public.request_votes;
drop policy if exists votes_delete on public.request_votes;

-- Anonymous boost stuffing. The delete policy was already removed in
-- 20260727170000 because it had no writer at all.
drop policy if exists "anon add boost" on public.bounty_boosts;
drop policy if exists boosts_insert on public.bounty_boosts;

commit;
