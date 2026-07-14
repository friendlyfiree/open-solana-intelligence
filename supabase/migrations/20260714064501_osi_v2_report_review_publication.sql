-- OSI V2 immutable Case Report review, weighted quorum and publication.
--
-- This is an additive, fail-closed slice. Report intake keeps its independent
-- flag. Only eligible server-derived analysts can cast counted reviews or
-- publish an exact quorum-ready version. Publication does not resolve or close
-- the parent Case and does not assert truth, guilt or legal certainty.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.case_report_reviews
  add column public_ref text
    constraint case_report_reviews_public_ref_check
    check (public_ref is null or public_ref ~ '^OSI-RVW-[0-9A-F]{16}$'),
  add column reviewer_profile_wallet text
    references public.analyst_profiles (wallet) on delete restrict,
  add column tier_snapshot text
    constraint case_report_reviews_tier_snapshot_check
    check (tier_snapshot is null or tier_snapshot in (
      'probationary', 'analyst_i', 'analyst_ii', 'senior', 'distinguished'
    )),
  add column public_rationale text
    constraint case_report_reviews_public_rationale_check
    check (
      public_rationale is null
      or (
        public_rationale = btrim(public_rationale)
        and char_length(public_rationale) between 10 and 2000
      )
    ),
  add column private_note text
    constraint case_report_reviews_private_note_check
    check (
      private_note is null
      or (
        private_note = btrim(private_note)
        and char_length(private_note) between 1 and 4000
      )
    ),
  add constraint case_report_reviews_profile_binding_check
    check (
      public_ref is null
      or (
        reviewer_profile_wallet = reviewer_wallet
        and tier_snapshot is not null
        and public_rationale is not null
      )
    );

alter table public.case_report_versions
  add column publication_quorum_hash text
    constraint case_report_versions_publication_quorum_hash_check
    check (
      publication_quorum_hash is null
      or publication_quorum_hash ~ '^[0-9a-f]{64}$'
    );

create unique index case_report_reviews_public_ref_uidx
  on public.case_report_reviews (public_ref)
  where public_ref is not null;
create index case_report_reviews_active_quorum_idx
  on public.case_report_reviews (report_version_id, decision, reviewer_wallet)
  where is_active;

comment on column public.case_report_reviews.public_rationale is
  'Public-safe analyst rationale. Restricted analyst notes remain in private_note and are never included in public DTOs.';
comment on column public.case_report_reviews.tier_snapshot is
  'Immutable server-derived analyst tier at the moment this review was cast.';
comment on column public.case_report_versions.publication_quorum_hash is
  'Write-once hash of the exact active counted review snapshot bound to REPORT_PUBLISHED.';

insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_REPORT_REVIEW_WRITES_ENABLED', 'false', statement_timestamp()),
  ('OSI_V2_REPORT_STANDARD_MIN_ANALYSTS', '2', statement_timestamp()),
  ('OSI_V2_REPORT_STANDARD_MIN_WEIGHT', '2.00', statement_timestamp()),
  ('OSI_V2_REPORT_HIGH_MIN_ANALYSTS', '3', statement_timestamp()),
  ('OSI_V2_REPORT_HIGH_MIN_WEIGHT', '4.00', statement_timestamp()),
  ('OSI_V2_REPORT_REVIEW_RATE_WINDOW_SECONDS', '3600', statement_timestamp()),
  ('OSI_V2_REPORT_REVIEW_MAX_PER_WALLET', '30', statement_timestamp()),
  ('OSI_V2_REPORT_REVIEW_MAX_PER_FINGERPRINT', '60', statement_timestamp()),
  ('OSI_V2_REPORT_REVIEW_COOLDOWN_SECONDS', '2', statement_timestamp())
on conflict (key) do nothing;

create function osi_private.osi_v2_report_review_writes_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select config.value = 'true'
      from public.osi_config as config
     where config.key = 'OSI_V2_REPORT_REVIEW_WRITES_ENABLED'
  ), false)
$$;

create function osi_private.osi_v2_report_review_payload_hash(
  p_purpose text,
  p_version_id uuid,
  p_version_ref text,
  p_actor_wallet text,
  p_decision text,
  p_reason_code text,
  p_public_rationale text,
  p_private_note text
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
        'decision', p_decision,
        'event_type', p_purpose,
        'private_note', p_private_note,
        'public_rationale', p_public_rationale,
        'reason_code', p_reason_code,
        'version_id', p_version_id,
        'version_ref', p_version_ref
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function osi_private.osi_v2_report_publication_payload_hash(
  p_version_id uuid,
  p_version_ref text,
  p_actor_wallet text,
  p_body_private text,
  p_content_public_safe text,
  p_evidence_snapshot_hash text,
  p_quorum_hash text,
  p_previous_published_version_id uuid
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
        'event_type', 'REPORT_PUBLISHED',
        'evidence_snapshot_hash', p_evidence_snapshot_hash,
        'previous_published_version_id', p_previous_published_version_id,
        'quorum_hash', p_quorum_hash,
        'version_id', p_version_id,
        'version_ref', p_version_ref
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function osi_private.osi_v2_report_quorum(p_version_id uuid)
returns table (
  version_id uuid,
  version_public_ref text,
  risk_tier text,
  approve_count integer,
  approve_weight numeric,
  reject_count integer,
  reject_weight numeric,
  required_count integer,
  required_weight numeric,
  approve_ready boolean,
  reject_ready boolean,
  quorum_hash text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  version_row public.case_report_versions%rowtype;
  case_risk text;
  minimum_count integer;
  minimum_weight numeric;
  approval_count integer;
  approval_weight numeric;
  rejection_count integer;
  rejection_weight numeric;
  snapshot jsonb;
begin
  select version.* into version_row
    from public.case_report_versions as version
   where version.id = p_version_id;
  if version_row.id is null then
    raise exception 'Report version is not available' using errcode = '42501';
  end if;

  select case_row.risk_tier into case_risk
    from public.case_reports as report
    join public.cases as case_row on case_row.id = report.case_id
   where report.id = version_row.report_id;

  if case_risk = 'high' then
    select case when config.value ~ '^[0-9]+$' then config.value::integer end
      into minimum_count from public.osi_config as config
     where config.key = 'OSI_V2_REPORT_HIGH_MIN_ANALYSTS';
    select case when config.value ~ '^[0-9]+(?:\.[0-9]+)?$' then config.value::numeric end
      into minimum_weight from public.osi_config as config
     where config.key = 'OSI_V2_REPORT_HIGH_MIN_WEIGHT';
  else
    select case when config.value ~ '^[0-9]+$' then config.value::integer end
      into minimum_count from public.osi_config as config
     where config.key = 'OSI_V2_REPORT_STANDARD_MIN_ANALYSTS';
    select case when config.value ~ '^[0-9]+(?:\.[0-9]+)?$' then config.value::numeric end
      into minimum_weight from public.osi_config as config
     where config.key = 'OSI_V2_REPORT_STANDARD_MIN_WEIGHT';
  end if;
  if minimum_count is null or minimum_count not between 2 and 10
     or minimum_weight is null or minimum_weight not between 1 and 20 then
    raise exception 'Report quorum configuration is absent or invalid'
      using errcode = '55000';
  end if;

  with counted as (
    select
      review.public_ref,
      review.reviewer_wallet,
      review.decision,
      review.weight,
      review.tier_snapshot,
      review.created_at
    from public.case_report_reviews as review
    join public.analyst_profiles as profile
      on profile.wallet = review.reviewer_wallet
    join public.event_receipts as receipt
      on receipt.id = review.event_receipt_id
     and receipt.event_version = 'OSI2'
     and receipt.event_type in ('CASE_REPORT_REVIEW_CAST', 'CASE_REPORT_REVIEW_REVISED')
     and receipt.target_type = 'report_version'
     and receipt.target_id = review.report_version_id::text
     and receipt.actor_wallet = review.reviewer_wallet
     and receipt.decision = review.decision
     and receipt.weight = review.weight
     and receipt.reason_code is not distinct from review.reason_code
     and receipt.proof_type = 'wallet_signed_server_verified'
     and receipt.server_verified = true
    where review.report_version_id = p_version_id
      and review.is_active = true
      and review.public_ref is not null
      and profile.status in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
      and profile.verified = true
      and profile.approved = true
  )
  select
    count(*) filter (where counted.decision = 'approve')::integer,
    coalesce(sum(counted.weight) filter (where counted.decision = 'approve'), 0),
    count(*) filter (where counted.decision = 'reject')::integer,
    coalesce(sum(counted.weight) filter (where counted.decision = 'reject'), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'decision', counted.decision,
      'public_ref', counted.public_ref,
      'reviewer_wallet', counted.reviewer_wallet,
      'tier_snapshot', counted.tier_snapshot,
      'weight', counted.weight
    ) order by counted.reviewer_wallet) filter (
      where counted.decision in ('approve', 'reject')
    ), '[]'::jsonb)
    into approval_count, approval_weight, rejection_count, rejection_weight, snapshot
    from counted;

  return query select
    version_row.id,
    version_row.version_ref,
    case_risk,
    approval_count,
    approval_weight,
    rejection_count,
    rejection_weight,
    minimum_count,
    minimum_weight,
    approval_count >= minimum_count and approval_weight >= minimum_weight,
    rejection_count >= minimum_count and rejection_weight >= minimum_weight,
    encode(extensions.digest(pg_catalog.convert_to(jsonb_build_object(
      'risk_tier', case_risk,
      'reviews', snapshot,
      'threshold_count', minimum_count,
      'threshold_weight', minimum_weight,
      'version_id', version_row.id,
      'version_ref', version_row.version_ref
    )::text, 'UTF8'), 'sha256'), 'hex');
end
$$;

create function osi_private.osi_v2_check_report_review_rate(
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
     and n.purpose in ('CASE_REPORT_REVIEW_CAST', 'CASE_REPORT_REVIEW_REVISED', 'REPORT_PUBLISHED')
     and n.issued_at > p_now - pg_catalog.make_interval(secs => window_seconds);
  select count(*) into fingerprint_count
    from public.osi_nonces as n
   where n.request_fingerprint_hash = p_request_fingerprint_hash
     and n.purpose in ('CASE_REPORT_REVIEW_CAST', 'CASE_REPORT_REVIEW_REVISED', 'REPORT_PUBLISHED')
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

create function public.osi_v2_enforce_report_review_binding()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  profile public.analyst_profiles%rowtype;
  receipt_role text;
  report_author text;
  case_owner text;
begin
  if new.public_ref is null then
    return new;
  end if;
  select profile_row.* into profile
    from public.analyst_profiles as profile_row
   where profile_row.wallet = new.reviewer_wallet;
  if profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true
     or profile.wallet is distinct from new.reviewer_profile_wallet
     or profile.tier_code is distinct from new.tier_snapshot
     or profile.weight_cached is distinct from new.weight then
    raise exception 'Native Report review analyst snapshot is invalid'
      using errcode = '42501';
  end if;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  if not exists (
    select 1 from public.event_receipts as receipt
     where receipt.id = new.event_receipt_id
       and receipt.event_version = 'OSI2'
       and receipt.event_type in ('CASE_REPORT_REVIEW_CAST', 'CASE_REPORT_REVIEW_REVISED')
       and receipt.target_type = 'report_version'
       and receipt.target_id = new.report_version_id::text
       and receipt.actor_wallet = new.reviewer_wallet
       and receipt.actor_role = receipt_role
       and receipt.decision = new.decision
       and receipt.weight = new.weight
       and receipt.reason_code is not distinct from new.reason_code
       and receipt.proof_type = 'wallet_signed_server_verified'
       and receipt.server_verified = true
  ) then
    raise exception 'Native Report review receipt binding is invalid'
      using errcode = '42501';
  end if;
  select report.author_wallet, case_row.submitted_by_wallet
    into report_author, case_owner
    from public.case_report_versions as version
    join public.case_reports as report on report.id = version.report_id
    join public.cases as case_row on case_row.id = report.case_id
   where version.id = new.report_version_id;
  if new.reviewer_wallet in (report_author, case_owner) then
    raise exception 'Report author and Case owner cannot review this Report'
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger osi_v2_enforce_report_review_binding
before insert on public.case_report_reviews
for each row execute function public.osi_v2_enforce_report_review_binding();

create or replace function public.osi_v2_guard_report_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_core jsonb;
  new_core jsonb;
begin
  old_core := to_jsonb(old) - array[
    'content_public_safe', 'lifecycle_state', 'published_at', 'superseded_at',
    'superseded_by_version_id', 'publication_receipt_id',
    'publication_quorum_hash', 'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'content_public_safe', 'lifecycle_state', 'published_at', 'superseded_at',
    'superseded_by_version_id', 'publication_receipt_id',
    'publication_quorum_hash', 'updated_at'
  ];
  if new_core is distinct from old_core then
    raise exception 'Report version identity/private content/evidence are immutable'
      using errcode = '55000';
  end if;
  if new.content_public_safe is distinct from old.content_public_safe
     and old.lifecycle_state <> 'draft' then
    raise exception 'Submitted Report public-safe content is immutable'
      using errcode = '55000';
  end if;
  if not public.osi_v2_valid_report_version_transition(old.lifecycle_state, new.lifecycle_state) then
    raise exception 'Invalid Report version transition: % -> %', old.lifecycle_state, new.lifecycle_state
      using errcode = '23514';
  end if;
  if old.published_at is not null and new.published_at is distinct from old.published_at then
    raise exception 'Report published_at is write-once' using errcode = '55000';
  end if;
  if old.publication_receipt_id is not null
     and new.publication_receipt_id is distinct from old.publication_receipt_id then
    raise exception 'Report publication receipt is write-once' using errcode = '55000';
  end if;
  if to_jsonb(old)->>'publication_quorum_hash' is not null
     and to_jsonb(new)->>'publication_quorum_hash'
       is distinct from to_jsonb(old)->>'publication_quorum_hash' then
    raise exception 'Report publication quorum hash is write-once' using errcode = '55000';
  end if;
  if old.superseded_by_version_id is not null
     and new.superseded_by_version_id is distinct from old.superseded_by_version_id then
    raise exception 'Report supersession link is write-once' using errcode = '55000';
  end if;
  return new;
end
$$;

create function osi_private.osi_v2_prepare_report_review(
  p_nonce text,
  p_actor_wallet text,
  p_version_id uuid,
  p_decision text,
  p_reason_code text,
  p_public_rationale text,
  p_private_note text,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, purpose text, case_public_ref text,
  report_public_ref text, version_public_ref text,
  review_public_ref text, actor_role text, payload_hash text,
  issued_at timestamptz, expires_at timestamptz,
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
  event_type text;
  receipt_role text;
  review_id uuid := gen_random_uuid();
  review_ref text;
  exact_hash text;
  issued_time timestamptz := statement_timestamp();
  ttl_seconds integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Report review prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_report_review_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Report review writes are disabled' using errcode = '55000';
  end if;
  if p_decision not in ('approve', 'reject', 'request_revision', 'abstain')
     or p_reason_code is null or p_reason_code !~ '^[a-z][a-z0-9_:-]{0,95}$'
     or p_public_rationale is null or p_public_rationale <> btrim(p_public_rationale)
     or char_length(p_public_rationale) not between 10 and 2000
     or (p_private_note is not null and (
       p_private_note <> btrim(p_private_note) or char_length(p_private_note) not between 1 and 4000
     )) then
    raise exception 'Report review payload is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-review-idempotency:' || p_idempotency_key, 0)
  );
  select version.* into version_row from public.case_report_versions as version
   where version.id = p_version_id for update;
  select report.* into report_row from public.case_reports as report
   where report.id = version_row.report_id for update;
  select case_item.* into case_row from public.cases as case_item
   where case_item.id = report_row.case_id;
  select analyst.* into profile from public.analyst_profiles as analyst
   where analyst.wallet = p_actor_wallet;
  if version_row.id is null or report_row.id is null or not report_row.native_intake
     or report_row.current_version_id is distinct from version_row.id
     or version_row.version_ref is null
     or version_row.lifecycle_state not in ('submitted', 'in_review')
     or case_row.visibility <> 'public'
     or case_row.stage not in ('open_public', 'in_review', 'reopened') then
    raise exception 'Report version is not available for review' using errcode = '42501';
  end if;
  if p_actor_wallet in (report_row.author_wallet, case_row.submitted_by_wallet) then
    raise exception 'Report author and Case owner cannot review this Report' using errcode = '42501';
  end if;
  if profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true
     or profile.weight_cached not between 0.50 and 3.00 then
    raise exception 'Actor is not an eligible Report analyst' using errcode = '42501';
  end if;
  event_type := case when exists (
    select 1 from public.case_report_reviews as review
     where review.report_version_id = version_row.id
       and review.reviewer_wallet = p_actor_wallet
  ) then 'CASE_REPORT_REVIEW_REVISED' else 'CASE_REPORT_REVIEW_CAST' end;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  exact_hash := osi_private.osi_v2_report_review_payload_hash(
    event_type, version_row.id, version_row.version_ref, p_actor_wallet,
    p_decision, p_reason_code, p_public_rationale, p_private_note
  );

  select n.* into existing from public.osi_nonces as n
   where n.idempotency_key = p_idempotency_key for update;
  if found then
    if existing.purpose is distinct from event_type
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.target_type <> 'report_version'
       or existing.target_id is distinct from version_row.id::text
       or existing.payload_hash is distinct from exact_hash then
      raise exception 'Idempotency key is bound to another exact Report review'
        using errcode = '23514';
    end if;
    return query select existing.nonce, existing.purpose,
      existing.binding_context->>'case_public_ref',
      existing.binding_context->>'report_public_ref',
      existing.binding_context->>'version_public_ref',
      existing.binding_context->>'review_public_ref',
      existing.binding_context->>'actor_role', existing.payload_hash,
      existing.issued_at, existing.expires_at,
      existing.consumed_by_receipt_id, true;
    return;
  end if;

  perform osi_private.osi_v2_check_report_review_rate(
    p_actor_wallet, p_request_fingerprint_hash, event_type, issued_time
  );
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into ttl_seconds from public.osi_config as config
   where config.key = 'OSI_V2_NONCE_TTL_SECONDS';
  if ttl_seconds is null or ttl_seconds not between 30 and 300 then
    raise exception 'Report review nonce configuration is invalid' using errcode = '55000';
  end if;
  review_ref := 'OSI-RVW-' || upper(substr(replace(review_id::text, '-', ''), 1, 16));
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, event_type, p_actor_wallet, 'report_version', version_row.id::text,
    exact_hash, p_idempotency_key, p_request_fingerprint_hash,
    jsonb_build_object(
      'actor_role', receipt_role,
      'case_public_ref', case_row.public_ref,
      'report_public_ref', report_row.public_ref,
      'review_id', review_id,
      'review_public_ref', review_ref,
      'tier_snapshot', profile.tier_code,
      'version_public_ref', version_row.version_ref
    ),
    issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds)
  );
  return query select p_nonce, event_type, case_row.public_ref,
    report_row.public_ref, version_row.version_ref, review_ref, receipt_role,
    exact_hash, issued_time,
    issued_time + pg_catalog.make_interval(secs => ttl_seconds),
    null::uuid, false;
end
$$;

create function osi_private.osi_v2_commit_report_review(
  p_nonce text,
  p_decision text,
  p_reason_code text,
  p_public_rationale text,
  p_private_note text,
  p_signature text,
  p_message text
)
returns table (
  case_public_ref text, report_public_ref text, version_public_ref text,
  review_public_ref text, actor_role text, decision text, weight numeric,
  tier_snapshot text, receipt_id uuid, approve_count integer,
  approve_weight numeric, required_count integer, required_weight numeric,
  approve_ready boolean, idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  receipt public.event_receipts%rowtype;
  version_row public.case_report_versions%rowtype;
  report_row public.case_reports%rowtype;
  case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype;
  prior public.case_report_reviews%rowtype;
  review_row public.case_report_reviews%rowtype;
  quorum record;
  expected_purpose text;
  receipt_role text;
  exact_hash text;
  new_review_id uuid;
  new_receipt_id uuid := gen_random_uuid();
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Report review commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_report_review_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Report review writes are disabled' using errcode = '55000';
  end if;
  select n.* into bound from public.osi_nonces as n
   where n.nonce = p_nonce for update;
  if bound.nonce is null
     or bound.purpose not in ('CASE_REPORT_REVIEW_CAST', 'CASE_REPORT_REVIEW_REVISED')
     or bound.target_type <> 'report_version' then
    raise exception 'Report review nonce binding is invalid' using errcode = '23514';
  end if;
  exact_hash := osi_private.osi_v2_report_review_payload_hash(
    bound.purpose, bound.target_id::uuid,
    bound.binding_context->>'version_public_ref', bound.actor_wallet,
    p_decision, p_reason_code, p_public_rationale, p_private_note
  );
  if exact_hash is distinct from bound.payload_hash then
    raise exception 'Report review payload changed after prepare' using errcode = '23514';
  end if;

  if bound.consumed_at is not null then
    select event.* into receipt from public.event_receipts as event
     where event.id = bound.consumed_by_receipt_id;
    select review.* into review_row from public.case_report_reviews as review
     where review.event_receipt_id = receipt.id;
    if receipt.id is null or review_row.id is null
       or receipt.signature is distinct from p_signature
       or receipt.memo_ref is distinct from p_message
       or receipt.payload_hash is distinct from exact_hash
       or review_row.decision is distinct from p_decision
       or review_row.reason_code is distinct from p_reason_code
       or review_row.public_rationale is distinct from p_public_rationale
       or review_row.private_note is distinct from p_private_note then
      raise exception 'Consumed Report review nonce does not match exact retry'
        using errcode = '23514';
    end if;
    select * into quorum from osi_private.osi_v2_report_quorum(review_row.report_version_id);
    return query select bound.binding_context->>'case_public_ref',
      bound.binding_context->>'report_public_ref',
      bound.binding_context->>'version_public_ref', review_row.public_ref,
      receipt.actor_role, review_row.decision, review_row.weight,
      review_row.tier_snapshot, receipt.id, quorum.approve_count,
      quorum.approve_weight, quorum.required_count, quorum.required_weight,
      quorum.approve_ready, true;
    return;
  end if;
  if statement_timestamp() > bound.expires_at then
    raise exception 'Report review nonce expired' using errcode = '22023';
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
     or version_row.version_ref is distinct from bound.binding_context->>'version_public_ref'
     or version_row.lifecycle_state not in ('submitted', 'in_review')
     or case_row.visibility <> 'public'
     or case_row.stage not in ('open_public', 'in_review', 'reopened') then
    raise exception 'Report version is not available for review' using errcode = '42501';
  end if;
  if bound.actor_wallet in (report_row.author_wallet, case_row.submitted_by_wallet) then
    raise exception 'Report author and Case owner cannot review this Report' using errcode = '42501';
  end if;
  if profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true
     or profile.weight_cached not between 0.50 and 3.00
     or profile.tier_code is distinct from bound.binding_context->>'tier_snapshot' then
    raise exception 'Actor is not an eligible Report analyst' using errcode = '42501';
  end if;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  if receipt_role is distinct from bound.binding_context->>'actor_role' then
    raise exception 'Report review actor role changed after prepare' using errcode = '42501';
  end if;
  select review.* into prior from public.case_report_reviews as review
   where review.report_version_id = version_row.id
     and review.reviewer_wallet = bound.actor_wallet
     and review.is_active = true for update;
  expected_purpose := case when exists (
    select 1 from public.case_report_reviews as history
     where history.report_version_id = version_row.id
       and history.reviewer_wallet = bound.actor_wallet
  ) then 'CASE_REPORT_REVIEW_REVISED' else 'CASE_REPORT_REVIEW_CAST' end;
  if bound.purpose is distinct from expected_purpose then
    raise exception 'Report review history changed after prepare' using errcode = '40001';
  end if;

  new_review_id := (bound.binding_context->>'review_id')::uuid;
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, weight, reason_code, proof_type,
    memo_ref, anchor_wallet, payload_hash, nonce, tx_sig, signature,
    server_verified, occurred_at, created_at
  ) values (
    new_receipt_id, 'OSI2', bound.purpose, 'report_version', version_row.id::text,
    version_row.version_ref, bound.actor_wallet, receipt_role, p_decision,
    profile.weight_cached, p_reason_code, 'wallet_signed_server_verified',
    p_message, null, exact_hash, bound.nonce, null, p_signature,
    true, statement_timestamp(), statement_timestamp()
  );
  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(), consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound.nonce and nonce.consumed_at is null;
  if not found then
    raise exception 'Report review nonce consumed concurrently' using errcode = '40001';
  end if;
  if prior.id is not null then
    update public.case_report_reviews as review
       set is_active = false, superseded_by = new_review_id,
           updated_at = statement_timestamp()
     where review.id = prior.id and review.is_active = true;
    if not found then
      raise exception 'Report review changed concurrently' using errcode = '40001';
    end if;
  end if;
  if version_row.lifecycle_state = 'submitted' then
    update public.case_report_versions as version
       set lifecycle_state = 'in_review', updated_at = statement_timestamp()
     where version.id = version_row.id and version.lifecycle_state = 'submitted';
    if not found then
      raise exception 'Report review state changed concurrently' using errcode = '40001';
    end if;
  end if;
  insert into public.case_report_reviews (
    id, report_version_id, reviewer_wallet, decision, weight, reason_code,
    is_active, superseded_by, event_receipt_id, public_ref,
    reviewer_profile_wallet, tier_snapshot, public_rationale, private_note,
    created_at, updated_at
  ) values (
    new_review_id, version_row.id, bound.actor_wallet, p_decision,
    profile.weight_cached, p_reason_code, true, null, new_receipt_id,
    bound.binding_context->>'review_public_ref', profile.wallet,
    profile.tier_code, p_public_rationale, p_private_note,
    statement_timestamp(), statement_timestamp()
  ) returning * into review_row;
  if p_decision = 'request_revision' then
    update public.case_report_versions as version
       set lifecycle_state = 'revision_requested', updated_at = statement_timestamp()
     where version.id = version_row.id and version.lifecycle_state = 'in_review';
  end if;
  select * into quorum from osi_private.osi_v2_report_quorum(version_row.id);
  return query select case_row.public_ref, report_row.public_ref,
    version_row.version_ref, review_row.public_ref, receipt_role,
    review_row.decision, review_row.weight, review_row.tier_snapshot,
    new_receipt_id, quorum.approve_count, quorum.approve_weight,
    quorum.required_count, quorum.required_weight, quorum.approve_ready, false;
end
$$;

create function osi_private.osi_v2_prepare_report_publication(
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
    raise exception 'Report publication prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_report_review_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Report review writes are disabled' using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-publish-idempotency:' || p_idempotency_key, 0)
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
    raise exception 'Report version is not available for publication' using errcode = '42501';
  end if;
  if p_actor_wallet in (report_row.author_wallet, case_row.submitted_by_wallet)
     or profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true
     or not exists (
       select 1 from public.case_report_reviews as review
        where review.report_version_id = version_row.id
          and review.reviewer_wallet = p_actor_wallet
          and review.is_active = true and review.decision = 'approve'
     ) then
    raise exception 'Publication requires an active approving eligible analyst'
      using errcode = '42501';
  end if;
  select * into quorum from osi_private.osi_v2_report_quorum(version_row.id);
  if quorum.approve_ready is distinct from true then
    raise exception 'Report publication quorum is not ready' using errcode = '42501';
  end if;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  exact_hash := osi_private.osi_v2_report_publication_payload_hash(
    version_row.id, version_row.version_ref, p_actor_wallet,
    version_row.body_private, version_row.content_public_safe,
    version_row.evidence_snapshot_hash, quorum.quorum_hash,
    report_row.current_published_version_id
  );
  select n.* into existing from public.osi_nonces as n
   where n.idempotency_key = p_idempotency_key for update;
  if found then
    if existing.purpose <> 'REPORT_PUBLISHED'
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.target_id is distinct from version_row.id::text
       or existing.payload_hash is distinct from exact_hash then
      raise exception 'Idempotency key is bound to another exact Report publication'
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
    p_actor_wallet, p_request_fingerprint_hash, 'REPORT_PUBLISHED', issued_time
  );
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into ttl_seconds from public.osi_config as config
   where config.key = 'OSI_V2_NONCE_TTL_SECONDS';
  if ttl_seconds is null or ttl_seconds not between 30 and 300 then
    raise exception 'Report publication nonce configuration is invalid' using errcode = '55000';
  end if;
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, 'REPORT_PUBLISHED', p_actor_wallet, 'report_version', version_row.id::text,
    exact_hash, p_idempotency_key, p_request_fingerprint_hash,
    jsonb_build_object(
      'actor_role', receipt_role,
      'case_public_ref', case_row.public_ref,
      'previous_published_version_id', coalesce(report_row.current_published_version_id::text, ''),
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

create function osi_private.osi_v2_commit_report_publication(
  p_nonce text,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz
)
returns table (
  case_public_ref text, report_public_ref text, version_public_ref text,
  actor_role text, quorum_hash text, publication_receipt_id uuid,
  previous_published_version_ref text, idempotent_replay boolean
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
  prior_version public.case_report_versions%rowtype;
  quorum record;
  receipt_role text;
  exact_hash text;
  new_receipt_id uuid := gen_random_uuid();
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Report publication commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_report_review_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Report review writes are disabled' using errcode = '55000';
  end if;
  select n.* into bound from public.osi_nonces as n
   where n.nonce = p_nonce for update;
  if bound.nonce is null or bound.purpose <> 'REPORT_PUBLISHED'
     or bound.target_type <> 'report_version' then
    raise exception 'Report publication nonce binding is invalid' using errcode = '23514';
  end if;
  if bound.consumed_at is not null then
    select receipt.* into existing_receipt from public.event_receipts as receipt
     where receipt.id = bound.consumed_by_receipt_id;
    if existing_receipt.id is null
       or existing_receipt.event_type <> 'REPORT_PUBLISHED'
       or existing_receipt.tx_sig is distinct from p_tx_sig
       or existing_receipt.memo_ref is distinct from p_memo_ref
       or existing_receipt.payload_hash is distinct from bound.payload_hash then
      raise exception 'Consumed Report publication nonce does not match exact retry'
        using errcode = '23514';
    end if;
    select version.* into version_row from public.case_report_versions as version
     where version.id = bound.target_id::uuid;
    select prior.* into prior_version from public.case_report_versions as prior
     where prior.id = nullif(bound.binding_context->>'previous_published_version_id', '')::uuid;
    return query select bound.binding_context->>'case_public_ref',
      bound.binding_context->>'report_public_ref',
      bound.binding_context->>'version_public_ref', existing_receipt.actor_role,
      bound.binding_context->>'quorum_hash', existing_receipt.id,
      prior_version.version_ref, true;
    return;
  end if;
  if statement_timestamp() > bound.expires_at then
    raise exception 'Report publication nonce expired' using errcode = '22023';
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
     or report_row.current_published_version_id is distinct from
       nullif(bound.binding_context->>'previous_published_version_id', '')::uuid
     or case_row.visibility <> 'public'
     or case_row.stage not in ('open_public', 'in_review', 'reopened') then
    raise exception 'Report publication lineage changed after prepare' using errcode = '40001';
  end if;
  if bound.actor_wallet in (report_row.author_wallet, case_row.submitted_by_wallet)
     or profile.wallet is null
     or profile.status not in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
     or profile.verified is not true or profile.approved is not true
     or not exists (
       select 1 from public.case_report_reviews as review
        where review.report_version_id = version_row.id
          and review.reviewer_wallet = bound.actor_wallet
          and review.is_active = true and review.decision = 'approve'
     ) then
    raise exception 'Publication requires an active approving eligible analyst'
      using errcode = '42501';
  end if;
  receipt_role := case when profile.status = 'senior_analyst' then 'senior' else 'analyst' end;
  if receipt_role is distinct from bound.binding_context->>'actor_role' then
    raise exception 'Publication actor role changed after prepare' using errcode = '42501';
  end if;
  select * into quorum from osi_private.osi_v2_report_quorum(version_row.id);
  if quorum.approve_ready is distinct from true
     or quorum.quorum_hash is distinct from bound.binding_context->>'quorum_hash' then
    raise exception 'Report publication quorum changed after prepare' using errcode = '40001';
  end if;
  exact_hash := osi_private.osi_v2_report_publication_payload_hash(
    version_row.id, version_row.version_ref, bound.actor_wallet,
    version_row.body_private, version_row.content_public_safe,
    version_row.evidence_snapshot_hash, quorum.quorum_hash,
    report_row.current_published_version_id
  );
  if exact_hash is distinct from bound.payload_hash then
    raise exception 'Report publication payload changed after prepare' using errcode = '23514';
  end if;
  if report_row.current_published_version_id is not null then
    select prior.* into prior_version from public.case_report_versions as prior
     where prior.id = report_row.current_published_version_id
       and prior.report_id = report_row.id for update;
    if prior_version.lifecycle_state <> 'published' then
      raise exception 'Prior published Report pointer is invalid' using errcode = '23503';
    end if;
  end if;
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, weight, reason_code, proof_type,
    memo_ref, anchor_wallet, payload_hash, nonce, tx_sig, signature,
    server_verified, occurred_at, created_at
  ) values (
    new_receipt_id, 'OSI2', 'REPORT_PUBLISHED', 'report_version', version_row.id::text,
    version_row.version_ref, bound.actor_wallet, receipt_role, 'publish', null,
    null, 'solana_memo', p_memo_ref, bound.actor_wallet, exact_hash,
    bound.nonce, p_tx_sig, null, true, p_occurred_at, statement_timestamp()
  );
  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(), consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound.nonce and nonce.consumed_at is null;
  if not found then
    raise exception 'Report publication nonce consumed concurrently' using errcode = '40001';
  end if;
  update public.case_report_versions as version
     set lifecycle_state = 'published', published_at = p_occurred_at,
         publication_receipt_id = new_receipt_id,
         publication_quorum_hash = quorum.quorum_hash,
         updated_at = statement_timestamp()
   where version.id = version_row.id and version.lifecycle_state = 'in_review';
  if not found then
    raise exception 'Report publication state changed concurrently' using errcode = '40001';
  end if;
  if prior_version.id is not null then
    update public.case_report_versions as version
       set lifecycle_state = 'superseded', superseded_at = p_occurred_at,
           superseded_by_version_id = version_row.id,
           updated_at = statement_timestamp()
     where version.id = prior_version.id and version.lifecycle_state = 'published';
  end if;
  update public.case_reports as report
     set current_published_version_id = version_row.id,
         updated_at = statement_timestamp()
   where report.id = report_row.id
     and report.current_published_version_id is not distinct from prior_version.id;
  if not found then
    raise exception 'Report published pointer changed concurrently' using errcode = '40001';
  end if;
  return query select case_row.public_ref, report_row.public_ref,
    version_row.version_ref, receipt_role, quorum.quorum_hash,
    new_receipt_id, prior_version.version_ref, false;
end
$$;

create function public.osi_v2_prepare_report_review(
  p_nonce text, p_actor_wallet text, p_version_id uuid,
  p_decision text, p_reason_code text, p_public_rationale text,
  p_private_note text, p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, purpose text, case_public_ref text,
  report_public_ref text, version_public_ref text,
  review_public_ref text, actor_role text, payload_hash text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_prepare_report_review(
    p_nonce, p_actor_wallet, p_version_id, p_decision, p_reason_code,
    p_public_rationale, p_private_note, p_idempotency_key,
    p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_commit_report_review(
  p_nonce text, p_decision text, p_reason_code text,
  p_public_rationale text, p_private_note text,
  p_signature text, p_message text
)
returns table (
  case_public_ref text, report_public_ref text, version_public_ref text,
  review_public_ref text, actor_role text, decision text, weight numeric,
  tier_snapshot text, receipt_id uuid, approve_count integer,
  approve_weight numeric, required_count integer, required_weight numeric,
  approve_ready boolean, idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_report_review(
    p_nonce, p_decision, p_reason_code, p_public_rationale,
    p_private_note, p_signature, p_message
  )
$$;

create function public.osi_v2_prepare_report_publication(
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
  select * from osi_private.osi_v2_prepare_report_publication(
    p_nonce, p_actor_wallet, p_version_id, p_idempotency_key,
    p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_commit_report_publication(
  p_nonce text, p_tx_sig text, p_memo_ref text, p_occurred_at timestamptz
)
returns table (
  case_public_ref text, report_public_ref text, version_public_ref text,
  actor_role text, quorum_hash text, publication_receipt_id uuid,
  previous_published_version_ref text, idempotent_replay boolean
)
language sql security invoker set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_report_publication(
    p_nonce, p_tx_sig, p_memo_ref, p_occurred_at
  )
$$;

revoke all privileges on function osi_private.osi_v2_report_review_writes_enabled()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_report_review_payload_hash(text, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_report_publication_payload_hash(uuid, text, text, text, text, text, text, uuid)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_report_quorum(uuid)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_check_report_review_rate(text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_report_review(text, text, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_report_review(text, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_report_publication(text, text, uuid, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_report_publication(text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_prepare_report_review(text, text, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_report_review(text, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_prepare_report_publication(text, text, uuid, text, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_report_publication(text, text, text, timestamptz)
  from public, anon, authenticated;

grant execute on function osi_private.osi_v2_report_review_writes_enabled() to service_role;
grant execute on function osi_private.osi_v2_report_review_payload_hash(text, uuid, text, text, text, text, text, text) to service_role;
grant execute on function osi_private.osi_v2_report_publication_payload_hash(uuid, text, text, text, text, text, text, uuid) to service_role;
grant execute on function osi_private.osi_v2_report_quorum(uuid) to service_role;
grant execute on function osi_private.osi_v2_check_report_review_rate(text, text, text, timestamptz) to service_role;
grant execute on function osi_private.osi_v2_prepare_report_review(text, text, uuid, text, text, text, text, text, text) to service_role;
grant execute on function osi_private.osi_v2_commit_report_review(text, text, text, text, text, text, text) to service_role;
grant execute on function osi_private.osi_v2_prepare_report_publication(text, text, uuid, text, text) to service_role;
grant execute on function osi_private.osi_v2_commit_report_publication(text, text, text, timestamptz) to service_role;
grant execute on function public.osi_v2_prepare_report_review(text, text, uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.osi_v2_commit_report_review(text, text, text, text, text, text, text) to service_role;
grant execute on function public.osi_v2_prepare_report_publication(text, text, uuid, text, text) to service_role;
grant execute on function public.osi_v2_commit_report_publication(text, text, text, timestamptz) to service_role;

comment on function osi_private.osi_v2_report_quorum(uuid) is
  'Computes deterministic active eligible analyst count and weight gates for one exact immutable Report version.';
comment on function osi_private.osi_v2_commit_report_publication(text, text, text, timestamptz) is
  'Consumes one exact confirmed REPORT_PUBLISHED Memo and advances only the Report publication pointer; the Case lifecycle is unchanged.';

commit;
