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
