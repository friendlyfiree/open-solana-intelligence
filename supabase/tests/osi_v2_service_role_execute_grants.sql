-- Every osi_private function is `security invoker`, so service_role's own
-- privileges decide every hop of a call chain, not just the entry point. A
-- slice that revokes a private function from public and forgets to grant it to
-- service_role therefore breaks its own write path with a 42501 that surfaces
-- as `not_authorized`. These tests hold that shape in place.

begin;

create extension if not exists pgtap with schema extensions;
select plan(9);

-- ---------------------------------------------------------------------------
-- 1. The invariant itself: nothing service-reachable is left unreachable.
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc as p
     join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'osi_private'
      and not has_function_privilege('service_role', p.oid, 'EXECUTE')),
  '',
  'every osi_private function is executable by service_role'
);

select is(
  (select count(*) from pg_proc as p
     join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'osi_private' and p.prosecdef),
  0::bigint,
  'no osi_private function is security definer, so the grants above are what carry the chain'
);

-- ---------------------------------------------------------------------------
-- 2. The analyst flow end to end: the path that also fires SAS issuance.
-- ---------------------------------------------------------------------------
select ok(
  has_function_privilege('service_role',
    'osi_private.osi_v2_issue_analyst_nonce(text, text, text, text, text, text, text, text)', 'EXECUTE'),
  'service_role can issue an analyst nonce, so an application can be prepared'
);
select ok(
  has_function_privilege('service_role',
    'osi_private.osi_v2_commit_analyst_application(text, text, text, text, text, text, jsonb, jsonb, jsonb, text, text, text)', 'EXECUTE'),
  'service_role can commit an analyst application'
);
select ok(
  has_function_privilege('service_role',
    'osi_private.osi_v2_commit_application_review(text, text, text, text, text)', 'EXECUTE'),
  'service_role can commit a maintainer application review'
);
select ok(
  has_function_privilege('service_role',
    'osi_private.osi_v2_commit_analyst_probation(text, text, text, text, timestamptz)', 'EXECUTE'),
  'service_role can commit probation activation, the only path that issues a SAS credential'
);

-- The CHECK constraints on the application version table call these, and a
-- CHECK runs with the privileges of whoever performs the DML.
select ok(
  has_function_privilege('service_role', 'osi_private.osi_v2_valid_profile_expertise(jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'osi_private.osi_v2_valid_profile_links(jsonb)', 'EXECUTE'),
  'service_role can evaluate the profile CHECK constraints it must satisfy to insert'
);

-- ---------------------------------------------------------------------------
-- 3. Widening stops at service_role: browser-facing roles stay shut out.
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc as p
     join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'osi_private'
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  '',
  'no osi_private function is executable by anon or authenticated'
);
select ok(
  not has_schema_privilege('anon', 'osi_private', 'USAGE')
  and not has_schema_privilege('authenticated', 'osi_private', 'USAGE'),
  'the private schema itself stays unreachable from the browser-facing roles'
);

select * from finish();
rollback;
