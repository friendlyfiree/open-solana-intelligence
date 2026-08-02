-- OSI V2 Report rejection transition.
--
-- docs/OSI_V2_STATE_MACHINES.md defines `in_review -> rejected` as an analyst
-- quorum outcome anchored by a class-A `REPORT_REJECTED` Memo, with no
-- maintainer required and no maintainer bootstrap alternative. The event type,
-- the lifecycle transition and the reject quorum were all already modeled and
-- enforced; only the prepare/commit pair was missing, so an exact version whose
-- reject quorum was reached had no authorized next action and stayed in
-- `in_review` forever.
--
-- This delta is additive: it adds the payload hash, prepare and commit
-- functions, and widens the shared Report review rate window to count the new
-- purpose. It rewrites no row and changes no existing publication behaviour.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- The rejection payload binds the exact version, its immutable content, the
-- counted quorum snapshot and the acting analyst. It deliberately excludes the
-- published pointer: rejection never moves it.
create function osi_private.osi_v2_report_rejection_payload_hash(
  p_version_id uuid,
  p_version_ref text,
  p_actor_wallet text,
  p_body_private text,
  p_content_public_safe text,
  p_evidence_snapshot_hash text,
  p_quorum_hash text
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      pg_catalog.convert_to(jsonb_build_object(
        'actor_wallet', p_actor_wallet,
        'body_sha256', encode(extensions.digest(
          pg_catalog.convert_to(p_body_private, 'UTF8'), 'sha256'
        ), 'hex'),
        'content_public_safe_sha256', case
          when p_content_public_safe is null then null
          else encode(extensions.digest(
            pg_catalog.convert_to(p_content_public_safe, 'UTF8'), 'sha256'
          ), 'hex')
        end,
        'event_type', 'REPORT_REJECTED',
        'evidence_snapshot_hash', p_evidence_snapshot_hash,
        'quorum_hash', p_quorum_hash,
        'version_id', p_version_id,
        'version_ref', p_version_ref
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

comment on function osi_private.osi_v2_report_rejection_payload_hash(
  uuid, text, text, text, text, text, text
) is
  'Exact REPORT_REJECTED payload binding for one immutable Report version and its counted quorum snapshot.';

-- The shared Report review rate window must count rejection preparation too,
-- otherwise the new purpose would be an unmetered path to the same tables.
create or replace function osi_private.osi_v2_check_report_review_rate(
  p_actor_wallet text,
  p_request_fingerprint_hash text,
  p_purpose text,
  p_now timestamptz
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  window_seconds integer;
  max_per_wallet integer;
  max_per_fingerprint integer;
  cooldown_seconds integer;
  wallet_count bigint;
  fingerprint_count bigint;
  last_issued timestamptz;
  counted_purposes constant text[] := array[
    'CASE_REPORT_REVIEW_CAST', 'CASE_REPORT_REVIEW_REVISED',
    'REPORT_PUBLISHED', 'REPORT_REJECTED'
  ];
begin
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into window_seconds from public.osi_config as config
   where config.key = 'OSI_V2_REPORT_REVIEW_RATE_WINDOW_SECONDS';
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into max_per_wallet from public.osi_config as config
   where config.key = 'OSI_V2_REPORT_REVIEW_MAX_PER_WALLET';
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into max_per_fingerprint from public.osi_config as config
   where config.key = 'OSI_V2_REPORT_REVIEW_MAX_PER_FINGERPRINT';
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into cooldown_seconds from public.osi_config as config
   where config.key = 'OSI_V2_REPORT_REVIEW_COOLDOWN_SECONDS';
  if window_seconds is null or window_seconds not between 60 and 3600
     or max_per_wallet is null or max_per_wallet not between 1 and 100
     or max_per_fingerprint is null or max_per_fingerprint not between 1 and 200
     or cooldown_seconds is null or cooldown_seconds not between 0 and 300 then
    raise exception 'Report review rate configuration is absent or invalid'
      using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-review-wallet:' || p_actor_wallet, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-review-fingerprint:' || p_request_fingerprint_hash, 0)
  );
  select count(*), max(n.issued_at) into wallet_count, last_issued
    from public.osi_nonces as n
   where n.actor_wallet = p_actor_wallet
     and n.purpose = any(counted_purposes)
     and n.issued_at > p_now - pg_catalog.make_interval(secs => window_seconds);
  select count(*) into fingerprint_count
    from public.osi_nonces as n
   where n.request_fingerprint_hash = p_request_fingerprint_hash
     and n.purpose = any(counted_purposes)
     and n.issued_at > p_now - pg_catalog.make_interval(secs => window_seconds);
  if wallet_count >= max_per_wallet or fingerprint_count >= max_per_fingerprint then
    raise exception 'Report review rate limit exceeded' using errcode = 'P0001';
  end if;
  if last_issued is not null
     and last_issued > p_now - pg_catalog.make_interval(secs => cooldown_seconds) then
    raise exception 'Report review cooldown is active' using errcode = 'P0001';
  end if;
end
$$;

create function osi_private.osi_v2_prepare_report_rejection(
  p_nonce text,
  p_actor_wallet text,
  p_version_id uuid,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, case_public_ref text, report_public_ref text,
  version_public_ref text, actor_role text, payload_hash text,
  quorum_hash text, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.osi_nonces%rowtype;
  version_row public.case_report_versions%rowtype;
  report_row public.case_reports%rowtype;
  case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype;
  quorum record;
  receipt_role text;
  exact_hash text;
  issued_time timestamptz := statement_timestamp();
  ttl_seconds integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Report rejection prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_report_review_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Report review writes are disabled' using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-reject-idempotency:' || p_idempotency_key, 0)
  );
  select version.* into version_row from public.case_report_versions as version
   where version.id = p_version_id for update;
  select report.* into report_row from public.case_reports as report
   where report.id = version_row.report_id for update;
  select case_item.* into case_row from public.cases as case_item
   where case_item.id = report_row.case_id;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = p_actor_wallet;
  if version_row.id is null or not report_row.native_intake
     or report_row.current_version_id is distinct from version_row.id
     or version_row.lifecycle_state <> 'in_review'
     or case_row.visibility <> 'public'
     or case_row.stage not in ('open_public', 'in_review', 'reopened') then
    raise exception 'Report version is not available for rejection' using errcode = '42501';
  end if;
  -- Rejection is an analyst-quorum outcome only. The author and the Case owner
  -- are excluded exactly as they are for publication, and the D17 maintainer
  -- bootstrap channel deliberately does not reach this transition.
  if p_actor_wallet in (report_row.author_wallet, case_row.submitted_by_wallet)
     or profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true
     or not exists (
       select 1 from public.case_report_reviews as review
        where review.report_version_id = version_row.id
          and review.reviewer_wallet = p_actor_wallet
          and review.is_active = true and review.decision = 'reject'
     ) then
    raise exception 'Rejection requires an active rejecting eligible analyst'
      using errcode = '42501';
  end if;
  select * into quorum from osi_private.osi_v2_report_quorum(version_row.id);
  if quorum.reject_ready is distinct from true then
    raise exception 'Report rejection quorum is not ready' using errcode = '42501';
  end if;
  -- A version can never be both publishable and rejectable at once. If both
  -- gates report ready the tally is contested, and no single actor may settle
  -- it silently.
  if quorum.approve_ready is true then
    raise exception 'Report approve and reject quorum are both ready' using errcode = '42501';
  end if;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  exact_hash := osi_private.osi_v2_report_rejection_payload_hash(
    version_row.id, version_row.version_ref, p_actor_wallet,
    version_row.body_private, version_row.content_public_safe,
    version_row.evidence_snapshot_hash, quorum.quorum_hash
  );
  select n.* into existing from public.osi_nonces as n
   where n.idempotency_key = p_idempotency_key for update;
  if found then
    if existing.purpose <> 'REPORT_REJECTED'
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.target_id is distinct from version_row.id::text
       or existing.payload_hash is distinct from exact_hash then
      raise exception 'Idempotency key is bound to another exact Report rejection'
        using errcode = '23514';
    end if;
    return query select existing.nonce,
      existing.binding_context->>'case_public_ref',
      existing.binding_context->>'report_public_ref',
      existing.binding_context->>'version_public_ref',
      existing.binding_context->>'actor_role', existing.payload_hash,
      existing.binding_context->>'quorum_hash', existing.issued_at,
      existing.expires_at, existing.consumed_by_receipt_id, true;
    return;
  end if;
  perform osi_private.osi_v2_check_report_review_rate(
    p_actor_wallet, p_request_fingerprint_hash, 'REPORT_REJECTED', issued_time
  );
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into ttl_seconds from public.osi_config as config
   where config.key = 'OSI_V2_NONCE_TTL_SECONDS';
  if ttl_seconds is null or ttl_seconds not between 30 and 300 then
    raise exception 'Report rejection nonce configuration is invalid' using errcode = '55000';
  end if;
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, 'REPORT_REJECTED', p_actor_wallet, 'report_version', version_row.id::text,
    exact_hash, p_idempotency_key, p_request_fingerprint_hash,
    jsonb_build_object(
      'actor_role', receipt_role,
      'case_public_ref', case_row.public_ref,
      'quorum_hash', quorum.quorum_hash,
      'report_public_ref', report_row.public_ref,
      'version_public_ref', version_row.version_ref
    ),
    issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds)
  );
  return query select p_nonce, case_row.public_ref, report_row.public_ref,
    version_row.version_ref, receipt_role, exact_hash, quorum.quorum_hash,
    issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds),
    null::uuid, false;
end
$$;

comment on function osi_private.osi_v2_prepare_report_rejection(
  text, text, uuid, text, text
) is
  'Service-only exact REPORT_REJECTED proof issuance. Requires an eligible independent analyst holding an active reject review plus a ready reject quorum.';

create function osi_private.osi_v2_commit_report_rejection(
  p_nonce text,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz
)
returns table (
  case_public_ref text, report_public_ref text, version_public_ref text,
  actor_role text, quorum_hash text, rejection_receipt_id uuid,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  existing_receipt public.event_receipts%rowtype;
  version_row public.case_report_versions%rowtype;
  report_row public.case_reports%rowtype;
  case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype;
  quorum record;
  receipt_role text;
  exact_hash text;
  new_receipt_id uuid := gen_random_uuid();
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Report rejection commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_report_review_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Report review writes are disabled' using errcode = '55000';
  end if;
  select n.* into bound from public.osi_nonces as n
   where n.nonce = p_nonce for update;
  if bound.nonce is null or bound.purpose <> 'REPORT_REJECTED'
     or bound.target_type <> 'report_version' then
    raise exception 'Report rejection nonce binding is invalid' using errcode = '23514';
  end if;
  if bound.consumed_at is not null then
    select receipt.* into existing_receipt from public.event_receipts as receipt
     where receipt.id = bound.consumed_by_receipt_id;
    if existing_receipt.id is null
       or existing_receipt.event_type <> 'REPORT_REJECTED'
       or existing_receipt.tx_sig is distinct from p_tx_sig
       or existing_receipt.memo_ref is distinct from p_memo_ref
       or existing_receipt.payload_hash is distinct from bound.payload_hash then
      raise exception 'Consumed Report rejection nonce does not match exact retry'
        using errcode = '23514';
    end if;
    return query select bound.binding_context->>'case_public_ref',
      bound.binding_context->>'report_public_ref',
      bound.binding_context->>'version_public_ref', existing_receipt.actor_role,
      bound.binding_context->>'quorum_hash', existing_receipt.id, true;
    return;
  end if;
  if statement_timestamp() > bound.expires_at then
    raise exception 'Report rejection nonce expired' using errcode = '22023';
  end if;
  select version.* into version_row from public.case_report_versions as version
   where version.id = bound.target_id::uuid for update;
  select report.* into report_row from public.case_reports as report
   where report.id = version_row.report_id for update;
  select case_item.* into case_row from public.cases as case_item
   where case_item.id = report_row.case_id;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = bound.actor_wallet;
  if version_row.id is null or not report_row.native_intake
     or report_row.current_version_id is distinct from version_row.id
     or version_row.lifecycle_state <> 'in_review'
     or case_row.visibility <> 'public'
     or case_row.stage not in ('open_public', 'in_review', 'reopened') then
    raise exception 'Report rejection lineage changed after prepare' using errcode = '40001';
  end if;
  if bound.actor_wallet in (report_row.author_wallet, case_row.submitted_by_wallet)
     or profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true
     or not exists (
       select 1 from public.case_report_reviews as review
        where review.report_version_id = version_row.id
          and review.reviewer_wallet = bound.actor_wallet
          and review.is_active = true and review.decision = 'reject'
     ) then
    raise exception 'Rejection requires an active rejecting eligible analyst'
      using errcode = '42501';
  end if;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  if receipt_role is distinct from bound.binding_context->>'actor_role' then
    raise exception 'Rejection actor role changed after prepare' using errcode = '42501';
  end if;
  select * into quorum from osi_private.osi_v2_report_quorum(version_row.id);
  if quorum.reject_ready is distinct from true
     or quorum.approve_ready is true
     or quorum.quorum_hash is distinct from bound.binding_context->>'quorum_hash' then
    raise exception 'Report rejection quorum changed after prepare' using errcode = '40001';
  end if;
  exact_hash := osi_private.osi_v2_report_rejection_payload_hash(
    version_row.id, version_row.version_ref, bound.actor_wallet,
    version_row.body_private, version_row.content_public_safe,
    version_row.evidence_snapshot_hash, quorum.quorum_hash
  );
  if exact_hash is distinct from bound.payload_hash then
    raise exception 'Report rejection payload changed after prepare' using errcode = '23514';
  end if;
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, weight, reason_code, proof_type,
    memo_ref, anchor_wallet, payload_hash, nonce, tx_sig, signature,
    server_verified, occurred_at, created_at
  ) values (
    new_receipt_id, 'OSI2', 'REPORT_REJECTED', 'report_version', version_row.id::text,
    version_row.version_ref, bound.actor_wallet, receipt_role, 'reject', null,
    null, 'solana_memo', p_memo_ref, bound.actor_wallet, exact_hash,
    bound.nonce, p_tx_sig, null, true, p_occurred_at, statement_timestamp()
  );
  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(), consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound.nonce and nonce.consumed_at is null;
  if not found then
    raise exception 'Report rejection nonce consumed concurrently' using errcode = '40001';
  end if;
  -- A rejected version keeps published_at and publication_receipt_id null, so
  -- the publication-state constraint stays satisfied and the published pointer
  -- on the header is untouched. The rejection receipt is discoverable through
  -- event_receipts on this exact version.
  update public.case_report_versions as version
     set lifecycle_state = 'rejected', updated_at = statement_timestamp()
   where version.id = version_row.id and version.lifecycle_state = 'in_review';
  if not found then
    raise exception 'Report rejection state changed concurrently' using errcode = '40001';
  end if;
  return query select case_row.public_ref, report_row.public_ref,
    version_row.version_ref, receipt_role, quorum.quorum_hash,
    new_receipt_id, false;
end
$$;

comment on function osi_private.osi_v2_commit_report_rejection(
  text, text, text, timestamptz
) is
  'Service-only exact REPORT_REJECTED commit. Re-proves lineage, analyst authority, reject quorum and payload before recording the immutable Memo receipt and moving the exact version to rejected.';

create function public.osi_v2_prepare_report_rejection(
  p_nonce text, p_actor_wallet text, p_version_id uuid,
  p_idempotency_key text, p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, case_public_ref text, report_public_ref text,
  version_public_ref text, actor_role text, payload_hash text,
  quorum_hash text, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_prepare_report_rejection(
    p_nonce, p_actor_wallet, p_version_id, p_idempotency_key,
    p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_commit_report_rejection(
  p_nonce text, p_tx_sig text, p_memo_ref text, p_occurred_at timestamptz
)
returns table (
  case_public_ref text, report_public_ref text, version_public_ref text,
  actor_role text, quorum_hash text, rejection_receipt_id uuid,
  idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_report_rejection(
    p_nonce, p_tx_sig, p_memo_ref, p_occurred_at
  )
$$;

comment on function public.osi_v2_prepare_report_rejection(
  text, text, uuid, text, text
) is
  'Service-role-only PostgREST wrapper for exact REPORT_REJECTED proof issuance.';
comment on function public.osi_v2_commit_report_rejection(
  text, text, text, timestamptz
) is
  'Service-role-only PostgREST wrapper for the exact REPORT_REJECTED commit.';

revoke all privileges on function osi_private.osi_v2_report_rejection_payload_hash(
  uuid, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_report_rejection(
  text, text, uuid, text, text
) from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_report_rejection(
  text, text, text, timestamptz
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_prepare_report_rejection(
  text, text, uuid, text, text
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_report_rejection(
  text, text, text, timestamptz
) from public, anon, authenticated;

grant execute on function osi_private.osi_v2_report_rejection_payload_hash(
  uuid, text, text, text, text, text, text
) to service_role;
grant execute on function osi_private.osi_v2_prepare_report_rejection(
  text, text, uuid, text, text
) to service_role;
grant execute on function osi_private.osi_v2_commit_report_rejection(
  text, text, text, timestamptz
) to service_role;
grant execute on function public.osi_v2_prepare_report_rejection(
  text, text, uuid, text, text
) to service_role;
grant execute on function public.osi_v2_commit_report_rejection(
  text, text, text, timestamptz
) to service_role;

commit;
