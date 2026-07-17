-- D19 SAS Verified Analyst credential gate: enforcement, fail-closed, bootstrap
-- isolation, lazy re-check, prospective-only, and telemetry immutability.
-- All writes run against the disposable local database and roll back.

begin;

create extension if not exists pgtap with schema extensions;
select plan(24);

-- ---- shipped flag defaults -------------------------------------------------
select is(
  (select value from public.osi_config where key = 'OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED'),
  'false',
  'enforcement ships OFF (the single most safety-critical default)'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_SAS_CREDENTIAL_ISSUANCE_ENABLED'),
  'true',
  'issuance ships live-capable'
);
select is(
  (select value from public.osi_config where key = 'OSI_V2_SAS_CREDENTIAL_PUBKEY'),
  '',
  'Step 0 credential pubkey seeded empty (fail-closed until published)'
);

-- ---- service-only exposure -------------------------------------------------
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.osi_v2_sas_review_verifications'::regclass),
  'per-review snapshot table forces RLS'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.osi_v2_sas_wallet_credentials'::regclass),
  'wallet credential cache forces RLS'
);
select isnt(
  has_table_privilege('authenticated', 'public.osi_v2_sas_review_verifications', 'SELECT'),
  true,
  'authenticated clients cannot read the per-review snapshot'
);
select ok(
  has_table_privilege('service_role', 'public.osi_v2_sas_review_verifications', 'SELECT'),
  'service_role may read the per-review snapshot'
);

-- ---- gate helper semantics -------------------------------------------------
select ok(
  osi_private.osi_v2_sas_review_counts('case_report', extensions.gen_random_uuid()),
  'gate is a tautology for ANY review when enforcement is off (identical to main)'
);
update public.osi_config set value = 'true' where key = 'OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED';
select ok(
  not osi_private.osi_v2_sas_review_counts('case_report', extensions.gen_random_uuid()),
  'gate excludes an unknown/unverified review when enforcement is on (fail-closed)'
);
update public.osi_config set value = 'false' where key = 'OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED';

-- ---- end-to-end case_review_quorum fixtures --------------------------------
insert into public.cases (id, public_ref, title, category, summary_public, submitted_by_wallet, stage)
values ('11111111-1111-1111-1111-111111111111', 'OSI-TESTCASE00000001', 'T', 'scam', 's',
  '11111111111111111111111111111111', 'initial_review');
insert into public.analyst_profiles (wallet, status, tier_code, verified, approved, weight_cached)
values ('AnaLystWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA111', 'probationary_analyst', 'probationary', true, true, 0.50);
insert into public.event_receipts (id, event_version, event_type, target_type, target_id, actor_wallet,
  actor_role, decision, weight, proof_type, payload_hash, nonce, signature, server_verified, occurred_at)
values ('22222222-2222-2222-2222-222222222222', 'OSI2', 'CASE_INITIAL_REVIEW_CAST', 'case',
  '11111111-1111-1111-1111-111111111111', 'AnaLystWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA111',
  'analyst', 'approve_open', 0.50, 'wallet_signed_server_verified', repeat('a', 64),
  repeat('n', 43), repeat('s', 88), true, now());
insert into public.case_initial_reviews (id, case_id, reviewer_wallet, decision, reviewer_role, weight,
  is_active, event_receipt_id)
values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
  'AnaLystWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA111', 'approve_open', 'analyst', 0.50, true,
  '22222222-2222-2222-2222-222222222222');
-- maintainer (D17 bootstrap channel) approval; weight 0
insert into public.event_receipts (id, event_version, event_type, target_type, target_id, actor_wallet,
  actor_role, decision, weight, proof_type, payload_hash, nonce, signature, server_verified, occurred_at)
values ('44444444-4444-4444-4444-444444444444', 'OSI2', 'CASE_INITIAL_REVIEW_CAST', 'case',
  '11111111-1111-1111-1111-111111111111', 'Maintainer1111111111111111111111111111111111',
  'maintainer', 'approve_open', null, 'wallet_signed_server_verified', repeat('b', 64),
  repeat('m', 43), repeat('s', 88), true, now());
insert into public.case_initial_reviews (id, case_id, reviewer_wallet, decision, reviewer_role, weight,
  is_active, event_receipt_id)
values ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111',
  'Maintainer1111111111111111111111111111111111', 'approve_open', 'maintainer', 0, true,
  '44444444-4444-4444-4444-444444444444');

-- Regression: enforcement OFF is identical to main (the analyst review counts).
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'enforcement OFF: analyst review counts (identical to main)'
);
select is(
  (select maintainer_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'enforcement OFF: maintainer approval counts'
);

update public.osi_config set value = 'true' where key = 'OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED';

-- Fail-closed: an analyst review with no verified snapshot no longer counts.
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  0::bigint,
  'enforcement ON: unverified analyst review is excluded (fail-closed)'
);
-- Bootstrap isolation: the maintainer channel is never gated, in either state.
select is(
  (select maintainer_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'enforcement ON: maintainer_bootstrap approval is unaffected by the gate'
);
select ok(
  (select ready from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  'enforcement ON: case still opens via the maintainer path (bootstrap isolated)'
);

-- RPC-failure handling / shadow: a pending_verification snapshot still excludes.
select is(
  osi_private.osi_v2_sas_record_review_verification('case_initial',
    '33333333-3333-3333-3333-333333333333', 'AnaLystWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA111',
    'pending_verification'),
  'pending_verification',
  'a review whose live check failed is recorded pending_verification'
);
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  0::bigint,
  'enforcement ON: pending_verification review does not count'
);

-- Lazy re-check: pending -> verified counts on the next quorum computation.
select is(
  osi_private.osi_v2_sas_record_review_verification('case_initial',
    '33333333-3333-3333-3333-333333333333', 'AnaLystWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA111', 'verified'),
  'verified',
  'lazy re-check resolves pending_verification to verified'
);
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'enforcement ON: a freshly verified review counts without a new submission'
);

-- Prospective-only / immutability: a resolved snapshot is never rewritten.
select is(
  osi_private.osi_v2_sas_record_review_verification('case_initial',
    '33333333-3333-3333-3333-333333333333', 'AnaLystWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA111', 'invalid'),
  'verified',
  'a resolved (verified) snapshot is immutable history and never downgrades'
);
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'a resolved review keeps counting; enforcement is prospective, not retroactive'
);

-- Bypass hook neutralizes the gate for the maintainer_bootstrap channel.
set local osi_v2.sas_bypass = 'on';
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'transaction-local bypass neutralizes the gate for bootstrap finalize compute'
);
set local osi_v2.sas_bypass = '';

-- Enforcement OFF again: still identical to main regardless of any snapshot.
update public.osi_config set value = 'false' where key = 'OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED';
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'enforcement OFF: quorum identical to main irrespective of credential state'
);

-- record helper rejects an unknown review kind.
select throws_ok(
  $$ select osi_private.osi_v2_sas_record_review_verification('bogus_kind',
       '33333333-3333-3333-3333-333333333333', 'AnaLystWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA111', 'verified') $$,
  '22023',
  null,
  'the snapshot recorder rejects an unknown review kind'
);

-- config knobs for the bounded verifier are present and in range.
select ok(
  osi_private.osi_v2_config_integer('OSI_V2_SAS_VERIFY_TIMEOUT_MS', 250, 60000) > 0,
  'bounded verify timeout config is present and valid'
);

select * from finish();
rollback;
