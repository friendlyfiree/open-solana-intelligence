-- OSI V2 native Case Report intake and immutable version history.
--
-- Scope is deliberately narrow: one wallet-authored Report header per Case,
-- immutable submitted versions, exact evidence manifests, and one class-A
-- Solana Memo receipt per version. Review, publication, resolution, challenge,
-- reward, and support transitions are not enabled here.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.case_reports
  add column public_ref text
    constraint case_reports_public_ref_check
    check (public_ref is null or public_ref ~ '^OSI-RPT-[0-9A-F]{12}$'),
  add column native_intake boolean not null default false;

alter table public.case_report_versions
  add column version_ref text
    constraint case_report_versions_version_ref_check
    check (version_ref is null or version_ref ~ '^OSI-RV-[0-9A-F]{16}$');

alter table public.case_report_version_evidence
  add column ordinal integer
    constraint case_report_version_evidence_ordinal_check
    check (ordinal is null or ordinal between 1 and 12);

alter table public.osi_nonces
  add column binding_context jsonb not null default '{}'::jsonb
    constraint osi_nonces_binding_context_check
    check (jsonb_typeof(binding_context) = 'object');

create unique index case_reports_public_ref_uidx
  on public.case_reports (public_ref)
  where public_ref is not null;
create unique index case_reports_native_case_author_uidx
  on public.case_reports (case_id, author_wallet)
  where native_intake;
create index case_reports_native_author_created_idx
  on public.case_reports (author_wallet, created_at desc)
  where native_intake;
create unique index case_report_versions_version_ref_uidx
  on public.case_report_versions (version_ref)
  where version_ref is not null;
create unique index case_report_version_evidence_ordinal_uidx
  on public.case_report_version_evidence (report_version_id, ordinal)
  where ordinal is not null;

comment on column public.case_reports.native_intake is
  'True only for a header admitted to the native Memo-confirmed Case Report lineage.';
comment on column public.case_report_versions.version_ref is
  'Safe short reference for an exact immutable Report version; raw UUIDs are never placed in Memo data.';
comment on column public.case_report_version_evidence.ordinal is
  'Stable evidence-manifest order for this exact immutable Report version.';
comment on column public.osi_nonces.binding_context is
  'Non-secret server reservation metadata used to bind generated IDs and lineage before a class-A transaction.';

-- A legacy header may be adopted once by its exact author. Native identity is
-- write-once after that adoption and cannot be moved to another lineage.
create function public.osi_v2_guard_native_report_header()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.public_ref is not null
     and new.public_ref is distinct from old.public_ref then
    raise exception 'Native Report public reference is write-once'
      using errcode = '55000';
  end if;

  if old.native_intake
     and new.native_intake is distinct from old.native_intake then
    raise exception 'Native Report lineage cannot be disabled'
      using errcode = '55000';
  end if;

  if new.native_intake and new.public_ref is null then
    raise exception 'Native Report lineage requires a public reference'
      using errcode = '23514';
  end if;

  if not old.native_intake and new.native_intake
     and old.public_ref is not null
     and new.public_ref is distinct from old.public_ref then
    raise exception 'Legacy Report reference cannot be repointed during adoption'
      using errcode = '55000';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_native_report_header
before update on public.case_reports
for each row execute function public.osi_v2_guard_native_report_header();

-- The dedicated flag starts disabled in every environment. A reviewed
-- main-only rollout enables only this key after all database and Edge smoke
-- checks pass. Absence, malformed values, or read failures therefore fail shut.
insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_REPORT_WRITES_ENABLED', 'false', statement_timestamp()),
  ('OSI_V2_REPORT_RATE_WINDOW_SECONDS', '3600', statement_timestamp()),
  ('OSI_V2_REPORT_MAX_PER_WALLET', '10', statement_timestamp()),
  ('OSI_V2_REPORT_MAX_PER_FINGERPRINT', '20', statement_timestamp()),
  ('OSI_V2_REPORT_COOLDOWN_SECONDS', '15', statement_timestamp())
on conflict (key) do nothing;

create function osi_private.osi_v2_report_writes_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select value = 'true'
    from public.osi_config
    where key = 'OSI_V2_REPORT_WRITES_ENABLED'
  ), false)
$$;

create function osi_private.osi_v2_report_evidence_manifest(p_evidence jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  manifest jsonb;
begin
  if p_evidence is null
     or jsonb_typeof(p_evidence) <> 'array'
     or jsonb_array_length(p_evidence) not between 1 and 12 then
    raise exception 'Report evidence must contain between 1 and 12 references'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_evidence) as item(value)
    where jsonb_typeof(item.value) <> 'object'
       or item.value->>'kind' not in ('onchain_tx', 'wallet', 'url')
       or nullif(btrim(item.value->>'ref'), '') is null
       or item.value->>'ref' is distinct from btrim(item.value->>'ref')
       or item.value->>'sha256' !~ '^[0-9a-f]{64}$'
       or item.value->>'sha256' is distinct from encode(
         extensions.digest(pg_catalog.convert_to(item.value->>'ref', 'UTF8'), 'sha256'),
         'hex'
       )
       or (item.value->>'kind' = 'url' and item.value->>'ref' !~ '^https://')
       or (
         item.value->>'kind' = 'wallet'
         and (
           char_length(item.value->>'ref') not between 32 and 44
           or item.value->>'ref' !~ '^[1-9A-HJ-NP-Za-km-z]+$'
         )
       )
       or (
         item.value->>'kind' = 'onchain_tx'
         and (
           char_length(item.value->>'ref') not between 64 and 88
           or item.value->>'ref' !~ '^[1-9A-HJ-NP-Za-km-z]+$'
         )
       )
  ) then
    raise exception 'Report evidence contains an unsupported or malformed reference'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_evidence) as item(value)
    group by item.value->>'kind', item.value->>'ref'
    having count(*) > 1
  ) then
    raise exception 'Report evidence references must be unique within a version'
      using errcode = '23514';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'ordinal', item.ordinality,
      'kind', item.value->>'kind',
      'ref', item.value->>'ref',
      'sha256', item.value->>'sha256'
    )
    order by item.ordinality
  )
  into manifest
  from jsonb_array_elements(p_evidence) with ordinality as item(value, ordinality);

  return manifest;
end
$$;

create function osi_private.osi_v2_report_manifest_hash(p_evidence jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      pg_catalog.convert_to(osi_private.osi_v2_report_evidence_manifest(p_evidence)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function osi_private.osi_v2_report_input_hash(
  p_case_id uuid,
  p_actor_wallet text,
  p_body_private text,
  p_content_public_safe text,
  p_revision_reason_code text,
  p_manifest_hash text
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
        'body_private', p_body_private,
        'case_id', p_case_id,
        'content_public_safe', p_content_public_safe,
        'evidence_manifest_hash', p_manifest_hash,
        'revision_reason_code', p_revision_reason_code
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function osi_private.osi_v2_report_payload_hash(
  p_case_id uuid,
  p_report_id uuid,
  p_version_id uuid,
  p_version_no integer,
  p_supersedes_version_id uuid,
  p_actor_wallet text,
  p_body_private text,
  p_content_public_safe text,
  p_revision_reason_code text,
  p_manifest_hash text
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
        'body_private', p_body_private,
        'case_id', p_case_id,
        'content_public_safe', p_content_public_safe,
        'event_type', 'CASE_REPORT_VERSION_SUBMITTED',
        'evidence_manifest_hash', p_manifest_hash,
        'report_id', p_report_id,
        'revision_reason_code', p_revision_reason_code,
        'supersedes_version_id', p_supersedes_version_id,
        'version_id', p_version_id,
        'version_no', p_version_no
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function osi_private.osi_v2_validate_report_content(
  p_body_private text,
  p_content_public_safe text,
  p_revision_reason_code text,
  p_is_revision boolean
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_body_private is null
     or p_body_private is distinct from btrim(p_body_private)
     or char_length(p_body_private) not between 80 and 100000 then
    raise exception 'Report narrative must contain between 80 and 100000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_content_public_safe is not null
     and (
       p_content_public_safe is distinct from btrim(p_content_public_safe)
       or char_length(p_content_public_safe) not between 1 and 4000
     ) then
    raise exception 'Public-safe summary must contain between 1 and 4000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_is_revision then
    if p_revision_reason_code not in (
      'author_correction', 'new_evidence', 'clarification', 'review_response'
    ) then
      raise exception 'A revision requires an allowed reason code'
        using errcode = '23514';
    end if;
  elsif p_revision_reason_code is not null then
    raise exception 'Initial Report version cannot claim a revision reason'
      using errcode = '23514';
  end if;
  return true;
end
$$;

create function osi_private.osi_v2_prepare_report_version(
  p_nonce text,
  p_actor_wallet text,
  p_case_id uuid,
  p_body_private text,
  p_content_public_safe text,
  p_revision_reason_code text,
  p_evidence jsonb,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text,
  case_id uuid,
  case_public_ref text,
  report_id uuid,
  report_public_ref text,
  version_id uuid,
  version_public_ref text,
  version_no integer,
  supersedes_version_id uuid,
  evidence_manifest_hash text,
  payload_hash text,
  issued_at timestamptz,
  expires_at timestamptz,
  consumed_receipt_id uuid,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing public.osi_nonces%rowtype;
  case_row public.cases%rowtype;
  header_row public.case_reports%rowtype;
  current_version public.case_report_versions%rowtype;
  header_count integer;
  actual_report_id uuid;
  actual_version_id uuid;
  actual_report_ref text;
  actual_version_ref text;
  actual_version_no integer;
  actual_supersedes uuid;
  manifest_hash text;
  input_hash text;
  exact_payload_hash text;
  issued_time timestamptz := statement_timestamp();
  ttl_seconds integer;
  window_seconds integer;
  max_per_wallet integer;
  max_per_fingerprint integer;
  cooldown_seconds integer;
  wallet_count bigint;
  fingerprint_count bigint;
  last_issued timestamptz;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Report prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_report_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Report writes are disabled' using errcode = '55000';
  end if;
  if p_actor_wallet is null
     or char_length(p_actor_wallet) not between 32 and 44
     or p_actor_wallet !~ '^[1-9A-HJ-NP-Za-km-z]+$' then
    raise exception 'Report actor wallet is invalid' using errcode = '22023';
  end if;

  manifest_hash := osi_private.osi_v2_report_manifest_hash(p_evidence);
  input_hash := osi_private.osi_v2_report_input_hash(
    p_case_id, p_actor_wallet, p_body_private, p_content_public_safe,
    p_revision_reason_code, manifest_hash
  );

  -- Lock order is stable across prepare and commit: idempotency, lineage,
  -- actor, fingerprint, then relational rows.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-idempotency:' || p_idempotency_key, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-lineage:' || p_case_id::text || ':' || p_actor_wallet, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-wallet:' || p_actor_wallet, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-fingerprint:' || p_request_fingerprint_hash, 0)
  );

  select n.* into existing
    from public.osi_nonces as n
   where n.idempotency_key = p_idempotency_key
   for update;

  if found then
    if existing.purpose <> 'CASE_REPORT_VERSION_SUBMITTED'
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.target_type <> 'report_version'
       or existing.binding_context->>'input_hash' is distinct from input_hash
       or existing.binding_context->>'case_id' is distinct from p_case_id::text then
      raise exception 'Idempotency key is bound to another exact Report action'
        using errcode = '23514';
    end if;
    return query select
      existing.nonce,
      (existing.binding_context->>'case_id')::uuid,
      existing.binding_context->>'case_public_ref',
      (existing.binding_context->>'report_id')::uuid,
      existing.binding_context->>'report_public_ref',
      existing.target_id::uuid,
      existing.binding_context->>'version_public_ref',
      (existing.binding_context->>'version_no')::integer,
      nullif(existing.binding_context->>'supersedes_version_id', '')::uuid,
      existing.binding_context->>'evidence_manifest_hash',
      existing.payload_hash,
      existing.issued_at,
      existing.expires_at,
      existing.consumed_by_receipt_id,
      true;
    return;
  end if;

  select * into case_row
    from public.cases
   where id = p_case_id
     and visibility = 'public'
     and stage in ('open_public', 'in_review', 'reopened')
   for update;
  if case_row.id is null then
    raise exception 'Case is not available for Report submission'
      using errcode = '42501';
  end if;

  select count(*) into header_count
    from public.case_reports as report
   where report.case_id = case_row.id
     and report.author_wallet = p_actor_wallet;
  if header_count > 1 then
    raise exception 'Report lineage is ambiguous and writes are disabled for this Case and author'
      using errcode = '55000';
  end if;

  if header_count = 1 then
    select * into header_row
      from public.case_reports as report
     where report.case_id = case_row.id
       and report.author_wallet = p_actor_wallet
     for update;
    actual_report_id := header_row.id;
    if header_row.status <> 'active' then
      raise exception 'Report lineage is not active' using errcode = '55000';
    end if;
    if header_row.current_version_id is not null then
      select version.* into current_version
        from public.case_report_versions as version
       where version.id = header_row.current_version_id
         and version.report_id = header_row.id;
      if current_version.id is null then
        raise exception 'Report current-version pointer is invalid' using errcode = '23503';
      end if;
      actual_version_no := current_version.version_no + 1;
      actual_supersedes := current_version.id;
    else
      if exists (
        select 1
        from public.case_report_versions as version
        where version.report_id = header_row.id
      ) then
        raise exception 'Report lineage has versions but no current-version pointer'
          using errcode = '55000';
      end if;
      actual_version_no := 1;
      actual_supersedes := null;
    end if;
  else
    actual_report_id := gen_random_uuid();
    actual_version_no := 1;
    actual_supersedes := null;
  end if;

  perform osi_private.osi_v2_validate_report_content(
    p_body_private, p_content_public_safe, p_revision_reason_code,
    actual_version_no > 1
  );

  actual_version_id := gen_random_uuid();
  actual_report_ref := coalesce(
    header_row.public_ref,
    'OSI-RPT-' || upper(substr(replace(actual_report_id::text, '-', ''), 1, 12))
  );
  actual_version_ref :=
    'OSI-RV-' || upper(substr(replace(actual_version_id::text, '-', ''), 1, 16));
  exact_payload_hash := osi_private.osi_v2_report_payload_hash(
    case_row.id, actual_report_id, actual_version_id, actual_version_no,
    actual_supersedes, p_actor_wallet, p_body_private, p_content_public_safe,
    p_revision_reason_code, manifest_hash
  );

  select case when value ~ '^[0-9]+$' then value::integer end into ttl_seconds
    from public.osi_config where key = 'OSI_V2_NONCE_TTL_SECONDS';
  select case when value ~ '^[0-9]+$' then value::integer end into window_seconds
    from public.osi_config where key = 'OSI_V2_REPORT_RATE_WINDOW_SECONDS';
  select case when value ~ '^[0-9]+$' then value::integer end into max_per_wallet
    from public.osi_config where key = 'OSI_V2_REPORT_MAX_PER_WALLET';
  select case when value ~ '^[0-9]+$' then value::integer end into max_per_fingerprint
    from public.osi_config where key = 'OSI_V2_REPORT_MAX_PER_FINGERPRINT';
  select case when value ~ '^[0-9]+$' then value::integer end into cooldown_seconds
    from public.osi_config where key = 'OSI_V2_REPORT_COOLDOWN_SECONDS';

  if ttl_seconds is null or ttl_seconds not between 30 and 300
     or window_seconds is null or window_seconds not between 60 and 3600
     or max_per_wallet is null or max_per_wallet not between 1 and 100
     or max_per_fingerprint is null or max_per_fingerprint not between 1 and 200
     or cooldown_seconds is null or cooldown_seconds not between 0 and 300 then
    raise exception 'Report write security configuration is absent or invalid'
      using errcode = '55000';
  end if;

  select count(*), max(n.issued_at) into wallet_count, last_issued
    from public.osi_nonces as n
   where n.actor_wallet = p_actor_wallet
     and n.purpose = 'CASE_REPORT_VERSION_SUBMITTED'
     and n.issued_at > issued_time - pg_catalog.make_interval(secs => window_seconds);
  select count(*) into fingerprint_count
    from public.osi_nonces as n
   where n.request_fingerprint_hash = p_request_fingerprint_hash
     and n.purpose = 'CASE_REPORT_VERSION_SUBMITTED'
     and n.issued_at > issued_time - pg_catalog.make_interval(secs => window_seconds);

  if wallet_count >= max_per_wallet or fingerprint_count >= max_per_fingerprint then
    raise exception 'Report write rate limit exceeded' using errcode = 'P0001';
  end if;
  if last_issued is not null
     and last_issued > issued_time - pg_catalog.make_interval(secs => cooldown_seconds) then
    raise exception 'Report write cooldown is active' using errcode = 'P0001';
  end if;

  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, 'CASE_REPORT_VERSION_SUBMITTED', p_actor_wallet,
    'report_version', actual_version_id::text, exact_payload_hash,
    p_idempotency_key, p_request_fingerprint_hash,
    jsonb_build_object(
      'case_id', case_row.id,
      'case_public_ref', case_row.public_ref,
      'evidence_manifest_hash', manifest_hash,
      'input_hash', input_hash,
      'report_id', actual_report_id,
      'report_public_ref', actual_report_ref,
      'supersedes_version_id', coalesce(actual_supersedes::text, ''),
      'version_no', actual_version_no,
      'version_public_ref', actual_version_ref
    ),
    issued_time,
    issued_time + pg_catalog.make_interval(secs => ttl_seconds)
  );

  return query select
    p_nonce, case_row.id, case_row.public_ref, actual_report_id,
    actual_report_ref, actual_version_id, actual_version_ref,
    actual_version_no, actual_supersedes, manifest_hash, exact_payload_hash,
    issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds),
    null::uuid, false;
end
$$;

create function osi_private.osi_v2_commit_report_version(
  p_nonce text,
  p_body_private text,
  p_content_public_safe text,
  p_revision_reason_code text,
  p_evidence jsonb,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz
)
returns table (
  case_public_ref text,
  report_id uuid,
  report_public_ref text,
  version_id uuid,
  version_public_ref text,
  version_no integer,
  receipt_id uuid,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  peek_nonce public.osi_nonces%rowtype;
  bound_nonce public.osi_nonces%rowtype;
  existing_receipt public.event_receipts%rowtype;
  case_row public.cases%rowtype;
  header_row public.case_reports%rowtype;
  version_row public.case_report_versions%rowtype;
  actual_case_id uuid;
  actual_report_id uuid;
  actual_version_id uuid;
  actual_version_no integer;
  actual_supersedes uuid;
  actual_report_ref text;
  actual_version_ref text;
  manifest jsonb;
  manifest_hash text;
  recomputed_hash text;
  evidence_row record;
  evidence_id uuid;
  new_receipt_id uuid := gen_random_uuid();
  header_count integer;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Report commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_report_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Report writes are disabled' using errcode = '55000';
  end if;

  select n.* into peek_nonce
    from public.osi_nonces as n
   where n.nonce = p_nonce;
  if peek_nonce.nonce is null
     or peek_nonce.purpose <> 'CASE_REPORT_VERSION_SUBMITTED'
     or peek_nonce.target_type <> 'report_version' then
    raise exception 'Report nonce binding is invalid' using errcode = '23514';
  end if;

  actual_case_id := (peek_nonce.binding_context->>'case_id')::uuid;
  actual_report_id := (peek_nonce.binding_context->>'report_id')::uuid;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-report-idempotency:' || peek_nonce.idempotency_key, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-report-lineage:' || actual_case_id::text || ':' || peek_nonce.actor_wallet,
      0
    )
  );

  select n.* into bound_nonce
    from public.osi_nonces as n
   where n.nonce = p_nonce
   for update;

  actual_version_id := bound_nonce.target_id::uuid;
  actual_version_no := (bound_nonce.binding_context->>'version_no')::integer;
  actual_supersedes := nullif(
    bound_nonce.binding_context->>'supersedes_version_id', ''
  )::uuid;
  actual_report_ref := bound_nonce.binding_context->>'report_public_ref';
  actual_version_ref := bound_nonce.binding_context->>'version_public_ref';
  manifest := osi_private.osi_v2_report_evidence_manifest(p_evidence);
  manifest_hash := osi_private.osi_v2_report_manifest_hash(p_evidence);
  perform osi_private.osi_v2_validate_report_content(
    p_body_private, p_content_public_safe, p_revision_reason_code,
    actual_version_no > 1
  );
  recomputed_hash := osi_private.osi_v2_report_payload_hash(
    actual_case_id, actual_report_id, actual_version_id, actual_version_no,
    actual_supersedes, bound_nonce.actor_wallet, p_body_private,
    p_content_public_safe, p_revision_reason_code, manifest_hash
  );

  if recomputed_hash is distinct from bound_nonce.payload_hash
     or manifest_hash is distinct from bound_nonce.binding_context->>'evidence_manifest_hash' then
    raise exception 'Report content or evidence changed after prepare'
      using errcode = '23514';
  end if;

  if bound_nonce.consumed_at is not null then
    select receipt.* into existing_receipt
      from public.event_receipts as receipt
     where receipt.id = bound_nonce.consumed_by_receipt_id;
    if existing_receipt.tx_sig is distinct from p_tx_sig
       or existing_receipt.memo_ref is distinct from p_memo_ref
       or existing_receipt.payload_hash is distinct from recomputed_hash
       or existing_receipt.actor_wallet is distinct from bound_nonce.actor_wallet
       or existing_receipt.event_version <> 'OSI2'
       or existing_receipt.event_type <> 'CASE_REPORT_VERSION_SUBMITTED'
       or existing_receipt.target_type <> 'report_version'
       or existing_receipt.target_id is distinct from actual_version_id::text
       or existing_receipt.public_ref is distinct from actual_version_ref
       or existing_receipt.proof_type <> 'solana_memo'
       or existing_receipt.server_verified is distinct from true then
      raise exception 'Consumed Report nonce cannot change its exact proof'
        using errcode = '23514';
    end if;
    select version.* into version_row
      from public.case_report_versions as version
     where version.event_receipt_id = existing_receipt.id;
    if version_row.id is distinct from actual_version_id
       or version_row.report_id is distinct from actual_report_id
       or version_row.version_no is distinct from actual_version_no
       or version_row.version_ref is distinct from actual_version_ref then
      raise exception 'Consumed Report nonce is missing its exact immutable version'
        using errcode = '23514';
    end if;
    return query select
      bound_nonce.binding_context->>'case_public_ref',
      actual_report_id, actual_report_ref, actual_version_id,
      actual_version_ref, actual_version_no, existing_receipt.id, true;
    return;
  end if;

  if statement_timestamp() > bound_nonce.expires_at then
    raise exception 'Report nonce expired' using errcode = '22023';
  end if;
  if p_occurred_at is null
     or p_occurred_at < bound_nonce.issued_at - interval '5 seconds'
     or p_occurred_at > statement_timestamp() + interval '5 seconds' then
    raise exception 'Report transaction timestamp is outside the signed action window'
      using errcode = '22023';
  end if;

  select candidate.* into case_row
    from public.cases as candidate
   where candidate.id = actual_case_id
     and candidate.visibility = 'public'
     and candidate.stage in ('open_public', 'in_review', 'reopened')
   for update;
  if case_row.id is null then
    raise exception 'Case is not available for Report submission'
      using errcode = '42501';
  end if;

  select count(*) into header_count
    from public.case_reports as report
   where report.case_id = actual_case_id
     and report.author_wallet = bound_nonce.actor_wallet;

  if header_count > 1 then
    raise exception 'Report lineage is ambiguous and cannot be committed'
      using errcode = '55000';
  end if;

  if header_count = 1 then
    select * into header_row
      from public.case_reports as report
     where report.case_id = actual_case_id
       and report.author_wallet = bound_nonce.actor_wallet
     for update;
    if header_row.case_id is distinct from actual_case_id
       or header_row.author_wallet is distinct from bound_nonce.actor_wallet
       or header_row.status <> 'active'
       or header_row.id is distinct from actual_report_id
       or header_row.current_version_id is distinct from actual_supersedes then
      raise exception 'Report lineage advanced after prepare; prepare a fresh revision'
        using errcode = '40001';
    end if;
  else
    header_row.id := null;
    if actual_version_no <> 1 or actual_supersedes is not null then
      raise exception 'Prepared Report lineage no longer exists'
        using errcode = '40001';
    end if;
  end if;

  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, reason_code, proof_type, memo_ref,
    anchor_wallet, payload_hash, nonce, tx_sig, server_verified, occurred_at
  ) values (
    new_receipt_id, 'OSI2', 'CASE_REPORT_VERSION_SUBMITTED',
    'report_version', actual_version_id::text, actual_version_ref,
    bound_nonce.actor_wallet, 'wallet',
    case when actual_version_no = 1 then 'submit' else 'revise' end,
    p_revision_reason_code, 'solana_memo', p_memo_ref,
    bound_nonce.actor_wallet, recomputed_hash, bound_nonce.nonce,
    p_tx_sig, true, p_occurred_at
  );

  update public.osi_nonces
     set consumed_at = statement_timestamp(),
         consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce = bound_nonce.nonce and consumed_at is null;
  if not found then
    raise exception 'Report nonce was consumed concurrently' using errcode = '40001';
  end if;

  if header_row.id is null then
    insert into public.case_reports (
      id, case_id, author_wallet, current_version_id,
      current_published_version_id, status, public_ref, native_intake,
      created_at, updated_at
    ) values (
      actual_report_id, actual_case_id, bound_nonce.actor_wallet,
      null, null, 'active', actual_report_ref, true,
      p_occurred_at, p_occurred_at
    );
  elsif not header_row.native_intake then
    update public.case_reports
       set native_intake = true,
           public_ref = coalesce(public_ref, actual_report_ref),
           updated_at = statement_timestamp()
     where id = header_row.id;
  end if;

  insert into public.case_report_versions (
    id, report_id, version_no, version_ref, created_by_wallet,
    body_private, content_public_safe, evidence_snapshot_hash,
    supersedes_version_id, superseded_by_version_id,
    revision_reason_code, lifecycle_state, published_at, superseded_at,
    publication_receipt_id, event_receipt_id, created_at, updated_at
  ) values (
    actual_version_id, actual_report_id, actual_version_no,
    actual_version_ref, bound_nonce.actor_wallet, p_body_private,
    p_content_public_safe, manifest_hash, actual_supersedes, null,
    p_revision_reason_code, 'submitted', null, null, null,
    new_receipt_id, p_occurred_at, p_occurred_at
  );

  for evidence_row in
    select item.value, item.ordinality
    from jsonb_array_elements(manifest) with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    evidence_id := gen_random_uuid();
    insert into public.evidence_items (
      id, kind, ref, is_public, moderation_state, sha256,
      added_by_wallet, created_at, updated_at
    ) values (
      evidence_id, evidence_row.value->>'kind', evidence_row.value->>'ref',
      false, 'pending', evidence_row.value->>'sha256',
      bound_nonce.actor_wallet, p_occurred_at, p_occurred_at
    );
    insert into public.case_report_version_evidence (
      report_version_id, evidence_item_id, added_by_wallet, ordinal, created_at
    ) values (
      actual_version_id, evidence_id, bound_nonce.actor_wallet,
      (evidence_row.value->>'ordinal')::integer, p_occurred_at
    );
  end loop;

  update public.case_reports
     set current_version_id = actual_version_id,
         updated_at = statement_timestamp()
   where id = actual_report_id
     and current_version_id is not distinct from actual_supersedes;
  if not found then
    raise exception 'Report current-version pointer advanced concurrently'
      using errcode = '40001';
  end if;

  return query select
    case_row.public_ref, actual_report_id, actual_report_ref,
    actual_version_id, actual_version_ref, actual_version_no,
    new_receipt_id, false;
end
$$;

create function public.osi_v2_prepare_report_version(
  p_nonce text,
  p_actor_wallet text,
  p_case_id uuid,
  p_body_private text,
  p_content_public_safe text,
  p_revision_reason_code text,
  p_evidence jsonb,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, case_id uuid, case_public_ref text,
  report_id uuid, report_public_ref text, version_id uuid,
  version_public_ref text, version_no integer,
  supersedes_version_id uuid, evidence_manifest_hash text,
  payload_hash text, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_prepare_report_version(
    p_nonce, p_actor_wallet, p_case_id, p_body_private,
    p_content_public_safe, p_revision_reason_code, p_evidence,
    p_idempotency_key, p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_commit_report_version(
  p_nonce text,
  p_body_private text,
  p_content_public_safe text,
  p_revision_reason_code text,
  p_evidence jsonb,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz
)
returns table (
  case_public_ref text, report_id uuid, report_public_ref text,
  version_id uuid, version_public_ref text, version_no integer,
  receipt_id uuid, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_report_version(
    p_nonce, p_body_private, p_content_public_safe,
    p_revision_reason_code, p_evidence, p_tx_sig,
    p_memo_ref, p_occurred_at
  )
$$;

revoke all privileges on function osi_private.osi_v2_report_writes_enabled()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_report_evidence_manifest(jsonb)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_report_manifest_hash(jsonb)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_report_input_hash(uuid, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_report_payload_hash(uuid, uuid, uuid, integer, uuid, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_validate_report_content(text, text, text, boolean)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_report_version(text, text, uuid, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_report_version(text, text, text, text, jsonb, text, text, timestamptz)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_prepare_report_version(text, text, uuid, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_report_version(text, text, text, text, jsonb, text, text, timestamptz)
  from public, anon, authenticated;

grant execute on function osi_private.osi_v2_report_writes_enabled()
  to service_role;
grant execute on function osi_private.osi_v2_report_evidence_manifest(jsonb)
  to service_role;
grant execute on function osi_private.osi_v2_report_manifest_hash(jsonb)
  to service_role;
grant execute on function osi_private.osi_v2_report_input_hash(uuid, text, text, text, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_report_payload_hash(uuid, uuid, uuid, integer, uuid, text, text, text, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_validate_report_content(text, text, text, boolean)
  to service_role;
grant execute on function osi_private.osi_v2_prepare_report_version(text, text, uuid, text, text, text, jsonb, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_commit_report_version(text, text, text, text, jsonb, text, text, timestamptz)
  to service_role;
grant execute on function public.osi_v2_prepare_report_version(text, text, uuid, text, text, text, jsonb, text, text)
  to service_role;
grant execute on function public.osi_v2_commit_report_version(text, text, text, text, jsonb, text, text, timestamptz)
  to service_role;

comment on function osi_private.osi_v2_prepare_report_version(text, text, uuid, text, text, text, jsonb, text, text) is
  'Reserves one exact Case Report version, lineage, evidence manifest and payload hash behind the dedicated fail-closed flag.';
comment on function osi_private.osi_v2_commit_report_version(text, text, text, text, jsonb, text, text, timestamptz) is
  'Atomically consumes a verified class-A Memo nonce and creates the immutable Report version, evidence manifest, receipt and current pointer.';

commit;
