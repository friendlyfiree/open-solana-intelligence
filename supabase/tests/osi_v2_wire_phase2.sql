-- The Wire Phase 2 review, publication, challenge, support, and promotion lane.
-- Every fixture and config mutation is rolled back in this disposable pgTAP run.

begin;

create extension if not exists pgtap with schema extensions;
select plan(69);

select is(
  (select value from public.osi_config where key='OSI_V2_WIRE_STANDARD_MIN_COUNT'),
  '2', 'normal Wire publication requires two independent analysts'
);
select is(
  (select value from public.osi_config where key='OSI_V2_WIRE_STANDARD_MIN_WEIGHT'),
  '2.00', 'normal Wire publication requires weight 2.00'
);
select is(
  (select value from public.osi_config where key='OSI_V2_WIRE_WRITES_ENABLED'),
  'false', 'Phase 2 preserves the disabled-by-default Wire gate'
);
select isnt(
  has_function_privilege(
    'anon',
    'public.osi_v2_prepare_wire_review(text,text,uuid,text,text,text,text,text,text)',
    'EXECUTE'
  ), true, 'anonymous clients cannot prepare Wire reviews directly'
);
select isnt(
  has_function_privilege(
    'authenticated',
    'public.osi_v2_commit_wire_publication(text,text,text,timestamptz,text)',
    'EXECUTE'
  ), true, 'authenticated clients cannot publish Wire versions directly'
);
select isnt(
  has_function_privilege(
    'anon',
    'public.osi_v2_list_public_wire_reports(integer,timestamptz)',
    'EXECUTE'
  ), true, 'public Wire DTO access stays behind the service gateway'
);
select ok(
  to_regclass('public.support_events_wire_state_idx') is not null,
  'Wire support has its exact typed-target state index'
);

update public.osi_config set value='true'
 where key in (
   'OSI_V2_WIRE_WRITES_ENABLED',
   'OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED',
   'OSI_V2_CASE_WRITES_ENABLED',
   'OSI_V2_PAYMENT_WRITES_ENABLED'
 );
update public.osi_config set value='0'
 where key='OSI_V2_WIRE_COOLDOWN_SECONDS';
insert into public.osi_config (key,value) values
  ('admin_wallet','51111111111111111111111111111111')
on conflict (key) do update set value=excluded.value;

create function pg_temp.add_wire(
  p_nonce text, p_author text, p_idempotency text, p_title text
) returns table (
  wire_report_id uuid, version_id uuid,
  wire_report_public_ref text, version_public_ref text
) language plpgsql as $$
declare prepared record;
begin
  select * into prepared from public.osi_v2_prepare_wire_version(
    p_nonce, p_author, null, p_title,
    'A public-safe summary describes an exact standalone transfer finding without asserting guilt or legal certainty.',
    'The detailed Wire analysis records transaction order, wallet relationships, alternative explanations, and the exact source trail for independent review.',
    'Attribution and wallet control remain uncertain and require independent corroboration.',
    null,
    jsonb_build_array(jsonb_build_object(
      'kind','wallet','ref',p_author,
      'sha256',encode(extensions.digest(convert_to(p_author,'UTF8'),'sha256'),'hex')
    )), p_idempotency, repeat('a',64)
  );
  perform public.osi_v2_commit_wire_version(
    p_nonce, p_title,
    'A public-safe summary describes an exact standalone transfer finding without asserting guilt or legal certainty.',
    'The detailed Wire analysis records transaction order, wallet relationships, alternative explanations, and the exact source trail for independent review.',
    'Attribution and wallet control remain uncertain and require independent corroboration.',
    null,
    jsonb_build_array(jsonb_build_object(
      'kind','wallet','ref',p_author,
      'sha256',encode(extensions.digest(convert_to(p_author,'UTF8'),'sha256'),'hex')
    )), repeat(substr(p_nonce,1,1),88),
    'OSI2 test WIRE_REPORT_VERSION_SUBMITTED', statement_timestamp()
  );
  return query select prepared.wire_report_id, prepared.version_id,
    prepared.wire_report_public_ref, prepared.version_public_ref;
end
$$;

create temporary table wire_normal on commit drop as
select * from pg_temp.add_wire(
  repeat('n',32),'61111111111111111111111111111111',
  'wire-phase2-normal-intake-0001','Normal Wire publication fixture'
);
create temporary table wire_bootstrap on commit drop as
select * from pg_temp.add_wire(
  repeat('b',32),'71111111111111111111111111111111',
  'wire-phase2-bootstrap-intake-0002','Bootstrap Wire publication fixture'
);
create temporary table wire_maintainer_authored on commit drop as
select * from pg_temp.add_wire(
  repeat('m',32),'51111111111111111111111111111111',
  'wire-phase2-maintainer-intake-0003','Maintainer authored Wire fixture'
);

update public.osi_config set value='1'
 where key='OSI_V2_WIRE_COOLDOWN_SECONDS';

select ok((select active and tier='maintainer_only' and eligible_analyst_count=0
  from osi_private.osi_v2_bootstrap_tier()),
  'Wire bootstrap uses the existing tier at zero analysts');

insert into public.analyst_profiles (
  wallet,status,tier_code,verified,approved,weight_cached
)
select 'B'||repeat('1',30)||substr(
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',gs,1
),
  'probationary_analyst','probationary',true,true,0.50
from generate_series(1,19) as gs;
select ok((select active and tier='maintainer_only' and eligible_analyst_count=19
  from osi_private.osi_v2_bootstrap_tier()),
  'Wire bootstrap remains maintainer-only at nineteen analysts');
insert into public.analyst_profiles (
  wallet,status,tier_code,verified,approved,weight_cached
) values (
  'C1111111111111111111111111111111',
  'probationary_analyst','probationary',true,true,0.50
);
select ok((select active and tier='maintainer_plus_one' and eligible_analyst_count=20
  and required_analyst_count=1 and required_analyst_weight=0.50
  from osi_private.osi_v2_bootstrap_tier()),
  'Wire bootstrap requires one independent analyst at twenty analysts');
update public.analyst_profiles set
  status='revoked',tier_code='none',verified=false,approved=false,weight_cached=0
where wallet like 'B%' or wallet='C1111111111111111111111111111111';
select ok((select active and tier='maintainer_only' and eligible_analyst_count=0
  from osi_private.osi_v2_bootstrap_tier()),
  'revoked filler profiles do not count toward the live tier');

select throws_ok($test$
  select * from public.osi_v2_prepare_wire_publication(
    repeat('c',32),'51111111111111111111111111111111',
    (select version_id from wire_bootstrap),
    'wire-bootstrap-wallet-half-0001',repeat('1',64),null
  )
$test$,'42501','Wire publication requires counted quorum or both maintainer gates',
  'wallet-only half-maintainer cannot use Wire bootstrap');
select throws_ok($test$
  select * from public.osi_v2_prepare_wire_publication(
    repeat('d',32),'A1111111111111111111111111111111',
    (select version_id from wire_bootstrap),
    'wire-bootstrap-auth-half-0002',repeat('2',64),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  )
$test$,'42501','Wire publication requires counted quorum or both maintainer gates',
  'auth-only half-maintainer cannot use Wire bootstrap');
select throws_ok($test$
  select * from public.osi_v2_prepare_wire_publication(
    repeat('e',32),'51111111111111111111111111111111',
    (select version_id from wire_maintainer_authored),
    'wire-bootstrap-self-author-0003',repeat('3',64),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  )
$test$,'42501','Wire version is not available for publication by this actor',
  'bootstrap maintainer cannot publish their own exact Wire version');

create temporary table bootstrap_publication on commit drop as
select * from public.osi_v2_prepare_wire_publication(
  repeat('f',32),'51111111111111111111111111111111',
  (select version_id from wire_bootstrap),
  'wire-bootstrap-publish-0004',repeat('4',64),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);
select lives_ok($test$
  select * from public.osi_v2_commit_wire_publication(
    repeat('f',32),repeat('F',88),
    (select proof_text from bootstrap_publication),statement_timestamp(),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  )
$test$,'full maintainer publishes under the zero-analyst bootstrap tier');
select ok((select decision_channel='maintainer_bootstrap'
  and actor_role='maintainer' and proof_type='solana_memo' and server_verified
  from public.event_receipts where nonce=repeat('f',32)),
  'bootstrap publication receipt is permanently and honestly labeled');
select ok((select report.current_published_version_id=fixture.version_id
  from public.wire_reports as report cross join wire_bootstrap as fixture
  where report.id=fixture.wire_report_id),
  'bootstrap publication advances only the exact current published pointer');

insert into public.analyst_profiles (
  wallet,status,tier_code,verified,approved,weight_cached,handle,display_name
) values
  ('21111111111111111111111111111111','verified_analyst','analyst_i',true,true,1.50,'wire_a','Wire analyst A'),
  ('31111111111111111111111111111111','verified_analyst','analyst_i',true,true,1.50,'wire_b','Wire analyst B'),
  ('41111111111111111111111111111111','verified_analyst','analyst_i',true,true,1.50,'wire_c','Wire analyst C');

select throws_ok($test$
  select * from public.osi_v2_prepare_wire_review(
    repeat('g',32),'61111111111111111111111111111111',
    (select version_id from wire_normal),'approve','evidence_reviewed',
    'The exact evidence supports publication with the stated limitations.',null,
    'wire-self-review-denied-0001',repeat('5',64)
  )
$test$,'42501','Wire author cannot review this Wire version',
  'Wire author self-review is denied at the database boundary');

create function pg_temp.cast_wire_review(
  p_nonce text,p_wallet text,p_version uuid,p_decision text,p_idempotency text,
  p_note text default null
) returns void language plpgsql as $$
declare prepared record;
begin
  select * into prepared from public.osi_v2_prepare_wire_review(
    p_nonce,p_wallet,p_version,p_decision,'evidence_reviewed',
    'The exact evidence was independently reviewed against the recorded limitations.',
    p_note,p_idempotency,
    encode(extensions.digest(convert_to(p_nonce,'UTF8'),'sha256'),'hex')
  );
  perform public.osi_v2_commit_wire_review(
    p_nonce,p_decision,'evidence_reviewed',
    'The exact evidence was independently reviewed against the recorded limitations.',
    p_note,repeat('S',88),'OSI2 test wallet-signed Wire review'
  );
end
$$;

select lives_ok($test$
  select pg_temp.cast_wire_review(
    repeat('h',32),'21111111111111111111111111111111',
    (select version_id from wire_normal),'approve',
    'wire-normal-review-a-0001','WIRE_PRIVATE_NOTE_SENTINEL'
  )
$test$,'first exact-version Wire review commits');
select ok((select approve_count=1 and approve_weight=1.50 and not approve_ready
  from osi_private.osi_v2_wire_quorum((select version_id from wire_normal))),
  'one analyst cannot satisfy the normal Wire count gate');
select lives_ok($test$
  select pg_temp.cast_wire_review(
    repeat('i',32),'31111111111111111111111111111111',
    (select version_id from wire_normal),'approve','wire-normal-review-b-0002',null
  )
$test$,'second independent exact-version Wire review commits');
select ok((select approve_count=2 and approve_weight=3.00 and approve_ready
  and required_count=2 and required_weight=2.00
  from osi_private.osi_v2_wire_quorum((select version_id from wire_normal))),
  'two independent analysts and weight 3.00 satisfy both normal gates');
select ok((select count(*)=2 and bool_and(decision_channel='standard')
  from public.event_receipts where event_type='WIRE_REPORT_REVIEW_CAST'
    and target_id=(select version_id::text from wire_normal)),
  'Wire review history is append-only and standard-channel attributed');

create temporary table normal_publication on commit drop as
select * from public.osi_v2_prepare_wire_publication(
  repeat('j',32),'21111111111111111111111111111111',
  (select version_id from wire_normal),
  'wire-normal-publication-0001',repeat('6',64),null
);
select is((select decision_channel from normal_publication),'standard',
  'server selects the normal analyst publication channel without a maintainer gate');
select lives_ok($test$
  select * from public.osi_v2_commit_wire_publication(
    repeat('j',32),repeat('J',88),
    (select proof_text from normal_publication),statement_timestamp(),null
  )
$test$,'a counted quorum analyst finalizes the normal publication Memo');
select ok((select idempotent_replay and consumed_receipt_id is not null
  from public.osi_v2_prepare_wire_review(
    repeat('v',32),'21111111111111111111111111111111',
    (select version_id from wire_normal),'approve','evidence_reviewed',
    'The exact evidence was independently reviewed against the recorded limitations.',
    'WIRE_PRIVATE_NOTE_SENTINEL','wire-normal-review-a-0001',repeat('d',64)
  )), 'review prepare returns the original consumed binding after publication');
select ok((select idempotent_replay and consumed_receipt_id is not null
  from public.osi_v2_prepare_wire_publication(
    repeat('w',32),'21111111111111111111111111111111',
    (select version_id from wire_normal),
    'wire-normal-publication-0001',repeat('e',64),null
  )), 'publication prepare returns the original consumed binding after publication');
select ok((select idempotent_replay and lifecycle_state='published'
  from public.osi_v2_commit_wire_publication(
    repeat('j',32),repeat('J',88),
    (select proof_text from normal_publication),
    (select occurred_at from public.event_receipts where nonce=repeat('j',32)),null
  )), 'publication commit returns the exact original result on replay');
select ok((select decision_channel='standard' and actor_role='analyst'
  and event_type='WIRE_REPORT_PUBLISHED' and proof_type='solana_memo'
  from public.event_receipts where nonce=repeat('j',32)),
  'normal publication receipt is analyst-attributed and Memo-anchored');
select ok((select version.lifecycle_state='published'
  and version.published_at is not null
  and report.current_published_version_id=version.id
  from public.wire_report_versions as version
  join public.wire_reports as report on report.id=version.wire_report_id
  where version.id=(select version_id from wire_normal)),
  'normal publication advances the exact pointer and lifecycle atomically');
select ok((select count(*)=1
  and bool_and(evidence.is_public and evidence.moderation_state='approved')
  from public.wire_report_version_evidence as link
  join public.evidence_items as evidence on evidence.id=link.evidence_item_id
  where link.wire_report_version_id=(select version_id from wire_normal)),
  'publication makes only the exact reviewed evidence set public and approved');
select ok((select jsonb_array_length(public.osi_v2_get_public_wire_report(
  (select version_public_ref from wire_normal)
)->'evidence')=1 and not jsonb_path_exists(
  public.osi_v2_get_public_wire_report((select version_public_ref from wire_normal)),
  '$.evidence[*].evidence_item_id'
)), 'public detail returns approved evidence without its internal UUID');
select throws_ok($test$
  do $block$
  begin
    update public.evidence_items as evidence
       set moderation_state='blocked',is_public=false
      from public.wire_report_version_evidence as link
     where link.wire_report_version_id=(select version_id from wire_normal)
       and link.evidence_item_id=evidence.id;
    perform 1 from public.osi_v2_prepare_wire_governance_action(
      repeat('y',32),'challenge_submit','81111111111111111111111111111111',
      (select version_public_ref from wire_normal),
      jsonb_build_object(
        'reason_code','blocked_evidence_cannot_challenge',
        'public_safe_summary','A blocked evidence row cannot become a public challenge target.',
        'restricted_detail',null,
        'evidence_ordinal',(select link.ordinal
          from public.wire_report_version_evidence as link
          where link.wire_report_version_id=(select version_id from wire_normal) limit 1),
        'evidence_sha256',(select evidence.sha256
          from public.wire_report_version_evidence as link
          join public.evidence_items as evidence on evidence.id=link.evidence_item_id
          where link.wire_report_version_id=(select version_id from wire_normal) limit 1)
      ),'wire-challenge-blocked-evidence-0001',repeat('c',64),null
    );
  end
  $block$
$test$,'42501','Challenge requires one exact current published Wire version and linked evidence',
  'blocked or private evidence cannot become a public Wire challenge target');

select ok((select jsonb_path_exists(
  public.osi_v2_list_public_wire_reports(40,null),
  '$[*] ? (@.version_public_ref == $ref)',
  jsonb_build_object('ref',(select version_public_ref from wire_normal))
)), 'public Wire list contains the exact governed version');
select ok((select public.osi_v2_get_public_wire_report(
  (select version_public_ref from wire_normal)
)->>'analysis' like 'The detailed Wire analysis%'),
  'exact published detail exposes the reviewed analysis through its allowlist');
select ok((select position('WIRE_PRIVATE_NOTE_SENTINEL' in
  public.osi_v2_get_public_wire_report(
    (select version_public_ref from wire_normal)
  )::text)=0),
  'public Wire detail excludes restricted analyst notes');
select ok((select not (
  public.osi_v2_get_public_wire_report(
    (select version_public_ref from wire_normal)
  ) ?| array['nonce','signature','payload_hash','wire_report_id','wire_report_version_id']
)), 'public Wire detail excludes root-level internal proof and UUID binding fields');

insert into public.analyst_profiles (
  wallet,display_name,status,tier_code,verified,approved,weight_cached
) values (
  '61111111111111111111111111111111','WIRE_PRIVATE_PROFILE_SENTINEL',
  'contributor','none',false,false,0
);
select is((select public.osi_v2_get_public_wire_report(
  (select version_public_ref from wire_normal)
)#>>'{author,display_name}'),null::text,
  'public Wire attribution does not expose a non-public analyst profile');

insert into public.event_receipts (
  event_version,event_type,target_type,target_id,public_ref,actor_role,
  decision,proof_type,payload_hash,server_verified,occurred_at
)
select 'OSI2','CHALLENGE_EXPIRED','wire_version',version_id::text,
  version_public_ref,'service','expire','system_event',repeat('e',64),true,
  statement_timestamp()
from wire_normal;
select ok((select position('CHALLENGE_EXPIRED' in
  public.osi_v2_get_public_wire_report(
    (select version_public_ref from wire_normal)
  )::text)=0),
  'public Wire Proof Log rejects a verified event with the wrong target shape');

select throws_ok($test$
  select * from public.osi_v2_prepare_wire_support(
    repeat('k',32),'61111111111111111111111111111111',
    (select version_public_ref from wire_normal),100000000,
    'wire-support-self-denied-0001',repeat('7',64)
  )
$test$,'42501','Wire support target, payer or amount is not eligible',
  'Wire author cannot support themselves');
create temporary table wire_support_intent on commit drop as
select * from public.osi_v2_prepare_wire_support(
  repeat('l',32),'91111111111111111111111111111111',
  (select version_public_ref from wire_normal),100000000,
  'wire-support-derived-0002',repeat('8',64)
);
select ok((select jsonb_array_length(recipient_manifest)=1
  and recipient_manifest->0->>'wallet'='61111111111111111111111111111111'
  and recipient_manifest->0->>'target_ref'=(select version_public_ref from wire_normal)
  from wire_support_intent),
  'Wire support recipient is the server-derived current published author');
select lives_ok($test$
  select * from public.osi_v2_record_wire_support_submission(
    repeat('l',32),repeat('L',88)
  )
$test$,'Wire support submission binds the exact transaction before finality');
select lives_ok($test$
  select * from public.osi_v2_commit_payment(
    repeat('l',32),repeat('L',88),123456,statement_timestamp(),
    'finalized','{}'::jsonb
  )
$test$,'Wire support records only after trusted finalized-mainnet verification input');
select ok((select state='confirmed' and finality='finalized'
  and target_wallet='61111111111111111111111111111111'
  and wire_report_version_id=(select version_id from wire_normal)
  from public.support_events where intent_nonce=repeat('l',32)),
  'confirmed Wire support remains bound to one exact version and recipient');
select ok((select approve_count=2 and approve_weight=3.00 and approve_ready
  from osi_private.osi_v2_wire_quorum((select version_id from wire_normal))),
  'support has zero effect on Wire review count weight or governance');
select is((select public.osi_v2_get_public_wire_report(
  (select version_public_ref from wire_normal)
)->'support'->0->>'label'),
  'SOL transfer verified on Solana',
  'public support uses the complete finalized-transfer proof label');

create temporary table wire_support_pending on commit drop as
select * from public.osi_v2_prepare_wire_support(
  repeat('x',32),'81111111111111111111111111111111',
  (select version_public_ref from wire_normal),1,
  'wire-support-finalization-gate-0003',repeat('b',64)
);
select lives_ok($test$
  select * from public.osi_v2_record_wire_support_submission(
    repeat('x',32),repeat('X',88)
  )
$test$,'a second Wire support intent reaches submitted state while both flags are on');
update public.osi_config set value='false'
 where key='OSI_V2_WIRE_WRITES_ENABLED';
select throws_ok($test$
  select * from public.osi_v2_commit_payment(
    repeat('x',32),repeat('X',88),123457,statement_timestamp(),
    'finalized','{}'::jsonb
  )
$test$,'55000','Wire and payment writes must both be enabled',
  'the shared payment commit cannot finalize prepared Wire support after the Wire flag closes');
select ok((select state='submitted' and event_receipt_id is null
  from public.support_events where intent_nonce=repeat('x',32)),
  'failed closed finalization leaves the immutable support intent unconfirmed');
update public.osi_config set value='true'
 where key='OSI_V2_WIRE_WRITES_ENABLED';

update public.osi_config set value='false'
 where key='OSI_V2_PAYMENT_WRITES_ENABLED';
select throws_ok($test$
  select * from public.osi_v2_prepare_wire_support(
    repeat('o',32),'81111111111111111111111111111111',
    (select version_public_ref from wire_normal),1,
    'wire-support-payment-flag-off-0003',repeat('9',64)
  )
$test$,'55000','Wire and payment writes must both be enabled',
  'Wire support fails closed when the payment flag is off');
update public.osi_config set value='true'
 where key='OSI_V2_PAYMENT_WRITES_ENABLED';
update public.osi_config set value='false'
 where key='OSI_V2_WIRE_WRITES_ENABLED';
select throws_ok($test$
  select * from public.osi_v2_prepare_wire_support(
    repeat('p',32),'81111111111111111111111111111111',
    (select version_public_ref from wire_normal),1,
    'wire-support-wire-flag-off-0004',repeat('a',64)
  )
$test$,'55000','Wire and payment writes must both be enabled',
  'Wire support fails closed when the Wire flag is off');
update public.osi_config set value='true'
 where key='OSI_V2_WIRE_WRITES_ENABLED';

create function pg_temp.commit_wire_action(
  p_nonce text,p_action text,p_wallet text,p_target text,p_payload jsonb,
  p_idempotency text,p_auth text default null
) returns table(challenge_ref text,case_ref text,state text)
language plpgsql as $$
declare prepared record; committed record;
begin
  select * into prepared from public.osi_v2_prepare_wire_governance_action(
    p_nonce,p_action,p_wallet,p_target,p_payload,p_idempotency,
    encode(extensions.digest(convert_to(p_nonce,'UTF8'),'sha256'),'hex'),p_auth
  );
  if prepared.proof_type='solana_memo' then
    select * into committed from public.osi_v2_commit_wire_governance_action(
      p_nonce,p_payload,null,repeat('T',88),prepared.proof_text,
      statement_timestamp(),p_auth
    );
  else
    select * into committed from public.osi_v2_commit_wire_governance_action(
      p_nonce,p_payload,repeat('S',88),null,prepared.proof_text,null,p_auth
    );
  end if;
  return query select committed.challenge_public_ref,
    committed.case_public_ref,committed.state;
end
$$;

create temporary table wire_challenge on commit drop as
select * from pg_temp.commit_wire_action(
  repeat('q',32),'challenge_submit','81111111111111111111111111111111',
  (select version_public_ref from wire_normal),
  jsonb_build_object(
    'reason_code','material_context_missing',
    'public_safe_summary','The exact published version omits material linked transaction context.',
    'restricted_detail','Restricted corroborating context for eligible reviewers.',
    'evidence_ordinal',(select link.ordinal
      from public.wire_report_version_evidence as link
      where link.wire_report_version_id=(select version_id from wire_normal) limit 1),
    'evidence_sha256',(select evidence.sha256
      from public.wire_report_version_evidence as link
      join public.evidence_items as evidence on evidence.id=link.evidence_item_id
      where link.wire_report_version_id=(select version_id from wire_normal) limit 1)
  ),'wire-challenge-submit-0001',null
);
select ok((select challenge_ref ~ '^OSI-CHL-[0-9A-F]{16}$'
  from wire_challenge), 'community challenge receives an exact typed public reference');
select ok((select target_kind='wire_report_version'
  and wire_report_version_id=(select version_id from wire_normal)
  and state='submitted' from public.challenges_v2
  where public_ref=(select challenge_ref from wire_challenge)),
  'challenge target is the exact current published Wire version');
select lives_ok($test$
  select * from pg_temp.commit_wire_action(
    repeat('r',32),'challenge_admit','41111111111111111111111111111111',
    (select challenge_ref from wire_challenge),jsonb_build_object('decision','accept'),
    'wire-challenge-admit-0002',null
  )
$test$,'eligible analyst admits the exact Wire challenge');

select lives_ok($test$
  select * from pg_temp.commit_wire_action(
    repeat('s',32),'challenge_review','21111111111111111111111111111111',
    (select challenge_ref from wire_challenge),jsonb_build_object(
      'decision','accept','reason_code','material_issue_confirmed',
      'public_rationale','The linked evidence confirms material omitted context.',
      'private_note',null
    ),'wire-challenge-review-a-0003',null
  )
$test$,'first independent analyst reviews the Wire challenge');
select lives_ok($test$
  select * from pg_temp.commit_wire_action(
    repeat('t',32),'challenge_review','31111111111111111111111111111111',
    (select challenge_ref from wire_challenge),jsonb_build_object(
      'decision','accept','reason_code','material_issue_confirmed',
      'public_rationale','A second review confirms material omitted context.',
      'private_note',null
    ),'wire-challenge-review-b-0004',null
  )
$test$,'second independent analyst reviews the Wire challenge');
select lives_ok($test$
  select * from pg_temp.commit_wire_action(
    repeat('u',32),'challenge_review','41111111111111111111111111111111',
    (select challenge_ref from wire_challenge),jsonb_build_object(
      'decision','accept','reason_code','material_issue_confirmed',
      'public_rationale','A third review confirms the exact challenge outcome.',
      'private_note',null
    ),'wire-challenge-review-c-0005',null
  )
$test$,'third independent analyst satisfies the exact challenge quorum');
select lives_ok($test$
  select * from pg_temp.commit_wire_action(
    repeat('v',32),'challenge_finalize','21111111111111111111111111111111',
    (select challenge_ref from wire_challenge),'{}'::jsonb,
    'wire-challenge-finalize-0006',null
  )
$test$,'counted analyst finalizes the pure-analyst Wire challenge outcome');
select ok((select challenge.state='accepted' and version.contested_at is not null
  and report.current_published_version_id=version.id
  from public.challenges_v2 as challenge
  join public.wire_report_versions as version
    on version.id=challenge.wire_report_version_id
  join public.wire_reports as report on report.id=version.wire_report_id
  where challenge.public_ref=(select challenge_ref from wire_challenge)),
  'accepted challenge adds a marker while preserving version and publication pointer');
select ok((select decision_channel='standard' and actor_role='analyst'
  from public.event_receipts where event_type='CHALLENGE_ACCEPTED'
    and target_id=(select id::text from public.challenges_v2
      where public_ref=(select challenge_ref from wire_challenge))),
  'accepted Wire challenge is standard-channel and analyst-attributed');
select is((select count(*)::integer from public.event_receipts
  where target_type='challenge' and decision_channel='maintainer_bootstrap'),0,
  'maintainer-bootstrap channel is unreachable for every Wire challenge event');
select is((select public.osi_v2_get_public_wire_report(
  (select version_public_ref from wire_normal)
)->>'challenge_state'),'challenge_upheld_under_re_review',
  'public detail reports the upheld challenge without rewriting history');

create temporary table wire_promotion on commit drop as
select * from pg_temp.commit_wire_action(
  repeat('w',32),'wire_promote','21111111111111111111111111111111',
  (select version_public_ref from wire_bootstrap),'{}'::jsonb,
  'wire-promotion-0001',null
);
select ok((select case_ref ~ '^OSI-[0-9A-F]{12}$' from wire_promotion),
  'eligible analyst promotion creates a new server-derived Case reference');
select ok((select stage='initial_review' and visibility='private'
  and reward_intent_lamports is null
  and submitted_by_wallet='21111111111111111111111111111111'
  from public.cases where public_ref=(select case_ref from wire_promotion)),
  'promoted Case enters normal private initial review with no reward');
select ok((select subject_refs @> jsonb_build_array(jsonb_build_object(
  'kind','wire_report_version','ref',(select version_public_ref from wire_bootstrap)
)) from public.cases where public_ref=(select case_ref from wire_promotion)),
  'promoted Case keeps the exact Wire version as its source reference');
select ok((select count(*)=1 from public.case_evidence_links
  where case_id=(select id from public.cases
    where public_ref=(select case_ref from wire_promotion))),
  'promotion links the exact Wire evidence without copying or rewriting it');
select ok((select report.promoted_to_case_id=case_item.id
  and report.current_published_version_id=fixture.version_id
  and version.lifecycle_state='published'
  from public.wire_reports as report
  cross join wire_bootstrap as fixture
  join public.wire_report_versions as version on version.id=fixture.version_id
  join public.cases as case_item on case_item.id=report.promoted_to_case_id
  where report.id=fixture.wire_report_id),
  'promotion preserves the original published Wire Report and adds one cross-reference');
select is((select public.osi_v2_get_public_wire_report(
  (select version_public_ref from wire_bootstrap)
)->>'promoted_case_public_ref'),null,
  'public Wire detail never leaks the private promoted Case reference');
select is((select stage from public.cases
  where public_ref=(select case_ref from wire_promotion)),'initial_review',
  'promotion cannot bypass the normal Case opening rules');

select * from finish();
rollback;
