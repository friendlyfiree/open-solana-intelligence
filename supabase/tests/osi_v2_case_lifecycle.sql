-- First native V2 Case lifecycle integration tests.
-- All writes run against the disposable local database and roll back.

begin;

create extension if not exists pgtap with schema extensions;
select plan(53);

select is(
  (select value from public.osi_config where key = 'OSI_V2_WRITES_ENABLED'),
  'false',
  'broad V2 writes remain disabled'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_PROOF_ENABLED'),
  'false',
  'broad V2 proof writes remain disabled'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_CASE_WRITES_ENABLED'),
  'true',
  'only the exact Case write slice is enabled'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.osi_read_nonces'::regclass),
  'durable read nonces have RLS enabled'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.osi_read_nonces'::regclass),
  'durable read nonces force RLS'
);
select isnt(
  has_table_privilege('authenticated', 'public.osi_read_nonces', 'SELECT'),
  true,
  'authenticated clients cannot read durable nonces'
);
select isnt(
  has_function_privilege(
    'anon',
    'public.osi_v2_issue_read_nonce(text,text,text,text,text,text)',
    'EXECUTE'
  ),
  true,
  'anonymous clients cannot issue read nonces'
);
select isnt(
  has_function_privilege(
    'authenticated',
    'public.osi_v2_commit_case_submission(text,text,text,text,text,text,bigint,jsonb,text,text,timestamptz)',
    'EXECUTE'
  ),
  true,
  'authenticated clients cannot commit a Case directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.osi_v2_commit_case_submission(text,text,text,text,text,text,bigint,jsonb,text,text,timestamptz)',
    'EXECUTE'
  ),
  'trusted service role can reach the Case commit wrapper'
);

select lives_ok(
  $test$
    select * from public.osi_v2_issue_read_nonce(
      repeat('r', 32), 'CASE_READ_AUTHORIZED_CASE',
      '11111111111111111111111111111112', 'case', 'OSI-READTEST01',
      repeat('1', 64)
    )
  $test$,
  'a durable exact-bound read nonce is issued'
);
select is(
  (
    select public.osi_v2_consume_read_nonce(
      repeat('r', 32), 'CASE_READ_AUTHORIZED_CASE',
      '11111111111111111111111111111112', 'case', 'OSI-READTEST01'
    )
  ),
  true,
  'first exact read proof consumes the nonce atomically'
);
select is(
  (
    select public.osi_v2_consume_read_nonce(
      repeat('r', 32), 'CASE_READ_AUTHORIZED_CASE',
      '11111111111111111111111111111112', 'case', 'OSI-READTEST01'
    )
  ),
  false,
  'read proof replay is denied across requests and instances'
);
select throws_ok(
  $test$
    update public.osi_read_nonces
       set target_id = 'OSI-CHANGED'
     where nonce = repeat('r', 32)
  $test$,
  '55000',
  'Read nonce binding and expiry are immutable',
  'read nonce binding cannot be rewritten'
);

select lives_ok(
  $test$
    insert into public.analyst_profiles (
      wallet, status, tier_code, verified, approved, weight_cached
    ) values (
      '22222222222222222222222222222222',
      'probationary_analyst', 'probationary', true, true, 0.50
    )
  $test$,
  'an eligible analyst fixture is created with the minimum live weight'
);

select lives_ok(
  $test$
    select * from public.osi_v2_issue_case_nonce(
      repeat('s', 32), 'CASE_SUBMITTED',
      '11111111111111111111111111111112', 'owner', null,
      repeat('a', 64), 'case-submit-pgtap-0001', repeat('2', 64)
    )
  $test$,
  'owner receives an exact-bound Case submission nonce'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_case_submission(
      repeat('s', 32), repeat('a', 64),
      'Neutral wallet incident review', 'wallet_drain',
      'A neutral public summary long enough for the native Case intake path.',
      'Restricted context visible only to the owner and authorized reviewers.',
      1000000000,
      jsonb_build_array(jsonb_build_object(
        'kind', 'wallet',
        'ref', '11111111111111111111111111111112',
        'sha256', repeat('1', 64)
      )),
      repeat('T', 88), 'OSI2 test CASE_SUBMITTED memo', statement_timestamp()
    )
  $test$,
  'confirmed submission proof creates the private Case atomically'
);
select is(
  (
    select stage || ':' || visibility from public.cases
     where id = (select target_id::uuid from public.osi_nonces where nonce = repeat('s', 32))
  ),
  'initial_review:private',
  'new Case is private and awaiting initial review'
);
select is(
  (
    select details_restricted from public.cases
     where id = (select target_id::uuid from public.osi_nonces where nonce = repeat('s', 32))
  ),
  'Restricted context visible only to the owner and authorized reviewers.',
  'restricted intake detail is stored separately from the public summary'
);
select ok(
  (
    select bool_and(e.is_public is false and e.moderation_state = 'pending')
      from public.evidence_items e
      join public.case_evidence_links l on l.evidence_item_id = e.id
     where l.case_id = (select target_id::uuid from public.osi_nonces where nonce = repeat('s', 32))
  ),
  'submitted evidence is private and pending by default'
);
select ok(
  (
    select r.proof_type = 'solana_memo'
       and r.server_verified is true
       and r.tx_sig = repeat('T', 88)
      from public.event_receipts r
     where r.nonce = repeat('s', 32)
  ),
  'submission receipt is honestly labeled as a verified Solana Memo'
);
select is(
  (
    select idempotent_replay from public.osi_v2_commit_case_submission(
      repeat('s', 32), repeat('a', 64),
      'Neutral wallet incident review', 'wallet_drain',
      'A neutral public summary long enough for the native Case intake path.',
      'Restricted context visible only to the owner and authorized reviewers.',
      1000000000, '[]'::jsonb,
      repeat('T', 88), 'OSI2 test CASE_SUBMITTED memo', statement_timestamp()
    )
  ),
  true,
  'submission retry returns the original result without a duplicate effect'
);
select throws_ok(
  $test$
    select * from public.osi_v2_issue_case_nonce(
      repeat('o', 32), 'CASE_INITIAL_REVIEW_CAST',
      '11111111111111111111111111111112', 'analyst',
      (select target_id from public.osi_nonces where nonce = repeat('s', 32)),
      repeat('b', 64), 'case-owner-review-0001', repeat('3', 64)
    )
  $test$,
  '42501',
  'Case owner cannot review or open the same Case',
  'Case owner cannot self-review at the database boundary'
);

select lives_ok(
  $test$
    select * from public.osi_v2_issue_case_nonce(
      repeat('m', 32), 'CASE_INITIAL_REVIEW_CAST',
      '33333333333333333333333333333333', 'maintainer',
      (select target_id from public.osi_nonces where nonce = repeat('s', 32)),
      repeat('c', 64), 'case-maint-review-0001', repeat('4', 64)
    )
  $test$,
  'full maintainer route can issue an initial approval nonce'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_case_review(
      repeat('m', 32), repeat('c', 64), repeat('M', 88),
      'maintainer', 'approve_open', 'public_scope_clear'
    )
  $test$,
  'full maintainer approve_open review is recorded'
);
select is(
  (
    select weight from public.case_initial_reviews
     where reviewer_wallet = '33333333333333333333333333333333'
  ),
  0.00::numeric,
  'full maintainer review carries zero analyst voting weight'
);
select ok(
  (
    select maintainer_ready and ready and not analyst_ready
      from osi_private.osi_v2_case_review_quorum(
      (select target_id::uuid from public.osi_nonces where nonce = repeat('s', 32))
    )
  ),
  'full maintainer is an independent ready path without fabricating analyst quorum'
);

select lives_ok(
  $test$
    select * from public.osi_v2_issue_case_nonce(
      repeat('v', 32), 'CASE_INITIAL_REVIEW_CAST',
      '22222222222222222222222222222222', 'analyst',
      (select target_id from public.osi_nonces where nonce = repeat('s', 32)),
      repeat('d', 64), 'case-analyst-review-0001', repeat('5', 64)
    )
  $test$,
  'eligible independent analyst receives a review nonce'
);
select throws_ok(
  $test$
    select * from public.osi_v2_issue_case_nonce(
      repeat('w', 32), 'CASE_INITIAL_REVIEW_CAST',
      '22222222222222222222222222222222', 'analyst',
      '018f47ac-7d20-7b92-a323-7fc0f3f43c10',
      repeat('d', 64), 'case-analyst-review-0001', repeat('6', 64)
    )
  $test$,
  '23514',
  'Idempotency key is bound to another exact Case action',
  'idempotency cannot be replayed against a changed target'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_case_review(
      repeat('v', 32), repeat('d', 64), repeat('A', 88),
      'analyst', 'approve_open', 'public_scope_clear'
    )
  $test$,
  'eligible analyst records a server-verified typed review'
);
select is(
  (
    select analyst_count from osi_private.osi_v2_case_review_quorum(
      (select target_id::uuid from public.osi_nonces where nonce = repeat('s', 32))
    )
  ),
  1::bigint,
  'quorum count gate sees exactly one eligible analyst'
);
select is(
  (
    select total_weight from osi_private.osi_v2_case_review_quorum(
      (select target_id::uuid from public.osi_nonces where nonce = repeat('s', 32))
    )
  ),
  0.50::numeric,
  'quorum weight gate uses the server-derived minimum analyst weight'
);
select is(
  (
    select ready from osi_private.osi_v2_case_review_quorum(
      (select target_id::uuid from public.osi_nonces where nonce = repeat('s', 32))
    )
  ),
  true,
  'count and weight gates must both pass before opening'
);

select lives_ok(
  $test$
    select * from public.osi_v2_issue_case_nonce(
      repeat('x', 32), 'CASE_INITIAL_REVIEW_REVISED',
      '22222222222222222222222222222222', 'analyst',
      (select target_id from public.osi_nonces where nonce = repeat('s', 32)),
      repeat('e', 64), 'case-review-reject-0001', repeat('7', 64)
    )
  $test$,
  'review revision nonce remains available for supported decisions'
);
select throws_ok(
  $test$
    select * from public.osi_v2_commit_case_review(
      repeat('x', 32), repeat('e', 64), repeat('B', 88),
      'analyst', 'reject', 'unsafe_or_prohibited'
    )
  $test$,
  '55000',
  'Initial rejection outcome is not enabled in this Case slice',
  'unfinished rejection outcome fails closed at the database boundary'
);

select lives_ok(
  $test$
    select * from public.osi_v2_issue_case_nonce(
      repeat('p', 32), 'CASE_OPENED',
      '22222222222222222222222222222222', 'analyst',
      (select target_id from public.osi_nonces where nonce = repeat('s', 32)),
      repeat('f', 64), 'case-public-open-0001', repeat('8', 64)
    )
  $test$,
  'the counted approving analyst receives the exact public-open nonce'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_case_open(
      repeat('p', 32), repeat('f', 64), repeat('U', 88),
      'OSI2 test CASE_OPENED memo', statement_timestamp()
    )
  $test$,
  'confirmed open proof performs the public transition atomically'
);
select is(
  (
    select stage || ':' || visibility from public.cases
     where id = (select target_id::uuid from public.osi_nonces where nonce = repeat('s', 32))
  ),
  'open_public:public',
  'Case becomes public only after counted review and canonical open proof'
);
select ok(
  (
    select c.opened_receipt_id = r.id
       and r.event_type = 'CASE_OPENED'
       and r.proof_type = 'solana_memo'
       and r.server_verified is true
      from public.cases c
      join public.event_receipts r on r.id = c.opened_receipt_id
     where c.id = (select target_id::uuid from public.osi_nonces where nonce = repeat('s', 32))
  ),
  'public Case is permanently bound to its verified opening receipt'
);
select is(
  (
    select idempotent_replay from public.osi_v2_commit_case_open(
      repeat('p', 32), repeat('f', 64), repeat('U', 88),
      'OSI2 test CASE_OPENED memo', statement_timestamp()
    )
  ),
  true,
  'public-open retry returns the original result'
);
select is(
  (
    select count(*)::integer from public.event_receipts
     where target_id = (select target_id from public.osi_nonces where nonce = repeat('s', 32))
  ),
  4,
  'submission, maintainer review, analyst review, and opening each have one receipt'
);
select throws_ok(
  $test$
    update public.cases
       set details_restricted = 'rewritten private content'
     where id = (select target_id::uuid from public.osi_nonces where nonce = repeat('s', 32))
  $test$,
  '55000',
  'Submitted Case content and submission receipt are immutable',
  'submitted restricted content cannot be rewritten'
);

-- A second Case proves the full-maintainer path can perform the actual open
-- without any analyst profile. The Edge boundary supplies the maintainer role
-- only after both wallet and Supabase auth gates pass; these service-role RPC
-- fixtures exercise the durable database half of that verified server path.
select lives_ok(
  $test$
    select * from public.osi_v2_issue_case_nonce(
      repeat('k', 32), 'CASE_SUBMITTED',
      '44444444444444444444444444444444', 'owner', null,
      repeat('9', 64), 'case-maint-submit-0002', repeat('9', 64)
    )
  $test$,
  'second owner receives a maintainer-path Case submission nonce'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_case_submission(
      repeat('k', 32), repeat('9', 64),
      'Maintainer initial open fixture', 'other',
      'A neutral public summary for the independent full maintainer opening path.',
      'Private maintainer-path fixture detail that must not leak publicly.',
      null, '[]'::jsonb,
      repeat('V', 88), 'OSI2 second CASE_SUBMITTED memo', statement_timestamp()
    )
  $test$,
  'second private Case is committed for the full maintainer path'
);
select is(
  (select count(*)::integer from public.analyst_profiles
    where wallet = '33333333333333333333333333333333'),
  0,
  'full maintainer fixture has no analyst profile'
);
select lives_ok(
  $test$
    select * from public.osi_v2_issue_case_nonce(
      repeat('j', 32), 'CASE_INITIAL_REVIEW_CAST',
      '33333333333333333333333333333333', 'maintainer',
      (select target_id from public.osi_nonces where nonce = repeat('k', 32)),
      repeat('8', 64), 'case-maint-review-0002', repeat('8', 64)
    )
  $test$,
  'full maintainer without an analyst profile receives a review nonce'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_case_review(
      repeat('j', 32), repeat('8', 64), repeat('N', 88),
      'maintainer', 'approve_open', 'public_scope_clear'
    )
  $test$,
  'full maintainer without an analyst profile commits approve_open'
);
select ok(
  (
    select review.weight = 0
       and receipt.actor_role = 'maintainer'
       and receipt.proof_type = 'wallet_signed_server_verified'
       and receipt.server_verified is true
      from public.case_initial_reviews as review
      join public.event_receipts as receipt on receipt.id = review.event_receipt_id
     where review.case_id = (select target_id::uuid from public.osi_nonces where nonce = repeat('k', 32))
       and review.reviewer_wallet = '33333333333333333333333333333333'
       and review.is_active = true
  ),
  'maintainer review receipt has exact actor role, zero weight, and wallet proof type'
);
select lives_ok(
  $test$
    select * from public.osi_v2_issue_case_nonce(
      repeat('z', 32), 'CASE_OPENED',
      '33333333333333333333333333333333', 'maintainer',
      (select target_id from public.osi_nonces where nonce = repeat('k', 32)),
      repeat('7', 64), 'case-maint-open-0002', repeat('7', 64)
    )
  $test$,
  'full maintainer receives the exact CASE_OPENED nonce for its approved Case'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_case_open(
      repeat('z', 32), repeat('7', 64), repeat('W', 88),
      'OSI2 maintainer CASE_OPENED memo', statement_timestamp()
    )
  $test$,
  'full maintainer canonical proof opens the Case without an analyst profile'
);
select is(
  (
    select stage || ':' || visibility from public.cases
     where id = (select target_id::uuid from public.osi_nonces where nonce = repeat('k', 32))
  ),
  'open_public:public',
  'full maintainer path performs the public transition'
);
select ok(
  (
    select receipt.actor_wallet = '33333333333333333333333333333333'
       and receipt.actor_role = 'maintainer'
       and receipt.anchor_wallet = receipt.actor_wallet
       and receipt.event_type = 'CASE_OPENED'
       and receipt.proof_type = 'solana_memo'
       and receipt.server_verified is true
      from public.cases as case_row
      join public.event_receipts as receipt on receipt.id = case_row.opened_receipt_id
     where case_row.id = (select target_id::uuid from public.osi_nonces where nonce = repeat('k', 32))
  ),
  'maintainer CASE_OPENED receipt binds the exact Case, actor, role, and Memo proof'
);
select is(
  (
    select idempotent_replay from public.osi_v2_commit_case_open(
      repeat('z', 32), repeat('7', 64), repeat('W', 88),
      'OSI2 maintainer CASE_OPENED memo', statement_timestamp()
    )
  ),
  true,
  'maintainer CASE_OPENED replay returns the original result without duplication'
);
select throws_ok(
  $test$
    select * from public.osi_v2_commit_case_open(
      repeat('z', 32), repeat('6', 64), repeat('W', 88),
      'OSI2 maintainer CASE_OPENED memo', statement_timestamp()
    )
  $test$,
  '23514',
  'Open nonce binding is invalid',
  'maintainer CASE_OPENED nonce rejects a different payload hash'
);

select * from finish();
rollback;
