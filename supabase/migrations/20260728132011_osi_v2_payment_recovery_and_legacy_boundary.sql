-- Production hardening follow-up.
--
-- 1. Close the legacy browser write/list paths that survived the earlier
--    name-based policy cleanup, while retaining approved request reads and
--    public-bucket object URL fetches.
-- 2. Add a service-role-only, exact-intent recovery path for a finalized SOL
--    transfer that a former transaction parser rejected. Recovery never issues
--    a replacement intent and never accepts a different signature.

begin;
set local lock_timeout = '5s';

create function osi_private.osi_v2_apply_legacy_boundary()
returns void
language plpgsql security invoker set search_path='' as $migration$
begin
  if to_regclass('public.onchain_events') is not null then
    execute 'alter table public.onchain_events enable row level security';
    execute 'alter table public.onchain_events force row level security';
    execute 'drop policy if exists "onchain_events insert" on public.onchain_events';
    execute 'revoke insert, update, delete, truncate on table public.onchain_events from public, anon, authenticated';
    execute 'grant select on table public.onchain_events to anon, authenticated';
  end if;

  if to_regclass('public.requests') is not null then
    execute 'alter table public.requests enable row level security';
    execute 'alter table public.requests force row level security';
    execute 'drop policy if exists "read requests" on public.requests';
    execute 'drop policy if exists "admin delete" on public.requests';
    execute 'drop policy if exists "admin read" on public.requests';
    execute 'drop policy if exists "admin update" on public.requests';
    execute 'drop policy if exists "requests_insert" on public.requests';
    execute 'drop policy if exists "requests_read" on public.requests';
    execute 'drop policy if exists "requests approved public read" on public.requests';
    execute 'revoke insert, update, delete, truncate on table public.requests from public, anon, authenticated';
    execute 'grant select on table public.requests to anon, authenticated';
    execute 'create policy "requests approved public read" on public.requests for select to anon, authenticated using (approved is true)';
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists "osi storage upload" on storage.objects';
    execute 'drop policy if exists "osi storage read" on storage.objects';
  end if;
end
$migration$;

select osi_private.osi_v2_apply_legacy_boundary();
drop function osi_private.osi_v2_apply_legacy_boundary();

create or replace function osi_private.osi_v2_record_payment_failure(
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
  if p_tx_sig is null or p_tx_sig !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'
     or p_error is null or p_error not in (
    'transaction_failed','wrong_fee_payer','unexpected_signer','signature_mismatch',
    'transaction_not_fresh','unexpected_instruction','memo_mismatch',
    'transfer_count_mismatch','transfer_manifest_mismatch','slot_invalid',
    'account_metadata_invalid','duplicate_account_key','writable_account_mismatch',
    'invalid_compute_budget_instruction','unsafe_lighthouse_instruction',
    'slot_mismatch','inner_instruction_present','token_balance_change',
    'unexpected_reward_balance_change','loaded_address_present',
    'balance_metadata_invalid','fee_out_of_range','payer_balance_mismatch',
    'recipient_balance_mismatch','unexpected_balance_change'
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
    if reward_payment.id is null then
      raise exception 'Reward failure state changed concurrently' using errcode='40001';
    end if;
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
    if support.id is null then
      raise exception 'Support failure state changed concurrently' using errcode='40001';
    end if;
    return query select support.id,'support',support.state,support.verification_error;
  end if;
end
$$;

create function osi_private.osi_v2_recover_payment(
  p_nonce text,p_tx_sig text,p_slot bigint,p_block_time timestamptz,
  p_finality text,p_rpc_metadata jsonb
)
returns table (
  payment_id uuid,payment_kind text,state text,receipt_id uuid,
  pledge_state text,confirmed_total_lamports bigint,outstanding_lamports bigint,
  idempotent_replay boolean
)
language plpgsql security invoker set search_path='' as $$
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
  manifest jsonb;
  first_recipient jsonb;
  prior_failure text;
begin
  if osi_private.osi_v2_payment_writes_enabled() is distinct from true then
    raise exception 'OSI V2 payment writes are disabled' using errcode='55000';
  end if;
  if p_tx_sig is null or p_tx_sig !~ '^[1-9A-HJ-NP-Za-km-z]{64,96}$'
     or p_slot is null or p_slot<=0 or p_block_time is null
     or p_finality is distinct from 'finalized'
     or jsonb_typeof(p_rpc_metadata) is distinct from 'object'
     or p_rpc_metadata->>'historical_reverification' is distinct from 'true'
     or p_rpc_metadata->>'server_rpc_verified' is distinct from 'true'
     or p_rpc_metadata->>'balance_deltas_verified' is distinct from 'true'
     or p_rpc_metadata->>'writable_accounts_verified' is distinct from 'true'
     or p_rpc_metadata->>'no_token_or_inner_transfers' is distinct from 'true' then
    raise exception 'Historical payment verification metadata is invalid' using errcode='22023';
  end if;

  select nonce.* into bound
    from public.osi_nonces as nonce
   where nonce.nonce=p_nonce
   for update;
  if bound.nonce is null
     or bound.purpose not in ('REWARD_PAYMENT_CONFIRMED','SUPPORT_PAYMENT_CONFIRMED')
     or coalesce(bound.binding_context->>'payment_kind','') not in ('reward','support') then
    raise exception 'Payment recovery nonce binding is invalid' using errcode='23514';
  end if;
  if bound.consumed_at is not null then
    select event.* into receipt
      from public.event_receipts as event
     where event.id=bound.consumed_by_receipt_id;
    if receipt.id is null or receipt.tx_sig is distinct from p_tx_sig then
      raise exception 'Consumed payment nonce is bound to another transaction' using errcode='23514';
    end if;
    if bound.purpose='REWARD_PAYMENT_CONFIRMED' then
      select payment.* into reward_payment
        from public.reward_payments as payment
       where payment.intent_nonce=bound.nonce;
      if reward_payment.id is null then
        raise exception 'Consumed reward nonce has no exact payment' using errcode='23514';
      end if;
      select reward.* into pledge
        from public.reward_pledges as reward
       where reward.id=reward_payment.pledge_id;
      select coalesce(sum(payment.amount_lamports),0) into total_confirmed
        from public.reward_payments as payment
       where payment.pledge_id=pledge.id and payment.state='confirmed';
      remaining:=greatest(pledge.amount_lamports-total_confirmed,0);
      return query select reward_payment.id,'reward',reward_payment.state,receipt.id,
        pledge.state,total_confirmed,remaining,true;
    else
      select event.* into support
        from public.support_events as event
       where event.intent_nonce=bound.nonce;
      if support.id is null then
        raise exception 'Consumed support nonce has no exact payment' using errcode='23514';
      end if;
      return query select support.id,'support',support.state,receipt.id,null::text,
        support.amount_lamports,0::bigint,true;
    end if;
    return;
  end if;
  if p_block_time < bound.issued_at-interval '5 seconds'
     or p_block_time > bound.expires_at+interval '120 seconds' then
    raise exception 'Recovered transaction time is outside the original intent window' using errcode='23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('osi2-payment-tx:'||p_tx_sig,0)
  );
  manifest:=bound.binding_context->'recipient_manifest';
  first_recipient:=manifest->0;

  if bound.purpose='REWARD_PAYMENT_CONFIRMED' then
    select payment.* into reward_payment
      from public.reward_payments as payment
     where payment.intent_nonce=bound.nonce
     for update;
    if reward_payment.id is null then
      select reward.* into pledge
        from public.reward_pledges as reward
       where reward.id=(bound.binding_context->>'pledge_id')::uuid
       for update;
      insert into public.reward_payments (
        id,pledge_id,from_wallet,to_wallet,amount_lamports,tx_sig,state,
        intent_nonce,cluster,submitted_at
      ) values (
        bound.target_id::uuid,pledge.id,bound.actor_wallet,first_recipient->>'wallet',
        (first_recipient->>'amount_lamports')::bigint,p_tx_sig,'submitted',
        bound.nonce,'mainnet-beta',statement_timestamp()
      ) returning * into reward_payment;
    elsif reward_payment.tx_sig is distinct from p_tx_sig
       or reward_payment.state not in ('submitted','failed')
       or (reward_payment.state='failed'
           and reward_payment.verification_error is distinct from 'unexpected_instruction') then
      raise exception 'Reward recovery is not bound to the known parser failure' using errcode='23514';
    else
      prior_failure:=reward_payment.verification_error;
      select reward.* into pledge
        from public.reward_pledges as reward
       where reward.id=reward_payment.pledge_id
       for update;
    end if;
  else
    select event.* into support
      from public.support_events as event
     where event.intent_nonce=bound.nonce
     for update;
    if support.id is null then
      insert into public.support_events (
        id,support_type,case_report_version_id,analyst_wallet,target_wallet,
        from_wallet,amount_lamports,tx_sig,state,intent_nonce,case_id,
        context_report_version_id,recipient_manifest,manifest_hash,cluster
      ) values (
        bound.target_id::uuid,
        case when first_recipient->>'recipient_type'='report_author'
          then 'report_author' else 'analyst' end,
        case when first_recipient->>'recipient_type'='report_author'
          then nullif(bound.binding_context->>'context_report_version_id','')::uuid else null end,
        case when first_recipient->>'recipient_type'<>'report_author'
          then first_recipient->>'wallet' else null end,
        first_recipient->>'wallet',bound.actor_wallet,
        (bound.binding_context->>'total_lamports')::bigint,p_tx_sig,'submitted',
        bound.nonce,nullif(bound.binding_context->>'case_id','')::uuid,
        nullif(bound.binding_context->>'context_report_version_id','')::uuid,
        manifest,bound.binding_context->>'manifest_hash','mainnet-beta'
      ) returning * into support;
    elsif support.tx_sig is distinct from p_tx_sig
       or support.state not in ('submitted','failed')
       or (support.state='failed'
           and support.verification_error is distinct from 'unexpected_instruction') then
      raise exception 'Support recovery is not bound to the known parser failure' using errcode='23514';
    else
      prior_failure:=support.verification_error;
    end if;
  end if;

  metadata:=p_rpc_metadata || jsonb_build_object(
    'payment_kind',bound.binding_context->>'payment_kind',
    'cluster','mainnet-beta','finality','finalized','slot',p_slot::text,
    'block_time',p_block_time,'payer_wallet',bound.actor_wallet,
    'recipient_manifest',bound.binding_context->'recipient_manifest',
    'manifest_hash',bound.binding_context->>'manifest_hash',
    'total_lamports',bound.binding_context->>'total_lamports',
    'target_public_ref',bound.binding_context->>'target_public_ref',
    'original_issued_at',bound.issued_at,'original_expires_at',bound.expires_at,
    'previous_verification_error',prior_failure,
    'server_rpc_verified',true,'system_program_transfers_verified',true,
    'memo_verified',true,'historical_reverification',true
  );
  insert into public.event_receipts (
    id,event_version,event_type,target_type,target_id,public_ref,actor_wallet,
    actor_role,decision,proof_type,memo_ref,anchor_wallet,payload_hash,nonce,
    tx_sig,server_verified,occurred_at,verification_metadata
  ) values (
    new_receipt_id,'OSI2',bound.purpose,bound.target_type,bound.target_id,
    bound.binding_context->>'target_public_ref',bound.actor_wallet,
    bound.binding_context->>'actor_role',
    case when bound.purpose='REWARD_PAYMENT_CONFIRMED' then 'paid' else 'sent' end,
    'solana_memo',bound.binding_context->>'memo',bound.actor_wallet,
    bound.payload_hash,bound.nonce,p_tx_sig,true,p_block_time,metadata
  ) returning * into receipt;

  if bound.purpose='REWARD_PAYMENT_CONFIRMED' then
    update public.reward_payments as payment
       set state='confirmed',confirmed_at=p_block_time,event_receipt_id=new_receipt_id,
           slot=p_slot,block_time=p_block_time,finality='finalized',
           verification_error=null,updated_at=statement_timestamp()
     where payment.intent_nonce=bound.nonce and payment.tx_sig=p_tx_sig
       and (
         payment.state='submitted'
         or (payment.state='failed' and payment.verification_error='unexpected_instruction')
       )
    returning * into reward_payment;
    if reward_payment.id is null then
      raise exception 'Reward recovery changed concurrently' using errcode='40001';
    end if;
    select coalesce(sum(payment.amount_lamports),0) into total_confirmed
      from public.reward_payments as payment
     where payment.pledge_id=pledge.id and payment.state='confirmed';
    if total_confirmed>pledge.amount_lamports then
      raise exception 'Recovered reward exceeds sealed pledge' using errcode='23514';
    end if;
    remaining:=pledge.amount_lamports-total_confirmed;
    if remaining=0 and pledge.state='assigned' then
      update public.reward_pledges as reward
         set state='paid',updated_at=statement_timestamp()
       where reward.id=pledge.id
      returning * into pledge;
    end if;
  else
    update public.support_events as event
       set state='confirmed',confirmed_at=p_block_time,event_receipt_id=new_receipt_id,
           slot=p_slot,block_time=p_block_time,finality='finalized',
           verification_error=null,updated_at=statement_timestamp()
     where event.intent_nonce=bound.nonce and event.tx_sig=p_tx_sig
       and (
         event.state='submitted'
         or (event.state='failed' and event.verification_error='unexpected_instruction')
       )
    returning * into support;
    if support.id is null then
      raise exception 'Support recovery changed concurrently' using errcode='40001';
    end if;
    total_confirmed:=support.amount_lamports;
    remaining:=0;
  end if;

  update public.osi_nonces as nonce
     set consumed_at=statement_timestamp(),consumed_by_receipt_id=new_receipt_id,
         updated_at=statement_timestamp()
   where nonce.nonce=bound.nonce and nonce.consumed_at is null;
  if not found then
    raise exception 'Payment recovery replayed concurrently' using errcode='40001';
  end if;
  return query select bound.target_id::uuid,bound.binding_context->>'payment_kind',
    'confirmed',new_receipt_id,
    case when bound.purpose='REWARD_PAYMENT_CONFIRMED' then pledge.state else null end,
    total_confirmed,remaining,false;
end
$$;

create function public.osi_v2_recover_payment(
  p_nonce text,p_tx_sig text,p_slot bigint,p_block_time timestamptz,
  p_finality text,p_rpc_metadata jsonb
)
returns table (
  payment_id uuid,payment_kind text,state text,receipt_id uuid,
  pledge_state text,confirmed_total_lamports bigint,outstanding_lamports bigint,
  idempotent_replay boolean
)
language sql security invoker set search_path='' as $$
  select * from osi_private.osi_v2_recover_payment(
    p_nonce,p_tx_sig,p_slot,p_block_time,p_finality,p_rpc_metadata
  )
$$;

revoke all privileges on function
  osi_private.osi_v2_recover_payment(text,text,bigint,timestamptz,text,jsonb)
  from public,anon,authenticated;
revoke all privileges on function
  public.osi_v2_recover_payment(text,text,bigint,timestamptz,text,jsonb)
  from public,anon,authenticated;
grant execute on function
  osi_private.osi_v2_recover_payment(text,text,bigint,timestamptz,text,jsonb)
  to service_role;
grant execute on function
  public.osi_v2_recover_payment(text,text,bigint,timestamptz,text,jsonb)
  to service_role;

comment on function public.osi_v2_recover_payment(text,text,bigint,timestamptz,text,jsonb)
  is 'Service-role-only recovery for an exact finalized transaction bound to an unconsumed historical payment intent. It never issues or substitutes a transaction.';

commit;
