-- OSI V2 Case normal initial rejection and owner appeal.
--
-- Normal rejection is a class-A analyst-quorum outcome (>=2 independent
-- analysts and >=2.00 counted weight). It is never a maintainer shortcut.
-- An owner appeal is class B, appends new private evidence without rewriting
-- the immutable original submission, and starts a fresh initial-review cycle.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create function osi_private.osi_v2_case_review_cycle_started_at(p_case_id uuid)
returns timestamptz
language sql stable security invoker set search_path = ''
as $$
  select coalesce(max(receipt.occurred_at), '-infinity'::timestamptz)
    from public.event_receipts as receipt
   where receipt.event_version = 'OSI2'
     and receipt.event_type = 'CASE_APPEAL_SUBMITTED'
     and receipt.target_type = 'case'
     and receipt.target_id = p_case_id::text
     and receipt.proof_type = 'wallet_signed_server_verified'
     and receipt.server_verified = true
$$;

comment on function osi_private.osi_v2_case_review_cycle_started_at(uuid) is
  'Start of the current initial-review cycle. Reviews at or before the latest owner appeal remain history and cannot decide the new cycle.';

create or replace function osi_private.osi_v2_case_review_quorum(p_case_id uuid)
returns table (
  analyst_count bigint, total_weight numeric, maintainer_count bigint,
  analyst_ready boolean, maintainer_ready boolean, ready boolean
)
language sql stable security invoker set search_path = ''
as $$
  with qualified as (
    select review.reviewer_wallet, review.weight,
      review.reviewer_role = 'analyst'
        and profile.status in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
        and profile.verified = true and profile.approved = true
        and receipt.actor_role in ('analyst', 'senior') as analyst_approval,
      review.reviewer_role = 'maintainer' and review.weight = 0
        and receipt.actor_role = 'maintainer' as maintainer_approval
    from public.case_initial_reviews as review
    left join public.analyst_profiles as profile on profile.wallet = review.reviewer_wallet
    join public.event_receipts as receipt
      on receipt.id = review.event_receipt_id
     and receipt.target_type = 'case'
     and receipt.target_id = review.case_id::text
     and receipt.actor_wallet = review.reviewer_wallet
     and receipt.decision = 'approve_open'
     and receipt.event_type in ('CASE_INITIAL_REVIEW_CAST', 'CASE_INITIAL_REVIEW_REVISED')
     and receipt.proof_type = 'wallet_signed_server_verified'
     and receipt.server_verified = true
    where review.case_id = p_case_id and review.is_active = true
      and review.decision = 'approve_open'
      and review.created_at > osi_private.osi_v2_case_review_cycle_started_at(p_case_id)
      and (review.reviewer_role <> 'analyst'
        or osi_private.osi_v2_sas_review_counts('case_initial', review.id))
  ), totals as (
    select count(distinct reviewer_wallet) filter (where analyst_approval) as analyst_count,
      coalesce(sum(weight) filter (where analyst_approval), 0) as total_weight,
      count(distinct reviewer_wallet) filter (where maintainer_approval) as maintainer_count
    from qualified
  )
  select analyst_count, total_weight, maintainer_count,
    analyst_count >= 1 and total_weight >= 0.50,
    maintainer_count >= 1,
    (analyst_count >= 1 and total_weight >= 0.50) or maintainer_count >= 1
  from totals
$$;

create function osi_private.osi_v2_case_rejection_quorum(p_case_id uuid)
returns table (
  approve_count integer, approve_weight numeric,
  reject_count integer, reject_weight numeric,
  approve_ready boolean, reject_ready boolean, quorum_hash text
)
language plpgsql stable security invoker set search_path = ''
as $$
declare snapshot jsonb;
begin
  with counted as (
    select review.id, review.reviewer_wallet, review.decision, review.weight,
      receipt.actor_role, review.created_at
    from public.case_initial_reviews as review
    join public.analyst_profiles as profile on profile.wallet = review.reviewer_wallet
    join public.event_receipts as receipt
      on receipt.id = review.event_receipt_id
     and receipt.event_version = 'OSI2'
     and receipt.event_type in ('CASE_INITIAL_REVIEW_CAST', 'CASE_INITIAL_REVIEW_REVISED')
     and receipt.target_type = 'case' and receipt.target_id = review.case_id::text
     and receipt.actor_wallet = review.reviewer_wallet
     and receipt.decision = review.decision and receipt.weight = review.weight
     and receipt.reason_code is not distinct from review.reason_code
     and receipt.proof_type = 'wallet_signed_server_verified'
     and receipt.server_verified = true
    where review.case_id = p_case_id and review.is_active = true
      and review.reviewer_role = 'analyst'
      and review.decision in ('approve_open', 'reject')
      and review.created_at > osi_private.osi_v2_case_review_cycle_started_at(p_case_id)
      and profile.status in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
      and profile.verified = true and profile.approved = true
      and osi_private.osi_v2_sas_review_counts('case_initial', review.id)
  )
  select count(*) filter (where decision = 'approve_open')::integer,
    coalesce(sum(weight) filter (where decision = 'approve_open'), 0),
    count(*) filter (where decision = 'reject')::integer,
    coalesce(sum(weight) filter (where decision = 'reject'), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'actor_role', actor_role, 'decision', decision, 'review_id', id,
      'reviewer_wallet', reviewer_wallet, 'weight', weight
    ) order by reviewer_wallet) filter (where decision in ('approve_open', 'reject')), '[]'::jsonb)
    into approve_count, approve_weight, reject_count, reject_weight, snapshot
  from counted;
  approve_ready := approve_count >= 1 and approve_weight >= 0.50;
  reject_ready := reject_count >= 2 and reject_weight >= 2.00;
  quorum_hash := encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'case_id', p_case_id,
    'cycle_started_at', osi_private.osi_v2_case_review_cycle_started_at(p_case_id),
    'reject_threshold_count', 2, 'reject_threshold_weight', 2.00,
    'reviews', snapshot
  )::text, 'UTF8'), 'sha256'), 'hex');
  return next;
end
$$;

create function osi_private.osi_v2_case_action_ttl(
  p_actor_wallet text, p_request_fingerprint_hash text, p_idempotency_key text
)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare ttl_seconds integer; window_seconds integer; max_per_wallet integer;
  max_per_fingerprint integer; wallet_count bigint; fingerprint_count bigint;
  issued_time timestamptz := statement_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-case-idempotency:' || p_idempotency_key, 0));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-case-wallet:' || p_actor_wallet, 0));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-case-fingerprint:' || p_request_fingerprint_hash, 0));
  select case when value ~ '^[0-9]+$' then value::integer end into ttl_seconds
    from public.osi_config where key = 'OSI_V2_NONCE_TTL_SECONDS';
  select case when value ~ '^[0-9]+$' then value::integer end into window_seconds
    from public.osi_config where key = 'OSI_V2_NONCE_RATE_WINDOW_SECONDS';
  select case when value ~ '^[0-9]+$' then value::integer end into max_per_wallet
    from public.osi_config where key = 'OSI_V2_NONCE_MAX_PER_WALLET';
  select case when value ~ '^[0-9]+$' then value::integer end into max_per_fingerprint
    from public.osi_config where key = 'OSI_V2_NONCE_MAX_PER_FINGERPRINT';
  if ttl_seconds is null or ttl_seconds not between 30 and 300
     or window_seconds is null or window_seconds not between 60 and 3600
     or max_per_wallet is null or max_per_wallet not between 1 and 100
     or max_per_fingerprint is null or max_per_fingerprint not between 1 and 200 then
    raise exception 'Case nonce security configuration is absent or invalid' using errcode = '55000';
  end if;
  -- An exact idempotent retry returns its original reservation even when the
  -- actor has since reached the ordinary rate window. The caller rechecks the
  -- complete purpose/target/payload binding before returning it.
  if exists(select 1 from public.osi_nonces where idempotency_key=p_idempotency_key) then
    return ttl_seconds;
  end if;
  select count(*) into wallet_count from public.osi_nonces as nonce
   where nonce.actor_wallet = p_actor_wallet
     and nonce.issued_at > issued_time - pg_catalog.make_interval(secs => window_seconds);
  select count(*) into fingerprint_count from public.osi_nonces as nonce
   where nonce.request_fingerprint_hash = p_request_fingerprint_hash
     and nonce.issued_at > issued_time - pg_catalog.make_interval(secs => window_seconds);
  if wallet_count >= max_per_wallet or fingerprint_count >= max_per_fingerprint then
    raise exception 'Case nonce rate limit exceeded' using errcode = 'P0001';
  end if;
  return ttl_seconds;
end
$$;

create function osi_private.osi_v2_case_outcome_payload_hash(
  p_case_id uuid, p_case_ref text, p_actor_wallet text,
  p_actor_role text, p_outcome text, p_quorum_hash text
)
returns text
language sql immutable security invoker set search_path = ''
as $$
  select encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'actor_role', p_actor_role, 'actor_wallet', p_actor_wallet,
    'case_id', p_case_id, 'case_ref', p_case_ref,
    'outcome', p_outcome, 'quorum_hash', p_quorum_hash
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;

create function osi_private.osi_v2_prepare_case_rejection(
  p_nonce text, p_actor_wallet text, p_case_id uuid,
  p_idempotency_key text, p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, public_ref text, actor_role text, payload_hash text,
  quorum_hash text, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language plpgsql security invoker set search_path = ''
as $$
declare existing public.osi_nonces%rowtype; case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype; quorum record; exact_hash text;
  receipt_role text; issued_time timestamptz := statement_timestamp(); ttl integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Case rejection prepare is service-only' using errcode = '42501'; end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode = '55000'; end if;
  ttl := osi_private.osi_v2_case_action_ttl(
    p_actor_wallet, p_request_fingerprint_hash, p_idempotency_key);
  select * into case_row from public.cases where id = p_case_id for update;
  select * into profile from public.analyst_profiles where wallet = p_actor_wallet;
  if case_row.id is null or case_row.stage <> 'initial_review' or case_row.visibility <> 'private'
     or case_row.submitted_by_wallet = p_actor_wallet then
    raise exception 'Case is not available for rejection' using errcode = '42501'; end if;
  if profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true then
    raise exception 'Case rejection requires an eligible analyst' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.case_initial_reviews as review
     where review.case_id = case_row.id and review.reviewer_wallet = p_actor_wallet
       and review.reviewer_role = 'analyst' and review.decision = 'reject'
       and review.is_active = true
       and review.created_at > osi_private.osi_v2_case_review_cycle_started_at(case_row.id)
       and osi_private.osi_v2_sas_review_counts('case_initial', review.id)
  ) then raise exception 'Actor needs a current counted reject review' using errcode = '42501'; end if;
  select * into quorum from osi_private.osi_v2_case_rejection_quorum(case_row.id);
  if quorum.reject_ready is distinct from true or quorum.approve_ready is true then
    raise exception 'Case rejection quorum is not exclusively ready' using errcode = '42501'; end if;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  exact_hash := osi_private.osi_v2_case_outcome_payload_hash(
    case_row.id, case_row.public_ref, p_actor_wallet, receipt_role, 'reject', quorum.quorum_hash);
  select * into existing from public.osi_nonces where idempotency_key = p_idempotency_key for update;
  if found then
    if existing.purpose <> 'CASE_INITIAL_REVIEW_REJECTED'
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.target_id is distinct from case_row.id::text
       or existing.payload_hash is distinct from exact_hash then
      raise exception 'Idempotency key is bound to another Case action' using errcode = '23514'; end if;
    return query select existing.nonce, case_row.public_ref,
      existing.binding_context->>'actor_role', existing.payload_hash,
      existing.binding_context->>'quorum_hash', existing.issued_at, existing.expires_at,
      existing.consumed_by_receipt_id, true; return;
  end if;
  insert into public.osi_nonces (
    nonce,purpose,actor_wallet,target_type,target_id,payload_hash,idempotency_key,
    request_fingerprint_hash,binding_context,issued_at,expires_at
  ) values (
    p_nonce,'CASE_INITIAL_REVIEW_REJECTED',p_actor_wallet,'case',case_row.id::text,
    exact_hash,p_idempotency_key,p_request_fingerprint_hash,
    jsonb_build_object('actor_role',receipt_role,'case_ref',case_row.public_ref,
      'quorum_hash',quorum.quorum_hash),issued_time,
    issued_time + pg_catalog.make_interval(secs => ttl)
  );
  return query select p_nonce,case_row.public_ref,receipt_role,exact_hash,quorum.quorum_hash,
    issued_time,issued_time + pg_catalog.make_interval(secs => ttl),null::uuid,false;
end
$$;

create function osi_private.osi_v2_commit_case_rejection(
  p_nonce text, p_tx_sig text, p_memo_ref text, p_occurred_at timestamptz
)
returns table (public_ref text, quorum_hash text, receipt_id uuid, idempotent_replay boolean)
language plpgsql security invoker set search_path = ''
as $$
declare bound public.osi_nonces%rowtype; existing_receipt public.event_receipts%rowtype;
  case_row public.cases%rowtype; profile public.analyst_profiles%rowtype; quorum record;
  receipt_role text; exact_hash text; new_receipt_id uuid := gen_random_uuid();
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Case rejection commit is service-only' using errcode = '42501'; end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode = '55000'; end if;
  select * into bound from public.osi_nonces where nonce = p_nonce for update;
  if bound.nonce is null or bound.purpose <> 'CASE_INITIAL_REVIEW_REJECTED'
     or bound.target_type <> 'case' then
    raise exception 'Case rejection nonce binding is invalid' using errcode = '23514'; end if;
  if bound.consumed_at is not null then
    select * into existing_receipt from public.event_receipts where id = bound.consumed_by_receipt_id;
    if existing_receipt.event_type <> 'CASE_INITIAL_REVIEW_REJECTED'
       or existing_receipt.tx_sig is distinct from p_tx_sig
       or existing_receipt.memo_ref is distinct from p_memo_ref then
      raise exception 'Consumed rejection nonce changed proof' using errcode = '23514'; end if;
    return query select existing_receipt.public_ref,bound.binding_context->>'quorum_hash',
      existing_receipt.id,true; return;
  end if;
  if statement_timestamp() > bound.expires_at then
    raise exception 'Case rejection nonce expired' using errcode = '22023'; end if;
  select * into case_row from public.cases where id = bound.target_id::uuid for update;
  select * into profile from public.analyst_profiles where wallet = bound.actor_wallet;
  if case_row.id is null or case_row.stage <> 'initial_review' or case_row.visibility <> 'private'
     or case_row.submitted_by_wallet = bound.actor_wallet then
    raise exception 'Case rejection lineage changed' using errcode = '40001'; end if;
  if profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true then
    raise exception 'Rejection actor lost analyst authority' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.case_initial_reviews as review
     where review.case_id = case_row.id and review.reviewer_wallet = bound.actor_wallet
       and review.reviewer_role = 'analyst' and review.decision = 'reject'
       and review.is_active = true
       and review.created_at > osi_private.osi_v2_case_review_cycle_started_at(case_row.id)
       and osi_private.osi_v2_sas_review_counts('case_initial', review.id)
  ) then raise exception 'Actor reject review changed' using errcode = '40001'; end if;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  if receipt_role is distinct from bound.binding_context->>'actor_role' then
    raise exception 'Rejection actor role changed' using errcode = '40001'; end if;
  select * into quorum from osi_private.osi_v2_case_rejection_quorum(case_row.id);
  if quorum.reject_ready is distinct from true or quorum.approve_ready is true
     or quorum.quorum_hash is distinct from bound.binding_context->>'quorum_hash' then
    raise exception 'Case rejection quorum changed' using errcode = '40001'; end if;
  exact_hash := osi_private.osi_v2_case_outcome_payload_hash(
    case_row.id,case_row.public_ref,bound.actor_wallet,receipt_role,'reject',quorum.quorum_hash);
  if exact_hash is distinct from bound.payload_hash then
    raise exception 'Case rejection payload changed' using errcode = '23514'; end if;
  insert into public.event_receipts (
    id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,
    decision,proof_type,memo_ref,anchor_wallet,payload_hash,nonce,tx_sig,server_verified,occurred_at
  ) values (
    new_receipt_id,'OSI2','CASE_INITIAL_REVIEW_REJECTED','case',case_row.id::text,
    case_row.public_ref,bound.actor_wallet,receipt_role,'reject','solana_memo',p_memo_ref,
    bound.actor_wallet,exact_hash,bound.nonce,p_tx_sig,true,p_occurred_at
  );
  update public.osi_nonces set consumed_at=statement_timestamp(),
    consumed_by_receipt_id=new_receipt_id,updated_at=statement_timestamp()
   where nonce=bound.nonce and consumed_at is null;
  if not found then raise exception 'Rejection nonce consumed concurrently' using errcode = '40001'; end if;
  update public.cases set stage='initial_rejected',visibility='private',updated_at=statement_timestamp()
   where id=case_row.id and stage='initial_review' and visibility='private';
  if not found then raise exception 'Case rejection changed concurrently' using errcode = '40001'; end if;
  return query select case_row.public_ref,quorum.quorum_hash,new_receipt_id,false;
end
$$;

create function osi_private.osi_v2_case_appeal_payload_hash(
  p_case_id uuid, p_case_ref text, p_actor_wallet text,
  p_reason_code text, p_evidence jsonb
)
returns text
language sql immutable security invoker set search_path = ''
as $$
  select encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
    'actor_wallet',p_actor_wallet,'case_id',p_case_id,'case_ref',p_case_ref,
    'evidence',p_evidence,'reason_code',p_reason_code
  )::text,'UTF8'),'sha256'),'hex')
$$;

create function osi_private.osi_v2_validate_case_appeal(
  p_reason_code text, p_evidence jsonb
)
returns void
language plpgsql immutable security invoker set search_path = ''
as $$
declare item jsonb;
begin
  if p_reason_code is null
     or p_reason_code not in ('new_evidence','scope_clarified','submission_corrected') then
    raise exception 'Appeal reason is invalid' using errcode = '23514'; end if;
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'array'
     or jsonb_array_length(p_evidence) not between 1 and 12 then
    raise exception 'Appeal needs one to twelve evidence items' using errcode = '23514'; end if;
  for item in select value from jsonb_array_elements(p_evidence) loop
    if jsonb_typeof(item) <> 'object'
       or item->>'kind' not in ('wallet','onchain_tx','url')
       or nullif(btrim(item->>'ref'),'') is null
       or item->>'ref' is distinct from btrim(item->>'ref')
       or char_length(item->>'ref') > 4096
       or coalesce(item->>'sha256','') !~ '^[0-9a-f]{64}$' then
      raise exception 'Appeal evidence item is invalid' using errcode = '23514'; end if;
    if item->>'kind'='url' and item->>'ref' !~ '^https://' then
      raise exception 'Appeal URL must use HTTPS' using errcode = '23514'; end if;
    if item->>'kind'='wallet' and (char_length(item->>'ref') not between 32 and 44
       or item->>'ref' !~ '^[1-9A-HJ-NP-Za-km-z]+$') then
      raise exception 'Appeal wallet evidence is invalid' using errcode = '23514'; end if;
    if item->>'kind'='onchain_tx' and (char_length(item->>'ref') not between 64 and 88
       or item->>'ref' !~ '^[1-9A-HJ-NP-Za-km-z]+$') then
      raise exception 'Appeal transaction evidence is invalid' using errcode = '23514'; end if;
    if encode(extensions.digest(pg_catalog.convert_to(item->>'ref','UTF8'),'sha256'),'hex')
       is distinct from item->>'sha256' then
      raise exception 'Appeal evidence hash is invalid' using errcode = '23514'; end if;
  end loop;
  if (select count(*) from (
    select distinct value->>'kind', value->>'ref' from jsonb_array_elements(p_evidence)
  ) as unique_items) <> jsonb_array_length(p_evidence) then
    raise exception 'Appeal evidence contains duplicates' using errcode = '23514'; end if;
end
$$;

create function osi_private.osi_v2_prepare_case_appeal(
  p_nonce text,p_actor_wallet text,p_case_id uuid,p_reason_code text,p_evidence jsonb,
  p_idempotency_key text,p_request_fingerprint_hash text
)
returns table (
  issued_nonce text,public_ref text,payload_hash text,issued_at timestamptz,
  expires_at timestamptz,consumed_receipt_id uuid,idempotent_replay boolean
)
language plpgsql security invoker set search_path = ''
as $$
declare existing public.osi_nonces%rowtype; case_row public.cases%rowtype;
  exact_hash text; issued_time timestamptz:=statement_timestamp(); ttl integer;
begin
  if current_user not in ('postgres','service_role','supabase_admin') then
    raise exception 'Case appeal prepare is service-only' using errcode='42501'; end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode='55000'; end if;
  perform osi_private.osi_v2_validate_case_appeal(p_reason_code,p_evidence);
  ttl:=osi_private.osi_v2_case_action_ttl(p_actor_wallet,p_request_fingerprint_hash,p_idempotency_key);
  select * into case_row from public.cases where id=p_case_id for update;
  if case_row.id is null or case_row.stage<>'initial_rejected' or case_row.visibility<>'private'
     or case_row.submitted_by_wallet is distinct from p_actor_wallet then
    raise exception 'Only the owner can appeal this rejected Case' using errcode='42501'; end if;
  exact_hash:=osi_private.osi_v2_case_appeal_payload_hash(
    case_row.id,case_row.public_ref,p_actor_wallet,p_reason_code,p_evidence);
  select * into existing from public.osi_nonces where idempotency_key=p_idempotency_key for update;
  if found then
    if existing.purpose<>'CASE_APPEAL_SUBMITTED' or existing.actor_wallet<>p_actor_wallet
       or existing.target_id<>case_row.id::text or existing.payload_hash<>exact_hash then
      raise exception 'Idempotency key is bound to another appeal' using errcode='23514'; end if;
    return query select existing.nonce,case_row.public_ref,existing.payload_hash,
      existing.issued_at,existing.expires_at,existing.consumed_by_receipt_id,true; return;
  end if;
  insert into public.osi_nonces (
    nonce,purpose,actor_wallet,target_type,target_id,payload_hash,idempotency_key,
    request_fingerprint_hash,binding_context,issued_at,expires_at
  ) values (
    p_nonce,'CASE_APPEAL_SUBMITTED',p_actor_wallet,'case',case_row.id::text,exact_hash,
    p_idempotency_key,p_request_fingerprint_hash,
    jsonb_build_object('case_ref',case_row.public_ref,'reason_code',p_reason_code),
    issued_time,issued_time+pg_catalog.make_interval(secs=>ttl)
  );
  return query select p_nonce,case_row.public_ref,exact_hash,issued_time,
    issued_time+pg_catalog.make_interval(secs=>ttl),null::uuid,false;
end
$$;

create function osi_private.osi_v2_commit_case_appeal(
  p_nonce text,p_signature text,p_reason_code text,p_evidence jsonb
)
returns table (public_ref text,receipt_id uuid,idempotent_replay boolean)
language plpgsql security invoker set search_path = ''
as $$
declare bound public.osi_nonces%rowtype; existing_receipt public.event_receipts%rowtype;
  case_row public.cases%rowtype; exact_hash text; new_receipt_id uuid:=gen_random_uuid();
  item jsonb; evidence_id uuid; manifest_hash text;
begin
  if current_user not in ('postgres','service_role','supabase_admin') then
    raise exception 'Case appeal commit is service-only' using errcode='42501'; end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode='55000'; end if;
  perform osi_private.osi_v2_validate_case_appeal(p_reason_code,p_evidence);
  select * into bound from public.osi_nonces where nonce=p_nonce for update;
  if bound.nonce is null or bound.purpose<>'CASE_APPEAL_SUBMITTED' or bound.target_type<>'case' then
    raise exception 'Case appeal nonce is invalid' using errcode='23514'; end if;
  select * into case_row from public.cases where id=bound.target_id::uuid for update;
  exact_hash:=osi_private.osi_v2_case_appeal_payload_hash(
    case_row.id,case_row.public_ref,bound.actor_wallet,p_reason_code,p_evidence);
  if exact_hash is distinct from bound.payload_hash then
    raise exception 'Case appeal payload changed' using errcode='23514'; end if;
  if bound.consumed_at is not null then
    select * into existing_receipt from public.event_receipts where id=bound.consumed_by_receipt_id;
    if existing_receipt.event_type<>'CASE_APPEAL_SUBMITTED'
       or existing_receipt.signature is distinct from p_signature
       or existing_receipt.reason_code is distinct from p_reason_code then
      raise exception 'Consumed appeal nonce changed proof' using errcode='23514'; end if;
    return query select existing_receipt.public_ref,existing_receipt.id,true; return;
  end if;
  if statement_timestamp()>bound.expires_at then
    raise exception 'Case appeal nonce expired' using errcode='22023'; end if;
  if case_row.id is null or case_row.stage<>'initial_rejected' or case_row.visibility<>'private'
     or case_row.submitted_by_wallet is distinct from bound.actor_wallet then
    raise exception 'Case is no longer appealable by this owner' using errcode='40001'; end if;
  manifest_hash:=encode(extensions.digest(pg_catalog.convert_to(p_evidence::text,'UTF8'),'sha256'),'hex');
  insert into public.event_receipts (
    id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,
    decision,reason_code,proof_type,payload_hash,nonce,signature,server_verified,occurred_at,
    verification_metadata
  ) values (
    new_receipt_id,'OSI2','CASE_APPEAL_SUBMITTED','case',case_row.id::text,case_row.public_ref,
    bound.actor_wallet,'owner','appeal',p_reason_code,'wallet_signed_server_verified',
    exact_hash,bound.nonce,p_signature,true,statement_timestamp(),jsonb_build_object(
      'evidence_count',jsonb_array_length(p_evidence),'evidence_manifest_hash',manifest_hash)
  );
  update public.osi_nonces set consumed_at=statement_timestamp(),
    consumed_by_receipt_id=new_receipt_id,updated_at=statement_timestamp()
   where nonce=bound.nonce and consumed_at is null;
  if not found then raise exception 'Appeal nonce consumed concurrently' using errcode='40001'; end if;
  for item in select value from jsonb_array_elements(p_evidence) loop
    evidence_id:=gen_random_uuid();
    insert into public.evidence_items (
      id,kind,ref,is_public,moderation_state,sha256,added_by_wallet,created_at,updated_at
    ) values (
      evidence_id,item->>'kind',item->>'ref',false,'pending',item->>'sha256',
      bound.actor_wallet,statement_timestamp(),statement_timestamp());
    insert into public.case_evidence_links(case_id,evidence_item_id,added_by_wallet,created_at)
      values(case_row.id,evidence_id,bound.actor_wallet,statement_timestamp());
  end loop;
  update public.cases set stage='initial_review',visibility='private',updated_at=statement_timestamp()
   where id=case_row.id and stage='initial_rejected' and visibility='private';
  if not found then raise exception 'Appeal transition changed concurrently' using errcode='40001'; end if;
  return query select case_row.public_ref,new_receipt_id,false;
end
$$;

-- A cycle-aware replacement for the public-open outcome. It prevents an old
-- pre-appeal approval from anchoring the new review cycle and refuses a tally
-- whose reject and approve gates are both ready.
create function osi_private.osi_v2_prepare_case_open_outcome(
  p_nonce text,p_actor_wallet text,p_actor_role text,p_case_id uuid,
  p_idempotency_key text,p_request_fingerprint_hash text
)
returns table (
  issued_nonce text,public_ref text,actor_role text,payload_hash text,
  issued_at timestamptz,expires_at timestamptz,consumed_receipt_id uuid,idempotent_replay boolean
)
language plpgsql security invoker set search_path = ''
as $$
declare existing public.osi_nonces%rowtype; case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype; quorum record; rejection record;
  receipt_role text; exact_hash text; issued_time timestamptz:=statement_timestamp(); ttl integer;
begin
  if current_user not in ('postgres','service_role','supabase_admin') then
    raise exception 'Case open prepare is service-only' using errcode='42501'; end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode='55000'; end if;
  ttl:=osi_private.osi_v2_case_action_ttl(p_actor_wallet,p_request_fingerprint_hash,p_idempotency_key);
  select * into case_row from public.cases where id=p_case_id for update;
  if case_row.id is null or case_row.stage<>'initial_review' or case_row.visibility<>'private'
     or case_row.submitted_by_wallet=p_actor_wallet then
    raise exception 'Case is not openable by this actor' using errcode='42501'; end if;
  select * into quorum from osi_private.osi_v2_case_review_quorum(case_row.id);
  select * into rejection from osi_private.osi_v2_case_rejection_quorum(case_row.id);
  if rejection.reject_ready is true then
    raise exception 'Case has a ready or contested reject quorum' using errcode='42501'; end if;
  if p_actor_role='maintainer' then
    if quorum.maintainer_ready is distinct from true or not exists(
      select 1 from public.case_initial_reviews as review
       where review.case_id=case_row.id and review.reviewer_wallet=p_actor_wallet
         and review.reviewer_role='maintainer' and review.decision='approve_open'
         and review.weight=0 and review.is_active=true
         and review.created_at>osi_private.osi_v2_case_review_cycle_started_at(case_row.id)
    ) then raise exception 'Current maintainer opening path is not ready' using errcode='42501'; end if;
    receipt_role:='maintainer';
  elsif p_actor_role in ('analyst','senior') then
    select * into profile from public.analyst_profiles where wallet=p_actor_wallet;
    if profile.wallet is null or profile.status not in ('probationary_analyst','verified_analyst','senior_analyst')
       or profile.verified is not true or profile.approved is not true
       or quorum.analyst_ready is distinct from true or not exists(
         select 1 from public.case_initial_reviews as review
          where review.case_id=case_row.id and review.reviewer_wallet=p_actor_wallet
            and review.reviewer_role='analyst' and review.decision='approve_open'
            and review.is_active=true
            and review.created_at>osi_private.osi_v2_case_review_cycle_started_at(case_row.id)
            and osi_private.osi_v2_sas_review_counts('case_initial',review.id)
       ) then raise exception 'Current analyst opening path is not ready' using errcode='42501'; end if;
    receipt_role:=case when profile.status='senior_analyst' then 'senior' else 'analyst' end;
    if receipt_role<>p_actor_role then raise exception 'Analyst role mismatch' using errcode='42501'; end if;
  else raise exception 'Opening actor role is invalid' using errcode='42501'; end if;
  exact_hash:=osi_private.osi_v2_case_outcome_payload_hash(
    case_row.id,case_row.public_ref,p_actor_wallet,receipt_role,'open',rejection.quorum_hash);
  select * into existing from public.osi_nonces where idempotency_key=p_idempotency_key for update;
  if found then
    if existing.purpose<>'CASE_OPENED' or existing.actor_wallet<>p_actor_wallet
       or existing.target_id<>case_row.id::text or existing.payload_hash<>exact_hash then
      raise exception 'Idempotency key is bound to another open' using errcode='23514'; end if;
    return query select existing.nonce,case_row.public_ref,
      existing.binding_context->>'actor_role',existing.payload_hash,existing.issued_at,
      existing.expires_at,existing.consumed_by_receipt_id,true; return;
  end if;
  insert into public.osi_nonces(
    nonce,purpose,actor_wallet,target_type,target_id,payload_hash,idempotency_key,
    request_fingerprint_hash,binding_context,issued_at,expires_at
  ) values(
    p_nonce,'CASE_OPENED',p_actor_wallet,'case',case_row.id::text,exact_hash,
    p_idempotency_key,p_request_fingerprint_hash,jsonb_build_object(
      'actor_role',receipt_role,'case_ref',case_row.public_ref,'quorum_hash',rejection.quorum_hash),
    issued_time,issued_time+pg_catalog.make_interval(secs=>ttl));
  return query select p_nonce,case_row.public_ref,receipt_role,exact_hash,issued_time,
    issued_time+pg_catalog.make_interval(secs=>ttl),null::uuid,false;
end
$$;

create function osi_private.osi_v2_commit_case_open_outcome(
  p_nonce text,p_tx_sig text,p_memo_ref text,p_occurred_at timestamptz
)
returns table(public_ref text,receipt_id uuid,idempotent_replay boolean)
language plpgsql security invoker set search_path = ''
as $$
declare bound public.osi_nonces%rowtype; existing_receipt public.event_receipts%rowtype;
  case_row public.cases%rowtype; profile public.analyst_profiles%rowtype;
  quorum record; rejection record; receipt_role text; exact_hash text;
  new_receipt_id uuid:=gen_random_uuid();
begin
  if current_user not in ('postgres','service_role','supabase_admin') then
    raise exception 'Case open commit is service-only' using errcode='42501'; end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode='55000'; end if;
  select * into bound from public.osi_nonces where nonce=p_nonce for update;
  if bound.nonce is null or bound.purpose<>'CASE_OPENED' or bound.target_type<>'case' then
    raise exception 'Case open nonce is invalid' using errcode='23514'; end if;
  if bound.consumed_at is not null then
    select * into existing_receipt from public.event_receipts where id=bound.consumed_by_receipt_id;
    if existing_receipt.event_type<>'CASE_OPENED' or existing_receipt.tx_sig is distinct from p_tx_sig
       or existing_receipt.memo_ref is distinct from p_memo_ref then
      raise exception 'Consumed open nonce changed proof' using errcode='23514'; end if;
    return query select existing_receipt.public_ref,existing_receipt.id,true; return;
  end if;
  if statement_timestamp()>bound.expires_at then raise exception 'Open nonce expired' using errcode='22023'; end if;
  select * into case_row from public.cases where id=bound.target_id::uuid for update;
  if case_row.id is null or case_row.stage<>'initial_review' or case_row.visibility<>'private'
     or case_row.submitted_by_wallet=bound.actor_wallet then
    raise exception 'Case open lineage changed' using errcode='40001'; end if;
  select * into quorum from osi_private.osi_v2_case_review_quorum(case_row.id);
  select * into rejection from osi_private.osi_v2_case_rejection_quorum(case_row.id);
  if rejection.reject_ready is true or rejection.quorum_hash<>bound.binding_context->>'quorum_hash' then
    raise exception 'Opening quorum changed or is contested' using errcode='40001'; end if;
  receipt_role:=bound.binding_context->>'actor_role';
  if receipt_role='maintainer' then
    if quorum.maintainer_ready is distinct from true or not exists(
      select 1 from public.case_initial_reviews as review
       where review.case_id=case_row.id and review.reviewer_wallet=bound.actor_wallet
         and review.reviewer_role='maintainer' and review.decision='approve_open'
         and review.is_active=true
         and review.created_at>osi_private.osi_v2_case_review_cycle_started_at(case_row.id)
    ) then raise exception 'Maintainer opening path changed' using errcode='40001'; end if;
  elsif receipt_role in ('analyst','senior') then
    select * into profile from public.analyst_profiles where wallet=bound.actor_wallet;
    if profile.wallet is null or profile.status not in ('probationary_analyst','verified_analyst','senior_analyst')
       or profile.verified is not true or profile.approved is not true
       or quorum.analyst_ready is distinct from true or not exists(
         select 1 from public.case_initial_reviews as review
          where review.case_id=case_row.id and review.reviewer_wallet=bound.actor_wallet
            and review.reviewer_role='analyst' and review.decision='approve_open'
            and review.is_active=true
            and review.created_at>osi_private.osi_v2_case_review_cycle_started_at(case_row.id)
            and osi_private.osi_v2_sas_review_counts('case_initial',review.id)
       ) then raise exception 'Analyst opening path changed' using errcode='40001'; end if;
    if receipt_role<>(case when profile.status='senior_analyst' then 'senior' else 'analyst' end) then
      raise exception 'Opening actor role changed' using errcode='40001'; end if;
  else raise exception 'Opening role is invalid' using errcode='42501'; end if;
  exact_hash:=osi_private.osi_v2_case_outcome_payload_hash(
    case_row.id,case_row.public_ref,bound.actor_wallet,receipt_role,'open',rejection.quorum_hash);
  if exact_hash<>bound.payload_hash then raise exception 'Opening payload changed' using errcode='23514'; end if;
  insert into public.event_receipts(
    id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,
    decision,proof_type,memo_ref,anchor_wallet,payload_hash,nonce,tx_sig,server_verified,occurred_at
  ) values(
    new_receipt_id,'OSI2','CASE_OPENED','case',case_row.id::text,case_row.public_ref,
    bound.actor_wallet,receipt_role,'open','solana_memo',p_memo_ref,bound.actor_wallet,
    exact_hash,bound.nonce,p_tx_sig,true,p_occurred_at);
  update public.osi_nonces set consumed_at=statement_timestamp(),consumed_by_receipt_id=new_receipt_id,
    updated_at=statement_timestamp() where nonce=bound.nonce and consumed_at is null;
  if not found then raise exception 'Open nonce consumed concurrently' using errcode='40001'; end if;
  update public.cases set stage='open_public',visibility='public',opened_receipt_id=new_receipt_id,
    updated_at=statement_timestamp() where id=case_row.id and stage='initial_review' and visibility='private';
  if not found then raise exception 'Case open changed concurrently' using errcode='40001'; end if;
  return query select case_row.public_ref,new_receipt_id,false;
end
$$;

create function osi_private.osi_v2_commit_case_review_current(
  p_nonce text,p_payload_hash text,p_signature text,p_actor_role text,
  p_decision text,p_reason_code text
)
returns table(
  public_ref text,review_id uuid,receipt_id uuid,analyst_ready boolean,
  maintainer_ready boolean,open_ready boolean,idempotent_replay boolean
)
language plpgsql security invoker set search_path=''
as $$
declare bound public.osi_nonces%rowtype; existing_receipt public.event_receipts%rowtype;
  case_row public.cases%rowtype; profile public.analyst_profiles%rowtype;
  prior public.case_initial_reviews%rowtype; quorum record;
  new_receipt_id uuid:=gen_random_uuid(); new_review_id uuid:=gen_random_uuid();
  receipt_role text; review_weight numeric; prior_exists boolean:=false;
begin
  if p_decision<>'reject' then
    return query select * from osi_private.osi_v2_commit_case_review(
      p_nonce,p_payload_hash,p_signature,p_actor_role,p_decision,p_reason_code);
    return;
  end if;
  if current_user not in ('postgres','service_role','supabase_admin') then
    raise exception 'Case review commit is service-only' using errcode='42501'; end if;
  if osi_private.osi_v2_case_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Case writes are disabled' using errcode='55000'; end if;
  select * into bound from public.osi_nonces where nonce=p_nonce for update;
  if bound.nonce is null or bound.purpose not in ('CASE_INITIAL_REVIEW_CAST','CASE_INITIAL_REVIEW_REVISED')
     or bound.payload_hash<>p_payload_hash then
    raise exception 'Review nonce binding is invalid' using errcode='23514'; end if;
  if bound.consumed_at is not null then
    select * into existing_receipt from public.event_receipts where id=bound.consumed_by_receipt_id;
    if existing_receipt.signature is distinct from p_signature
       or existing_receipt.decision<>'reject' or existing_receipt.reason_code<>p_reason_code
       or existing_receipt.actor_role<>p_actor_role then
      raise exception 'Consumed review nonce changed decision' using errcode='23514'; end if;
    select id into new_review_id from public.case_initial_reviews
     where event_receipt_id=existing_receipt.id;
    select * into quorum from osi_private.osi_v2_case_review_quorum(bound.target_id::uuid);
    return query select existing_receipt.public_ref,new_review_id,existing_receipt.id,
      quorum.analyst_ready,quorum.maintainer_ready,quorum.ready,true; return;
  end if;
  if statement_timestamp()>bound.expires_at then raise exception 'Review nonce expired' using errcode='22023'; end if;
  select * into case_row from public.cases where id=bound.target_id::uuid;
  if case_row.id is null or case_row.stage<>'initial_review' or case_row.visibility<>'private'
     or case_row.submitted_by_wallet=bound.actor_wallet then
    raise exception 'Case is not eligible for this reviewer' using errcode='42501'; end if;
  if p_actor_role not in ('analyst','senior') then
    raise exception 'Maintainer cannot cast normal Case rejection' using errcode='42501'; end if;
  select * into profile from public.analyst_profiles where wallet=bound.actor_wallet;
  if profile.wallet is null or profile.status not in ('probationary_analyst','verified_analyst','senior_analyst')
     or profile.verified is not true or profile.approved is not true then
    raise exception 'Actor is not an eligible analyst' using errcode='42501'; end if;
  receipt_role:=case when profile.status='senior_analyst' then 'senior' else 'analyst' end;
  if receipt_role<>p_actor_role then raise exception 'Claimed analyst role mismatch' using errcode='42501'; end if;
  review_weight:=profile.weight_cached;
  select * into prior from public.case_initial_reviews
   where case_id=case_row.id and reviewer_wallet=bound.actor_wallet and is_active=true for update;
  prior_exists:=found;
  if (prior_exists and bound.purpose<>'CASE_INITIAL_REVIEW_REVISED')
     or (not prior_exists and bound.purpose<>'CASE_INITIAL_REVIEW_CAST') then
    raise exception 'Review history changed after nonce issuance' using errcode='40001'; end if;
  insert into public.event_receipts(
    id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,
    decision,weight,reason_code,proof_type,payload_hash,nonce,signature,server_verified,occurred_at
  ) values(
    new_receipt_id,'OSI2',bound.purpose,'case',case_row.id::text,case_row.public_ref,
    bound.actor_wallet,receipt_role,'reject',review_weight,p_reason_code,
    'wallet_signed_server_verified',bound.payload_hash,bound.nonce,p_signature,true,statement_timestamp());
  update public.osi_nonces set consumed_at=statement_timestamp(),consumed_by_receipt_id=new_receipt_id,
    updated_at=statement_timestamp() where nonce=bound.nonce and consumed_at is null;
  if not found then raise exception 'Review nonce consumed concurrently' using errcode='40001'; end if;
  if prior_exists then
    update public.case_initial_reviews set is_active=false,superseded_by=new_review_id
     where id=prior.id and is_active=true;
  end if;
  insert into public.case_initial_reviews(
    id,case_id,reviewer_wallet,decision,reviewer_role,weight,reason_code,is_active,
    superseded_by,event_receipt_id,created_at,updated_at
  ) values(
    new_review_id,case_row.id,bound.actor_wallet,'reject','analyst',review_weight,p_reason_code,
    true,null,new_receipt_id,statement_timestamp(),statement_timestamp());
  select * into quorum from osi_private.osi_v2_case_review_quorum(case_row.id);
  return query select case_row.public_ref,new_review_id,new_receipt_id,
    quorum.analyst_ready,quorum.maintainer_ready,quorum.ready,false;
end
$$;

create function public.osi_v2_prepare_case_rejection(
  p_nonce text,p_actor_wallet text,p_case_id uuid,p_idempotency_key text,p_request_fingerprint_hash text)
returns table(issued_nonce text,public_ref text,actor_role text,payload_hash text,quorum_hash text,
  issued_at timestamptz,expires_at timestamptz,consumed_receipt_id uuid,idempotent_replay boolean)
language sql security invoker set search_path=''
as 'select * from osi_private.osi_v2_prepare_case_rejection($1,$2,$3,$4,$5)';
create function public.osi_v2_commit_case_rejection(
  p_nonce text,p_tx_sig text,p_memo_ref text,p_occurred_at timestamptz)
returns table(public_ref text,quorum_hash text,receipt_id uuid,idempotent_replay boolean)
language sql security invoker set search_path=''
as 'select * from osi_private.osi_v2_commit_case_rejection($1,$2,$3,$4)';
create function public.osi_v2_prepare_case_appeal(
  p_nonce text,p_actor_wallet text,p_case_id uuid,p_reason_code text,p_evidence jsonb,
  p_idempotency_key text,p_request_fingerprint_hash text)
returns table(issued_nonce text,public_ref text,payload_hash text,issued_at timestamptz,
  expires_at timestamptz,consumed_receipt_id uuid,idempotent_replay boolean)
language sql security invoker set search_path=''
as 'select * from osi_private.osi_v2_prepare_case_appeal($1,$2,$3,$4,$5,$6,$7)';
create function public.osi_v2_commit_case_appeal(
  p_nonce text,p_signature text,p_reason_code text,p_evidence jsonb)
returns table(public_ref text,receipt_id uuid,idempotent_replay boolean)
language sql security invoker set search_path=''
as 'select * from osi_private.osi_v2_commit_case_appeal($1,$2,$3,$4)';
create function public.osi_v2_prepare_case_open_outcome(
  p_nonce text,p_actor_wallet text,p_actor_role text,p_case_id uuid,
  p_idempotency_key text,p_request_fingerprint_hash text)
returns table(issued_nonce text,public_ref text,actor_role text,payload_hash text,
  issued_at timestamptz,expires_at timestamptz,consumed_receipt_id uuid,idempotent_replay boolean)
language sql security invoker set search_path=''
as 'select * from osi_private.osi_v2_prepare_case_open_outcome($1,$2,$3,$4,$5,$6)';
create function public.osi_v2_commit_case_open_outcome(
  p_nonce text,p_tx_sig text,p_memo_ref text,p_occurred_at timestamptz)
returns table(public_ref text,receipt_id uuid,idempotent_replay boolean)
language sql security invoker set search_path=''
as 'select * from osi_private.osi_v2_commit_case_open_outcome($1,$2,$3,$4)';
create function public.osi_v2_commit_case_review_current(
  p_nonce text,p_payload_hash text,p_signature text,p_actor_role text,
  p_decision text,p_reason_code text)
returns table(public_ref text,review_id uuid,receipt_id uuid,analyst_ready boolean,
  maintainer_ready boolean,open_ready boolean,idempotent_replay boolean)
language sql security invoker set search_path=''
as 'select * from osi_private.osi_v2_commit_case_review_current($1,$2,$3,$4,$5,$6)';
create function public.osi_v2_case_rejection_quorum(p_case_id uuid)
returns table(approve_count integer,approve_weight numeric,reject_count integer,reject_weight numeric,
  approve_ready boolean,reject_ready boolean,quorum_hash text)
language sql stable security invoker set search_path=''
as 'select * from osi_private.osi_v2_case_rejection_quorum($1)';

revoke all privileges on function osi_private.osi_v2_case_review_cycle_started_at(uuid) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_case_rejection_quorum(uuid) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_case_action_ttl(text,text,text) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_case_outcome_payload_hash(uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_case_appeal_payload_hash(uuid,text,text,text,jsonb) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_validate_case_appeal(text,jsonb) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_case_rejection(text,text,uuid,text,text) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_commit_case_rejection(text,text,text,timestamptz) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_case_appeal(text,text,uuid,text,jsonb,text,text) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_commit_case_appeal(text,text,text,jsonb) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_case_open_outcome(text,text,text,uuid,text,text) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_commit_case_open_outcome(text,text,text,timestamptz) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_commit_case_review_current(text,text,text,text,text,text) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_prepare_case_rejection(text,text,uuid,text,text) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_commit_case_rejection(text,text,text,timestamptz) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_prepare_case_appeal(text,text,uuid,text,jsonb,text,text) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_commit_case_appeal(text,text,text,jsonb) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_prepare_case_open_outcome(text,text,text,uuid,text,text) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_commit_case_open_outcome(text,text,text,timestamptz) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_commit_case_review_current(text,text,text,text,text,text) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_case_rejection_quorum(uuid) from public,anon,authenticated;

grant execute on function osi_private.osi_v2_case_review_cycle_started_at(uuid) to service_role;
grant execute on function osi_private.osi_v2_case_rejection_quorum(uuid) to service_role;
grant execute on function osi_private.osi_v2_case_action_ttl(text,text,text) to service_role;
grant execute on function osi_private.osi_v2_case_outcome_payload_hash(uuid,text,text,text,text,text) to service_role;
grant execute on function osi_private.osi_v2_case_appeal_payload_hash(uuid,text,text,text,jsonb) to service_role;
grant execute on function osi_private.osi_v2_validate_case_appeal(text,jsonb) to service_role;
grant execute on function osi_private.osi_v2_prepare_case_rejection(text,text,uuid,text,text) to service_role;
grant execute on function osi_private.osi_v2_commit_case_rejection(text,text,text,timestamptz) to service_role;
grant execute on function osi_private.osi_v2_prepare_case_appeal(text,text,uuid,text,jsonb,text,text) to service_role;
grant execute on function osi_private.osi_v2_commit_case_appeal(text,text,text,jsonb) to service_role;
grant execute on function osi_private.osi_v2_prepare_case_open_outcome(text,text,text,uuid,text,text) to service_role;
grant execute on function osi_private.osi_v2_commit_case_open_outcome(text,text,text,timestamptz) to service_role;
grant execute on function osi_private.osi_v2_commit_case_review_current(text,text,text,text,text,text) to service_role;
grant execute on function public.osi_v2_prepare_case_rejection(text,text,uuid,text,text) to service_role;
grant execute on function public.osi_v2_commit_case_rejection(text,text,text,timestamptz) to service_role;
grant execute on function public.osi_v2_prepare_case_appeal(text,text,uuid,text,jsonb,text,text) to service_role;
grant execute on function public.osi_v2_commit_case_appeal(text,text,text,jsonb) to service_role;
grant execute on function public.osi_v2_prepare_case_open_outcome(text,text,text,uuid,text,text) to service_role;
grant execute on function public.osi_v2_commit_case_open_outcome(text,text,text,timestamptz) to service_role;
grant execute on function public.osi_v2_commit_case_review_current(text,text,text,text,text,text) to service_role;
grant execute on function public.osi_v2_case_rejection_quorum(uuid) to service_role;

comment on function osi_private.osi_v2_commit_case_rejection(text,text,text,timestamptz) is
  'Exact class-A normal initial rejection. Rechecks current-cycle SAS-valid count and weight quorum and forbids maintainer bootstrap.';
comment on function osi_private.osi_v2_commit_case_appeal(text,text,text,jsonb) is
  'Owner-only class-B appeal. Appends new private evidence, preserves immutable intake and starts a fresh review cycle.';

commit;
