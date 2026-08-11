-- Launch-completion boundary tests for Solana Pay reference binding and the
-- private, full-maintainer-only AI Pack generation mode.

begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

select is(
  (select value from public.osi_config where key = 'OSI_V2_SOLANA_PAY_ENABLED'),
  'false',
  'Solana Pay is fail-closed until the post-deployment production gate'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_AI_PACK_ACCESS_MODE'),
  'maintainer_only',
  'AI Pack defaults to the explicit maintainer-only access mode'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED'),
  'false',
  'AI Pack review and publication remain disabled'
);

select ok(
  exists (
    select 1
      from pg_constraint
     where conname = 'osi_nonces_solana_pay_binding_check'
       and convalidated
  ),
  'the exact Solana Pay binding constraint is installed and validated'
);
select ok(
  exists (
    select 1
      from pg_indexes
     where schemaname = 'public'
       and indexname = 'osi_nonces_solana_pay_reference_unique'
       and indexdef like '%UNIQUE INDEX%'
       and indexdef like '%solana_pay%'
  ),
  'a partial unique reference index prevents cross-intent reuse'
);

select throws_ok(
  $$insert into public.osi_nonces (
      nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
      idempotency_key, request_fingerprint_hash, binding_context,
      issued_at, expires_at
    ) values (
      repeat('n', 32), 'SUPPORT_PAYMENT_CONFIRMED',
      '11111111111111111111111111111111', 'support',
      '00000000-0000-4000-8000-000000000001', repeat('0', 64),
      'solana-pay-null-fixture-20260728', repeat('1', 64),
      '{"solana_pay":{"reference":null}}'::jsonb,
      statement_timestamp(), statement_timestamp() + interval '60 seconds'
    )$$,
  '23514',
  'new row for relation "osi_nonces" violates check constraint "osi_nonces_solana_pay_binding_check"',
  'missing or JSON-null reference bindings cannot bypass the exact constraint'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.osi_v2_bind_payment_reference(text,text)',
    'EXECUTE'
  ),
  'only the trusted service path can bind a payment reference'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.osi_v2_bind_payment_reference(text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.osi_v2_bind_payment_reference(text,text)',
    'EXECUTE'
  ),
  'browser roles cannot bind payment references'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.osi_v2_find_payment_by_reference(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.osi_v2_find_payment_by_reference(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.osi_v2_find_payment_by_reference(text)',
    'EXECUTE'
  ),
  'reference polling lookup is service-only'
);

select throws_ok(
  $$select * from public.osi_v2_bind_payment_reference(
    'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn',
    '11111111111111111111111111111111'
  )$$,
  '55000',
  'OSI V2 Solana Pay is disabled',
  'a disabled rollout fails before reference or nonce discovery'
);

-- The launch migration originally had only the disabled-path assertion above.
-- Exercise the real one-time transition so a future immutable-nonce guard
-- cannot silently make the enabled Solana Pay path unusable again.
update public.osi_config
   set value = 'true'
 where key = 'OSI_V2_SOLANA_PAY_ENABLED';

insert into public.osi_nonces (
  nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
  idempotency_key, request_fingerprint_hash, binding_context,
  issued_at, expires_at
) values (
  repeat('p', 32),
  'SUPPORT_PAYMENT_CONFIRMED',
  '11111111111111111111111111111112',
  'support',
  '00000000-0000-4000-8000-000000000028',
  repeat('a', 64),
  'solana-pay-positive-binding-20260811',
  repeat('b', 64),
  jsonb_build_object(
    'payment_kind', 'support',
    'target_public_ref', 'OSI-AN-A1B2C3D4E5F60718',
    'recipient_manifest', jsonb_build_array(jsonb_build_object(
      'ordinal', 1,
      'wallet', '11111111111111111111111111111113',
      'recipient_type', 'analyst',
      'target_ref', 'OSI-AN-A1B2C3D4E5F60718',
      'amount_lamports', '1000000'
    )),
    'manifest_hash', repeat('c', 64),
    'total_lamports', '1000000',
    'memo', 'OSI2|1|SUPPORT_PAYMENT_CONFIRMED|test'
  ),
  statement_timestamp(),
  statement_timestamp() + interval '120 seconds'
);

set local role service_role;
select is(
  (
    select solana_pay_reference
      from public.osi_v2_bind_payment_reference(
        repeat('p', 32),
        '11111111111111111111111111111114'
      )
  ),
  '11111111111111111111111111111114',
  'a live unconsumed exact payment nonce accepts one service-bound reference'
);
reset role;

select is(
  (
    select idempotent_replay
      from public.osi_v2_bind_payment_reference(
        repeat('p', 32),
        '11111111111111111111111111111114'
      )
  ),
  true,
  'the same reference is an idempotent replay and does not mutate the nonce'
);

select throws_ok(
  $$select * from public.osi_v2_bind_payment_reference(
    repeat('p', 32),
    '11111111111111111111111111111115'
  )$$,
  '23514',
  'Payment nonce already has another Solana Pay reference',
  'a second reference cannot replace the exact bound reference'
);

select throws_ok(
  $$update public.osi_nonces
       set binding_context = jsonb_set(
         binding_context,
         '{solana_pay,network}',
         '"devnet"'::jsonb
       )
     where nonce = repeat('p', 32)$$,
  '55000',
  'Nonce purpose, actor, target, payload and expiry are immutable',
  'the one-time exception cannot alter any bound Solana Pay field'
);

select throws_ok(
  $$update public.osi_nonces
       set binding_context = jsonb_set(
         binding_context,
         '{solana_pay,unexpected}',
         'true'::jsonb
       )
     where nonce = repeat('p', 32)$$,
  '55000',
  'Nonce purpose, actor, target, payload and expiry are immutable',
  'the one-time exception cannot add an unbound Solana Pay field'
);

insert into public.event_receipts (
  id, event_version, event_type, target_type, target_id, public_ref,
  actor_wallet, actor_role, decision, proof_type, memo_ref, anchor_wallet,
  payload_hash, nonce, tx_sig, server_verified, occurred_at,
  verification_metadata
) values (
  '00000000-0000-4000-8000-000000000030',
  'OSI2',
  'SUPPORT_PAYMENT_CONFIRMED',
  'support',
  '00000000-0000-4000-8000-000000000028',
  'OSI-AN-A1B2C3D4E5F60718',
  '11111111111111111111111111111112',
  'wallet',
  'sent',
  'solana_memo',
  'OSI2|1|SUPPORT_PAYMENT_CONFIRMED|test',
  '11111111111111111111111111111112',
  repeat('a', 64),
  repeat('p', 32),
  repeat('2', 64),
  true,
  statement_timestamp(),
  jsonb_build_object(
    'cluster', 'mainnet-beta',
    'finality', 'finalized',
    'slot', '1',
    'total_lamports', '1000000',
    'recipient_manifest', jsonb_build_array(jsonb_build_object(
      'ordinal', 1,
      'wallet', '11111111111111111111111111111113',
      'recipient_type', 'analyst',
      'target_ref', 'OSI-AN-A1B2C3D4E5F60718',
      'amount_lamports', '1000000'
    ))
  )
);

select lives_ok(
  $$update public.osi_nonces
       set consumed_at = statement_timestamp(),
           consumed_by_receipt_id = '00000000-0000-4000-8000-000000000030'
     where nonce = repeat('p', 32)$$,
  'normal atomic consumption remains valid after the reference is bound'
);

set constraints all immediate;
select ok(
  (
    select consumed_at is not null
      and consumed_by_receipt_id = '00000000-0000-4000-8000-000000000030'
      and binding_context->'solana_pay'->>'reference'
        = '11111111111111111111111111111114'
      from public.osi_nonces
     where nonce = repeat('p', 32)
  ),
  'consumption preserves the exact immutable Solana Pay reference'
);
set constraints all deferred;

select throws_ok(
  $$select * from public.osi_v2_bind_payment_reference(
    repeat('p', 32),
    '11111111111111111111111111111114'
  )$$,
  '23514',
  'Payment nonce cannot be bound to Solana Pay',
  'a consumed nonce cannot be rebound even to the same reference'
);

insert into public.osi_nonces (
  nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
  idempotency_key, request_fingerprint_hash, binding_context,
  issued_at, expires_at
) values (
  repeat('m', 32),
  'SUPPORT_PAYMENT_CONFIRMED',
  '11111111111111111111111111111112',
  'support',
  '00000000-0000-4000-8000-000000000031',
  repeat('1', 64),
  'solana-pay-multiple-recipient-20260811',
  repeat('2', 64),
  jsonb_build_object(
    'payment_kind', 'support',
    'target_public_ref', 'OSI-AN-A1B2C3D4E5F60718',
    'recipient_manifest', jsonb_build_array(
      jsonb_build_object('ordinal', 1, 'wallet', '11111111111111111111111111111113', 'recipient_type', 'analyst', 'target_ref', 'OSI-AN-A1B2C3D4E5F60718', 'amount_lamports', '1'),
      jsonb_build_object('ordinal', 2, 'wallet', '11111111111111111111111111111114', 'recipient_type', 'analyst', 'target_ref', 'OSI-AN-A1B2C3D4E5F60718', 'amount_lamports', '1')
    ),
    'manifest_hash', repeat('3', 64),
    'total_lamports', '2',
    'memo', 'OSI2|1|SUPPORT_PAYMENT_CONFIRMED|multiple'
  ),
  statement_timestamp(),
  statement_timestamp() + interval '120 seconds'
);

select throws_ok(
  $$update public.osi_nonces
       set binding_context = binding_context || '{"unexpected":true}'::jsonb
     where nonce = repeat('m', 32)$$,
  '55000',
  'Nonce purpose, actor, target, payload and expiry are immutable',
  'the first binding transition cannot smuggle an unrelated top-level context key'
);

select throws_ok(
  $$select * from public.osi_v2_bind_payment_reference(
    repeat('m', 32),
    '11111111111111111111111111111116'
  )$$,
  '23514',
  'Payment nonce cannot be bound to Solana Pay',
  'a multi-recipient intent remains Phantom-only'
);

insert into public.osi_nonces (
  nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
  idempotency_key, request_fingerprint_hash, binding_context,
  issued_at, expires_at
) values (
  repeat('q', 32),
  'CHALLENGE_SUBMITTED',
  '11111111111111111111111111111112',
  'challenge',
  '00000000-0000-4000-8000-000000000032',
  repeat('4', 64),
  'solana-pay-non-payment-20260811',
  repeat('5', 64),
  '{}'::jsonb,
  statement_timestamp(),
  statement_timestamp() + interval '120 seconds'
);

select throws_ok(
  $$update public.osi_nonces
       set binding_context = jsonb_build_object(
         'solana_pay',
         jsonb_build_object('reference', '11111111111111111111111111111116')
       )
     where nonce = repeat('q', 32)$$,
  '55000',
  'Nonce purpose, actor, target, payload and expiry are immutable',
  'a non-payment nonce cannot use the binding exception'
);

insert into public.osi_nonces (
  nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
  idempotency_key, request_fingerprint_hash, binding_context,
  issued_at, expires_at
) values (
  repeat('x', 32),
  'SUPPORT_PAYMENT_CONFIRMED',
  '11111111111111111111111111111112',
  'support',
  '00000000-0000-4000-8000-000000000029',
  repeat('d', 64),
  'solana-pay-expired-binding-20260811',
  repeat('e', 64),
  jsonb_build_object(
    'payment_kind', 'support',
    'target_public_ref', 'OSI-AN-A1B2C3D4E5F60718',
    'recipient_manifest', jsonb_build_array(jsonb_build_object(
      'ordinal', 1,
      'wallet', '11111111111111111111111111111113',
      'recipient_type', 'analyst',
      'target_ref', 'OSI-AN-A1B2C3D4E5F60718',
      'amount_lamports', '1000000'
    )),
    'manifest_hash', repeat('f', 64),
    'total_lamports', '1000000',
    'memo', 'OSI2|1|SUPPORT_PAYMENT_CONFIRMED|expired'
  ),
  statement_timestamp() - interval '120 seconds',
  statement_timestamp() - interval '60 seconds'
);

select throws_ok(
  $$select * from public.osi_v2_bind_payment_reference(
    repeat('x', 32),
    '11111111111111111111111111111116'
  )$$,
  '23514',
  'Payment nonce cannot be bound to Solana Pay',
  'an expired payment nonce cannot gain a reference'
);

update public.osi_config
   set value = 'false'
 where key = 'OSI_V2_SOLANA_PAY_ENABLED';

select is(
  osi_private.osi_v2_ai_pack_writes_enabled(),
  false,
  'private AI Pack generation is disabled by its dedicated write gate'
);
select is(
  osi_private.osi_v2_ai_pack_review_writes_enabled(),
  false,
  'review remains disabled in maintainer-only mode'
);

update public.osi_config
   set value = 'true'
 where key = 'OSI_V2_AI_PACK_WRITES_ENABLED';

select is(
  osi_private.osi_v2_ai_pack_writes_enabled(),
  true,
  'private generation can be enabled without broad V2 write or proof flags'
);
select is(
  osi_private.osi_v2_ai_pack_review_writes_enabled(),
  false,
  'enabling private generation cannot enable review or publication'
);
select is(
  (
    select bool_and(value = 'false')
      from public.osi_config
     where key in (
       'OSI_V2_WRITES_ENABLED',
       'OSI_V2_PROOF_ENABLED',
       'OSI_V2_FALLBACK_GOVERNANCE'
     )
  ),
  true,
  'broad, proof, and fallback controls remain independently fail-closed'
);

update public.osi_config
   set value = case key
     when 'OSI_V2_AI_PACK_ACCESS_MODE' then 'governed'
     when 'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED' then 'true'
     else value
   end
 where key in (
   'OSI_V2_AI_PACK_ACCESS_MODE',
   'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED'
 );

select is(
  osi_private.osi_v2_ai_pack_writes_enabled(),
  false,
  'governed mode cannot use the private generation gate'
);
select is(
  osi_private.osi_v2_ai_pack_review_writes_enabled(),
  true,
  'a future governed mode still requires both dedicated write flags'
);

select * from finish();
rollback;
