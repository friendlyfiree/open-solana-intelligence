begin;

select plan(3);

select is(
  (
    select value
      from public.osi_config
     where key = 'OSI_V2_NONCE_TTL_SECONDS'
  ),
  '300',
  'Stage-5 proof approval window is five minutes'
);

select ok(
  (
    select count(*) = 1
      from public.osi_config
     where key = 'OSI_V2_NONCE_TTL_SECONDS'
  ),
  'proof recovery keeps one canonical TTL configuration row'
);

select ok(
  (
    select value = 'true'
      from public.osi_config
     where key = 'OSI_V2_WIRE_WRITES_ENABLED'
  ) is not true,
  'proof recovery does not enable the Wire feature gate'
);

select * from finish();

rollback;
