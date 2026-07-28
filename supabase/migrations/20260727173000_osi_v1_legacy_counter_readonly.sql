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
--
-- Guarded on the relation existing, for the same reason as 20260727170000:
-- these V1 tables live only in production and a database built from migrations
-- alone does not have them.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
declare
  target text[];
  targets text[][] := array[
    -- Anonymous vote stuffing and anonymous vote deletion.
    array['request_votes', 'add votes'],
    array['request_votes', 'remove votes'],
    array['request_votes', 'votes_insert'],
    array['request_votes', 'votes_delete'],
    -- Anonymous boost stuffing. The delete policy was already removed in
    -- 20260727170000 because it had no writer at all.
    array['bounty_boosts', 'anon add boost'],
    array['bounty_boosts', 'boosts_insert']
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

commit;
