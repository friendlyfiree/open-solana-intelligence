begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A Stage-5 nonce remains single-use and is still bound to one actor, purpose,
-- target, immutable payload hash, origin fingerprint, and idempotency key.
-- The original 120-second approval window was too short for a locked Phantom
-- wallet plus mainnet submission and RPC confirmation. Five minutes is the
-- already-accepted upper bound enforced by every native proof issuer. It keeps
-- the proof short-lived while giving a human enough time to unlock and approve.
do $migration$
declare
  current_ttl text;
begin
  select config.value
    into current_ttl
    from public.osi_config as config
   where config.key = 'OSI_V2_NONCE_TTL_SECONDS'
   for update;

  if current_ttl is null
     or current_ttl !~ '^[0-9]+$'
     or current_ttl::integer not between 30 and 300 then
    raise exception 'Stage-5 nonce TTL configuration is absent or invalid'
      using errcode = '55000';
  end if;

  update public.osi_config as config
     set value = '300',
         updated_at = statement_timestamp()
   where config.key = 'OSI_V2_NONCE_TTL_SECONDS'
     and config.value is distinct from '300';
end
$migration$;

commit;
