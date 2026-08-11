-- Typed voluntary support for the public maintainer profile.
--
-- Maintainer authority is not analyst standing, so this path never creates or
-- reuses an analyst profile. The recipient is derived from the singleton
-- maintainer_profile and must still equal osi_config.admin_wallet at prepare
-- time. It is one-recipient native SOL support, rejects self-support, shares
-- the existing Stage-5 nonce / Solana Pay / Phantom / trusted finality path,
-- and carries no ranking, reputation, review, quorum or governance effect.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

insert into public.osi_config (key, value)
values ('OSI_V2_MAINTAINER_SUPPORT_ENABLED', 'false')
on conflict (key) do nothing;

create or replace function osi_private.osi_v2_maintainer_support_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
      from public.osi_config as config
     where config.key = 'OSI_V2_MAINTAINER_SUPPORT_ENABLED'
       and config.value = 'true'
  )
$$;

alter table public.support_events
  drop constraint support_events_type_check,
  add constraint support_events_type_check
    check (support_type in ('report_author', 'analyst', 'maintainer')),
  drop constraint support_events_typed_target_check,
  add constraint support_events_typed_target_check
    check (
      (
        support_type = 'report_author'
        and analyst_wallet is null
        and num_nonnulls(case_report_version_id, wire_report_version_id) = 1
      )
      or (
        support_type = 'analyst'
        and analyst_wallet is not null
        and case_report_version_id is null
        and wire_report_version_id is null
      )
      or (
        support_type = 'maintainer'
        and analyst_wallet is null
        and case_report_version_id is null
        and wire_report_version_id is null
        and case_id is null
        and context_report_version_id is null
      )
    ),
  add constraint support_events_maintainer_manifest_check
    check (
      support_type <> 'maintainer'
      or (
        intent_nonce is not null
        and jsonb_array_length(recipient_manifest) = 1
        and recipient_manifest->0->>'recipient_type' = 'maintainer'
        and recipient_manifest->0->>'target_ref' = 'OSI-MAINTAINER'
        and recipient_manifest->0->>'wallet' = target_wallet
        and recipient_manifest->0->>'amount_lamports' = amount_lamports::text
      )
    );

create or replace function public.osi_v2_validate_support_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  expected_wallet text;
  analyst_ok boolean;
  manifest_type text;
begin
  manifest_type := new.recipient_manifest->0->>'recipient_type';

  -- The existing record/submission/recovery functions predate the maintainer
  -- type and populate their non-report branch as analyst. Normalize only when
  -- the immutable server manifest explicitly carries the new typed recipient;
  -- constraints and the exact target check below then validate the final row.
  if manifest_type = 'maintainer' then
    new.support_type := 'maintainer';
    new.analyst_wallet := null;
    new.case_report_version_id := null;
    new.wire_report_version_id := null;
    new.case_id := null;
    new.context_report_version_id := null;
  end if;

  if new.support_type = 'report_author' then
    if new.case_report_version_id is not null then
      select report.author_wallet
        into expected_wallet
        from public.case_report_versions as version
        join public.case_reports as report on report.id = version.report_id
       where version.id = new.case_report_version_id;
    else
      select report.author_wallet
        into expected_wallet
        from public.wire_report_versions as version
        join public.wire_reports as report on report.id = version.wire_report_id
       where version.id = new.wire_report_version_id;
    end if;

    if new.target_wallet is distinct from expected_wallet then
      raise exception 'Report support target must be the exact Report author'
        using errcode = '23514';
    end if;
  elsif new.support_type = 'analyst' then
    select
      profile.wallet,
      profile.status in (
        'probationary_analyst',
        'verified_analyst',
        'senior_analyst'
      )
      and profile.verified
      and profile.approved
      into expected_wallet, analyst_ok
      from public.analyst_profiles as profile
     where profile.wallet = new.analyst_wallet;

    if analyst_ok is not true
       or new.target_wallet is distinct from expected_wallet then
      raise exception 'Analyst support target must be an eligible analyst'
        using errcode = '23514';
    end if;
  elsif new.support_type = 'maintainer' then
    select profile.wallet
      into expected_wallet
      from public.maintainer_profile as profile
      join public.osi_config as config
        on config.key = 'admin_wallet'
       and config.value = profile.wallet
     where profile.singleton is true;

    if expected_wallet is null
       or new.target_wallet is distinct from expected_wallet
       or manifest_type is distinct from 'maintainer'
       or new.recipient_manifest->0->>'target_ref'
          is distinct from 'OSI-MAINTAINER' then
      raise exception 'Maintainer support target must be the current configured maintainer profile'
        using errcode = '23514';
    end if;
  else
    raise exception 'Unsupported support target type' using errcode = '23514';
  end if;

  return new;
end
$$;

create or replace function osi_private.osi_v2_prepare_maintainer_support(
  p_nonce text,
  p_payer_wallet text,
  p_target_wallet text,
  p_amount_lamports bigint,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, purpose text, payment_id uuid, payment_kind text,
  target_public_ref text, actor_role text, recipient_manifest jsonb,
  manifest_hash text, total_lamports bigint, payload_hash text, memo text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.osi_nonces%rowtype;
  maintainer_wallet text;
  server_manifest jsonb;
  server_binding jsonb;
  exact_hash text;
  actual_manifest_hash text;
  canonical_memo text;
  actual_payment_id uuid := gen_random_uuid();
  issued_time timestamptz := statement_timestamp();
  expires_time timestamptz;
  ttl_seconds integer;
  max_lamports bigint;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Maintainer support preparation is service-only'
      using errcode = '42501';
  end if;
  if osi_private.osi_v2_payment_writes_enabled() is distinct from true then
    raise exception 'OSI V2 payment writes are disabled' using errcode = '55000';
  end if;
  if osi_private.osi_v2_maintainer_support_enabled() is distinct from true then
    raise exception 'OSI V2 maintainer support is disabled' using errcode = '55000';
  end if;
  if p_nonce !~ '^[A-Za-z0-9_-]{32,128}$'
     or p_payer_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or p_target_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     or p_request_fingerprint_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Maintainer support request is invalid' using errcode = '22023';
  end if;

  select profile.wallet
    into maintainer_wallet
    from public.maintainer_profile as profile
    join public.osi_config as config
      on config.key = 'admin_wallet'
     and config.value = profile.wallet
   where profile.singleton is true;

  select case when config.value ~ '^[0-9]+$' then config.value::bigint end
    into max_lamports
    from public.osi_config as config
   where config.key = 'OSI_V2_PAYMENT_MAX_LAMPORTS';

  if maintainer_wallet is null
     or p_target_wallet is distinct from maintainer_wallet
     or p_payer_wallet = maintainer_wallet then
    raise exception 'Maintainer support recipient is unavailable or is the payer'
      using errcode = '42501';
  end if;
  if max_lamports is null
     or max_lamports not between 1 and 100000000000
     or p_amount_lamports is null
     or p_amount_lamports <= 0
     or p_amount_lamports > max_lamports then
    raise exception 'Maintainer support amount is invalid' using errcode = '22023';
  end if;

  server_manifest := jsonb_build_array(jsonb_build_object(
    'ordinal', 1,
    'wallet', maintainer_wallet,
    'amount_lamports', p_amount_lamports::text,
    'recipient_type', 'maintainer',
    'target_ref', 'OSI-MAINTAINER'
  ));
  actual_manifest_hash := osi_private.osi_v2_payment_hash(server_manifest);
  server_binding := jsonb_build_object(
    'maintainer_support', true,
    'maintainer_wallet', maintainer_wallet,
    'support_context_ref', 'OSI-MAINTAINER'
  );
  exact_hash := osi_private.osi_v2_payment_hash(jsonb_build_object(
    'payment_kind', 'support',
    'payment_id', actual_payment_id,
    'payer_wallet', p_payer_wallet,
    'target_public_ref', 'OSI-MAINTAINER',
    'recipient_manifest', server_manifest,
    'manifest_hash', actual_manifest_hash,
    'total_lamports', p_amount_lamports::text,
    'server_binding', server_binding
  ));

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-payment-idempotency:' || p_idempotency_key, 0)
  );
  select nonce.*
    into existing
    from public.osi_nonces as nonce
   where nonce.idempotency_key = p_idempotency_key
   for update;
  if found then
    if existing.actor_wallet is distinct from p_payer_wallet
       or existing.binding_context->>'payment_kind' is distinct from 'support'
       or existing.binding_context->>'target_ref_input'
          is distinct from p_target_wallet
       or existing.binding_context->>'maintainer_wallet'
          is distinct from maintainer_wallet
       or existing.binding_context->>'total_lamports'
          is distinct from p_amount_lamports::text
       or existing.binding_context->>'maintainer_support'
          is distinct from 'true' then
      raise exception 'Idempotency key is bound to another exact payment intent'
        using errcode = '23514';
    end if;
    return query select
      existing.nonce,
      existing.purpose,
      existing.target_id::uuid,
      existing.binding_context->>'payment_kind',
      existing.binding_context->>'target_public_ref',
      existing.binding_context->>'actor_role',
      existing.binding_context->'recipient_manifest',
      existing.binding_context->>'manifest_hash',
      (existing.binding_context->>'total_lamports')::bigint,
      existing.payload_hash,
      existing.binding_context->>'memo',
      existing.issued_at,
      existing.expires_at,
      existing.consumed_by_receipt_id,
      true;
    return;
  end if;

  perform osi_private.osi_v2_payment_rate_limit(
    p_payer_wallet, p_request_fingerprint_hash, issued_time
  );
  ttl_seconds := osi_private.osi_v2_payment_config_integer(
    'OSI_V2_PAYMENT_NONCE_TTL_SECONDS', 30, 300
  );
  expires_time := issued_time + pg_catalog.make_interval(secs => ttl_seconds);
  canonical_memo := concat_ws(
    '|', 'OSI2', '1', 'SUPPORT_PAYMENT_CONFIRMED', 't=support',
    'id=OSI-MAINTAINER', 'a=' || p_payer_wallet, 'r=wallet', 'd=sent',
    'n=' || p_nonce, 'h=' || exact_hash,
    'ts=' || floor(extract(epoch from issued_time))::bigint
  );

  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, 'SUPPORT_PAYMENT_CONFIRMED', p_payer_wallet, 'support',
    actual_payment_id::text, exact_hash, p_idempotency_key,
    p_request_fingerprint_hash,
    server_binding || jsonb_build_object(
      'payment_kind', 'support',
      'target_ref_input', p_target_wallet,
      'target_public_ref', 'OSI-MAINTAINER',
      'actor_role', 'wallet',
      'recipient_manifest', server_manifest,
      'manifest_hash', actual_manifest_hash,
      'total_lamports', p_amount_lamports::text,
      'memo', canonical_memo,
      'client_request', jsonb_build_object(
        'target_type', 'maintainer',
        'target_wallet', p_target_wallet,
        'amount_lamports', p_amount_lamports::text
      )
    ),
    issued_time, expires_time
  );

  return query select
    p_nonce,
    'SUPPORT_PAYMENT_CONFIRMED'::text,
    actual_payment_id,
    'support'::text,
    'OSI-MAINTAINER'::text,
    'wallet'::text,
    server_manifest,
    actual_manifest_hash,
    p_amount_lamports,
    exact_hash,
    canonical_memo,
    issued_time,
    expires_time,
    null::uuid,
    false;
end
$$;

create or replace function public.osi_v2_prepare_maintainer_support(
  p_nonce text,
  p_payer_wallet text,
  p_target_wallet text,
  p_amount_lamports bigint,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, purpose text, payment_id uuid, payment_kind text,
  target_public_ref text, actor_role text, recipient_manifest jsonb,
  manifest_hash text, total_lamports bigint, payload_hash text, memo text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_prepare_maintainer_support(
    p_nonce, p_payer_wallet, p_target_wallet, p_amount_lamports,
    p_idempotency_key, p_request_fingerprint_hash
  )
$$;

revoke all privileges on function osi_private.osi_v2_prepare_maintainer_support(
  text, text, text, bigint, text, text
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_maintainer_support_enabled()
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_prepare_maintainer_support(
  text, text, text, bigint, text, text
) from public, anon, authenticated;
grant execute on function osi_private.osi_v2_prepare_maintainer_support(
  text, text, text, bigint, text, text
) to service_role;
grant execute on function osi_private.osi_v2_maintainer_support_enabled()
  to service_role;
grant execute on function public.osi_v2_prepare_maintainer_support(
  text, text, text, bigint, text, text
) to service_role;

comment on function public.osi_v2_prepare_maintainer_support(
  text, text, text, bigint, text, text
) is
  'Service-only preparation of one direct native SOL support intent to the exact current configured maintainer profile. It never grants analyst or governance standing.';

commit;
