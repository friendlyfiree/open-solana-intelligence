-- OSI V2 AI Pack Phase 1 authorization, privacy, budget, quorum and
-- layer-aware staleness regression coverage.
--
-- All fixtures and flag changes live only in this disposable transaction.

begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Fail-closed defaults and direct-access posture.
-- ---------------------------------------------------------------------------

select is(
  (
    select jsonb_object_agg(config.key, config.value)
      from public.osi_config as config
     where config.key = any (array[
       'OSI_V2_AI_PACK_WRITES_ENABLED',
       'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED',
       'OSI_V2_AI_PACK_MODEL',
       'OSI_V2_AI_PACK_RATE_WINDOW_SECONDS',
       'OSI_V2_AI_PACK_MAX_PER_WALLET',
       'OSI_V2_AI_PACK_MAX_PER_FINGERPRINT',
       'OSI_V2_AI_PACK_CASE_COOLDOWN_SECONDS',
       'OSI_V2_AI_PACK_DAILY_QUOTA',
       'OSI_V2_AI_PACK_MAX_INPUT_CHARS',
       'OSI_V2_AI_PACK_MAX_OUTPUT_TOKENS',
       'OSI_V2_AI_PACK_MAX_OUTPUT_CHARS',
       'OSI_V2_AI_PACK_MAX_EVIDENCE_ITEMS',
       'OSI_V2_AI_PACK_PROVIDER_TIMEOUT_MS',
       'OSI_V2_AI_PACK_INPUT_USD_MICROS_PER_MTOK',
       'OSI_V2_AI_PACK_OUTPUT_USD_MICROS_PER_MTOK'
     ])
  ),
  jsonb_build_object(
    'OSI_V2_AI_PACK_WRITES_ENABLED', 'false',
    'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED', 'false',
    'OSI_V2_AI_PACK_MODEL', 'claude-sonnet-5',
    'OSI_V2_AI_PACK_RATE_WINDOW_SECONDS', '3600',
    'OSI_V2_AI_PACK_MAX_PER_WALLET', '2',
    'OSI_V2_AI_PACK_MAX_PER_FINGERPRINT', '4',
    'OSI_V2_AI_PACK_CASE_COOLDOWN_SECONDS', '21600',
    'OSI_V2_AI_PACK_DAILY_QUOTA', '10',
    'OSI_V2_AI_PACK_MAX_INPUT_CHARS', '24000',
    'OSI_V2_AI_PACK_MAX_OUTPUT_TOKENS', '1000',
    'OSI_V2_AI_PACK_MAX_OUTPUT_CHARS', '12000',
    'OSI_V2_AI_PACK_MAX_EVIDENCE_ITEMS', '40',
    'OSI_V2_AI_PACK_PROVIDER_TIMEOUT_MS', '45000',
    'OSI_V2_AI_PACK_INPUT_USD_MICROS_PER_MTOK', '3000000',
    'OSI_V2_AI_PACK_OUTPUT_USD_MICROS_PER_MTOK', '15000000'
  ),
  'AI Pack rollout and conservative budget defaults are exact'
);
select is(
  (
    select jsonb_object_agg(config.key, config.value)
      from public.osi_config as config
     where config.key in (
       'OSI_V2_AI_PACK_MIN_COUNT', 'OSI_V2_AI_PACK_MIN_WEIGHT'
     )
  ),
  jsonb_build_object(
    'OSI_V2_AI_PACK_MIN_COUNT', '2',
    'OSI_V2_AI_PACK_MIN_WEIGHT', '2.50'
  ),
  'count and weight quorum gates retain their accepted thresholds'
);
select ok(
  public.osi_v2_valid_ai_pack_transition(
    'review_required', 'superseded'
  ),
  'a replaced review-required version can reach the terminal superseded state'
);
select ok(
  public.osi_v2_valid_ai_pack_transition(
    'revision_requested', 'superseded'
  ),
  'a committed requested revision can supersede its immutable predecessor'
);
select ok(
  not public.osi_v2_valid_ai_pack_transition(
    'superseded', 'approved'
  ),
  'a superseded AI Pack version cannot become authoritative again'
);
select isnt(
  has_function_privilege(
    'anon',
    'public.osi_v2_prepare_ai_pack_generation(text,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  true,
  'anonymous clients cannot prepare AI Pack generation directly'
);
select isnt(
  has_function_privilege(
    'authenticated',
    'public.osi_v2_commit_ai_pack_generation(text,text,text,text,jsonb,text,integer,integer,bigint,text,timestamptz)',
    'EXECUTE'
  ),
  true,
  'authenticated clients cannot commit model output directly'
);
select isnt(
  has_function_privilege(
    'authenticated',
    'public.osi_v2_prepare_ai_pack_approval(text,text,text,text,text,text)',
    'EXECUTE'
  ),
  true,
  'authenticated clients cannot reach AI Pack approval directly'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.osi_v2_reserve_ai_pack_generation(text,text,text,text)',
    'EXECUTE'
  ),
  'service role can reach the atomic provider reservation wrapper'
);
select isnt(
  has_table_privilege(
    'authenticated', 'public.osi_v2_ai_pack_generation_runs', 'SELECT'
  ),
  true,
  'generation telemetry is not readable by authenticated clients'
);
select isnt(
  has_table_privilege(
    'authenticated', 'public.osi_v2_ai_pack_generation_runs', 'INSERT'
  ),
  true,
  'generation telemetry cannot be forged by authenticated clients'
);
select isnt(
  has_table_privilege('anon', 'public.ai_pack_versions', 'SELECT'),
  true,
  'anonymous clients cannot bypass the minimized AI Pack projection'
);
select isnt(
  has_table_privilege('authenticated', 'public.ai_pack_reviews', 'SELECT'),
  true,
  'authenticated clients cannot enumerate restricted review history'
);

-- ---------------------------------------------------------------------------
-- Deterministic actors, Case and three evidence scopes.
-- ---------------------------------------------------------------------------

insert into public.osi_config (key, value, updated_at)
values (
  'admin_wallet',
  '11111111111111111111111111111117',
  statement_timestamp()
)
on conflict (key) do update
  set value = excluded.value, updated_at = excluded.updated_at;

insert into public.event_receipts (
  id, event_version, event_type, target_type, target_id, actor_role,
  decision, proof_type, payload_hash, server_verified, occurred_at
) values
  (
    'a1000000-0000-4000-8000-000000000001', 'legacy',
    'ANALYST_VERIFIED', 'analyst', '11111111111111111111111111111112',
    'service', 'verify', 'legacy_imported', repeat('1', 64), false,
    statement_timestamp()
  ),
  (
    'a1000000-0000-4000-8000-000000000002', 'legacy',
    'ANALYST_VERIFIED', 'analyst', '11111111111111111111111111111113',
    'service', 'verify', 'legacy_imported', repeat('2', 64), false,
    statement_timestamp()
  ),
  (
    'a1000000-0000-4000-8000-000000000003', 'legacy',
    'ANALYST_VERIFIED', 'analyst', '11111111111111111111111111111115',
    'service', 'verify', 'legacy_imported', repeat('3', 64), false,
    statement_timestamp()
  ),
  (
    'a1000000-0000-4000-8000-000000000004', 'legacy',
    'ANALYST_VERIFIED', 'analyst', '11111111111111111111111111111116',
    'service', 'verify', 'legacy_imported', repeat('4', 64), false,
    statement_timestamp()
  );

insert into public.analyst_profiles (
  wallet, status, tier_code, verified, approved, weight_cached,
  verified_by, verified_receipt_id
) values
  (
    '11111111111111111111111111111112', 'verified_analyst',
    'analyst_i', true, true, 1.25,
    '11111111111111111111111111111117',
    'a1000000-0000-4000-8000-000000000001'
  ),
  (
    '11111111111111111111111111111113', 'verified_analyst',
    'analyst_i', true, true, 1.25,
    '11111111111111111111111111111117',
    'a1000000-0000-4000-8000-000000000002'
  ),
  (
    '11111111111111111111111111111114', 'probationary_analyst',
    'probationary', true, true, 1.25, null, null
  ),
  (
    '11111111111111111111111111111115', 'verified_analyst',
    'analyst_i', true, true, 1.25,
    '11111111111111111111111111111117',
    'a1000000-0000-4000-8000-000000000003'
  ),
  (
    '11111111111111111111111111111116', 'verified_analyst',
    'analyst_ii', true, true, 1.25,
    '11111111111111111111111111111117',
    'a1000000-0000-4000-8000-000000000004'
  );

insert into public.cases (
  id, public_ref, title, category, summary_public,
  submitted_by_wallet, stage, visibility, risk_tier, subject_refs
) values (
  'aa000000-0000-4000-8000-000000000001',
  'OSI-AIPACK0001',
  'AI Pack Phase 1 primary fixture',
  'other',
  'Public Case fixture for evidence-bound AI Pack verification.',
  '11111111111111111111111111111112',
  'open_public',
  'public',
  'standard',
  '[]'::jsonb
);

insert into public.evidence_items (
  id, kind, ref, is_public, moderation_state, sha256, added_by_wallet
) values
  (
    'ab000000-0000-4000-8000-000000000001',
    'url',
    'https://example.test/public-transaction',
    true,
    'approved',
    repeat('a', 64),
    '11111111111111111111111111111118'
  ),
  (
    'ab000000-0000-4000-8000-000000000002',
    'document',
    'OWNER_SCOPE_EVIDENCE_INITIAL',
    false,
    'approved',
    repeat('b', 64),
    '11111111111111111111111111111112'
  ),
  (
    'ab000000-0000-4000-8000-000000000003',
    'document',
    'ANALYST_SCOPE_EVIDENCE_INITIAL',
    false,
    'approved',
    repeat('c', 64),
    '11111111111111111111111111111115'
  );

insert into public.case_evidence_links (
  id, case_id, evidence_item_id, added_by_wallet
) values
  (
    'ac000000-0000-4000-8000-000000000001',
    'aa000000-0000-4000-8000-000000000001',
    'ab000000-0000-4000-8000-000000000001',
    '11111111111111111111111111111118'
  ),
  (
    'ac000000-0000-4000-8000-000000000002',
    'aa000000-0000-4000-8000-000000000001',
    'ab000000-0000-4000-8000-000000000002',
    '11111111111111111111111111111112'
  ),
  (
    'ac000000-0000-4000-8000-000000000003',
    'aa000000-0000-4000-8000-000000000001',
    'ab000000-0000-4000-8000-000000000003',
    '11111111111111111111111111111115'
  );

select is(
  (select count(*)::integer from public.osi_v2_list_public_ai_packs()),
  0,
  'public AI Pack projection starts honestly empty'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('f', 43),
      '11111111111111111111111111111113',
      'OSI-AIPACK0001',
      'victim',
      'ai-pack-disabled-0001',
      repeat('0', 64),
      null
    )
  $test$,
  '55000',
  'ai_pack_writes_disabled',
  'valid generation is refused while the dedicated rollout is disabled'
);
select is(
  (
    select jsonb_build_object(
      'runs', count(*) filter (where run.id is not null),
      'nonces', (
        select count(*) from public.osi_nonces as nonce
         where nonce.purpose = 'PACK_SUBMITTED'
      )
    )
      from public.osi_v2_ai_pack_generation_runs as run
  ),
  jsonb_build_object('runs', 0, 'nonces', 0),
  'flag-off generation leaves durable state byte-for-byte untouched'
);
update public.osi_config
   set value = 'TRUE'
 where key = 'OSI_V2_AI_PACK_WRITES_ENABLED';
select is(
  osi_private.osi_v2_ai_pack_writes_enabled(),
  false,
  'malformed AI Pack flag fails closed'
);

update public.osi_config
   set value = 'true'
 where key in (
   'OSI_V2_WRITES_ENABLED',
   'OSI_V2_PROOF_ENABLED',
   'OSI_V2_AI_PACK_WRITES_ENABLED',
   'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED'
 );
update public.osi_config
   set value = case key
     when 'OSI_V2_AI_PACK_MAX_PER_WALLET' then '100'
     when 'OSI_V2_AI_PACK_MAX_PER_FINGERPRINT' then '100'
     when 'OSI_V2_AI_PACK_CASE_COOLDOWN_SECONDS' then '0'
     when 'OSI_V2_AI_PACK_DAILY_QUOTA' then '100'
     when 'OSI_V2_NONCE_MAX_PER_WALLET' then '100'
     when 'OSI_V2_NONCE_MAX_PER_FINGERPRINT' then '200'
     else value
   end
 where key in (
   'OSI_V2_AI_PACK_MAX_PER_WALLET',
   'OSI_V2_AI_PACK_MAX_PER_FINGERPRINT',
   'OSI_V2_AI_PACK_CASE_COOLDOWN_SECONDS',
   'OSI_V2_AI_PACK_DAILY_QUOTA',
   'OSI_V2_NONCE_MAX_PER_WALLET',
   'OSI_V2_NONCE_MAX_PER_FINGERPRINT'
 );

-- ---------------------------------------------------------------------------
-- Generation eligibility, three manifests, budgets and immutable commit.
-- ---------------------------------------------------------------------------

select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('o', 43), '11111111111111111111111111111112',
      'OSI-AIPACK0001', 'victim', 'ai-pack-owner-denied-0001',
      repeat('1', 64), null
    )
  $test$,
  '42501',
  'ai_pack_generation_actor_ineligible',
  'Case owner cannot generate even when the owner also has an analyst profile'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('n', 43), '11111111111111111111111111111118',
      'OSI-AIPACK0001', 'victim', 'ai-pack-wallet-denied-0001',
      repeat('2', 64), null
    )
  $test$,
  '42501',
  'ai_pack_generation_actor_ineligible',
  'ordinary wallet cannot generate'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('p', 43), '11111111111111111111111111111114',
      'OSI-AIPACK0001', 'victim', 'ai-pack-probation-denied-0001',
      repeat('3', 64), null
    )
  $test$,
  '42501',
  'ai_pack_generation_actor_ineligible',
  'probationary analyst cannot incur provider generation cost'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('w', 43), '11111111111111111111111111111117',
      'OSI-AIPACK0001', 'law_enforcement',
      'ai-pack-wallet-half-maintainer-0001', repeat('4', 64), null
    )
  $test$,
  '42501',
  'ai_pack_generation_actor_ineligible',
  'admin wallet without maintainer auth is denied generation'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('h', 43), '11111111111111111111111111111118',
      'OSI-AIPACK0001', 'law_enforcement',
      'ai-pack-auth-half-maintainer-0001', repeat('5', 64),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  $test$,
  '42501',
  'ai_pack_generation_actor_ineligible',
  'maintainer auth without the admin wallet is denied generation'
);
select lives_ok(
  $test$
    create temporary table ai_pack_maintainer_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('m', 43), '11111111111111111111111111111117',
      'OSI-AIPACK0001', 'law_enforcement',
      'ai-pack-full-maintainer-0001', repeat('6', 64),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  $test$,
  'full double-gated maintainer can prepare generation'
);
select ok(
  (
    select actor_role = 'maintainer'
       and generation_state = 'prepared'
       and receipt_id is null
      from pg_temp.ai_pack_maintainer_prepare
  ),
  'maintainer preparation reserves no provider call and no receipt'
);

select lives_ok(
  $test$
    create temporary table ai_pack_main_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('g', 43), '11111111111111111111111111111113',
      'OSI-AIPACK0001', 'victim', 'ai-pack-main-generate-0001',
      repeat('a', 64), null
    )
  $test$,
  'verified analyst prepares an evidence-bound generation'
);
select ok(
  (
    select actor_role = 'analyst'
       and generation_state = 'prepared'
       and pack_public_ref ~ '^OSI-AP-[0-9A-F]{12}$'
       and version_public_ref ~ '^OSI-APV-[0-9A-F]{16}$'
       and jsonb_array_length(evidence_manifest) = 3
       and model = 'claude-sonnet-5'
       and max_input_chars = 24000
       and max_output_tokens = 1000
       and max_output_chars = 12000
       and max_evidence_items = 40
       and provider_timeout_ms = 45000
      from pg_temp.ai_pack_main_prepare
  ),
  'prepare snapshots stable refs, evidence and every provider budget cap'
);
select is(
  (
    select jsonb_agg(item.value->>'access_scope'
      order by item.value->>'access_scope')
      from pg_temp.ai_pack_main_prepare as prepared
      cross join lateral jsonb_array_elements(
        prepared.evidence_manifest
      ) as item(value)
  ),
  '["analyst_restricted", "owner_safe", "public"]'::jsonb,
  'approved evidence is classified into exactly three trust layers'
);
select ok(
  (
    select public_manifest_hash <> owner_safe_manifest_hash
       and owner_safe_manifest_hash <> analyst_restricted_manifest_hash
       and public_manifest_hash <> analyst_restricted_manifest_hash
      from pg_temp.ai_pack_main_prepare
  ),
  'public, owner-safe and analyst-restricted manifests have distinct hashes'
);
select is(
  (
    select idempotent_replay
      from public.osi_v2_prepare_ai_pack_generation(
        repeat('x', 43), '11111111111111111111111111111113',
        'OSI-AIPACK0001', 'victim', 'ai-pack-main-generate-0001',
        repeat('a', 64), null
      )
  ),
  true,
  'exact prepare retry returns the original durable reservation'
);

select lives_ok(
  $test$
    create temporary table ai_pack_main_reserve on commit drop as
    select * from public.osi_v2_reserve_ai_pack_generation(
      repeat('g', 43),
      repeat('G', 88),
      (select proof_text from pg_temp.ai_pack_main_prepare),
      null
    )
  $test$,
  'verified wallet proof reserves exactly one provider attempt'
);
select ok(
  (
    select generation_state = 'reserved'
       and idempotent_replay is false
       and receipt_id is null
       and reserved_at is not null
      from pg_temp.ai_pack_main_reserve
  ),
  'first reservation is durable and has no domain or receipt effect'
);
select is(
  (
    select idempotent_replay
      from public.osi_v2_reserve_ai_pack_generation(
        repeat('g', 43),
        repeat('G', 88),
        (select proof_text from pg_temp.ai_pack_main_prepare),
        null
      )
  ),
  true,
  'exact reservation retry is identified before any second provider call'
);

select throws_ok(
  $test$
    select * from public.osi_v2_commit_ai_pack_generation(
      repeat('g', 43),
      'Changed output cannot be committed with a deliberately incorrect provider cost.',
      'Changed owner-safe output cannot be committed with an incorrect provider cost.',
      'Changed restricted output cannot be committed with an incorrect provider cost.',
      jsonb_build_object(
        'public_verifiability', 0.50,
        'onchain_reproducibility', 0.50,
        'evidence_coverage', 0.50,
        'source_consistency', 0.50,
        'analyst_attestation', 0
      ),
      'claude-sonnet-5', 100, 50, 1049, repeat('e', 64),
      statement_timestamp()
    )
  $test$,
  '23514',
  'ai_pack_generation_cost_mismatch',
  'provider telemetry cost must match the server-snapshotted price formula'
);
select lives_ok(
  $test$
    create temporary table ai_pack_main_commit on commit drop as
    select * from public.osi_v2_commit_ai_pack_generation(
      repeat('g', 43),
      'PUBLIC_LAYER_ONLY: Public evidence supports a reviewable transfer chronology without a truth or guilt claim.',
      'OWNER_LAYER_ONLY: Owner-provided evidence adds context while preserving restricted analyst material.',
      'ANALYST_LAYER_ONLY: Restricted analyst evidence records alternative hypotheses for independent governance review.',
      jsonb_build_object(
        'public_verifiability', 0.50,
        'onchain_reproducibility', 0.50,
        'evidence_coverage', 0.50,
        'source_consistency', 0.50,
        'analyst_attestation', 0
      ),
      'claude-sonnet-5', 100, 50, 1050, repeat('e', 64),
      statement_timestamp()
    )
  $test$,
  'generation atomically appends one immutable three-layer version'
);
select ok(
  (
    select version.lifecycle_state = 'review_required'
       and version.version_ref = prepared.version_public_ref
       and version.event_receipt_id = committed.receipt_id
       and version.confidence_profile->>'analyst_attestation' = '0'
       and run.state = 'committed'
       and run.provider_input_tokens = 100
       and run.provider_output_tokens = 50
       and run.cost_usd_micros = 1050
      from public.ai_pack_versions as version
      join pg_temp.ai_pack_main_prepare as prepared
        on prepared.version_id = version.id
      join pg_temp.ai_pack_main_commit as committed
        on committed.version_id = version.id
      join public.osi_v2_ai_pack_generation_runs as run
        on run.version_id = version.id
  ),
  'version, system receipt and service-only telemetry bind the same artifact'
);
select is(
  (
    select jsonb_object_agg(link.access_scope, layer_count)
      from (
        select link.access_scope, count(*)::integer as layer_count
          from public.ai_pack_version_evidence as link
         where link.pack_version_id = (
           select version_id from pg_temp.ai_pack_main_prepare
         )
         group by link.access_scope
      ) as link
  ),
  jsonb_build_object(
    'public', 1, 'owner_safe', 1, 'analyst_restricted', 1
  ),
  'immutable version evidence persists one exact row per trust layer'
);
select ok(
  (
    select receipt.event_type = 'PACK_SUBMITTED'
       and receipt.proof_type = 'system_event'
       and receipt.server_verified
       and receipt.nonce is null
       and receipt.signature is null
       and receipt.tx_sig is null
       and run.signature = repeat('G', 88)
      from public.event_receipts as receipt
      join public.osi_v2_ai_pack_generation_runs as run
        on run.receipt_id = receipt.id
     where receipt.id = (select receipt_id from pg_temp.ai_pack_main_commit)
  ),
  'generation authorization stays in telemetry and is never mislabeled on-chain'
);
select is(
  (
    select idempotent_replay
      from public.osi_v2_commit_ai_pack_generation(
        repeat('g', 43),
        'PUBLIC_LAYER_ONLY: Public evidence supports a reviewable transfer chronology without a truth or guilt claim.',
        'OWNER_LAYER_ONLY: Owner-provided evidence adds context while preserving restricted analyst material.',
        'ANALYST_LAYER_ONLY: Restricted analyst evidence records alternative hypotheses for independent governance review.',
        jsonb_build_object(
          'public_verifiability', 0.50,
          'onchain_reproducibility', 0.50,
          'evidence_coverage', 0.50,
          'source_consistency', 0.50,
          'analyst_attestation', 0
        ),
        'claude-sonnet-5', 100, 50, 1050, repeat('e', 64),
        statement_timestamp()
      )
  ),
  true,
  'exact generation commit retry returns the original immutable effect'
);
select throws_ok(
  $test$
    update public.ai_pack_versions
       set content_owner_safe = 'Rewritten owner content must never replace an immutable generated artifact.'
     where id = (select version_id from pg_temp.ai_pack_main_prepare)
  $test$,
  '55000',
  'Published AI Pack artifact content and identity are immutable',
  'generated layer content cannot be rewritten'
);

-- A separate reserved generation proves model output containing secrets or
-- direct PII cannot enter any artifact or receipt.
select lives_ok(
  $test$
    create temporary table ai_pack_unsafe_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('s', 43), '11111111111111111111111111111113',
      'OSI-AIPACK0001', 'exchange', 'ai-pack-unsafe-output-0001',
      repeat('9', 64), null
    )
  $test$,
  'separate exact version is prepared for output safety testing'
);
select lives_ok(
  $test$
    select * from public.osi_v2_reserve_ai_pack_generation(
      repeat('s', 43), repeat('S', 88),
      (select proof_text from pg_temp.ai_pack_unsafe_prepare), null
    )
  $test$,
  'unsafe-output fixture reaches only the reserved telemetry state'
);
select throws_ok(
  $test$
    select * from public.osi_v2_commit_ai_pack_generation(
      repeat('s', 43),
      'This generated public layer includes a seed phrase and must be rejected before persistence.',
      'This otherwise valid owner-safe layer is long enough for the output contract.',
      'This otherwise valid analyst layer is long enough for the output contract.',
      jsonb_build_object(
        'public_verifiability', 0.25,
        'onchain_reproducibility', 0.25,
        'evidence_coverage', 0.25,
        'source_consistency', 0.25,
        'analyst_attestation', 0
      ),
      'claude-sonnet-5', 0, 0, 0, null, statement_timestamp()
    )
  $test$,
  '22023',
  'ai_pack_generated_content_invalid',
  'secret-bearing model output is rejected before domain persistence'
);
select ok(
  not osi_private.osi_v2_ai_pack_safe_generated_text(
    'Contact the subject at analyst@example.test for direct identification.'
  )
  and not osi_private.osi_v2_ai_pack_safe_generated_text(
    'The exported card number is 4111111111111111.'
  ),
  'generated-output safety gate rejects direct email and payment-card PII'
);
select is(
  (
    select jsonb_build_object(
      'state', run.state,
      'versions', (
        select count(*) from public.ai_pack_versions as version
         where version.id = run.version_id
      ),
      'receipts', (
        select count(*) from public.event_receipts as receipt
         where receipt.target_type = 'pack_version'
           and receipt.target_id = run.version_id::text
      )
    )
      from public.osi_v2_ai_pack_generation_runs as run
     where run.nonce = repeat('s', 43)
  ),
  jsonb_build_object('state', 'reserved', 'versions', 0, 'receipts', 0),
  'rejected unsafe output records no Pack version or receipt'
);

-- ---------------------------------------------------------------------------
-- Input cap, wallet/fingerprint rates, Case cooldown and daily quota.
-- ---------------------------------------------------------------------------

insert into public.cases (
  id, public_ref, title, category, summary_public,
  submitted_by_wallet, stage, visibility, risk_tier, subject_refs
) values
  (
    'aa000000-0000-4000-8000-000000000002', 'OSI-AIPACK0002',
    'AI Pack rate fixture two', 'other',
    'Public Case fixture for wallet and fingerprint rate limits.',
    '11111111111111111111111111111118',
    'open_public', 'public', 'standard', '[]'::jsonb
  ),
  (
    'aa000000-0000-4000-8000-000000000003', 'OSI-AIPACK0003',
    'AI Pack cooldown fixture three', 'other',
    'Public Case fixture for Case cooldown enforcement.',
    '11111111111111111111111111111118',
    'open_public', 'public', 'standard', '[]'::jsonb
  ),
  (
    'aa000000-0000-4000-8000-000000000004', 'OSI-AIPACK0004',
    'AI Pack quota fixture four', 'other',
    'Public Case fixture for global daily quota enforcement.',
    '11111111111111111111111111111118',
    'open_public', 'public', 'standard', '[]'::jsonb
  );
insert into public.evidence_items (
  id, kind, ref, is_public, moderation_state, sha256, added_by_wallet
) values
  (
    'ab000000-0000-4000-8000-000000000004', 'document',
    'RATE_FIXTURE_EVIDENCE_TWO', true, 'approved', repeat('4', 64),
    '11111111111111111111111111111118'
  ),
  (
    'ab000000-0000-4000-8000-000000000005', 'document',
    'COOLDOWN_FIXTURE_EVIDENCE_THREE', true, 'approved', repeat('5', 64),
    '11111111111111111111111111111118'
  ),
  (
    'ab000000-0000-4000-8000-000000000006', 'document',
    'QUOTA_FIXTURE_EVIDENCE_FOUR', true, 'approved', repeat('6', 64),
    '11111111111111111111111111111118'
  );
insert into public.case_evidence_links (
  id, case_id, evidence_item_id, added_by_wallet
) values
  (
    'ac000000-0000-4000-8000-000000000004',
    'aa000000-0000-4000-8000-000000000002',
    'ab000000-0000-4000-8000-000000000004',
    '11111111111111111111111111111118'
  ),
  (
    'ac000000-0000-4000-8000-000000000005',
    'aa000000-0000-4000-8000-000000000003',
    'ab000000-0000-4000-8000-000000000005',
    '11111111111111111111111111111118'
  ),
  (
    'ac000000-0000-4000-8000-000000000006',
    'aa000000-0000-4000-8000-000000000004',
    'ab000000-0000-4000-8000-000000000006',
    '11111111111111111111111111111118'
  );

update public.osi_config set value = '41'
 where key = 'OSI_V2_AI_PACK_MAX_EVIDENCE_ITEMS';
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('I', 43), '11111111111111111111111111111113',
      'OSI-AIPACK0002', 'law_enforcement',
      'ai-pack-evidence-cap-config-0001', repeat('6', 64), null
    )
  $test$,
  '55000',
  'ai_pack_config_invalid',
  'evidence cap above the hard maximum of 40 fails closed'
);
update public.osi_config set value = '40'
 where key = 'OSI_V2_AI_PACK_MAX_EVIDENCE_ITEMS';

update public.osi_config set value = '1000'
 where key = 'OSI_V2_AI_PACK_MAX_INPUT_CHARS';
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('i', 43), '11111111111111111111111111111113',
      'OSI-AIPACK0002', 'victim', 'ai-pack-input-cap-0001',
      repeat('7', 64), null
    )
  $test$,
  '22023',
  'ai_pack_input_too_large',
  'bounded evidence prompt is refused before a provider reservation'
);
select is(
  (
    select count(*)::integer
      from public.osi_v2_ai_pack_generation_runs
     where idempotency_key = 'ai-pack-input-cap-0001'
  ),
  0,
  'input-cap refusal consumes no nonce, quota or telemetry row'
);
update public.osi_config set value = '24000'
 where key = 'OSI_V2_AI_PACK_MAX_INPUT_CHARS';

select lives_ok(
  $test$
    create temporary table ai_pack_wallet_rate_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('j', 43), '11111111111111111111111111111113',
      'OSI-AIPACK0002', 'victim', 'ai-pack-wallet-rate-0001',
      repeat('7', 64), null
    )
  $test$,
  'wallet-rate fixture is prepared without spending quota'
);
update public.osi_config set value = '1'
 where key = 'OSI_V2_AI_PACK_MAX_PER_WALLET';
select throws_ok(
  $test$
    select * from public.osi_v2_reserve_ai_pack_generation(
      repeat('j', 43), repeat('J', 88),
      (select proof_text from pg_temp.ai_pack_wallet_rate_prepare), null
    )
  $test$,
  'P0001',
  'ai_pack_wallet_rate_limited',
  'per-wallet limit refuses a provider attempt before charging'
);
update public.osi_config set value = '100'
 where key = 'OSI_V2_AI_PACK_MAX_PER_WALLET';

select lives_ok(
  $test$
    create temporary table ai_pack_fingerprint_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('k', 43), '11111111111111111111111111111115',
      'OSI-AIPACK0002', 'exchange', 'ai-pack-fingerprint-rate-0001',
      repeat('a', 64), null
    )
  $test$,
  'fingerprint-rate fixture is prepared without spending quota'
);
update public.osi_config set value = '1'
 where key = 'OSI_V2_AI_PACK_MAX_PER_FINGERPRINT';
select throws_ok(
  $test$
    select * from public.osi_v2_reserve_ai_pack_generation(
      repeat('k', 43), repeat('K', 88),
      (select proof_text from pg_temp.ai_pack_fingerprint_prepare), null
    )
  $test$,
  'P0001',
  'ai_pack_fingerprint_rate_limited',
  'per-fingerprint limit refuses duplicate infrastructure demand'
);
update public.osi_config set value = '100'
 where key = 'OSI_V2_AI_PACK_MAX_PER_FINGERPRINT';

select lives_ok(
  $test$
    create temporary table ai_pack_cooldown_first_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('l', 43), '11111111111111111111111111111115',
      'OSI-AIPACK0003', 'victim', 'ai-pack-cooldown-first-0001',
      repeat('b', 64), null
    )
  $test$,
  'first Case cooldown fixture is prepared'
);
select lives_ok(
  $test$
    select * from public.osi_v2_reserve_ai_pack_generation(
      repeat('l', 43), repeat('L', 88),
      (select proof_text from pg_temp.ai_pack_cooldown_first_prepare), null
    )
  $test$,
  'first Case attempt reserves one provider slot'
);
select lives_ok(
  $test$
    create temporary table ai_pack_cooldown_second_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('q', 43), '11111111111111111111111111111116',
      'OSI-AIPACK0003', 'exchange', 'ai-pack-cooldown-second-0001',
      repeat('c', 64), null
    )
  $test$,
  'second pack type on the same Case can prepare without spending quota'
);
update public.osi_config set value = '21600'
 where key = 'OSI_V2_AI_PACK_CASE_COOLDOWN_SECONDS';
select throws_ok(
  $test$
    select * from public.osi_v2_reserve_ai_pack_generation(
      repeat('q', 43), repeat('Q', 88),
      (select proof_text from pg_temp.ai_pack_cooldown_second_prepare), null
    )
  $test$,
  'P0001',
  'ai_pack_case_cooldown_active',
  'per-Case cooldown refuses another provider attempt'
);
update public.osi_config set value = '0'
 where key = 'OSI_V2_AI_PACK_CASE_COOLDOWN_SECONDS';

select lives_ok(
  $test$
    create temporary table ai_pack_daily_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('d', 43), '11111111111111111111111111111116',
      'OSI-AIPACK0004', 'victim', 'ai-pack-daily-quota-0001',
      repeat('d', 64), null
    )
  $test$,
  'daily-quota fixture is prepared without spending quota'
);
update public.osi_config set value = '1'
 where key = 'OSI_V2_AI_PACK_DAILY_QUOTA';
select throws_ok(
  $test$
    select * from public.osi_v2_reserve_ai_pack_generation(
      repeat('d', 43), repeat('D', 88),
      (select proof_text from pg_temp.ai_pack_daily_prepare), null
    )
  $test$,
  'P0001',
  'ai_pack_daily_quota_exhausted',
  'global UTC-day quota refuses another provider attempt'
);
update public.osi_config set value = '100'
 where key = 'OSI_V2_AI_PACK_DAILY_QUOTA';
select ok(
  (
    select state = 'prepared' and reserved_at is null
      from public.osi_v2_ai_pack_generation_runs
     where nonce = repeat('d', 43)
  ),
  'quota refusal records no reservation time and consumes no provider slot'
);

select lives_ok(
  $test$
    create temporary table ai_pack_claimed_wallet_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('y', 43), '11111111111111111111111111111115',
      'OSI-AIPACK0004', 'exchange',
      'ai-pack-claimed-wallet-prepare-0001', repeat('e', 64), null
    )
  $test$,
  'an unsigned claimed-wallet challenge may prepare only a bounded nonce'
);
select lives_ok(
  $test$
    create temporary table ai_pack_valid_competing_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_generation(
      repeat('Y', 43), '11111111111111111111111111111115',
      'OSI-AIPACK0004', 'exchange',
      'ai-pack-valid-competing-prepare-0001', repeat('f', 64), null
    )
  $test$,
  'unsigned prepare does not lock the Case and type against a valid challenge'
);
select ok(
  (
    select first.generation_state = 'prepared'
       and second.generation_state = 'prepared'
       and first.generation_id <> second.generation_id
      from pg_temp.ai_pack_claimed_wallet_prepare as first
      cross join pg_temp.ai_pack_valid_competing_prepare as second
  ),
  'distinct bounded challenges coexist without reserving provider capacity'
);
select lives_ok(
  $test$
    select * from public.osi_v2_reserve_ai_pack_generation(
      repeat('Y', 43), repeat('W', 88),
      (select proof_text from pg_temp.ai_pack_valid_competing_prepare), null
    )
  $test$,
  'valid signed challenge reserves despite the earlier claimed-wallet prepare'
);
select throws_ok(
  $test$
    select * from public.osi_v2_reserve_ai_pack_generation(
      repeat('y', 43), repeat('X', 88),
      (select proof_text from pg_temp.ai_pack_claimed_wallet_prepare), null
    )
  $test$,
  '55000',
  'ai_pack_generation_in_progress',
  'competing challenge cannot reserve a second provider slot for Case and type'
);
select ok(
  (
    select count(*) filter (where run.state = 'reserved') = 1
       and count(*) filter (where run.state = 'prepared') = 1
      from public.osi_v2_ai_pack_generation_runs as run
     where run.id in (
       (select generation_id from pg_temp.ai_pack_claimed_wallet_prepare),
       (select generation_id from pg_temp.ai_pack_valid_competing_prepare)
     )
  ),
  'claimed-wallet prepare remains non-reserved while one signed winner owns capacity'
);

-- ---------------------------------------------------------------------------
-- Counted analyst review, append-only history, advisory owner feedback.
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::integer from public.osi_v2_list_public_ai_packs()),
  0,
  'unapproved content remains absent from the public projection'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_review(
      repeat('r', 43), '11111111111111111111111111111113',
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      'support', 'self_review',
      'The exact creator must never cast a counted review.',
      'ANALYST_PRIVATE_CREATOR_NOTE',
      'ai-pack-creator-self-review-0001', repeat('1', 64)
    )
  $test$,
  '42501',
  'ai_pack_review_actor_ineligible',
  'creator cannot review their own exact version'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_review(
      repeat('r', 42) || 'o', '11111111111111111111111111111112',
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      'support', 'owner_conflict',
      'The Case owner must never cast a counted vote on their own Pack.',
      'ANALYST_PRIVATE_OWNER_NOTE',
      'ai-pack-owner-counted-review-0001', repeat('2', 64)
    )
  $test$,
  '42501',
  'ai_pack_review_actor_ineligible',
  'Case owner cannot cast a counted vote even with an analyst profile'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_review(
      repeat('r', 42) || 'n', '11111111111111111111111111111118',
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      'support', 'ordinary_wallet',
      'An ordinary wallet cannot cast a counted analyst review.',
      null,
      'ai-pack-ordinary-review-0001', repeat('3', 64)
    )
  $test$,
  '42501',
  'ai_pack_review_actor_ineligible',
  'ordinary wallet cannot cast a counted review'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_approval(
      repeat('u', 43), '11111111111111111111111111111117',
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      'ai-pack-wallet-only-approval-0001', repeat('4', 64), null
    )
  $test$,
  '42501',
  'ai_pack_approval_full_maintainer_required',
  'admin wallet alone cannot finalize an AI Pack'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_approval(
      repeat('v', 43), '11111111111111111111111111111118',
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      'ai-pack-auth-only-approval-0001', repeat('5', 64),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  $test$,
  '42501',
  'ai_pack_approval_full_maintainer_required',
  'maintainer auth alone cannot finalize an AI Pack'
);
select throws_ok(
  $test$
    select * from public.osi_v2_prepare_ai_pack_approval(
      repeat('t', 43), '11111111111111111111111111111117',
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      'ai-pack-no-quorum-approval-0001', repeat('6', 64),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  $test$,
  '42501',
  'ai_pack_approval_quorum_not_ready',
  'full maintainer cannot invent or replace analyst quorum'
);

select lives_ok(
  $test$
    create temporary table ai_pack_review_one_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_review(
      repeat('a', 43), '11111111111111111111111111111115',
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      'support', 'evidence_support',
      'Independent evidence supports this exact immutable version.',
      'ANALYST_PRIVATE_NOTE_ONE',
      'ai-pack-review-one-0001', repeat('7', 64)
    )
  $test$,
  'first independent analyst prepares a counted review'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_ai_pack_review(
      repeat('a', 43), 'support', 'evidence_support',
      'Independent evidence supports this exact immutable version.',
      'ANALYST_PRIVATE_NOTE_ONE', repeat('A', 88),
      (select proof_text from pg_temp.ai_pack_review_one_prepare)
    )
  $test$,
  'first counted analyst review commits'
);
select ok(
  (
    select independent_count = 1
       and total_weight = 1.25
       and quorum_ready is false
      from osi_private.osi_v2_ai_pack_quorum(
        (select version_id from pg_temp.ai_pack_main_prepare)
      )
  ),
  'one analyst meets neither the two-person count gate nor final quorum'
);

select lives_ok(
  $test$
    create temporary table ai_pack_review_one_revision_prepare
      on commit drop as
    select * from public.osi_v2_prepare_ai_pack_review(
      repeat('b', 43), '11111111111111111111111111111115',
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      'support', 'evidence_support_rechecked',
      'Independent evidence still supports this exact immutable version.',
      'ANALYST_PRIVATE_NOTE_ONE_REVISED',
      'ai-pack-review-one-revision-0001', repeat('8', 64)
    )
  $test$,
  'revised analyst decision prepares a new immutable review row'
);
select is(
  (
    select event_type
      from pg_temp.ai_pack_review_one_revision_prepare
  ),
  'AI_PACK_REVIEW_REVISED',
  'review revision binds the explicit revised event type'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_ai_pack_review(
      repeat('b', 43), 'support', 'evidence_support_rechecked',
      'Independent evidence still supports this exact immutable version.',
      'ANALYST_PRIVATE_NOTE_ONE_REVISED', repeat('B', 88),
      (
        select proof_text
          from pg_temp.ai_pack_review_one_revision_prepare
      )
    )
  $test$,
  'revised analyst decision appends without erasing prior history'
);
select ok(
  (
    select count(*) = 2
       and count(*) filter (where review.is_active) = 1
       and count(*) filter (
         where not review.is_active and review.superseded_by is not null
       ) = 1
      from public.ai_pack_reviews as review
     where review.pack_version_id = (
       select version_id from pg_temp.ai_pack_main_prepare
     )
       and review.reviewer_wallet = '11111111111111111111111111111115'
  ),
  'review history is append-only with exactly one active decision'
);

select lives_ok(
  $test$
    create temporary table ai_pack_review_two_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_review(
      repeat('c', 43), '11111111111111111111111111111116',
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      'support', 'independent_support',
      'A second independent analyst supports this exact immutable version.',
      'ANALYST_PRIVATE_NOTE_TWO',
      'ai-pack-review-two-0001', repeat('9', 64)
    )
  $test$,
  'second independent analyst prepares the count-gate review'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_ai_pack_review(
      repeat('c', 43), 'support', 'independent_support',
      'A second independent analyst supports this exact immutable version.',
      'ANALYST_PRIVATE_NOTE_TWO', repeat('C', 88),
      (select proof_text from pg_temp.ai_pack_review_two_prepare)
    )
  $test$,
  'second counted analyst review commits'
);
select ok(
  (
    select independent_count = 2
       and total_weight = 2.50
       and not has_dispute
       and not has_revision_request
       and quorum_ready
      from osi_private.osi_v2_ai_pack_quorum(
        (select version_id from pg_temp.ai_pack_main_prepare)
      )
  ),
  'two independent active analysts satisfy both count and weight gates'
);
select is(
  (
    select lifecycle_state
      from public.ai_pack_versions
     where id = (select version_id from pg_temp.ai_pack_main_prepare)
  ),
  'supported',
  'real analyst quorum advances the exact version only to supported'
);

create temporary table ai_pack_quorum_before_feedback on commit drop as
select independent_count, total_weight, quorum_hash
  from osi_private.osi_v2_ai_pack_quorum(
    (select version_id from pg_temp.ai_pack_main_prepare)
  );
select lives_ok(
  $test$
    create temporary table ai_pack_feedback_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_owner_feedback(
      repeat('e', 43), '11111111111111111111111111111112',
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      'clarification',
      'OWNER_FEEDBACK_PUBLIC: The owner requests a source clarification.',
      'OWNER_FEEDBACK_RESTRICTED: This advisory note is not an analyst vote.',
      'ai-pack-owner-feedback-0001', repeat('e', 64)
    )
  $test$,
  'exact Case owner prepares advisory feedback'
);
select lives_ok(
  $test$
    select * from public.osi_v2_commit_ai_pack_owner_feedback(
      repeat('e', 43), 'clarification',
      'OWNER_FEEDBACK_PUBLIC: The owner requests a source clarification.',
      'OWNER_FEEDBACK_RESTRICTED: This advisory note is not an analyst vote.',
      repeat('E', 88),
      (select proof_text from pg_temp.ai_pack_feedback_prepare)
    )
  $test$,
  'owner advisory feedback commits through its separate event path'
);
select ok(
  (
    select before.independent_count = after.independent_count
       and before.total_weight = after.total_weight
       and before.quorum_hash = after.quorum_hash
      from pg_temp.ai_pack_quorum_before_feedback as before
      cross join lateral osi_private.osi_v2_ai_pack_quorum(
        (select version_id from pg_temp.ai_pack_main_prepare)
      ) as after
  ),
  'owner feedback contributes zero count and zero weight'
);
select ok(
  (
    select feedback.event_receipt_id = receipt.id
       and receipt.event_type = 'AI_PACK_OWNER_FEEDBACK_SUBMITTED'
       and receipt.target_type = 'pack_owner_feedback'
       and receipt.proof_type = 'wallet_signed_server_verified'
       and receipt.weight is null
      from public.ai_pack_owner_feedback as feedback
      join public.event_receipts as receipt
        on receipt.id = feedback.event_receipt_id
     where feedback.id = (
       select feedback_id from pg_temp.ai_pack_feedback_prepare
     )
  ),
  'owner feedback is a separate signed advisory receipt with no vote weight'
);
select is(
  (
    select confidence_profile->>'analyst_attestation'
      from public.ai_pack_versions
     where id = (select version_id from pg_temp.ai_pack_main_prepare)
  ),
  '0',
  'owner feedback and review do not rewrite the stored generated profile'
);

-- ---------------------------------------------------------------------------
-- Viewer isolation before approval, then standard-channel finalization.
-- ---------------------------------------------------------------------------

create temporary table ai_pack_owner_projection_before on commit drop as
select * from public.osi_v2_get_authorized_ai_packs(
  'OSI-AIPACK0001', '11111111111111111111111111111112', null
);
select ok(
  (
    select viewer_role = 'owner'
       and packs::text like '%PUBLIC_LAYER_ONLY%'
       and packs::text like '%OWNER_LAYER_ONLY%'
       and packs::text not like '%ANALYST_LAYER_ONLY%'
       and packs::text not like '%ANALYST_PRIVATE_NOTE%'
       and not ((packs #> '{0,versions,0}') ? 'content_analyst_restricted')
       and not ((packs #> '{0,versions,0}') ? 'reviews')
      from pg_temp.ai_pack_owner_projection_before
  ),
  'Case owner who is also an analyst still receives only owner-safe content'
);

update public.osi_config
   set value = '11111111111111111111111111111112'
 where key = 'admin_wallet';
select ok(
  (
    select viewer_role = 'owner'
       and packs::text like '%OWNER_LAYER_ONLY%'
       and packs::text not like '%ANALYST_LAYER_ONLY%'
       and packs::text not like '%ANALYST_PRIVATE_NOTE%'
       and not ((packs #> '{0,versions,0}') ? 'content_analyst_restricted')
       and not ((packs #> '{0,versions,0}') ? 'reviews')
      from public.osi_v2_get_authorized_ai_packs(
        'OSI-AIPACK0001',
        '11111111111111111111111111111112',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      )
  ),
  'full-maintainer credentials never elevate the exact Case owner projection'
);
update public.osi_config
   set value = '11111111111111111111111111111117'
 where key = 'admin_wallet';

create temporary table ai_pack_analyst_projection_before on commit drop as
select * from public.osi_v2_get_authorized_ai_packs(
  'OSI-AIPACK0001', '11111111111111111111111111111115', null
);
select ok(
  (
    select viewer_role = 'analyst'
       and packs::text like '%PUBLIC_LAYER_ONLY%'
       and packs::text like '%OWNER_LAYER_ONLY%'
       and packs::text like '%ANALYST_LAYER_ONLY%'
       and packs::text like '%ANALYST_PRIVATE_NOTE_ONE_REVISED%'
       and packs::text like '%wallet_signed_server_verified%'
       and packs #>> '{0,versions,0,confidence_profile,analyst_attestation}'
         = '1'
      from pg_temp.ai_pack_analyst_projection_before
  ),
  'eligible analyst receives all layers, private notes and honest proof class'
);

create temporary table ai_pack_public_projection_before on commit drop as
select * from public.osi_v2_get_authorized_ai_packs(
  'OSI-AIPACK0001', '11111111111111111111111111111118', null
);
select ok(
  (
    select viewer_role = 'public'
       and packs = '[]'::jsonb
       and packs::text not like '%OSI-AP-%'
       and packs::text not like '%PUBLIC_LAYER_ONLY%'
       and packs::text not like '%OWNER_LAYER_ONLY%'
       and packs::text not like '%ANALYST_LAYER_ONLY%'
      from pg_temp.ai_pack_public_projection_before
  ),
  'ordinary public read leaks no unapproved Pack metadata, ref or content'
);

select throws_ok(
  $test$
    do $stale_review$
    begin
      insert into public.evidence_items (
        id, kind, ref, is_public, moderation_state, sha256, added_by_wallet
      ) values (
        'ab000000-0000-4000-8000-000000000008', 'document',
        'TRANSIENT_REVIEW_DRIFT', false, 'approved', repeat('8', 64),
        '11111111111111111111111111111112'
      );
      insert into public.case_evidence_links (
        id, case_id, evidence_item_id, added_by_wallet
      ) values (
        'ac000000-0000-4000-8000-000000000008',
        'aa000000-0000-4000-8000-000000000001',
        'ab000000-0000-4000-8000-000000000008',
        '11111111111111111111111111111112'
      );
      perform * from public.osi_v2_prepare_ai_pack_review(
        repeat('x', 43), '11111111111111111111111111111115',
        (select version_public_ref from pg_temp.ai_pack_main_prepare),
        'support', 'stale_evidence',
        'A stale evidence manifest cannot receive another counted review.',
        null, 'ai-pack-stale-review-guard-0001', repeat('d', 64)
      );
    end
    $stale_review$
  $test$,
  '40001',
  'ai_pack_review_evidence_stale',
  'live evidence drift blocks counted review before a stale receipt is persisted'
);
select throws_ok(
  $test$
    do $stale_approval$
    begin
      insert into public.evidence_items (
        id, kind, ref, is_public, moderation_state, sha256, added_by_wallet
      ) values (
        'ab000000-0000-4000-8000-000000000009', 'document',
        'TRANSIENT_APPROVAL_DRIFT', false, 'approved', repeat('9', 64),
        '11111111111111111111111111111112'
      );
      insert into public.case_evidence_links (
        id, case_id, evidence_item_id, added_by_wallet
      ) values (
        'ac000000-0000-4000-8000-000000000009',
        'aa000000-0000-4000-8000-000000000001',
        'ab000000-0000-4000-8000-000000000009',
        '11111111111111111111111111111112'
      );
      perform * from public.osi_v2_prepare_ai_pack_approval(
        repeat('y', 43), '11111111111111111111111111111117',
        (select version_public_ref from pg_temp.ai_pack_main_prepare),
        'ai-pack-stale-approval-guard-0001', repeat('e', 64),
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      );
    end
    $stale_approval$
  $test$,
  '40001',
  'ai_pack_approval_evidence_stale',
  'live evidence drift blocks approval before a stale receipt is persisted'
);

select lives_ok(
  $test$
    create temporary table ai_pack_approval_prepare on commit drop as
    select * from public.osi_v2_prepare_ai_pack_approval(
      repeat('z', 43), '11111111111111111111111111111117',
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      'ai-pack-standard-approval-0001', repeat('f', 64),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  $test$,
  'full maintainer binds a class-A Memo to the exact real analyst quorum'
);
select ok(
  (
    select independent_count = 2
       and total_weight = 2.50
       and quorum_hash ~ '^[0-9a-f]{64}$'
      from pg_temp.ai_pack_approval_prepare
  ),
  'approval proof snapshots both accepted quorum gates'
);
select throws_ok(
  $test$
    insert into public.event_receipts (
      id, event_version, event_type, target_type, target_id, public_ref,
      actor_wallet, actor_role, decision, proof_type, memo_ref,
      anchor_wallet, payload_hash, tx_sig, server_verified, occurred_at,
      decision_channel
    ) values (
      'ad000000-0000-4000-8000-000000000001',
      'OSI2', 'AI_PACK_APPROVED', 'pack_version',
      (select version_id::text from pg_temp.ai_pack_main_prepare),
      (select version_public_ref from pg_temp.ai_pack_main_prepare),
      '11111111111111111111111111111117', 'maintainer', 'approve',
      'solana_memo', 'Bootstrap must not approve an AI Pack.',
      '11111111111111111111111111111117', repeat('f', 64),
      repeat('U', 88), true, statement_timestamp(), 'maintainer_bootstrap'
    )
  $test$,
  '23514',
  'new row for relation "event_receipts" violates check constraint "event_receipts_ai_pack_approval_standard_check"',
  'AI Pack approval is structurally unreachable through bootstrap'
);
select lives_ok(
  $test$
    create temporary table ai_pack_approval_commit on commit drop as
    select * from public.osi_v2_commit_ai_pack_approval(
      repeat('z', 43),
      repeat('T', 88),
      (select proof_text from pg_temp.ai_pack_approval_prepare),
      statement_timestamp(),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  $test$,
  'full maintainer finalizes only the exact standard-channel quorum'
);
select ok(
  (
    select version.lifecycle_state = 'approved'
       and version.approval_independent_count = 2
       and version.approval_total_weight = 2.50
       and version.approval_quorum_hash = prepared.quorum_hash
       and receipt.event_type = 'AI_PACK_APPROVED'
       and receipt.proof_type = 'solana_memo'
       and receipt.decision_channel = 'standard'
       and receipt.tx_sig = repeat('T', 88)
      from public.ai_pack_versions as version
      join pg_temp.ai_pack_approval_prepare as prepared
        on prepared.version_id = version.id
      join public.event_receipts as receipt
        on receipt.id = version.approval_receipt_id
  ),
  'approved state records real analyst quorum and confirmed standard Memo proof'
);
update public.osi_config set value = 'false'
 where key = 'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED';
select is(
  (
    select idempotent_replay
      from public.osi_v2_commit_ai_pack_approval(
        repeat('z', 43),
        repeat('T', 88),
        (select proof_text from pg_temp.ai_pack_approval_prepare),
        statement_timestamp(),
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      )
  ),
  true,
  'exact consumed approval replay returns the original result even after disable'
);
update public.osi_config set value = 'true'
 where key = 'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED';
select is(
  (select count(*)::integer from public.osi_v2_list_public_ai_packs()),
  1,
  'one standard-receipt-approved version becomes publicly visible'
);
select ok(
  (
    select row_to_json(projected)::text like '%PUBLIC_LAYER_ONLY%'
       and row_to_json(projected)::text not like '%OWNER_LAYER_ONLY%'
       and row_to_json(projected)::text not like '%ANALYST_LAYER_ONLY%'
       and row_to_json(projected)::text not like '%ANALYST_PRIVATE_NOTE%'
      from public.osi_v2_list_public_ai_packs() as projected
  ),
  'public projection exposes only minimized metadata and public-safe content'
);
select ok(
  (
    select not ((packs #> '{0,versions,0}') ? 'content_owner_safe')
       and not ((packs #> '{0,versions,0}') ? 'content_analyst_restricted')
       and not ((packs #> '{0,versions,0}') ? 'reviews')
      from public.osi_v2_get_authorized_ai_packs(
        'OSI-AIPACK0001', '11111111111111111111111111111118', null
      )
  ),
  'authorized public viewer cannot cross into owner or analyst layers'
);

-- ---------------------------------------------------------------------------
-- Layer-aware drift is derived on reads and persisted only by a gated write.
-- ---------------------------------------------------------------------------

insert into public.evidence_items (
  id, kind, ref, is_public, moderation_state, sha256, added_by_wallet
) values (
  'ab000000-0000-4000-8000-000000000007',
  'document',
  'OWNER_SCOPE_EVIDENCE_ADDED_LATER',
  false,
  'approved',
  repeat('7', 64),
  '11111111111111111111111111111112'
);
insert into public.case_evidence_links (
  id, case_id, evidence_item_id, added_by_wallet
) values (
  'ac000000-0000-4000-8000-000000000007',
  'aa000000-0000-4000-8000-000000000001',
  'ab000000-0000-4000-8000-000000000007',
  '11111111111111111111111111111112'
);

select ok(
  (
    select public_layer_is_stale is false
      from public.osi_v2_list_public_ai_packs('OSI-AIPACK0001')
  ),
  'owner-only evidence drift does not mark the public layer stale'
);
select ok(
  (
    select packs #>> '{0,versions,0,staleness,owner_safe,stale}' = 'true'
       and not (
         (packs #> '{0,versions,0,staleness}') ? 'analyst_restricted'
       )
      from public.osi_v2_get_authorized_ai_packs(
        'OSI-AIPACK0001', '11111111111111111111111111111112', null
      )
  ),
  'owner read derives owner-safe drift without exposing restricted staleness'
);
select ok(
  (
    select packs #>> '{0,versions,0,staleness,owner_safe,stale}' = 'true'
       and packs #>> '{0,versions,0,staleness,analyst_restricted,stale}'
         = 'true'
       and packs #>> '{0,versions,0,staleness,public,stale}' = 'false'
      from public.osi_v2_get_authorized_ai_packs(
        'OSI-AIPACK0001', '11111111111111111111111111111115', null
      )
  ),
  'analyst read sees cumulative owner-safe and restricted drift by layer'
);

update public.osi_config set value = 'false'
 where key = 'OSI_V2_AI_PACK_WRITES_ENABLED';
select throws_ok(
  $test$
    select * from public.osi_v2_refresh_ai_pack_staleness(
      (select version_public_ref from pg_temp.ai_pack_main_prepare)
    )
  $test$,
  '55000',
  'ai_pack_writes_disabled',
  'flag-off staleness refresh cannot mutate the artifact'
);
select ok(
  (
    select not public_layer_is_stale
       and not owner_safe_layer_is_stale
       and not analyst_restricted_layer_is_stale
       and first_stale_receipt_id is null
      from public.ai_pack_versions
     where id = (select version_id from pg_temp.ai_pack_main_prepare)
  ),
  'flag-off read-derived drift leaves persisted state byte-identical'
);
update public.osi_config set value = 'true'
 where key = 'OSI_V2_AI_PACK_WRITES_ENABLED';

select lives_ok(
  $test$
    create temporary table ai_pack_owner_drift_refresh on commit drop as
    select * from public.osi_v2_refresh_ai_pack_staleness(
      (select version_public_ref from pg_temp.ai_pack_main_prepare)
    )
  $test$,
  'service refresh persists newly observed owner and restricted drift'
);
select ok(
  (
    select not public_layer_is_stale
       and owner_safe_layer_is_stale
       and analyst_restricted_layer_is_stale
       and is_stale
       and receipt_id is not null
      from pg_temp.ai_pack_owner_drift_refresh
  ),
  'owner-safe evidence changes only owner-safe and cumulative restricted layers'
);
select is(
  (
    select count(*)::integer
      from public.event_receipts
     where event_type = 'PACK_STALE'
       and target_id = (
         select version_id::text from pg_temp.ai_pack_main_prepare
       )
  ),
  1,
  'first new layer drift emits one immutable PACK_STALE event'
);
select lives_ok(
  $test$
    select * from public.osi_v2_refresh_ai_pack_staleness(
      (select version_public_ref from pg_temp.ai_pack_main_prepare)
    )
  $test$,
  'repeated refresh of already recorded drift is idempotent'
);
select is(
  (
    select count(*)::integer
      from public.event_receipts
     where event_type = 'PACK_STALE'
       and target_id = (
         select version_id::text from pg_temp.ai_pack_main_prepare
       )
  ),
  1,
  'idempotent staleness refresh emits no duplicate event'
);

insert into public.evidence_items (
  id, kind, ref, is_public, moderation_state, sha256, added_by_wallet
) values (
  'ab000000-0000-4000-8000-000000000008',
  'url',
  'https://example.test/new-public-evidence',
  true,
  'approved',
  repeat('8', 64),
  '11111111111111111111111111111118'
);
insert into public.case_evidence_links (
  id, case_id, evidence_item_id, added_by_wallet
) values (
  'ac000000-0000-4000-8000-000000000008',
  'aa000000-0000-4000-8000-000000000001',
  'ab000000-0000-4000-8000-000000000008',
  '11111111111111111111111111111118'
);
select lives_ok(
  $test$
    create temporary table ai_pack_public_drift_refresh on commit drop as
    select * from public.osi_v2_refresh_ai_pack_staleness(
      (select version_public_ref from pg_temp.ai_pack_main_prepare)
    )
  $test$,
  'new public evidence records the newly stale public layer'
);
select ok(
  (
    select public_layer_is_stale
       and owner_safe_layer_is_stale
       and analyst_restricted_layer_is_stale
       and is_stale
      from pg_temp.ai_pack_public_drift_refresh
  ),
  'public evidence drift propagates through all cumulative layers'
);
select is(
  (
    select count(*)::integer
      from public.event_receipts
     where event_type = 'PACK_STALE'
       and target_id = (
         select version_id::text from pg_temp.ai_pack_main_prepare
       )
  ),
  2,
  'a newly affected layer emits one additional immutable stale event'
);
select ok(
  (
    select public_layer_is_stale
      from public.osi_v2_list_public_ai_packs('OSI-AIPACK0001')
  ),
  'public projection honestly reports public-layer evidence drift'
);

-- Return all rollout controls to their shipped fail-closed values inside the
-- transaction as a final assertion; ROLLBACK then removes every fixture.
update public.osi_config
   set value = 'false'
 where key in (
   'OSI_V2_WRITES_ENABLED',
   'OSI_V2_PROOF_ENABLED',
   'OSI_V2_AI_PACK_WRITES_ENABLED',
   'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED'
 );
select is(
  osi_private.osi_v2_ai_pack_writes_enabled(),
  false,
  'AI Pack write gate ends fail-closed'
);
select is(
  (select count(*)::integer from public.osi_v2_list_public_ai_packs()),
  1,
  'read-only approved projection remains available when write flags are off'
);

select * from finish();
rollback;
