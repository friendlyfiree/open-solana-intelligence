-- OSI V2 launch completion: exact Solana Pay reference binding and a private,
-- full-maintainer-only AI Pack access mode.
--
-- This migration is additive. It leaves broad V2 write/proof flags and AI
-- review writes disabled, creates no domain records, and does not publish any
-- AI artifact. Solana Pay remains disabled until its dedicated flag is changed
-- after the production RPC and application gates pass.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_SOLANA_PAY_ENABLED', 'false', statement_timestamp()),
  ('OSI_V2_AI_PACK_ACCESS_MODE', 'maintainer_only', statement_timestamp())
on conflict (key) do nothing;

alter table public.osi_nonces
  add constraint osi_nonces_solana_pay_binding_check
  check (
    not (binding_context ? 'solana_pay')
    or (
      jsonb_typeof(binding_context->'solana_pay') = 'object'
      and (binding_context->'solana_pay') ?& array[
        'reference',
        'network',
        'nonce',
        'purpose',
        'payer_wallet',
        'payment_kind',
        'target_type',
        'target_id',
        'target_public_ref',
        'recipient_manifest',
        'manifest_hash',
        'total_lamports',
        'memo',
        'payload_hash',
        'expires_at',
        'idempotency_key'
      ]
      and binding_context ?& array[
        'payment_kind',
        'target_public_ref',
        'recipient_manifest',
        'manifest_hash',
        'total_lamports',
        'memo'
      ]
      and jsonb_typeof(binding_context->'solana_pay'->'reference') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'network') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'nonce') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'purpose') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'payer_wallet') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'payment_kind') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'target_type') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'target_id') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'target_public_ref') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'recipient_manifest') = 'array'
      and jsonb_typeof(binding_context->'solana_pay'->'manifest_hash') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'total_lamports') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'memo') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'payload_hash') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'expires_at') = 'string'
      and jsonb_typeof(binding_context->'solana_pay'->'idempotency_key') = 'string'
      and jsonb_typeof(binding_context->'recipient_manifest') = 'array'
      and purpose in ('REWARD_PAYMENT_CONFIRMED', 'SUPPORT_PAYMENT_CONFIRMED')
      and binding_context->'solana_pay'->>'network' = 'mainnet-beta'
      and binding_context->'solana_pay'->>'nonce' = nonce
      and binding_context->'solana_pay'->>'payer_wallet' = actor_wallet
      and binding_context->'solana_pay'->>'purpose' = purpose
      and binding_context->'solana_pay'->>'payload_hash' = payload_hash
      and binding_context->'solana_pay'->>'reference'
        ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      and jsonb_array_length(binding_context->'recipient_manifest') = 1
      and binding_context->'solana_pay'->'recipient_manifest'
        = binding_context->'recipient_manifest'
      and binding_context->'solana_pay'->>'manifest_hash'
        = binding_context->>'manifest_hash'
      and binding_context->'solana_pay'->>'total_lamports'
        = binding_context->>'total_lamports'
      and binding_context->'solana_pay'->>'target_public_ref'
        = binding_context->>'target_public_ref'
      and binding_context->'solana_pay'->>'memo'
        = binding_context->>'memo'
      and binding_context->'solana_pay'->>'idempotency_key'
        = idempotency_key
    )
  ) not valid;

alter table public.osi_nonces
  validate constraint osi_nonces_solana_pay_binding_check;

create unique index osi_nonces_solana_pay_reference_unique
  on public.osi_nonces ((binding_context->'solana_pay'->>'reference'))
  where binding_context ? 'solana_pay';

create function public.osi_v2_bind_payment_reference(
  p_nonce text,
  p_reference text
)
returns table (
  issued_nonce text,
  solana_pay_reference text,
  expires_at timestamptz,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  enabled boolean;
  existing_reference text;
  exact_binding jsonb;
begin
  select config.value = 'true'
    into enabled
    from public.osi_config as config
   where config.key = 'OSI_V2_SOLANA_PAY_ENABLED';
  if enabled is distinct from true then
    raise exception 'OSI V2 Solana Pay is disabled' using errcode = '55000';
  end if;
  if p_reference !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    raise exception 'Solana Pay reference is invalid' using errcode = '22023';
  end if;
  select nonce.*
    into bound
    from public.osi_nonces as nonce
   where nonce.nonce = p_nonce
   for update;
  if bound.nonce is null
     or bound.purpose not in ('REWARD_PAYMENT_CONFIRMED', 'SUPPORT_PAYMENT_CONFIRMED')
     or bound.consumed_at is not null
     or bound.expires_at <= statement_timestamp()
     or jsonb_typeof(bound.binding_context->'recipient_manifest') <> 'array'
     or jsonb_array_length(bound.binding_context->'recipient_manifest') <> 1 then
    raise exception 'Payment nonce cannot be bound to Solana Pay'
      using errcode = '23514';
  end if;
  existing_reference := bound.binding_context->'solana_pay'->>'reference';
  if existing_reference is not null then
    if existing_reference is distinct from p_reference then
      raise exception 'Payment nonce already has another Solana Pay reference'
        using errcode = '23514';
    end if;
    return query select bound.nonce, existing_reference, bound.expires_at, true;
    return;
  end if;
  exact_binding := jsonb_build_object(
    'reference', p_reference,
    'network', 'mainnet-beta',
    'nonce', bound.nonce,
    'purpose', bound.purpose,
    'payer_wallet', bound.actor_wallet,
    'payment_kind', bound.binding_context->>'payment_kind',
    'target_type', bound.target_type,
    'target_id', bound.target_id,
    'target_public_ref', bound.binding_context->>'target_public_ref',
    'recipient_manifest', bound.binding_context->'recipient_manifest',
    'manifest_hash', bound.binding_context->>'manifest_hash',
    'total_lamports', bound.binding_context->>'total_lamports',
    'memo', bound.binding_context->>'memo',
    'payload_hash', bound.payload_hash,
    'expires_at', bound.expires_at,
    'idempotency_key', bound.idempotency_key
  );
  update public.osi_nonces as nonce
     set binding_context = nonce.binding_context
       || jsonb_build_object('solana_pay', exact_binding),
         updated_at = statement_timestamp()
   where nonce.nonce = bound.nonce;
  return query select bound.nonce, p_reference, bound.expires_at, false;
end
$$;

create function public.osi_v2_find_payment_by_reference(p_reference text)
returns table (
  issued_nonce text,
  expires_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select nonce.nonce, nonce.expires_at
    from public.osi_nonces as nonce
   where nonce.binding_context->'solana_pay'->>'reference' = p_reference
     and nonce.purpose in ('REWARD_PAYMENT_CONFIRMED', 'SUPPORT_PAYMENT_CONFIRMED')
   limit 1
$$;

-- Generation is no longer coupled to the unfinished broad Stage-5 flags. The
-- dedicated write gate and exact access mode are both required. Review and
-- publication remain unreachable in maintainer-only mode.
create or replace function osi_private.osi_v2_ai_pack_writes_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select bool_and(
      case config.key
        when 'OSI_V2_AI_PACK_WRITES_ENABLED' then config.value = 'true'
        when 'OSI_V2_AI_PACK_ACCESS_MODE' then config.value = 'maintainer_only'
        else false
      end
    )
      from public.osi_config as config
     where config.key in (
       'OSI_V2_AI_PACK_WRITES_ENABLED',
       'OSI_V2_AI_PACK_ACCESS_MODE'
     )
     having count(*) = 2
  ), false)
$$;

create or replace function osi_private.osi_v2_ai_pack_review_writes_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select bool_and(
      case config.key
        when 'OSI_V2_AI_PACK_WRITES_ENABLED' then config.value = 'true'
        when 'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED' then config.value = 'true'
        when 'OSI_V2_AI_PACK_ACCESS_MODE' then config.value = 'governed'
        else false
      end
    )
      from public.osi_config as config
     where config.key in (
       'OSI_V2_AI_PACK_WRITES_ENABLED',
       'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED',
       'OSI_V2_AI_PACK_ACCESS_MODE'
     )
     having count(*) = 3
  ), false)
$$;

revoke all privileges on function public.osi_v2_bind_payment_reference(text, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_find_payment_by_reference(text)
  from public, anon, authenticated;
grant execute on function public.osi_v2_bind_payment_reference(text, text)
  to service_role;
grant execute on function public.osi_v2_find_payment_by_reference(text)
  to service_role;

comment on function public.osi_v2_bind_payment_reference(text, text) is
  'Service-only, atomic binding of one server-issued native SOL payment nonce to one Solana Pay reference. It never creates or confirms a payment.';
comment on function public.osi_v2_find_payment_by_reference(text) is
  'Service-only lookup used to poll a bound Solana Pay reference without exposing payment intent rows to clients.';
comment on function osi_private.osi_v2_ai_pack_writes_enabled() is
  'Fail-closed dedicated gate for private, full-maintainer-only AI Pack generation. Broad V2 write/proof flags remain independent.';
comment on function osi_private.osi_v2_ai_pack_review_writes_enabled() is
  'AI Pack review/publication remains disabled in maintainer-only mode and requires a future explicit governed mode plus both dedicated flags.';

commit;
