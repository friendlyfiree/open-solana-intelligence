-- OSI V2 cross-row integrity, immutable-history and lifecycle guards.
-- These guards protect invariants even when trusted server code has a bug.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Header/version pointers must always stay inside the same logical parent.
alter table public.case_reports
  add constraint case_reports_current_version_same_report_fk
  foreign key (id, current_version_id)
  references public.case_report_versions (report_id, id)
  on delete restrict
  deferrable initially deferred,
  add constraint case_reports_published_version_same_report_fk
  foreign key (id, current_published_version_id)
  references public.case_report_versions (report_id, id)
  on delete restrict
  deferrable initially deferred;

alter table public.wire_reports
  add constraint wire_reports_current_version_same_report_fk
  foreign key (id, current_version_id)
  references public.wire_report_versions (wire_report_id, id)
  on delete restrict
  deferrable initially deferred,
  add constraint wire_reports_published_version_same_report_fk
  foreign key (id, current_published_version_id)
  references public.wire_report_versions (wire_report_id, id)
  on delete restrict
  deferrable initially deferred;

alter table public.analyst_applications
  add constraint analyst_applications_current_version_same_parent_fk
  foreign key (id, current_version_id)
  references public.analyst_application_versions (application_id, id)
  on delete restrict
  deferrable initially deferred;

alter table public.ai_packs
  add constraint ai_packs_current_version_same_pack_fk
  foreign key (id, current_version_id)
  references public.ai_pack_versions (pack_id, id)
  on delete restrict
  deferrable initially deferred;

-- Canonical OSI2 events have exactly one proof transport class.
create function public.osi_v2_expected_proof_type(p_event_type text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when p_event_type = any (array[
      'CASE_INITIAL_REVIEW_CAST',
      'CASE_INITIAL_REVIEW_REVISED',
      'CASE_WITHDRAWN',
      'CASE_APPEAL_SUBMITTED',
      'CASE_REPORT_REVIEW_CAST',
      'CASE_REPORT_REVIEW_REVISED',
      'WIRE_REPORT_REVIEW_CAST',
      'WIRE_REPORT_REVIEW_REVISED',
      'RESOLUTION_REVIEW_CAST',
      'RESOLUTION_REVIEW_REVISED',
      'CHALLENGE_SUBMITTED',
      'CHALLENGE_ADMISSIBILITY_ACCEPTED',
      'CHALLENGE_ADMISSIBILITY_REJECTED',
      'CHALLENGE_REVIEW_CAST',
      'CHALLENGE_REVIEW_REVISED',
      'CHALLENGE_WITHDRAWN',
      'CHALLENGE_BAD_FAITH_REVIEW_CAST',
      'CHALLENGE_BAD_FAITH_REVIEW_REVISED',
      'AI_PACK_REVIEW_CAST',
      'AI_PACK_REVIEW_REVISED',
      'AI_PACK_OWNER_FEEDBACK_SUBMITTED',
      'ANALYST_APPLICATION_VERSION_SUBMITTED',
      'ANALYST_APPLICATION_REVIEW_CAST',
      'ANALYST_APPLICATION_REVIEW_REVISED',
      'OWNER_STATUS_PROOF'
    ]::text[]) then 'wallet_signed_server_verified'
    when p_event_type = any (array[
      'CASE_SUBMITTED',
      'CASE_OPENED',
      'CASE_SAFETY_BLOCKED',
      'CASE_SAFETY_LIFTED',
      'CASE_INITIAL_REVIEW_REJECTED',
      'CASE_RESUMED',
      'CASE_REPORT_VERSION_SUBMITTED',
      'REPORT_PUBLISHED',
      'REPORT_REJECTED',
      'WIRE_REPORT_VERSION_SUBMITTED',
      'WIRE_REPORT_PUBLISHED',
      'WIRE_PROMOTED',
      'RESOLUTION_PROPOSED',
      'REPORT_SELECTED_WINNING',
      'CHALLENGE_ACCEPTED',
      'CHALLENGE_REJECTED',
      'CHALLENGE_BAD_FAITH_CONFIRMED',
      'CHALLENGE_BAD_FAITH_DISMISSED',
      'CASE_RESOLVED',
      'CASE_REOPENED',
      'RECORD_SEALED',
      'CASE_HALTED',
      'ANALYST_PROBATION',
      'ANALYST_SENIOR',
      'ANALYST_VERIFIED',
      'ANALYST_REVOKED',
      'AI_PACK_APPROVED',
      'AI_PACK_REJECTED',
      'REWARD_PLEDGED',
      'REWARD_PAID',
      'SUPPORT_SENT',
      'CONFIG_CHANGED'
    ]::text[]) then 'solana_memo'
    when p_event_type = any (array[
      'CASE_QUORUM_READY',
      'CHALLENGE_EXPIRED',
      'PACK_SUBMITTED',
      'PACK_ATTACHED',
      'PACK_SUPERSEDED',
      'PACK_STALE',
      'REWARD_ASSIGNED',
      'ANALYST_CANDIDATE'
    ]::text[]) then 'system_event'
    else null
  end
$$;

alter table public.event_receipts
  add constraint event_receipts_canonical_transport_check
  check (
    event_version <> 'OSI2'
    or (
      public.osi_v2_expected_proof_type(event_type) is not null
      and proof_type = public.osi_v2_expected_proof_type(event_type)
    )
  ),
  add constraint event_receipts_native_nonce_required_check
  check (
    event_version <> 'OSI2'
    or proof_type = 'system_event'
    or (nonce is not null and target_id is not null)
  ),
  add constraint event_receipts_nonce_fk
  foreign key (nonce)
  references public.osi_nonces (nonce)
  on delete restrict
  deferrable initially deferred;

alter table public.osi_nonces
  add constraint osi_nonces_canonical_purpose_check
  check (
    public.osi_v2_expected_proof_type(purpose)
      in ('solana_memo', 'wallet_signed_server_verified')
  );

create function public.osi_v2_validate_native_receipt_nonce()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  nonce_row public.osi_nonces%rowtype;
  expected_actor text;
begin
  if new.event_version <> 'OSI2'
     or new.proof_type = 'system_event' then
    return null;
  end if;

  select *
    into nonce_row
    from public.osi_nonces
   where nonce = new.nonce;

  expected_actor := coalesce(new.actor_wallet, new.anchor_wallet);

  if nonce_row.nonce is null
     or nonce_row.purpose is distinct from new.event_type
     or nonce_row.actor_wallet is distinct from expected_actor
     or nonce_row.target_type is distinct from new.target_type
     or nonce_row.target_id is distinct from new.target_id
     or nonce_row.payload_hash is distinct from new.payload_hash
     or nonce_row.consumed_at is null
     or nonce_row.consumed_by_receipt_id is distinct from new.id then
    raise exception 'Native receipt requires one exact atomically-consumed nonce'
      using errcode = '23514';
  end if;

  return null;
end
$$;

create constraint trigger osi_v2_validate_native_receipt_nonce
after insert on public.event_receipts
deferrable initially deferred
for each row execute function public.osi_v2_validate_native_receipt_nonce();

-- Standard updated_at behavior for mutable V2 records.
create function public.osi_v2_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := statement_timestamp();
  return new;
end
$$;

-- Case lifecycle and public/private content guard.
create function public.osi_v2_guard_case_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transition_ok boolean;
begin
  if new.id is distinct from old.id
     or new.public_ref is distinct from old.public_ref
     or new.submitted_by_wallet is distinct from old.submitted_by_wallet
     or new.created_at is distinct from old.created_at then
    raise exception 'Case identity and submitter are immutable'
      using errcode = '55000';
  end if;

  if old.visibility = 'public'
     and (
       new.title is distinct from old.title
       or new.category is distinct from old.category
       or new.summary_public is distinct from old.summary_public
       or new.subject_refs is distinct from old.subject_refs
     ) then
    raise exception 'Public Case content is immutable; use a modeled forward correction'
      using errcode = '55000';
  end if;

  transition_ok :=
    new.stage = old.stage
    or (old.stage = 'draft' and new.stage = 'submitted')
    or (old.stage = 'submitted' and new.stage in ('initial_review', 'withdrawn'))
    or (
      old.stage = 'initial_review'
      and new.stage in ('open_public', 'safety_blocked', 'initial_rejected')
    )
    or (old.stage = 'safety_blocked' and new.stage = 'initial_review')
    or (old.stage = 'initial_rejected' and new.stage = 'initial_review')
    or (old.stage = 'open_public' and new.stage = 'in_review')
    or (
      old.stage = 'in_review'
      and new.stage = 'ready_for_finalization'
    )
    or (
      old.stage = 'ready_for_finalization'
      and new.stage in ('in_review', 'resolution_proposed')
    )
    or (
      old.stage = 'resolution_proposed'
      and new.stage in ('ready_for_finalization', 'in_challenge_window')
    )
    or (
      old.stage = 'in_challenge_window'
      and new.stage in ('resolved', 'reopened')
    )
    or (old.stage = 'resolved' and new.stage in ('sealed', 'reopened'))
    or (old.stage = 'sealed' and new.stage in ('archived', 'reopened'))
    or (old.stage = 'reopened' and new.stage = 'in_review')
    or (old.stage = 'halted' and new.stage = 'in_review')
    or (
      new.stage = 'halted'
      and old.stage not in ('draft', 'withdrawn', 'archived')
    );

  if not transition_ok then
    raise exception 'Invalid Case stage transition: % -> %', old.stage, new.stage
      using errcode = '23514';
  end if;

  if old.visibility = 'public' and new.visibility <> 'public' then
    raise exception 'A public Case cannot silently become private'
      using errcode = '23514';
  end if;

  if old.sealed_at is not null
     and new.sealed_at is distinct from old.sealed_at then
    raise exception 'Case sealed_at is historical and write-once'
      using errcode = '55000';
  end if;

  if old.archived_at is not null
     and new.archived_at is distinct from old.archived_at then
    raise exception 'Case archived_at is historical and write-once'
      using errcode = '55000';
  end if;

  if old.stage <> 'sealed'
     and new.stage = 'sealed'
     and new.sealed_at is null then
    raise exception 'Sealed Case requires sealed_at'
      using errcode = '23514';
  end if;

  if old.stage <> 'archived'
     and new.stage = 'archived'
     and new.archived_at is null then
    raise exception 'Archived Case requires archived_at'
      using errcode = '23514';
  end if;

  if new.sealed_at is distinct from old.sealed_at
     and new.stage <> 'sealed' then
    raise exception 'sealed_at may be set only by the seal transition'
      using errcode = '23514';
  end if;

  if new.archived_at is distinct from old.archived_at
     and new.stage <> 'archived' then
    raise exception 'archived_at may be set only by the archive transition'
      using errcode = '23514';
  end if;

  if new.stage in (
    'open_public',
    'in_review',
    'ready_for_finalization',
    'resolution_proposed',
    'in_challenge_window',
    'resolved',
    'sealed',
    'archived',
    'reopened'
  ) and new.visibility <> 'public' then
    raise exception 'Public Case stages require visibility=public'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_case_update
before update on public.cases
for each row execute function public.osi_v2_guard_case_update();

-- Report/Wire headers keep immutable ownership and same-parent pointers.
create function public.osi_v2_guard_report_header()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  state_value text;
begin
  if new.id is distinct from old.id
     or new.author_wallet is distinct from old.author_wallet
     or new.created_at is distinct from old.created_at then
    raise exception 'Report header identity and author are immutable'
      using errcode = '55000';
  end if;

  if tg_table_name = 'case_reports'
     and to_jsonb(new)->>'case_id' is distinct from to_jsonb(old)->>'case_id' then
    raise exception 'A Case Report cannot move to another Case'
      using errcode = '55000';
  end if;

  if new.current_version_id is distinct from old.current_version_id
     and new.current_version_id is not null then
    if tg_table_name = 'case_reports' then
      select lifecycle_state
        into state_value
        from public.case_report_versions
       where id = new.current_version_id
         and report_id = new.id;
    else
      select lifecycle_state
        into state_value
        from public.wire_report_versions
       where id = new.current_version_id
         and wire_report_id = new.id;
    end if;

    if state_value is null or state_value = 'draft' then
      raise exception 'Current version must be a submitted same-parent version'
        using errcode = '23503';
    end if;
  end if;

  if new.current_published_version_id
       is distinct from old.current_published_version_id
     and new.current_published_version_id is not null then
    if tg_table_name = 'case_reports' then
      select lifecycle_state
        into state_value
        from public.case_report_versions
       where id = new.current_published_version_id
         and report_id = new.id;
    else
      select lifecycle_state
        into state_value
        from public.wire_report_versions
       where id = new.current_published_version_id
         and wire_report_id = new.id;
    end if;

    if state_value is distinct from 'published' then
      raise exception 'Published pointer must target a published same-parent version'
        using errcode = '23503';
    end if;
  end if;

  if old.current_published_version_id is not null
     and new.current_published_version_id is null then
    raise exception 'Published pointer cannot be silently cleared'
      using errcode = '55000';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_case_report_header
before update on public.case_reports
for each row execute function public.osi_v2_guard_report_header();

create trigger osi_v2_guard_wire_report_header
before update on public.wire_reports
for each row execute function public.osi_v2_guard_report_header();

-- Exact Report/Wire version content freezes no later than submission.
create function public.osi_v2_valid_report_version_transition(
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
    or (old_state = 'draft' and new_state = 'submitted')
    or (old_state = 'submitted' and new_state = 'in_review')
    or (
      old_state = 'in_review'
      and new_state in ('published', 'rejected', 'revision_requested')
    )
    or (
      old_state in ('published', 'rejected', 'revision_requested')
      and new_state = 'superseded'
    )
$$;

create function public.osi_v2_guard_report_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_core jsonb;
  new_core jsonb;
begin
  old_core := to_jsonb(old) - array[
    'content_public_safe',
    'lifecycle_state',
    'published_at',
    'superseded_at',
    'superseded_by_version_id',
    'publication_receipt_id',
    'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'content_public_safe',
    'lifecycle_state',
    'published_at',
    'superseded_at',
    'superseded_by_version_id',
    'publication_receipt_id',
    'updated_at'
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

  if not public.osi_v2_valid_report_version_transition(
    old.lifecycle_state,
    new.lifecycle_state
  ) then
    raise exception 'Invalid Report version transition: % -> %',
      old.lifecycle_state, new.lifecycle_state
      using errcode = '23514';
  end if;

  if old.published_at is not null
     and new.published_at is distinct from old.published_at then
    raise exception 'Report published_at is write-once'
      using errcode = '55000';
  end if;

  if old.publication_receipt_id is not null
     and new.publication_receipt_id is distinct from old.publication_receipt_id then
    raise exception 'Report publication receipt is write-once'
      using errcode = '55000';
  end if;

  if old.superseded_by_version_id is not null
     and new.superseded_by_version_id
       is distinct from old.superseded_by_version_id then
    raise exception 'Report supersession link is write-once'
      using errcode = '55000';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_case_report_version
before update on public.case_report_versions
for each row execute function public.osi_v2_guard_report_version();

create trigger osi_v2_guard_wire_report_version
before update on public.wire_report_versions
for each row execute function public.osi_v2_guard_report_version();

create function public.osi_v2_enforce_report_version_author()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  expected_wallet text;
begin
  if tg_table_name = 'case_report_versions' then
    select author_wallet
      into expected_wallet
      from public.case_reports
     where id = new.report_id;
  else
    select author_wallet
      into expected_wallet
      from public.wire_reports
     where id = new.wire_report_id;
  end if;

  if expected_wallet is null
     or new.created_by_wallet is distinct from expected_wallet then
    raise exception 'Report version creator must match the immutable header author'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_enforce_case_report_version_author
before insert on public.case_report_versions
for each row execute function public.osi_v2_enforce_report_version_author();

create trigger osi_v2_enforce_wire_report_version_author
before insert on public.wire_report_versions
for each row execute function public.osi_v2_enforce_report_version_author();

-- Analyst applications preserve every exact submitted version.
create function public.osi_v2_guard_application_header()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_version_no integer;
  new_version_no integer;
  creator_wallet text;
  transition_ok boolean;
begin
  if new.id is distinct from old.id
     or new.applicant_wallet is distinct from old.applicant_wallet
     or new.origin is distinct from old.origin
     or new.event_receipt_id is distinct from old.event_receipt_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Analyst application identity/origin/applicant are immutable'
      using errcode = '55000';
  end if;

  transition_ok :=
    new.status = old.status
    or (old.status = 'submitted' and new.status in ('in_review', 'withdrawn'))
    or (
      old.status = 'in_review'
      and new.status in ('revision_requested', 'approved', 'rejected', 'withdrawn')
    )
    or (
      old.status = 'revision_requested'
      and new.status in ('in_review', 'withdrawn')
    );

  if not transition_ok then
    raise exception 'Invalid analyst application transition: % -> %',
      old.status, new.status
      using errcode = '23514';
  end if;

  if new.current_version_id is distinct from old.current_version_id
     and new.current_version_id is not null then
    select version_no, created_by_wallet
      into new_version_no, creator_wallet
      from public.analyst_application_versions
     where id = new.current_version_id
       and application_id = new.id;

    if creator_wallet is distinct from new.applicant_wallet then
      raise exception 'Application version creator must be the applicant'
        using errcode = '23514';
    end if;

    if old.current_version_id is not null then
      select version_no
        into old_version_no
        from public.analyst_application_versions
       where id = old.current_version_id;

      if new_version_no <= old_version_no then
        raise exception 'Application current version may only advance'
          using errcode = '23514';
      end if;
    end if;
  end if;

  if old.current_version_id is not null and new.current_version_id is null then
    raise exception 'Application current version cannot be cleared'
      using errcode = '55000';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_application_header
before update on public.analyst_applications
for each row execute function public.osi_v2_guard_application_header();

create function public.osi_v2_enforce_application_version_author()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  applicant text;
begin
  select applicant_wallet
    into applicant
    from public.analyst_applications
   where id = new.application_id;

  if applicant is null or new.created_by_wallet is distinct from applicant then
    raise exception 'Application version creator must match applicant wallet'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_enforce_application_version_author
before insert on public.analyst_application_versions
for each row execute function public.osi_v2_enforce_application_version_author();

-- AI Pack header points only to a non-superseded version of the same Pack.
create function public.osi_v2_guard_ai_pack_header()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  version_state text;
begin
  if new.id is distinct from old.id
     or new.case_id is distinct from old.case_id
     or new.pack_type is distinct from old.pack_type
     or new.created_at is distinct from old.created_at then
    raise exception 'AI Pack identity, Case and type are immutable'
      using errcode = '55000';
  end if;

  if new.current_version_id is distinct from old.current_version_id
     and new.current_version_id is not null then
    select lifecycle_state
      into version_state
      from public.ai_pack_versions
     where id = new.current_version_id
       and pack_id = new.id;

    if version_state is null or version_state = 'superseded' then
      raise exception 'AI Pack current pointer must target a live same-Pack version'
        using errcode = '23503';
    end if;
  end if;

  if old.current_version_id is not null and new.current_version_id is null then
    raise exception 'AI Pack current version cannot be cleared'
      using errcode = '55000';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_ai_pack_header
before update on public.ai_packs
for each row execute function public.osi_v2_guard_ai_pack_header();

create function public.osi_v2_valid_ai_pack_transition(
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
        'revision_requested',
        'approved',
        'rejected',
        'attached_to_resolution'
      )
      and new_state = 'superseded'
    )
$$;

create function public.osi_v2_guard_ai_pack_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_core jsonb;
  new_core jsonb;
begin
  old_core := to_jsonb(old) - array[
    'lifecycle_state',
    'is_stale',
    'stale_at',
    'stale_reason',
    'superseded_by_version_id',
    'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'lifecycle_state',
    'is_stale',
    'stale_at',
    'stale_reason',
    'superseded_by_version_id',
    'updated_at'
  ];

  if new_core is distinct from old_core then
    raise exception 'AI Pack version content/manifests/profile are immutable'
      using errcode = '55000';
  end if;

  if not public.osi_v2_valid_ai_pack_transition(
    old.lifecycle_state,
    new.lifecycle_state
  ) then
    raise exception 'Invalid AI Pack transition: % -> %',
      old.lifecycle_state, new.lifecycle_state
      using errcode = '23514';
  end if;

  if old.is_stale and not new.is_stale then
    raise exception 'A stale AI Pack version cannot be made fresh in place'
      using errcode = '55000';
  end if;

  if old.superseded_by_version_id is not null
     and new.superseded_by_version_id
       is distinct from old.superseded_by_version_id then
    raise exception 'AI Pack supersession link is write-once'
      using errcode = '55000';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_ai_pack_version
before update on public.ai_pack_versions
for each row execute function public.osi_v2_guard_ai_pack_version();

-- Evidence content/hash are immutable; moderation may only move forward.
create function public.osi_v2_guard_evidence_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_core jsonb;
  new_core jsonb;
  transition_ok boolean;
begin
  old_core := to_jsonb(old) - array[
    'is_public',
    'moderation_state',
    'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'is_public',
    'moderation_state',
    'updated_at'
  ];

  if new_core is distinct from old_core then
    raise exception 'Evidence content, reference, hash and author are immutable'
      using errcode = '55000';
  end if;

  transition_ok :=
    new.moderation_state = old.moderation_state
    or (
      old.moderation_state = 'pending'
      and new.moderation_state in ('approved', 'blocked')
    )
    or (
      old.moderation_state = 'approved'
      and new.moderation_state = 'blocked'
    );

  if not transition_ok then
    raise exception 'Invalid evidence moderation transition: % -> %',
      old.moderation_state, new.moderation_state
      using errcode = '23514';
  end if;

  if old.is_public and not new.is_public
     and new.moderation_state <> 'blocked' then
    raise exception 'Public evidence may be hidden only by a safety block'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_evidence_update
before update on public.evidence_items
for each row execute function public.osi_v2_guard_evidence_update();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'cases',
    'case_reports',
    'case_report_versions',
    'wire_reports',
    'wire_report_versions',
    'evidence_items',
    'analyst_applications',
    'analyst_profiles',
    'ai_packs',
    'ai_pack_versions',
    'ai_pack_owner_feedback',
    'case_resolutions',
    'challenges_v2',
    'reward_pledges',
    'reward_payments',
    'support_events',
    'case_initial_reviews',
    'case_report_reviews',
    'wire_report_reviews',
    'resolution_reviews',
    'challenge_reviews',
    'ai_pack_reviews',
    'analyst_application_reviews',
    'osi_nonces',
    'migration_crosswalk',
    'migration_manual_queue'
  ]
  loop
    execute format(
      'create trigger osi_v2_touch_updated_at before update on public.%I
       for each row execute function public.osi_v2_touch_updated_at()',
      table_name
    );
  end loop;
end
$$;

-- Analyst lifecycle is forward-only; tier and cached weight remain derived
-- fields, never discretionary identifiers.
create function public.osi_v2_guard_analyst_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transition_ok boolean;
begin
  if new.wallet is distinct from old.wallet
     or new.created_at is distinct from old.created_at then
    raise exception 'Analyst profile wallet and creation time are immutable'
      using errcode = '55000';
  end if;

  transition_ok :=
    new.status = old.status
    or (
      old.status = 'contributor'
      and new.status in ('analyst_candidate', 'probationary_analyst', 'revoked')
    )
    or (
      old.status = 'analyst_candidate'
      and new.status in ('probationary_analyst', 'revoked')
    )
    or (
      old.status = 'probationary_analyst'
      and new.status in ('verified_analyst', 'revoked')
    )
    or (
      old.status = 'verified_analyst'
      and new.status in ('probationary_analyst', 'senior_analyst', 'revoked')
    )
    or (
      old.status = 'senior_analyst'
      and new.status in ('verified_analyst', 'revoked')
    );

  if not transition_ok then
    raise exception 'Invalid analyst lifecycle transition: % -> %',
      old.status, new.status
      using errcode = '23514';
  end if;

  if old.verified_by is not null
     and new.verified_by is distinct from old.verified_by then
    raise exception 'Analyst verifier is write-once'
      using errcode = '55000';
  end if;

  if old.verified_receipt_id is not null
     and new.verified_receipt_id is distinct from old.verified_receipt_id then
    raise exception 'Analyst verification receipt is write-once'
      using errcode = '55000';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_analyst_profile
before update on public.analyst_profiles
for each row execute function public.osi_v2_guard_analyst_profile();

-- A resolution winner is set once from a quorum and never repointed.
create function public.osi_v2_validate_resolution_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state not in ('selection_open', 'resolved_legacy') then
    raise exception 'A native resolution must begin in selection_open'
      using errcode = '23514';
  end if;

  if new.state = 'selection_open'
     and (
       new.winning_report_version_id is not null
       or new.proposed_by_wallet is not null
       or new.finalized_by is not null
       or new.challenge_window_ends_at is not null
     ) then
    raise exception 'selection_open resolution cannot start with a winner/finalizer'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_validate_resolution_insert
before insert on public.case_resolutions
for each row execute function public.osi_v2_validate_resolution_insert();

create function public.osi_v2_guard_resolution()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transition_ok boolean;
begin
  if new.id is distinct from old.id
     or new.case_id is distinct from old.case_id
     or new.event_receipt_id is distinct from old.event_receipt_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Resolution identity, Case and creation receipt are immutable'
      using errcode = '55000';
  end if;

  if old.winning_report_version_id is not null
     and new.winning_report_version_id
       is distinct from old.winning_report_version_id then
    raise exception 'Resolution winner is permanently bound to its exact version'
      using errcode = '55000';
  end if;

  if old.proposed_by_wallet is not null
     and new.proposed_by_wallet is distinct from old.proposed_by_wallet then
    raise exception 'Resolution proposer is write-once'
      using errcode = '55000';
  end if;

  if old.finalized_by is not null
     and new.finalized_by is distinct from old.finalized_by then
    raise exception 'Resolution finalization mode is write-once'
      using errcode = '55000';
  end if;

  transition_ok :=
    new.state = old.state
    or (old.state = 'selection_open' and new.state = 'proposed')
    or (old.state = 'proposed' and new.state in ('in_challenge_window', 'reopened'))
    or (
      old.state = 'in_challenge_window'
      and new.state in ('sealed', 'reopened')
    )
    or (old.state = 'sealed' and new.state = 'reopened');

  if not transition_ok then
    raise exception 'Invalid resolution transition: % -> %', old.state, new.state
      using errcode = '23514';
  end if;

  if old.state = 'selection_open' and new.state = 'proposed' then
    if new.winning_report_version_id is null
       or new.proposed_by_wallet is null
       or new.finalized_by is null then
      raise exception 'Finalized resolution requires winner, proposer and finalization mode'
        using errcode = '23514';
    end if;
  end if;

  if new.state = 'in_challenge_window'
     and (
       new.challenge_window_ends_at is null
       or new.challenge_window_ends_at <= statement_timestamp()
     ) then
    raise exception 'Challenge window must end in the future'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_resolution
before update on public.case_resolutions
for each row execute function public.osi_v2_guard_resolution();

create function public.osi_v2_enforce_resolution_winner_case()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  winner_case_id uuid;
begin
  if new.winning_report_version_id is null then
    return new;
  end if;

  select report.case_id
    into winner_case_id
    from public.case_report_versions as version
    join public.case_reports as report
      on report.id = version.report_id
   where version.id = new.winning_report_version_id;

  if winner_case_id is distinct from new.case_id then
    raise exception 'Resolution winner must belong to the same Case'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_enforce_resolution_winner_case
before insert or update of winning_report_version_id, case_id
on public.case_resolutions
for each row execute function public.osi_v2_enforce_resolution_winner_case();

-- Challenge state, typed target and bad-faith phase remain forward-only.
create function public.osi_v2_guard_challenge()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transition_ok boolean;
  bad_faith_transition_ok boolean;
  old_core jsonb;
  new_core jsonb;
begin
  old_core := to_jsonb(old) - array[
    'state',
    'admitted_by_wallet',
    'review_deadline_at',
    'expired_reason',
    'bad_faith_state',
    'opened_receipt_id',
    'resolved_receipt_id',
    'bad_faith_receipt_id',
    'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'state',
    'admitted_by_wallet',
    'review_deadline_at',
    'expired_reason',
    'bad_faith_state',
    'opened_receipt_id',
    'resolved_receipt_id',
    'bad_faith_receipt_id',
    'updated_at'
  ];

  if new_core is distinct from old_core then
    raise exception 'Challenge actor, target, evidence and cooldown binding are immutable'
      using errcode = '55000';
  end if;

  transition_ok :=
    new.state = old.state
    or (
      old.state = 'submitted'
      and new.state in ('admissibility_review', 'withdrawn', 'expired')
    )
    or (
      old.state = 'admissibility_review'
      and new.state in ('open', 'rejected', 'withdrawn', 'expired')
    )
    or (
      old.state = 'open'
      and new.state in ('under_review', 'withdrawn', 'expired')
    )
    or (
      old.state = 'under_review'
      and new.state in ('accepted', 'rejected', 'withdrawn', 'expired')
    );

  if not transition_ok then
    raise exception 'Invalid challenge transition: % -> %', old.state, new.state
      using errcode = '23514';
  end if;

  if old.admitted_by_wallet is not null
     and new.admitted_by_wallet is distinct from old.admitted_by_wallet then
    raise exception 'Challenge admissibility actor is write-once'
      using errcode = '55000';
  end if;

  if old.opened_receipt_id is not null
     and new.opened_receipt_id is distinct from old.opened_receipt_id then
    raise exception 'Challenge opening receipt is write-once'
      using errcode = '55000';
  end if;

  if old.resolved_receipt_id is not null
     and new.resolved_receipt_id is distinct from old.resolved_receipt_id then
    raise exception 'Challenge terminal receipt is write-once'
      using errcode = '55000';
  end if;

  if old.bad_faith_receipt_id is not null
     and new.bad_faith_receipt_id is distinct from old.bad_faith_receipt_id then
    raise exception 'Challenge bad-faith receipt is write-once'
      using errcode = '55000';
  end if;

  if new.state in ('accepted', 'rejected', 'withdrawn', 'expired')
     and new.resolved_receipt_id is null then
    raise exception 'Terminal challenge state requires an exact receipt'
      using errcode = '23514';
  end if;

  bad_faith_transition_ok :=
    new.bad_faith_state = old.bad_faith_state
    or (
      old.bad_faith_state = 'none'
      and new.bad_faith_state = 'under_review'
      and new.state in ('rejected', 'withdrawn', 'expired')
    )
    or (
      old.bad_faith_state = 'under_review'
      and new.bad_faith_state in ('confirmed', 'dismissed')
      and new.state in ('rejected', 'withdrawn', 'expired')
      and new.bad_faith_receipt_id is not null
    );

  if not bad_faith_transition_ok then
    raise exception 'Invalid challenge bad-faith transition: % -> %',
      old.bad_faith_state, new.bad_faith_state
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_challenge
before update on public.challenges_v2
for each row execute function public.osi_v2_guard_challenge();

-- Direct wallet-to-wallet money records can advance only after the modeled
-- transfer/confirmation events.
create function public.osi_v2_validate_reward_pledge_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  case_owner text;
  receipt record;
begin
  select submitted_by_wallet
    into case_owner
    from public.cases
   where id = new.case_id;

  if new.pledger_wallet is distinct from case_owner then
    raise exception 'Only the Case owner may pledge its reward'
      using errcode = '42501';
  end if;

  select event_version, event_type, target_type, target_id, actor_wallet
    into receipt
    from public.event_receipts
   where id = new.created_receipt_id;

  if receipt.event_version = 'OSI2'
     and (
       receipt.event_type <> 'REWARD_PLEDGED'
       or receipt.target_type <> 'reward'
       or receipt.target_id is distinct from new.id::text
       or receipt.actor_wallet is distinct from new.pledger_wallet
     ) then
    raise exception 'Reward pledge receipt is not exactly bound'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_validate_reward_pledge_insert
before insert on public.reward_pledges
for each row execute function public.osi_v2_validate_reward_pledge_insert();

create function public.osi_v2_guard_reward_pledge()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transition_ok boolean;
begin
  if new.id is distinct from old.id
     or new.case_id is distinct from old.case_id
     or new.pledger_wallet is distinct from old.pledger_wallet
     or new.amount_lamports is distinct from old.amount_lamports
     or new.token is distinct from old.token
     or new.created_receipt_id is distinct from old.created_receipt_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Reward pledge identity, owner and amount are immutable'
      using errcode = '55000';
  end if;

  if old.winning_report_version_id is not null
     and new.winning_report_version_id
       is distinct from old.winning_report_version_id then
    raise exception 'Assigned reward winner is immutable'
      using errcode = '55000';
  end if;

  transition_ok :=
    new.state = old.state
    or (
      old.state = 'pledged'
      and new.state in ('assigned', 'cancelled', 'expired')
    )
    or (old.state = 'assigned' and new.state in ('paid', 'expired'));

  if not transition_ok then
    raise exception 'Invalid reward pledge transition: % -> %', old.state, new.state
      using errcode = '23514';
  end if;

  if old.state <> 'paid' and new.state = 'paid'
     and not exists (
       select 1
       from public.reward_payments as payment
       where payment.pledge_id = new.id
         and payment.state = 'confirmed'
         and payment.amount_lamports = new.amount_lamports
         and payment.from_wallet = new.pledger_wallet
     ) then
    raise exception 'Reward cannot be marked paid without exact confirmed payment'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_reward_pledge
before update on public.reward_pledges
for each row execute function public.osi_v2_guard_reward_pledge();

create function public.osi_v2_enforce_reward_winner_case()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  winner_case_id uuid;
begin
  if new.winning_report_version_id is null then
    return new;
  end if;

  select report.case_id
    into winner_case_id
    from public.case_report_versions as version
    join public.case_reports as report
      on report.id = version.report_id
   where version.id = new.winning_report_version_id;

  if winner_case_id is distinct from new.case_id then
    raise exception 'Reward winner must belong to the pledged Case'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_enforce_reward_winner_case
before insert or update of winning_report_version_id, case_id
on public.reward_pledges
for each row execute function public.osi_v2_enforce_reward_winner_case();

create function public.osi_v2_validate_reward_payment_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  pledge record;
  expected_recipient text;
begin
  select *
    into pledge
    from public.reward_pledges
   where id = new.pledge_id;

  select report.author_wallet
    into expected_recipient
    from public.case_report_versions as version
    join public.case_reports as report on report.id = version.report_id
   where version.id = pledge.winning_report_version_id;

  if pledge.state <> 'assigned'
     or new.from_wallet is distinct from pledge.pledger_wallet
     or new.to_wallet is distinct from expected_recipient
     or new.amount_lamports is distinct from pledge.amount_lamports then
    raise exception 'Reward payment must exactly match assigned pledge and winner'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_validate_reward_payment_insert
before insert on public.reward_payments
for each row execute function public.osi_v2_validate_reward_payment_insert();

create function public.osi_v2_guard_reward_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transition_ok boolean;
  old_core jsonb;
  new_core jsonb;
begin
  old_core := to_jsonb(old) - array[
    'tx_sig',
    'state',
    'confirmed_at',
    'event_receipt_id',
    'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'tx_sig',
    'state',
    'confirmed_at',
    'event_receipt_id',
    'updated_at'
  ];

  if new_core is distinct from old_core then
    raise exception 'Reward payment intent, wallets and amount are immutable'
      using errcode = '55000';
  end if;

  transition_ok :=
    new.state = old.state
    or (
      old.state = 'initiated'
      and new.state in ('submitted', 'failed', 'timed_out')
    )
    or (
      old.state = 'submitted'
      and new.state in ('confirmed', 'failed', 'timed_out')
    );

  if not transition_ok then
    raise exception 'Invalid reward payment transition: % -> %', old.state, new.state
      using errcode = '23514';
  end if;

  if old.tx_sig is not null and new.tx_sig is distinct from old.tx_sig then
    raise exception 'Reward transaction signature is write-once'
      using errcode = '55000';
  end if;

  if old.event_receipt_id is not null
     and new.event_receipt_id is distinct from old.event_receipt_id then
    raise exception 'Reward payment receipt is write-once'
      using errcode = '55000';
  end if;

  if old.state <> 'confirmed' and new.state = 'confirmed' then
    if not exists (
      select 1
      from public.event_receipts as receipt
      where receipt.id = new.event_receipt_id
        and receipt.event_version = 'OSI2'
        and receipt.event_type = 'REWARD_PAID'
        and receipt.target_type = 'reward'
        and receipt.target_id = new.id::text
        and receipt.actor_wallet = new.from_wallet
        and receipt.tx_sig = new.tx_sig
    ) then
      raise exception 'Confirmed reward requires exact REWARD_PAID receipt'
        using errcode = '23514';
    end if;
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_reward_payment
before update on public.reward_payments
for each row execute function public.osi_v2_guard_reward_payment();

create function public.osi_v2_validate_support_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  expected_wallet text;
  analyst_ok boolean;
begin
  if new.support_type = 'report_author' then
    if new.case_report_version_id is not null then
      select report.author_wallet
        into expected_wallet
        from public.case_report_versions as version
        join public.case_reports as report on report.id = version.report_id
       where version.id = new.case_report_version_id;
    else
      select report.author_wallet
        into expected_wallet
        from public.wire_report_versions as version
        join public.wire_reports as report on report.id = version.wire_report_id
       where version.id = new.wire_report_version_id;
    end if;

    if new.target_wallet is distinct from expected_wallet then
      raise exception 'Report support target must be the exact Report author'
        using errcode = '23514';
    end if;
  else
    select
      profile.wallet,
      profile.status in (
        'probationary_analyst',
        'verified_analyst',
        'senior_analyst'
      )
      and profile.verified
      and profile.approved
      into expected_wallet, analyst_ok
      from public.analyst_profiles as profile
     where profile.wallet = new.analyst_wallet;

    if analyst_ok is not true
       or new.target_wallet is distinct from expected_wallet then
      raise exception 'Analyst support target must be an eligible analyst'
        using errcode = '23514';
    end if;
  end if;

  return new;
end
$$;

create trigger osi_v2_validate_support_target
before insert on public.support_events
for each row execute function public.osi_v2_validate_support_target();

create function public.osi_v2_guard_support_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  transition_ok boolean;
  old_core jsonb;
  new_core jsonb;
begin
  old_core := to_jsonb(old) - array[
    'tx_sig',
    'state',
    'event_receipt_id',
    'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'tx_sig',
    'state',
    'event_receipt_id',
    'updated_at'
  ];

  if new_core is distinct from old_core then
    raise exception 'Support sender, recipient, type and amount are immutable'
      using errcode = '55000';
  end if;

  transition_ok :=
    new.state = old.state
    or (
      old.state = 'submitted'
      and new.state in ('confirmed', 'failed')
    );

  if not transition_ok then
    raise exception 'Invalid support transition: % -> %', old.state, new.state
      using errcode = '23514';
  end if;

  if old.tx_sig is not null and new.tx_sig is distinct from old.tx_sig then
    raise exception 'Support transaction signature is write-once'
      using errcode = '55000';
  end if;

  if old.event_receipt_id is not null
     and new.event_receipt_id is distinct from old.event_receipt_id then
    raise exception 'Support receipt is write-once'
      using errcode = '55000';
  end if;

  if old.state <> 'confirmed' and new.state = 'confirmed' then
    if not exists (
      select 1
      from public.event_receipts as receipt
      where receipt.id = new.event_receipt_id
        and receipt.event_version = 'OSI2'
        and receipt.event_type = 'SUPPORT_SENT'
        and receipt.target_type = 'support'
        and receipt.target_id = new.id::text
        and receipt.actor_wallet = new.from_wallet
        and receipt.tx_sig = new.tx_sig
    ) then
      raise exception 'Confirmed support requires exact SUPPORT_SENT receipt'
        using errcode = '23514';
    end if;
  end if;

  return new;
end
$$;

create trigger osi_v2_guard_support_event
before update on public.support_events
for each row execute function public.osi_v2_guard_support_event();

-- A review is valid only while its exact target is in the modeled review state.
create function public.osi_v2_enforce_review_target_state()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_state text;
  bad_faith_state_value text;
begin
  if tg_table_name = 'case_initial_reviews' then
    select stage
      into target_state
      from public.cases
     where id = new.case_id;
    if target_state <> 'initial_review' then
      raise exception 'Case initial review requires initial_review stage'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'case_report_reviews' then
    select lifecycle_state
      into target_state
      from public.case_report_versions
     where id = new.report_version_id;
    if target_state <> 'in_review' then
      raise exception 'Case Report review requires in_review version'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'wire_report_reviews' then
    select lifecycle_state
      into target_state
      from public.wire_report_versions
     where id = new.wire_report_version_id;
    if target_state <> 'in_review' then
      raise exception 'Wire Report review requires in_review version'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'resolution_reviews' then
    select state
      into target_state
      from public.case_resolutions
     where id = new.resolution_id;
    if target_state <> 'selection_open' then
      raise exception 'Resolution review requires selection_open state'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'challenge_reviews' then
    select state, bad_faith_state
      into target_state, bad_faith_state_value
      from public.challenges_v2
     where id = new.challenge_id;

    if new.phase = 'merit'
       and target_state not in ('open', 'under_review') then
      raise exception 'Challenge merit review requires open/under_review state'
        using errcode = '23514';
    end if;

    if new.phase = 'bad_faith'
       and (
         target_state not in ('rejected', 'withdrawn', 'expired')
         or bad_faith_state_value <> 'under_review'
       ) then
      raise exception 'Bad-faith review requires its separate opened phase'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'ai_pack_reviews' then
    select lifecycle_state
      into target_state
      from public.ai_pack_versions
     where id = new.pack_version_id;
    if target_state not in ('review_required', 'supported', 'disputed') then
      raise exception 'AI Pack review requires an active review state'
        using errcode = '23514';
    end if;

  elsif tg_table_name = 'analyst_application_reviews' then
    select application.status
      into target_state
      from public.analyst_application_versions as version
      join public.analyst_applications as application
        on application.id = version.application_id
     where version.id = new.application_version_id;
    if target_state <> 'in_review' then
      raise exception 'Application review requires in_review state'
        using errcode = '23514';
    end if;
  end if;

  return new;
end
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'case_initial_reviews',
    'case_report_reviews',
    'wire_report_reviews',
    'resolution_reviews',
    'challenge_reviews',
    'ai_pack_reviews',
    'analyst_application_reviews'
  ]
  loop
    execute format(
      'create trigger osi_v2_enforce_review_target_state
       before insert on public.%I
       for each row execute function public.osi_v2_enforce_review_target_state()',
      table_name
    );
  end loop;
end
$$;

-- Native review receipts bind the exact reviewer and exact immutable target.
create function public.osi_v2_bind_review_receipt()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_column text := tg_argv[0];
  expected_target_type text := tg_argv[1];
  cast_event text := tg_argv[2];
  revised_event text := tg_argv[3];
  target_value uuid;
  has_history boolean;
  receipt record;
  sql_text text;
begin
  target_value := (to_jsonb(new)->>target_column)::uuid;

  select
    event_version,
    event_type,
    target_type,
    target_id,
    actor_wallet,
    actor_role,
    decision,
    weight,
    reason_code
    into receipt
    from public.event_receipts
   where id = new.event_receipt_id;

  if receipt.event_version is distinct from 'OSI2' then
    return new;
  end if;

  sql_text := format(
    'select exists (
       select 1
       from public.%I as prior
       where prior.%I = $1
         and prior.reviewer_wallet = $2
         and prior.id <> $3',
    tg_table_name,
    target_column
  );

  if tg_table_name = 'challenge_reviews' then
    sql_text := sql_text || ' and prior.phase = $4';
    sql_text := sql_text || ')';
    execute sql_text
      into has_history
      using target_value, new.reviewer_wallet, new.id, new.phase;
  else
    sql_text := sql_text || ')';
    execute sql_text
      into has_history
      using target_value, new.reviewer_wallet, new.id;
  end if;

  if receipt.target_type is distinct from expected_target_type
     or receipt.target_id is distinct from target_value::text
     or receipt.actor_wallet is distinct from new.reviewer_wallet
     or receipt.decision is distinct from new.decision
     or receipt.reason_code is distinct from new.reason_code
     or (
       new.weight > 0
       and receipt.weight is distinct from new.weight
     )
     or (
       new.weight = 0
       and receipt.weight is not null
     ) then
    raise exception 'Review receipt is not bound to exact reviewer, target, decision, weight and reason'
      using errcode = '23514';
  end if;

  if tg_table_name = 'case_initial_reviews'
     and to_jsonb(new)->>'reviewer_role' = 'maintainer'
     and receipt.actor_role is distinct from 'maintainer' then
    raise exception 'Maintainer initial review requires maintainer receipt role'
      using errcode = '42501';
  end if;

  if not (
    tg_table_name = 'case_initial_reviews'
    and to_jsonb(new)->>'reviewer_role' = 'maintainer'
  ) and receipt.actor_role not in ('analyst', 'senior') then
    raise exception 'Counted review receipt requires analyst/senior role'
      using errcode = '42501';
  end if;

  if has_history and receipt.event_type is distinct from revised_event then
    raise exception 'Revised review requires % receipt', revised_event
      using errcode = '23514';
  end if;

  if not has_history and receipt.event_type is distinct from cast_event then
    raise exception 'First review requires % receipt', cast_event
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_bind_case_initial_review_receipt
before insert on public.case_initial_reviews
for each row execute function public.osi_v2_bind_review_receipt(
  'case_id',
  'case',
  'CASE_INITIAL_REVIEW_CAST',
  'CASE_INITIAL_REVIEW_REVISED'
);

create trigger osi_v2_bind_case_report_review_receipt
before insert on public.case_report_reviews
for each row execute function public.osi_v2_bind_review_receipt(
  'report_version_id',
  'report_version',
  'CASE_REPORT_REVIEW_CAST',
  'CASE_REPORT_REVIEW_REVISED'
);

create trigger osi_v2_bind_wire_report_review_receipt
before insert on public.wire_report_reviews
for each row execute function public.osi_v2_bind_review_receipt(
  'wire_report_version_id',
  'wire_version',
  'WIRE_REPORT_REVIEW_CAST',
  'WIRE_REPORT_REVIEW_REVISED'
);

create trigger osi_v2_bind_resolution_review_receipt
before insert on public.resolution_reviews
for each row execute function public.osi_v2_bind_review_receipt(
  'resolution_id',
  'resolution',
  'RESOLUTION_REVIEW_CAST',
  'RESOLUTION_REVIEW_REVISED'
);

create trigger osi_v2_bind_challenge_merit_review_receipt
before insert on public.challenge_reviews
for each row
when (new.phase = 'merit')
execute function public.osi_v2_bind_review_receipt(
  'challenge_id',
  'challenge',
  'CHALLENGE_REVIEW_CAST',
  'CHALLENGE_REVIEW_REVISED'
);

create trigger osi_v2_bind_challenge_bad_faith_review_receipt
before insert on public.challenge_reviews
for each row
when (new.phase = 'bad_faith')
execute function public.osi_v2_bind_review_receipt(
  'challenge_id',
  'challenge',
  'CHALLENGE_BAD_FAITH_REVIEW_CAST',
  'CHALLENGE_BAD_FAITH_REVIEW_REVISED'
);

create trigger osi_v2_bind_ai_pack_review_receipt
before insert on public.ai_pack_reviews
for each row execute function public.osi_v2_bind_review_receipt(
  'pack_version_id',
  'pack_version',
  'AI_PACK_REVIEW_CAST',
  'AI_PACK_REVIEW_REVISED'
);

create trigger osi_v2_bind_application_review_receipt
before insert on public.analyst_application_reviews
for each row execute function public.osi_v2_bind_review_receipt(
  'application_version_id',
  'application_version',
  'ANALYST_APPLICATION_REVIEW_CAST',
  'ANALYST_APPLICATION_REVIEW_REVISED'
);

-- Native counted review weight must match an eligible analyst's current
-- server-derived snapshot cache at cast time.
create function public.osi_v2_enforce_review_weight()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  receipt_version text;
  profile record;
begin
  if new.weight = 0 then
    return new;
  end if;

  select event_version
    into receipt_version
    from public.event_receipts
   where id = new.event_receipt_id;

  if receipt_version is distinct from 'OSI2' then
    return new;
  end if;

  select status, verified, approved, weight_cached
    into profile
    from public.analyst_profiles
   where wallet = new.reviewer_wallet;

  if profile.status is null
     or profile.status not in (
       'probationary_analyst',
       'verified_analyst',
       'senior_analyst'
     )
     or profile.verified is not true
     or profile.approved is not true then
    raise exception 'Native counted review requires an eligible analyst'
      using errcode = '42501';
  end if;

  if profile.weight_cached is distinct from new.weight then
    raise exception 'Review weight must equal the server-derived weight snapshot'
      using errcode = '23514';
  end if;

  return new;
end
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'case_initial_reviews',
    'case_report_reviews',
    'wire_report_reviews',
    'resolution_reviews',
    'challenge_reviews',
    'ai_pack_reviews',
    'analyst_application_reviews'
  ]
  loop
    execute format(
      'create trigger osi_v2_enforce_review_weight
       before insert on public.%I
       for each row execute function public.osi_v2_enforce_review_weight()',
      table_name
    );
  end loop;
end
$$;

-- A historical review may only change from active to superseded. The successor
-- is validated at transaction commit so the deferrable self-FK and partial
-- active unique index can be satisfied atomically.
create function public.osi_v2_guard_review_history_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_core jsonb;
  new_core jsonb;
begin
  old_core := to_jsonb(old) - array['is_active', 'superseded_by', 'updated_at'];
  new_core := to_jsonb(new) - array['is_active', 'superseded_by', 'updated_at'];

  if new_core is distinct from old_core then
    raise exception 'Historical review decision/weight/target are immutable'
      using errcode = '55000';
  end if;

  if old.is_active is not true
     or new.is_active is not false
     or old.superseded_by is not null
     or new.superseded_by is null then
    raise exception 'Review update must supersede one active row exactly once'
      using errcode = '55000';
  end if;

  return new;
end
$$;

create function public.osi_v2_validate_review_successor()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_column text := tg_argv[0];
  extra_column text := nullif(tg_argv[1], '');
  target_value text;
  extra_value text;
  successor_ok boolean;
  sql_text text;
begin
  if new.is_active or new.superseded_by is null then
    return null;
  end if;

  target_value := to_jsonb(old)->>target_column;
  extra_value := case
    when extra_column is null then null
    else to_jsonb(old)->>extra_column
  end;

  sql_text := format(
    'select exists (
       select 1
       from public.%I as successor
       where successor.id = $1
         and successor.%I::text = $2
         and successor.reviewer_wallet = $3
         and successor.is_active = true
         and successor.superseded_by is null
         and successor.created_at >= $4',
    tg_table_name,
    target_column
  );

  if extra_column is null then
    sql_text := sql_text || ')';
    execute sql_text
      into successor_ok
      using new.superseded_by, target_value, old.reviewer_wallet, old.created_at;
  else
    sql_text := sql_text || format(' and successor.%I::text = $5)', extra_column);
    execute sql_text
      into successor_ok
      using
        new.superseded_by,
        target_value,
        old.reviewer_wallet,
        old.created_at,
        extra_value;
  end if;

  if not successor_ok then
    raise exception 'Review successor must be active and match target/reviewer/phase'
      using errcode = '23514';
  end if;

  return null;
end
$$;

do $$
declare
  item record;
begin
  for item in
    select *
    from (values
      ('case_initial_reviews', 'case_id', ''),
      ('case_report_reviews', 'report_version_id', ''),
      ('wire_report_reviews', 'wire_report_version_id', ''),
      ('resolution_reviews', 'resolution_id', ''),
      ('challenge_reviews', 'challenge_id', 'phase'),
      ('ai_pack_reviews', 'pack_version_id', ''),
      ('analyst_application_reviews', 'application_version_id', '')
    ) as definitions(table_name, target_column, extra_column)
  loop
    execute format(
      'create trigger osi_v2_guard_review_history_update
       before update on public.%I
       for each row execute function public.osi_v2_guard_review_history_update()',
      item.table_name
    );

    execute format(
      'create constraint trigger osi_v2_validate_review_successor
       after update on public.%I
       deferrable initially deferred
       for each row execute function public.osi_v2_validate_review_successor(%L, %L)',
      item.table_name,
      item.target_column,
      item.extra_column
    );
  end loop;
end
$$;

-- Database-level no-self-review and same-Case candidate enforcement.
create function public.osi_v2_enforce_no_self_review()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  reviewer text := new.reviewer_wallet;
  excluded_wallets text[] := array[]::text[];
  target_uuid uuid;
  challenge_row public.challenges_v2%rowtype;
  wallet_one text;
  wallet_two text;
begin
  if tg_table_name = 'case_initial_reviews' then
    select submitted_by_wallet
      into wallet_one
      from public.cases
     where id = new.case_id;
    excluded_wallets := array_append(excluded_wallets, wallet_one);

    if new.reviewer_role = 'maintainer' then
      select actor_wallet
        into wallet_two
        from public.event_receipts
       where id = new.event_receipt_id
         and event_version = 'OSI2'
         and actor_role = 'maintainer';

      if wallet_two is distinct from reviewer then
        raise exception 'Maintainer initial-open route requires a maintainer receipt'
          using errcode = '42501';
      end if;
    end if;

  elsif tg_table_name = 'case_report_reviews' then
    select report.author_wallet
      into wallet_one
      from public.case_report_versions as version
      join public.case_reports as report on report.id = version.report_id
     where version.id = new.report_version_id;
    excluded_wallets := array_append(excluded_wallets, wallet_one);

  elsif tg_table_name = 'wire_report_reviews' then
    select report.author_wallet
      into wallet_one
      from public.wire_report_versions as version
      join public.wire_reports as report on report.id = version.wire_report_id
     where version.id = new.wire_report_version_id;
    excluded_wallets := array_append(excluded_wallets, wallet_one);

  elsif tg_table_name = 'resolution_reviews' then
    select case_row.submitted_by_wallet, report.author_wallet
      into wallet_one, wallet_two
      from public.case_resolutions as resolution
      join public.cases as case_row on case_row.id = resolution.case_id
      join public.case_report_versions as version
        on version.id = new.candidate_report_version_id
      join public.case_reports as report on report.id = version.report_id
     where resolution.id = new.resolution_id;
    excluded_wallets := array_append(excluded_wallets, wallet_one);
    excluded_wallets := array_append(excluded_wallets, wallet_two);

  elsif tg_table_name = 'challenge_reviews' then
    select *
      into challenge_row
      from public.challenges_v2
     where id = new.challenge_id;

    excluded_wallets := array_append(
      excluded_wallets,
      challenge_row.challenger_wallet
    );

    if challenge_row.case_id is not null then
      select submitted_by_wallet
        into wallet_one
        from public.cases
       where id = challenge_row.case_id;
      excluded_wallets := array_append(excluded_wallets, wallet_one);

    elsif challenge_row.case_report_version_id is not null then
      select report.author_wallet, case_row.submitted_by_wallet
        into wallet_one, wallet_two
        from public.case_report_versions as version
        join public.case_reports as report on report.id = version.report_id
        join public.cases as case_row on case_row.id = report.case_id
       where version.id = challenge_row.case_report_version_id;
      excluded_wallets := array_append(excluded_wallets, wallet_one);
      excluded_wallets := array_append(excluded_wallets, wallet_two);

    elsif challenge_row.wire_report_version_id is not null then
      select report.author_wallet
        into wallet_one
        from public.wire_report_versions as version
        join public.wire_reports as report on report.id = version.wire_report_id
       where version.id = challenge_row.wire_report_version_id;
      excluded_wallets := array_append(excluded_wallets, wallet_one);

    elsif challenge_row.ai_pack_version_id is not null then
      select version.created_by_wallet, case_row.submitted_by_wallet
        into wallet_one, wallet_two
        from public.ai_pack_versions as version
        join public.ai_packs as pack on pack.id = version.pack_id
        join public.cases as case_row on case_row.id = pack.case_id
       where version.id = challenge_row.ai_pack_version_id;
      excluded_wallets := array_append(excluded_wallets, wallet_one);
      excluded_wallets := array_append(excluded_wallets, wallet_two);

    elsif challenge_row.resolution_id is not null then
      select case_row.submitted_by_wallet, report.author_wallet
        into wallet_one, wallet_two
        from public.case_resolutions as resolution
        join public.cases as case_row on case_row.id = resolution.case_id
        left join public.case_report_versions as version
          on version.id = resolution.winning_report_version_id
        left join public.case_reports as report on report.id = version.report_id
       where resolution.id = challenge_row.resolution_id;
      excluded_wallets := array_append(excluded_wallets, wallet_one);
      excluded_wallets := array_append(excluded_wallets, wallet_two);
    end if;

  elsif tg_table_name = 'ai_pack_reviews' then
    select version.created_by_wallet, case_row.submitted_by_wallet
      into wallet_one, wallet_two
      from public.ai_pack_versions as version
      join public.ai_packs as pack on pack.id = version.pack_id
      join public.cases as case_row on case_row.id = pack.case_id
     where version.id = new.pack_version_id;
    excluded_wallets := array_append(excluded_wallets, wallet_one);
    excluded_wallets := array_append(excluded_wallets, wallet_two);

  elsif tg_table_name = 'analyst_application_reviews' then
    select application.applicant_wallet
      into wallet_one
      from public.analyst_application_versions as version
      join public.analyst_applications as application
        on application.id = version.application_id
     where version.id = new.application_version_id;
    excluded_wallets := array_append(excluded_wallets, wallet_one);
  end if;

  if reviewer = any (array_remove(excluded_wallets, null)) then
    raise exception 'Self-review is forbidden for this exact target'
      using errcode = '42501';
  end if;

  return new;
end
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'case_initial_reviews',
    'case_report_reviews',
    'wire_report_reviews',
    'resolution_reviews',
    'challenge_reviews',
    'ai_pack_reviews',
    'analyst_application_reviews'
  ]
  loop
    execute format(
      'create trigger osi_v2_enforce_no_self_review
       before insert on public.%I
       for each row execute function public.osi_v2_enforce_no_self_review()',
      table_name
    );
  end loop;
end
$$;

create function public.osi_v2_enforce_resolution_review_case()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  resolution_case_id uuid;
  candidate_case_id uuid;
begin
  select case_id
    into resolution_case_id
    from public.case_resolutions
   where id = new.resolution_id;

  select report.case_id
    into candidate_case_id
    from public.case_report_versions as version
    join public.case_reports as report on report.id = version.report_id
   where version.id = new.candidate_report_version_id;

  if resolution_case_id is distinct from candidate_case_id then
    raise exception 'Resolution review candidate must belong to the same Case'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_enforce_resolution_review_case
before insert on public.resolution_reviews
for each row execute function public.osi_v2_enforce_resolution_review_case();

-- Owner feedback is advisory, owner-only and historically superseded.
create function public.osi_v2_bind_owner_feedback()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  expected_owner text;
  receipt record;
begin
  select case_row.submitted_by_wallet
    into expected_owner
    from public.ai_pack_versions as version
    join public.ai_packs as pack on pack.id = version.pack_id
    join public.cases as case_row on case_row.id = pack.case_id
   where version.id = new.pack_version_id;

  if new.owner_wallet is distinct from expected_owner then
    raise exception 'AI Pack owner feedback requires the proven Case owner'
      using errcode = '42501';
  end if;

  select event_version, event_type, target_type, target_id, actor_wallet
    into receipt
    from public.event_receipts
   where id = new.event_receipt_id;

  if receipt.event_version = 'OSI2'
     and (
       receipt.event_type <> 'AI_PACK_OWNER_FEEDBACK_SUBMITTED'
       or receipt.target_type <> 'pack_owner_feedback'
       or receipt.target_id is distinct from new.id::text
       or receipt.actor_wallet is distinct from new.owner_wallet
     ) then
    raise exception 'Owner-feedback receipt is not exactly bound'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_bind_owner_feedback
before insert on public.ai_pack_owner_feedback
for each row execute function public.osi_v2_bind_owner_feedback();

create function public.osi_v2_guard_owner_feedback_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_core jsonb;
  new_core jsonb;
begin
  old_core := to_jsonb(old) - array['is_active', 'superseded_by', 'updated_at'];
  new_core := to_jsonb(new) - array['is_active', 'superseded_by', 'updated_at'];

  if new_core is distinct from old_core
     or old.is_active is not true
     or new.is_active is not false
     or old.superseded_by is not null
     or new.superseded_by is null then
    raise exception 'Owner feedback may only be superseded by a new note'
      using errcode = '55000';
  end if;

  return new;
end
$$;

create function public.osi_v2_validate_owner_feedback_successor()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  successor_ok boolean;
begin
  if new.is_active or new.superseded_by is null then
    return null;
  end if;

  select exists (
    select 1
    from public.ai_pack_owner_feedback as successor
    where successor.id = new.superseded_by
      and successor.pack_version_id = old.pack_version_id
      and successor.owner_wallet = old.owner_wallet
      and successor.is_active = true
      and successor.superseded_by is null
      and successor.created_at >= old.created_at
  ) into successor_ok;

  if not successor_ok then
    raise exception 'Owner-feedback successor must match owner and Pack version'
      using errcode = '23514';
  end if;

  return null;
end
$$;

create trigger osi_v2_guard_owner_feedback_update
before update on public.ai_pack_owner_feedback
for each row execute function public.osi_v2_guard_owner_feedback_update();

create constraint trigger osi_v2_validate_owner_feedback_successor
after update on public.ai_pack_owner_feedback
deferrable initially deferred
for each row execute function public.osi_v2_validate_owner_feedback_successor();

-- AI Pack creator role and immutable evidence manifest scope are verified
-- against the Pack's exact Case.
create function public.osi_v2_validate_ai_pack_creator()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  case_owner text;
  analyst_ok boolean;
begin
  select case_row.submitted_by_wallet
    into case_owner
    from public.ai_packs as pack
    join public.cases as case_row on case_row.id = pack.case_id
   where pack.id = new.pack_id;

  if new.created_by_role = 'owner'
     and new.created_by_wallet is distinct from case_owner then
    raise exception 'Owner-created AI Pack must use the Case-owner wallet'
      using errcode = '42501';
  end if;

  if new.created_by_role = 'analyst' then
    select exists (
      select 1
      from public.analyst_profiles as profile
      where profile.wallet = new.created_by_wallet
        and profile.status in (
          'probationary_analyst',
          'verified_analyst',
          'senior_analyst'
        )
        and profile.verified = true
        and profile.approved = true
    ) into analyst_ok;

    if not analyst_ok then
      raise exception 'Analyst-created AI Pack requires eligible analyst status'
        using errcode = '42501';
    end if;
  end if;

  return new;
end
$$;

create trigger osi_v2_validate_ai_pack_creator
before insert on public.ai_pack_versions
for each row execute function public.osi_v2_validate_ai_pack_creator();

create function public.osi_v2_validate_pack_manifest_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  pack_case_id uuid;
  evidence_hash text;
  evidence_public boolean;
  evidence_moderation text;
  same_case boolean;
begin
  select pack.case_id
    into pack_case_id
    from public.ai_pack_versions as version
    join public.ai_packs as pack on pack.id = version.pack_id
   where version.id = new.pack_version_id;

  select sha256, is_public, moderation_state
    into evidence_hash, evidence_public, evidence_moderation
    from public.evidence_items
   where id = new.evidence_item_id;

  if evidence_hash is distinct from new.evidence_hash_at_generation then
    raise exception 'Pack manifest hash must match validated evidence hash'
      using errcode = '23514';
  end if;

  if evidence_moderation is distinct from 'approved' then
    raise exception 'Pending or blocked evidence cannot enter an AI Pack manifest'
      using errcode = '42501';
  end if;

  if new.access_scope = 'public' and evidence_public is not true then
    raise exception 'Public AI Pack scope requires public evidence'
      using errcode = '42501';
  end if;

  select
    exists (
      select 1
      from public.case_evidence_links as link
      where link.case_id = pack_case_id
        and link.evidence_item_id = new.evidence_item_id
    )
    or exists (
      select 1
      from public.case_report_version_evidence as link
      join public.case_report_versions as version
        on version.id = link.report_version_id
      join public.case_reports as report on report.id = version.report_id
      where report.case_id = pack_case_id
        and link.evidence_item_id = new.evidence_item_id
    )
    or exists (
      select 1
      from public.wire_report_version_evidence as link
      join public.wire_report_versions as version
        on version.id = link.wire_report_version_id
      join public.wire_reports as report on report.id = version.wire_report_id
      where report.promoted_to_case_id = pack_case_id
        and link.evidence_item_id = new.evidence_item_id
    )
    into same_case;

  if not same_case then
    raise exception 'AI Pack manifest evidence must belong to the same Case'
      using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger osi_v2_validate_pack_manifest_evidence
before insert on public.ai_pack_version_evidence
for each row execute function public.osi_v2_validate_pack_manifest_evidence();

-- Existing V1 osi_config policies permit the maintainer Supabase auth UUID to
-- update V1 configuration. Native V2 feature gates are stricter: only a
-- trusted server path may change OSI_V2_* keys after it has verified the full
-- maintainer wallet + auth requirements and emitted CONFIG_CHANGED.
create function public.osi_v2_guard_config_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_is_protected boolean := false;
  new_is_protected boolean := false;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    old_is_protected := old.key like 'OSI_V2_%';
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    new_is_protected := new.key like 'OSI_V2_%';
  end if;

  if (old_is_protected or new_is_protected)
     and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'OSI V2 configuration requires the trusted server path'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

create trigger osi_v2_guard_config_write
before insert or update or delete on public.osi_config
for each row execute function public.osi_v2_guard_config_write();

-- V2 history is forward-only. No domain or infrastructure row is physically
-- deleted during the coexistence/soak period.
create function public.osi_v2_reject_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'OSI V2 history is append-only: DELETE denied on %.%',
    tg_table_schema, tg_table_name
    using errcode = '55000';
end
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'event_receipts',
    'cases',
    'case_reports',
    'case_report_versions',
    'wire_reports',
    'wire_report_versions',
    'evidence_items',
    'case_evidence_links',
    'case_report_version_evidence',
    'wire_report_version_evidence',
    'case_initial_reviews',
    'case_report_reviews',
    'wire_report_reviews',
    'resolution_reviews',
    'challenge_reviews',
    'ai_pack_reviews',
    'analyst_application_reviews',
    'case_resolutions',
    'challenges_v2',
    'analyst_applications',
    'analyst_application_versions',
    'analyst_profiles',
    'analyst_contributions',
    'analyst_reputation_snapshots',
    'ai_packs',
    'ai_pack_versions',
    'ai_pack_owner_feedback',
    'ai_pack_version_evidence',
    'reward_pledges',
    'reward_payments',
    'support_events',
    'osi_nonces',
    'migration_crosswalk',
    'migration_manual_queue'
  ]
  loop
    execute format(
      'create trigger osi_v2_reject_delete before delete on public.%I
       for each row execute function public.osi_v2_reject_delete()',
      table_name
    );
  end loop;
end
$$;

create function public.osi_v2_reject_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'OSI V2 immutable row: UPDATE denied on %.%',
    tg_table_schema, tg_table_name
    using errcode = '55000';
end
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'event_receipts',
    'case_evidence_links',
    'case_report_version_evidence',
    'wire_report_version_evidence',
    'analyst_application_versions',
    'analyst_contributions',
    'analyst_reputation_snapshots',
    'ai_pack_version_evidence'
  ]
  loop
    execute format(
      'create trigger osi_v2_reject_update before update on public.%I
       for each row execute function public.osi_v2_reject_update()',
      table_name
    );
  end loop;
end
$$;

commit;
