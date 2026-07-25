-- D19 Step 4: enforcement is real. Exercises the live quorum functions against
-- real review rows, with the on-chain answer mocked as the snapshot state the
-- verifier would have recorded. All writes run against the disposable local
-- database and roll back.

begin;

create extension if not exists pgtap with schema extensions;
select plan(38);

-- Real base58 coordinates, so the published-credential binding is exercised.
create temporary table sas_fixture (credential text, schema text, issuer text, rotated text);
insert into sas_fixture values (
  'So11111111111111111111111111111111111111112',
  'SysvarC1ock11111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111'
);

-- ---------------------------------------------------------------------------
-- Fixtures: one Case, one analyst approve_open, one maintainer approve_open.
-- ---------------------------------------------------------------------------
insert into public.cases (id, public_ref, title, category, summary_public, submitted_by_wallet, stage)
values ('11111111-1111-1111-1111-111111111111', 'OSI-SASENF0000000001', 'T', 'scam', 's',
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

-- ---------------------------------------------------------------------------
-- 1. Flag OFF is a tautology, whatever any snapshot says.
-- ---------------------------------------------------------------------------
select is(
  (select value from public.osi_config where key = 'OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED'),
  'false',
  'enforcement still ships OFF after the Step 4 migration'
);
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'flag OFF: the analyst review counts, identical to main'
);
select ok(
  osi_private.osi_v2_sas_review_counts('case_report', extensions.gen_random_uuid()),
  'flag OFF: the predicate is a tautology for any review at all'
);
select is(
  (select count(*)::bigint from osi_private.osi_v2_sas_reviews_needing_recheck(
    'case', '11111111-1111-1111-1111-111111111111')),
  0::bigint,
  'flag OFF: the re-check worklist is empty, so no on-chain read is ever planned'
);
select is(
  (select verification_state from osi_private.osi_v2_sas_review_authority(
    'case_initial', array['33333333-3333-3333-3333-333333333333'::uuid])),
  'not_enforced',
  'flag OFF: the authority projection claims no credential check'
);
select ok(
  not (select enforcement_enabled from osi_private.osi_v2_sas_review_authority(
    'case_initial', array['33333333-3333-3333-3333-333333333333'::uuid])),
  'flag OFF: the surface is told enforcement is off rather than guessing'
);

-- ---------------------------------------------------------------------------
-- 2. Flag ON, SAS unconfigured: fail closed, never invent authority.
-- ---------------------------------------------------------------------------
update public.osi_config set value = 'true' where key = 'OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED';

select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  0::bigint,
  'flag ON with SAS unconfigured: the analyst review contributes zero'
);
select is(
  (select total_weight from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  0::numeric,
  'flag ON with SAS unconfigured: the analyst review contributes zero weight'
);
select is(
  (select maintainer_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'the maintainer channel carries weight zero and is never credential gated'
);

-- Even a snapshot recorded verified cannot count while SAS is unconfigured.
select is(
  osi_private.osi_v2_sas_record_review_verification('case_initial',
    '33333333-3333-3333-3333-333333333333', 'AnaLystWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA111', 'verified'),
  'verified',
  'a snapshot can be recorded verified even before Step 0 coordinates exist'
);
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  0::bigint,
  'unconfigured SAS still counts nothing: a snapshot with no coordinates is not authority'
);

-- ---------------------------------------------------------------------------
-- 3. Flag ON, SAS published: only a live verified snapshot counts.
-- ---------------------------------------------------------------------------
update public.osi_config set value = (select credential from sas_fixture)
  where key = 'OSI_V2_SAS_CREDENTIAL_PUBKEY';
update public.osi_config set value = (select schema from sas_fixture)
  where key = 'OSI_V2_SAS_SCHEMA_PUBKEY';
update public.osi_config set value = (select issuer from sas_fixture)
  where key = 'OSI_V2_SAS_ISSUER_PUBKEY';

select ok(
  osi_private.osi_v2_sas_configured(),
  'SAS is now fully configured'
);
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  0::bigint,
  'a snapshot taken without the published coordinates does not count'
);
select is(
  (select count(*)::bigint from osi_private.osi_v2_sas_reviews_needing_recheck(
    'case', '11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'that review appears on the re-check worklist so a live read can settle it'
);
select is(
  (select reviewer_wallet from osi_private.osi_v2_sas_reviews_needing_recheck(
    'case', '11111111-1111-1111-1111-111111111111')),
  'AnaLystWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA111',
  'the worklist never lists the maintainer row, only genuine analyst reviews'
);

-- The live on-chain read comes back verified under the published coordinates.
select is(
  osi_private.osi_v2_sas_record_review_verification('case_initial',
    '33333333-3333-3333-3333-333333333333', 'AnaLystWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA111',
    'verified',
    (select credential from sas_fixture), (select schema from sas_fixture), (select issuer from sas_fixture)),
  'verified',
  'the lazy re-check replaces a coordinate-less snapshot with the live answer'
);
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'flag ON with a live verified credential: the review counts'
);
select is(
  (select total_weight from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  0.50::numeric,
  'flag ON with a live verified credential: the review carries its full weight'
);
select is(
  (select count(*)::bigint from osi_private.osi_v2_sas_reviews_needing_recheck(
    'case', '11111111-1111-1111-1111-111111111111')),
  0::bigint,
  'a settled review leaves the re-check worklist'
);
select ok(
  (select counted from osi_private.osi_v2_sas_review_authority(
    'case_initial', array['33333333-3333-3333-3333-333333333333'::uuid])),
  'the weight surface is told this review counted'
);
select is(
  (select verification_state from osi_private.osi_v2_sas_review_authority(
    'case_initial', array['33333333-3333-3333-3333-333333333333'::uuid])),
  'verified',
  'the weight surface is told the authority was SAS-verified'
);

-- ---------------------------------------------------------------------------
-- 4. Absent, expired, revoked and unreachable all contribute zero and are
--    labeled, never silently dropped.
-- ---------------------------------------------------------------------------
insert into public.analyst_profiles (wallet, status, tier_code, verified, approved, weight_cached)
values ('AnaLystWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBB222', 'verified_analyst', 'verified', true, true, 1.00);
insert into public.event_receipts (id, event_version, event_type, target_type, target_id, actor_wallet,
  actor_role, decision, weight, proof_type, payload_hash, nonce, signature, server_verified, occurred_at)
values ('66666666-6666-6666-6666-666666666666', 'OSI2', 'CASE_INITIAL_REVIEW_CAST', 'case',
  '11111111-1111-1111-1111-111111111111', 'AnaLystWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBB222',
  'analyst', 'approve_open', 1.00, 'wallet_signed_server_verified', repeat('c', 64),
  repeat('p', 43), repeat('s', 88), true, now());
insert into public.case_initial_reviews (id, case_id, reviewer_wallet, decision, reviewer_role, weight,
  is_active, event_receipt_id)
values ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111',
  'AnaLystWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBB222', 'approve_open', 'analyst', 1.00, true,
  '66666666-6666-6666-6666-666666666666');

-- No snapshot at all (wallet holds no credential and was never checked).
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'a wallet with no credential snapshot contributes zero, the verified one still counts'
);
select is(
  (select verification_state from osi_private.osi_v2_sas_review_authority(
    'case_initial', array['77777777-7777-7777-7777-777777777777'::uuid])),
  'unchecked',
  'a review with no snapshot is labeled unchecked, not treated as verified'
);

-- Live read says the credential is absent on chain.
select is(
  osi_private.osi_v2_sas_record_review_verification('case_initial',
    '77777777-7777-7777-7777-777777777777', 'AnaLystWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBB222',
    'invalid',
    (select credential from sas_fixture), (select schema from sas_fixture), (select issuer from sas_fixture)),
  'invalid',
  'an absent on-chain credential is recorded invalid'
);
select is(
  (select total_weight from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  0.50::numeric,
  'the wallet with no valid credential adds zero weight, it is not dropped from history'
);
select ok(
  not (select counted from osi_private.osi_v2_sas_review_authority(
    'case_initial', array['77777777-7777-7777-7777-777777777777'::uuid])),
  'the weight surface is told plainly that this review did not count'
);

-- ---------------------------------------------------------------------------
-- 5. An unreachable verifier withholds weight and stays retryable.
-- ---------------------------------------------------------------------------
insert into public.analyst_profiles (wallet, status, tier_code, verified, approved, weight_cached)
values ('AnaLystWa11etCCCCCCCCCCCCCCCCCCCCCCCCCCC333', 'verified_analyst', 'verified', true, true, 1.00);
insert into public.event_receipts (id, event_version, event_type, target_type, target_id, actor_wallet,
  actor_role, decision, weight, proof_type, payload_hash, nonce, signature, server_verified, occurred_at)
values ('88888888-8888-8888-8888-888888888888', 'OSI2', 'CASE_INITIAL_REVIEW_CAST', 'case',
  '11111111-1111-1111-1111-111111111111', 'AnaLystWa11etCCCCCCCCCCCCCCCCCCCCCCCCCCC333',
  'analyst', 'approve_open', 1.00, 'wallet_signed_server_verified', repeat('d', 64),
  repeat('q', 43), repeat('s', 88), true, now());
insert into public.case_initial_reviews (id, case_id, reviewer_wallet, decision, reviewer_role, weight,
  is_active, event_receipt_id)
values ('99999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111',
  'AnaLystWa11etCCCCCCCCCCCCCCCCCCCCCCCCCCC333', 'approve_open', 'analyst', 1.00, true,
  '88888888-8888-8888-8888-888888888888');

select is(
  osi_private.osi_v2_sas_record_review_verification('case_initial',
    '99999999-9999-9999-9999-999999999999', 'AnaLystWa11etCCCCCCCCCCCCCCCCCCCCCCCCCCC333',
    'pending_verification',
    (select credential from sas_fixture), (select schema from sas_fixture), (select issuer from sas_fixture),
    null, 'rpc_failed'),
  'pending_verification',
  'an unreachable verifier records pending_verification, the review keeps its receipt'
);
select is(
  (select total_weight from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  0.50::numeric,
  'a pending_verification review contributes zero weight, fail closed'
);
select is(
  (select count(*)::bigint from osi_private.osi_v2_sas_reviews_needing_recheck(
    'case', '11111111-1111-1111-1111-111111111111')),
  1::bigint,
  'only the unresolved review stays on the worklist for a later live read'
);
select is(
  osi_private.osi_v2_sas_record_review_verification('case_initial',
    '99999999-9999-9999-9999-999999999999', 'AnaLystWa11etCCCCCCCCCCCCCCCCCCCCCCCCCCC333',
    'verified',
    (select credential from sas_fixture), (select schema from sas_fixture), (select issuer from sas_fixture)),
  'verified',
  'the lazy re-check resolves pending_verification once the chain answers'
);
select is(
  (select total_weight from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  1.50::numeric,
  'the recovered review counts without a new submission or a new signature'
);

-- ---------------------------------------------------------------------------
-- 6. Prospective only under stable coordinates; repairable after rotation.
-- ---------------------------------------------------------------------------
select is(
  osi_private.osi_v2_sas_record_review_verification('case_initial',
    '33333333-3333-3333-3333-333333333333', 'AnaLystWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAA111',
    'revoked',
    (select credential from sas_fixture), (select schema from sas_fixture), (select issuer from sas_fixture)),
  'verified',
  'a resolved snapshot under the published coordinates never downgrades retroactively'
);

update public.osi_config set value = (select rotated from sas_fixture)
  where key = 'OSI_V2_SAS_CREDENTIAL_PUBKEY';
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  0::bigint,
  'after a credential rotation, snapshots under the retired credential stop counting'
);
select is(
  (select count(*)::bigint from osi_private.osi_v2_sas_reviews_needing_recheck(
    'case', '11111111-1111-1111-1111-111111111111')),
  3::bigint,
  'every analyst review returns to the worklist so it can be re-read on chain'
);

-- ---------------------------------------------------------------------------
-- 7. The bootstrap bypass can never reach a challenge verdict or AI Pack.
-- ---------------------------------------------------------------------------
set local osi_v2.sas_bypass = 'on';
select ok(
  osi_private.osi_v2_sas_review_counts('case_report', extensions.gen_random_uuid()),
  'the bypass covers the D17 bootstrap review kinds'
);
select ok(
  not osi_private.osi_v2_sas_review_counts('challenge', extensions.gen_random_uuid()),
  'the bypass can never reach a challenge verdict'
);
select ok(
  not osi_private.osi_v2_sas_review_counts('ai_pack', extensions.gen_random_uuid()),
  'the bypass can never reach AI Pack approval'
);
set local osi_v2.sas_bypass = '';

-- ---------------------------------------------------------------------------
-- 8. Turning the flag back off restores the exact flag-off baseline.
-- ---------------------------------------------------------------------------
update public.osi_config set value = 'false' where key = 'OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED';
select is(
  (select analyst_count from osi_private.osi_v2_case_review_quorum('11111111-1111-1111-1111-111111111111')),
  3::bigint,
  'rollback: every analyst review counts again, irrespective of credential state'
);

select * from finish();
rollback;
