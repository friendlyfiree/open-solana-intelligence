-- Permit the one additive mutation required by the already-deployed Solana
-- Pay flow without weakening Stage-5 nonce immutability.
--
-- The payment preparer first creates an exact, server-derived nonce. A second
-- service-only RPC then binds one random Solana Pay reference to that nonce.
-- The original Stage-5 trigger correctly denied every binding change, but it
-- predated this one-time reference extension. The result was fail-closed but
-- unusable: preparation succeeded while the QR path always returned
-- `solana_pay_binding_unavailable`.
--
-- This replacement still denies every ordinary field mutation. It allows only
-- an unconsumed, unexpired payment nonce with no prior `solana_pay` key to gain
-- the exact object recomputed from the immutable row. The caller cannot add an
-- extra key, alter any copied value, bind and consume in one update, replace a
-- reference, or bind a non-payment nonce.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create or replace function public.osi_v2_guard_nonce_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_core jsonb;
  new_core jsonb;
  expected_solana_pay jsonb;
  solana_pay_binding_added boolean := false;
begin
  -- Consumption fields and updated_at are checked separately. Binding context
  -- is separated so the single permitted additive transition can be proven
  -- exactly rather than exempting the whole JSON document.
  old_core := to_jsonb(old) - array[
    'binding_context',
    'consumed_at',
    'consumed_by_receipt_id',
    'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'binding_context',
    'consumed_at',
    'consumed_by_receipt_id',
    'updated_at'
  ];

  if new_core is distinct from old_core then
    raise exception 'Nonce purpose, actor, target, payload and expiry are immutable'
      using errcode = '55000';
  end if;

  if new.binding_context is distinct from old.binding_context then
    expected_solana_pay := jsonb_build_object(
      'reference', new.binding_context->'solana_pay'->>'reference',
      'network', 'mainnet-beta',
      'nonce', old.nonce,
      'purpose', old.purpose,
      'payer_wallet', old.actor_wallet,
      'payment_kind', old.binding_context->>'payment_kind',
      'target_type', old.target_type,
      'target_id', old.target_id,
      'target_public_ref', old.binding_context->>'target_public_ref',
      'recipient_manifest', old.binding_context->'recipient_manifest',
      'manifest_hash', old.binding_context->>'manifest_hash',
      'total_lamports', old.binding_context->>'total_lamports',
      'memo', old.binding_context->>'memo',
      'payload_hash', old.payload_hash,
      'expires_at', old.expires_at,
      'idempotency_key', old.idempotency_key
    );

    solana_pay_binding_added :=
      current_user in ('postgres', 'service_role', 'supabase_admin')
      and old.purpose in (
        'REWARD_PAYMENT_CONFIRMED',
        'SUPPORT_PAYMENT_CONFIRMED'
      )
      and old.target_type in ('reward', 'support')
      and old.consumed_at is null
      and old.consumed_by_receipt_id is null
      and new.consumed_at is null
      and new.consumed_by_receipt_id is null
      and old.expires_at > statement_timestamp()
      and not (old.binding_context ? 'solana_pay')
      and jsonb_typeof(new.binding_context->'solana_pay') = 'object'
      and new.binding_context = old.binding_context
        || jsonb_build_object('solana_pay', expected_solana_pay);

    if solana_pay_binding_added is distinct from true then
      raise exception 'Nonce purpose, actor, target, payload and expiry are immutable'
        using errcode = '55000';
    end if;
  end if;

  if old.consumed_at is not null
     and (
       new.consumed_at is distinct from old.consumed_at
       or new.consumed_by_receipt_id
         is distinct from old.consumed_by_receipt_id
     ) then
    raise exception 'Consumed nonce cannot be reused or repointed'
      using errcode = '55000';
  end if;

  if old.consumed_at is null
     and (
       (new.consumed_at is null) <>
       (new.consumed_by_receipt_id is null)
     ) then
    raise exception 'Nonce consumption timestamp and receipt must advance together'
      using errcode = '23514';
  end if;

  return new;
end
$$;

revoke all privileges on function public.osi_v2_guard_nonce_update()
  from public, anon, authenticated;
grant execute on function public.osi_v2_guard_nonce_update()
  to service_role;

comment on function public.osi_v2_guard_nonce_update() is
  'Stage-5 nonce immutability guard. Allows only one exact service-bound Solana Pay reference to be added to a live unconsumed payment nonce; all other bindings remain immutable.';

commit;
