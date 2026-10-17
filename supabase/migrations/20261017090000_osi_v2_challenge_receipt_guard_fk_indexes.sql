-- Two additive integrity repairs. No row is read, rewritten or removed.
--
-- 1. challenges_v2.bad_faith_receipt_id is write-once again. The first
--    challenge guard (20260711092852) refused any change to a recorded
--    bad-faith receipt. The resolution/challenge/seal migration
--    (20260714082218) replaced the guard to add write-once checks for its
--    new columns and dropped that one, so a recorded bad-faith outcome could
--    be repointed at another receipt or left with none. This replacement is
--    the 20260714082218 guard unchanged, plus that one check. No current
--    server path writes the column twice, so no flow changes.
--
-- 2. Foreign keys without an index that leads with the key get one. The
--    challenge target columns were reachable only through unique indexes
--    that lead with challenger_wallet, so a lookup by target (for example the
--    public Wire challenge count) and the referenced tables' FK checks could
--    not use an index. Nullable target, reviewer-profile and receipt columns
--    use partial indexes on their non-null rows.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create or replace function public.osi_v2_guard_challenge()
returns trigger
language plpgsql set search_path = ''
as $$
declare transition_ok boolean; bad_faith_transition_ok boolean; old_core jsonb; new_core jsonb;
begin
  old_core := to_jsonb(old) - array[
    'state', 'admitted_by_wallet', 'review_deadline_at', 'expired_reason',
    'bad_faith_state', 'opened_receipt_id', 'resolved_receipt_id',
    'bad_faith_receipt_id', 'outcome_quorum_hash', 'terminal_at', 'updated_at'
  ];
  new_core := to_jsonb(new) - array[
    'state', 'admitted_by_wallet', 'review_deadline_at', 'expired_reason',
    'bad_faith_state', 'opened_receipt_id', 'resolved_receipt_id',
    'bad_faith_receipt_id', 'outcome_quorum_hash', 'terminal_at', 'updated_at'
  ];
  if new_core is distinct from old_core then
    raise exception 'Challenge actor, target, evidence and public/restricted content are immutable'
      using errcode = '55000';
  end if;
  transition_ok := new.state = old.state
    or (old.state = 'submitted' and new.state in ('admissibility_review', 'withdrawn', 'expired'))
    or (old.state = 'admissibility_review' and new.state in ('open', 'rejected', 'withdrawn', 'expired'))
    or (old.state = 'open' and new.state in ('under_review', 'withdrawn', 'expired'))
    or (old.state = 'under_review' and new.state in ('accepted', 'rejected', 'withdrawn', 'expired'));
  if not transition_ok then
    raise exception 'Invalid challenge transition: % -> %', old.state, new.state using errcode = '23514';
  end if;
  if old.admitted_by_wallet is not null and new.admitted_by_wallet is distinct from old.admitted_by_wallet then
    raise exception 'Challenge admissibility actor is write-once' using errcode = '55000'; end if;
  if old.opened_receipt_id is not null and new.opened_receipt_id is distinct from old.opened_receipt_id then
    raise exception 'Challenge opening receipt is write-once' using errcode = '55000'; end if;
  if old.resolved_receipt_id is not null and new.resolved_receipt_id is distinct from old.resolved_receipt_id then
    raise exception 'Challenge terminal receipt is write-once' using errcode = '55000'; end if;
  if old.outcome_quorum_hash is not null and new.outcome_quorum_hash is distinct from old.outcome_quorum_hash then
    raise exception 'Challenge outcome quorum is write-once' using errcode = '55000'; end if;
  if old.terminal_at is not null and new.terminal_at is distinct from old.terminal_at then
    raise exception 'Challenge terminal_at is write-once' using errcode = '55000'; end if;
  if old.bad_faith_receipt_id is not null
     and new.bad_faith_receipt_id is distinct from old.bad_faith_receipt_id then
    raise exception 'Challenge bad-faith receipt is write-once' using errcode = '55000'; end if;
  if new.state in ('accepted', 'rejected', 'withdrawn', 'expired')
     and (new.resolved_receipt_id is null or new.terminal_at is null) then
    raise exception 'Terminal challenge requires exact receipt and timestamp' using errcode = '23514';
  end if;
  if new.state in ('accepted', 'rejected') and old.state = 'under_review'
     and new.outcome_quorum_hash is null then
    raise exception 'Adjudicated challenge requires exact quorum hash' using errcode = '23514';
  end if;
  bad_faith_transition_ok := new.bad_faith_state = old.bad_faith_state
    or (old.bad_faith_state = 'none' and new.bad_faith_state = 'under_review'
      and new.state in ('rejected', 'withdrawn', 'expired'))
    or (old.bad_faith_state = 'under_review'
      and new.bad_faith_state in ('confirmed', 'dismissed')
      and new.state in ('rejected', 'withdrawn', 'expired')
      and new.bad_faith_receipt_id is not null);
  if not bad_faith_transition_ok then
    raise exception 'Invalid challenge bad-faith transition: % -> %', old.bad_faith_state, new.bad_faith_state
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create index challenges_v2_case_target_idx
  on public.challenges_v2 (case_id) where case_id is not null;
create index challenges_v2_report_version_target_idx
  on public.challenges_v2 (case_report_version_id) where case_report_version_id is not null;
create index challenges_v2_wire_version_target_idx
  on public.challenges_v2 (wire_report_version_id) where wire_report_version_id is not null;
create index challenges_v2_ai_pack_version_target_idx
  on public.challenges_v2 (ai_pack_version_id) where ai_pack_version_id is not null;

create index resolution_reviews_case_idx
  on public.resolution_reviews (case_id) where case_id is not null;

create index case_report_reviews_reviewer_profile_idx
  on public.case_report_reviews (reviewer_profile_wallet) where reviewer_profile_wallet is not null;
create index resolution_reviews_reviewer_profile_idx
  on public.resolution_reviews (reviewer_profile_wallet) where reviewer_profile_wallet is not null;
create index challenge_reviews_reviewer_profile_idx
  on public.challenge_reviews (reviewer_profile_wallet) where reviewer_profile_wallet is not null;
create index wire_report_reviews_reviewer_profile_idx
  on public.wire_report_reviews (reviewer_profile_wallet) where reviewer_profile_wallet is not null;
create index ai_pack_reviews_reviewer_profile_idx
  on public.ai_pack_reviews (reviewer_profile_wallet) where reviewer_profile_wallet is not null;

create index case_resolutions_final_receipt_idx
  on public.case_resolutions (final_receipt_id) where final_receipt_id is not null;
create index case_resolutions_seal_receipt_idx
  on public.case_resolutions (seal_receipt_id) where seal_receipt_id is not null;
create index wire_report_versions_contested_receipt_idx
  on public.wire_report_versions (contested_receipt_id) where contested_receipt_id is not null;
create index ai_pack_versions_first_stale_receipt_idx
  on public.ai_pack_versions (first_stale_receipt_id) where first_stale_receipt_id is not null;

commit;
