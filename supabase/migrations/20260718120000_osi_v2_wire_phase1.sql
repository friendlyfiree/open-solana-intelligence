-- OSI V2 native Wire Phase 1: immutable intake and private author history.
--
-- This additive slice enables no public projection, analyst review,
-- publication, challenge, support, promotion, reward, or Case transition.
-- Every write remains behind OSI_V2_WIRE_WRITES_ENABLED, which starts false.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.wire_reports
  add column public_ref text
    constraint wire_reports_public_ref_check
    check (public_ref is null or public_ref ~ '^OSI-WR-[0-9A-F]{12}$'),
  add column native_intake boolean not null default false;

alter table public.wire_report_versions
  add column version_ref text
    constraint wire_report_versions_version_ref_check
    check (version_ref is null or version_ref ~ '^OSI-WV-[0-9A-F]{16}$'),
  add column title_public_safe text
    constraint wire_report_versions_title_check
    check (
      title_public_safe is null
      or (
        title_public_safe = btrim(title_public_safe)
        and char_length(title_public_safe) between 8 and 160
      )
    ),
  add column uncertainties_private text
    constraint wire_report_versions_uncertainties_check
    check (
      uncertainties_private is null
      or (
        uncertainties_private = btrim(uncertainties_private)
        and char_length(uncertainties_private) between 20 and 4000
      )
    );

alter table public.wire_report_version_evidence
  add column ordinal integer
    constraint wire_report_version_evidence_ordinal_check
    check (ordinal is null or ordinal between 1 and 12);

create unique index wire_reports_public_ref_uidx
  on public.wire_reports (public_ref)
  where public_ref is not null;
create index wire_reports_native_author_created_idx
  on public.wire_reports (author_wallet, created_at desc)
  where native_intake;
create unique index wire_report_versions_version_ref_uidx
  on public.wire_report_versions (version_ref)
  where version_ref is not null;
create unique index wire_report_version_evidence_ordinal_uidx
  on public.wire_report_version_evidence (wire_report_version_id, ordinal)
  where ordinal is not null;

comment on column public.wire_reports.native_intake is
  'True only for a header admitted to the native Memo-confirmed Wire lineage.';
comment on column public.wire_report_versions.version_ref is
  'Safe short reference for one exact immutable Wire version; raw UUIDs never enter Memo data.';
comment on column public.wire_report_versions.title_public_safe is
  'Public-safe title that remains private until this exact version is separately published.';
comment on column public.wire_report_versions.uncertainties_private is
  'Required limitations and uncertainty statement; private until a separately authorized publication.';
comment on column public.wire_report_version_evidence.ordinal is
  'Stable evidence-manifest order for this exact immutable Wire version.';

create function public.osi_v2_guard_native_wire_header()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.public_ref is not null
     and new.public_ref is distinct from old.public_ref then
    raise exception 'Native Wire public reference is write-once'
      using errcode = '55000';
  end if;
  if old.native_intake
     and new.native_intake is distinct from old.native_intake then
    raise exception 'Native Wire lineage cannot be disabled'
      using errcode = '55000';
  end if;
  if new.native_intake and new.public_ref is null then
    raise exception 'Native Wire lineage requires a public reference'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger osi_v2_guard_native_wire_header
before update on public.wire_reports
for each row execute function public.osi_v2_guard_native_wire_header();

insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_WIRE_WRITES_ENABLED', 'false', statement_timestamp()),
  ('OSI_V2_WIRE_RATE_WINDOW_SECONDS', '3600', statement_timestamp()),
  ('OSI_V2_WIRE_MAX_PER_WALLET', '10', statement_timestamp()),
  ('OSI_V2_WIRE_MAX_PER_FINGERPRINT', '20', statement_timestamp()),
  ('OSI_V2_WIRE_COOLDOWN_SECONDS', '15', statement_timestamp())
on conflict (key) do nothing;

create function osi_private.osi_v2_wire_writes_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select value = 'true'
    from public.osi_config
    where key = 'OSI_V2_WIRE_WRITES_ENABLED'
  ), false)
$$;

create function osi_private.osi_v2_wire_evidence_manifest(p_evidence jsonb)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select osi_private.osi_v2_report_evidence_manifest(p_evidence)
$$;

create function osi_private.osi_v2_wire_manifest_hash(p_evidence jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      pg_catalog.convert_to(osi_private.osi_v2_wire_evidence_manifest(p_evidence)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function osi_private.osi_v2_wire_input_hash(
  p_wire_report_public_ref text,
  p_actor_wallet text,
  p_title_public_safe text,
  p_content_public_safe text,
  p_body_private text,
  p_uncertainties_private text,
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
        'content_public_safe', p_content_public_safe,
        'evidence_manifest_hash', p_manifest_hash,
        'revision_reason_code', p_revision_reason_code,
        'title_public_safe', p_title_public_safe,
        'uncertainties_private', p_uncertainties_private,
        'wire_report_public_ref', p_wire_report_public_ref
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function osi_private.osi_v2_wire_payload_hash(
  p_wire_report_id uuid,
  p_version_id uuid,
  p_version_no integer,
  p_supersedes_version_id uuid,
  p_actor_wallet text,
  p_title_public_safe text,
  p_content_public_safe text,
  p_body_private text,
  p_uncertainties_private text,
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
        'content_public_safe', p_content_public_safe,
        'event_type', 'WIRE_REPORT_VERSION_SUBMITTED',
        'evidence_manifest_hash', p_manifest_hash,
        'revision_reason_code', p_revision_reason_code,
        'supersedes_version_id', p_supersedes_version_id,
        'title_public_safe', p_title_public_safe,
        'uncertainties_private', p_uncertainties_private,
        'version_id', p_version_id,
        'version_no', p_version_no,
        'wire_report_id', p_wire_report_id
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function osi_private.osi_v2_validate_wire_content(
  p_title_public_safe text,
  p_content_public_safe text,
  p_body_private text,
  p_uncertainties_private text,
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
  if p_title_public_safe is null
     or p_title_public_safe is distinct from btrim(p_title_public_safe)
     or char_length(p_title_public_safe) not between 8 and 160 then
    raise exception 'Wire title must contain between 8 and 160 trimmed characters'
      using errcode = '23514';
  end if;
  if p_content_public_safe is null
     or p_content_public_safe is distinct from btrim(p_content_public_safe)
     or char_length(p_content_public_safe) not between 40 and 4000 then
    raise exception 'Wire summary must contain between 40 and 4000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_body_private is null
     or p_body_private is distinct from btrim(p_body_private)
     or char_length(p_body_private) not between 80 and 100000 then
    raise exception 'Wire analysis must contain between 80 and 100000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_uncertainties_private is null
     or p_uncertainties_private is distinct from btrim(p_uncertainties_private)
     or char_length(p_uncertainties_private) not between 20 and 4000 then
    raise exception 'Wire uncertainties must contain between 20 and 4000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_is_revision then
    if p_revision_reason_code not in (
      'author_correction', 'new_evidence', 'clarification', 'review_response'
    ) then
      raise exception 'A Wire revision requires an allowed reason code'
        using errcode = '23514';
    end if;
  elsif p_revision_reason_code is not null then
    raise exception 'Initial Wire version cannot claim a revision reason'
      using errcode = '23514';
  end if;
  return true;
end
$$;

create function osi_private.osi_v2_prepare_wire_version(
  p_nonce text,
  p_actor_wallet text,
  p_wire_report_public_ref text,
  p_title_public_safe text,
  p_content_public_safe text,
  p_body_private text,
  p_uncertainties_private text,
  p_revision_reason_code text,
  p_evidence jsonb,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text,
  wire_report_id uuid,
  wire_report_public_ref text,
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
  header_row public.wire_reports%rowtype;
  current_version public.wire_report_versions%rowtype;
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
    raise exception 'Wire prepare is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_wire_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Wire writes are disabled' using errcode = '55000';
  end if;
  if p_actor_wallet is null
     or char_length(p_actor_wallet) not between 32 and 44
     or p_actor_wallet !~ '^[1-9A-HJ-NP-Za-km-z]+$' then
    raise exception 'Wire actor wallet is invalid' using errcode = '22023';
  end if;
  if p_wire_report_public_ref is not null
     and p_wire_report_public_ref !~ '^OSI-WR-[0-9A-F]{12}$' then
    raise exception 'Wire Report reference is invalid' using errcode = '22023';
  end if;

  manifest_hash := osi_private.osi_v2_wire_manifest_hash(p_evidence);
  input_hash := osi_private.osi_v2_wire_input_hash(
    p_wire_report_public_ref, p_actor_wallet, p_title_public_safe,
    p_content_public_safe, p_body_private, p_uncertainties_private,
    p_revision_reason_code, manifest_hash
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-idempotency:' || p_idempotency_key, 0)
  );
  select n.* into existing
    from public.osi_nonces as n
   where n.idempotency_key = p_idempotency_key
   for update;
  if found then
    if existing.purpose <> 'WIRE_REPORT_VERSION_SUBMITTED'
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.target_type <> 'wire_version'
       or existing.binding_context->>'input_hash' is distinct from input_hash
       or nullif(existing.binding_context->>'requested_report_public_ref', '')
          is distinct from p_wire_report_public_ref then
      raise exception 'Idempotency key is bound to another exact Wire action'
        using errcode = '23514';
    end if;
    return query select
      existing.nonce,
      (existing.binding_context->>'wire_report_id')::uuid,
      existing.binding_context->>'wire_report_public_ref',
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

  if p_wire_report_public_ref is null then
    actual_report_id := gen_random_uuid();
  else
    select report.id into actual_report_id
      from public.wire_reports as report
     where report.public_ref = p_wire_report_public_ref
       and report.author_wallet = p_actor_wallet
       and report.native_intake;
    if actual_report_id is null then
      raise exception 'Wire Report is not available for revision'
        using errcode = '42501';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-lineage:' || actual_report_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-wallet:' || p_actor_wallet, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-fingerprint:' || p_request_fingerprint_hash, 0)
  );

  if p_wire_report_public_ref is null then
    actual_version_no := 1;
    actual_supersedes := null;
  else
    select * into header_row
      from public.wire_reports as report
     where report.id = actual_report_id
       and report.public_ref = p_wire_report_public_ref
       and report.author_wallet = p_actor_wallet
       and report.native_intake
     for update;
    if header_row.id is null or header_row.status <> 'active' then
      raise exception 'Wire Report is not available for revision'
        using errcode = '42501';
    end if;
    if header_row.current_version_id is null then
      raise exception 'Native Wire lineage has no current-version pointer'
        using errcode = '55000';
    end if;
    select version.* into current_version
      from public.wire_report_versions as version
     where version.id = header_row.current_version_id
       and version.wire_report_id = header_row.id;
    if current_version.id is null then
      raise exception 'Wire current-version pointer is invalid' using errcode = '23503';
    end if;
    actual_version_no := current_version.version_no + 1;
    actual_supersedes := current_version.id;
  end if;

  perform osi_private.osi_v2_validate_wire_content(
    p_title_public_safe, p_content_public_safe, p_body_private,
    p_uncertainties_private, p_revision_reason_code,
    actual_version_no > 1
  );

  actual_version_id := gen_random_uuid();
  actual_report_ref := coalesce(
    header_row.public_ref,
    'OSI-WR-' || upper(substr(replace(actual_report_id::text, '-', ''), 1, 12))
  );
  actual_version_ref :=
    'OSI-WV-' || upper(substr(replace(actual_version_id::text, '-', ''), 1, 16));
  exact_payload_hash := osi_private.osi_v2_wire_payload_hash(
    actual_report_id, actual_version_id, actual_version_no,
    actual_supersedes, p_actor_wallet, p_title_public_safe,
    p_content_public_safe, p_body_private, p_uncertainties_private,
    p_revision_reason_code, manifest_hash
  );

  select case when value ~ '^[0-9]+$' then value::integer end into ttl_seconds
    from public.osi_config where key = 'OSI_V2_NONCE_TTL_SECONDS';
  select case when value ~ '^[0-9]+$' then value::integer end into window_seconds
    from public.osi_config where key = 'OSI_V2_WIRE_RATE_WINDOW_SECONDS';
  select case when value ~ '^[0-9]+$' then value::integer end into max_per_wallet
    from public.osi_config where key = 'OSI_V2_WIRE_MAX_PER_WALLET';
  select case when value ~ '^[0-9]+$' then value::integer end into max_per_fingerprint
    from public.osi_config where key = 'OSI_V2_WIRE_MAX_PER_FINGERPRINT';
  select case when value ~ '^[0-9]+$' then value::integer end into cooldown_seconds
    from public.osi_config where key = 'OSI_V2_WIRE_COOLDOWN_SECONDS';

  if ttl_seconds is null or ttl_seconds not between 30 and 300
     or window_seconds is null or window_seconds not between 60 and 3600
     or max_per_wallet is null or max_per_wallet not between 1 and 100
     or max_per_fingerprint is null or max_per_fingerprint not between 1 and 200
     or cooldown_seconds is null or cooldown_seconds not between 0 and 300 then
    raise exception 'Wire write security configuration is absent or invalid'
      using errcode = '55000';
  end if;

  select count(*), max(n.issued_at) into wallet_count, last_issued
    from public.osi_nonces as n
   where n.actor_wallet = p_actor_wallet
     and n.purpose = 'WIRE_REPORT_VERSION_SUBMITTED'
     and n.issued_at > issued_time - pg_catalog.make_interval(secs => window_seconds);
  select count(*) into fingerprint_count
    from public.osi_nonces as n
   where n.request_fingerprint_hash = p_request_fingerprint_hash
     and n.purpose = 'WIRE_REPORT_VERSION_SUBMITTED'
     and n.issued_at > issued_time - pg_catalog.make_interval(secs => window_seconds);
  if wallet_count >= max_per_wallet or fingerprint_count >= max_per_fingerprint then
    raise exception 'Wire write rate limit exceeded' using errcode = 'P0001';
  end if;
  if last_issued is not null
     and last_issued > issued_time - pg_catalog.make_interval(secs => cooldown_seconds) then
    raise exception 'Wire write cooldown is active' using errcode = 'P0001';
  end if;

  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, 'WIRE_REPORT_VERSION_SUBMITTED', p_actor_wallet,
    'wire_version', actual_version_id::text, exact_payload_hash,
    p_idempotency_key, p_request_fingerprint_hash,
    jsonb_build_object(
      'evidence_manifest_hash', manifest_hash,
      'input_hash', input_hash,
      'requested_report_public_ref', coalesce(p_wire_report_public_ref, ''),
      'supersedes_version_id', coalesce(actual_supersedes::text, ''),
      'version_no', actual_version_no,
      'version_public_ref', actual_version_ref,
      'wire_report_id', actual_report_id,
      'wire_report_public_ref', actual_report_ref
    ),
    issued_time,
    issued_time + pg_catalog.make_interval(secs => ttl_seconds)
  );

  return query select
    p_nonce, actual_report_id, actual_report_ref,
    actual_version_id, actual_version_ref, actual_version_no,
    actual_supersedes, manifest_hash, exact_payload_hash,
    issued_time, issued_time + pg_catalog.make_interval(secs => ttl_seconds),
    null::uuid, false;
end
$$;

create function osi_private.osi_v2_commit_wire_version(
  p_nonce text,
  p_title_public_safe text,
  p_content_public_safe text,
  p_body_private text,
  p_uncertainties_private text,
  p_revision_reason_code text,
  p_evidence jsonb,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz
)
returns table (
  wire_report_id uuid,
  wire_report_public_ref text,
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
  header_row public.wire_reports%rowtype;
  version_row public.wire_report_versions%rowtype;
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
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Wire commit is service-only' using errcode = '42501';
  end if;
  if osi_private.osi_v2_wire_writes_enabled() is distinct from true then
    raise exception 'OSI V2 Wire writes are disabled' using errcode = '55000';
  end if;

  select n.* into peek_nonce
    from public.osi_nonces as n
   where n.nonce = p_nonce;
  if peek_nonce.nonce is null
     or peek_nonce.purpose <> 'WIRE_REPORT_VERSION_SUBMITTED'
     or peek_nonce.target_type <> 'wire_version' then
    raise exception 'Wire nonce binding is invalid' using errcode = '23514';
  end if;
  actual_report_id := (peek_nonce.binding_context->>'wire_report_id')::uuid;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-idempotency:' || peek_nonce.idempotency_key, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wire-lineage:' || actual_report_id::text, 0)
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
  actual_report_ref := bound_nonce.binding_context->>'wire_report_public_ref';
  actual_version_ref := bound_nonce.binding_context->>'version_public_ref';
  manifest := osi_private.osi_v2_wire_evidence_manifest(p_evidence);
  manifest_hash := osi_private.osi_v2_wire_manifest_hash(p_evidence);
  perform osi_private.osi_v2_validate_wire_content(
    p_title_public_safe, p_content_public_safe, p_body_private,
    p_uncertainties_private, p_revision_reason_code,
    actual_version_no > 1
  );
  recomputed_hash := osi_private.osi_v2_wire_payload_hash(
    actual_report_id, actual_version_id, actual_version_no,
    actual_supersedes, bound_nonce.actor_wallet, p_title_public_safe,
    p_content_public_safe, p_body_private, p_uncertainties_private,
    p_revision_reason_code, manifest_hash
  );
  if recomputed_hash is distinct from bound_nonce.payload_hash
     or manifest_hash is distinct from bound_nonce.binding_context->>'evidence_manifest_hash' then
    raise exception 'Wire content or evidence changed after prepare'
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
       or existing_receipt.event_type <> 'WIRE_REPORT_VERSION_SUBMITTED'
       or existing_receipt.target_type <> 'wire_version'
       or existing_receipt.target_id is distinct from actual_version_id::text
       or existing_receipt.public_ref is distinct from actual_version_ref
       or existing_receipt.proof_type <> 'solana_memo'
       or existing_receipt.server_verified is distinct from true then
      raise exception 'Consumed Wire nonce cannot change its exact proof'
        using errcode = '23514';
    end if;
    select version.* into version_row
      from public.wire_report_versions as version
     where version.event_receipt_id = existing_receipt.id;
    if version_row.id is distinct from actual_version_id
       or version_row.wire_report_id is distinct from actual_report_id
       or version_row.version_no is distinct from actual_version_no
       or version_row.version_ref is distinct from actual_version_ref then
      raise exception 'Consumed Wire nonce is missing its exact immutable version'
        using errcode = '23514';
    end if;
    return query select
      actual_report_id, actual_report_ref, actual_version_id,
      actual_version_ref, actual_version_no, existing_receipt.id, true;
    return;
  end if;

  if statement_timestamp() > bound_nonce.expires_at then
    raise exception 'Wire nonce expired' using errcode = '22023';
  end if;
  if p_occurred_at is null
     or p_occurred_at < bound_nonce.issued_at - interval '5 seconds'
     or p_occurred_at > statement_timestamp() + interval '5 seconds' then
    raise exception 'Wire transaction timestamp is outside the signed action window'
      using errcode = '22023';
  end if;

  if actual_version_no = 1 then
    if actual_supersedes is not null
       or exists (select 1 from public.wire_reports where id = actual_report_id) then
      raise exception 'Prepared Wire lineage no longer has an empty initial state'
        using errcode = '40001';
    end if;
  else
    select * into header_row
      from public.wire_reports as report
     where report.id = actual_report_id
       and report.public_ref = actual_report_ref
       and report.author_wallet = bound_nonce.actor_wallet
       and report.native_intake
     for update;
    if header_row.id is null
       or header_row.status <> 'active'
       or header_row.current_version_id is distinct from actual_supersedes then
      raise exception 'Wire lineage advanced after prepare; prepare a fresh revision'
        using errcode = '40001';
    end if;
  end if;

  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, reason_code, proof_type, memo_ref,
    anchor_wallet, payload_hash, nonce, tx_sig, server_verified, occurred_at
  ) values (
    new_receipt_id, 'OSI2', 'WIRE_REPORT_VERSION_SUBMITTED',
    'wire_version', actual_version_id::text, actual_version_ref,
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
    raise exception 'Wire nonce was consumed concurrently' using errcode = '40001';
  end if;

  if actual_version_no = 1 then
    insert into public.wire_reports (
      id, author_wallet, current_version_id, current_published_version_id,
      promoted_to_case_id, status, public_ref, native_intake,
      created_at, updated_at
    ) values (
      actual_report_id, bound_nonce.actor_wallet, null, null,
      null, 'active', actual_report_ref, true,
      p_occurred_at, p_occurred_at
    );
  end if;

  insert into public.wire_report_versions (
    id, wire_report_id, version_no, version_ref, created_by_wallet,
    title_public_safe, content_public_safe, body_private,
    uncertainties_private, evidence_snapshot_hash,
    supersedes_version_id, superseded_by_version_id,
    revision_reason_code, lifecycle_state, published_at, superseded_at,
    publication_receipt_id, event_receipt_id, created_at, updated_at
  ) values (
    actual_version_id, actual_report_id, actual_version_no,
    actual_version_ref, bound_nonce.actor_wallet,
    p_title_public_safe, p_content_public_safe, p_body_private,
    p_uncertainties_private, manifest_hash,
    actual_supersedes, null, p_revision_reason_code, 'submitted',
    null, null, null, new_receipt_id, p_occurred_at, p_occurred_at
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
    insert into public.wire_report_version_evidence (
      wire_report_version_id, evidence_item_id, added_by_wallet,
      ordinal, created_at
    ) values (
      actual_version_id, evidence_id, bound_nonce.actor_wallet,
      (evidence_row.value->>'ordinal')::integer, p_occurred_at
    );
  end loop;

  update public.wire_reports
     set current_version_id = actual_version_id,
         updated_at = statement_timestamp()
   where id = actual_report_id
     and current_version_id is not distinct from actual_supersedes;
  if not found then
    raise exception 'Wire current-version pointer advanced concurrently'
      using errcode = '40001';
  end if;

  return query select
    actual_report_id, actual_report_ref, actual_version_id,
    actual_version_ref, actual_version_no, new_receipt_id, false;
end
$$;

create function public.osi_v2_prepare_wire_version(
  p_nonce text,
  p_actor_wallet text,
  p_wire_report_public_ref text,
  p_title_public_safe text,
  p_content_public_safe text,
  p_body_private text,
  p_uncertainties_private text,
  p_revision_reason_code text,
  p_evidence jsonb,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, wire_report_id uuid, wire_report_public_ref text,
  version_id uuid, version_public_ref text, version_no integer,
  supersedes_version_id uuid, evidence_manifest_hash text,
  payload_hash text, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_prepare_wire_version(
    p_nonce, p_actor_wallet, p_wire_report_public_ref,
    p_title_public_safe, p_content_public_safe, p_body_private,
    p_uncertainties_private, p_revision_reason_code, p_evidence,
    p_idempotency_key, p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_commit_wire_version(
  p_nonce text,
  p_title_public_safe text,
  p_content_public_safe text,
  p_body_private text,
  p_uncertainties_private text,
  p_revision_reason_code text,
  p_evidence jsonb,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz
)
returns table (
  wire_report_id uuid, wire_report_public_ref text,
  version_id uuid, version_public_ref text, version_no integer,
  receipt_id uuid, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_wire_version(
    p_nonce, p_title_public_safe, p_content_public_safe,
    p_body_private, p_uncertainties_private, p_revision_reason_code,
    p_evidence, p_tx_sig, p_memo_ref, p_occurred_at
  )
$$;

revoke all privileges on function public.osi_v2_guard_native_wire_header()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_wire_writes_enabled()
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_wire_evidence_manifest(jsonb)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_wire_manifest_hash(jsonb)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_wire_input_hash(text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_wire_payload_hash(uuid, uuid, integer, uuid, text, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_validate_wire_content(text, text, text, text, text, boolean)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_wire_version(text, text, text, text, text, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
revoke all privileges on function osi_private.osi_v2_commit_wire_version(text, text, text, text, text, text, jsonb, text, text, timestamptz)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_prepare_wire_version(text, text, text, text, text, text, text, text, jsonb, text, text)
  from public, anon, authenticated;
revoke all privileges on function public.osi_v2_commit_wire_version(text, text, text, text, text, text, jsonb, text, text, timestamptz)
  from public, anon, authenticated;

grant execute on function osi_private.osi_v2_wire_writes_enabled()
  to service_role;
grant execute on function osi_private.osi_v2_wire_evidence_manifest(jsonb)
  to service_role;
grant execute on function osi_private.osi_v2_wire_manifest_hash(jsonb)
  to service_role;
grant execute on function osi_private.osi_v2_wire_input_hash(text, text, text, text, text, text, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_wire_payload_hash(uuid, uuid, integer, uuid, text, text, text, text, text, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_validate_wire_content(text, text, text, text, text, boolean)
  to service_role;
grant execute on function osi_private.osi_v2_prepare_wire_version(text, text, text, text, text, text, text, text, jsonb, text, text)
  to service_role;
grant execute on function osi_private.osi_v2_commit_wire_version(text, text, text, text, text, text, jsonb, text, text, timestamptz)
  to service_role;
grant execute on function public.osi_v2_prepare_wire_version(text, text, text, text, text, text, text, text, jsonb, text, text)
  to service_role;
grant execute on function public.osi_v2_commit_wire_version(text, text, text, text, text, text, jsonb, text, text, timestamptz)
  to service_role;

comment on function osi_private.osi_v2_prepare_wire_version(text, text, text, text, text, text, text, text, jsonb, text, text) is
  'Reserves one exact private Wire version, lineage, ordered evidence manifest, and payload hash behind the dedicated fail-closed flag.';
comment on function osi_private.osi_v2_commit_wire_version(text, text, text, text, text, text, jsonb, text, text, timestamptz) is
  'Atomically consumes a verified class-A Memo nonce and creates the immutable Wire version, private evidence, receipt, and current pointer.';

commit;
