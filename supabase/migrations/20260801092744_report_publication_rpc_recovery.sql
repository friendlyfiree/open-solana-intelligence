begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A publication transaction is valid only when its verified mainnet block
-- time falls inside the original nonce window. RPC indexing may finish after
-- that window, so commit time itself is not a valid reason to discard an
-- otherwise exact transaction. All actor, maintainer, quorum, lineage,
-- payload, replay and idempotency checks remain inside the same function.
do $migration$
declare
  definition text;
  old_guard constant text := $old$
  if statement_timestamp() > bound.expires_at then
    raise exception 'Report publication nonce expired' using errcode = '22023';
  end if;
$old$;
  new_guard constant text := $new$
  if p_occurred_at is null
     or p_occurred_at < bound.issued_at
     or p_occurred_at > bound.expires_at then
    raise exception 'Report publication transaction outside issuance window'
      using errcode = '22023';
  end if;
$new$;
begin
  select pg_catalog.pg_get_functiondef(
    'osi_private.osi_v2_commit_report_publication(text,text,text,timestamptz,text)'::regprocedure
  ) into definition;

  if definition is null then
    raise exception 'Report publication commit function is absent'
      using errcode = '55000';
  end if;
  if pg_catalog.strpos(definition, old_guard) = 0
     or pg_catalog.strpos(
       pg_catalog.substr(
         definition,
         pg_catalog.strpos(definition, old_guard) + pg_catalog.length(old_guard)
       ),
       old_guard
     ) > 0 then
    raise exception 'Report publication expiry guard drifted from the reviewed definition'
      using errcode = '55000';
  end if;

  execute pg_catalog.replace(definition, old_guard, new_guard);
end
$migration$;

comment on function osi_private.osi_v2_commit_report_publication(
  text, text, text, timestamptz, text
) is
  'Atomically publishes one exact Report version. Late RPC recovery is allowed only when verified mainnet block time is inside the original nonce window; all replay, lineage, quorum and maintainer gates are revalidated.';

commit;
