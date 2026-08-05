-- Maintainer profile.
--
-- The record exists to say one thing: the person who operates OSI is visible
-- and holds no analyst standing. Two properties therefore have to survive every
-- future change, and both are checked here against a live database rather than
-- against the text of a migration:
--
--   1. Nothing that counts analysts can see this row.
--   2. Only the configured admin wallet, through service_role, can write it.
--
-- Disposable: everything below runs inside a transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- 1. Default deny, the same shape as every other client-unreachable V2 table.
-- ---------------------------------------------------------------------------
select ok(
  (select relrowsecurity and relforcerowsecurity
     from pg_class where oid = 'public.maintainer_profile'::regclass),
  'maintainer_profile enables and forces row level security'
);
select is(
  (select count(*)::integer from pg_policies
    where schemaname = 'public' and tablename = 'maintainer_profile'),
  0,
  'maintainer_profile carries no policy, so the browser roles have no way in'
);
select ok(
  not has_table_privilege('anon', 'public.maintainer_profile', 'SELECT')
  and not has_table_privilege('anon', 'public.maintainer_profile', 'INSERT')
  and not has_table_privilege('anon', 'public.maintainer_profile', 'UPDATE')
  and not has_table_privilege('anon', 'public.maintainer_profile', 'DELETE'),
  'anon holds no privilege on maintainer_profile'
);
select ok(
  not has_table_privilege('authenticated', 'public.maintainer_profile', 'SELECT')
  and not has_table_privilege('authenticated', 'public.maintainer_profile', 'INSERT')
  and not has_table_privilege('authenticated', 'public.maintainer_profile', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.maintainer_profile', 'DELETE'),
  'authenticated holds no privilege on maintainer_profile'
);
select ok(
  has_table_privilege('service_role', 'public.maintainer_profile', 'SELECT')
  and has_table_privilege('service_role', 'public.maintainer_profile', 'INSERT')
  and has_table_privilege('service_role', 'public.maintainer_profile', 'UPDATE'),
  'service_role holds the privileges the security invoker write path depends on'
);

-- ---------------------------------------------------------------------------
-- 2. The write path is service-only, and reachable where PostgREST looks.
-- ---------------------------------------------------------------------------
select ok(
  to_regprocedure(
    'public.osi_v2_save_maintainer_profile(text,text,text,text,text,jsonb,jsonb,text)'
  ) is not null,
  'the write has a public wrapper, so the Edge function rpc() call resolves'
);
select ok(
  not (select prosecdef from pg_proc
        where oid = 'osi_private.osi_v2_save_maintainer_profile(text,text,text,text,text,jsonb,jsonb,text)'::regprocedure),
  'the private write is security invoker, so service_role privileges carry the chain'
);
select ok(
  has_function_privilege('service_role',
    'osi_private.osi_v2_save_maintainer_profile(text,text,text,text,text,jsonb,jsonb,text)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.osi_v2_save_maintainer_profile(text,text,text,text,text,jsonb,jsonb,text)', 'EXECUTE'),
  'service_role can execute both halves of the write path'
);
select ok(
  not has_function_privilege('anon',
    'public.osi_v2_save_maintainer_profile(text,text,text,text,text,jsonb,jsonb,text)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.osi_v2_save_maintainer_profile(text,text,text,text,text,jsonb,jsonb,text)', 'EXECUTE'),
  'no browser-facing role can call the maintainer profile write'
);

-- ---------------------------------------------------------------------------
-- 3. The row carries no standing, structurally. A column that does not exist
--    cannot later be read by something that counts analysts.
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(column_name, ', ' order by column_name), '')
     from information_schema.columns
    where table_schema = 'public' and table_name = 'maintainer_profile'
      and column_name in ('status', 'tier_code', 'weight_cached', 'approved', 'verified')),
  '',
  'maintainer_profile has no status, tier, weight or approval column'
);
select ok(
  pg_get_function_result(
    'public.osi_v2_save_maintainer_profile(text,text,text,text,text,jsonb,jsonb,text)'::regprocedure
  ) !~* '(status|tier|weight|approved|verified)',
  'the write returns no field that could be read as analyst standing'
);

-- ---------------------------------------------------------------------------
-- 4. Fixture, and the before-picture of the governance state.
-- ---------------------------------------------------------------------------
insert into public.osi_config (key, value)
values ('admin_wallet', '44444444444444444444444444444444')
on conflict (key) do update set value = excluded.value;

-- The bootstrap ladder as it stands with no maintainer profile written.
-- Section 7 compares against this snapshot, so the comparison spans the write
-- instead of measuring the same state twice.
create temporary table maintainer_profile_tier_probe on commit drop as
  select * from osi_private.osi_v2_bootstrap_tier();

-- ---------------------------------------------------------------------------
-- 5. Column constraints: a profile field must not become an execution surface.
-- ---------------------------------------------------------------------------
select throws_ok($$
  insert into public.maintainer_profile (wallet, avatar_url)
  values ('44444444444444444444444444444444', 'javascript:alert(1)')
$$, '23514'::text, null::text, 'a non-https avatar URL is refused by the table itself');

select throws_ok($$
  insert into public.maintainer_profile (wallet, proof_of_work_url)
  values ('44444444444444444444444444444444', 'http://example.org/x')
$$, '23514'::text, null::text, 'a plain http proof-of-work URL is refused by the table itself');

select throws_ok($$
  insert into public.maintainer_profile (wallet) values ('not a base58 wallet')
$$, '23514'::text, null::text, 'a wallet that is not base58 is refused by the table itself');

-- ---------------------------------------------------------------------------
-- 5. The write itself: only the configured admin wallet, only with an identity.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select * from public.osi_v2_save_maintainer_profile(
    '55555555555555555555555555555555', 'Impostor', null, null, null,
    '[]'::jsonb, '[]'::jsonb, '11111111-1111-4111-8111-111111111111')
$$, '42501'::text, null::text, 'a wallet that is not the configured admin wallet cannot write');

select throws_ok($$
  select * from public.osi_v2_save_maintainer_profile(
    '44444444444444444444444444444444', 'No identity', null, null, null,
    '[]'::jsonb, '[]'::jsonb, null::text)
$$, '42501'::text, null::text, 'the admin wallet without an authenticated identity cannot write');

select throws_ok($$
  select * from public.osi_v2_save_maintainer_profile(
    '44444444444444444444444444444444', 'Bad identity', null, null, null,
    '[]'::jsonb, '[]'::jsonb, 'not-a-uuid')
$$, '42501'::text, null::text, 'an identity that is not a UUID cannot write');

-- A rotated admin wallet revokes editing with no code change.
update public.osi_config set value = '55555555555555555555555555555555'
 where key = 'admin_wallet';
select throws_ok($$
  select * from public.osi_v2_save_maintainer_profile(
    '44444444444444444444444444444444', 'Stale maintainer', null, null, null,
    '[]'::jsonb, '[]'::jsonb, '11111111-1111-4111-8111-111111111111')
$$, '42501'::text, null::text, 'the previously configured wallet loses write access when the config rotates');
update public.osi_config set value = '44444444444444444444444444444444'
 where key = 'admin_wallet';

-- ---------------------------------------------------------------------------
-- 6. The happy path, and the singleton it must never escape.
-- ---------------------------------------------------------------------------
select is(
  (select display_name from public.osi_v2_save_maintainer_profile(
     '44444444444444444444444444444444', 'Aksusarya', 'On-chain intelligence.',
     'https://example.org/a.png', 'https://example.org/pow',
     '["fund_flow", "osint"]'::jsonb,
     '[{"label": "X", "url": "https://x.com/example"}]'::jsonb,
     '11111111-1111-4111-8111-111111111111')),
  'Aksusarya',
  'the configured admin wallet writes the profile and gets the stored row back'
);
select is(
  (select count(*)::integer from public.maintainer_profile),
  1,
  'the first write creates exactly one row'
);

select is(
  (select bio from public.osi_v2_save_maintainer_profile(
     '44444444444444444444444444444444', 'Aksusarya', 'Second revision.',
     null, null, '[]'::jsonb, '[]'::jsonb,
     '11111111-1111-4111-8111-111111111111')),
  'Second revision.',
  'a second write updates the same row rather than adding another'
);
select is(
  (select count(*)::integer from public.maintainer_profile),
  1,
  'the profile stays a single row across writes'
);
select is(
  (select avatar_url from public.maintainer_profile),
  null::text,
  'a write clears the fields it omits instead of keeping stale text'
);

select throws_ok($$
  insert into public.maintainer_profile (singleton, wallet)
  values (false, '44444444444444444444444444444444')
$$, '23514'::text, null::text, 'a second maintainer row cannot be created by falsifying the key');

-- ---------------------------------------------------------------------------
-- 7. The governance guarantee, stated as a measurement rather than a promise:
--    a written profile changes nothing the bootstrap ladder reads.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::integer from public.analyst_profiles
    where wallet = '44444444444444444444444444444444'),
  0,
  'writing a maintainer profile creates no analyst row'
);
select is(
  (select eligible_analyst_count from osi_private.osi_v2_bootstrap_tier()),
  (select eligible_analyst_count from maintainer_profile_tier_probe),
  'the eligible analyst count is identical with a maintainer profile present'
);
select is(
  (select tier from osi_private.osi_v2_bootstrap_tier()),
  (select tier from maintainer_profile_tier_probe),
  'the bootstrap tier is unchanged, so the operator cannot retire their own cold-start privilege'
);
select is(
  (select active from osi_private.osi_v2_bootstrap_tier()),
  (select active from maintainer_profile_tier_probe),
  'bootstrap activity is unchanged by the maintainer profile'
);

-- The ladder must not merely happen to ignore the table; it must not read it.
select is(
  (select count(*)::integer from pg_proc as p
     join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'osi_private'
      and p.proname in ('osi_v2_bootstrap_tier', 'osi_v2_bootstrap_selection_support')
      and pg_get_functiondef(p.oid) ilike '%maintainer_profile%'),
  0,
  'no bootstrap function mentions maintainer_profile in its body'
);

select * from finish();
rollback;
