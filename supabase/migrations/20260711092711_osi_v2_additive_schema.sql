-- OSI V2 additive schema foundation.
--
-- Scope:
--   * 31 new V2 domain tables (osi_config is intentionally reused)
--   * 3 service-only security/migration infrastructure tables
--   * no V1 rename, drop, rewrite, backfill, or write cutover
--
-- Closed vocabularies are CHECK-constrained where the blueprint is explicit.
-- Fields whose vocabulary is intentionally server/config driven use structured
-- text checks instead of inventing an irreversible PostgreSQL enum.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create table public.event_receipts (
  id uuid primary key default gen_random_uuid(),
  event_version text not null
    constraint event_receipts_event_version_check
    check (event_version in ('OSI2', 'OSI1', 'legacy')),
  event_type text not null
    constraint event_receipts_event_type_format_check
    check (event_type ~ '^[A-Z][A-Z0-9_]{1,95}$'),
  target_type text not null
    constraint event_receipts_target_type_check
    check (target_type in (
      'case',
      'report_version',
      'wire_version',
      'resolution',
      'challenge',
      'pack_version',
      'pack_owner_feedback',
      'analyst',
      'application_version',
      'reward',
      'support',
      'config'
    )),
  target_id text
    constraint event_receipts_target_id_length_check
    check (target_id is null or char_length(target_id) between 1 and 256),
  public_ref text
    constraint event_receipts_public_ref_length_check
    check (public_ref is null or char_length(public_ref) between 1 and 64),
  actor_wallet text
    constraint event_receipts_actor_wallet_format_check
    check (
      actor_wallet is null
      or (
        char_length(actor_wallet) between 32 and 44
        and actor_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
      )
    ),
  actor_role text not null
    constraint event_receipts_actor_role_check
    check (actor_role in ('owner', 'wallet', 'analyst', 'senior', 'maintainer', 'service')),
  decision text
    constraint event_receipts_decision_format_check
    check (decision is null or decision ~ '^[a-z][a-z0-9_]{0,63}$'),
  weight numeric(4,2)
    constraint event_receipts_weight_check
    check (weight is null or weight between 0.50 and 3.00),
  reason_code text
    constraint event_receipts_reason_code_format_check
    check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'),
  proof_type text not null
    constraint event_receipts_proof_type_check
    check (proof_type in (
      'solana_memo',
      'wallet_signed_server_verified',
      'system_event',
      'legacy_imported'
    )),
  memo_ref text
    constraint event_receipts_memo_ref_length_check
    check (memo_ref is null or char_length(memo_ref) <= 512),
  anchor_wallet text
    constraint event_receipts_anchor_wallet_format_check
    check (
      anchor_wallet is null
      or (
        char_length(anchor_wallet) between 32 and 44
        and anchor_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
      )
    ),
  payload_hash text not null
    constraint event_receipts_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  nonce text
    constraint event_receipts_nonce_format_check
    check (nonce is null or nonce ~ '^[A-Za-z0-9_-]{32,128}$'),
  tx_sig text
    constraint event_receipts_tx_sig_format_check
    check (
      tx_sig is null
      or (
        char_length(tx_sig) between 64 and 96
        and tx_sig ~ '^[1-9A-HJ-NP-Za-km-z]+$'
      )
    ),
  signature text
    constraint event_receipts_signature_length_check
    check (signature is null or char_length(signature) between 64 and 256),
  server_verified boolean not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint event_receipts_actor_presence_check
    check (actor_role = 'service' or actor_wallet is not null),
  constraint event_receipts_legacy_truthfulness_check
    check (
      (
        event_version in ('OSI1', 'legacy')
        and proof_type = 'legacy_imported'
        and server_verified = false
      )
      or (
        event_version = 'OSI2'
        and proof_type <> 'legacy_imported'
        and server_verified = true
      )
    ),
  constraint event_receipts_transport_material_check
    check (
      (
        proof_type = 'solana_memo'
        and tx_sig is not null
        and anchor_wallet is not null
      )
      or (
        proof_type = 'wallet_signed_server_verified'
        and nonce is not null
        and signature is not null
        and anchor_wallet is null
      )
      or (
        proof_type in ('system_event', 'legacy_imported')
        and anchor_wallet is null
      )
    )
);

create unique index event_receipts_native_nonce_uidx
  on public.event_receipts (nonce)
  where event_version = 'OSI2' and nonce is not null;
create index event_receipts_target_idx
  on public.event_receipts (target_type, target_id);
create index event_receipts_actor_idx
  on public.event_receipts (actor_wallet, occurred_at desc);
create index event_receipts_event_type_idx
  on public.event_receipts (event_type, occurred_at desc);
create index event_receipts_proof_type_idx
  on public.event_receipts (proof_type, occurred_at desc);

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  public_ref text not null unique
    constraint cases_public_ref_check
    check (
      char_length(public_ref) between 10 and 24
      and public_ref ~ '^OSI-[0-9A-Z]+$'
    ),
  title text not null
    constraint cases_title_length_check
    check (char_length(btrim(title)) between 1 and 200),
  category text not null
    constraint cases_category_format_check
    check (category ~ '^[a-z][a-z0-9_]{1,63}$'),
  summary_public text not null
    constraint cases_summary_public_length_check
    check (char_length(btrim(summary_public)) between 1 and 4000),
  submitted_by_wallet text not null
    constraint cases_submitter_wallet_check
    check (
      char_length(submitted_by_wallet) between 32 and 44
      and submitted_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  stage text not null default 'draft'
    constraint cases_stage_check
    check (stage in (
      'draft',
      'submitted',
      'initial_review',
      'open_public',
      'in_review',
      'ready_for_finalization',
      'resolution_proposed',
      'in_challenge_window',
      'resolved',
      'sealed',
      'archived',
      'withdrawn',
      'initial_rejected',
      'safety_blocked',
      'reopened',
      'halted'
    )),
  visibility text not null default 'private'
    constraint cases_visibility_check
    check (visibility in ('private', 'public')),
  risk_tier text not null default 'standard'
    constraint cases_risk_tier_check
    check (risk_tier in ('low', 'standard', 'high')),
  subject_refs jsonb not null default '[]'::jsonb
    constraint cases_subject_refs_shape_check
    check (jsonb_typeof(subject_refs) in ('array', 'object')),
  sealed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cases_public_visibility_stage_check
    check (
      visibility = 'private'
      or stage in (
        'open_public',
        'in_review',
        'ready_for_finalization',
        'resolution_proposed',
        'in_challenge_window',
        'resolved',
        'sealed',
        'archived',
        'reopened',
        'halted'
      )
    ),
  constraint cases_sealed_timestamp_check
    check (sealed_at is null or sealed_at >= created_at),
  constraint cases_archived_timestamp_check
    check (
      archived_at is null
      or (
        sealed_at is not null
        and archived_at >= sealed_at
      )
    )
);

create index cases_stage_idx on public.cases (stage);
create index cases_visibility_stage_idx on public.cases (visibility, stage);
create index cases_submitter_idx on public.cases (submitted_by_wallet);
create index cases_category_idx on public.cases (category);
create index cases_risk_tier_idx on public.cases (risk_tier);
create index cases_subject_refs_gin_idx on public.cases using gin (subject_refs);

create table public.case_reports (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.cases (id) on delete restrict,
  author_wallet text not null
    constraint case_reports_author_wallet_check
    check (
      char_length(author_wallet) between 32 and 44
      and author_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  current_version_id uuid,
  current_published_version_id uuid,
  status text not null default 'active'
    constraint case_reports_status_format_check
    check (status ~ '^[a-z][a-z0-9_]{0,31}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index case_reports_case_status_idx
  on public.case_reports (case_id, status);
create index case_reports_author_idx
  on public.case_reports (author_wallet);

create table public.case_report_versions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null
    references public.case_reports (id) on delete restrict,
  version_no integer not null
    constraint case_report_versions_version_no_check
    check (version_no >= 1),
  created_by_wallet text not null
    constraint case_report_versions_creator_wallet_check
    check (
      char_length(created_by_wallet) between 32 and 44
      and created_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  body_private text not null
    constraint case_report_versions_body_length_check
    check (char_length(btrim(body_private)) between 1 and 100000),
  content_public_safe text
    constraint case_report_versions_public_content_length_check
    check (content_public_safe is null or char_length(content_public_safe) <= 50000),
  evidence_snapshot_hash text not null
    constraint case_report_versions_evidence_hash_check
    check (evidence_snapshot_hash ~ '^[0-9a-f]{64}$'),
  supersedes_version_id uuid,
  superseded_by_version_id uuid,
  revision_reason_code text
    constraint case_report_versions_revision_reason_check
    check (
      revision_reason_code is null
      or revision_reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'
    ),
  lifecycle_state text not null default 'draft'
    constraint case_report_versions_lifecycle_check
    check (lifecycle_state in (
      'draft',
      'submitted',
      'in_review',
      'published',
      'rejected',
      'revision_requested',
      'superseded'
    )),
  published_at timestamptz,
  superseded_at timestamptz,
  publication_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint case_report_versions_report_version_unique
    unique (report_id, version_no),
  constraint case_report_versions_report_id_id_unique
    unique (report_id, id),
  constraint case_report_versions_supersedes_fk
    foreign key (report_id, supersedes_version_id)
    references public.case_report_versions (report_id, id)
    on delete restrict,
  constraint case_report_versions_superseded_by_fk
    foreign key (report_id, superseded_by_version_id)
    references public.case_report_versions (report_id, id)
    on delete restrict,
  constraint case_report_versions_distinct_links_check
    check (
      (supersedes_version_id is null or supersedes_version_id <> id)
      and (superseded_by_version_id is null or superseded_by_version_id <> id)
    ),
  constraint case_report_versions_publication_state_check
    check (
      (
        lifecycle_state in ('published', 'superseded')
        and published_at is not null
        and publication_receipt_id is not null
        and content_public_safe is not null
      )
      or (
        lifecycle_state not in ('published', 'superseded')
        and published_at is null
        and publication_receipt_id is null
      )
    ),
  constraint case_report_versions_supersession_state_check
    check (
      (
        lifecycle_state = 'superseded'
        and superseded_at is not null
        and superseded_by_version_id is not null
      )
      or (
        lifecycle_state <> 'superseded'
        and superseded_at is null
        and superseded_by_version_id is null
      )
    )
);

create index case_report_versions_report_state_idx
  on public.case_report_versions (report_id, lifecycle_state);
create index case_report_versions_event_receipt_idx
  on public.case_report_versions (event_receipt_id);
create index case_report_versions_publication_receipt_idx
  on public.case_report_versions (publication_receipt_id)
  where publication_receipt_id is not null;

create table public.wire_reports (
  id uuid primary key default gen_random_uuid(),
  author_wallet text not null
    constraint wire_reports_author_wallet_check
    check (
      char_length(author_wallet) between 32 and 44
      and author_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  current_version_id uuid,
  current_published_version_id uuid,
  promoted_to_case_id uuid
    references public.cases (id) on delete restrict,
  status text not null default 'active'
    constraint wire_reports_status_format_check
    check (status ~ '^[a-z][a-z0-9_]{0,31}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index wire_reports_author_idx on public.wire_reports (author_wallet);
create index wire_reports_status_idx on public.wire_reports (status);
create index wire_reports_promoted_case_idx
  on public.wire_reports (promoted_to_case_id)
  where promoted_to_case_id is not null;

create table public.wire_report_versions (
  id uuid primary key default gen_random_uuid(),
  wire_report_id uuid not null
    references public.wire_reports (id) on delete restrict,
  version_no integer not null
    constraint wire_report_versions_version_no_check
    check (version_no >= 1),
  created_by_wallet text not null
    constraint wire_report_versions_creator_wallet_check
    check (
      char_length(created_by_wallet) between 32 and 44
      and created_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  body_private text not null
    constraint wire_report_versions_body_length_check
    check (char_length(btrim(body_private)) between 1 and 100000),
  content_public_safe text
    constraint wire_report_versions_public_content_length_check
    check (content_public_safe is null or char_length(content_public_safe) <= 50000),
  evidence_snapshot_hash text not null
    constraint wire_report_versions_evidence_hash_check
    check (evidence_snapshot_hash ~ '^[0-9a-f]{64}$'),
  supersedes_version_id uuid,
  superseded_by_version_id uuid,
  revision_reason_code text
    constraint wire_report_versions_revision_reason_check
    check (
      revision_reason_code is null
      or revision_reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'
    ),
  lifecycle_state text not null default 'draft'
    constraint wire_report_versions_lifecycle_check
    check (lifecycle_state in (
      'draft',
      'submitted',
      'in_review',
      'published',
      'rejected',
      'revision_requested',
      'superseded'
    )),
  published_at timestamptz,
  superseded_at timestamptz,
  publication_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wire_report_versions_report_version_unique
    unique (wire_report_id, version_no),
  constraint wire_report_versions_report_id_id_unique
    unique (wire_report_id, id),
  constraint wire_report_versions_supersedes_fk
    foreign key (wire_report_id, supersedes_version_id)
    references public.wire_report_versions (wire_report_id, id)
    on delete restrict,
  constraint wire_report_versions_superseded_by_fk
    foreign key (wire_report_id, superseded_by_version_id)
    references public.wire_report_versions (wire_report_id, id)
    on delete restrict,
  constraint wire_report_versions_distinct_links_check
    check (
      (supersedes_version_id is null or supersedes_version_id <> id)
      and (superseded_by_version_id is null or superseded_by_version_id <> id)
    ),
  constraint wire_report_versions_publication_state_check
    check (
      (
        lifecycle_state in ('published', 'superseded')
        and published_at is not null
        and publication_receipt_id is not null
        and content_public_safe is not null
      )
      or (
        lifecycle_state not in ('published', 'superseded')
        and published_at is null
        and publication_receipt_id is null
      )
    ),
  constraint wire_report_versions_supersession_state_check
    check (
      (
        lifecycle_state = 'superseded'
        and superseded_at is not null
        and superseded_by_version_id is not null
      )
      or (
        lifecycle_state <> 'superseded'
        and superseded_at is null
        and superseded_by_version_id is null
      )
    )
);

create index wire_report_versions_report_state_idx
  on public.wire_report_versions (wire_report_id, lifecycle_state);
create index wire_report_versions_event_receipt_idx
  on public.wire_report_versions (event_receipt_id);
create index wire_report_versions_publication_receipt_idx
  on public.wire_report_versions (publication_receipt_id)
  where publication_receipt_id is not null;

create table public.evidence_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    constraint evidence_items_kind_check
    check (kind in ('onchain_tx', 'wallet', 'url', 'document', 'token')),
  ref text not null
    constraint evidence_items_ref_length_check
    check (char_length(btrim(ref)) between 1 and 4096),
  is_public boolean not null default false,
  moderation_state text not null default 'pending'
    constraint evidence_items_moderation_state_check
    check (moderation_state in ('pending', 'approved', 'blocked')),
  sha256 text not null
    constraint evidence_items_sha256_check
    check (sha256 ~ '^[0-9a-f]{64}$'),
  added_by_wallet text not null
    constraint evidence_items_added_by_wallet_check
    check (
      char_length(added_by_wallet) between 32 and 44
      and added_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evidence_items_public_approval_check
    check (is_public = false or moderation_state = 'approved'),
  constraint evidence_items_kind_ref_check
    check (
      (kind <> 'url' or ref ~ '^https://')
      and (
        kind <> 'wallet'
        or (
          char_length(ref) between 32 and 44
          and ref ~ '^[1-9A-HJ-NP-Za-km-z]+$'
        )
      )
    )
);

create index evidence_items_kind_idx on public.evidence_items (kind);
create index evidence_items_sha256_idx on public.evidence_items (sha256);
create index evidence_items_public_moderation_idx
  on public.evidence_items (is_public, moderation_state);

create table public.case_evidence_links (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.cases (id) on delete restrict,
  evidence_item_id uuid not null
    references public.evidence_items (id) on delete restrict,
  added_by_wallet text not null
    constraint case_evidence_links_wallet_check
    check (
      char_length(added_by_wallet) between 32 and 44
      and added_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  created_at timestamptz not null default now(),
  constraint case_evidence_links_unique unique (case_id, evidence_item_id)
);

create index case_evidence_links_evidence_idx
  on public.case_evidence_links (evidence_item_id);

create table public.case_report_version_evidence (
  id uuid primary key default gen_random_uuid(),
  report_version_id uuid not null
    references public.case_report_versions (id) on delete restrict,
  evidence_item_id uuid not null
    references public.evidence_items (id) on delete restrict,
  added_by_wallet text not null
    constraint case_report_version_evidence_wallet_check
    check (
      char_length(added_by_wallet) between 32 and 44
      and added_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  created_at timestamptz not null default now(),
  constraint case_report_version_evidence_unique
    unique (report_version_id, evidence_item_id)
);

create index case_report_version_evidence_item_idx
  on public.case_report_version_evidence (evidence_item_id);

create table public.wire_report_version_evidence (
  id uuid primary key default gen_random_uuid(),
  wire_report_version_id uuid not null
    references public.wire_report_versions (id) on delete restrict,
  evidence_item_id uuid not null
    references public.evidence_items (id) on delete restrict,
  added_by_wallet text not null
    constraint wire_report_version_evidence_wallet_check
    check (
      char_length(added_by_wallet) between 32 and 44
      and added_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  created_at timestamptz not null default now(),
  constraint wire_report_version_evidence_unique
    unique (wire_report_version_id, evidence_item_id)
);

create index wire_report_version_evidence_item_idx
  on public.wire_report_version_evidence (evidence_item_id);

create table public.analyst_applications (
  id uuid primary key default gen_random_uuid(),
  applicant_wallet text not null
    constraint analyst_applications_wallet_check
    check (
      char_length(applicant_wallet) between 32 and 44
      and applicant_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  origin text not null
    constraint analyst_applications_origin_check
    check (origin in ('path_a_direct', 'path_b_derived')),
  status text not null default 'submitted'
    constraint analyst_applications_status_check
    check (status in (
      'submitted',
      'in_review',
      'revision_requested',
      'approved',
      'rejected',
      'withdrawn'
    )),
  current_version_id uuid,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index analyst_applications_wallet_status_idx
  on public.analyst_applications (applicant_wallet, status);
create unique index analyst_applications_one_live_uidx
  on public.analyst_applications (applicant_wallet)
  where status in ('submitted', 'in_review', 'revision_requested');

create table public.analyst_application_versions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null
    references public.analyst_applications (id) on delete restrict,
  version_no integer not null
    constraint analyst_application_versions_number_check
    check (version_no >= 1),
  expertise_public jsonb not null
    constraint analyst_application_versions_expertise_shape_check
    check (jsonb_typeof(expertise_public) in ('array', 'object')),
  details_restricted jsonb not null
    constraint analyst_application_versions_details_shape_check
    check (jsonb_typeof(details_restricted) = 'object'),
  created_by_wallet text not null
    constraint analyst_application_versions_creator_check
    check (
      char_length(created_by_wallet) between 32 and 44
      and created_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  supersedes_version_id uuid,
  revision_reason_code text
    constraint analyst_application_versions_reason_check
    check (
      revision_reason_code is null
      or revision_reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'
    ),
  submitted_at timestamptz not null,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint analyst_application_versions_number_unique
    unique (application_id, version_no),
  constraint analyst_application_versions_application_id_id_unique
    unique (application_id, id),
  constraint analyst_application_versions_supersedes_fk
    foreign key (application_id, supersedes_version_id)
    references public.analyst_application_versions (application_id, id)
    on delete restrict,
  constraint analyst_application_versions_not_self_check
    check (supersedes_version_id is null or supersedes_version_id <> id)
);

create index analyst_application_versions_receipt_idx
  on public.analyst_application_versions (event_receipt_id);

create table public.analyst_profiles (
  wallet text primary key
    constraint analyst_profiles_wallet_check
    check (
      char_length(wallet) between 32 and 44
      and wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  handle text
    constraint analyst_profiles_handle_check
    check (handle is null or handle ~ '^[A-Za-z0-9_]{2,32}$'),
  display_name text
    constraint analyst_profiles_display_name_check
    check (display_name is null or char_length(display_name) <= 80),
  bio text
    constraint analyst_profiles_bio_check
    check (bio is null or char_length(bio) <= 1000),
  avatar_url text
    constraint analyst_profiles_avatar_url_check
    check (avatar_url is null or avatar_url ~ '^https://'),
  status text not null default 'contributor'
    constraint analyst_profiles_status_check
    check (status in (
      'contributor',
      'analyst_candidate',
      'probationary_analyst',
      'verified_analyst',
      'senior_analyst',
      'revoked'
    )),
  tier_code text not null default 'none'
    constraint analyst_profiles_tier_code_check
    check (tier_code in (
      'none',
      'probationary',
      'analyst_i',
      'analyst_ii',
      'senior',
      'distinguished'
    )),
  verified boolean not null default false,
  approved boolean not null default false,
  weight_cached numeric(4,2) not null default 0,
  verified_by text
    constraint analyst_profiles_verified_by_check
    check (
      verified_by is null
      or (
        char_length(verified_by) between 32 and 44
        and verified_by ~ '^[1-9A-HJ-NP-Za-km-z]+$'
      )
    ),
  verified_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint analyst_profiles_eligibility_consistency_check
    check (
      (
        status in ('probationary_analyst', 'verified_analyst', 'senior_analyst')
        and verified = true
        and approved = true
        and weight_cached between 0.50 and 3.00
        and tier_code <> 'none'
      )
      or (
        status in ('contributor', 'analyst_candidate', 'revoked')
        and weight_cached = 0
        and verified = false
        and approved = false
        and tier_code = 'none'
      )
    ),
  constraint analyst_profiles_verification_receipt_check
    check (
      (
        status in ('verified_analyst', 'senior_analyst')
        and verified_by is not null
        and verified_receipt_id is not null
      )
      or status not in ('verified_analyst', 'senior_analyst')
    )
);

create unique index analyst_profiles_handle_lower_uidx
  on public.analyst_profiles (lower(handle))
  where handle is not null;
create index analyst_profiles_active_idx
  on public.analyst_profiles (status, approved, verified);

create table public.analyst_contributions (
  id uuid primary key default gen_random_uuid(),
  analyst_wallet text not null
    references public.analyst_profiles (wallet) on delete restrict,
  kind text not null
    constraint analyst_contributions_kind_check
    check (kind ~ '^[a-z][a-z0-9_]{1,63}$'),
  subject_type text not null
    constraint analyst_contributions_subject_type_check
    check (subject_type ~ '^[a-z][a-z0-9_]{1,63}$'),
  subject_id uuid not null,
  quality_score numeric(5,4) not null
    constraint analyst_contributions_quality_check
    check (quality_score between 0 and 1),
  signed_by_independent_count integer not null
    constraint analyst_contributions_independent_count_check
    check (signed_by_independent_count >= 0),
  weight_delta_input numeric(10,4) not null,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now()
);

create index analyst_contributions_wallet_kind_idx
  on public.analyst_contributions (analyst_wallet, kind);
create index analyst_contributions_subject_idx
  on public.analyst_contributions (subject_type, subject_id);
create index analyst_contributions_receipt_idx
  on public.analyst_contributions (event_receipt_id);

create table public.analyst_reputation_snapshots (
  id uuid primary key default gen_random_uuid(),
  analyst_wallet text not null
    references public.analyst_profiles (wallet) on delete restrict,
  as_of timestamptz not null,
  weight numeric(4,2) not null
    constraint analyst_reputation_snapshots_weight_check
    check (weight between 0.50 and 3.00),
  component_breakdown jsonb not null
    constraint analyst_reputation_snapshots_components_check
    check (jsonb_typeof(component_breakdown) = 'object'),
  algo_version text not null
    constraint analyst_reputation_snapshots_algo_version_check
    check (algo_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  created_at timestamptz not null default now(),
  constraint analyst_reputation_snapshots_unique
    unique (analyst_wallet, as_of, algo_version)
);

create index analyst_reputation_snapshots_latest_idx
  on public.analyst_reputation_snapshots (analyst_wallet, as_of desc);

create table public.ai_packs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.cases (id) on delete restrict,
  pack_type text not null
    constraint ai_packs_pack_type_check
    check (pack_type in ('victim', 'exchange', 'law_enforcement')),
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_packs_case_type_unique unique (case_id, pack_type)
);

create table public.ai_pack_versions (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null
    references public.ai_packs (id) on delete restrict,
  version_no integer not null
    constraint ai_pack_versions_version_no_check
    check (version_no >= 1),
  public_evidence_manifest_hash text not null
    constraint ai_pack_versions_public_manifest_hash_check
    check (public_evidence_manifest_hash ~ '^[0-9a-f]{64}$'),
  owner_safe_evidence_manifest_hash text not null
    constraint ai_pack_versions_owner_manifest_hash_check
    check (owner_safe_evidence_manifest_hash ~ '^[0-9a-f]{64}$'),
  analyst_restricted_evidence_manifest_hash text not null
    constraint ai_pack_versions_analyst_manifest_hash_check
    check (analyst_restricted_evidence_manifest_hash ~ '^[0-9a-f]{64}$'),
  content_public_brief text not null
    constraint ai_pack_versions_public_content_length_check
    check (char_length(content_public_brief) <= 50000),
  content_owner_safe text not null
    constraint ai_pack_versions_owner_content_length_check
    check (char_length(content_owner_safe) <= 100000),
  content_analyst_restricted text not null
    constraint ai_pack_versions_restricted_content_length_check
    check (char_length(content_analyst_restricted) <= 150000),
  model text not null
    constraint ai_pack_versions_model_check
    check (char_length(btrim(model)) between 1 and 128),
  created_by_wallet text not null
    constraint ai_pack_versions_creator_wallet_check
    check (
      char_length(created_by_wallet) between 32 and 44
      and created_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  created_by_role text not null
    constraint ai_pack_versions_creator_role_check
    check (created_by_role in ('owner', 'analyst', 'maintainer')),
  lifecycle_state text not null default 'draft'
    constraint ai_pack_versions_lifecycle_check
    check (lifecycle_state in (
      'draft',
      'review_required',
      'revision_requested',
      'supported',
      'disputed',
      'approved',
      'rejected',
      'attached_to_resolution',
      'superseded'
    )),
  is_stale boolean not null default false,
  stale_at timestamptz,
  stale_reason text
    constraint ai_pack_versions_stale_reason_check
    check (stale_reason is null or char_length(stale_reason) <= 512),
  superseded_by_version_id uuid,
  confidence_profile jsonb not null
    constraint ai_pack_versions_confidence_profile_check
    check (jsonb_typeof(confidence_profile) = 'object'),
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_pack_versions_number_unique unique (pack_id, version_no),
  constraint ai_pack_versions_pack_id_id_unique unique (pack_id, id),
  constraint ai_pack_versions_superseded_by_fk
    foreign key (pack_id, superseded_by_version_id)
    references public.ai_pack_versions (pack_id, id)
    on delete restrict,
  constraint ai_pack_versions_not_self_check
    check (superseded_by_version_id is null or superseded_by_version_id <> id),
  constraint ai_pack_versions_staleness_check
    check (
      (is_stale = false and stale_at is null and stale_reason is null)
      or (is_stale = true and stale_at is not null and stale_reason is not null)
    ),
  constraint ai_pack_versions_supersession_check
    check (
      (lifecycle_state = 'superseded' and superseded_by_version_id is not null)
      or lifecycle_state <> 'superseded'
    )
);

create index ai_pack_versions_pack_state_idx
  on public.ai_pack_versions (pack_id, lifecycle_state);
create index ai_pack_versions_receipt_idx
  on public.ai_pack_versions (event_receipt_id);
create index ai_pack_versions_stale_idx
  on public.ai_pack_versions (is_stale, stale_at)
  where is_stale = true;

create table public.ai_pack_version_evidence (
  id uuid primary key default gen_random_uuid(),
  pack_version_id uuid not null
    references public.ai_pack_versions (id) on delete restrict,
  evidence_item_id uuid not null
    references public.evidence_items (id) on delete restrict,
  access_scope text not null
    constraint ai_pack_version_evidence_scope_check
    check (access_scope in ('public', 'owner_safe', 'analyst_restricted')),
  ordinal integer not null
    constraint ai_pack_version_evidence_ordinal_check
    check (ordinal >= 0),
  evidence_hash_at_generation text not null
    constraint ai_pack_version_evidence_hash_check
    check (evidence_hash_at_generation ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint ai_pack_version_evidence_item_unique
    unique (pack_version_id, evidence_item_id),
  constraint ai_pack_version_evidence_ordinal_unique
    unique (pack_version_id, access_scope, ordinal)
);

create index ai_pack_version_evidence_item_idx
  on public.ai_pack_version_evidence (evidence_item_id);
create index ai_pack_version_evidence_scope_idx
  on public.ai_pack_version_evidence (pack_version_id, access_scope, ordinal);

create table public.ai_pack_owner_feedback (
  id uuid primary key default gen_random_uuid(),
  pack_version_id uuid not null
    references public.ai_pack_versions (id) on delete restrict,
  owner_wallet text not null
    constraint ai_pack_owner_feedback_wallet_check
    check (
      char_length(owner_wallet) between 32 and 44
      and owner_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  feedback_type text not null
    constraint ai_pack_owner_feedback_type_check
    check (feedback_type in ('correction_request', 'clarification', 'evidence_note')),
  public_safe_summary text
    constraint ai_pack_owner_feedback_public_summary_check
    check (public_safe_summary is null or char_length(public_safe_summary) <= 4000),
  feedback_restricted text
    constraint ai_pack_owner_feedback_restricted_check
    check (feedback_restricted is null or char_length(feedback_restricted) <= 20000),
  is_active boolean not null default true,
  superseded_by uuid
    references public.ai_pack_owner_feedback (id)
    on delete restrict deferrable initially deferred,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_pack_owner_feedback_content_check
    check (public_safe_summary is not null or feedback_restricted is not null),
  constraint ai_pack_owner_feedback_not_self_check
    check (superseded_by is null or superseded_by <> id),
  constraint ai_pack_owner_feedback_active_link_check
    check (
      (is_active = true and superseded_by is null)
      or (is_active = false and superseded_by is not null)
    )
);

create unique index ai_pack_owner_feedback_active_uidx
  on public.ai_pack_owner_feedback (pack_version_id, owner_wallet)
  where is_active;
create index ai_pack_owner_feedback_receipt_idx
  on public.ai_pack_owner_feedback (event_receipt_id);

create table public.case_resolutions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.cases (id) on delete restrict,
  winning_report_version_id uuid
    references public.case_report_versions (id) on delete restrict,
  proposed_by_wallet text
    constraint case_resolutions_proposed_by_wallet_check
    check (
      proposed_by_wallet is null
      or (
        char_length(proposed_by_wallet) between 32 and 44
        and proposed_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
      )
    ),
  challenge_window_ends_at timestamptz,
  state text not null default 'selection_open'
    constraint case_resolutions_state_check
    check (state in (
      'selection_open',
      'proposed',
      'in_challenge_window',
      'sealed',
      'reopened',
      'resolved_legacy'
    )),
  finalized_by text
    constraint case_resolutions_finalized_by_check
    check (finalized_by is null or finalized_by in ('quorum_maintainer', 'fallback')),
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint case_resolutions_winner_state_check
    check (
      (winning_report_version_id is null and state in ('selection_open', 'resolved_legacy'))
      or (
        winning_report_version_id is not null
        and state in ('proposed', 'in_challenge_window', 'sealed', 'reopened', 'resolved_legacy')
      )
    ),
  constraint case_resolutions_finalizer_state_check
    check (
      (
        state = 'selection_open'
        and finalized_by is null
        and proposed_by_wallet is null
      )
      or (
        state in ('proposed', 'in_challenge_window', 'sealed', 'reopened')
        and finalized_by is not null
        and proposed_by_wallet is not null
      )
      or state = 'resolved_legacy'
    ),
  constraint case_resolutions_challenge_window_check
    check (
      state <> 'in_challenge_window'
      or challenge_window_ends_at is not null
    )
);

create unique index case_resolutions_one_live_uidx
  on public.case_resolutions (case_id)
  where state not in ('reopened', 'resolved_legacy');
create unique index case_resolutions_one_legacy_uidx
  on public.case_resolutions (case_id)
  where state = 'resolved_legacy';
create index case_resolutions_winning_version_idx
  on public.case_resolutions (winning_report_version_id)
  where winning_report_version_id is not null;
create index case_resolutions_receipt_idx
  on public.case_resolutions (event_receipt_id);

create table public.challenges_v2 (
  id uuid primary key default gen_random_uuid(),
  challenger_wallet text not null
    constraint challenges_v2_challenger_wallet_check
    check (
      char_length(challenger_wallet) between 32 and 44
      and challenger_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  reason_code text not null
    constraint challenges_v2_reason_code_check
    check (reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'),
  case_id uuid
    references public.cases (id) on delete restrict,
  case_report_version_id uuid
    references public.case_report_versions (id) on delete restrict,
  wire_report_version_id uuid
    references public.wire_report_versions (id) on delete restrict,
  ai_pack_version_id uuid
    references public.ai_pack_versions (id) on delete restrict,
  resolution_id uuid
    references public.case_resolutions (id) on delete restrict,
  target_kind text not null
    constraint challenges_v2_target_kind_check
    check (target_kind in (
      'case',
      'case_report_version',
      'wire_report_version',
      'ai_pack_version',
      'resolution'
    )),
  evidence_item_id uuid not null
    references public.evidence_items (id) on delete restrict,
  state text not null default 'submitted'
    constraint challenges_v2_state_check
    check (state in (
      'submitted',
      'admissibility_review',
      'open',
      'under_review',
      'accepted',
      'rejected',
      'withdrawn',
      'expired'
    )),
  admitted_by_wallet text
    constraint challenges_v2_admitted_by_wallet_check
    check (
      admitted_by_wallet is null
      or (
        char_length(admitted_by_wallet) between 32 and 44
        and admitted_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
      )
    ),
  admissibility_ttl_at timestamptz not null,
  review_deadline_at timestamptz,
  expired_reason text
    constraint challenges_v2_expired_reason_check
    check (expired_reason is null or expired_reason in ('admissibility_timeout', 'review_timeout')),
  cooldown_key text not null
    constraint challenges_v2_cooldown_key_check
    check (char_length(cooldown_key) between 16 and 256),
  bad_faith_state text not null default 'none'
    constraint challenges_v2_bad_faith_state_check
    check (bad_faith_state in ('none', 'under_review', 'confirmed', 'dismissed')),
  submitted_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  opened_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  resolved_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  bad_faith_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint challenges_v2_exactly_one_target_check
    check (
      num_nonnulls(
        case_id,
        case_report_version_id,
        wire_report_version_id,
        ai_pack_version_id,
        resolution_id
      ) = 1
    ),
  constraint challenges_v2_target_kind_consistency_check
    check (
      (target_kind = 'case' and case_id is not null)
      or (target_kind = 'case_report_version' and case_report_version_id is not null)
      or (target_kind = 'wire_report_version' and wire_report_version_id is not null)
      or (target_kind = 'ai_pack_version' and ai_pack_version_id is not null)
      or (target_kind = 'resolution' and resolution_id is not null)
    ),
  constraint challenges_v2_admitter_not_challenger_check
    check (admitted_by_wallet is null or admitted_by_wallet <> challenger_wallet),
  constraint challenges_v2_deadline_state_check
    check (
      (
        state in ('submitted', 'admissibility_review')
        and review_deadline_at is null
      )
      or (
        state in ('open', 'under_review')
        and review_deadline_at is not null
        and opened_receipt_id is not null
      )
      or state in ('accepted', 'rejected', 'withdrawn', 'expired')
    ),
  constraint challenges_v2_expiry_consistency_check
    check (
      (state = 'expired' and expired_reason is not null and resolved_receipt_id is not null)
      or (state <> 'expired' and expired_reason is null)
    ),
  constraint challenges_v2_resolution_receipt_check
    check (
      state not in ('accepted', 'rejected')
      or resolved_receipt_id is not null
    )
);

create unique index challenges_v2_active_case_uidx
  on public.challenges_v2 (challenger_wallet, case_id)
  where case_id is not null
    and state in ('submitted', 'admissibility_review', 'open', 'under_review');
create unique index challenges_v2_active_case_report_uidx
  on public.challenges_v2 (challenger_wallet, case_report_version_id)
  where case_report_version_id is not null
    and state in ('submitted', 'admissibility_review', 'open', 'under_review');
create unique index challenges_v2_active_wire_report_uidx
  on public.challenges_v2 (challenger_wallet, wire_report_version_id)
  where wire_report_version_id is not null
    and state in ('submitted', 'admissibility_review', 'open', 'under_review');
create unique index challenges_v2_active_pack_uidx
  on public.challenges_v2 (challenger_wallet, ai_pack_version_id)
  where ai_pack_version_id is not null
    and state in ('submitted', 'admissibility_review', 'open', 'under_review');
create unique index challenges_v2_active_resolution_uidx
  on public.challenges_v2 (challenger_wallet, resolution_id)
  where resolution_id is not null
    and state in ('submitted', 'admissibility_review', 'open', 'under_review');
create index challenges_v2_target_state_idx
  on public.challenges_v2 (target_kind, state);
create index challenges_v2_admissibility_deadline_idx
  on public.challenges_v2 (state, admissibility_ttl_at)
  where state in ('submitted', 'admissibility_review');
create index challenges_v2_review_deadline_idx
  on public.challenges_v2 (state, review_deadline_at)
  where state in ('open', 'under_review');
create index challenges_v2_evidence_idx
  on public.challenges_v2 (evidence_item_id);

create table public.reward_pledges (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null unique
    references public.cases (id) on delete restrict,
  pledger_wallet text not null
    constraint reward_pledges_pledger_wallet_check
    check (
      char_length(pledger_wallet) between 32 and 44
      and pledger_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  amount_lamports bigint not null
    constraint reward_pledges_amount_check
    check (amount_lamports > 0),
  token text not null default 'SOL'
    constraint reward_pledges_token_check
    check (token = 'SOL'),
  state text not null default 'pledged'
    constraint reward_pledges_state_check
    check (state in ('pledged', 'assigned', 'paid', 'cancelled', 'expired')),
  winning_report_version_id uuid
    references public.case_report_versions (id) on delete restrict,
  created_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reward_pledges_assignment_check
    check (
      (state = 'pledged' and winning_report_version_id is null)
      or (
        state in ('assigned', 'paid')
        and winning_report_version_id is not null
      )
      or state in ('cancelled', 'expired')
    )
);

create index reward_pledges_winning_version_idx
  on public.reward_pledges (winning_report_version_id)
  where winning_report_version_id is not null;
create index reward_pledges_receipt_idx
  on public.reward_pledges (created_receipt_id);

create table public.reward_payments (
  id uuid primary key default gen_random_uuid(),
  pledge_id uuid not null
    references public.reward_pledges (id) on delete restrict,
  from_wallet text not null
    constraint reward_payments_from_wallet_check
    check (
      char_length(from_wallet) between 32 and 44
      and from_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  to_wallet text not null
    constraint reward_payments_to_wallet_check
    check (
      char_length(to_wallet) between 32 and 44
      and to_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  amount_lamports bigint not null
    constraint reward_payments_amount_check
    check (amount_lamports > 0),
  tx_sig text
    constraint reward_payments_tx_sig_check
    check (
      tx_sig is null
      or (
        char_length(tx_sig) between 64 and 96
        and tx_sig ~ '^[1-9A-HJ-NP-Za-km-z]+$'
      )
    ),
  state text not null default 'initiated'
    constraint reward_payments_state_check
    check (state in ('initiated', 'submitted', 'confirmed', 'failed', 'timed_out')),
  confirmed_at timestamptz,
  event_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reward_payments_distinct_wallets_check
    check (from_wallet <> to_wallet),
  constraint reward_payments_confirmation_check
    check (
      (
        state = 'confirmed'
        and tx_sig is not null
        and confirmed_at is not null
        and event_receipt_id is not null
      )
      or (
        state <> 'confirmed'
        and confirmed_at is null
      )
    )
);

create unique index reward_payments_tx_sig_uidx
  on public.reward_payments (tx_sig)
  where tx_sig is not null;
create index reward_payments_pledge_state_idx
  on public.reward_payments (pledge_id, state);
create index reward_payments_receipt_idx
  on public.reward_payments (event_receipt_id)
  where event_receipt_id is not null;

create table public.support_events (
  id uuid primary key default gen_random_uuid(),
  support_type text not null
    constraint support_events_type_check
    check (support_type in ('report_author', 'analyst')),
  case_report_version_id uuid
    references public.case_report_versions (id) on delete restrict,
  wire_report_version_id uuid
    references public.wire_report_versions (id) on delete restrict,
  analyst_wallet text
    references public.analyst_profiles (wallet) on delete restrict,
  target_wallet text not null
    constraint support_events_target_wallet_check
    check (
      char_length(target_wallet) between 32 and 44
      and target_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  from_wallet text not null
    constraint support_events_from_wallet_check
    check (
      char_length(from_wallet) between 32 and 44
      and from_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  amount_lamports bigint not null
    constraint support_events_amount_check
    check (amount_lamports > 0),
  token text not null default 'SOL'
    constraint support_events_token_check
    check (token = 'SOL'),
  tx_sig text
    constraint support_events_tx_sig_check
    check (
      tx_sig is null
      or (
        char_length(tx_sig) between 64 and 96
        and tx_sig ~ '^[1-9A-HJ-NP-Za-km-z]+$'
      )
    ),
  state text not null default 'submitted'
    constraint support_events_state_check
    check (state in ('submitted', 'confirmed', 'failed')),
  event_receipt_id uuid
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_events_distinct_wallets_check
    check (from_wallet <> target_wallet),
  constraint support_events_typed_target_check
    check (
      (
        support_type = 'report_author'
        and analyst_wallet is null
        and num_nonnulls(case_report_version_id, wire_report_version_id) = 1
      )
      or (
        support_type = 'analyst'
        and analyst_wallet is not null
        and case_report_version_id is null
        and wire_report_version_id is null
      )
    ),
  constraint support_events_confirmation_check
    check (
      state <> 'confirmed'
      or (tx_sig is not null and event_receipt_id is not null)
    )
);

create unique index support_events_tx_sig_uidx
  on public.support_events (tx_sig)
  where tx_sig is not null;
create index support_events_target_idx
  on public.support_events (target_wallet, created_at desc);
create index support_events_from_idx
  on public.support_events (from_wallet, created_at desc);
create index support_events_case_report_version_idx
  on public.support_events (case_report_version_id)
  where case_report_version_id is not null;
create index support_events_wire_report_version_idx
  on public.support_events (wire_report_version_id)
  where wire_report_version_id is not null;
create index support_events_analyst_idx
  on public.support_events (analyst_wallet)
  where analyst_wallet is not null;

-- Seven typed review tables. Each keeps historical decisions; a revision
-- inserts a new row and marks the old row inactive with superseded_by.

create table public.case_initial_reviews (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.cases (id) on delete restrict,
  reviewer_wallet text not null
    constraint case_initial_reviews_wallet_check
    check (
      char_length(reviewer_wallet) between 32 and 44
      and reviewer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  decision text not null
    constraint case_initial_reviews_decision_check
    check (decision in ('approve_open', 'reject', 'needs_more')),
  reviewer_role text not null default 'analyst'
    constraint case_initial_reviews_reviewer_role_check
    check (reviewer_role in ('analyst', 'maintainer')),
  weight numeric(4,2) not null
    constraint case_initial_reviews_weight_check
    check (
      (reviewer_role = 'analyst' and weight between 0.50 and 3.00)
      or (
        reviewer_role = 'maintainer'
        and decision = 'approve_open'
        and weight = 0
      )
    ),
  reason_code text
    constraint case_initial_reviews_reason_check
    check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'),
  is_active boolean not null default true,
  superseded_by uuid
    references public.case_initial_reviews (id)
    on delete restrict deferrable initially deferred,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint case_initial_reviews_not_self_link_check
    check (superseded_by is null or superseded_by <> id),
  constraint case_initial_reviews_active_link_check
    check (
      (is_active = true and superseded_by is null)
      or (is_active = false and superseded_by is not null)
    )
);

create unique index case_initial_reviews_active_uidx
  on public.case_initial_reviews (case_id, reviewer_wallet)
  where is_active;
create index case_initial_reviews_receipt_idx
  on public.case_initial_reviews (event_receipt_id);

create table public.case_report_reviews (
  id uuid primary key default gen_random_uuid(),
  report_version_id uuid not null
    references public.case_report_versions (id) on delete restrict,
  reviewer_wallet text not null
    constraint case_report_reviews_wallet_check
    check (
      char_length(reviewer_wallet) between 32 and 44
      and reviewer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  decision text not null
    constraint case_report_reviews_decision_check
    check (decision in ('approve', 'reject', 'request_revision', 'abstain')),
  weight numeric(4,2) not null
    constraint case_report_reviews_weight_check
    check (weight between 0.50 and 3.00),
  reason_code text
    constraint case_report_reviews_reason_check
    check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'),
  is_active boolean not null default true,
  superseded_by uuid
    references public.case_report_reviews (id)
    on delete restrict deferrable initially deferred,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint case_report_reviews_not_self_link_check
    check (superseded_by is null or superseded_by <> id),
  constraint case_report_reviews_active_link_check
    check (
      (is_active = true and superseded_by is null)
      or (is_active = false and superseded_by is not null)
    )
);

create unique index case_report_reviews_active_uidx
  on public.case_report_reviews (report_version_id, reviewer_wallet)
  where is_active;
create index case_report_reviews_receipt_idx
  on public.case_report_reviews (event_receipt_id);

create table public.wire_report_reviews (
  id uuid primary key default gen_random_uuid(),
  wire_report_version_id uuid not null
    references public.wire_report_versions (id) on delete restrict,
  reviewer_wallet text not null
    constraint wire_report_reviews_wallet_check
    check (
      char_length(reviewer_wallet) between 32 and 44
      and reviewer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  decision text not null
    constraint wire_report_reviews_decision_check
    check (decision in ('approve', 'reject', 'request_revision', 'abstain')),
  weight numeric(4,2) not null
    constraint wire_report_reviews_weight_check
    check (weight between 0.50 and 3.00),
  reason_code text
    constraint wire_report_reviews_reason_check
    check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'),
  is_active boolean not null default true,
  superseded_by uuid
    references public.wire_report_reviews (id)
    on delete restrict deferrable initially deferred,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wire_report_reviews_not_self_link_check
    check (superseded_by is null or superseded_by <> id),
  constraint wire_report_reviews_active_link_check
    check (
      (is_active = true and superseded_by is null)
      or (is_active = false and superseded_by is not null)
    )
);

create unique index wire_report_reviews_active_uidx
  on public.wire_report_reviews (wire_report_version_id, reviewer_wallet)
  where is_active;
create index wire_report_reviews_receipt_idx
  on public.wire_report_reviews (event_receipt_id);

create table public.resolution_reviews (
  id uuid primary key default gen_random_uuid(),
  resolution_id uuid not null
    references public.case_resolutions (id) on delete restrict,
  candidate_report_version_id uuid not null
    references public.case_report_versions (id) on delete restrict,
  reviewer_wallet text not null
    constraint resolution_reviews_wallet_check
    check (
      char_length(reviewer_wallet) between 32 and 44
      and reviewer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  decision text not null
    constraint resolution_reviews_decision_check
    check (decision in ('select', 'object', 'abstain')),
  weight numeric(4,2) not null
    constraint resolution_reviews_weight_check
    check (weight between 0.50 and 3.00),
  reason_code text
    constraint resolution_reviews_reason_check
    check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'),
  is_active boolean not null default true,
  superseded_by uuid
    references public.resolution_reviews (id)
    on delete restrict deferrable initially deferred,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resolution_reviews_not_self_link_check
    check (superseded_by is null or superseded_by <> id),
  constraint resolution_reviews_active_link_check
    check (
      (is_active = true and superseded_by is null)
      or (is_active = false and superseded_by is not null)
    )
);

create unique index resolution_reviews_active_uidx
  on public.resolution_reviews (resolution_id, reviewer_wallet)
  where is_active;
create index resolution_reviews_candidate_idx
  on public.resolution_reviews (candidate_report_version_id);
create index resolution_reviews_receipt_idx
  on public.resolution_reviews (event_receipt_id);

create table public.challenge_reviews (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null
    references public.challenges_v2 (id) on delete restrict,
  phase text not null
    constraint challenge_reviews_phase_check
    check (phase in ('merit', 'bad_faith')),
  reviewer_wallet text not null
    constraint challenge_reviews_wallet_check
    check (
      char_length(reviewer_wallet) between 32 and 44
      and reviewer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  decision text not null
    constraint challenge_reviews_decision_check
    check (decision in ('accept', 'reject', 'bad_faith', 'not_bad_faith')),
  weight numeric(4,2) not null
    constraint challenge_reviews_weight_check
    check (weight between 0.50 and 3.00),
  reason_code text
    constraint challenge_reviews_reason_check
    check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'),
  is_active boolean not null default true,
  superseded_by uuid
    references public.challenge_reviews (id)
    on delete restrict deferrable initially deferred,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint challenge_reviews_phase_decision_check
    check (
      (phase = 'merit' and decision in ('accept', 'reject'))
      or (
        phase = 'bad_faith'
        and decision in ('bad_faith', 'not_bad_faith')
      )
    ),
  constraint challenge_reviews_not_self_link_check
    check (superseded_by is null or superseded_by <> id),
  constraint challenge_reviews_active_link_check
    check (
      (is_active = true and superseded_by is null)
      or (is_active = false and superseded_by is not null)
    )
);

create unique index challenge_reviews_active_uidx
  on public.challenge_reviews (challenge_id, reviewer_wallet, phase)
  where is_active;
create index challenge_reviews_receipt_idx
  on public.challenge_reviews (event_receipt_id);

create table public.ai_pack_reviews (
  id uuid primary key default gen_random_uuid(),
  pack_version_id uuid not null
    references public.ai_pack_versions (id) on delete restrict,
  reviewer_wallet text not null
    constraint ai_pack_reviews_wallet_check
    check (
      char_length(reviewer_wallet) between 32 and 44
      and reviewer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  decision text not null
    constraint ai_pack_reviews_decision_check
    check (decision in ('support', 'dispute', 'request_revision', 'approve')),
  weight numeric(4,2) not null
    constraint ai_pack_reviews_weight_check
    check (weight between 0.50 and 3.00),
  reason_code text
    constraint ai_pack_reviews_reason_check
    check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'),
  is_active boolean not null default true,
  superseded_by uuid
    references public.ai_pack_reviews (id)
    on delete restrict deferrable initially deferred,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_pack_reviews_not_self_link_check
    check (superseded_by is null or superseded_by <> id),
  constraint ai_pack_reviews_active_link_check
    check (
      (is_active = true and superseded_by is null)
      or (is_active = false and superseded_by is not null)
    )
);

create unique index ai_pack_reviews_active_uidx
  on public.ai_pack_reviews (pack_version_id, reviewer_wallet)
  where is_active;
create index ai_pack_reviews_receipt_idx
  on public.ai_pack_reviews (event_receipt_id);

create table public.analyst_application_reviews (
  id uuid primary key default gen_random_uuid(),
  application_version_id uuid not null
    references public.analyst_application_versions (id) on delete restrict,
  reviewer_wallet text not null
    constraint analyst_application_reviews_wallet_check
    check (
      char_length(reviewer_wallet) between 32 and 44
      and reviewer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  decision text not null
    constraint analyst_application_reviews_decision_check
    check (decision in ('approve', 'reject', 'request_revision')),
  weight numeric(4,2) not null
    constraint analyst_application_reviews_weight_check
    check (weight between 0.50 and 3.00),
  reason_code text
    constraint analyst_application_reviews_reason_check
    check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'),
  is_active boolean not null default true,
  superseded_by uuid
    references public.analyst_application_reviews (id)
    on delete restrict deferrable initially deferred,
  event_receipt_id uuid not null
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint analyst_application_reviews_not_self_link_check
    check (superseded_by is null or superseded_by <> id),
  constraint analyst_application_reviews_active_link_check
    check (
      (is_active = true and superseded_by is null)
      or (is_active = false and superseded_by is not null)
    )
);

create unique index analyst_application_reviews_active_uidx
  on public.analyst_application_reviews (application_version_id, reviewer_wallet)
  where is_active;
create index analyst_application_reviews_receipt_idx
  on public.analyst_application_reviews (event_receipt_id);

-- Stage-5 and migration infrastructure (not part of the 32 domain tables).

create table public.osi_nonces (
  nonce text primary key
    constraint osi_nonces_nonce_format_check
    check (nonce ~ '^[A-Za-z0-9_-]{32,128}$'),
  purpose text not null
    constraint osi_nonces_purpose_format_check
    check (purpose ~ '^[A-Z][A-Z0-9_]{1,95}$'),
  actor_wallet text not null
    constraint osi_nonces_actor_wallet_check
    check (
      char_length(actor_wallet) between 32 and 44
      and actor_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  target_type text not null
    constraint osi_nonces_target_type_check
    check (target_type in (
      'case',
      'report_version',
      'wire_version',
      'resolution',
      'challenge',
      'pack_version',
      'pack_owner_feedback',
      'analyst',
      'application_version',
      'reward',
      'support',
      'config'
    )),
  target_id text not null
    constraint osi_nonces_target_id_length_check
    check (char_length(target_id) between 1 and 256),
  payload_hash text not null
    constraint osi_nonces_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null unique
    constraint osi_nonces_idempotency_key_check
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_receipt_id uuid unique
    references public.event_receipts (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint osi_nonces_expiry_check
    check (expires_at > issued_at),
  constraint osi_nonces_consumption_check
    check (
      (consumed_at is null and consumed_by_receipt_id is null)
      or (
        consumed_at is not null
        and consumed_by_receipt_id is not null
        and consumed_at >= issued_at
        and consumed_at <= expires_at
      )
    )
);

create index osi_nonces_actor_purpose_idx
  on public.osi_nonces (actor_wallet, purpose, issued_at desc);
create index osi_nonces_unconsumed_expiry_idx
  on public.osi_nonces (expires_at)
  where consumed_at is null;
create index osi_nonces_target_idx
  on public.osi_nonces (target_type, target_id);

create table public.migration_crosswalk (
  id uuid primary key default gen_random_uuid(),
  entity_kind text not null
    constraint migration_crosswalk_entity_kind_check
    check (entity_kind ~ '^[a-z][a-z0-9_]{1,63}$'),
  legacy_table text not null
    constraint migration_crosswalk_legacy_table_check
    check (legacy_table ~ '^[a-z][a-z0-9_]{1,63}$'),
  legacy_id text not null
    constraint migration_crosswalk_legacy_id_check
    check (char_length(legacy_id) between 1 and 256),
  v2_table text not null
    constraint migration_crosswalk_v2_table_check
    check (v2_table ~ '^[a-z][a-z0-9_]{1,63}$'),
  v2_id uuid not null,
  confidence text not null
    constraint migration_crosswalk_confidence_check
    check (confidence in ('high', 'medium', 'low')),
  classification_reason text not null
    constraint migration_crosswalk_reason_check
    check (char_length(classification_reason) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint migration_crosswalk_legacy_unique
    unique (legacy_table, legacy_id, entity_kind)
);

create index migration_crosswalk_v2_idx
  on public.migration_crosswalk (v2_table, v2_id);

create table public.migration_manual_queue (
  id uuid primary key default gen_random_uuid(),
  legacy_table text not null
    constraint migration_manual_queue_legacy_table_check
    check (legacy_table ~ '^[a-z][a-z0-9_]{1,63}$'),
  legacy_id text not null
    constraint migration_manual_queue_legacy_id_check
    check (char_length(legacy_id) between 1 and 256),
  candidate_kinds text[] not null default '{}'::text[],
  reason_code text not null
    constraint migration_manual_queue_reason_code_check
    check (reason_code ~ '^[a-z][a-z0-9_:-]{0,95}$'),
  status text not null default 'pending'
    constraint migration_manual_queue_status_check
    check (status in ('pending', 'resolved')),
  resolution_kind text
    constraint migration_manual_queue_resolution_kind_check
    check (
      resolution_kind is null
      or resolution_kind ~ '^[a-z][a-z0-9_]{1,63}$'
    ),
  resolved_v2_id uuid,
  resolved_by_wallet text
    constraint migration_manual_queue_resolved_wallet_check
    check (
      resolved_by_wallet is null
      or (
        char_length(resolved_by_wallet) between 32 and 44
        and resolved_by_wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
      )
    ),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint migration_manual_queue_legacy_unique
    unique (legacy_table, legacy_id),
  constraint migration_manual_queue_resolution_check
    check (
      (
        status = 'pending'
        and resolution_kind is null
        and resolved_v2_id is null
        and resolved_by_wallet is null
        and resolved_at is null
      )
      or (
        status = 'resolved'
        and resolution_kind is not null
        and resolved_by_wallet is not null
        and resolved_at is not null
      )
    )
);

create index migration_manual_queue_status_idx
  on public.migration_manual_queue (status, created_at);

-- osi_config is the only intentional V1 table reuse. This creates the minimal
-- compatible shape only for a clean local database; on production the existing
-- table and its data remain untouched.
create table if not exists public.osi_config (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'osi_config'
      and column_name = 'key'
      and data_type = 'text'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'osi_config'
      and column_name = 'value'
      and data_type = 'text'
  ) then
    raise exception 'public.osi_config is incompatible with the OSI V2 key/value contract';
  end if;
end
$$;

commit;
