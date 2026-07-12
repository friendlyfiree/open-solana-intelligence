-- Run on a disposable local Supabase database:
--   supabase test db supabase/tests/osi_v2_stage5.sql
-- All writes are inside this transaction and are rolled back.

begin;

create extension if not exists pgtap with schema extensions;
select plan(13);

select is(
  (select value from public.osi_config where key = 'OSI_V2_PROOF_ENABLED'),
  'false',
  'proof infrastructure fails closed after migration'
);

select isnt(
  has_function_privilege(
    'authenticated',
    'public.osi_v2_issue_nonce(text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  true,
  'authenticated role cannot execute nonce issuer directly'
);

select isnt(
  has_schema_privilege('authenticated', 'osi_private', 'USAGE'),
  true,
  'authenticated role cannot access the private receipt helper schema'
);

update public.osi_config
   set value = 'true'
 where key = 'OSI_V2_PROOF_ENABLED';

select lives_ok(
  $test$
    select * from public.osi_v2_issue_nonce(
      repeat('a', 32),
      'CHALLENGE_SUBMITTED',
      '11111111111111111111111111111112',
      'challenge',
      '018f47ac-7d20-7b92-a323-7fc0f3f43c10',
      repeat('a', 64),
      'stage5-pgtap-action-0001',
      repeat('c', 64)
    )
  $test$,
  'first exact-bound nonce is issued'
);

select is(
  (
    select issued_nonce
    from public.osi_v2_issue_nonce(
      repeat('b', 32),
      'CHALLENGE_SUBMITTED',
      '11111111111111111111111111111112',
      'challenge',
      '018f47ac-7d20-7b92-a323-7fc0f3f43c10',
      repeat('a', 64),
      'stage5-pgtap-action-0001',
      repeat('d', 64)
    )
  ),
  repeat('a', 32),
  'idempotent retry returns the original nonce'
);

select throws_ok(
  $test$
    select * from public.osi_v2_issue_nonce(
      repeat('c', 32),
      'CHALLENGE_SUBMITTED',
      '11111111111111111111111111111112',
      'challenge',
      '018f47ac-7d20-7b92-a323-7fc0f3f43c10',
      repeat('b', 64),
      'stage5-pgtap-action-0001',
      repeat('c', 64)
    )
  $test$,
  '23514',
  'Idempotency key is already bound to another exact action',
  'idempotency key cannot bind a changed payload'
);

select lives_ok(
  $test$
    select * from osi_private.osi_v2_consume_signed_nonce(
      repeat('a', 32),
      repeat('A', 88),
      'wallet',
      null::text,
      null::numeric,
      null::text,
      null::text
    )
  $test$,
  'signed nonce is consumed into one receipt'
);

select is(
  (
    select count(*)::integer
    from public.event_receipts
    where nonce = repeat('a', 32)
  ),
  1,
  'first consumption creates exactly one receipt'
);

select is(
  (
    select idempotent_replay
    from osi_private.osi_v2_consume_signed_nonce(
      repeat('a', 32),
      repeat('A', 88),
      'wallet',
      null::text,
      null::numeric,
      null::text,
      null::text
    )
  ),
  true,
  'same signed retry returns the original effect'
);

select is(
  (
    select count(*)::integer
    from public.event_receipts
    where nonce = repeat('a', 32)
  ),
  1,
  'idempotent retry still has one receipt'
);

select throws_ok(
  $test$
    select * from osi_private.osi_v2_consume_signed_nonce(
      repeat('a', 32),
      repeat('B', 88),
      'wallet',
      null::text,
      null::numeric,
      null::text,
      null::text
    )
  $test$,
  '23514',
  'Consumed nonce cannot be replayed with changed receipt data',
  'consumed nonce rejects a changed signature'
);

select ok(
  (
    select server_verified = true
      and proof_type = 'wallet_signed_server_verified'
      and tx_sig is null
    from public.event_receipts
    where nonce = repeat('a', 32)
  ),
  'native signMessage receipt is verified but never labeled on-chain'
);

select throws_ok(
  $test$
    update public.osi_nonces
       set payload_hash = repeat('f', 64)
     where nonce = repeat('a', 32)
  $test$,
  '55000',
  'Nonce purpose, actor, target, payload and expiry are immutable',
  'nonce binding cannot be rewritten after issuance'
);

select * from finish();
rollback;
