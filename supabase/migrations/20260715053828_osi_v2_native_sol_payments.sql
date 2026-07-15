-- OSI V2 native SOL reward, voluntary support and verified payment proof.
-- Additive only: existing money tables remain authoritative; payment intent
-- reservation reuses osi_nonces and immutable history reuses event_receipts.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

insert into public.osi_config (key, value, updated_at)
values
  ('OSI_V2_PAYMENT_WRITES_ENABLED', 'false', statement_timestamp()),
  ('OSI_V2_PAYMENT_NONCE_TTL_SECONDS', '180', statement_timestamp()),
  ('OSI_V2_PAYMENT_RATE_WINDOW_SECONDS', '600', statement_timestamp()),
  ('OSI_V2_PAYMENT_MAX_PER_WALLET', '10', statement_timestamp()),
  ('OSI_V2_PAYMENT_MAX_PER_FINGERPRINT', '30', statement_timestamp()),
  ('OSI_V2_PAYMENT_MAX_RECIPIENTS', '4', statement_timestamp()),
  ('OSI_V2_PAYMENT_MAX_LAMPORTS', '100000000000', statement_timestamp())
on conflict (key) do nothing;

-- The current executable registry retires REWARD_PLEDGED for new writes but
-- retains it (and REWARD_PAID/SUPPORT_SENT) as historical OSI2 transport
-- compatibility. New pledge mutations are Class B; verified transfers are
-- Class A only after exact System Program + Memo verification.
create or replace function public.osi_v2_expected_proof_type(p_event_type text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when p_event_type = any (array[
      'CASE_INITIAL_REVIEW_CAST', 'CASE_INITIAL_REVIEW_REVISED',
      'CASE_WITHDRAWN', 'CASE_APPEAL_SUBMITTED',
      'CASE_REPORT_REVIEW_CAST', 'CASE_REPORT_REVIEW_REVISED',
      'WIRE_REPORT_REVIEW_CAST', 'WIRE_REPORT_REVIEW_REVISED',
      'RESOLUTION_REVIEW_CAST', 'RESOLUTION_REVIEW_REVISED',
      'CHALLENGE_SUBMITTED', 'CHALLENGE_ADMISSIBILITY_ACCEPTED',
      'CHALLENGE_ADMISSIBILITY_REJECTED', 'CHALLENGE_REVIEW_CAST',
      'CHALLENGE_REVIEW_REVISED', 'CHALLENGE_WITHDRAWN',
      'CHALLENGE_BAD_FAITH_REVIEW_CAST', 'CHALLENGE_BAD_FAITH_REVIEW_REVISED',
      'AI_PACK_REVIEW_CAST', 'AI_PACK_REVIEW_REVISED',
      'AI_PACK_OWNER_FEEDBACK_SUBMITTED',
      'ANALYST_APPLICATION_VERSION_SUBMITTED',
      'ANALYST_APPLICATION_REVIEW_CAST', 'ANALYST_APPLICATION_REVIEW_REVISED',
      'OWNER_STATUS_PROOF', 'REWARD_PLEDGE_CREATED',
      'REWARD_PLEDGE_REVISED', 'REWARD_PLEDGE_WITHDRAWN'
    ]::text[]) then 'wallet_signed_server_verified'
    when p_event_type = any (array[
      'CASE_SUBMITTED', 'CASE_OPENED', 'CASE_SAFETY_BLOCKED',
      'CASE_SAFETY_LIFTED', 'CASE_INITIAL_REVIEW_REJECTED', 'CASE_RESUMED',
      'CASE_REPORT_VERSION_SUBMITTED', 'REPORT_PUBLISHED', 'REPORT_REJECTED',
      'WIRE_REPORT_VERSION_SUBMITTED', 'WIRE_REPORT_PUBLISHED', 'WIRE_PROMOTED',
      'RESOLUTION_PROPOSED', 'REPORT_SELECTED_WINNING', 'CHALLENGE_ACCEPTED',
      'CHALLENGE_REJECTED', 'CHALLENGE_BAD_FAITH_CONFIRMED',
      'CHALLENGE_BAD_FAITH_DISMISSED', 'CASE_RESOLVED', 'CASE_REOPENED',
      'RECORD_SEALED', 'CASE_HALTED', 'ANALYST_PROBATION', 'ANALYST_SENIOR',
      'ANALYST_VERIFIED', 'ANALYST_REVOKED', 'AI_PACK_APPROVED',
      'AI_PACK_REJECTED', 'REWARD_PLEDGED', 'REWARD_PAID', 'SUPPORT_SENT',
      'REWARD_PAYMENT_CONFIRMED', 'SUPPORT_PAYMENT_CONFIRMED', 'CONFIG_CHANGED'
    ]::text[]) then 'solana_memo'
    when p_event_type = any (array[
      'CASE_QUORUM_READY', 'CHALLENGE_EXPIRED', 'PACK_SUBMITTED',
      'PACK_ATTACHED', 'PACK_SUPERSEDED', 'PACK_STALE',
      'REWARD_ASSIGNED', 'ANALYST_CANDIDATE'
    ]::text[]) then 'system_event'
    else null
  end
$$;

alter table public.event_receipts
  add column verification_metadata jsonb not null default '{}'::jsonb
    constraint event_receipts_verification_metadata_object_check
    check (jsonb_typeof(verification_metadata) = 'object');

alter table public.event_receipts
  add constraint event_receipts_payment_proof_metadata_check
  check (
    event_type not in ('REWARD_PAYMENT_CONFIRMED', 'SUPPORT_PAYMENT_CONFIRMED')
    or (
      event_version = 'OSI2'
      and proof_type = 'solana_memo'
      and server_verified = true
      and tx_sig is not null
      and memo_ref is not null
      and verification_metadata->>'cluster' = 'mainnet-beta'
      and verification_metadata->>'finality' = 'finalized'
      and verification_metadata->>'slot' ~ '^[1-9][0-9]*$'
      and verification_metadata->>'total_lamports' ~ '^[1-9][0-9]*$'
      and jsonb_typeof(verification_metadata->'recipient_manifest') = 'array'
      and jsonb_array_length(verification_metadata->'recipient_manifest') between 1 and 4
    )
  ),
  add constraint event_receipts_pledge_history_metadata_check
  check (
    event_type not in (
      'REWARD_PLEDGE_CREATED', 'REWARD_PLEDGE_REVISED', 'REWARD_PLEDGE_WITHDRAWN'
    )
    or (
      proof_type = 'wallet_signed_server_verified'
      and verification_metadata->>'amount_lamports' ~ '^[1-9][0-9]*$'
      and verification_metadata->>'revision_no' ~ '^[1-9][0-9]*$'
      and verification_metadata->>'case_public_ref' ~ '^OSI-[A-Z0-9-]{6,56}$'
    )
  );

alter table public.reward_pledges
  add column latest_receipt_id uuid references public.event_receipts (id) on delete restrict,
  add column revision_no integer not null default 1
    constraint reward_pledges_revision_no_check check (revision_no >= 1),
  add column sealed_amount_lamports bigint
    constraint reward_pledges_sealed_amount_check check (sealed_amount_lamports is null or sealed_amount_lamports > 0),
  add column withdrawn_at timestamptz,
  add constraint reward_pledges_withdrawal_shape_check
    check (
      (state = 'cancelled' and (withdrawn_at is not null or latest_receipt_id is null))
      or (state <> 'cancelled' and withdrawn_at is null)
    ),
  add constraint reward_pledges_sealed_amount_consistency_check
    check (sealed_amount_lamports is null or sealed_amount_lamports = amount_lamports);

create index reward_pledges_latest_receipt_idx
  on public.reward_pledges (latest_receipt_id) where latest_receipt_id is not null;

alter table public.reward_payments
  add column intent_nonce text references public.osi_nonces (nonce) on delete restrict,
  add column cluster text not null default 'mainnet-beta'
    constraint reward_payments_cluster_check check (cluster = 'mainnet-beta'),
  add column submitted_at timestamptz,
  add column slot bigint constraint reward_payments_slot_check check (slot is null or slot > 0),
  add column block_time timestamptz,
  add column finality text constraint reward_payments_finality_check check (finality is null or finality = 'finalized'),
  add column verification_error text
    constraint reward_payments_verification_error_check
    check (verification_error is null or verification_error ~ '^[a-z][a-z0-9_]{0,95}$'),
  add constraint reward_payments_intent_nonce_unique unique (intent_nonce),
  add constraint reward_payments_finalized_shape_check
  check (
    state <> 'confirmed'
    or intent_nonce is null
    or (
      cluster = 'mainnet-beta' and slot is not null and block_time is not null
      and finality = 'finalized' and verification_error is null
    )
  );

alter table public.support_events
  add column intent_nonce text references public.osi_nonces (nonce) on delete restrict,
  add column case_id uuid references public.cases (id) on delete restrict,
  add column context_report_version_id uuid references public.case_report_versions (id) on delete restrict,
  add column recipient_manifest jsonb not null default '[]'::jsonb
    constraint support_events_recipient_manifest_check
    check (jsonb_typeof(recipient_manifest) = 'array' and jsonb_array_length(recipient_manifest) between 0 and 4),
  add column manifest_hash text
    constraint support_events_manifest_hash_check check (manifest_hash is null or manifest_hash ~ '^[0-9a-f]{64}$'),
  add column cluster text not null default 'mainnet-beta'
    constraint support_events_cluster_check check (cluster = 'mainnet-beta'),
  add column confirmed_at timestamptz,
  add column slot bigint constraint support_events_slot_check check (slot is null or slot > 0),
  add column block_time timestamptz,
  add column finality text constraint support_events_finality_check check (finality is null or finality = 'finalized'),
  add column verification_error text
    constraint support_events_verification_error_check
    check (verification_error is null or verification_error ~ '^[a-z][a-z0-9_]{0,95}$'),
  add constraint support_events_intent_nonce_unique unique (intent_nonce),
  add constraint support_events_native_manifest_shape_check
  check (
    intent_nonce is null
    or (
      manifest_hash is not null and jsonb_array_length(recipient_manifest) between 1 and 4
    )
  ),
  add constraint support_events_finalized_shape_check
  check (
    state <> 'confirmed'
    or intent_nonce is null
    or (
      confirmed_at is not null and cluster = 'mainnet-beta' and slot is not null
      and block_time is not null and finality = 'finalized' and verification_error is null
    )
  );

create index support_events_case_state_idx on public.support_events (case_id, state);
create index support_events_context_version_idx
  on public.support_events (context_report_version_id, state)
  where context_report_version_id is not null;

create or replace function osi_private.osi_v2_payment_writes_enabled()
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from public.osi_config as config
     where config.key = 'OSI_V2_PAYMENT_WRITES_ENABLED' and config.value = 'true'
  )
$$;

create function osi_private.osi_v2_payment_hash(p_value jsonb)
returns text language sql immutable strict security invoker set search_path = '' as $$
  select pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_value::text, 'UTF8'), 'sha256'), 'hex'
  )
$$;

create function osi_private.osi_v2_payment_config_integer(
  p_key text, p_min integer, p_max integer
)
returns integer language plpgsql stable security invoker set search_path = '' as $$
declare result integer;
begin
  select case when config.value ~ '^[0-9]+$' then config.value::integer end
    into result from public.osi_config as config where config.key = p_key;
  if result is null or result not between p_min and p_max then
    raise exception 'Payment security configuration is absent or invalid' using errcode = '55000';
  end if;
  return result;
end
$$;

create function osi_private.osi_v2_payment_rate_limit(
  p_wallet text, p_fingerprint text, p_now timestamptz
)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  window_seconds integer := osi_private.osi_v2_payment_config_integer('OSI_V2_PAYMENT_RATE_WINDOW_SECONDS', 60, 3600);
  wallet_max integer := osi_private.osi_v2_payment_config_integer('OSI_V2_PAYMENT_MAX_PER_WALLET', 1, 100);
  fingerprint_max integer := osi_private.osi_v2_payment_config_integer('OSI_V2_PAYMENT_MAX_PER_FINGERPRINT', 1, 200);
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osi2-payment-wallet:' || p_wallet, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osi2-payment-fingerprint:' || p_fingerprint, 0));
  if (select count(*) from public.osi_nonces as nonce
       where nonce.actor_wallet = p_wallet
         and nonce.purpose in (
           'REWARD_PLEDGE_CREATED', 'REWARD_PLEDGE_REVISED', 'REWARD_PLEDGE_WITHDRAWN',
           'REWARD_PAYMENT_CONFIRMED', 'SUPPORT_PAYMENT_CONFIRMED'
         )
         and nonce.issued_at >= p_now - pg_catalog.make_interval(secs => window_seconds)) >= wallet_max then
    raise exception 'Payment wallet rate limit exceeded' using errcode = 'P0001';
  end if;
  if (select count(*) from public.osi_nonces as nonce
       where nonce.request_fingerprint_hash = p_fingerprint
         and nonce.purpose in (
           'REWARD_PLEDGE_CREATED', 'REWARD_PLEDGE_REVISED', 'REWARD_PLEDGE_WITHDRAWN',
           'REWARD_PAYMENT_CONFIRMED', 'SUPPORT_PAYMENT_CONFIRMED'
         )
         and nonce.issued_at >= p_now - pg_catalog.make_interval(secs => window_seconds)) >= fingerprint_max then
    raise exception 'Payment fingerprint rate limit exceeded' using errcode = 'P0001';
  end if;
end
$$;

create or replace function public.osi_v2_validate_reward_pledge_insert()
returns trigger language plpgsql set search_path = '' as $$
declare case_owner text; receipt public.event_receipts%rowtype;
begin
  select case_item.submitted_by_wallet into case_owner
    from public.cases as case_item where case_item.id = new.case_id;
  if new.pledger_wallet is distinct from case_owner then
    raise exception 'Only the Case owner may pledge its reward' using errcode = '42501';
  end if;
  select event.* into receipt from public.event_receipts as event where event.id = new.created_receipt_id;
  if receipt.event_version = 'OSI2' and (
    receipt.event_type not in ('REWARD_PLEDGED', 'REWARD_PLEDGE_CREATED')
    or receipt.target_type <> 'reward'
    or receipt.target_id is distinct from new.id::text
    or receipt.actor_wallet is distinct from new.pledger_wallet
  ) then
    raise exception 'Reward pledge receipt is not exactly bound' using errcode = '23514';
  end if;
  if receipt.event_type = 'REWARD_PLEDGE_CREATED'
     and new.latest_receipt_id is distinct from new.created_receipt_id then
    raise exception 'Native pledge creation must set its exact latest receipt' using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.osi_v2_guard_reward_pledge()
returns trigger language plpgsql set search_path = '' as $$
declare
  case_row public.cases%rowtype;
  confirmed_total bigint;
  receipt public.event_receipts%rowtype;
begin
  if new.id is distinct from old.id or new.case_id is distinct from old.case_id
     or new.pledger_wallet is distinct from old.pledger_wallet
     or new.token is distinct from old.token
     or new.created_receipt_id is distinct from old.created_receipt_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Reward pledge identity and owner are immutable' using errcode = '55000';
  end if;
  select case_item.* into case_row from public.cases as case_item where case_item.id = old.case_id;
  if old.winning_report_version_id is not null
     and new.winning_report_version_id is distinct from old.winning_report_version_id then
    raise exception 'Assigned reward winner is immutable' using errcode = '55000';
  end if;
  if new.amount_lamports is distinct from old.amount_lamports then
    if old.state <> 'pledged' or case_row.stage = 'sealed' or old.sealed_amount_lamports is not null then
      raise exception 'A sealed or assigned pledge amount is immutable' using errcode = '55000';
    end if;
    if case_row.visibility = 'public' and new.amount_lamports <= old.amount_lamports then
      raise exception 'A public Case pledge may only increase' using errcode = '23514';
    end if;
    if new.revision_no <> old.revision_no + 1 or new.latest_receipt_id is null
       or new.latest_receipt_id is not distinct from old.latest_receipt_id then
      raise exception 'Pledge revision requires an immutable new receipt' using errcode = '23514';
    end if;
    select event.* into receipt from public.event_receipts as event where event.id = new.latest_receipt_id;
    if receipt.event_type <> 'REWARD_PLEDGE_REVISED'
       or receipt.target_id is distinct from new.id::text
       or receipt.verification_metadata->>'amount_lamports' is distinct from new.amount_lamports::text then
      raise exception 'Pledge revision receipt is not exactly bound' using errcode = '23514';
    end if;
  end if;
  if old.state = 'pledged' and new.state = 'cancelled' then
    if case_row.visibility <> 'private' or case_row.stage = 'sealed'
       or new.revision_no <> old.revision_no + 1 or new.latest_receipt_id is null
       or new.withdrawn_at is null then
      raise exception 'A pledge may be withdrawn only before public opening with a new receipt'
        using errcode = '23514';
    end if;
    select event.* into receipt from public.event_receipts as event where event.id = new.latest_receipt_id;
    if receipt.event_type <> 'REWARD_PLEDGE_WITHDRAWN'
       or receipt.target_id is distinct from new.id::text then
      raise exception 'Pledge withdrawal receipt is not exactly bound' using errcode = '23514';
    end if;
  elsif old.state = 'pledged' and new.state = 'assigned' then
    if new.winning_report_version_id is null or new.sealed_amount_lamports <> new.amount_lamports then
      raise exception 'Assigned pledge requires the sealed exact winner and amount' using errcode = '23514';
    end if;
  elsif old.state = 'assigned' and new.state = 'paid' then
    select coalesce(sum(payment.amount_lamports), 0) into confirmed_total
      from public.reward_payments as payment
     where payment.pledge_id = new.id and payment.state = 'confirmed';
    if confirmed_total <> new.amount_lamports then
      raise exception 'Reward cannot be fulfilled before exact confirmed total' using errcode = '23514';
    end if;
  elsif new.state is distinct from old.state then
    raise exception 'Invalid reward pledge transition: % -> %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end
$$;

-- Freeze the exact pledged amount and winner in the same transaction that
-- completes Case sealing. This changes only pledge state; no SOL moves.
create function public.osi_v2_freeze_reward_on_case_seal()
returns trigger language plpgsql set search_path = '' as $$
declare winning_version_id uuid;
begin
  if new.stage = 'sealed' and old.stage <> 'sealed' then
    select resolution.winning_report_version_id into winning_version_id
      from public.case_resolutions as resolution
     where resolution.case_id = new.id and resolution.state = 'sealed'
     order by resolution.sealed_at desc nulls last, resolution.created_at desc
     limit 1;
    if exists (
      select 1 from public.reward_pledges as reward
       where reward.case_id = new.id and reward.state = 'pledged'
    ) and winning_version_id is null then
      raise exception 'A sealed Case pledge requires the exact sealed winning Report version'
        using errcode = '23514';
    end if;
    update public.reward_pledges as reward
       set state = 'assigned', winning_report_version_id = winning_version_id,
           sealed_amount_lamports = reward.amount_lamports,
           updated_at = statement_timestamp()
     where reward.case_id = new.id and reward.state = 'pledged';
  end if;
  return new;
end
$$;

create trigger osi_v2_freeze_reward_on_case_seal
after update of stage on public.cases
for each row execute function public.osi_v2_freeze_reward_on_case_seal();

create or replace function public.osi_v2_validate_reward_payment_insert()
returns trigger language plpgsql set search_path = '' as $$
declare pledge public.reward_pledges%rowtype; expected_recipient text; confirmed_total bigint;
begin
  select reward.* into pledge from public.reward_pledges as reward where reward.id = new.pledge_id for update;
  select report.author_wallet into expected_recipient
    from public.case_report_versions as version
    join public.case_reports as report on report.id = version.report_id
   where version.id = pledge.winning_report_version_id;
  select coalesce(sum(payment.amount_lamports), 0) into confirmed_total
    from public.reward_payments as payment
   where payment.pledge_id = new.pledge_id and payment.state = 'confirmed';
  if pledge.state not in ('assigned', 'paid')
     or new.from_wallet is distinct from pledge.pledger_wallet
     or new.to_wallet is distinct from expected_recipient
     or new.amount_lamports > pledge.amount_lamports - confirmed_total then
    raise exception 'Reward payment exceeds the exact sealed outstanding pledge or targets the wrong winner'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.osi_v2_guard_reward_payment()
returns trigger language plpgsql set search_path = '' as $$
declare old_core jsonb; new_core jsonb; receipt public.event_receipts%rowtype;
begin
  old_core := to_jsonb(old) - array['tx_sig','state','confirmed_at','event_receipt_id','submitted_at','slot','block_time','finality','verification_error','updated_at'];
  new_core := to_jsonb(new) - array['tx_sig','state','confirmed_at','event_receipt_id','submitted_at','slot','block_time','finality','verification_error','updated_at'];
  if new_core is distinct from old_core then
    raise exception 'Reward payment intent, wallets and amount are immutable' using errcode = '55000';
  end if;
  if old.tx_sig is not null and new.tx_sig is distinct from old.tx_sig then
    raise exception 'Reward transaction signature is write-once' using errcode = '55000';
  end if;
  if old.event_receipt_id is not null and new.event_receipt_id is distinct from old.event_receipt_id then
    raise exception 'Reward payment receipt is write-once' using errcode = '55000';
  end if;
  if not (
    new.state = old.state
    or (old.state = 'initiated' and new.state in ('submitted','failed','timed_out'))
    or (old.state = 'submitted' and new.state in ('confirmed','failed','timed_out'))
  ) then
    raise exception 'Invalid reward payment transition: % -> %', old.state, new.state using errcode = '23514';
  end if;
  if old.state <> 'confirmed' and new.state = 'confirmed' then
    select event.* into receipt from public.event_receipts as event where event.id = new.event_receipt_id;
    if receipt.event_type <> 'REWARD_PAYMENT_CONFIRMED'
       or receipt.target_type <> 'reward' or receipt.target_id is distinct from new.id::text
       or receipt.actor_wallet is distinct from new.from_wallet or receipt.tx_sig is distinct from new.tx_sig then
      raise exception 'Confirmed reward requires exact verified transfer receipt' using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

create or replace function public.osi_v2_guard_support_event()
returns trigger language plpgsql set search_path = '' as $$
declare old_core jsonb; new_core jsonb; receipt public.event_receipts%rowtype;
begin
  old_core := to_jsonb(old) - array['tx_sig','state','event_receipt_id','confirmed_at','slot','block_time','finality','verification_error','updated_at'];
  new_core := to_jsonb(new) - array['tx_sig','state','event_receipt_id','confirmed_at','slot','block_time','finality','verification_error','updated_at'];
  if new_core is distinct from old_core then
    raise exception 'Support sender, recipient manifest, type and amount are immutable' using errcode = '55000';
  end if;
  if old.tx_sig is not null and new.tx_sig is distinct from old.tx_sig then
    raise exception 'Support transaction signature is write-once' using errcode = '55000';
  end if;
  if old.event_receipt_id is not null and new.event_receipt_id is distinct from old.event_receipt_id then
    raise exception 'Support receipt is write-once' using errcode = '55000';
  end if;
  if not (new.state = old.state or (old.state = 'submitted' and new.state in ('confirmed','failed'))) then
    raise exception 'Invalid support transition: % -> %', old.state, new.state using errcode = '23514';
  end if;
  if old.state <> 'confirmed' and new.state = 'confirmed' then
    select event.* into receipt from public.event_receipts as event where event.id = new.event_receipt_id;
    if receipt.event_type <> 'SUPPORT_PAYMENT_CONFIRMED'
       or receipt.target_type <> 'support' or receipt.target_id is distinct from new.id::text
       or receipt.actor_wallet is distinct from new.from_wallet or receipt.tx_sig is distinct from new.tx_sig then
      raise exception 'Confirmed support requires exact verified transfer receipt' using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

create function public.osi_v2_reject_cross_payment_tx()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.tx_sig is null then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osi2-payment-tx:' || new.tx_sig, 0));
  if tg_table_name = 'reward_payments' and exists (
    select 1 from public.support_events as support where support.tx_sig = new.tx_sig
  ) then
    raise exception 'A transaction cannot be both reward and support' using errcode = '23505';
  end if;
  if tg_table_name = 'support_events' and exists (
    select 1 from public.reward_payments as reward where reward.tx_sig = new.tx_sig
  ) then
    raise exception 'A transaction cannot be both support and reward' using errcode = '23505';
  end if;
  return new;
end
$$;

create trigger osi_v2_reject_cross_reward_tx
before insert or update of tx_sig on public.reward_payments
for each row execute function public.osi_v2_reject_cross_payment_tx();
create trigger osi_v2_reject_cross_support_tx
before insert or update of tx_sig on public.support_events
for each row execute function public.osi_v2_reject_cross_payment_tx();

create function osi_private.osi_v2_prepare_pledge(
  p_nonce text, p_action text, p_actor_wallet text, p_case_ref text,
  p_amount_lamports bigint, p_idempotency_key text, p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, purpose text, pledge_id uuid, case_public_ref text,
  amount_lamports bigint, revision_no integer, payload_hash text, proof_text text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language plpgsql security invoker set search_path = '' as $$
declare
  existing public.osi_nonces%rowtype;
  case_row public.cases%rowtype;
  pledge public.reward_pledges%rowtype;
  actual_pledge_id uuid;
  actual_purpose text;
  next_revision integer;
  exact_hash text;
  canonical_proof text;
  issued_time timestamptz := statement_timestamp();
  expires_time timestamptz;
  ttl_seconds integer;
  request_value jsonb;
begin
  if osi_private.osi_v2_payment_writes_enabled() is distinct from true then
    raise exception 'OSI V2 payment writes are disabled' using errcode = '55000';
  end if;
  if p_action not in ('create','revise','withdraw') then
    raise exception 'Unknown pledge action' using errcode = '22023';
  end if;
  if p_actor_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' or p_case_ref !~ '^OSI-[A-Z0-9-]{6,56}$' then
    raise exception 'Pledge actor or Case reference is invalid' using errcode = '22023';
  end if;
  select case_item.* into case_row from public.cases as case_item
   where case_item.public_ref = p_case_ref for update;
  if case_row.id is null or case_row.submitted_by_wallet is distinct from p_actor_wallet then
    raise exception 'Only the exact Case owner may mutate its pledge' using errcode = '42501';
  end if;
  select reward.* into pledge from public.reward_pledges as reward where reward.case_id = case_row.id for update;
  if p_action = 'create' then
    if pledge.id is not null or case_row.stage = 'sealed'
       or p_amount_lamports not between 1 and 100000000000 then
      raise exception 'Pledge already exists or amount is invalid' using errcode = '23514';
    end if;
    actual_pledge_id := gen_random_uuid(); actual_purpose := 'REWARD_PLEDGE_CREATED'; next_revision := 1;
  elsif p_action = 'revise' then
    if pledge.id is null or pledge.state <> 'pledged' or case_row.stage = 'sealed'
       or p_amount_lamports not between 1 and 100000000000
       or (case_row.visibility = 'public' and p_amount_lamports <= pledge.amount_lamports) then
      raise exception 'Pledge revision is not allowed in the current Case state' using errcode = '42501';
    end if;
    actual_pledge_id := pledge.id; actual_purpose := 'REWARD_PLEDGE_REVISED'; next_revision := pledge.revision_no + 1;
  else
    if pledge.id is null or pledge.state <> 'pledged' or case_row.visibility <> 'private'
       or case_row.stage = 'sealed' then
      raise exception 'Pledge withdrawal is allowed only before public opening' using errcode = '42501';
    end if;
    actual_pledge_id := pledge.id; actual_purpose := 'REWARD_PLEDGE_WITHDRAWN';
    next_revision := pledge.revision_no + 1; p_amount_lamports := pledge.amount_lamports;
  end if;
  request_value := jsonb_build_object(
    'action', p_action, 'case_id', case_row.id, 'case_public_ref', case_row.public_ref,
    'pledge_id', actual_pledge_id, 'actor_wallet', p_actor_wallet,
    'amount_lamports', p_amount_lamports::text, 'revision_no', next_revision
  );
  exact_hash := osi_private.osi_v2_payment_hash(request_value);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osi2-payment-idempotency:' || p_idempotency_key, 0));
  select nonce.* into existing from public.osi_nonces as nonce
   where nonce.idempotency_key = p_idempotency_key for update;
  if found then
    if existing.actor_wallet is distinct from p_actor_wallet
       or existing.binding_context->'client_request' is distinct from request_value then
      raise exception 'Idempotency key is bound to another exact pledge action' using errcode = '23514';
    end if;
    return query select existing.nonce, existing.purpose, existing.target_id::uuid,
      existing.binding_context->>'case_public_ref',
      (existing.binding_context->>'amount_lamports')::bigint,
      (existing.binding_context->>'revision_no')::integer, existing.payload_hash,
      existing.binding_context->>'proof_text', existing.issued_at, existing.expires_at,
      existing.consumed_by_receipt_id, true;
    return;
  end if;
  perform osi_private.osi_v2_payment_rate_limit(p_actor_wallet, p_request_fingerprint_hash, issued_time);
  ttl_seconds := osi_private.osi_v2_payment_config_integer('OSI_V2_PAYMENT_NONCE_TTL_SECONDS', 30, 300);
  expires_time := issued_time + pg_catalog.make_interval(secs => ttl_seconds);
  canonical_proof := concat_ws('|', 'OSI2', '2', actual_purpose, 't=reward',
    'id=' || actual_pledge_id::text, 'a=' || p_actor_wallet, 'n=' || p_nonce,
    'h=' || exact_hash, 'ts=' || floor(extract(epoch from issued_time) * 1000)::bigint,
    'exp=' || floor(extract(epoch from expires_time) * 1000)::bigint);
  insert into public.osi_nonces (
    nonce,purpose,actor_wallet,target_type,target_id,payload_hash,idempotency_key,
    request_fingerprint_hash,binding_context,issued_at,expires_at
  ) values (
    p_nonce,actual_purpose,p_actor_wallet,'reward',actual_pledge_id::text,exact_hash,
    p_idempotency_key,p_request_fingerprint_hash,
    request_value || jsonb_build_object('client_request', request_value, 'proof_text', canonical_proof),
    issued_time,expires_time
  );
  return query select p_nonce,actual_purpose,actual_pledge_id,case_row.public_ref,
    p_amount_lamports,next_revision,exact_hash,canonical_proof,issued_time,expires_time,null::uuid,false;
end
$$;

create function osi_private.osi_v2_commit_pledge(
  p_nonce text, p_action text, p_amount_lamports bigint, p_proof_text text, p_signature text
)
returns table (
  pledge_id uuid, case_public_ref text, state text, amount_lamports bigint,
  revision_no integer, receipt_id uuid, idempotent_replay boolean
)
language plpgsql security invoker set search_path = '' as $$
declare
  bound public.osi_nonces%rowtype;
  pledge public.reward_pledges%rowtype;
  case_row public.cases%rowtype;
  expected_purpose text;
  expected_amount bigint;
  expected_revision integer;
  new_receipt_id uuid := gen_random_uuid();
  receipt public.event_receipts%rowtype;
begin
  if osi_private.osi_v2_payment_writes_enabled() is distinct from true then
    raise exception 'OSI V2 payment writes are disabled' using errcode = '55000';
  end if;
  select nonce.* into bound from public.osi_nonces as nonce where nonce.nonce = p_nonce for update;
  expected_purpose := case p_action when 'create' then 'REWARD_PLEDGE_CREATED'
    when 'revise' then 'REWARD_PLEDGE_REVISED' when 'withdraw' then 'REWARD_PLEDGE_WITHDRAWN' else null end;
  expected_amount := (bound.binding_context->>'amount_lamports')::bigint;
  expected_revision := (bound.binding_context->>'revision_no')::integer;
  if bound.nonce is null or bound.purpose is distinct from expected_purpose
     or bound.target_type <> 'reward' or bound.binding_context->>'action' is distinct from p_action
     or p_amount_lamports is distinct from expected_amount
     or p_proof_text is distinct from bound.binding_context->>'proof_text'
     or p_signature !~ '^[A-Za-z0-9+/=_-]{64,256}$' then
    raise exception 'Pledge nonce, payload or signature binding is invalid' using errcode = '23514';
  end if;
  select case_item.* into case_row from public.cases as case_item
   where case_item.id = (bound.binding_context->>'case_id')::uuid for update;
  select reward.* into pledge from public.reward_pledges as reward
   where reward.id = bound.target_id::uuid for update;
  if bound.consumed_at is not null then
    select event.* into receipt from public.event_receipts as event where event.id = bound.consumed_by_receipt_id;
    if receipt.id is null or receipt.event_type is distinct from bound.purpose then
      raise exception 'Consumed pledge nonce has no exact receipt' using errcode = '23514';
    end if;
    select reward.* into pledge from public.reward_pledges as reward where reward.id = bound.target_id::uuid;
    return query select pledge.id,case_row.public_ref,pledge.state,pledge.amount_lamports,
      pledge.revision_no,receipt.id,true;
    return;
  end if;
  if statement_timestamp() > bound.expires_at or case_row.submitted_by_wallet is distinct from bound.actor_wallet then
    raise exception 'Pledge authorization expired or owner changed' using errcode = '42501';
  end if;
  if p_action = 'create' then
    if pledge.id is not null then raise exception 'Pledge state changed after prepare' using errcode = '40001'; end if;
  elsif pledge.id is null or pledge.state <> 'pledged' or pledge.revision_no + 1 <> expected_revision then
    raise exception 'Pledge history changed after prepare' using errcode = '40001';
  end if;
  if (p_action = 'withdraw' and (case_row.visibility <> 'private' or case_row.stage = 'sealed'))
     or (p_action = 'revise' and (
       case_row.stage = 'sealed' or (case_row.visibility = 'public' and expected_amount <= pledge.amount_lamports)
     )) then
    raise exception 'Pledge lifecycle changed after prepare' using errcode = '40001';
  end if;
  insert into public.event_receipts (
    id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,
    decision,proof_type,payload_hash,nonce,signature,server_verified,occurred_at,verification_metadata
  ) values (
    new_receipt_id,'OSI2',bound.purpose,'reward',bound.target_id,case_row.public_ref,
    bound.actor_wallet,'owner',p_action,'wallet_signed_server_verified',bound.payload_hash,
    bound.nonce,p_signature,true,statement_timestamp(),jsonb_build_object(
      'case_public_ref',case_row.public_ref,'amount_lamports',expected_amount::text,
      'revision_no',expected_revision,'pledge_state',case when p_action='withdraw' then 'cancelled' else 'pledged' end,
      'non_custodial',true,'escrowed',false
    )
  );
  if p_action = 'create' then
    insert into public.reward_pledges (
      id,case_id,pledger_wallet,amount_lamports,state,created_receipt_id,latest_receipt_id,revision_no
    ) values (
      bound.target_id::uuid,case_row.id,bound.actor_wallet,expected_amount,'pledged',new_receipt_id,new_receipt_id,1
    ) returning * into pledge;
  elsif p_action = 'revise' then
    update public.reward_pledges as reward
       set amount_lamports=expected_amount,revision_no=expected_revision,
           latest_receipt_id=new_receipt_id,updated_at=statement_timestamp()
     where reward.id=pledge.id and reward.state='pledged' and reward.revision_no=expected_revision-1
    returning * into pledge;
  else
    update public.reward_pledges as reward
       set state='cancelled',withdrawn_at=statement_timestamp(),revision_no=expected_revision,
           latest_receipt_id=new_receipt_id,updated_at=statement_timestamp()
     where reward.id=pledge.id and reward.state='pledged' and reward.revision_no=expected_revision-1
    returning * into pledge;
  end if;
  if pledge.id is null then raise exception 'Pledge changed concurrently' using errcode = '40001'; end if;
  update public.osi_nonces as nonce
     set consumed_at=statement_timestamp(),consumed_by_receipt_id=new_receipt_id,updated_at=statement_timestamp()
   where nonce.nonce=bound.nonce and nonce.consumed_at is null;
  if not found then raise exception 'Pledge nonce replayed concurrently' using errcode = '40001'; end if;
  return query select pledge.id,case_row.public_ref,pledge.state,pledge.amount_lamports,
    pledge.revision_no,new_receipt_id,false;
end
$$;

create function osi_private.osi_v2_prepare_payment(
  p_nonce text, p_payment_kind text, p_payer_wallet text, p_target_ref text,
  p_request jsonb, p_idempotency_key text, p_request_fingerprint_hash text
)
returns table (
  issued_nonce text, purpose text, payment_id uuid, payment_kind text,
  target_public_ref text, actor_role text, recipient_manifest jsonb,
  manifest_hash text, total_lamports bigint, payload_hash text, memo text,
  issued_at timestamptz, expires_at timestamptz,
  consumed_receipt_id uuid, idempotent_replay boolean
)
language plpgsql security invoker set search_path = '' as $$
declare
  existing public.osi_nonces%rowtype;
  case_row public.cases%rowtype;
  resolution_row public.case_resolutions%rowtype;
  pledge public.reward_pledges%rowtype;
  version_row public.case_report_versions%rowtype;
  report_row public.case_reports%rowtype;
  profile public.analyst_profiles%rowtype;
  review_row public.case_report_reviews%rowtype;
  request_item jsonb;
  item_ordinal bigint;
  recipient_wallet text;
  recipient_type text;
  recipient_target_ref text;
  recipient_amount bigint;
  context_version_id uuid;
  context_case_id uuid;
  expected_context text;
  current_context text;
  server_manifest jsonb := '[]'::jsonb;
  actual_total bigint := 0;
  confirmed_total bigint := 0;
  actual_payment_id uuid := gen_random_uuid();
  actual_purpose text;
  actual_actor_role text;
  actual_target_public_ref text;
  actual_manifest_hash text;
  exact_hash text;
  canonical_memo text;
  issued_time timestamptz := statement_timestamp();
  expires_time timestamptz;
  ttl_seconds integer;
  max_recipients integer;
  max_lamports bigint;
  server_binding jsonb;
begin
  if osi_private.osi_v2_payment_writes_enabled() is distinct from true then
    raise exception 'OSI V2 payment writes are disabled' using errcode = '55000';
  end if;
  if p_payment_kind not in ('reward','support')
     or p_payer_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or jsonb_typeof(p_request) <> 'object' then
    raise exception 'Payment request is invalid' using errcode = '22023';
  end if;
  max_recipients := osi_private.osi_v2_payment_config_integer('OSI_V2_PAYMENT_MAX_RECIPIENTS', 1, 4);
  select case when config.value ~ '^[0-9]+$' then config.value::bigint end
    into max_lamports from public.osi_config as config
   where config.key='OSI_V2_PAYMENT_MAX_LAMPORTS';
  if max_lamports is null or max_lamports not between 1 and 100000000000 then
    raise exception 'Payment amount configuration is absent or invalid' using errcode='55000';
  end if;
  if p_payment_kind = 'reward' then
    select case_item.* into case_row from public.cases as case_item
     where case_item.public_ref = p_target_ref for update;
    select resolution.* into resolution_row from public.case_resolutions as resolution
     where resolution.case_id = case_row.id and resolution.state = 'sealed'
     order by resolution.created_at desc limit 1;
    select reward.* into pledge from public.reward_pledges as reward where reward.case_id = case_row.id for update;
    if pledge.id is not null and pledge.state = 'pledged' and case_row.stage = 'sealed'
       and resolution_row.winning_report_version_id is not null then
      update public.reward_pledges as reward
         set state='assigned',winning_report_version_id=resolution_row.winning_report_version_id,
             sealed_amount_lamports=reward.amount_lamports,updated_at=statement_timestamp()
       where reward.id=pledge.id and reward.state='pledged'
      returning * into pledge;
    end if;
    select version.* into version_row from public.case_report_versions as version
     where version.id = resolution_row.winning_report_version_id;
    select report.* into report_row from public.case_reports as report where report.id = version_row.report_id;
    select coalesce(sum(payment.amount_lamports),0) into confirmed_total
      from public.reward_payments as payment where payment.pledge_id=pledge.id and payment.state='confirmed';
    recipient_amount := case when p_request->>'amount_lamports' ~ '^[1-9][0-9]*$'
      then (p_request->>'amount_lamports')::bigint end;
    if case_row.id is null or case_row.stage <> 'sealed' or resolution_row.id is null
       or pledge.id is null or pledge.state not in ('assigned','paid')
       or case_row.submitted_by_wallet is distinct from p_payer_wallet
       or report_row.author_wallet is null or report_row.case_id is distinct from case_row.id
       or recipient_amount is null or recipient_amount > pledge.amount_lamports-confirmed_total
       or recipient_amount > max_lamports then
      raise exception 'Reward is not ready for this exact owner, winner and outstanding pledge'
        using errcode = '42501';
    end if;
    if recipient_amount <= 0 then raise exception 'Reward is already fulfilled' using errcode='23514'; end if;
    if exists (
      select 1
        from public.osi_nonces as active_nonce
        left join public.reward_payments as active_payment
          on active_payment.intent_nonce = active_nonce.nonce
       where active_nonce.purpose = 'REWARD_PAYMENT_CONFIRMED'
         and active_nonce.binding_context->>'pledge_id' = pledge.id::text
         and active_nonce.idempotency_key <> p_idempotency_key
         and active_nonce.consumed_at is null
         and active_nonce.expires_at + interval '120 seconds' >= issued_time
         and (active_payment.id is null or active_payment.state = 'submitted')
    ) then
      raise exception 'An exact reward payment is already awaiting verification'
        using errcode='23514';
    end if;
    server_manifest := jsonb_build_array(jsonb_build_object(
      'ordinal',1,'wallet',report_row.author_wallet,'amount_lamports',recipient_amount::text,
      'recipient_type','report_author','target_ref',version_row.version_ref
    ));
    actual_total := recipient_amount; actual_purpose := 'REWARD_PAYMENT_CONFIRMED';
    actual_actor_role := 'owner'; actual_target_public_ref := case_row.public_ref;
    context_case_id := case_row.id; context_version_id := version_row.id;
    server_binding := jsonb_build_object(
      'case_id',case_row.id,'case_public_ref',case_row.public_ref,
      'resolution_id',resolution_row.id,'resolution_public_ref',resolution_row.public_ref,
      'winning_report_version_id',version_row.id,'winning_report_version_ref',version_row.version_ref,
      'pledge_id',pledge.id,'sealed_amount_lamports',pledge.amount_lamports::text,
      'confirmed_before_lamports',confirmed_total::text
    );
  else
    if jsonb_typeof(p_request->'recipients') <> 'array'
       or jsonb_array_length(p_request->'recipients') not between 1 and max_recipients then
      raise exception 'Support recipient request is invalid' using errcode='22023';
    end if;
    for request_item,item_ordinal in
      select entry.value,entry.ordinality
        from jsonb_array_elements(p_request->'recipients') with ordinality as entry(value,ordinality)
    loop
      recipient_type := request_item->>'target_type';
      recipient_target_ref := request_item->>'target_ref';
      recipient_amount := case when request_item->>'amount_lamports' ~ '^[1-9][0-9]*$'
        then (request_item->>'amount_lamports')::bigint end;
      if recipient_amount is null or recipient_amount <= 0 or recipient_amount > max_lamports then
        raise exception 'Support amount is invalid' using errcode='22023';
      end if;
      if recipient_type = 'report_author' then
        select version.* into version_row from public.case_report_versions as version
         where version.version_ref=recipient_target_ref and version.lifecycle_state='published'
           and version.published_at is not null;
        select report.* into report_row from public.case_reports as report
         where report.id=version_row.report_id and report.current_published_version_id=version_row.id;
        select case_item.* into case_row from public.cases as case_item
         where case_item.id=report_row.case_id and case_item.visibility='public';
        recipient_wallet := report_row.author_wallet; current_context := version_row.version_ref;
        context_version_id := version_row.id; context_case_id := case_row.id;
      elsif recipient_type = 'analyst' then
        select analyst.* into profile from public.analyst_profiles as analyst
         where analyst.wallet=recipient_target_ref and analyst.status in (
           'probationary_analyst','verified_analyst','senior_analyst'
         ) and analyst.verified=true and analyst.approved=true and analyst.weight_cached between 0.50 and 3.00;
        recipient_wallet := profile.wallet;
        current_context := 'OSI-AN-' || upper(substr(osi_private.osi_v2_payment_hash(to_jsonb(profile.wallet)),1,16));
      elsif recipient_type = 'counted_reviewer' then
        select version.* into version_row from public.case_report_versions as version
         where version.version_ref=recipient_target_ref and version.lifecycle_state='published'
           and version.published_at is not null;
        select review.* into review_row from public.case_report_reviews as review
         where review.report_version_id=version_row.id
           and review.reviewer_wallet=request_item->>'reviewer_wallet'
           and review.is_active=true and review.weight between 0.50 and 3.00
         order by review.created_at desc limit 1;
        select analyst.* into profile from public.analyst_profiles as analyst
         where analyst.wallet=review_row.reviewer_wallet and analyst.status in (
           'probationary_analyst','verified_analyst','senior_analyst'
         ) and analyst.verified=true and analyst.approved=true;
        select report.* into report_row from public.case_reports as report
         where report.id=version_row.report_id and report.current_published_version_id=version_row.id;
        select case_item.* into case_row from public.cases as case_item
         where case_item.id=report_row.case_id and case_item.visibility='public';
        recipient_wallet := profile.wallet; current_context := version_row.version_ref;
        context_version_id := version_row.id; context_case_id := case_row.id;
      else
        raise exception 'Unsupported support target type' using errcode='22023';
      end if;
      if recipient_wallet is null or recipient_wallet=p_payer_wallet then
        raise exception 'Support recipient is unavailable or is the payer' using errcode='42501';
      end if;
      if expected_context is null then expected_context:=current_context;
      elsif expected_context is distinct from current_context then
        raise exception 'One support transaction cannot span different targets or Cases' using errcode='23514';
      end if;
      if server_manifest @> jsonb_build_array(jsonb_build_object('wallet',recipient_wallet)) then
        raise exception 'Support recipients must be unique' using errcode='23514';
      end if;
      server_manifest := server_manifest || jsonb_build_array(jsonb_build_object(
        'ordinal',item_ordinal,'wallet',recipient_wallet,'amount_lamports',recipient_amount::text,
        'recipient_type',recipient_type,'target_ref',current_context
      ));
      actual_total := actual_total + recipient_amount;
      if actual_total > max_lamports then raise exception 'Support total exceeds the bounded limit' using errcode='23514'; end if;
    end loop;
    actual_purpose := 'SUPPORT_PAYMENT_CONFIRMED'; actual_actor_role := 'wallet';
    actual_target_public_ref := expected_context;
    server_binding := jsonb_build_object(
      'case_id',context_case_id,'context_report_version_id',context_version_id,
      'support_context_ref',expected_context
    );
  end if;
  actual_manifest_hash := osi_private.osi_v2_payment_hash(server_manifest);
  exact_hash := osi_private.osi_v2_payment_hash(jsonb_build_object(
    'payment_kind',p_payment_kind,'payment_id',actual_payment_id,'payer_wallet',p_payer_wallet,
    'target_public_ref',actual_target_public_ref,'recipient_manifest',server_manifest,
    'manifest_hash',actual_manifest_hash,'total_lamports',actual_total::text,
    'server_binding',server_binding
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osi2-payment-idempotency:' || p_idempotency_key,0));
  select nonce.* into existing from public.osi_nonces as nonce
   where nonce.idempotency_key=p_idempotency_key for update;
  if found then
    if existing.actor_wallet is distinct from p_payer_wallet
       or existing.binding_context->>'payment_kind' is distinct from p_payment_kind
       or existing.binding_context->>'target_ref_input' is distinct from p_target_ref
       or existing.binding_context->'client_request' is distinct from p_request then
      raise exception 'Idempotency key is bound to another exact payment intent' using errcode='23514';
    end if;
    return query select existing.nonce,existing.purpose,existing.target_id::uuid,
      existing.binding_context->>'payment_kind',existing.binding_context->>'target_public_ref',
      existing.binding_context->>'actor_role',existing.binding_context->'recipient_manifest',
      existing.binding_context->>'manifest_hash',(existing.binding_context->>'total_lamports')::bigint,
      existing.payload_hash,existing.binding_context->>'memo',existing.issued_at,existing.expires_at,
      existing.consumed_by_receipt_id,true;
    return;
  end if;
  perform osi_private.osi_v2_payment_rate_limit(p_payer_wallet,p_request_fingerprint_hash,issued_time);
  ttl_seconds := osi_private.osi_v2_payment_config_integer('OSI_V2_PAYMENT_NONCE_TTL_SECONDS',30,300);
  expires_time := issued_time + pg_catalog.make_interval(secs=>ttl_seconds);
  canonical_memo := concat_ws('|','OSI2','1',actual_purpose,
    't='||case when p_payment_kind='reward' then 'reward' else 'support' end,
    'id='||actual_target_public_ref,'a='||p_payer_wallet,'r='||actual_actor_role,
    'd='||case when p_payment_kind='reward' then 'paid' else 'sent' end,
    'n='||p_nonce,'h='||exact_hash,'ts='||floor(extract(epoch from issued_time))::bigint);
  insert into public.osi_nonces (
    nonce,purpose,actor_wallet,target_type,target_id,payload_hash,idempotency_key,
    request_fingerprint_hash,binding_context,issued_at,expires_at
  ) values (
    p_nonce,actual_purpose,p_payer_wallet,case when p_payment_kind='reward' then 'reward' else 'support' end,
    actual_payment_id::text,exact_hash,p_idempotency_key,p_request_fingerprint_hash,
    server_binding || jsonb_build_object(
      'payment_kind',p_payment_kind,'target_ref_input',p_target_ref,'target_public_ref',actual_target_public_ref,
      'actor_role',actual_actor_role,'recipient_manifest',server_manifest,'manifest_hash',actual_manifest_hash,
      'total_lamports',actual_total::text,'memo',canonical_memo,'client_request',p_request
    ),issued_time,expires_time
  );
  return query select p_nonce,actual_purpose,actual_payment_id,p_payment_kind,actual_target_public_ref,
    actual_actor_role,server_manifest,actual_manifest_hash,actual_total,exact_hash,canonical_memo,
    issued_time,expires_time,null::uuid,false;
end
$$;

create function osi_private.osi_v2_record_payment_submission(p_nonce text,p_tx_sig text)
returns table (payment_id uuid,payment_kind text,state text,tx_sig text,idempotent_replay boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  bound public.osi_nonces%rowtype;
  existing_reward public.reward_payments%rowtype;
  existing_support public.support_events%rowtype;
  manifest jsonb;
  first_recipient jsonb;
  pledge public.reward_pledges%rowtype;
begin
  if osi_private.osi_v2_payment_writes_enabled() is distinct from true then
    raise exception 'OSI V2 payment writes are disabled' using errcode='55000';
  end if;
  if p_tx_sig !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$' then raise exception 'Transaction signature is invalid' using errcode='22023'; end if;
  select nonce.* into bound from public.osi_nonces as nonce where nonce.nonce=p_nonce for update;
  if bound.nonce is null or bound.purpose not in ('REWARD_PAYMENT_CONFIRMED','SUPPORT_PAYMENT_CONFIRMED')
     or bound.consumed_at is not null or statement_timestamp()>bound.expires_at+interval '120 seconds' then
    raise exception 'Payment intent is unavailable or expired' using errcode='23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osi2-payment-tx:'||p_tx_sig,0));
  manifest:=bound.binding_context->'recipient_manifest'; first_recipient:=manifest->0;
  if bound.purpose='REWARD_PAYMENT_CONFIRMED' then
    select payment.* into existing_reward from public.reward_payments as payment where payment.intent_nonce=bound.nonce for update;
    if existing_reward.id is not null then
      if existing_reward.tx_sig is distinct from p_tx_sig then raise exception 'Payment intent is bound to another transaction' using errcode='23514'; end if;
      return query select existing_reward.id,'reward',existing_reward.state,existing_reward.tx_sig,true;return;
    end if;
    select reward.* into pledge from public.reward_pledges as reward
     where reward.id=(bound.binding_context->>'pledge_id')::uuid for update;
    insert into public.reward_payments (
      id,pledge_id,from_wallet,to_wallet,amount_lamports,tx_sig,state,intent_nonce,cluster,submitted_at
    ) values (
      bound.target_id::uuid,pledge.id,bound.actor_wallet,first_recipient->>'wallet',
      (first_recipient->>'amount_lamports')::bigint,p_tx_sig,'submitted',bound.nonce,'mainnet-beta',statement_timestamp()
    ) returning * into existing_reward;
    return query select existing_reward.id,'reward',existing_reward.state,existing_reward.tx_sig,false;
  else
    select support.* into existing_support from public.support_events as support where support.intent_nonce=bound.nonce for update;
    if existing_support.id is not null then
      if existing_support.tx_sig is distinct from p_tx_sig then raise exception 'Payment intent is bound to another transaction' using errcode='23514'; end if;
      return query select existing_support.id,'support',existing_support.state,existing_support.tx_sig,true;return;
    end if;
    insert into public.support_events (
      id,support_type,case_report_version_id,analyst_wallet,target_wallet,from_wallet,
      amount_lamports,tx_sig,state,intent_nonce,case_id,context_report_version_id,
      recipient_manifest,manifest_hash,cluster
    ) values (
      bound.target_id::uuid,
      case when first_recipient->>'recipient_type'='report_author' then 'report_author' else 'analyst' end,
      case when first_recipient->>'recipient_type'='report_author' then nullif(bound.binding_context->>'context_report_version_id','')::uuid else null end,
      case when first_recipient->>'recipient_type'<>'report_author' then first_recipient->>'wallet' else null end,
      first_recipient->>'wallet',bound.actor_wallet,(bound.binding_context->>'total_lamports')::bigint,
      p_tx_sig,'submitted',bound.nonce,nullif(bound.binding_context->>'case_id','')::uuid,
      nullif(bound.binding_context->>'context_report_version_id','')::uuid,manifest,
      bound.binding_context->>'manifest_hash','mainnet-beta'
    ) returning * into existing_support;
    return query select existing_support.id,'support',existing_support.state,existing_support.tx_sig,false;
  end if;
end
$$;

create function osi_private.osi_v2_commit_payment(
  p_nonce text,p_tx_sig text,p_slot bigint,p_block_time timestamptz,p_finality text,p_rpc_metadata jsonb
)
returns table (
  payment_id uuid,payment_kind text,state text,receipt_id uuid,
  pledge_state text,confirmed_total_lamports bigint,outstanding_lamports bigint,
  idempotent_replay boolean
)
language plpgsql security invoker set search_path = '' as $$
declare
  bound public.osi_nonces%rowtype;
  reward_payment public.reward_payments%rowtype;
  support public.support_events%rowtype;
  pledge public.reward_pledges%rowtype;
  receipt public.event_receipts%rowtype;
  new_receipt_id uuid:=gen_random_uuid();
  total_confirmed bigint:=0;
  remaining bigint:=0;
  metadata jsonb;
begin
  if osi_private.osi_v2_payment_writes_enabled() is distinct from true then
    raise exception 'OSI V2 payment writes are disabled' using errcode='55000';
  end if;
  if p_tx_sig !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$' or p_slot<=0 or p_finality<>'finalized'
     or jsonb_typeof(p_rpc_metadata)<>'object' then
    raise exception 'Finalized payment verification metadata is invalid' using errcode='22023';
  end if;
  select nonce.* into bound from public.osi_nonces as nonce where nonce.nonce=p_nonce for update;
  if bound.nonce is null or bound.purpose not in ('REWARD_PAYMENT_CONFIRMED','SUPPORT_PAYMENT_CONFIRMED') then
    raise exception 'Payment nonce binding is invalid' using errcode='23514';
  end if;
  if bound.consumed_at is not null then
    select event.* into receipt from public.event_receipts as event where event.id=bound.consumed_by_receipt_id;
    if receipt.tx_sig is distinct from p_tx_sig then raise exception 'Consumed payment nonce is bound to another transaction' using errcode='23514'; end if;
    if bound.purpose='REWARD_PAYMENT_CONFIRMED' then
      select payment.* into reward_payment from public.reward_payments as payment where payment.intent_nonce=bound.nonce;
      select reward.* into pledge from public.reward_pledges as reward where reward.id=reward_payment.pledge_id;
      select coalesce(sum(payment.amount_lamports),0) into total_confirmed from public.reward_payments as payment where payment.pledge_id=pledge.id and payment.state='confirmed';
      remaining:=greatest(pledge.amount_lamports-total_confirmed,0);
      return query select reward_payment.id,'reward',reward_payment.state,receipt.id,pledge.state,total_confirmed,remaining,true;
    else
      select event.* into support from public.support_events as event where event.intent_nonce=bound.nonce;
      return query select support.id,'support',support.state,receipt.id,null::text,support.amount_lamports,0::bigint,true;
    end if;
    return;
  end if;
  if statement_timestamp()>bound.expires_at+interval '120 seconds' then
    raise exception 'Payment verification window expired' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('osi2-payment-tx:'||p_tx_sig,0));
  metadata:=p_rpc_metadata || jsonb_build_object(
    'payment_kind',bound.binding_context->>'payment_kind','cluster','mainnet-beta',
    'finality','finalized','slot',p_slot::text,'block_time',p_block_time,
    'payer_wallet',bound.actor_wallet,'recipient_manifest',bound.binding_context->'recipient_manifest',
    'manifest_hash',bound.binding_context->>'manifest_hash',
    'total_lamports',bound.binding_context->>'total_lamports',
    'target_public_ref',bound.binding_context->>'target_public_ref',
    'server_rpc_verified',true,'system_program_transfers_verified',true,'memo_verified',true
  );
  insert into public.event_receipts (
    id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,actor_role,
    decision,proof_type,memo_ref,anchor_wallet,payload_hash,nonce,tx_sig,
    server_verified,occurred_at,verification_metadata
  ) values (
    new_receipt_id,'OSI2',bound.purpose,bound.target_type,bound.target_id,
    bound.binding_context->>'target_public_ref',bound.actor_wallet,bound.binding_context->>'actor_role',
    case when bound.purpose='REWARD_PAYMENT_CONFIRMED' then 'paid' else 'sent' end,
    'solana_memo',bound.binding_context->>'memo',bound.actor_wallet,bound.payload_hash,bound.nonce,p_tx_sig,
    true,p_block_time,metadata
  ) returning * into receipt;
  if bound.purpose='REWARD_PAYMENT_CONFIRMED' then
    select payment.* into reward_payment from public.reward_payments as payment where payment.intent_nonce=bound.nonce for update;
    if reward_payment.id is null then perform osi_private.osi_v2_record_payment_submission(bound.nonce,p_tx_sig); end if;
    update public.reward_payments as payment
       set state='confirmed',confirmed_at=p_block_time,event_receipt_id=new_receipt_id,
           slot=p_slot,block_time=p_block_time,finality='finalized',verification_error=null,
           updated_at=statement_timestamp()
     where payment.intent_nonce=bound.nonce and payment.tx_sig=p_tx_sig and payment.state='submitted'
    returning * into reward_payment;
    if reward_payment.id is null then raise exception 'Reward payment changed concurrently' using errcode='40001'; end if;
    select reward.* into pledge from public.reward_pledges as reward where reward.id=reward_payment.pledge_id for update;
    select coalesce(sum(payment.amount_lamports),0) into total_confirmed from public.reward_payments as payment where payment.pledge_id=pledge.id and payment.state='confirmed';
    if total_confirmed>pledge.amount_lamports then raise exception 'Confirmed reward exceeds sealed pledge' using errcode='23514'; end if;
    remaining:=pledge.amount_lamports-total_confirmed;
    if remaining=0 and pledge.state='assigned' then
      update public.reward_pledges as reward set state='paid',updated_at=statement_timestamp() where reward.id=pledge.id returning * into pledge;
    end if;
  else
    select event.* into support from public.support_events as event where event.intent_nonce=bound.nonce for update;
    if support.id is null then perform osi_private.osi_v2_record_payment_submission(bound.nonce,p_tx_sig); end if;
    update public.support_events as event
       set state='confirmed',confirmed_at=p_block_time,event_receipt_id=new_receipt_id,
           slot=p_slot,block_time=p_block_time,finality='finalized',verification_error=null,
           updated_at=statement_timestamp()
     where event.intent_nonce=bound.nonce and event.tx_sig=p_tx_sig and event.state='submitted'
    returning * into support;
    if support.id is null then raise exception 'Support payment changed concurrently' using errcode='40001'; end if;
    total_confirmed:=support.amount_lamports;remaining:=0;
  end if;
  update public.osi_nonces as nonce
     set consumed_at=statement_timestamp(),consumed_by_receipt_id=new_receipt_id,updated_at=statement_timestamp()
   where nonce.nonce=bound.nonce and nonce.consumed_at is null;
  if not found then raise exception 'Payment nonce replayed concurrently' using errcode='40001'; end if;
  return query select bound.target_id::uuid,bound.binding_context->>'payment_kind','confirmed',new_receipt_id,
    case when bound.purpose='REWARD_PAYMENT_CONFIRMED' then pledge.state else null end,
    total_confirmed,remaining,false;
end
$$;

create function osi_private.osi_v2_record_payment_failure(
  p_nonce text,p_tx_sig text,p_error text
)
returns table (payment_id uuid,payment_kind text,state text,verification_error text)
language plpgsql security invoker set search_path='' as $$
declare
  bound public.osi_nonces%rowtype;
  reward_payment public.reward_payments%rowtype;
  support public.support_events%rowtype;
begin
  if osi_private.osi_v2_payment_writes_enabled() is distinct from true then
    raise exception 'OSI V2 payment writes are disabled' using errcode='55000';
  end if;
  if p_tx_sig !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$' or p_error not in (
    'transaction_failed','wrong_fee_payer','unexpected_signer','signature_mismatch',
    'transaction_not_fresh','unexpected_instruction','memo_mismatch',
    'transfer_count_mismatch','transfer_manifest_mismatch','slot_invalid'
  ) then
    raise exception 'Payment failure metadata is invalid' using errcode='22023';
  end if;
  select nonce.* into bound from public.osi_nonces as nonce where nonce.nonce=p_nonce for update;
  if bound.nonce is null or bound.purpose not in ('REWARD_PAYMENT_CONFIRMED','SUPPORT_PAYMENT_CONFIRMED')
     or bound.consumed_at is not null then
    raise exception 'Payment failure nonce binding is invalid' using errcode='23514';
  end if;
  perform osi_private.osi_v2_record_payment_submission(p_nonce,p_tx_sig);
  if bound.purpose='REWARD_PAYMENT_CONFIRMED' then
    update public.reward_payments as payment
       set state='failed',verification_error=p_error,updated_at=statement_timestamp()
     where payment.intent_nonce=p_nonce and payment.tx_sig=p_tx_sig and payment.state='submitted'
     returning * into reward_payment;
    if reward_payment.id is null then
      select payment.* into reward_payment from public.reward_payments as payment
       where payment.intent_nonce=p_nonce and payment.tx_sig=p_tx_sig
         and payment.state='failed' and payment.verification_error=p_error;
    end if;
    if reward_payment.id is null then raise exception 'Reward failure state changed concurrently' using errcode='40001'; end if;
    return query select reward_payment.id,'reward',reward_payment.state,reward_payment.verification_error;
  else
    update public.support_events as event
       set state='failed',verification_error=p_error,updated_at=statement_timestamp()
     where event.intent_nonce=p_nonce and event.tx_sig=p_tx_sig and event.state='submitted'
     returning * into support;
    if support.id is null then
      select event.* into support from public.support_events as event
       where event.intent_nonce=p_nonce and event.tx_sig=p_tx_sig
         and event.state='failed' and event.verification_error=p_error;
    end if;
    if support.id is null then raise exception 'Support failure state changed concurrently' using errcode='40001'; end if;
    return query select support.id,'support',support.state,support.verification_error;
  end if;
end
$$;

create function public.osi_v2_prepare_pledge(
  p_nonce text,p_action text,p_actor_wallet text,p_case_ref text,p_amount_lamports bigint,
  p_idempotency_key text,p_request_fingerprint_hash text
)
returns table (
  issued_nonce text,purpose text,pledge_id uuid,case_public_ref text,amount_lamports bigint,
  revision_no integer,payload_hash text,proof_text text,issued_at timestamptz,expires_at timestamptz,
  consumed_receipt_id uuid,idempotent_replay boolean
)
language sql security invoker set search_path='' as $$
  select * from osi_private.osi_v2_prepare_pledge(
    p_nonce,p_action,p_actor_wallet,p_case_ref,p_amount_lamports,p_idempotency_key,p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_commit_pledge(
  p_nonce text,p_action text,p_amount_lamports bigint,p_proof_text text,p_signature text
)
returns table (
  pledge_id uuid,case_public_ref text,state text,amount_lamports bigint,
  revision_no integer,receipt_id uuid,idempotent_replay boolean
)
language sql security invoker set search_path='' as $$
  select * from osi_private.osi_v2_commit_pledge(p_nonce,p_action,p_amount_lamports,p_proof_text,p_signature)
$$;

create function public.osi_v2_prepare_payment(
  p_nonce text,p_payment_kind text,p_payer_wallet text,p_target_ref text,p_request jsonb,
  p_idempotency_key text,p_request_fingerprint_hash text
)
returns table (
  issued_nonce text,purpose text,payment_id uuid,payment_kind text,target_public_ref text,
  actor_role text,recipient_manifest jsonb,manifest_hash text,total_lamports bigint,
  payload_hash text,memo text,issued_at timestamptz,expires_at timestamptz,
  consumed_receipt_id uuid,idempotent_replay boolean
)
language sql security invoker set search_path='' as $$
  select * from osi_private.osi_v2_prepare_payment(
    p_nonce,p_payment_kind,p_payer_wallet,p_target_ref,p_request,p_idempotency_key,p_request_fingerprint_hash
  )
$$;

create function public.osi_v2_record_payment_submission(p_nonce text,p_tx_sig text)
returns table (payment_id uuid,payment_kind text,state text,tx_sig text,idempotent_replay boolean)
language sql security invoker set search_path='' as $$
  select * from osi_private.osi_v2_record_payment_submission(p_nonce,p_tx_sig)
$$;

create function public.osi_v2_commit_payment(
  p_nonce text,p_tx_sig text,p_slot bigint,p_block_time timestamptz,p_finality text,p_rpc_metadata jsonb
)
returns table (
  payment_id uuid,payment_kind text,state text,receipt_id uuid,pledge_state text,
  confirmed_total_lamports bigint,outstanding_lamports bigint,idempotent_replay boolean
)
language sql security invoker set search_path='' as $$
  select * from osi_private.osi_v2_commit_payment(
    p_nonce,p_tx_sig,p_slot,p_block_time,p_finality,p_rpc_metadata
  )
$$;

create function public.osi_v2_record_payment_failure(p_nonce text,p_tx_sig text,p_error text)
returns table (payment_id uuid,payment_kind text,state text,verification_error text)
language sql security invoker set search_path='' as $$
  select * from osi_private.osi_v2_record_payment_failure(p_nonce,p_tx_sig,p_error)
$$;

revoke all privileges on function osi_private.osi_v2_payment_writes_enabled() from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_payment_hash(jsonb) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_payment_config_integer(text,integer,integer) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_payment_rate_limit(text,text,timestamptz) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_pledge(text,text,text,text,bigint,text,text) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_commit_pledge(text,text,bigint,text,text) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_prepare_payment(text,text,text,text,jsonb,text,text) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_record_payment_submission(text,text) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_commit_payment(text,text,bigint,timestamptz,text,jsonb) from public,anon,authenticated;
revoke all privileges on function osi_private.osi_v2_record_payment_failure(text,text,text) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_prepare_pledge(text,text,text,text,bigint,text,text) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_commit_pledge(text,text,bigint,text,text) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_prepare_payment(text,text,text,text,jsonb,text,text) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_record_payment_submission(text,text) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_commit_payment(text,text,bigint,timestamptz,text,jsonb) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_record_payment_failure(text,text,text) from public,anon,authenticated;
revoke all privileges on function public.osi_v2_freeze_reward_on_case_seal() from public,anon,authenticated;
revoke all privileges on function public.osi_v2_reject_cross_payment_tx() from public,anon,authenticated;

grant execute on function osi_private.osi_v2_prepare_pledge(text,text,text,text,bigint,text,text) to service_role;
grant execute on function osi_private.osi_v2_commit_pledge(text,text,bigint,text,text) to service_role;
grant execute on function osi_private.osi_v2_prepare_payment(text,text,text,text,jsonb,text,text) to service_role;
grant execute on function osi_private.osi_v2_record_payment_submission(text,text) to service_role;
grant execute on function osi_private.osi_v2_commit_payment(text,text,bigint,timestamptz,text,jsonb) to service_role;
grant execute on function osi_private.osi_v2_record_payment_failure(text,text,text) to service_role;
grant execute on function public.osi_v2_prepare_pledge(text,text,text,text,bigint,text,text) to service_role;
grant execute on function public.osi_v2_commit_pledge(text,text,bigint,text,text) to service_role;
grant execute on function public.osi_v2_prepare_payment(text,text,text,text,jsonb,text,text) to service_role;
grant execute on function public.osi_v2_record_payment_submission(text,text) to service_role;
grant execute on function public.osi_v2_commit_payment(text,text,bigint,timestamptz,text,jsonb) to service_role;
grant execute on function public.osi_v2_record_payment_failure(text,text,text) to service_role;
grant execute on function public.osi_v2_freeze_reward_on_case_seal() to service_role;
grant execute on function public.osi_v2_reject_cross_payment_tx() to service_role;

-- Existing money tables remain FORCE RLS/default deny. Reassert this explicitly
-- because the new columns are server-only and no browser policy is added.
alter table public.reward_pledges enable row level security;
alter table public.reward_pledges force row level security;
alter table public.reward_payments enable row level security;
alter table public.reward_payments force row level security;
alter table public.support_events enable row level security;
alter table public.support_events force row level security;
revoke all privileges on table public.reward_pledges,public.reward_payments,public.support_events
  from public,anon,authenticated;
grant select,insert,update on table public.reward_pledges,public.reward_payments,public.support_events
  to service_role;

comment on column public.event_receipts.verification_metadata is
  'Server-only structured proof detail. Public DTOs expose only allowlisted payment fields.';
comment on column public.support_events.recipient_manifest is
  'Bounded server-derived atomic support recipients. Never used by ranking, reputation, weight or governance.';
comment on function public.osi_v2_prepare_payment(text,text,text,text,jsonb,text,text) is
  'Server-only payment intent reservation. Derives recipients and exact lamports; it does not move funds.';
comment on function public.osi_v2_commit_payment(text,text,bigint,timestamptz,text,jsonb) is
  'Server-only finalized mainnet System Program transfer + canonical Memo commit.';

commit;
