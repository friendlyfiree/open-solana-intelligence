-- OSI V2 shared short-lived READ-ONLY wallet session rollout gate.
-- This is security infrastructure, not a new domain entity. The token itself
-- is stateless and never stored in Postgres. Missing or non-literal true fails
-- closed in every private read gateway.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

insert into public.osi_config (key, value, updated_at)
values ('OSI_V2_READ_SESSION_ENABLED', 'false', statement_timestamp())
on conflict (key) do nothing;

commit;
