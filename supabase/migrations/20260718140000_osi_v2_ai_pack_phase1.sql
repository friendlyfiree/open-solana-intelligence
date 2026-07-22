-- OSI V2 AI Pack Phase 1: evidence-bound generation, review and approval.
--
-- This is an additive, fail-closed slice. It does not enable either dedicated
-- feature flag, publish an existing Pack, expose a table to a browser role, or
-- permit the D17 maintainer-bootstrap channel to approve an AI Pack.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_AI_PACK_WRITES_ENABLED', 'false', statement_timestamp()),
  ('OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED', 'false', statement_timestamp()),
  ('OSI_V2_AI_PACK_MODEL', 'claude-sonnet-5', statement_timestamp()),
  ('OSI_V2_AI_PACK_RATE_WINDOW_SECONDS', '3600', statement_timestamp()),
  ('OSI_V2_AI_PACK_MAX_PER_WALLET', '2', statement_timestamp()),
  ('OSI_V2_AI_PACK_MAX_PER_FINGERPRINT', '4', statement_timestamp()),
  ('OSI_V2_AI_PACK_CASE_COOLDOWN_SECONDS', '21600', statement_timestamp()),
  ('OSI_V2_AI_PACK_DAILY_QUOTA', '10', statement_timestamp()),
  ('OSI_V2_AI_PACK_MAX_INPUT_CHARS', '24000', statement_timestamp()),
  ('OSI_V2_AI_PACK_MAX_OUTPUT_TOKENS', '1000', statement_timestamp()),
  ('OSI_V2_AI_PACK_MAX_OUTPUT_CHARS', '12000', statement_timestamp()),
  ('OSI_V2_AI_PACK_MAX_EVIDENCE_ITEMS', '40', statement_timestamp()),
  ('OSI_V2_AI_PACK_PROVIDER_TIMEOUT_MS', '45000', statement_timestamp()),
  ('OSI_V2_AI_PACK_INPUT_USD_MICROS_PER_MTOK', '3000000', statement_timestamp()),
  ('OSI_V2_AI_PACK_OUTPUT_USD_MICROS_PER_MTOK', '15000000', statement_timestamp())
on conflict (key) do nothing;

alter table public.event_receipts
  add constraint event_receipts_ai_pack_approval_standard_check
  check (
    event_type <> 'AI_PACK_APPROVED'
    or decision_channel = 'standard'
  ) not valid;

alter table public.ai_packs
  add column public_ref text
    constraint ai_packs_public_ref_check
    check (public_ref is null or public_ref ~ '^OSI-AP-[0-9A-F]{12}$'),
  add column native_generation boolean not null default false;

create unique index ai_packs_public_ref_uidx
  on public.ai_packs (public_ref)
  where public_ref is not null;

alter table public.ai_pack_versions
  add column version_ref text
    constraint ai_pack_versions_ref_check
    check (version_ref is null or version_ref ~ '^OSI-APV-[0-9A-F]{16}$'),
  add column artifact_hash text
    constraint ai_pack_versions_artifact_hash_check
    check (artifact_hash is null or artifact_hash ~ '^[0-9a-f]{64}$'),
  add column public_layer_is_stale boolean not null default false,
  add column public_layer_stale_at timestamptz,
  add column owner_safe_layer_is_stale boolean not null default false,
  add column owner_safe_layer_stale_at timestamptz,
  add column analyst_restricted_layer_is_stale boolean not null default false,
  add column analyst_restricted_layer_stale_at timestamptz,
  add column first_stale_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  add column approved_at timestamptz,
  add column approved_by_wallet text
    constraint ai_pack_versions_approved_wallet_check
    check (
      approved_by_wallet is null
      or (
        char_length(approved_by_wallet) between 32 and 44
        and approved_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
      )
    ),
  add column approval_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  add column approval_quorum_hash text
    constraint ai_pack_versions_approval_quorum_hash_check
    check (
      approval_quorum_hash is null
      or approval_quorum_hash ~ '^[0-9a-f]{64}$'
    ),
  add column approval_independent_count integer
    constraint ai_pack_versions_approval_count_check
    check (
      approval_independent_count is null
      or approval_independent_count >= 2
    ),
  add column approval_total_weight numeric(8,2)
    constraint ai_pack_versions_approval_weight_check
    check (
      approval_total_weight is null
      or approval_total_weight >= 2.50
    ),
  add constraint ai_pack_versions_layer_staleness_shape_check
    check (
      version_ref is null
      or (
        (public_layer_is_stale = (public_layer_stale_at is not null))
        and (owner_safe_layer_is_stale = (owner_safe_layer_stale_at is not null))
        and (
          analyst_restricted_layer_is_stale
          = (analyst_restricted_layer_stale_at is not null)
        )
        and is_stale = (
          public_layer_is_stale
          or owner_safe_layer_is_stale
          or analyst_restricted_layer_is_stale
        )
      )
    ) not valid,
  add constraint ai_pack_versions_approval_shape_check
    check (
      version_ref is null
      or (
        (
          lifecycle_state in ('approved', 'attached_to_resolution')
          and approved_at is not null
          and approved_by_wallet is not null
          and approval_receipt_id is not null
          and approval_quorum_hash is not null
          and approval_independent_count is not null
          and approval_total_weight is not null
        )
        or (
          lifecycle_state not in ('approved', 'attached_to_resolution', 'superseded')
          and approved_at is null
          and approved_by_wallet is null
          and approval_receipt_id is null
          and approval_quorum_hash is null
          and approval_independent_count is null
          and approval_total_weight is null
        )
        or (
          lifecycle_state = 'superseded'
          and (
            (
              approved_at is not null
              and approved_by_wallet is not null
              and approval_receipt_id is not null
              and approval_quorum_hash is not null
              and approval_independent_count is not null
              and approval_total_weight is not null
            )
            or (
              approved_at is null
              and approved_by_wallet is null
              and approval_receipt_id is null
              and approval_quorum_hash is null
              and approval_independent_count is null
              and approval_total_weight is null
            )
          )
        )
      )
    ) not valid,
  add constraint ai_pack_versions_native_identity_check
    check (
      version_ref is null
      or (
        artifact_hash is not null
        and lifecycle_state <> 'draft'
      )
    ) not valid,
  add constraint ai_pack_versions_confidence_components_check
    check (
      version_ref is null
      or (
        jsonb_typeof(confidence_profile) = 'object'
        and confidence_profile ?& array[
          'public_verifiability',
          'onchain_reproducibility',
          'evidence_coverage',
          'source_consistency',
          'analyst_attestation'
        ]
        and confidence_profile - array[
          'public_verifiability',
          'onchain_reproducibility',
          'evidence_coverage',
          'source_consistency',
          'analyst_attestation'
        ] = '{}'::jsonb
        and jsonb_typeof(confidence_profile->'public_verifiability') = 'number'
        and jsonb_typeof(confidence_profile->'onchain_reproducibility') = 'number'
        and jsonb_typeof(confidence_profile->'evidence_coverage') = 'number'
        and jsonb_typeof(confidence_profile->'source_consistency') = 'number'
        and jsonb_typeof(confidence_profile->'analyst_attestation') = 'number'
        and (confidence_profile->>'public_verifiability')::numeric between 0 and 1
        and (confidence_profile->>'onchain_reproducibility')::numeric between 0 and 1
        and (confidence_profile->>'evidence_coverage')::numeric between 0 and 1
        and (confidence_profile->>'source_consistency')::numeric between 0 and 1
        and (confidence_profile->>'analyst_attestation')::numeric between 0 and 1
      )
    ) not valid;

-- The accepted AI Pack state machine permits an older immutable version to
-- become superseded once a replacement is created or approved. This includes
-- review states; otherwise evidence drift could leave an older current review
-- permanently nonterminal after a replacement becomes authoritative.
create or replace function public.osi_v2_valid_ai_pack_transition(
  old_state text,
  new_state text
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    old_state = new_state
    or (old_state = 'draft' and new_state = 'review_required')
    or (
      old_state = 'review_required'
      and new_state in (
        'revision_requested',
        'supported',
        'disputed',
        'approved',
        'rejected'
      )
    )
    or (
      old_state = 'supported'
      and new_state in (
        'disputed',
        'revision_requested',
        'approved',
        'rejected'
      )
    )
    or (
      old_state = 'disputed'
      and new_state in (
        'supported',
        'revision_requested',
        'approved',
        'rejected'
      )
    )
    or (old_state = 'approved' and new_state = 'attached_to_resolution')
    or (
      old_state in (
        'draft',
        'review_required',
        'revision_requested',
        'supported',
        'disputed',
        'approved',
        'rejected',
        'attached_to_resolution'
      )
      and new_state = 'superseded'
    )
$$;

create unique index ai_pack_versions_ref_uidx
  on public.ai_pack_versions (version_ref)
  where version_ref is not null;
create unique index ai_pack_versions_approval_receipt_uidx
  on public.ai_pack_versions (approval_receipt_id)
  where approval_receipt_id is not null;
create index ai_pack_versions_public_approved_idx
  on public.ai_pack_versions (pack_id, approved_at desc)
  where lifecycle_state in ('approved', 'attached_to_resolution');

alter table public.ai_pack_reviews
  add column public_ref text
    constraint ai_pack_reviews_public_ref_check
    check (public_ref is null or public_ref ~ '^OSI-APR-[0-9A-F]{16}$'),
  add column reviewer_profile_wallet text
    references public.analyst_profiles (wallet) on delete restrict,
  add column tier_snapshot text
    constraint ai_pack_reviews_tier_snapshot_check
    check (
      tier_snapshot is null
      or tier_snapshot in (
        'probationary', 'analyst_i', 'analyst_ii',
        'senior', 'distinguished'
      )
    ),
  add column public_rationale text
    constraint ai_pack_reviews_public_rationale_check
    check (
      public_rationale is null
      or (
        public_rationale = btrim(public_rationale)
        and char_length(public_rationale) between 10 and 2000
      )
    ),
  add column private_note text
    constraint ai_pack_reviews_private_note_check
    check (
      private_note is null
      or (
        private_note = btrim(private_note)
        and char_length(private_note) between 1 and 4000
      )
    ),
  add constraint ai_pack_reviews_native_snapshot_check
    check (
      public_ref is null
      or (
        reviewer_profile_wallet = reviewer_wallet
        and tier_snapshot is not null
        and public_rationale is not null
      )
    );

create unique index ai_pack_reviews_public_ref_uidx
  on public.ai_pack_reviews (public_ref)
  where public_ref is not null;
create index ai_pack_reviews_active_quorum_idx
  on public.ai_pack_reviews (
    pack_version_id, decision, reviewer_wallet
  ) where is_active;

create table public.osi_v2_ai_pack_generation_runs (
  id uuid primary key,
  nonce text not null unique
    references public.osi_nonces (nonce) on delete restrict,
  idempotency_key text not null unique
    constraint osi_v2_ai_pack_runs_idempotency_check
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  request_fingerprint_hash text not null
    constraint osi_v2_ai_pack_runs_fingerprint_check
    check (request_fingerprint_hash ~ '^[0-9a-f]{64}$'),
  state text not null
    constraint osi_v2_ai_pack_runs_state_check
    check (state in ('prepared', 'reserved', 'committed', 'failed')),
  actor_wallet text not null
    constraint osi_v2_ai_pack_runs_actor_wallet_check
    check (
      char_length(actor_wallet) between 32 and 44
      and actor_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  actor_role text not null
    constraint osi_v2_ai_pack_runs_actor_role_check
    check (actor_role in ('analyst', 'senior', 'maintainer')),
  maintainer_auth_uuid text
    constraint osi_v2_ai_pack_runs_auth_uuid_check
    check (
      maintainer_auth_uuid is null
      or maintainer_auth_uuid
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ),
  case_id uuid not null
    references public.cases (id) on delete restrict,
  case_public_ref text not null,
  pack_type text not null
    constraint osi_v2_ai_pack_runs_pack_type_check
    check (pack_type in ('victim', 'exchange', 'law_enforcement')),
  pack_id uuid not null,
  pack_public_ref text not null
    constraint osi_v2_ai_pack_runs_pack_ref_check
    check (pack_public_ref ~ '^OSI-AP-[0-9A-F]{12}$'),
  version_id uuid not null unique,
  version_public_ref text not null unique
    constraint osi_v2_ai_pack_runs_version_ref_check
    check (version_public_ref ~ '^OSI-APV-[0-9A-F]{16}$'),
  version_no integer not null
    constraint osi_v2_ai_pack_runs_version_no_check
    check (version_no >= 1),
  evidence_manifest jsonb not null
    constraint osi_v2_ai_pack_runs_manifest_check
    check (jsonb_typeof(evidence_manifest) = 'array'),
  public_manifest_hash text not null
    constraint osi_v2_ai_pack_runs_public_hash_check
    check (public_manifest_hash ~ '^[0-9a-f]{64}$'),
  owner_safe_manifest_hash text not null
    constraint osi_v2_ai_pack_runs_owner_hash_check
    check (owner_safe_manifest_hash ~ '^[0-9a-f]{64}$'),
  analyst_restricted_manifest_hash text not null
    constraint osi_v2_ai_pack_runs_restricted_hash_check
    check (analyst_restricted_manifest_hash ~ '^[0-9a-f]{64}$'),
  payload_hash text not null
    constraint osi_v2_ai_pack_runs_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  proof_text text not null
    constraint osi_v2_ai_pack_runs_proof_text_check
    check (char_length(proof_text) between 140 and 600),
  model text not null
    constraint osi_v2_ai_pack_runs_model_check
    check (model ~ '^claude-[a-z0-9-]{3,120}$'),
  max_input_chars integer not null
    constraint osi_v2_ai_pack_runs_input_cap_check
    check (max_input_chars between 1000 and 100000),
  input_char_count integer not null
    constraint osi_v2_ai_pack_runs_input_count_check
    check (input_char_count between 1 and 1000000),
  max_output_tokens integer not null
    constraint osi_v2_ai_pack_runs_token_cap_check
    check (max_output_tokens between 64 and 4000),
  max_output_chars integer not null
    constraint osi_v2_ai_pack_runs_output_cap_check
    check (max_output_chars between 100 and 50000),
  max_evidence_items integer not null
    constraint osi_v2_ai_pack_runs_evidence_cap_check
    check (max_evidence_items between 1 and 40),
  provider_timeout_ms integer not null
    constraint osi_v2_ai_pack_runs_timeout_check
    check (provider_timeout_ms between 1000 and 120000),
  input_price_usd_micros_per_mtok bigint not null
    constraint osi_v2_ai_pack_runs_input_price_check
    check (input_price_usd_micros_per_mtok between 0 and 1000000000),
  output_price_usd_micros_per_mtok bigint not null
    constraint osi_v2_ai_pack_runs_output_price_check
    check (output_price_usd_micros_per_mtok between 0 and 1000000000),
  signature text,
  signed_message_hash text
    constraint osi_v2_ai_pack_runs_message_hash_check
    check (
      signed_message_hash is null
      or signed_message_hash ~ '^[0-9a-f]{64}$'
    ),
  provider_input_tokens integer
    constraint osi_v2_ai_pack_runs_provider_input_check
    check (provider_input_tokens is null or provider_input_tokens >= 0),
  provider_output_tokens integer
    constraint osi_v2_ai_pack_runs_provider_output_check
    check (provider_output_tokens is null or provider_output_tokens >= 0),
  cost_usd_micros bigint
    constraint osi_v2_ai_pack_runs_cost_check
    check (cost_usd_micros is null or cost_usd_micros >= 0),
  provider_request_ref_hash text
    constraint osi_v2_ai_pack_runs_provider_ref_check
    check (
      provider_request_ref_hash is null
      or provider_request_ref_hash ~ '^[0-9a-f]{64}$'
    ),
  failure_code text
    constraint osi_v2_ai_pack_runs_failure_code_check
    check (
      failure_code is null
      or failure_code ~ '^[a-z][a-z0-9_:-]{0,95}$'
    ),
  receipt_id uuid unique
    references public.event_receipts (id) on delete restrict,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  reserved_at timestamptz,
  committed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint osi_v2_ai_pack_runs_expiry_check
    check (expires_at > issued_at),
  constraint osi_v2_ai_pack_runs_state_shape_check
    check (
      (
        state = 'prepared'
        and reserved_at is null
        and committed_at is null
        and failed_at is null
        and receipt_id is null
        and signature is null
        and signed_message_hash is null
      )
      or (
        state = 'reserved'
        and reserved_at is not null
        and committed_at is null
        and failed_at is null
        and receipt_id is null
        and signature is not null
        and signed_message_hash is not null
      )
      or (
        state = 'committed'
        and reserved_at is not null
        and committed_at is not null
        and failed_at is null
        and receipt_id is not null
        and signature is not null
        and signed_message_hash is not null
        and provider_input_tokens is not null
        and provider_output_tokens is not null
        and cost_usd_micros is not null
        and failure_code is null
      )
      or (
        state = 'failed'
        and committed_at is null
        and failed_at is not null
        and receipt_id is null
        and failure_code is not null
      )
    )
);

comment on table public.osi_v2_ai_pack_generation_runs is
  'Service-only durable AI Pack generation reservation, quota and provider telemetry infrastructure; not one of the 32 domain tables.';
comment on column public.osi_v2_ai_pack_generation_runs.signature is
  'Wallet authorization verified by the Edge gateway; never changes PACK_SUBMITTED from its canonical system-event proof class.';
comment on column public.ai_pack_versions.approval_quorum_hash is
  'Write-once hash of the exact active counted analyst snapshot finalized by AI_PACK_APPROVED. Bootstrap decisions are forbidden.';

create unique index osi_v2_ai_pack_runs_one_reserved_case_type_uidx
  on public.osi_v2_ai_pack_generation_runs (case_id, pack_type)
  where state = 'reserved';
create index osi_v2_ai_pack_runs_wallet_reserved_idx
  on public.osi_v2_ai_pack_generation_runs (actor_wallet, reserved_at desc)
  where reserved_at is not null;
create index osi_v2_ai_pack_runs_fingerprint_reserved_idx
  on public.osi_v2_ai_pack_generation_runs (
    request_fingerprint_hash, reserved_at desc
  ) where reserved_at is not null;
create index osi_v2_ai_pack_runs_case_reserved_idx
  on public.osi_v2_ai_pack_generation_runs (case_id, reserved_at desc)
  where reserved_at is not null;
create index osi_v2_ai_pack_runs_daily_reserved_idx
  on public.osi_v2_ai_pack_generation_runs (reserved_at)
  where reserved_at is not null;

alter table public.osi_v2_ai_pack_generation_runs enable row level security;
alter table public.osi_v2_ai_pack_generation_runs force row level security;
revoke all privileges on table public.osi_v2_ai_pack_generation_runs
  from public, anon, authenticated;
grant select, insert, update on table public.osi_v2_ai_pack_generation_runs
  to service_role;

-- PACK_SUBMITTED has canonical system-event transport, but its generation
-- authorization still uses an exact single-use Stage-5 nonce. The signature is
-- retained only in the service-only run, never mislabelled on the receipt.
alter table public.osi_nonces
  drop constraint osi_nonces_canonical_purpose_check;
alter table public.osi_nonces
  add constraint osi_nonces_canonical_purpose_check
  check (
    public.osi_v2_expected_proof_type(purpose)
      in ('solana_memo', 'wallet_signed_server_verified')
    or purpose = 'PACK_SUBMITTED'
  );

create function osi_private.osi_v2_canonical_jsonb_text(p_value jsonb)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  result_value text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg(
        to_jsonb(item.key)::text || ':'
          || osi_private.osi_v2_canonical_jsonb_text(item.value),
        ',' order by item.key collate "C"
      ), '') || '}'
        into result_value
        from jsonb_each(p_value) as item;
    when 'array' then
      select '[' || coalesce(string_agg(
        osi_private.osi_v2_canonical_jsonb_text(item.value),
        ',' order by item.ordinality
      ), '') || ']'
        into result_value
        from jsonb_array_elements(p_value)
          with ordinality as item(value, ordinality);
    else
      result_value := p_value::text;
  end case;
  return result_value;
end;
$$;

create function osi_private.osi_v2_ai_pack_hash(p_value jsonb)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select encode(extensions.digest(
    pg_catalog.convert_to(
      osi_private.osi_v2_canonical_jsonb_text(p_value),
      'UTF8'
    ),
    'sha256'
  ), 'hex')
$$;

create function osi_private.osi_v2_ai_pack_writes_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select bool_and(config.value = 'true')
      from public.osi_config as config
     where config.key in (
       'OSI_V2_WRITES_ENABLED',
       'OSI_V2_PROOF_ENABLED',
       'OSI_V2_AI_PACK_WRITES_ENABLED'
     )
     having count(*) = 3
  ), false)
$$;

create function osi_private.osi_v2_ai_pack_review_writes_enabled()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select osi_private.osi_v2_ai_pack_writes_enabled()
    and coalesce((
      select config.value = 'true'
        from public.osi_config as config
       where config.key = 'OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED'
    ), false)
$$;

create function osi_private.osi_v2_ai_pack_config_integer(
  p_key text,
  p_min integer,
  p_max integer
)
returns integer
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  value_text text;
  value_integer integer;
begin
  select config.value into value_text
    from public.osi_config as config
   where config.key = p_key;
  if value_text is null or value_text !~ '^[0-9]+$' then
    raise exception 'ai_pack_config_invalid' using errcode = '55000';
  end if;
  begin
    value_integer := value_text::integer;
  exception when numeric_value_out_of_range then
    raise exception 'ai_pack_config_invalid' using errcode = '55000';
  end;
  if value_integer not between p_min and p_max then
    raise exception 'ai_pack_config_invalid' using errcode = '55000';
  end if;
  return value_integer;
end;
$$;

create function osi_private.osi_v2_ai_pack_config_bigint(
  p_key text,
  p_min bigint,
  p_max bigint
)
returns bigint
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  value_text text;
  value_bigint bigint;
begin
  select config.value into value_text
    from public.osi_config as config
   where config.key = p_key;
  if value_text is null or value_text !~ '^[0-9]+$' then
    raise exception 'ai_pack_config_invalid' using errcode = '55000';
  end if;
  begin
    value_bigint := value_text::bigint;
  exception when numeric_value_out_of_range then
    raise exception 'ai_pack_config_invalid' using errcode = '55000';
  end;
  if value_bigint not between p_min and p_max then
    raise exception 'ai_pack_config_invalid' using errcode = '55000';
  end if;
  return value_bigint;
end;
$$;

create function osi_private.osi_v2_ai_pack_evidence_manifest(p_case_id uuid)
returns jsonb
language sql
stable
strict
security invoker
set search_path = ''
as $$
  with case_owner as (
    select case_item.submitted_by_wallet
      from public.cases as case_item
     where case_item.id = p_case_id
  ), linked as (
    select link.evidence_item_id
      from public.case_evidence_links as link
     where link.case_id = p_case_id
    union
    select link.evidence_item_id
      from public.case_report_version_evidence as link
      join public.case_report_versions as version
        on version.id = link.report_version_id
      join public.case_reports as report
        on report.id = version.report_id
     where report.case_id = p_case_id
  ), classified as (
    select
      evidence.id as evidence_item_id,
      evidence.kind,
      evidence.ref,
      evidence.sha256,
      evidence.is_public,
      evidence.moderation_state,
      case
        when evidence.is_public then 'public'
        when evidence.added_by_wallet = owner.submitted_by_wallet
          then 'owner_safe'
        else 'analyst_restricted'
      end as access_scope,
      evidence.created_at
    from linked
    join public.evidence_items as evidence
      on evidence.id = linked.evidence_item_id
    cross join case_owner as owner
    where evidence.moderation_state = 'approved'
  ), ordered as (
    select classified.*,
      row_number() over (
        partition by access_scope
        order by created_at, evidence_item_id
      ) - 1 as ordinal,
      case access_scope
        when 'public' then 0
        when 'owner_safe' then 1
        else 2
      end as scope_rank
    from classified
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'access_scope', ordered.access_scope,
    'evidence_item_id', ordered.evidence_item_id,
    'kind', ordered.kind,
    'ref', ordered.ref,
    'sha256', ordered.sha256,
    'is_public', ordered.is_public,
    'moderation_state', ordered.moderation_state,
    'ordinal', ordered.ordinal
  ) order by ordered.scope_rank, ordered.ordinal, ordered.evidence_item_id),
  '[]'::jsonb)
  from ordered
$$;

create function osi_private.osi_v2_ai_pack_manifest_hash(
  p_manifest jsonb,
  p_scopes text[]
)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select osi_private.osi_v2_ai_pack_hash(coalesce(jsonb_agg(
    jsonb_build_object(
      'access_scope', item.value->>'access_scope',
      'evidence_item_id', item.value->>'evidence_item_id',
      'evidence_hash_at_generation', item.value->>'sha256',
      'ordinal', (item.value->>'ordinal')::integer
    )
    order by
      case item.value->>'access_scope'
        when 'public' then 0
        when 'owner_safe' then 1
        else 2
      end,
      (item.value->>'ordinal')::integer,
      item.value->>'evidence_item_id'
  ), '[]'::jsonb))
  from jsonb_array_elements(p_manifest) as item(value)
  where item.value->>'access_scope' = any (p_scopes)
$$;

create function osi_private.osi_v2_ai_pack_input_char_count(p_manifest jsonb)
returns integer
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  with layers(scopes) as (
    values
      (array['public']::text[]),
      (array['public', 'owner_safe']::text[]),
      (array['public', 'owner_safe', 'analyst_restricted']::text[])
  )
  select 1536 + coalesce(sum(char_length(
    osi_private.osi_v2_canonical_jsonb_text(coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', item.value->>'kind',
        'ordinal', (item.value->>'ordinal')::integer,
        'ref', item.value->>'ref',
        'sha256', item.value->>'sha256'
      ) order by
        case item.value->>'access_scope'
          when 'public' then 0
          when 'owner_safe' then 1
          else 2
        end,
        (item.value->>'ordinal')::integer,
        item.value->>'evidence_item_id')
      from jsonb_array_elements(p_manifest) as item(value)
      where item.value->>'access_scope' = any (layers.scopes)
    ), '[]'::jsonb))
  )), 0)::integer
  from layers
$$;

create function osi_private.osi_v2_ai_pack_proof_text(
  p_purpose text,
  p_version_ref text,
  p_actor_wallet text,
  p_actor_role text,
  p_decision text,
  p_nonce text,
  p_payload_hash text,
  p_issued_at timestamptz,
  p_expires_at timestamptz
)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select 'OSI2|1|' || p_purpose
    || '|t=pack_version|id=' || p_version_ref
    || '|a=' || p_actor_wallet
    || '|r=' || p_actor_role
    || '|d=' || p_decision
    || '|n=' || p_nonce
    || '|h=' || p_payload_hash
    || '|ts=' || floor(extract(epoch from p_issued_at))::bigint
    || '|exp=' || floor(extract(epoch from p_expires_at))::bigint
$$;

create function osi_private.osi_v2_ai_pack_generation_payload_hash(
  p_generation_id uuid,
  p_actor_wallet text,
  p_actor_role text,
  p_case_id uuid,
  p_case_public_ref text,
  p_pack_id uuid,
  p_pack_public_ref text,
  p_pack_type text,
  p_version_id uuid,
  p_version_public_ref text,
  p_version_no integer,
  p_public_manifest_hash text,
  p_owner_manifest_hash text,
  p_restricted_manifest_hash text,
  p_model text
)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select osi_private.osi_v2_ai_pack_hash(jsonb_build_object(
    'actor_role', p_actor_role,
    'actor_wallet', p_actor_wallet,
    'case_id', p_case_id,
    'case_public_ref', p_case_public_ref,
    'event_type', 'PACK_SUBMITTED',
    'generation_id', p_generation_id,
    'model', p_model,
    'pack_id', p_pack_id,
    'pack_public_ref', p_pack_public_ref,
    'pack_type', p_pack_type,
    'public_manifest_hash', p_public_manifest_hash,
    'owner_safe_manifest_hash', p_owner_manifest_hash,
    'analyst_restricted_manifest_hash', p_restricted_manifest_hash,
    'version_id', p_version_id,
    'version_no', p_version_no,
    'version_public_ref', p_version_public_ref
  ))
$$;

create function osi_private.osi_v2_ai_pack_review_payload_hash(
  p_purpose text,
  p_review_id uuid,
  p_review_ref text,
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
  select osi_private.osi_v2_ai_pack_hash(jsonb_build_object(
    'actor_wallet', p_actor_wallet,
    'decision', p_decision,
    'event_type', p_purpose,
    'private_note', p_private_note,
    'public_rationale', p_public_rationale,
    'reason_code', p_reason_code,
    'review_id', p_review_id,
    'review_public_ref', p_review_ref,
    'version_id', p_version_id,
    'version_ref', p_version_ref
  ))
$$;

create function osi_private.osi_v2_ai_pack_feedback_payload_hash(
  p_feedback_id uuid,
  p_version_id uuid,
  p_version_ref text,
  p_owner_wallet text,
  p_feedback_type text,
  p_public_safe_summary text,
  p_feedback_restricted text
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select osi_private.osi_v2_ai_pack_hash(jsonb_build_object(
    'actor_wallet', p_owner_wallet,
    'event_type', 'AI_PACK_OWNER_FEEDBACK_SUBMITTED',
    'feedback_id', p_feedback_id,
    'feedback_restricted', p_feedback_restricted,
    'feedback_type', p_feedback_type,
    'public_safe_summary', p_public_safe_summary,
    'version_id', p_version_id,
    'version_ref', p_version_ref
  ))
$$;

create function osi_private.osi_v2_ai_pack_quorum(
  p_version_id uuid,
  p_maintainer_wallet text default null
)
returns table (
  independent_count integer,
  total_weight numeric,
  has_dispute boolean,
  has_revision_request boolean,
  quorum_hash text,
  quorum_ready boolean,
  snapshot jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  version_creator text;
  case_owner text;
  min_count integer;
  min_weight numeric;
begin
  select version.created_by_wallet, case_item.submitted_by_wallet
    into version_creator, case_owner
    from public.ai_pack_versions as version
    join public.ai_packs as pack on pack.id = version.pack_id
    join public.cases as case_item on case_item.id = pack.case_id
   where version.id = p_version_id;

  select case when config.value ~ '^[0-9]+$'
    then config.value::integer end
    into min_count
    from public.osi_config as config
   where config.key = 'OSI_V2_AI_PACK_MIN_COUNT';
  select case when config.value ~ '^[0-9]+(\.[0-9]+)?$'
    then config.value::numeric end
    into min_weight
    from public.osi_config as config
   where config.key = 'OSI_V2_AI_PACK_MIN_WEIGHT';
  if min_count is null or min_count < 2
     or min_weight is null or min_weight < 2.50 then
    raise exception 'ai_pack_config_invalid' using errcode = '55000';
  end if;

  select
    count(*) filter (
      where review.decision in ('support', 'approve')
    )::integer,
    coalesce(sum(review.weight) filter (
      where review.decision in ('support', 'approve')
    ), 0)::numeric,
    bool_or(review.decision = 'dispute'),
    bool_or(review.decision = 'request_revision'),
    coalesce(jsonb_agg(jsonb_build_object(
      'decision', review.decision,
      'receipt_id', review.event_receipt_id,
      'review_id', review.id,
      'review_public_ref', review.public_ref,
      'reviewer_wallet', review.reviewer_wallet,
      'tier_snapshot', review.tier_snapshot,
      'weight', review.weight
    ) order by review.reviewer_wallet), '[]'::jsonb)
    into independent_count, total_weight, has_dispute,
      has_revision_request, snapshot
    from public.ai_pack_reviews as review
    join public.analyst_profiles as profile
      on profile.wallet = review.reviewer_wallet
     and profile.status in (
       'probationary_analyst', 'verified_analyst', 'senior_analyst'
     )
     and profile.verified = true
     and profile.approved = true
     and profile.weight_cached = review.weight
    join public.event_receipts as receipt
      on receipt.id = review.event_receipt_id
     and receipt.event_version = 'OSI2'
     and receipt.event_type in (
       'AI_PACK_REVIEW_CAST', 'AI_PACK_REVIEW_REVISED'
     )
     and receipt.target_type = 'pack_version'
     and receipt.target_id = p_version_id::text
     and receipt.actor_wallet = review.reviewer_wallet
     and receipt.decision = review.decision
     and receipt.weight = review.weight
     and receipt.reason_code is not distinct from review.reason_code
     and receipt.proof_type = 'wallet_signed_server_verified'
     and receipt.server_verified = true
   where review.pack_version_id = p_version_id
     and review.is_active = true
     and review.reviewer_wallet <> version_creator
     and review.reviewer_wallet <> case_owner
     and (
       p_maintainer_wallet is null
       or review.reviewer_wallet <> p_maintainer_wallet
     )
     and osi_private.osi_v2_sas_review_counts('ai_pack', review.id);

  has_dispute := coalesce(has_dispute, false);
  has_revision_request := coalesce(has_revision_request, false);
  quorum_hash := osi_private.osi_v2_ai_pack_hash(jsonb_build_object(
    'reviews', snapshot,
    'version_id', p_version_id
  ));
  quorum_ready := independent_count >= min_count
    and total_weight >= min_weight
    and not has_dispute
    and not has_revision_request;
  return next;
end;
$$;

create or replace function public.osi_v2_guard_ai_pack_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_core jsonb;
  new_core jsonb;
begin
  old_core := to_jsonb(old) - array[
    'lifecycle_state', 'is_stale', 'stale_at', 'stale_reason',
    'public_layer_is_stale', 'public_layer_stale_at',
    'owner_safe_layer_is_stale', 'owner_safe_layer_stale_at',
    'analyst_restricted_layer_is_stale',
    'analyst_restricted_layer_stale_at', 'first_stale_receipt_id',
    'approved_at', 'approved_by_wallet', 'approval_receipt_id',
    'approval_quorum_hash', 'approval_independent_count',
    'approval_total_weight', 'superseded_by_version_id', 'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'lifecycle_state', 'is_stale', 'stale_at', 'stale_reason',
    'public_layer_is_stale', 'public_layer_stale_at',
    'owner_safe_layer_is_stale', 'owner_safe_layer_stale_at',
    'analyst_restricted_layer_is_stale',
    'analyst_restricted_layer_stale_at', 'first_stale_receipt_id',
    'approved_at', 'approved_by_wallet', 'approval_receipt_id',
    'approval_quorum_hash', 'approval_independent_count',
    'approval_total_weight', 'superseded_by_version_id', 'updated_at'
  ];
  if new_core is distinct from old_core then
    raise exception 'AI Pack version content, identity, manifests and profile are immutable'
      using errcode = '55000';
  end if;
  if not public.osi_v2_valid_ai_pack_transition(
    old.lifecycle_state, new.lifecycle_state
  ) then
    raise exception 'Invalid AI Pack transition: % -> %',
      old.lifecycle_state, new.lifecycle_state using errcode = '23514';
  end if;
  if (old.is_stale and not new.is_stale)
     or (old.public_layer_is_stale and not new.public_layer_is_stale)
     or (old.owner_safe_layer_is_stale and not new.owner_safe_layer_is_stale)
     or (
       old.analyst_restricted_layer_is_stale
       and not new.analyst_restricted_layer_is_stale
     ) then
    raise exception 'AI Pack staleness is monotonic for an immutable version'
      using errcode = '55000';
  end if;
  if old.first_stale_receipt_id is not null
     and new.first_stale_receipt_id
       is distinct from old.first_stale_receipt_id then
    raise exception 'First AI Pack stale receipt is write-once'
      using errcode = '55000';
  end if;
  if old.approval_receipt_id is not null
     and (
       new.approved_at is distinct from old.approved_at
       or new.approved_by_wallet is distinct from old.approved_by_wallet
       or new.approval_receipt_id is distinct from old.approval_receipt_id
       or new.approval_quorum_hash is distinct from old.approval_quorum_hash
       or new.approval_independent_count
         is distinct from old.approval_independent_count
       or new.approval_total_weight is distinct from old.approval_total_weight
     ) then
    raise exception 'AI Pack approval metadata is write-once'
      using errcode = '55000';
  end if;
  if old.approval_receipt_id is null
     and new.approval_receipt_id is not null
     and new.lifecycle_state <> 'approved' then
    raise exception 'AI Pack approval metadata requires approved lifecycle'
      using errcode = '23514';
  end if;
  if old.superseded_by_version_id is not null
     and new.superseded_by_version_id
       is distinct from old.superseded_by_version_id then
    raise exception 'AI Pack supersession link is write-once'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create function public.osi_v2_guard_ai_pack_generation_run()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_core jsonb;
  new_core jsonb;
begin
  old_core := to_jsonb(old) - array[
    'state', 'signature', 'signed_message_hash',
    'provider_input_tokens', 'provider_output_tokens', 'cost_usd_micros',
    'provider_request_ref_hash', 'failure_code', 'receipt_id',
    'reserved_at', 'committed_at', 'failed_at', 'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'state', 'signature', 'signed_message_hash',
    'provider_input_tokens', 'provider_output_tokens', 'cost_usd_micros',
    'provider_request_ref_hash', 'failure_code', 'receipt_id',
    'reserved_at', 'committed_at', 'failed_at', 'updated_at'
  ];
  if new_core is distinct from old_core then
    raise exception 'AI Pack generation binding and budget snapshots are immutable'
      using errcode = '55000';
  end if;
  if not (
    (old.state = 'prepared' and new.state in ('reserved', 'failed'))
    or (old.state = 'reserved' and new.state in ('committed', 'failed'))
  ) then
    raise exception 'Invalid AI Pack generation transition: % -> %',
      old.state, new.state using errcode = '23514';
  end if;
  new.updated_at := statement_timestamp();
  return new;
end;
$$;

create trigger osi_v2_guard_ai_pack_generation_run
before update on public.osi_v2_ai_pack_generation_runs
for each row execute function public.osi_v2_guard_ai_pack_generation_run();

-- Manifest rows are immutable. A changed evidence set always produces a new
-- Pack version and per-layer stale markers on the historical version.
create function public.osi_v2_reject_ai_pack_evidence_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'AI Pack evidence-manifest rows are immutable'
    using errcode = '55000';
end;
$$;

create trigger osi_v2_reject_ai_pack_evidence_update
before update or delete on public.ai_pack_version_evidence
for each row execute function public.osi_v2_reject_ai_pack_evidence_mutation();

create function osi_private.osi_v2_prepare_ai_pack_generation(
  p_nonce text,
  p_actor_wallet text,
  p_case_public_ref text,
  p_pack_type text,
  p_idempotency_key text,
  p_request_fingerprint_hash text,
  p_maintainer_auth_uuid text default null
)
returns table (
  generation_id uuid,
  issued_nonce text,
  actor_role text,
  case_id uuid,
  case_public_ref text,
  pack_id uuid,
  pack_public_ref text,
  version_id uuid,
  version_public_ref text,
  version_no integer,
  public_manifest_hash text,
  owner_safe_manifest_hash text,
  analyst_restricted_manifest_hash text,
  payload_hash text,
  proof_text text,
  model text,
  max_input_chars integer,
  input_char_count integer,
  max_output_tokens integer,
  max_output_chars integer,
  max_evidence_items integer,
  provider_timeout_ms integer,
  input_price_usd_micros_per_mtok bigint,
  output_price_usd_micros_per_mtok bigint,
  evidence_manifest jsonb,
  issued_at timestamptz,
  expires_at timestamptz,
  generation_state text,
  receipt_id uuid,
  lifecycle_state text,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_run public.osi_v2_ai_pack_generation_runs%rowtype;
  case_row public.cases%rowtype;
  pack_row public.ai_packs%rowtype;
  profile public.analyst_profiles%rowtype;
  existing_state text;
  actual_generation_id uuid := gen_random_uuid();
  actual_pack_id uuid;
  actual_pack_ref text;
  actual_version_id uuid := gen_random_uuid();
  actual_version_ref text;
  actual_version_no integer;
  actual_actor_role text;
  actual_manifest jsonb;
  actual_public_hash text;
  actual_owner_hash text;
  actual_restricted_hash text;
  exact_hash text;
  canonical_proof text;
  model_value text;
  input_cap integer;
  input_count integer;
  output_token_cap integer;
  output_char_cap integer;
  evidence_cap integer;
  timeout_value integer;
  input_price bigint;
  output_price bigint;
  ttl_seconds integer;
  nonce_window_seconds integer;
  nonce_max_per_wallet integer;
  nonce_max_per_fingerprint integer;
  nonce_wallet_count bigint;
  nonce_fingerprint_count bigint;
  issued_time timestamptz := statement_timestamp();
  expiry_time timestamptz;
  full_maintainer boolean;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'AI Pack generation prepare is service-only'
      using errcode = '42501';
  end if;
  if p_pack_type not in ('victim', 'exchange', 'law_enforcement')
     or p_case_public_ref !~ '^OSI-[0-9A-Z]+$'
     or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     or p_request_fingerprint_hash !~ '^[0-9a-f]{64}$'
     or p_nonce !~ '^[A-Za-z0-9_-]{32,128}$' then
    raise exception 'ai_pack_generation_binding_changed' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-ai-pack-generation-idempotency:' || p_idempotency_key, 0
    )
  );
  select run.* into existing_run
    from public.osi_v2_ai_pack_generation_runs as run
   where run.idempotency_key = p_idempotency_key
   for update;
  if found then
    if existing_run.actor_wallet is distinct from p_actor_wallet
       or existing_run.case_public_ref is distinct from p_case_public_ref
       or existing_run.pack_type is distinct from p_pack_type
       or coalesce(existing_run.maintainer_auth_uuid, '')
         is distinct from coalesce(p_maintainer_auth_uuid, '') then
      raise exception 'ai_pack_generation_binding_changed'
        using errcode = '23514';
    end if;
    select version.lifecycle_state into existing_state
      from public.ai_pack_versions as version
     where version.id = existing_run.version_id;
    return query select
      existing_run.id, existing_run.nonce, existing_run.actor_role,
      existing_run.case_id, existing_run.case_public_ref,
      existing_run.pack_id, existing_run.pack_public_ref,
      existing_run.version_id, existing_run.version_public_ref,
      existing_run.version_no, existing_run.public_manifest_hash,
      existing_run.owner_safe_manifest_hash,
      existing_run.analyst_restricted_manifest_hash,
      existing_run.payload_hash, existing_run.proof_text,
      existing_run.model, existing_run.max_input_chars,
      existing_run.input_char_count, existing_run.max_output_tokens,
      existing_run.max_output_chars, existing_run.max_evidence_items,
      existing_run.provider_timeout_ms,
      existing_run.input_price_usd_micros_per_mtok,
      existing_run.output_price_usd_micros_per_mtok,
      existing_run.evidence_manifest, existing_run.issued_at,
      existing_run.expires_at, existing_run.state,
      existing_run.receipt_id, existing_state, true;
    return;
  end if;
  if osi_private.osi_v2_ai_pack_writes_enabled() is distinct from true then
    raise exception 'ai_pack_writes_disabled' using errcode = '55000';
  end if;

  select case_item.* into case_row
    from public.cases as case_item
   where case_item.public_ref = p_case_public_ref;
  if case_row.id is null
     or case_row.visibility <> 'public'
     or case_row.stage not in (
       'open_public', 'in_review', 'ready_for_finalization',
       'resolution_proposed', 'in_challenge_window', 'resolved', 'reopened'
     ) then
    raise exception 'ai_pack_generation_case_ineligible' using errcode = '42501';
  end if;
  if p_actor_wallet is null
     or p_actor_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or p_actor_wallet = case_row.submitted_by_wallet then
    raise exception 'ai_pack_generation_actor_ineligible' using errcode = '42501';
  end if;

  full_maintainer := osi_private.osi_v2_full_maintainer_binding(
    p_actor_wallet, p_maintainer_auth_uuid
  );
  if full_maintainer then
    actual_actor_role := 'maintainer';
  else
    select analyst.* into profile
      from public.analyst_profiles as analyst
     where analyst.wallet = p_actor_wallet;
    if profile.wallet is null
       or profile.status not in ('verified_analyst', 'senior_analyst')
       or profile.verified is not true
       or profile.approved is not true
       or profile.weight_cached not between 0.50 and 3.00 then
      raise exception 'ai_pack_generation_actor_ineligible'
        using errcode = '42501';
    end if;
    if p_maintainer_auth_uuid is not null then
      raise exception 'ai_pack_generation_actor_ineligible'
        using errcode = '42501';
    end if;
    actual_actor_role := case
      when profile.status = 'senior_analyst' then 'senior'
      else 'analyst'
    end;
  end if;

  -- Prepare is intentionally unsigned because it creates the exact message to
  -- sign. It therefore must neither lock a Case/type nor permit unbounded
  -- challenge storage when a caller merely claims an eligible wallet.
  nonce_window_seconds := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_NONCE_RATE_WINDOW_SECONDS', 60, 3600
  );
  nonce_max_per_wallet := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_NONCE_MAX_PER_WALLET', 1, 100
  );
  nonce_max_per_fingerprint := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_NONCE_MAX_PER_FINGERPRINT', 1, 200
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-wallet:' || p_actor_wallet, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-fingerprint:' || p_request_fingerprint_hash, 0
    )
  );
  select count(*) into nonce_wallet_count
    from public.osi_nonces as prior
   where prior.actor_wallet = p_actor_wallet
     and prior.issued_at > issued_time
       - pg_catalog.make_interval(secs => nonce_window_seconds);
  if nonce_wallet_count >= nonce_max_per_wallet then
    raise exception 'ai_pack_prepare_wallet_rate_limited'
      using errcode = 'P0001';
  end if;
  select count(*) into nonce_fingerprint_count
    from public.osi_nonces as prior
   where prior.request_fingerprint_hash = p_request_fingerprint_hash
     and prior.issued_at > issued_time
       - pg_catalog.make_interval(secs => nonce_window_seconds);
  if nonce_fingerprint_count >= nonce_max_per_fingerprint then
    raise exception 'ai_pack_prepare_fingerprint_rate_limited'
      using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-ai-pack-generation-case-type:'
        || case_row.id::text || ':' || p_pack_type,
      0
    )
  );
  if exists (
    select 1
      from public.osi_v2_ai_pack_generation_runs as run
     where run.case_id = case_row.id
       and run.pack_type = p_pack_type
       and run.state = 'reserved'
  ) then
    raise exception 'ai_pack_generation_in_progress' using errcode = '55000';
  end if;

  select pack.* into pack_row
    from public.ai_packs as pack
   where pack.case_id = case_row.id
     and pack.pack_type = p_pack_type
   for update;
  if pack_row.id is not null then
    actual_pack_id := pack_row.id;
    actual_pack_ref := coalesce(
      pack_row.public_ref,
      'OSI-AP-' || upper(substr(replace(pack_row.id::text, '-', ''), 1, 12))
    );
    if exists (
      select 1 from public.ai_pack_versions as version
       where version.id = pack_row.current_version_id
         and version.lifecycle_state in (
           'review_required', 'supported', 'disputed'
         )
         and version.is_stale = false
         and not exists (
           select 1
             from osi_private.osi_v2_ai_pack_layer_drift(version.id) as drift
            where drift.public_layer_drift
               or drift.owner_safe_layer_drift
               or drift.analyst_restricted_layer_drift
         )
    ) then
      raise exception 'ai_pack_generation_in_progress' using errcode = '55000';
    end if;
  else
    actual_pack_id := gen_random_uuid();
    actual_pack_ref := 'OSI-AP-'
      || upper(substr(replace(actual_pack_id::text, '-', ''), 1, 12));
  end if;
  actual_version_ref := 'OSI-APV-'
    || upper(substr(replace(actual_version_id::text, '-', ''), 1, 16));
  select coalesce(max(version.version_no), 0) + 1
    into actual_version_no
    from public.ai_pack_versions as version
   where version.pack_id = actual_pack_id;

  actual_manifest := osi_private.osi_v2_ai_pack_evidence_manifest(case_row.id);
  evidence_cap := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_AI_PACK_MAX_EVIDENCE_ITEMS', 1, 40
  );
  if jsonb_array_length(actual_manifest) = 0 then
    raise exception 'ai_pack_generation_approved_evidence_required'
      using errcode = '42501';
  end if;
  if jsonb_array_length(actual_manifest) > evidence_cap then
    raise exception 'ai_pack_evidence_limit_exceeded' using errcode = '22023';
  end if;
  actual_public_hash := osi_private.osi_v2_ai_pack_manifest_hash(
    actual_manifest, array['public']::text[]
  );
  actual_owner_hash := osi_private.osi_v2_ai_pack_manifest_hash(
    actual_manifest, array['public', 'owner_safe']::text[]
  );
  actual_restricted_hash := osi_private.osi_v2_ai_pack_manifest_hash(
    actual_manifest,
    array['public', 'owner_safe', 'analyst_restricted']::text[]
  );

  select config.value into model_value
    from public.osi_config as config
   where config.key = 'OSI_V2_AI_PACK_MODEL';
  if model_value is null or model_value !~ '^claude-[a-z0-9-]{3,120}$' then
    raise exception 'ai_pack_config_invalid' using errcode = '55000';
  end if;
  input_cap := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_AI_PACK_MAX_INPUT_CHARS', 1000, 100000
  );
  input_count := osi_private.osi_v2_ai_pack_input_char_count(actual_manifest);
  if input_count > input_cap then
    raise exception 'ai_pack_input_too_large' using errcode = '22023';
  end if;
  output_token_cap := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_AI_PACK_MAX_OUTPUT_TOKENS', 64, 4000
  );
  output_char_cap := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_AI_PACK_MAX_OUTPUT_CHARS', 100, 50000
  );
  timeout_value := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_AI_PACK_PROVIDER_TIMEOUT_MS', 1000, 120000
  );
  input_price := osi_private.osi_v2_ai_pack_config_bigint(
    'OSI_V2_AI_PACK_INPUT_USD_MICROS_PER_MTOK', 0, 1000000000
  );
  output_price := osi_private.osi_v2_ai_pack_config_bigint(
    'OSI_V2_AI_PACK_OUTPUT_USD_MICROS_PER_MTOK', 0, 1000000000
  );
  ttl_seconds := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_NONCE_TTL_SECONDS', 30, 300
  );
  expiry_time := issued_time + pg_catalog.make_interval(secs => ttl_seconds);
  exact_hash := osi_private.osi_v2_ai_pack_generation_payload_hash(
    actual_generation_id, p_actor_wallet, actual_actor_role,
    case_row.id, case_row.public_ref, actual_pack_id, actual_pack_ref,
    p_pack_type, actual_version_id, actual_version_ref, actual_version_no,
    actual_public_hash, actual_owner_hash, actual_restricted_hash, model_value
  );
  canonical_proof := osi_private.osi_v2_ai_pack_proof_text(
    'PACK_SUBMITTED', actual_version_ref, p_actor_wallet, actual_actor_role,
    'generate', p_nonce, exact_hash, issued_time, expiry_time
  );

  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, 'PACK_SUBMITTED', p_actor_wallet, 'pack_version',
    actual_version_id::text, exact_hash, p_idempotency_key,
    p_request_fingerprint_hash, jsonb_build_object(
      'actor_role', actual_actor_role,
      'analyst_restricted_manifest_hash', actual_restricted_hash,
      'case_id', case_row.id,
      'case_public_ref', case_row.public_ref,
      'decision', 'generate',
      'evidence_manifest', actual_manifest,
      'generation_id', actual_generation_id,
      'input_price_usd_micros_per_mtok', input_price,
      'maintainer_auth_uuid', coalesce(p_maintainer_auth_uuid, ''),
      'max_evidence_items', evidence_cap,
      'max_input_chars', input_cap,
      'max_output_chars', output_char_cap,
      'max_output_tokens', output_token_cap,
      'model', model_value,
      'output_price_usd_micros_per_mtok', output_price,
      'owner_safe_manifest_hash', actual_owner_hash,
      'pack_id', actual_pack_id,
      'pack_public_ref', actual_pack_ref,
      'pack_type', p_pack_type,
      'proof_text', canonical_proof,
      'provider_timeout_ms', timeout_value,
      'public_manifest_hash', actual_public_hash,
      'version_id', actual_version_id,
      'version_no', actual_version_no,
      'version_public_ref', actual_version_ref
    ), issued_time, expiry_time
  );

  insert into public.osi_v2_ai_pack_generation_runs (
    id, nonce, idempotency_key, request_fingerprint_hash, state,
    actor_wallet, actor_role, maintainer_auth_uuid, case_id, case_public_ref,
    pack_type, pack_id, pack_public_ref, version_id, version_public_ref,
    version_no, evidence_manifest, public_manifest_hash,
    owner_safe_manifest_hash, analyst_restricted_manifest_hash, payload_hash,
    proof_text, model, max_input_chars, input_char_count, max_output_tokens,
    max_output_chars, max_evidence_items, provider_timeout_ms,
    input_price_usd_micros_per_mtok,
    output_price_usd_micros_per_mtok, issued_at, expires_at
  ) values (
    actual_generation_id, p_nonce, p_idempotency_key,
    p_request_fingerprint_hash, 'prepared', p_actor_wallet,
    actual_actor_role, case when full_maintainer
      then p_maintainer_auth_uuid else null end,
    case_row.id, case_row.public_ref, p_pack_type, actual_pack_id,
    actual_pack_ref, actual_version_id, actual_version_ref,
    actual_version_no, actual_manifest, actual_public_hash,
    actual_owner_hash, actual_restricted_hash, exact_hash, canonical_proof,
    model_value, input_cap, input_count, output_token_cap, output_char_cap,
    evidence_cap, timeout_value, input_price, output_price,
    issued_time, expiry_time
  );

  return query select
    actual_generation_id, p_nonce, actual_actor_role, case_row.id,
    case_row.public_ref, actual_pack_id, actual_pack_ref,
    actual_version_id, actual_version_ref, actual_version_no,
    actual_public_hash, actual_owner_hash, actual_restricted_hash,
    exact_hash, canonical_proof, model_value, input_cap, input_count,
    output_token_cap, output_char_cap, evidence_cap, timeout_value,
    input_price, output_price, actual_manifest, issued_time, expiry_time,
    'prepared'::text, null::uuid, null::text, false;
end;
$$;

create function osi_private.osi_v2_reserve_ai_pack_generation(
  p_nonce text,
  p_signature text,
  p_signed_message text,
  p_maintainer_auth_uuid text default null
)
returns table (
  generation_id uuid,
  case_public_ref text,
  pack_public_ref text,
  pack_type text,
  version_public_ref text,
  version_no integer,
  payload_hash text,
  proof_text text,
  public_manifest_hash text,
  owner_safe_manifest_hash text,
  analyst_restricted_manifest_hash text,
  model text,
  max_input_chars integer,
  input_char_count integer,
  max_output_tokens integer,
  max_output_chars integer,
  max_evidence_items integer,
  provider_timeout_ms integer,
  input_price_usd_micros_per_mtok bigint,
  output_price_usd_micros_per_mtok bigint,
  evidence_manifest jsonb,
  reserved_at timestamptz,
  generation_state text,
  receipt_id uuid,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  run_row public.osi_v2_ai_pack_generation_runs%rowtype;
  profile public.analyst_profiles%rowtype;
  live_pack public.ai_packs%rowtype;
  case_row public.cases%rowtype;
  current_manifest jsonb;
  expected_version_no integer;
  now_value timestamptz := statement_timestamp();
  window_seconds integer;
  wallet_max integer;
  fingerprint_max integer;
  cooldown_seconds integer;
  daily_quota integer;
  wallet_count bigint;
  fingerprint_count bigint;
  case_count bigint;
  daily_count bigint;
  signed_hash text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'AI Pack generation reservation is service-only'
      using errcode = '42501';
  end if;
  select run.* into run_row
    from public.osi_v2_ai_pack_generation_runs as run
   where run.nonce = p_nonce
   for update;
  if run_row.id is null then
    raise exception 'ai_pack_generation_binding_changed' using errcode = '23514';
  end if;
  signed_hash := encode(extensions.digest(
    pg_catalog.convert_to(coalesce(p_signed_message, ''), 'UTF8'),
    'sha256'
  ), 'hex');
  if run_row.state in ('reserved', 'committed') then
    if run_row.signature is distinct from p_signature
       or run_row.signed_message_hash is distinct from signed_hash
       or p_signed_message is distinct from run_row.proof_text then
      raise exception 'ai_pack_generation_binding_changed'
        using errcode = '23514';
    end if;
    if (
      run_row.actor_role = 'maintainer'
      and (
        coalesce(p_maintainer_auth_uuid, '')
          is distinct from coalesce(run_row.maintainer_auth_uuid, '')
        or osi_private.osi_v2_full_maintainer_binding(
          run_row.actor_wallet, p_maintainer_auth_uuid
        ) is distinct from true
      )
    ) or (
      run_row.actor_role <> 'maintainer'
      and p_maintainer_auth_uuid is not null
    ) then
      raise exception 'ai_pack_generation_actor_ineligible'
        using errcode = '42501';
    end if;
    return query select
      run_row.id, run_row.case_public_ref, run_row.pack_public_ref,
      run_row.pack_type, run_row.version_public_ref, run_row.version_no,
      run_row.payload_hash, run_row.proof_text, run_row.public_manifest_hash,
      run_row.owner_safe_manifest_hash,
      run_row.analyst_restricted_manifest_hash,
      run_row.model, run_row.max_input_chars, run_row.input_char_count,
      run_row.max_output_tokens, run_row.max_output_chars,
      run_row.max_evidence_items, run_row.provider_timeout_ms,
      run_row.input_price_usd_micros_per_mtok,
      run_row.output_price_usd_micros_per_mtok,
      run_row.evidence_manifest, run_row.reserved_at, run_row.state,
      run_row.receipt_id, true;
    return;
  end if;
  if run_row.state = 'failed' then
    raise exception 'ai_pack_generation_already_failed' using errcode = '55000';
  end if;
  if osi_private.osi_v2_ai_pack_writes_enabled() is distinct from true then
    raise exception 'ai_pack_writes_disabled' using errcode = '55000';
  end if;
  if now_value >= run_row.expires_at then
    raise exception 'ai_pack_generation_expired' using errcode = '22023';
  end if;
  if p_signed_message is distinct from run_row.proof_text
     or p_signature is null
     or char_length(p_signature) not between 64 and 256 then
    raise exception 'ai_pack_generation_binding_changed' using errcode = '23514';
  end if;
  if run_row.actor_role = 'maintainer' then
    if coalesce(p_maintainer_auth_uuid, '')
         is distinct from coalesce(run_row.maintainer_auth_uuid, '')
       or osi_private.osi_v2_full_maintainer_binding(
         run_row.actor_wallet, p_maintainer_auth_uuid
       ) is distinct from true then
      raise exception 'ai_pack_generation_actor_ineligible'
        using errcode = '42501';
    end if;
  else
    select analyst.* into profile
      from public.analyst_profiles as analyst
     where analyst.wallet = run_row.actor_wallet;
    if p_maintainer_auth_uuid is not null
       or profile.wallet is null
       or profile.status not in ('verified_analyst', 'senior_analyst')
       or profile.verified is not true
       or profile.approved is not true
       or (
         run_row.actor_role = 'senior'
         and profile.status <> 'senior_analyst'
       ) then
      raise exception 'ai_pack_generation_actor_ineligible'
        using errcode = '42501';
    end if;
  end if;
  select case_item.* into case_row
    from public.cases as case_item
   where case_item.id = run_row.case_id;
  if case_row.id is null
     or case_row.public_ref is distinct from run_row.case_public_ref
     or case_row.visibility <> 'public'
     or case_row.stage not in (
       'open_public', 'in_review', 'ready_for_finalization',
       'resolution_proposed', 'in_challenge_window', 'resolved', 'reopened'
     )
     or case_row.submitted_by_wallet = run_row.actor_wallet then
    raise exception 'ai_pack_generation_actor_ineligible' using errcode = '42501';
  end if;
  current_manifest := osi_private.osi_v2_ai_pack_evidence_manifest(
    run_row.case_id
  );
  if current_manifest is distinct from run_row.evidence_manifest
     or osi_private.osi_v2_ai_pack_manifest_hash(
       current_manifest, array['public']::text[]
     ) is distinct from run_row.public_manifest_hash
     or osi_private.osi_v2_ai_pack_manifest_hash(
       current_manifest, array['public', 'owner_safe']::text[]
     ) is distinct from run_row.owner_safe_manifest_hash
     or osi_private.osi_v2_ai_pack_manifest_hash(
       current_manifest,
       array['public', 'owner_safe', 'analyst_restricted']::text[]
     ) is distinct from run_row.analyst_restricted_manifest_hash then
    raise exception 'ai_pack_evidence_changed' using errcode = '40001';
  end if;
  if run_row.input_char_count > run_row.max_input_chars then
    raise exception 'ai_pack_input_too_large' using errcode = '22023';
  end if;

  window_seconds := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_AI_PACK_RATE_WINDOW_SECONDS', 60, 86400
  );
  wallet_max := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_AI_PACK_MAX_PER_WALLET', 1, 100
  );
  fingerprint_max := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_AI_PACK_MAX_PER_FINGERPRINT', 1, 500
  );
  cooldown_seconds := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_AI_PACK_CASE_COOLDOWN_SECONDS', 0, 604800
  );
  daily_quota := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_AI_PACK_DAILY_QUOTA', 1, 100000
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-ai-pack-wallet:' || run_row.actor_wallet, 0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-ai-pack-fingerprint:' || run_row.request_fingerprint_hash, 0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-ai-pack-case:' || run_row.case_id::text, 0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-ai-pack-daily:'
        || (now_value at time zone 'UTC')::date::text,
      0
    )
  );
  -- A terminated Edge isolate must not leave one Case/type permanently
  -- blocked. Once the exact Stage-5 expiry has passed, a later signed
  -- reservation closes the abandoned run without guessing provider usage;
  -- NULL telemetry on this failure state means the spend is unreconciled.
  update public.osi_v2_ai_pack_generation_runs as abandoned
     set state = 'failed',
         failure_code = 'ai_pack_generation_abandoned_after_expiry',
         failed_at = now_value
   where abandoned.case_id = run_row.case_id
     and abandoned.pack_type = run_row.pack_type
     and abandoned.state = 'reserved'
     and abandoned.expires_at <= now_value
     and abandoned.id <> run_row.id;
  if exists (
    select 1
      from public.osi_v2_ai_pack_generation_runs as concurrent_run
     where concurrent_run.case_id = run_row.case_id
       and concurrent_run.pack_type = run_row.pack_type
       and concurrent_run.state = 'reserved'
       and concurrent_run.id <> run_row.id
  ) then
    raise exception 'ai_pack_generation_in_progress' using errcode = '55000';
  end if;
  select pack.* into live_pack
    from public.ai_packs as pack
   where pack.case_id = run_row.case_id
     and pack.pack_type = run_row.pack_type
   for update;
  if live_pack.id is not null then
    if live_pack.id is distinct from run_row.pack_id then
      raise exception 'ai_pack_generation_binding_changed'
        using errcode = '40001';
    end if;
    select coalesce(max(version.version_no), 0) + 1
      into expected_version_no
      from public.ai_pack_versions as version
     where version.pack_id = live_pack.id;
    if expected_version_no is distinct from run_row.version_no then
      raise exception 'ai_pack_generation_binding_changed'
        using errcode = '40001';
    end if;
    if exists (
      select 1
        from public.ai_pack_versions as current_version
       where current_version.id = live_pack.current_version_id
         and current_version.lifecycle_state in (
           'review_required', 'supported', 'disputed'
         )
         and current_version.is_stale = false
         and not exists (
           select 1
             from osi_private.osi_v2_ai_pack_layer_drift(current_version.id)
               as drift
            where drift.public_layer_drift
               or drift.owner_safe_layer_drift
               or drift.analyst_restricted_layer_drift
         )
    ) then
      raise exception 'ai_pack_generation_in_progress' using errcode = '55000';
    end if;
  elsif exists (
    select 1
      from public.ai_pack_versions as unexpected_version
     where unexpected_version.pack_id = run_row.pack_id
  ) then
    raise exception 'ai_pack_generation_binding_changed'
      using errcode = '40001';
  end if;
  select count(*) into wallet_count
    from public.osi_v2_ai_pack_generation_runs as prior
   where prior.actor_wallet = run_row.actor_wallet
     and prior.reserved_at >= now_value
       - pg_catalog.make_interval(secs => window_seconds);
  if wallet_count >= wallet_max then
    raise exception 'ai_pack_wallet_rate_limited' using errcode = 'P0001';
  end if;
  select count(*) into fingerprint_count
    from public.osi_v2_ai_pack_generation_runs as prior
   where prior.request_fingerprint_hash = run_row.request_fingerprint_hash
     and prior.reserved_at >= now_value
       - pg_catalog.make_interval(secs => window_seconds);
  if fingerprint_count >= fingerprint_max then
    raise exception 'ai_pack_fingerprint_rate_limited' using errcode = 'P0001';
  end if;
  select count(*) into case_count
    from public.osi_v2_ai_pack_generation_runs as prior
   where prior.case_id = run_row.case_id
     and prior.reserved_at >= now_value
       - pg_catalog.make_interval(secs => cooldown_seconds);
  if cooldown_seconds > 0 and case_count > 0 then
    raise exception 'ai_pack_case_cooldown_active' using errcode = 'P0001';
  end if;
  select count(*) into daily_count
    from public.osi_v2_ai_pack_generation_runs as prior
   where prior.reserved_at >= (
     date_trunc('day', now_value at time zone 'UTC') at time zone 'UTC'
   );
  if daily_count >= daily_quota then
    raise exception 'ai_pack_daily_quota_exhausted' using errcode = 'P0001';
  end if;

  update public.osi_v2_ai_pack_generation_runs as run
     set state = 'reserved',
         signature = p_signature,
         signed_message_hash = signed_hash,
         reserved_at = now_value
   where run.id = run_row.id
     and run.state = 'prepared';
  if not found then
    raise exception 'ai_pack_generation_concurrent' using errcode = '40001';
  end if;
  return query select
    run_row.id, run_row.case_public_ref, run_row.pack_public_ref,
    run_row.pack_type, run_row.version_public_ref, run_row.version_no,
    run_row.payload_hash, run_row.proof_text, run_row.public_manifest_hash,
    run_row.owner_safe_manifest_hash,
    run_row.analyst_restricted_manifest_hash,
    run_row.model, run_row.max_input_chars, run_row.input_char_count,
    run_row.max_output_tokens, run_row.max_output_chars,
    run_row.max_evidence_items, run_row.provider_timeout_ms,
    run_row.input_price_usd_micros_per_mtok,
    run_row.output_price_usd_micros_per_mtok,
    run_row.evidence_manifest, now_value, 'reserved'::text,
    null::uuid, false;
end;
$$;

create function osi_private.osi_v2_ai_pack_safe_generated_text(p_value text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_value is not null
    and p_value !~* '\m(seed phrase|recovery phrase|mnemonic|private key|secret key|api key|access token|bearer token|client secret|password dump)\M'
    and p_value !~* '\m(stolen credentials|credential dump|malware payload|exploit kit|session hijack|phishing kit)\M'
    and p_value !~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
    and p_value !~ '\m[0-9]{13,19}\M'
$$;

create function osi_private.osi_v2_commit_ai_pack_generation(
  p_nonce text,
  p_content_public_brief text,
  p_content_owner_safe text,
  p_content_analyst_restricted text,
  p_confidence_profile jsonb,
  p_model text,
  p_provider_input_tokens integer,
  p_provider_output_tokens integer,
  p_cost_usd_micros bigint,
  p_provider_request_ref_hash text default null,
  p_occurred_at timestamptz default statement_timestamp()
)
returns table (
  generation_id uuid,
  case_public_ref text,
  pack_id uuid,
  pack_public_ref text,
  version_id uuid,
  version_public_ref text,
  version_no integer,
  receipt_id uuid,
  lifecycle_state text,
  cost_usd_micros bigint,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  run_row public.osi_v2_ai_pack_generation_runs%rowtype;
  existing_version public.ai_pack_versions%rowtype;
  pack_row public.ai_packs%rowtype;
  case_row public.cases%rowtype;
  current_manifest jsonb;
  new_receipt_id uuid := gen_random_uuid();
  artifact_hash_value text;
  expected_cost bigint;
  now_value timestamptz := statement_timestamp();
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'AI Pack generation commit is service-only'
      using errcode = '42501';
  end if;
  select run.* into run_row
    from public.osi_v2_ai_pack_generation_runs as run
   where run.nonce = p_nonce
   for update;
  if run_row.id is null then
    raise exception 'ai_pack_generation_binding_changed' using errcode = '23514';
  end if;
  if run_row.state = 'committed' then
    select version.* into existing_version
      from public.ai_pack_versions as version
     where version.id = run_row.version_id;
    if existing_version.id is null
       or existing_version.content_public_brief
         is distinct from p_content_public_brief
       or existing_version.content_owner_safe
         is distinct from p_content_owner_safe
       or existing_version.content_analyst_restricted
         is distinct from p_content_analyst_restricted
       or existing_version.confidence_profile
         is distinct from p_confidence_profile
       or existing_version.model is distinct from p_model
       or run_row.provider_input_tokens
         is distinct from p_provider_input_tokens
       or run_row.provider_output_tokens
         is distinct from p_provider_output_tokens
       or run_row.cost_usd_micros is distinct from p_cost_usd_micros
       or run_row.provider_request_ref_hash
         is distinct from p_provider_request_ref_hash then
      raise exception 'ai_pack_generation_binding_changed'
        using errcode = '23514';
    end if;
    return query select
      run_row.id, run_row.case_public_ref, run_row.pack_id,
      run_row.pack_public_ref, run_row.version_id,
      run_row.version_public_ref, run_row.version_no, run_row.receipt_id,
      existing_version.lifecycle_state, run_row.cost_usd_micros, true;
    return;
  end if;
  if osi_private.osi_v2_ai_pack_writes_enabled() is distinct from true then
    raise exception 'ai_pack_writes_disabled' using errcode = '55000';
  end if;
  if run_row.state <> 'reserved' then
    raise exception 'ai_pack_generation_not_reserved' using errcode = '55000';
  end if;
  if now_value >= run_row.expires_at then
    raise exception 'ai_pack_generation_expired' using errcode = '22023';
  end if;
  if p_model is distinct from run_row.model
     or p_provider_input_tokens is null
     or p_provider_input_tokens < 0
     or p_provider_output_tokens is null
     or p_provider_output_tokens < 0
     or p_provider_output_tokens > run_row.max_output_tokens * 3
     or p_provider_request_ref_hash is not null
       and p_provider_request_ref_hash !~ '^[0-9a-f]{64}$'
     or p_occurred_at is null
     or p_occurred_at > now_value + interval '60 seconds'
     or p_occurred_at < run_row.reserved_at - interval '60 seconds' then
    raise exception 'ai_pack_generation_binding_changed' using errcode = '23514';
  end if;
  expected_cost := ceil((
    p_provider_input_tokens::numeric
      * run_row.input_price_usd_micros_per_mtok::numeric
    + p_provider_output_tokens::numeric
      * run_row.output_price_usd_micros_per_mtok::numeric
  ) / 1000000)::bigint;
  if p_cost_usd_micros is distinct from expected_cost then
    raise exception 'ai_pack_generation_cost_mismatch' using errcode = '23514';
  end if;
  if p_content_public_brief is null
     or char_length(btrim(p_content_public_brief)) not between 20
       and run_row.max_output_chars
     or p_content_owner_safe is null
     or char_length(btrim(p_content_owner_safe)) not between 20
       and run_row.max_output_chars
     or p_content_analyst_restricted is null
     or char_length(btrim(p_content_analyst_restricted)) not between 20
       and run_row.max_output_chars
     or not osi_private.osi_v2_ai_pack_safe_generated_text(
       p_content_public_brief
     )
     or not osi_private.osi_v2_ai_pack_safe_generated_text(
       p_content_owner_safe
     )
     or not osi_private.osi_v2_ai_pack_safe_generated_text(
       p_content_analyst_restricted
     ) then
    raise exception 'ai_pack_generated_content_invalid' using errcode = '22023';
  end if;
  if p_confidence_profile is null
     or jsonb_typeof(p_confidence_profile) <> 'object'
     or not p_confidence_profile ?& array[
       'public_verifiability', 'onchain_reproducibility',
       'evidence_coverage', 'source_consistency', 'analyst_attestation'
     ]
     or p_confidence_profile - array[
       'public_verifiability', 'onchain_reproducibility',
       'evidence_coverage', 'source_consistency', 'analyst_attestation'
     ] <> '{}'::jsonb
     or jsonb_typeof(
       p_confidence_profile->'public_verifiability'
     ) <> 'number'
     or jsonb_typeof(
       p_confidence_profile->'onchain_reproducibility'
     ) <> 'number'
     or jsonb_typeof(p_confidence_profile->'evidence_coverage') <> 'number'
     or jsonb_typeof(p_confidence_profile->'source_consistency') <> 'number'
     or jsonb_typeof(p_confidence_profile->'analyst_attestation') <> 'number'
     or (p_confidence_profile->>'public_verifiability')::numeric
       not between 0 and 1
     or (p_confidence_profile->>'onchain_reproducibility')::numeric
       not between 0 and 1
     or (p_confidence_profile->>'evidence_coverage')::numeric
       not between 0 and 1
     or (p_confidence_profile->>'source_consistency')::numeric
       not between 0 and 1
     or (p_confidence_profile->>'analyst_attestation')::numeric <> 0 then
    raise exception 'ai_pack_confidence_profile_invalid'
      using errcode = '23514';
  end if;

  current_manifest := osi_private.osi_v2_ai_pack_evidence_manifest(
    run_row.case_id
  );
  if current_manifest is distinct from run_row.evidence_manifest
     or osi_private.osi_v2_ai_pack_manifest_hash(
       current_manifest, array['public']::text[]
     ) is distinct from run_row.public_manifest_hash
     or osi_private.osi_v2_ai_pack_manifest_hash(
       current_manifest, array['public', 'owner_safe']::text[]
     ) is distinct from run_row.owner_safe_manifest_hash
     or osi_private.osi_v2_ai_pack_manifest_hash(
       current_manifest,
       array['public', 'owner_safe', 'analyst_restricted']::text[]
     ) is distinct from run_row.analyst_restricted_manifest_hash then
    raise exception 'ai_pack_evidence_changed' using errcode = '40001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-ai-pack-generation-case-type:'
        || run_row.case_id::text || ':' || run_row.pack_type,
      0
    )
  );
  select case_item.* into case_row
    from public.cases as case_item
   where case_item.id = run_row.case_id;
  if case_row.id is null
     or case_row.public_ref is distinct from run_row.case_public_ref
     or case_row.visibility <> 'public'
     or case_row.stage not in (
       'open_public', 'in_review', 'ready_for_finalization',
       'resolution_proposed', 'in_challenge_window', 'resolved', 'reopened'
     )
     or case_row.submitted_by_wallet = run_row.actor_wallet then
    raise exception 'ai_pack_generation_actor_ineligible' using errcode = '42501';
  end if;
  if run_row.actor_role = 'maintainer' then
    if osi_private.osi_v2_full_maintainer_binding(
      run_row.actor_wallet, run_row.maintainer_auth_uuid
    ) is distinct from true then
      raise exception 'ai_pack_generation_actor_ineligible'
        using errcode = '42501';
    end if;
  elsif not exists (
    select 1 from public.analyst_profiles as profile
     where profile.wallet = run_row.actor_wallet
       and profile.status in ('verified_analyst', 'senior_analyst')
       and profile.verified = true and profile.approved = true
  ) then
    raise exception 'ai_pack_generation_actor_ineligible' using errcode = '42501';
  end if;

  select pack.* into pack_row
    from public.ai_packs as pack
   where pack.case_id = run_row.case_id
     and pack.pack_type = run_row.pack_type
   for update;
  if pack_row.id is null then
    insert into public.ai_packs (
      id, case_id, pack_type, public_ref, native_generation,
      created_at, updated_at
    ) values (
      run_row.pack_id, run_row.case_id, run_row.pack_type,
      run_row.pack_public_ref, true, now_value, now_value
    );
  elsif pack_row.id is distinct from run_row.pack_id then
    raise exception 'ai_pack_generation_concurrent' using errcode = '40001';
  else
    update public.ai_packs as pack
       set public_ref = coalesce(pack.public_ref, run_row.pack_public_ref),
           native_generation = true,
           updated_at = now_value
     where pack.id = run_row.pack_id
       and (
         pack.public_ref is null
         or pack.public_ref = run_row.pack_public_ref
       );
    if not found then
      raise exception 'ai_pack_generation_binding_changed'
        using errcode = '23514';
    end if;
  end if;
  if exists (
    select 1 from public.ai_pack_versions as version
     where version.pack_id = run_row.pack_id
       and version.version_no = run_row.version_no
  ) or (
    select coalesce(max(version.version_no), 0) + 1
      from public.ai_pack_versions as version
     where version.pack_id = run_row.pack_id
  ) <> run_row.version_no then
    raise exception 'ai_pack_generation_concurrent' using errcode = '40001';
  end if;

  artifact_hash_value := osi_private.osi_v2_ai_pack_hash(
    jsonb_build_object(
      'analyst_restricted_content_hash',
        encode(extensions.digest(pg_catalog.convert_to(
          p_content_analyst_restricted, 'UTF8'
        ), 'sha256'), 'hex'),
      'analyst_restricted_manifest_hash',
        run_row.analyst_restricted_manifest_hash,
      'confidence_profile', p_confidence_profile,
      'model', run_row.model,
      'owner_safe_content_hash',
        encode(extensions.digest(pg_catalog.convert_to(
          p_content_owner_safe, 'UTF8'
        ), 'sha256'), 'hex'),
      'owner_safe_manifest_hash', run_row.owner_safe_manifest_hash,
      'public_content_hash',
        encode(extensions.digest(pg_catalog.convert_to(
          p_content_public_brief, 'UTF8'
        ), 'sha256'), 'hex'),
      'public_manifest_hash', run_row.public_manifest_hash,
      'version_id', run_row.version_id,
      'version_public_ref', run_row.version_public_ref
    )
  );
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, proof_type, payload_hash,
    server_verified, occurred_at, created_at, decision_channel,
    verification_metadata
  ) values (
    new_receipt_id, 'OSI2', 'PACK_SUBMITTED', 'pack_version',
    run_row.version_id::text, run_row.version_public_ref,
    run_row.actor_wallet, run_row.actor_role, 'generate', 'system_event',
    artifact_hash_value, true, p_occurred_at, now_value, 'standard',
    jsonb_build_object(
      'authorization_payload_hash', run_row.payload_hash,
      'generation_id', run_row.id,
      'model', run_row.model
    )
  );
  insert into public.ai_pack_versions (
    id, pack_id, version_no, version_ref,
    public_evidence_manifest_hash, owner_safe_evidence_manifest_hash,
    analyst_restricted_evidence_manifest_hash,
    content_public_brief, content_owner_safe, content_analyst_restricted,
    model, created_by_wallet, created_by_role, lifecycle_state,
    confidence_profile, event_receipt_id, artifact_hash,
    created_at, updated_at
  ) values (
    run_row.version_id, run_row.pack_id, run_row.version_no,
    run_row.version_public_ref, run_row.public_manifest_hash,
    run_row.owner_safe_manifest_hash, run_row.analyst_restricted_manifest_hash,
    btrim(p_content_public_brief), btrim(p_content_owner_safe),
    btrim(p_content_analyst_restricted), run_row.model,
    run_row.actor_wallet, case when run_row.actor_role = 'maintainer'
      then 'maintainer' else 'analyst' end,
    'review_required', p_confidence_profile, new_receipt_id,
    artifact_hash_value, p_occurred_at, now_value
  );
  insert into public.ai_pack_version_evidence (
    pack_version_id, evidence_item_id, access_scope, ordinal,
    evidence_hash_at_generation, created_at
  )
  select run_row.version_id, (item.value->>'evidence_item_id')::uuid,
    item.value->>'access_scope', (item.value->>'ordinal')::integer,
    item.value->>'sha256', now_value
    from jsonb_array_elements(run_row.evidence_manifest) as item(value);
  -- A requested revision is replaced as soon as its immutable successor is
  -- committed. Approved or still-reviewable versions remain historical until
  -- the replacement itself reaches approval.
  if pack_row.current_version_id is not null then
    update public.ai_pack_versions as prior
       set lifecycle_state = 'superseded',
           superseded_by_version_id = run_row.version_id,
           updated_at = now_value
     where prior.id = pack_row.current_version_id
       and prior.pack_id = run_row.pack_id
       and prior.lifecycle_state = 'revision_requested';
  end if;
  update public.ai_packs as pack
     set current_version_id = run_row.version_id,
         updated_at = now_value
   where pack.id = run_row.pack_id;
  update public.osi_nonces as nonce
     set consumed_at = now_value,
         consumed_by_receipt_id = new_receipt_id,
         updated_at = now_value
   where nonce.nonce = run_row.nonce
     and nonce.consumed_at is null;
  if not found then
    raise exception 'ai_pack_generation_concurrent' using errcode = '40001';
  end if;
  update public.osi_v2_ai_pack_generation_runs as run
     set state = 'committed',
         provider_input_tokens = p_provider_input_tokens,
         provider_output_tokens = p_provider_output_tokens,
         cost_usd_micros = expected_cost,
         provider_request_ref_hash = p_provider_request_ref_hash,
         receipt_id = new_receipt_id,
         committed_at = now_value
   where run.id = run_row.id
     and run.state = 'reserved';
  if not found then
    raise exception 'ai_pack_generation_concurrent' using errcode = '40001';
  end if;
  return query select
    run_row.id, run_row.case_public_ref, run_row.pack_id,
    run_row.pack_public_ref, run_row.version_id, run_row.version_public_ref,
    run_row.version_no, new_receipt_id, 'review_required'::text,
    expected_cost, false;
end;
$$;

create function osi_private.osi_v2_fail_ai_pack_generation(
  p_nonce text,
  p_failure_code text,
  p_provider_input_tokens integer default 0,
  p_provider_output_tokens integer default 0,
  p_cost_usd_micros bigint default 0,
  p_provider_request_ref_hash text default null
)
returns table (
  generation_id uuid,
  generation_state text,
  failure_code text,
  cost_usd_micros bigint,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  run_row public.osi_v2_ai_pack_generation_runs%rowtype;
  expected_cost bigint;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'AI Pack generation failure telemetry is service-only'
      using errcode = '42501';
  end if;
  select run.* into run_row
    from public.osi_v2_ai_pack_generation_runs as run
   where run.nonce = p_nonce
   for update;
  if run_row.id is null then
    raise exception 'ai_pack_generation_binding_changed' using errcode = '23514';
  end if;
  if run_row.state = 'failed' then
    if run_row.failure_code is distinct from p_failure_code
       or run_row.provider_input_tokens
         is distinct from p_provider_input_tokens
       or run_row.provider_output_tokens
         is distinct from p_provider_output_tokens
       or run_row.cost_usd_micros is distinct from p_cost_usd_micros
       or run_row.provider_request_ref_hash
         is distinct from p_provider_request_ref_hash then
      raise exception 'ai_pack_generation_binding_changed'
        using errcode = '23514';
    end if;
    return query select
      run_row.id, run_row.state, run_row.failure_code,
      run_row.cost_usd_micros, true;
    return;
  end if;
  -- Only a reservation that may already have reached the provider can write
  -- failure/cost telemetry after a mid-flight flag disable. This path never
  -- creates a Pack version or event receipt.
  if run_row.state <> 'reserved' then
    raise exception 'ai_pack_generation_not_reserved' using errcode = '55000';
  end if;
  if p_failure_code is null
     or p_failure_code !~ '^[a-z][a-z0-9_:-]{0,95}$'
     or p_provider_input_tokens is null or p_provider_input_tokens < 0
     or p_provider_output_tokens is null or p_provider_output_tokens < 0
     or p_provider_output_tokens > run_row.max_output_tokens * 3
     or p_provider_request_ref_hash is not null
       and p_provider_request_ref_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'ai_pack_generation_binding_changed' using errcode = '23514';
  end if;
  expected_cost := ceil((
    p_provider_input_tokens::numeric
      * run_row.input_price_usd_micros_per_mtok::numeric
    + p_provider_output_tokens::numeric
      * run_row.output_price_usd_micros_per_mtok::numeric
  ) / 1000000)::bigint;
  if p_cost_usd_micros is distinct from expected_cost then
    raise exception 'ai_pack_generation_cost_mismatch' using errcode = '23514';
  end if;
  update public.osi_v2_ai_pack_generation_runs as run
     set state = 'failed',
         failure_code = p_failure_code,
         provider_input_tokens = p_provider_input_tokens,
         provider_output_tokens = p_provider_output_tokens,
         cost_usd_micros = expected_cost,
         provider_request_ref_hash = p_provider_request_ref_hash,
         failed_at = statement_timestamp()
   where run.id = run_row.id
     and run.state = 'reserved';
  if not found then
    raise exception 'ai_pack_generation_concurrent' using errcode = '40001';
  end if;
  return query select
    run_row.id, 'failed'::text, p_failure_code, expected_cost, false;
end;
$$;

create function osi_private.osi_v2_prepare_ai_pack_review(
  p_nonce text,
  p_actor_wallet text,
  p_version_public_ref text,
  p_decision text,
  p_reason_code text,
  p_public_rationale text,
  p_private_note text,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text,
  version_id uuid,
  version_public_ref text,
  review_id uuid,
  review_public_ref text,
  event_type text,
  actor_role text,
  payload_hash text,
  proof_text text,
  weight numeric,
  tier_snapshot text,
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
  version_row public.ai_pack_versions%rowtype;
  pack_row public.ai_packs%rowtype;
  case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype;
  drift record;
  actual_review_id uuid := gen_random_uuid();
  actual_review_ref text;
  purpose_value text;
  role_value text;
  exact_hash text;
  canonical_proof text;
  ttl_seconds integer;
  issued_time timestamptz := statement_timestamp();
  expiry_time timestamptz;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'AI Pack review prepare is service-only'
      using errcode = '42501';
  end if;
  if p_decision not in ('support', 'dispute', 'request_revision', 'approve')
     or p_reason_code is not null
       and p_reason_code !~ '^[a-z][a-z0-9_:-]{0,95}$'
     or p_public_rationale is null
     or p_public_rationale <> btrim(p_public_rationale)
     or char_length(p_public_rationale) not between 10 and 2000
     or p_private_note is not null
       and (
         p_private_note <> btrim(p_private_note)
         or char_length(p_private_note) not between 1 and 4000
       )
     or not osi_private.osi_v2_ai_pack_safe_generated_text(
       p_public_rationale
     )
     or p_private_note is not null
       and not osi_private.osi_v2_ai_pack_safe_generated_text(p_private_note)
     or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     or p_request_fingerprint_hash !~ '^[0-9a-f]{64}$'
     or p_nonce !~ '^[A-Za-z0-9_-]{32,128}$' then
    raise exception 'ai_pack_review_binding_invalid' using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-ai-pack-review-idempotency:' || p_idempotency_key, 0
    )
  );
  select nonce.* into existing
    from public.osi_nonces as nonce
   where nonce.idempotency_key = p_idempotency_key
   for update;
  if found then
    if existing.purpose not in (
         'AI_PACK_REVIEW_CAST', 'AI_PACK_REVIEW_REVISED'
       )
       or existing.actor_wallet is distinct from p_actor_wallet
       or existing.binding_context->>'version_public_ref'
         is distinct from p_version_public_ref
       or existing.binding_context->>'decision' is distinct from p_decision
       or nullif(existing.binding_context->>'reason_code', '')
         is distinct from p_reason_code
       or existing.binding_context->>'public_rationale'
         is distinct from p_public_rationale
       or nullif(existing.binding_context->>'private_note', '')
         is distinct from p_private_note then
      raise exception 'ai_pack_review_binding_invalid' using errcode = '23514';
    end if;
    return query select
      existing.nonce, existing.target_id::uuid,
      existing.binding_context->>'version_public_ref',
      (existing.binding_context->>'review_id')::uuid,
      existing.binding_context->>'review_public_ref', existing.purpose,
      existing.binding_context->>'actor_role', existing.payload_hash,
      existing.binding_context->>'proof_text',
      (existing.binding_context->>'weight')::numeric,
      existing.binding_context->>'tier_snapshot',
      existing.issued_at, existing.expires_at,
      existing.consumed_by_receipt_id, true;
    return;
  end if;
  if osi_private.osi_v2_ai_pack_review_writes_enabled()
       is distinct from true then
    raise exception 'ai_pack_review_writes_disabled' using errcode = '55000';
  end if;

  select version.* into version_row
    from public.ai_pack_versions as version
   where version.version_ref = p_version_public_ref
   for update;
  select pack.* into pack_row
    from public.ai_packs as pack
   where pack.id = version_row.pack_id;
  select case_item.* into case_row
    from public.cases as case_item
   where case_item.id = pack_row.case_id;
  select analyst.* into profile
    from public.analyst_profiles as analyst
   where analyst.wallet = p_actor_wallet;
  if version_row.id is null
     or version_row.lifecycle_state not in (
       'review_required', 'supported', 'disputed'
     )
     or profile.wallet is null
     or profile.status not in (
       'probationary_analyst', 'verified_analyst', 'senior_analyst'
     )
     or profile.verified is not true
     or profile.approved is not true
     or profile.weight_cached not between 0.50 and 3.00
     or p_actor_wallet in (
       version_row.created_by_wallet, case_row.submitted_by_wallet
     ) then
    raise exception 'ai_pack_review_actor_ineligible' using errcode = '42501';
  end if;
  select * into drift
    from osi_private.osi_v2_ai_pack_layer_drift(version_row.id);
  if version_row.is_stale
     or coalesce(drift.public_layer_drift, false)
     or coalesce(drift.owner_safe_layer_drift, false)
     or coalesce(drift.analyst_restricted_layer_drift, false) then
    raise exception 'ai_pack_review_evidence_stale' using errcode = '40001';
  end if;
  purpose_value := case when exists (
    select 1 from public.ai_pack_reviews as review
     where review.pack_version_id = version_row.id
       and review.reviewer_wallet = p_actor_wallet
  ) then 'AI_PACK_REVIEW_REVISED' else 'AI_PACK_REVIEW_CAST' end;
  role_value := case when profile.status = 'senior_analyst'
    then 'senior' else 'analyst' end;
  actual_review_ref := 'OSI-APR-'
    || upper(substr(replace(actual_review_id::text, '-', ''), 1, 16));
  exact_hash := osi_private.osi_v2_ai_pack_review_payload_hash(
    purpose_value, actual_review_id, actual_review_ref, version_row.id,
    version_row.version_ref, p_actor_wallet, p_decision, p_reason_code,
    p_public_rationale, p_private_note
  );
  ttl_seconds := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_NONCE_TTL_SECONDS', 30, 300
  );
  expiry_time := issued_time + pg_catalog.make_interval(secs => ttl_seconds);
  canonical_proof := osi_private.osi_v2_ai_pack_proof_text(
    purpose_value, version_row.version_ref, p_actor_wallet, role_value,
    p_decision, p_nonce, exact_hash, issued_time, expiry_time
  );
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, purpose_value, p_actor_wallet, 'pack_version',
    version_row.id::text, exact_hash, p_idempotency_key,
    p_request_fingerprint_hash, jsonb_build_object(
      'actor_role', role_value,
      'decision', p_decision,
      'private_note', coalesce(p_private_note, ''),
      'proof_text', canonical_proof,
      'public_rationale', p_public_rationale,
      'reason_code', coalesce(p_reason_code, ''),
      'review_id', actual_review_id,
      'review_public_ref', actual_review_ref,
      'tier_snapshot', profile.tier_code,
      'version_public_ref', version_row.version_ref,
      'weight', profile.weight_cached
    ), issued_time, expiry_time
  );
  return query select
    p_nonce, version_row.id, version_row.version_ref, actual_review_id,
    actual_review_ref, purpose_value, role_value, exact_hash,
    canonical_proof, profile.weight_cached, profile.tier_code,
    issued_time, expiry_time, null::uuid, false;
end;
$$;

create function osi_private.osi_v2_commit_ai_pack_review(
  p_nonce text,
  p_decision text,
  p_reason_code text,
  p_public_rationale text,
  p_private_note text,
  p_signature text,
  p_signed_message text
)
returns table (
  version_id uuid,
  version_public_ref text,
  review_id uuid,
  review_public_ref text,
  receipt_id uuid,
  decision text,
  weight numeric,
  lifecycle_state text,
  independent_count integer,
  total_weight numeric,
  quorum_ready boolean,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  receipt_row public.event_receipts%rowtype;
  review_row public.ai_pack_reviews%rowtype;
  prior_review public.ai_pack_reviews%rowtype;
  version_row public.ai_pack_versions%rowtype;
  pack_row public.ai_packs%rowtype;
  case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype;
  quorum record;
  drift record;
  consumed record;
  next_state text;
  exact_hash text;
  actual_review_id uuid;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'AI Pack review commit is service-only'
      using errcode = '42501';
  end if;
  select nonce.* into bound
    from public.osi_nonces as nonce
   where nonce.nonce = p_nonce
   for update;
  if bound.nonce is null
     or bound.purpose not in (
       'AI_PACK_REVIEW_CAST', 'AI_PACK_REVIEW_REVISED'
     )
     or bound.target_type <> 'pack_version' then
    raise exception 'ai_pack_review_binding_invalid' using errcode = '23514';
  end if;
  actual_review_id := (bound.binding_context->>'review_id')::uuid;
  if bound.consumed_at is not null then
    select receipt.* into receipt_row
      from public.event_receipts as receipt
     where receipt.id = bound.consumed_by_receipt_id;
    select review.* into review_row
      from public.ai_pack_reviews as review
     where review.id = actual_review_id
       and review.event_receipt_id = receipt_row.id;
    if receipt_row.id is null
       or review_row.id is null
       or receipt_row.signature is distinct from p_signature
       or p_signed_message
         is distinct from bound.binding_context->>'proof_text'
       or review_row.decision is distinct from p_decision
       or review_row.reason_code is distinct from p_reason_code
       or review_row.public_rationale is distinct from p_public_rationale
       or review_row.private_note is distinct from p_private_note then
      raise exception 'ai_pack_review_binding_invalid' using errcode = '23514';
    end if;
    select * into quorum
      from osi_private.osi_v2_ai_pack_quorum(bound.target_id::uuid);
    select version.* into version_row
      from public.ai_pack_versions as version
     where version.id = bound.target_id::uuid;
    return query select
      version_row.id, version_row.version_ref, review_row.id,
      review_row.public_ref, receipt_row.id, review_row.decision,
      review_row.weight, version_row.lifecycle_state,
      quorum.independent_count, quorum.total_weight,
      quorum.quorum_ready, true;
    return;
  end if;
  if osi_private.osi_v2_ai_pack_review_writes_enabled()
       is distinct from true then
    raise exception 'ai_pack_review_writes_disabled' using errcode = '55000';
  end if;
  if statement_timestamp() >= bound.expires_at then
    raise exception 'ai_pack_review_expired' using errcode = '22023';
  end if;
  if p_signed_message is distinct from bound.binding_context->>'proof_text'
     or p_signature is null
     or char_length(p_signature) not between 64 and 256
     or p_decision is distinct from bound.binding_context->>'decision'
     or p_reason_code is distinct from
       nullif(bound.binding_context->>'reason_code', '')
     or p_public_rationale
       is distinct from bound.binding_context->>'public_rationale'
     or p_private_note is distinct from
       nullif(bound.binding_context->>'private_note', '') then
    raise exception 'ai_pack_review_binding_invalid' using errcode = '23514';
  end if;
  select version.* into version_row
    from public.ai_pack_versions as version
   where version.id = bound.target_id::uuid
   for update;
  select pack.* into pack_row
    from public.ai_packs as pack
   where pack.id = version_row.pack_id;
  select case_item.* into case_row
    from public.cases as case_item
   where case_item.id = pack_row.case_id;
  select analyst.* into profile
    from public.analyst_profiles as analyst
   where analyst.wallet = bound.actor_wallet;
  if version_row.id is null
     or version_row.version_ref
       is distinct from bound.binding_context->>'version_public_ref'
     or version_row.lifecycle_state not in (
       'review_required', 'supported', 'disputed'
     )
     or profile.wallet is null
     or profile.status not in (
       'probationary_analyst', 'verified_analyst', 'senior_analyst'
     )
     or profile.verified is not true or profile.approved is not true
     or profile.weight_cached::text
       is distinct from (bound.binding_context->>'weight')::numeric::text
     or profile.tier_code
       is distinct from bound.binding_context->>'tier_snapshot'
     or bound.actor_wallet in (
       version_row.created_by_wallet, case_row.submitted_by_wallet
     ) then
    raise exception 'ai_pack_review_actor_ineligible' using errcode = '42501';
  end if;
  select * into drift
    from osi_private.osi_v2_ai_pack_layer_drift(version_row.id);
  if version_row.is_stale
     or coalesce(drift.public_layer_drift, false)
     or coalesce(drift.owner_safe_layer_drift, false)
     or coalesce(drift.analyst_restricted_layer_drift, false) then
    raise exception 'ai_pack_review_evidence_stale' using errcode = '40001';
  end if;
  exact_hash := osi_private.osi_v2_ai_pack_review_payload_hash(
    bound.purpose, actual_review_id,
    bound.binding_context->>'review_public_ref', version_row.id,
    version_row.version_ref, bound.actor_wallet, p_decision, p_reason_code,
    p_public_rationale, p_private_note
  );
  if exact_hash is distinct from bound.payload_hash then
    raise exception 'ai_pack_review_binding_invalid' using errcode = '23514';
  end if;
  select review.* into prior_review
    from public.ai_pack_reviews as review
   where review.pack_version_id = version_row.id
     and review.reviewer_wallet = bound.actor_wallet
     and review.is_active = true
   for update;
  if (bound.purpose = 'AI_PACK_REVIEW_CAST' and prior_review.id is not null)
     or (
       bound.purpose = 'AI_PACK_REVIEW_REVISED'
       and prior_review.id is null
     ) then
    raise exception 'ai_pack_review_history_changed' using errcode = '40001';
  end if;
  select * into consumed
    from osi_private.osi_v2_consume_signed_nonce(
      bound.nonce, p_signature, bound.binding_context->>'actor_role',
      p_decision, profile.weight_cached, p_reason_code,
      bound.binding_context->>'review_public_ref'
    );
  if prior_review.id is not null then
    update public.ai_pack_reviews as review
       set is_active = false,
           superseded_by = actual_review_id,
           updated_at = statement_timestamp()
     where review.id = prior_review.id
       and review.is_active = true;
  end if;
  insert into public.ai_pack_reviews (
    id, pack_version_id, reviewer_wallet, decision, weight, reason_code,
    is_active, superseded_by, event_receipt_id, public_ref,
    reviewer_profile_wallet, tier_snapshot, public_rationale, private_note,
    created_at, updated_at
  ) values (
    actual_review_id, version_row.id, bound.actor_wallet, p_decision,
    profile.weight_cached, p_reason_code, true, null, consumed.receipt_id,
    bound.binding_context->>'review_public_ref', profile.wallet,
    profile.tier_code, p_public_rationale, p_private_note,
    statement_timestamp(), statement_timestamp()
  );
  select * into quorum
    from osi_private.osi_v2_ai_pack_quorum(version_row.id);
  next_state := case
    when quorum.has_revision_request then 'revision_requested'
    when quorum.has_dispute then 'disputed'
    when quorum.quorum_ready then 'supported'
    else version_row.lifecycle_state
  end;
  if next_state is distinct from version_row.lifecycle_state then
    update public.ai_pack_versions as version
       set lifecycle_state = next_state,
           updated_at = statement_timestamp()
     where version.id = version_row.id;
  end if;
  return query select
    version_row.id, version_row.version_ref, actual_review_id,
    bound.binding_context->>'review_public_ref', consumed.receipt_id,
    p_decision, profile.weight_cached, next_state,
    quorum.independent_count, quorum.total_weight,
    quorum.quorum_ready, false;
end;
$$;

create function osi_private.osi_v2_prepare_ai_pack_owner_feedback(
  p_nonce text,
  p_owner_wallet text,
  p_version_public_ref text,
  p_feedback_type text,
  p_public_safe_summary text,
  p_feedback_restricted text,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text,
  version_id uuid,
  version_public_ref text,
  feedback_id uuid,
  payload_hash text,
  proof_text text,
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
  version_row public.ai_pack_versions%rowtype;
  expected_owner text;
  actual_feedback_id uuid := gen_random_uuid();
  exact_hash text;
  canonical_proof text;
  ttl_seconds integer;
  issued_time timestamptz := statement_timestamp();
  expiry_time timestamptz;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'AI Pack owner-feedback prepare is service-only'
      using errcode = '42501';
  end if;
  if p_feedback_type not in (
       'correction_request', 'clarification', 'evidence_note'
     )
     or (
       p_public_safe_summary is null
       and p_feedback_restricted is null
     )
     or p_public_safe_summary is not null
       and char_length(p_public_safe_summary) not between 1 and 4000
     or p_feedback_restricted is not null
       and char_length(p_feedback_restricted) not between 1 and 20000
     or p_public_safe_summary is not null
       and not osi_private.osi_v2_ai_pack_safe_generated_text(
         p_public_safe_summary
       )
     or p_feedback_restricted is not null
       and not osi_private.osi_v2_ai_pack_safe_generated_text(
         p_feedback_restricted
       )
     or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     or p_request_fingerprint_hash !~ '^[0-9a-f]{64}$'
     or p_nonce !~ '^[A-Za-z0-9_-]{32,128}$' then
    raise exception 'ai_pack_feedback_binding_invalid' using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-ai-pack-feedback-idempotency:' || p_idempotency_key, 0
    )
  );
  select nonce.* into existing
    from public.osi_nonces as nonce
   where nonce.idempotency_key = p_idempotency_key
   for update;
  if found then
    if existing.purpose <> 'AI_PACK_OWNER_FEEDBACK_SUBMITTED'
       or existing.actor_wallet is distinct from p_owner_wallet
       or existing.binding_context->>'version_public_ref'
         is distinct from p_version_public_ref
       or existing.binding_context->>'feedback_type'
         is distinct from p_feedback_type
       or nullif(existing.binding_context->>'public_safe_summary', '')
         is distinct from p_public_safe_summary
       or nullif(existing.binding_context->>'feedback_restricted', '')
         is distinct from p_feedback_restricted then
      raise exception 'ai_pack_feedback_binding_invalid' using errcode = '23514';
    end if;
    return query select
      existing.nonce, (existing.binding_context->>'version_id')::uuid,
      existing.binding_context->>'version_public_ref',
      (existing.binding_context->>'feedback_id')::uuid,
      existing.payload_hash, existing.binding_context->>'proof_text',
      existing.issued_at, existing.expires_at,
      existing.consumed_by_receipt_id, true;
    return;
  end if;
  if osi_private.osi_v2_ai_pack_writes_enabled()
       is distinct from true then
    raise exception 'ai_pack_writes_disabled' using errcode = '55000';
  end if;
  select version.* into version_row
    from public.ai_pack_versions as version
   where version.version_ref = p_version_public_ref;
  select case_item.submitted_by_wallet into expected_owner
    from public.ai_packs as pack
    join public.cases as case_item on case_item.id = pack.case_id
   where pack.id = version_row.pack_id;
  if version_row.id is null
     or p_owner_wallet is distinct from expected_owner then
    raise exception 'ai_pack_feedback_owner_required' using errcode = '42501';
  end if;
  exact_hash := osi_private.osi_v2_ai_pack_feedback_payload_hash(
    actual_feedback_id, version_row.id, version_row.version_ref,
    p_owner_wallet, p_feedback_type, p_public_safe_summary,
    p_feedback_restricted
  );
  ttl_seconds := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_NONCE_TTL_SECONDS', 30, 300
  );
  expiry_time := issued_time + pg_catalog.make_interval(secs => ttl_seconds);
  canonical_proof := osi_private.osi_v2_ai_pack_proof_text(
    'AI_PACK_OWNER_FEEDBACK_SUBMITTED', version_row.version_ref,
    p_owner_wallet, 'owner', 'submit_feedback', p_nonce, exact_hash,
    issued_time, expiry_time
  );
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, 'AI_PACK_OWNER_FEEDBACK_SUBMITTED', p_owner_wallet,
    'pack_owner_feedback', actual_feedback_id::text, exact_hash,
    p_idempotency_key, p_request_fingerprint_hash, jsonb_build_object(
      'actor_role', 'owner',
      'decision', 'submit_feedback',
      'feedback_id', actual_feedback_id,
      'feedback_restricted', coalesce(p_feedback_restricted, ''),
      'feedback_type', p_feedback_type,
      'proof_text', canonical_proof,
      'public_safe_summary', coalesce(p_public_safe_summary, ''),
      'version_id', version_row.id,
      'version_public_ref', version_row.version_ref
    ), issued_time, expiry_time
  );
  return query select
    p_nonce, version_row.id, version_row.version_ref, actual_feedback_id,
    exact_hash, canonical_proof, issued_time, expiry_time, null::uuid, false;
end;
$$;

create function osi_private.osi_v2_commit_ai_pack_owner_feedback(
  p_nonce text,
  p_feedback_type text,
  p_public_safe_summary text,
  p_feedback_restricted text,
  p_signature text,
  p_signed_message text
)
returns table (
  version_id uuid,
  version_public_ref text,
  feedback_id uuid,
  receipt_id uuid,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  receipt_row public.event_receipts%rowtype;
  feedback_row public.ai_pack_owner_feedback%rowtype;
  prior_feedback public.ai_pack_owner_feedback%rowtype;
  version_row public.ai_pack_versions%rowtype;
  expected_owner text;
  actual_feedback_id uuid;
  new_receipt_id uuid := gen_random_uuid();
  exact_hash text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'AI Pack owner-feedback commit is service-only'
      using errcode = '42501';
  end if;
  select nonce.* into bound
    from public.osi_nonces as nonce
   where nonce.nonce = p_nonce
   for update;
  if bound.nonce is null
     or bound.purpose <> 'AI_PACK_OWNER_FEEDBACK_SUBMITTED'
     or bound.target_type <> 'pack_owner_feedback' then
    raise exception 'ai_pack_feedback_binding_invalid' using errcode = '23514';
  end if;
  actual_feedback_id := bound.target_id::uuid;
  if bound.consumed_at is not null then
    select receipt.* into receipt_row
      from public.event_receipts as receipt
     where receipt.id = bound.consumed_by_receipt_id;
    select feedback.* into feedback_row
      from public.ai_pack_owner_feedback as feedback
     where feedback.id = actual_feedback_id
       and feedback.event_receipt_id = receipt_row.id;
    if receipt_row.id is null
       or feedback_row.id is null
       or receipt_row.signature is distinct from p_signature
       or p_signed_message
         is distinct from bound.binding_context->>'proof_text'
       or feedback_row.feedback_type is distinct from p_feedback_type
       or feedback_row.public_safe_summary
         is distinct from p_public_safe_summary
       or feedback_row.feedback_restricted
         is distinct from p_feedback_restricted then
      raise exception 'ai_pack_feedback_binding_invalid' using errcode = '23514';
    end if;
    return query select
      feedback_row.pack_version_id,
      bound.binding_context->>'version_public_ref',
      feedback_row.id, receipt_row.id, true;
    return;
  end if;
  if osi_private.osi_v2_ai_pack_writes_enabled()
       is distinct from true then
    raise exception 'ai_pack_writes_disabled' using errcode = '55000';
  end if;
  if statement_timestamp() >= bound.expires_at then
    raise exception 'ai_pack_feedback_expired' using errcode = '22023';
  end if;
  if p_signed_message is distinct from bound.binding_context->>'proof_text'
     or p_signature is null
     or char_length(p_signature) not between 64 and 256
     or p_feedback_type
       is distinct from bound.binding_context->>'feedback_type'
     or p_public_safe_summary is distinct from
       nullif(bound.binding_context->>'public_safe_summary', '')
     or p_feedback_restricted is distinct from
       nullif(bound.binding_context->>'feedback_restricted', '') then
    raise exception 'ai_pack_feedback_binding_invalid' using errcode = '23514';
  end if;
  select version.* into version_row
    from public.ai_pack_versions as version
   where version.id = (bound.binding_context->>'version_id')::uuid;
  select case_item.submitted_by_wallet into expected_owner
    from public.ai_packs as pack
    join public.cases as case_item on case_item.id = pack.case_id
   where pack.id = version_row.pack_id;
  if version_row.id is null
     or version_row.version_ref
       is distinct from bound.binding_context->>'version_public_ref'
     or bound.actor_wallet is distinct from expected_owner then
    raise exception 'ai_pack_feedback_owner_required' using errcode = '42501';
  end if;
  exact_hash := osi_private.osi_v2_ai_pack_feedback_payload_hash(
    actual_feedback_id, version_row.id, version_row.version_ref,
    bound.actor_wallet, p_feedback_type, p_public_safe_summary,
    p_feedback_restricted
  );
  if exact_hash is distinct from bound.payload_hash then
    raise exception 'ai_pack_feedback_binding_invalid' using errcode = '23514';
  end if;
  select feedback.* into prior_feedback
    from public.ai_pack_owner_feedback as feedback
   where feedback.pack_version_id = version_row.id
     and feedback.owner_wallet = bound.actor_wallet
     and feedback.is_active = true
   for update;
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, proof_type, payload_hash,
    nonce, signature, server_verified, occurred_at, created_at,
    decision_channel, verification_metadata
  ) values (
    new_receipt_id, 'OSI2', 'AI_PACK_OWNER_FEEDBACK_SUBMITTED',
    'pack_owner_feedback', actual_feedback_id::text, version_row.version_ref,
    bound.actor_wallet, 'owner', p_feedback_type,
    'wallet_signed_server_verified', bound.payload_hash, bound.nonce,
    p_signature, true, statement_timestamp(), statement_timestamp(),
    'standard', jsonb_build_object(
      'signed_message_hash', encode(extensions.digest(
        pg_catalog.convert_to(p_signed_message, 'UTF8'), 'sha256'
      ), 'hex')
    )
  );
  update public.osi_nonces as nonce
     set consumed_at = statement_timestamp(),
         consumed_by_receipt_id = new_receipt_id,
         updated_at = statement_timestamp()
   where nonce.nonce = bound.nonce
     and nonce.consumed_at is null;
  if prior_feedback.id is not null then
    update public.ai_pack_owner_feedback as feedback
       set is_active = false,
           superseded_by = actual_feedback_id,
           updated_at = statement_timestamp()
     where feedback.id = prior_feedback.id
       and feedback.is_active = true;
  end if;
  insert into public.ai_pack_owner_feedback (
    id, pack_version_id, owner_wallet, feedback_type,
    public_safe_summary, feedback_restricted, is_active, superseded_by,
    event_receipt_id, created_at, updated_at
  ) values (
    actual_feedback_id, version_row.id, bound.actor_wallet, p_feedback_type,
    p_public_safe_summary, p_feedback_restricted, true, null,
    new_receipt_id, statement_timestamp(), statement_timestamp()
  );
  return query select
    version_row.id, version_row.version_ref, actual_feedback_id,
    new_receipt_id, false;
end;
$$;

create function osi_private.osi_v2_ai_pack_approval_payload_hash(
  p_version_id uuid,
  p_version_ref text,
  p_maintainer_wallet text,
  p_independent_count integer,
  p_total_weight numeric,
  p_quorum_hash text
)
returns text
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select osi_private.osi_v2_ai_pack_hash(jsonb_build_object(
    'actor_wallet', p_maintainer_wallet,
    'decision', 'approve',
    'event_type', 'AI_PACK_APPROVED',
    'independent_count', p_independent_count,
    'quorum_hash', p_quorum_hash,
    'total_weight', p_total_weight,
    'version_id', p_version_id,
    'version_ref', p_version_ref
  ))
$$;

create function osi_private.osi_v2_prepare_ai_pack_approval(
  p_nonce text,
  p_maintainer_wallet text,
  p_version_public_ref text,
  p_idempotency_key text,
  p_request_fingerprint_hash text,
  p_maintainer_auth_uuid text
)
returns table (
  issued_nonce text,
  version_id uuid,
  version_public_ref text,
  independent_count integer,
  total_weight numeric,
  quorum_hash text,
  payload_hash text,
  proof_text text,
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
  version_row public.ai_pack_versions%rowtype;
  case_owner text;
  quorum record;
  drift record;
  exact_hash text;
  canonical_proof text;
  ttl_seconds integer;
  issued_time timestamptz := statement_timestamp();
  expiry_time timestamptz;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'AI Pack approval prepare is service-only'
      using errcode = '42501';
  end if;
  if osi_private.osi_v2_full_maintainer_binding(
    p_maintainer_wallet, p_maintainer_auth_uuid
  ) is distinct from true then
    raise exception 'ai_pack_approval_full_maintainer_required'
      using errcode = '42501';
  end if;
  if p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
     or p_request_fingerprint_hash !~ '^[0-9a-f]{64}$'
     or p_nonce !~ '^[A-Za-z0-9_-]{32,128}$' then
    raise exception 'ai_pack_approval_binding_invalid' using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'osi2-ai-pack-approval-idempotency:' || p_idempotency_key, 0
    )
  );
  select nonce.* into existing
    from public.osi_nonces as nonce
   where nonce.idempotency_key = p_idempotency_key
   for update;
  if found then
    if existing.purpose <> 'AI_PACK_APPROVED'
       or existing.actor_wallet is distinct from p_maintainer_wallet
       or existing.binding_context->>'version_public_ref'
         is distinct from p_version_public_ref
       or existing.binding_context->>'maintainer_auth_uuid'
         is distinct from p_maintainer_auth_uuid then
      raise exception 'ai_pack_approval_binding_invalid' using errcode = '23514';
    end if;
    return query select
      existing.nonce, existing.target_id::uuid,
      existing.binding_context->>'version_public_ref',
      (existing.binding_context->>'independent_count')::integer,
      (existing.binding_context->>'total_weight')::numeric,
      existing.binding_context->>'quorum_hash', existing.payload_hash,
      existing.binding_context->>'proof_text', existing.issued_at,
      existing.expires_at, existing.consumed_by_receipt_id, true;
    return;
  end if;
  if osi_private.osi_v2_ai_pack_review_writes_enabled()
       is distinct from true then
    raise exception 'ai_pack_review_writes_disabled' using errcode = '55000';
  end if;
  select version.* into version_row
    from public.ai_pack_versions as version
   where version.version_ref = p_version_public_ref
   for update;
  select case_item.submitted_by_wallet into case_owner
    from public.ai_packs as pack
    join public.cases as case_item on case_item.id = pack.case_id
   where pack.id = version_row.pack_id;
  if version_row.id is null
     or version_row.lifecycle_state <> 'supported'
     or p_maintainer_wallet in (
       version_row.created_by_wallet, case_owner
     ) then
    raise exception 'ai_pack_approval_actor_ineligible' using errcode = '42501';
  end if;
  select * into drift
    from osi_private.osi_v2_ai_pack_layer_drift(version_row.id);
  if version_row.is_stale
     or coalesce(drift.public_layer_drift, false)
     or coalesce(drift.owner_safe_layer_drift, false)
     or coalesce(drift.analyst_restricted_layer_drift, false) then
    raise exception 'ai_pack_approval_evidence_stale' using errcode = '40001';
  end if;
  select * into quorum
    from osi_private.osi_v2_ai_pack_quorum(
      version_row.id, p_maintainer_wallet
    );
  if quorum.quorum_ready is distinct from true then
    raise exception 'ai_pack_approval_quorum_not_ready' using errcode = '42501';
  end if;
  exact_hash := osi_private.osi_v2_ai_pack_approval_payload_hash(
    version_row.id, version_row.version_ref, p_maintainer_wallet,
    quorum.independent_count, quorum.total_weight, quorum.quorum_hash
  );
  ttl_seconds := osi_private.osi_v2_ai_pack_config_integer(
    'OSI_V2_NONCE_TTL_SECONDS', 30, 300
  );
  expiry_time := issued_time + pg_catalog.make_interval(secs => ttl_seconds);
  canonical_proof := osi_private.osi_v2_ai_pack_proof_text(
    'AI_PACK_APPROVED', version_row.version_ref, p_maintainer_wallet,
    'maintainer', 'approve', p_nonce, exact_hash, issued_time, expiry_time
  );
  insert into public.osi_nonces (
    nonce, purpose, actor_wallet, target_type, target_id, payload_hash,
    idempotency_key, request_fingerprint_hash, binding_context,
    issued_at, expires_at
  ) values (
    p_nonce, 'AI_PACK_APPROVED', p_maintainer_wallet, 'pack_version',
    version_row.id::text, exact_hash, p_idempotency_key,
    p_request_fingerprint_hash, jsonb_build_object(
      'actor_role', 'maintainer',
      'decision', 'approve',
      'independent_count', quorum.independent_count,
      'maintainer_auth_uuid', p_maintainer_auth_uuid,
      'proof_text', canonical_proof,
      'quorum_hash', quorum.quorum_hash,
      'total_weight', quorum.total_weight,
      'version_public_ref', version_row.version_ref
    ), issued_time, expiry_time
  );
  return query select
    p_nonce, version_row.id, version_row.version_ref,
    quorum.independent_count, quorum.total_weight, quorum.quorum_hash,
    exact_hash, canonical_proof, issued_time, expiry_time, null::uuid, false;
end;
$$;

create function osi_private.osi_v2_commit_ai_pack_approval(
  p_nonce text,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz,
  p_maintainer_auth_uuid text
)
returns table (
  version_id uuid,
  version_public_ref text,
  receipt_id uuid,
  independent_count integer,
  total_weight numeric,
  lifecycle_state text,
  idempotent_replay boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  bound public.osi_nonces%rowtype;
  receipt_row public.event_receipts%rowtype;
  version_row public.ai_pack_versions%rowtype;
  case_owner text;
  quorum record;
  drift record;
  exact_hash text;
  new_receipt_id uuid := gen_random_uuid();
  now_value timestamptz := statement_timestamp();
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'AI Pack approval commit is service-only'
      using errcode = '42501';
  end if;
  select nonce.* into bound
    from public.osi_nonces as nonce
   where nonce.nonce = p_nonce
   for update;
  if bound.nonce is null
     or bound.purpose <> 'AI_PACK_APPROVED'
     or bound.target_type <> 'pack_version' then
    raise exception 'ai_pack_approval_binding_invalid' using errcode = '23514';
  end if;
  if bound.consumed_at is not null then
    select receipt.* into receipt_row
      from public.event_receipts as receipt
     where receipt.id = bound.consumed_by_receipt_id;
    select version.* into version_row
      from public.ai_pack_versions as version
     where version.id = bound.target_id::uuid;
    if receipt_row.id is null
       or receipt_row.event_type <> 'AI_PACK_APPROVED'
       or receipt_row.tx_sig is distinct from p_tx_sig
       or receipt_row.memo_ref is distinct from p_memo_ref
       or receipt_row.decision_channel <> 'standard'
       or version_row.approval_receipt_id is distinct from receipt_row.id
       or p_maintainer_auth_uuid
         is distinct from bound.binding_context->>'maintainer_auth_uuid'
       or osi_private.osi_v2_full_maintainer_binding(
         bound.actor_wallet, p_maintainer_auth_uuid
       ) is distinct from true then
      raise exception 'ai_pack_approval_binding_invalid' using errcode = '23514';
    end if;
    return query select
      version_row.id, version_row.version_ref, receipt_row.id,
      version_row.approval_independent_count,
      version_row.approval_total_weight, version_row.lifecycle_state, true;
    return;
  end if;
  if osi_private.osi_v2_ai_pack_review_writes_enabled()
       is distinct from true then
    raise exception 'ai_pack_review_writes_disabled' using errcode = '55000';
  end if;
  if now_value >= bound.expires_at then
    raise exception 'ai_pack_approval_expired' using errcode = '22023';
  end if;
  if p_memo_ref is distinct from bound.binding_context->>'proof_text'
     or p_tx_sig is null
     or char_length(p_tx_sig) not between 64 and 96
     or p_tx_sig !~ '^[1-9A-HJ-NP-Za-km-z]+$'
     or p_occurred_at is null
     or p_occurred_at > now_value + interval '60 seconds'
     or p_occurred_at < bound.issued_at - interval '120 seconds'
     or p_maintainer_auth_uuid
       is distinct from bound.binding_context->>'maintainer_auth_uuid'
     or osi_private.osi_v2_full_maintainer_binding(
       bound.actor_wallet, p_maintainer_auth_uuid
     ) is distinct from true then
    raise exception 'ai_pack_approval_full_maintainer_required'
      using errcode = '42501';
  end if;
  select version.* into version_row
    from public.ai_pack_versions as version
   where version.id = bound.target_id::uuid
   for update;
  select case_item.submitted_by_wallet into case_owner
    from public.ai_packs as pack
    join public.cases as case_item on case_item.id = pack.case_id
   where pack.id = version_row.pack_id;
  if version_row.id is null
     or version_row.version_ref
       is distinct from bound.binding_context->>'version_public_ref'
     or version_row.lifecycle_state <> 'supported'
     or bound.actor_wallet in (
       version_row.created_by_wallet, case_owner
     ) then
    raise exception 'ai_pack_approval_actor_ineligible' using errcode = '42501';
  end if;
  select * into drift
    from osi_private.osi_v2_ai_pack_layer_drift(version_row.id);
  if version_row.is_stale
     or coalesce(drift.public_layer_drift, false)
     or coalesce(drift.owner_safe_layer_drift, false)
     or coalesce(drift.analyst_restricted_layer_drift, false) then
    raise exception 'ai_pack_approval_evidence_stale' using errcode = '40001';
  end if;
  select * into quorum
    from osi_private.osi_v2_ai_pack_quorum(
      version_row.id, bound.actor_wallet
    );
  if quorum.quorum_ready is distinct from true
     or quorum.independent_count
       is distinct from (
         bound.binding_context->>'independent_count'
       )::integer
     or quorum.total_weight
       is distinct from (bound.binding_context->>'total_weight')::numeric
     or quorum.quorum_hash
       is distinct from bound.binding_context->>'quorum_hash' then
    raise exception 'ai_pack_approval_quorum_changed' using errcode = '40001';
  end if;
  exact_hash := osi_private.osi_v2_ai_pack_approval_payload_hash(
    version_row.id, version_row.version_ref, bound.actor_wallet,
    quorum.independent_count, quorum.total_weight, quorum.quorum_hash
  );
  if exact_hash is distinct from bound.payload_hash then
    raise exception 'ai_pack_approval_binding_invalid' using errcode = '23514';
  end if;
  insert into public.event_receipts (
    id, event_version, event_type, target_type, target_id, public_ref,
    actor_wallet, actor_role, decision, proof_type, memo_ref, anchor_wallet,
    payload_hash, nonce, tx_sig, server_verified, occurred_at, created_at,
    decision_channel, verification_metadata
  ) values (
    new_receipt_id, 'OSI2', 'AI_PACK_APPROVED', 'pack_version',
    version_row.id::text, version_row.version_ref, bound.actor_wallet,
    'maintainer', 'approve', 'solana_memo', p_memo_ref,
    bound.actor_wallet, bound.payload_hash, bound.nonce, p_tx_sig,
    true, p_occurred_at, now_value, 'standard',
    jsonb_build_object(
      'independent_count', quorum.independent_count,
      'quorum_hash', quorum.quorum_hash,
      'total_weight', quorum.total_weight
    )
  );
  update public.osi_nonces as nonce
     set consumed_at = now_value,
         consumed_by_receipt_id = new_receipt_id,
         updated_at = now_value
   where nonce.nonce = bound.nonce
     and nonce.consumed_at is null;
  if not found then
    raise exception 'ai_pack_approval_concurrent' using errcode = '40001';
  end if;
  update public.ai_pack_versions as version
     set lifecycle_state = 'approved',
         approved_at = p_occurred_at,
         approved_by_wallet = bound.actor_wallet,
         approval_receipt_id = new_receipt_id,
         approval_quorum_hash = quorum.quorum_hash,
         approval_independent_count = quorum.independent_count,
         approval_total_weight = quorum.total_weight,
         updated_at = now_value
   where version.id = version_row.id
     and version.lifecycle_state = 'supported';
  if not found then
    raise exception 'ai_pack_approval_concurrent' using errcode = '40001';
  end if;
  update public.ai_pack_versions as prior
     set lifecycle_state = 'superseded',
         superseded_by_version_id = version_row.id,
         updated_at = now_value
    where prior.pack_id = version_row.pack_id
      and prior.id <> version_row.id
      and prior.lifecycle_state in (
        'draft', 'review_required', 'revision_requested', 'supported',
        'disputed', 'approved', 'rejected', 'attached_to_resolution'
      );
  return query select
    version_row.id, version_row.version_ref, new_receipt_id,
    quorum.independent_count, quorum.total_weight, 'approved'::text, false;
end;
$$;

create function osi_private.osi_v2_ai_pack_layer_drift(p_version_id uuid)
returns table (
  public_layer_drift boolean,
  owner_safe_layer_drift boolean,
  analyst_restricted_layer_drift boolean,
  current_public_manifest_hash text,
  current_owner_safe_manifest_hash text,
  current_analyst_restricted_manifest_hash text
)
language plpgsql
stable
strict
security invoker
set search_path = ''
as $$
declare
  version_row public.ai_pack_versions%rowtype;
  case_id_value uuid;
  manifest_value jsonb;
begin
  select version.* into version_row
    from public.ai_pack_versions as version
   where version.id = p_version_id;
  if version_row.id is null then
    return;
  end if;
  select pack.case_id into case_id_value
    from public.ai_packs as pack
   where pack.id = version_row.pack_id;
  if case_id_value is null then
    return;
  end if;
  manifest_value := osi_private.osi_v2_ai_pack_evidence_manifest(
    case_id_value
  );
  current_public_manifest_hash :=
    osi_private.osi_v2_ai_pack_manifest_hash(
      manifest_value, array['public']::text[]
    );
  current_owner_safe_manifest_hash :=
    osi_private.osi_v2_ai_pack_manifest_hash(
      manifest_value, array['public', 'owner_safe']::text[]
    );
  current_analyst_restricted_manifest_hash :=
    osi_private.osi_v2_ai_pack_manifest_hash(
      manifest_value,
      array['public', 'owner_safe', 'analyst_restricted']::text[]
    );
  public_layer_drift := current_public_manifest_hash
    is distinct from version_row.public_evidence_manifest_hash;
  owner_safe_layer_drift := current_owner_safe_manifest_hash
    is distinct from version_row.owner_safe_evidence_manifest_hash;
  analyst_restricted_layer_drift :=
    current_analyst_restricted_manifest_hash
    is distinct from version_row.analyst_restricted_evidence_manifest_hash;
  return next;
end;
$$;

create function osi_private.osi_v2_ai_pack_derived_confidence(
  p_version_id uuid,
  p_stored jsonb
)
returns jsonb
language plpgsql
stable
strict
security invoker
set search_path = ''
as $$
declare
  quorum record;
  min_count integer;
  min_weight numeric;
  attestation numeric := 0;
begin
  select case when config.value ~ '^[0-9]+$'
    then config.value::integer end
    into min_count
    from public.osi_config as config
   where config.key = 'OSI_V2_AI_PACK_MIN_COUNT';
  select case when config.value ~ '^[0-9]+(\.[0-9]+)?$'
    then config.value::numeric end
    into min_weight
    from public.osi_config as config
   where config.key = 'OSI_V2_AI_PACK_MIN_WEIGHT';
  if min_count is null or min_count < 2
     or min_weight is null or min_weight < 2.50 then
    return p_stored || jsonb_build_object('analyst_attestation', 0);
  end if;
  select * into quorum
    from osi_private.osi_v2_ai_pack_quorum(p_version_id);
  if quorum.independent_count >= min_count then
    attestation := least(1::numeric, quorum.total_weight / min_weight);
  end if;
  return p_stored || jsonb_build_object(
    'analyst_attestation', attestation
  );
end;
$$;

create function osi_private.osi_v2_list_public_ai_packs(
  p_case_public_ref text default null
)
returns table (
  case_public_ref text,
  pack_public_ref text,
  pack_type text,
  version_ref text,
  version_no integer,
  lifecycle_state text,
  content_public_brief text,
  confidence_profile jsonb,
  public_layer_is_stale boolean,
  public_layer_stale_at timestamptz,
  public_layer_stale_reason text,
  approval_receipt_id uuid,
  approved_at timestamptz,
  created_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Public AI Pack projection is service-only'
      using errcode = '42501';
  end if;
  if p_case_public_ref is not null
     and p_case_public_ref !~ '^OSI-[0-9A-Z]+$' then
    raise exception 'AI Pack Case reference is invalid' using errcode = '22023';
  end if;
  return query
  select
    case_item.public_ref, pack.public_ref, pack.pack_type,
    version.version_ref, version.version_no, version.lifecycle_state,
    version.content_public_brief,
    osi_private.osi_v2_ai_pack_derived_confidence(
      version.id, version.confidence_profile
    ),
    (
      version.public_layer_is_stale
      or coalesce(drift.public_layer_drift, false)
    ),
    version.public_layer_stale_at,
    case when (
      version.public_layer_is_stale
      or coalesce(drift.public_layer_drift, false)
    ) then 'current_public_evidence_manifest_drift'::text else null::text end,
    version.approval_receipt_id, version.approved_at, version.created_at
  from public.ai_packs as pack
  join public.cases as case_item
    on case_item.id = pack.case_id
   and case_item.visibility = 'public'
  join public.ai_pack_versions as version
    on version.pack_id = pack.id
   and version.lifecycle_state in ('approved', 'attached_to_resolution')
   and version.version_ref is not null
   and version.approved_at is not null
   and version.approval_receipt_id is not null
  join public.event_receipts as approval
    on approval.id = version.approval_receipt_id
   and approval.event_version = 'OSI2'
   and approval.event_type = 'AI_PACK_APPROVED'
   and approval.target_type = 'pack_version'
   and approval.target_id = version.id::text
   and approval.public_ref = version.version_ref
   and approval.actor_role = 'maintainer'
   and approval.decision = 'approve'
   and approval.proof_type = 'solana_memo'
   and approval.server_verified = true
   and approval.decision_channel = 'standard'
  left join lateral osi_private.osi_v2_ai_pack_layer_drift(version.id)
    as drift on true
  where pack.native_generation = true
    and pack.public_ref is not null
    and (
      p_case_public_ref is null
      or case_item.public_ref = p_case_public_ref
    )
  order by version.approved_at desc, pack.public_ref, version.version_no desc;
end;
$$;

create function osi_private.osi_v2_ai_pack_version_projection(
  p_version_id uuid,
  p_viewer_role text,
  p_actor_wallet text
)
returns jsonb
language plpgsql
stable
strict
security invoker
set search_path = ''
as $$
declare
  version_row public.ai_pack_versions%rowtype;
  case_owner text;
  drift record;
  quorum record;
  min_count integer;
  min_weight numeric;
  staleness_value jsonb;
  feedback_value jsonb := '[]'::jsonb;
  reviews_value jsonb := '[]'::jsonb;
  result_value jsonb;
  review_allowed boolean := false;
  finalize_allowed boolean := false;
  stale_any boolean := false;
  review_reason text;
  finalize_reason text;
begin
  select version.* into version_row
    from public.ai_pack_versions as version
   where version.id = p_version_id
     and version.version_ref is not null;
  if version_row.id is null then
    return null;
  end if;
  select case_item.submitted_by_wallet into case_owner
    from public.ai_packs as pack
    join public.cases as case_item on case_item.id = pack.case_id
   where pack.id = version_row.pack_id;
  if case_owner is null then
    return null;
  end if;
  select * into drift
    from osi_private.osi_v2_ai_pack_layer_drift(version_row.id);
  stale_any := version_row.is_stale
    or coalesce(drift.public_layer_drift, false)
    or coalesce(drift.owner_safe_layer_drift, false)
    or coalesce(drift.analyst_restricted_layer_drift, false);
  select * into quorum
    from osi_private.osi_v2_ai_pack_quorum(version_row.id);
  select case when config.value ~ '^[0-9]+$'
    then config.value::integer end into min_count
    from public.osi_config as config
   where config.key = 'OSI_V2_AI_PACK_MIN_COUNT';
  select case when config.value ~ '^[0-9]+(\.[0-9]+)?$'
    then config.value::numeric end into min_weight
    from public.osi_config as config
   where config.key = 'OSI_V2_AI_PACK_MIN_WEIGHT';

  staleness_value := jsonb_build_object(
    'public', jsonb_build_object(
      'stale', version_row.public_layer_is_stale
        or coalesce(drift.public_layer_drift, false),
      'stale_at', version_row.public_layer_stale_at,
      'reason', case when (
        version_row.public_layer_is_stale
        or coalesce(drift.public_layer_drift, false)
      ) then 'current_public_evidence_manifest_drift' else null end
    )
  );
  if p_viewer_role in ('owner', 'analyst', 'senior', 'maintainer') then
    staleness_value := staleness_value || jsonb_build_object(
      'owner_safe', jsonb_build_object(
        'stale', version_row.owner_safe_layer_is_stale
          or coalesce(drift.owner_safe_layer_drift, false),
        'stale_at', version_row.owner_safe_layer_stale_at,
        'reason', case when (
          version_row.owner_safe_layer_is_stale
          or coalesce(drift.owner_safe_layer_drift, false)
        ) then 'current_owner_safe_evidence_manifest_drift' else null end
      )
    );
    select coalesce(jsonb_agg(jsonb_build_object(
      'created_at', feedback.created_at,
      'feedback_restricted', feedback.feedback_restricted,
      'feedback_type', feedback.feedback_type,
      'is_active', feedback.is_active,
      'public_safe_summary', feedback.public_safe_summary
    ) order by feedback.created_at desc), '[]'::jsonb)
      into feedback_value
      from public.ai_pack_owner_feedback as feedback
     where feedback.pack_version_id = version_row.id
       and feedback.owner_wallet = case_owner;
  end if;
  if p_viewer_role in ('analyst', 'senior', 'maintainer') then
    staleness_value := staleness_value || jsonb_build_object(
      'analyst_restricted', jsonb_build_object(
        'stale', version_row.analyst_restricted_layer_is_stale
          or coalesce(drift.analyst_restricted_layer_drift, false),
        'stale_at', version_row.analyst_restricted_layer_stale_at,
        'reason', case when (
          version_row.analyst_restricted_layer_is_stale
          or coalesce(drift.analyst_restricted_layer_drift, false)
        ) then 'current_analyst_restricted_evidence_manifest_drift'
          else null end
      )
    );
    select coalesce(jsonb_agg(jsonb_build_object(
      'created_at', review.created_at,
      'decision', review.decision,
      'is_active', review.is_active,
      'private_note', review.private_note,
      'proof_type', receipt.proof_type,
      'public_rationale', review.public_rationale,
      'reason_code', review.reason_code,
      'review_public_ref', review.public_ref,
      'reviewer_wallet', review.reviewer_wallet,
      'tier_snapshot', review.tier_snapshot,
      'weight', review.weight
    ) order by review.created_at desc), '[]'::jsonb)
      into reviews_value
      from public.ai_pack_reviews as review
      join public.event_receipts as receipt
        on receipt.id = review.event_receipt_id
       and receipt.event_version = 'OSI2'
       and receipt.event_type in (
         'AI_PACK_REVIEW_CAST', 'AI_PACK_REVIEW_REVISED'
       )
       and receipt.target_type = 'pack_version'
       and receipt.target_id = version_row.id::text
       and receipt.actor_wallet = review.reviewer_wallet
       and receipt.proof_type = 'wallet_signed_server_verified'
       and receipt.server_verified = true
     where review.pack_version_id = version_row.id;
  end if;

  review_allowed := p_viewer_role in ('analyst', 'senior')
    and p_actor_wallet not in (version_row.created_by_wallet, case_owner)
    and not stale_any
    and version_row.lifecycle_state in (
      'review_required', 'supported', 'disputed'
    )
    and osi_private.osi_v2_ai_pack_review_writes_enabled();
  review_reason := case
    when review_allowed then null
    when not osi_private.osi_v2_ai_pack_review_writes_enabled()
      then 'AI Pack review writes are disabled.'
    when stale_any
      then 'Evidence changed after generation. Regenerate before review.'
    when p_actor_wallet in (version_row.created_by_wallet, case_owner)
      then 'Creators and Case owners cannot cast a counted review.'
    when version_row.lifecycle_state not in (
      'review_required', 'supported', 'disputed'
    ) then 'This exact version is not in a reviewable state.'
    else 'An eligible independent analyst is required.'
  end;
  finalize_allowed := p_viewer_role = 'maintainer'
    and p_actor_wallet not in (version_row.created_by_wallet, case_owner)
    and not stale_any
    and version_row.lifecycle_state = 'supported'
    and quorum.quorum_ready
    and osi_private.osi_v2_ai_pack_review_writes_enabled();
  finalize_reason := case
    when finalize_allowed then null
    when not osi_private.osi_v2_ai_pack_review_writes_enabled()
      then 'AI Pack approval writes are disabled.'
    when stale_any
      then 'Evidence changed after generation. Regenerate before approval.'
    when p_actor_wallet in (version_row.created_by_wallet, case_owner)
      then 'A creator or Case owner cannot finalize this exact version.'
    when quorum.independent_count < coalesce(min_count, 2)
      then 'Approval needs more independent analysts.'
    when quorum.total_weight < coalesce(min_weight, 2.50)
      then 'Approval needs more independent analyst weight.'
    when quorum.has_dispute or quorum.has_revision_request
      then 'Active dispute or revision review must be resolved.'
    else 'This exact version is not ready for maintainer finalization.'
  end;

  result_value := jsonb_build_object(
    'approved_at', version_row.approved_at,
    'approval_receipt_id', version_row.approval_receipt_id,
    'can_finalize', finalize_allowed,
    'can_review_exact_version', review_allowed,
    'confidence_profile',
      osi_private.osi_v2_ai_pack_derived_confidence(
        version_row.id, version_row.confidence_profile
      ),
    'content_public_brief', version_row.content_public_brief,
    'created_at', version_row.created_at,
    'created_by_role', version_row.created_by_role,
    'created_by_wallet', version_row.created_by_wallet,
    'finalize_prerequisite', finalize_reason,
    'lifecycle_state', version_row.lifecycle_state,
    'model', version_row.model,
    'quorum', jsonb_build_object(
      'approve_count', quorum.independent_count,
      'approve_weight', quorum.total_weight,
      'required_count', min_count,
      'required_weight', min_weight
    ),
    'review_prerequisite', review_reason,
    'staleness', staleness_value,
    'version_no', version_row.version_no,
    'version_ref', version_row.version_ref
  );
  if p_viewer_role in ('owner', 'analyst', 'senior', 'maintainer') then
    result_value := result_value || jsonb_build_object(
      'content_owner_safe', version_row.content_owner_safe,
      'owner_feedback', feedback_value,
      'owner_safe_evidence_manifest_hash',
        version_row.owner_safe_evidence_manifest_hash,
      'public_evidence_manifest_hash',
        version_row.public_evidence_manifest_hash
    );
  end if;
  if p_viewer_role in ('analyst', 'senior', 'maintainer') then
    result_value := result_value || jsonb_build_object(
      'analyst_restricted_evidence_manifest_hash',
        version_row.analyst_restricted_evidence_manifest_hash,
      'content_analyst_restricted',
        version_row.content_analyst_restricted,
      'reviews', reviews_value
    );
  end if;
  return result_value;
end;
$$;

create function osi_private.osi_v2_get_authorized_ai_packs(
  p_case_public_ref text,
  p_actor_wallet text,
  p_maintainer_auth_uuid text default null
)
returns table (
  viewer_role text,
  case_public_ref text,
  packs jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  case_row public.cases%rowtype;
  profile public.analyst_profiles%rowtype;
  role_value text;
  packs_value jsonb;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Authorized AI Pack projection is service-only'
      using errcode = '42501';
  end if;
  select case_item.* into case_row
    from public.cases as case_item
   where case_item.public_ref = p_case_public_ref;
  if case_row.id is null then
    raise exception 'AI Pack Case not found or denied' using errcode = '42501';
  end if;
  if p_actor_wallet = case_row.submitted_by_wallet then
    -- Case ownership is the least-privileged applicable role for that Case.
    -- An owner who is also an analyst or maintainer must not receive
    -- analyst-restricted content or private review notes on their own Case.
    role_value := 'owner';
  elsif osi_private.osi_v2_full_maintainer_binding(
    p_actor_wallet, p_maintainer_auth_uuid
  ) then
    role_value := 'maintainer';
  else
    select analyst.* into profile
      from public.analyst_profiles as analyst
     where analyst.wallet = p_actor_wallet
       and analyst.status in (
         'probationary_analyst', 'verified_analyst', 'senior_analyst'
       )
       and analyst.verified = true
       and analyst.approved = true;
    if profile.wallet is not null then
      role_value := case when profile.status = 'senior_analyst'
        then 'senior' else 'analyst' end;
    elsif case_row.visibility = 'public' then
      role_value := 'public';
    else
      raise exception 'AI Pack Case not found or denied' using errcode = '42501';
    end if;
  end if;
  if role_value <> 'maintainer'
     and p_maintainer_auth_uuid is not null
     and not (
       role_value = 'owner'
       and osi_private.osi_v2_full_maintainer_binding(
         p_actor_wallet, p_maintainer_auth_uuid
       )
     ) then
    raise exception 'AI Pack Case not found or denied' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'case_public_ref', case_row.public_ref,
    'current_version_ref', case when role_value = 'public'
      then versions.rows #>> '{0,version_ref}'
      else current_version.version_ref end,
    'pack_type', pack.pack_type,
    'public_ref', pack.public_ref,
    'versions', versions.rows
  ) order by pack.pack_type), '[]'::jsonb)
    into packs_value
    from public.ai_packs as pack
    left join public.ai_pack_versions as current_version
      on current_version.id = pack.current_version_id
    cross join lateral (
      select coalesce(jsonb_agg(
        osi_private.osi_v2_ai_pack_version_projection(
          version.id, role_value, p_actor_wallet
        ) order by version.version_no desc
      ), '[]'::jsonb) as rows
      from public.ai_pack_versions as version
      where version.pack_id = pack.id
        and version.version_ref is not null
        and (
          role_value <> 'public'
          or (
            version.lifecycle_state in ('approved', 'attached_to_resolution')
            and version.approved_at is not null
            and exists (
              select 1
                from public.event_receipts as approval
               where approval.id = version.approval_receipt_id
                 and approval.event_version = 'OSI2'
                 and approval.event_type = 'AI_PACK_APPROVED'
                  and approval.target_type = 'pack_version'
                  and approval.target_id = version.id::text
                  and approval.public_ref = version.version_ref
                  and approval.actor_role = 'maintainer'
                  and approval.decision = 'approve'
                  and approval.proof_type = 'solana_memo'
                 and approval.server_verified = true
                 and approval.decision_channel = 'standard'
            )
          )
        )
    ) as versions
   where pack.case_id = case_row.id
     and pack.native_generation = true
     and pack.public_ref is not null
     and (
       role_value <> 'public'
       or jsonb_array_length(versions.rows) > 0
     );
  return query select role_value, case_row.public_ref, packs_value;
end;
$$;

create function osi_private.osi_v2_refresh_ai_pack_staleness(
  p_version_public_ref text
)
returns table (
  version_id uuid,
  version_public_ref text,
  public_layer_is_stale boolean,
  public_layer_stale_at timestamptz,
  public_layer_stale_reason text,
  owner_safe_layer_is_stale boolean,
  owner_safe_layer_stale_at timestamptz,
  owner_safe_layer_stale_reason text,
  analyst_restricted_layer_is_stale boolean,
  analyst_restricted_layer_stale_at timestamptz,
  analyst_restricted_layer_stale_reason text,
  is_stale boolean,
  receipt_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  version_row public.ai_pack_versions%rowtype;
  drift record;
  new_public boolean;
  new_owner boolean;
  new_restricted boolean;
  any_new boolean;
  overall_stale boolean;
  new_receipt_id uuid;
  now_value timestamptz := statement_timestamp();
  reason_value text;
  exact_hash text;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'AI Pack staleness refresh is service-only'
      using errcode = '42501';
  end if;
  if osi_private.osi_v2_ai_pack_writes_enabled() is distinct from true then
    raise exception 'ai_pack_writes_disabled' using errcode = '55000';
  end if;
  select version.* into version_row
    from public.ai_pack_versions as version
   where version.version_ref = p_version_public_ref
   for update;
  if version_row.id is null then
    raise exception 'AI Pack version not found' using errcode = '22023';
  end if;
  select * into drift
    from osi_private.osi_v2_ai_pack_layer_drift(version_row.id);
  new_public := coalesce(drift.public_layer_drift, false)
    and not version_row.public_layer_is_stale;
  new_owner := coalesce(drift.owner_safe_layer_drift, false)
    and not version_row.owner_safe_layer_is_stale;
  new_restricted := coalesce(drift.analyst_restricted_layer_drift, false)
    and not version_row.analyst_restricted_layer_is_stale;
  any_new := new_public or new_owner or new_restricted;
  overall_stale := version_row.is_stale
    or coalesce(drift.public_layer_drift, false)
    or coalesce(drift.owner_safe_layer_drift, false)
    or coalesce(drift.analyst_restricted_layer_drift, false);
  reason_value := concat_ws(',',
    case when version_row.public_layer_is_stale
      or coalesce(drift.public_layer_drift, false) then 'public' end,
    case when version_row.owner_safe_layer_is_stale
      or coalesce(drift.owner_safe_layer_drift, false) then 'owner_safe' end,
    case when version_row.analyst_restricted_layer_is_stale
      or coalesce(drift.analyst_restricted_layer_drift, false)
      then 'analyst_restricted' end
  );
  if any_new then
    new_receipt_id := gen_random_uuid();
    exact_hash := osi_private.osi_v2_ai_pack_hash(jsonb_build_object(
      'event_type', 'PACK_STALE',
      'new_analyst_restricted_drift', new_restricted,
      'new_owner_safe_drift', new_owner,
      'new_public_drift', new_public,
      'version_id', version_row.id,
      'version_ref', version_row.version_ref
    ));
    insert into public.event_receipts (
      id, event_version, event_type, target_type, target_id, public_ref,
      actor_role, decision, reason_code, proof_type, payload_hash,
      server_verified, occurred_at, created_at, decision_channel
    ) values (
      new_receipt_id, 'OSI2', 'PACK_STALE', 'pack_version',
      version_row.id::text, version_row.version_ref, 'service', 'stale',
      'evidence_manifest_drift', 'system_event', exact_hash, true,
      now_value, now_value, 'standard'
    );
    update public.ai_pack_versions as version
       set public_layer_is_stale = version.public_layer_is_stale
             or coalesce(drift.public_layer_drift, false),
           public_layer_stale_at = coalesce(
             version.public_layer_stale_at,
             case when drift.public_layer_drift then now_value end
           ),
           owner_safe_layer_is_stale = version.owner_safe_layer_is_stale
             or coalesce(drift.owner_safe_layer_drift, false),
           owner_safe_layer_stale_at = coalesce(
             version.owner_safe_layer_stale_at,
             case when drift.owner_safe_layer_drift then now_value end
           ),
           analyst_restricted_layer_is_stale =
             version.analyst_restricted_layer_is_stale
             or coalesce(drift.analyst_restricted_layer_drift, false),
           analyst_restricted_layer_stale_at = coalesce(
             version.analyst_restricted_layer_stale_at,
             case when drift.analyst_restricted_layer_drift then now_value end
           ),
           is_stale = overall_stale,
           stale_at = coalesce(version.stale_at, now_value),
           stale_reason = 'evidence_manifest_drift:' || reason_value,
           first_stale_receipt_id = coalesce(
             version.first_stale_receipt_id, new_receipt_id
           ),
           updated_at = now_value
     where version.id = version_row.id;
    select version.* into version_row
      from public.ai_pack_versions as version
     where version.id = version_row.id;
  else
    new_receipt_id := version_row.first_stale_receipt_id;
  end if;
  return query select
    version_row.id, version_row.version_ref,
    version_row.public_layer_is_stale
      or coalesce(drift.public_layer_drift, false),
    version_row.public_layer_stale_at,
    case when (
      version_row.public_layer_is_stale
      or coalesce(drift.public_layer_drift, false)
    ) then 'current_public_evidence_manifest_drift' else null end,
    version_row.owner_safe_layer_is_stale
      or coalesce(drift.owner_safe_layer_drift, false),
    version_row.owner_safe_layer_stale_at,
    case when (
      version_row.owner_safe_layer_is_stale
      or coalesce(drift.owner_safe_layer_drift, false)
    ) then 'current_owner_safe_evidence_manifest_drift' else null end,
    version_row.analyst_restricted_layer_is_stale
      or coalesce(drift.analyst_restricted_layer_drift, false),
    version_row.analyst_restricted_layer_stale_at,
    case when (
      version_row.analyst_restricted_layer_is_stale
      or coalesce(drift.analyst_restricted_layer_drift, false)
    ) then 'current_analyst_restricted_evidence_manifest_drift'
      else null end,
    overall_stale, new_receipt_id;
end;
$$;

-- Public-schema RPC façades are PostgREST-discoverable but remain
-- SECURITY INVOKER and executable only by service_role.
create function public.osi_v2_prepare_ai_pack_generation(
  p_nonce text,
  p_actor_wallet text,
  p_case_public_ref text,
  p_pack_type text,
  p_idempotency_key text,
  p_request_fingerprint_hash text,
  p_maintainer_auth_uuid text default null
)
returns table (
  generation_id uuid, issued_nonce text, actor_role text, case_id uuid,
  case_public_ref text, pack_id uuid, pack_public_ref text, version_id uuid,
  version_public_ref text, version_no integer, public_manifest_hash text,
  owner_safe_manifest_hash text, analyst_restricted_manifest_hash text,
  payload_hash text, proof_text text, model text, max_input_chars integer,
  input_char_count integer, max_output_tokens integer,
  max_output_chars integer, max_evidence_items integer,
  provider_timeout_ms integer, input_price_usd_micros_per_mtok bigint,
  output_price_usd_micros_per_mtok bigint, evidence_manifest jsonb,
  issued_at timestamptz, expires_at timestamptz, generation_state text,
  receipt_id uuid, lifecycle_state text, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_prepare_ai_pack_generation(
    p_nonce, p_actor_wallet, p_case_public_ref, p_pack_type,
    p_idempotency_key, p_request_fingerprint_hash, p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_reserve_ai_pack_generation(
  p_nonce text,
  p_signature text,
  p_signed_message text,
  p_maintainer_auth_uuid text default null
)
returns table (
  generation_id uuid, case_public_ref text, pack_public_ref text,
  pack_type text, version_public_ref text, version_no integer,
  payload_hash text, proof_text text, public_manifest_hash text,
  owner_safe_manifest_hash text, analyst_restricted_manifest_hash text,
  model text, max_input_chars integer, input_char_count integer,
  max_output_tokens integer, max_output_chars integer,
  max_evidence_items integer, provider_timeout_ms integer,
  input_price_usd_micros_per_mtok bigint,
  output_price_usd_micros_per_mtok bigint, evidence_manifest jsonb,
  reserved_at timestamptz, generation_state text, receipt_id uuid,
  idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_reserve_ai_pack_generation(
    p_nonce, p_signature, p_signed_message, p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_commit_ai_pack_generation(
  p_nonce text,
  p_content_public_brief text,
  p_content_owner_safe text,
  p_content_analyst_restricted text,
  p_confidence_profile jsonb,
  p_model text,
  p_provider_input_tokens integer,
  p_provider_output_tokens integer,
  p_cost_usd_micros bigint,
  p_provider_request_ref_hash text default null,
  p_occurred_at timestamptz default statement_timestamp()
)
returns table (
  generation_id uuid, case_public_ref text, pack_id uuid,
  pack_public_ref text, version_id uuid, version_public_ref text,
  version_no integer, receipt_id uuid, lifecycle_state text,
  cost_usd_micros bigint, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_ai_pack_generation(
    p_nonce, p_content_public_brief, p_content_owner_safe,
    p_content_analyst_restricted, p_confidence_profile, p_model,
    p_provider_input_tokens, p_provider_output_tokens, p_cost_usd_micros,
    p_provider_request_ref_hash, p_occurred_at
  )
$$;

create function public.osi_v2_fail_ai_pack_generation(
  p_nonce text,
  p_failure_code text,
  p_provider_input_tokens integer default 0,
  p_provider_output_tokens integer default 0,
  p_cost_usd_micros bigint default 0,
  p_provider_request_ref_hash text default null
)
returns table (
  generation_id uuid, generation_state text, failure_code text,
  cost_usd_micros bigint, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_fail_ai_pack_generation(
    p_nonce, p_failure_code, p_provider_input_tokens,
    p_provider_output_tokens, p_cost_usd_micros,
    p_provider_request_ref_hash
  )
$$;

create function public.osi_v2_prepare_ai_pack_review(
  p_nonce text,
  p_actor_wallet text,
  p_version_public_ref text,
  p_decision text,
  p_reason_code text,
  p_public_rationale text,
  p_private_note text,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, version_id uuid, version_public_ref text,
  review_id uuid, review_public_ref text, event_type text,
  actor_role text, payload_hash text, proof_text text, weight numeric,
  tier_snapshot text, issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_prepare_ai_pack_review(
    p_nonce, p_actor_wallet, p_version_public_ref, p_decision,
    p_reason_code, p_public_rationale, p_private_note, p_idempotency_key,
    p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_commit_ai_pack_review(
  p_nonce text,
  p_decision text,
  p_reason_code text,
  p_public_rationale text,
  p_private_note text,
  p_signature text,
  p_signed_message text
)
returns table (
  version_id uuid, version_public_ref text, review_id uuid,
  review_public_ref text, receipt_id uuid, decision text, weight numeric,
  lifecycle_state text, independent_count integer, total_weight numeric,
  quorum_ready boolean, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_ai_pack_review(
    p_nonce, p_decision, p_reason_code, p_public_rationale,
    p_private_note, p_signature, p_signed_message
  )
$$;

create function public.osi_v2_prepare_ai_pack_owner_feedback(
  p_nonce text,
  p_owner_wallet text,
  p_version_public_ref text,
  p_feedback_type text,
  p_public_safe_summary text,
  p_feedback_restricted text,
  p_idempotency_key text,
  p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, version_id uuid, version_public_ref text,
  feedback_id uuid, payload_hash text, proof_text text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_prepare_ai_pack_owner_feedback(
    p_nonce, p_owner_wallet, p_version_public_ref, p_feedback_type,
    p_public_safe_summary, p_feedback_restricted, p_idempotency_key,
    p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_commit_ai_pack_owner_feedback(
  p_nonce text,
  p_feedback_type text,
  p_public_safe_summary text,
  p_feedback_restricted text,
  p_signature text,
  p_signed_message text
)
returns table (
  version_id uuid, version_public_ref text, feedback_id uuid,
  receipt_id uuid, idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_ai_pack_owner_feedback(
    p_nonce, p_feedback_type, p_public_safe_summary,
    p_feedback_restricted, p_signature, p_signed_message
  )
$$;

create function public.osi_v2_prepare_ai_pack_approval(
  p_nonce text,
  p_maintainer_wallet text,
  p_version_public_ref text,
  p_idempotency_key text,
  p_request_fingerprint_hash text,
  p_maintainer_auth_uuid text
)
returns table (
  issued_nonce text, version_id uuid, version_public_ref text,
  independent_count integer, total_weight numeric, quorum_hash text,
  payload_hash text, proof_text text, issued_at timestamptz,
  expires_at timestamptz, consumed_receipt_id uuid,
  idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_prepare_ai_pack_approval(
    p_nonce, p_maintainer_wallet, p_version_public_ref, p_idempotency_key,
    p_request_fingerprint_hash, p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_commit_ai_pack_approval(
  p_nonce text,
  p_tx_sig text,
  p_memo_ref text,
  p_occurred_at timestamptz,
  p_maintainer_auth_uuid text
)
returns table (
  version_id uuid, version_public_ref text, receipt_id uuid,
  independent_count integer, total_weight numeric, lifecycle_state text,
  idempotent_replay boolean
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_commit_ai_pack_approval(
    p_nonce, p_tx_sig, p_memo_ref, p_occurred_at,
    p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_list_public_ai_packs(
  p_case_public_ref text default null
)
returns table (
  case_public_ref text, pack_public_ref text, pack_type text,
  version_ref text, version_no integer, lifecycle_state text,
  content_public_brief text, confidence_profile jsonb,
  public_layer_is_stale boolean, public_layer_stale_at timestamptz,
  public_layer_stale_reason text, approval_receipt_id uuid,
  approved_at timestamptz, created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_list_public_ai_packs(
    p_case_public_ref
  )
$$;

create function public.osi_v2_get_authorized_ai_packs(
  p_case_public_ref text,
  p_actor_wallet text,
  p_maintainer_auth_uuid text default null
)
returns table (
  viewer_role text, case_public_ref text, packs jsonb
)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_get_authorized_ai_packs(
    p_case_public_ref, p_actor_wallet, p_maintainer_auth_uuid
  )
$$;

create function public.osi_v2_refresh_ai_pack_staleness(
  p_version_public_ref text
)
returns table (
  version_id uuid, version_public_ref text,
  public_layer_is_stale boolean, public_layer_stale_at timestamptz,
  public_layer_stale_reason text, owner_safe_layer_is_stale boolean,
  owner_safe_layer_stale_at timestamptz,
  owner_safe_layer_stale_reason text,
  analyst_restricted_layer_is_stale boolean,
  analyst_restricted_layer_stale_at timestamptz,
  analyst_restricted_layer_stale_reason text,
  is_stale boolean, receipt_id uuid
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_refresh_ai_pack_staleness(
    p_version_public_ref
  )
$$;

do $$
declare
  function_row record;
begin
  for function_row in
    select procedure.oid::regprocedure as signature
      from pg_proc as procedure
      join pg_namespace as namespace
        on namespace.oid = procedure.pronamespace
     where namespace.nspname in ('public', 'osi_private')
       and (
         procedure.proname like 'osi_v2%ai_pack%'
         or procedure.proname = 'osi_v2_canonical_jsonb_text'
       )
  loop
    execute format(
      'revoke all privileges on function %s from public, anon, authenticated',
      function_row.signature
    );
    execute format(
      'grant execute on function %s to service_role',
      function_row.signature
    );
  end loop;
end;
$$;

revoke all privileges on table public.ai_packs
  from anon, authenticated;
revoke all privileges on table public.ai_pack_versions
  from anon, authenticated;
revoke all privileges on table public.ai_pack_version_evidence
  from anon, authenticated;
revoke all privileges on table public.ai_pack_reviews
  from anon, authenticated;
revoke all privileges on table public.ai_pack_owner_feedback
  from anon, authenticated;

comment on function public.osi_v2_prepare_ai_pack_generation(
  text, text, text, text, text, text, text
) is
  'Reserves exact immutable AI Pack IDs, scope-classified evidence, budget snapshots and a short wallet authorization. Verified analysts/seniors or a full maintainer only; the Case owner is excluded.';
comment on function public.osi_v2_reserve_ai_pack_generation(
  text, text, text, text
) is
  'Atomically reserves one provider attempt after Edge Ed25519 verification and enforces wallet, fingerprint, Case cooldown and UTC-day quota gates.';
comment on function public.osi_v2_commit_ai_pack_generation(
  text, text, text, text, jsonb, text, integer, integer, bigint, text,
  timestamptz
) is
  'Atomically appends the immutable three-layer Pack version, exact manifest, system receipt and verified provider telemetry.';
comment on function public.osi_v2_prepare_ai_pack_approval(
  text, text, text, text, text, text
) is
  'Binds a standard-channel class-A Memo to an exact real analyst quorum. Maintainer bootstrap is never accepted.';
comment on function public.osi_v2_list_public_ai_packs(text) is
  'Minimized approval-receipt-validated public projection. Restricted evidence drift is neither selected nor exposed.';

commit;
