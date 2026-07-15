-- Shared private-read authorization is stateless, additive, and fail closed.
-- No production data or feature flag is changed by this disposable pgTAP test.

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select is(
  (select value from public.osi_config where key = 'OSI_V2_READ_SESSION_ENABLED'),
  'false',
  'shared private-read sessions start fail closed'
);

select is(
  (select count(*)::integer from public.osi_config where key = 'OSI_V2_READ_SESSION_ENABLED'),
  1,
  'the shared private-read gate is one exact configuration row'
);

select is(
  (select value from public.osi_config where key = 'OSI_V2_WRITES_ENABLED'),
  'false',
  'the broad V2 write gate remains closed'
);

select is(
  (select value from public.osi_config where key = 'OSI_V2_PROOF_ENABLED'),
  'false',
  'the broad proof gate remains closed'
);

select is(
  to_regclass('public.osi_read_sessions'),
  null::regclass,
  'read capabilities are stateless and create no session table'
);

select isnt(
  has_table_privilege('anon', 'public.osi_config', 'UPDATE'),
  true,
  'anonymous clients cannot enable the read-session gate'
);

select isnt(
  has_table_privilege('authenticated', 'public.osi_config', 'UPDATE'),
  true,
  'authenticated clients cannot enable the read-session gate'
);

select * from finish();
rollback;
