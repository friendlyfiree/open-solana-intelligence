-- Behavioral authorization coverage for the production-shaped V1 relations.
-- A migration-only database does not carry the legacy physical tables, so this
-- transaction creates their exact minimal shape, installs the formerly shipped
-- vulnerable policies, then invokes the same hardening function production
-- uses. Everything rolls back.

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create table if not exists public.requests (
  id text primary key,
  name text not null,
  created_at timestamptz default now(),
  approved boolean default false
);
create table if not exists public.onchain_events (
  id bigint primary key,
  event_type text not null,
  actor_wallet text,
  item_type text,
  item_id text,
  vote text,
  amount numeric,
  token text,
  label text,
  memo_text text,
  tx_sig text not null,
  status text default 'confirmed',
  created_at timestamptz default now()
);
alter table public.requests enable row level security;
alter table public.onchain_events enable row level security;
grant select,insert,update,delete on public.requests,public.onchain_events
  to anon,authenticated;

drop policy if exists "read requests" on public.requests;
drop policy if exists "admin delete" on public.requests;
drop policy if exists "admin read" on public.requests;
drop policy if exists "admin update" on public.requests;
drop policy if exists "requests admin delete" on public.requests;
drop policy if exists "requests admin read" on public.requests;
drop policy if exists "requests admin update" on public.requests;
drop policy if exists "requests_insert" on public.requests;
drop policy if exists "requests_read" on public.requests;
drop policy if exists "requests approved public read" on public.requests;
create policy "read requests" on public.requests for select to public using (true);
create policy "requests admin delete" on public.requests for delete to public
  using (auth.role()='authenticated');
create policy "requests admin read" on public.requests for select to public
  using (auth.role()='authenticated');
create policy "requests admin update" on public.requests for update to public
  using (auth.role()='authenticated');
create policy "requests_insert" on public.requests for insert to anon,authenticated
  with check (approved=false);
create policy "requests_read" on public.requests for select to anon,authenticated
  using (approved=true);

drop policy if exists "onchain_events insert" on public.onchain_events;
drop policy if exists "onchain_events read" on public.onchain_events;
create policy "onchain_events insert" on public.onchain_events for insert to public
  with check (tx_sig is not null and length(tx_sig)>25);
create policy "onchain_events read" on public.onchain_events for select to public
  using (true);

select osi_private.osi_v2_apply_legacy_boundary();

insert into public.requests(id,name,approved) values
  ('OSI-RLS-TEST-PENDING-20260728','pending request must stay private',false),
  ('OSI-RLS-TEST-APPROVED-20260728','approved historical request',true)
on conflict (id) do update set
  name=excluded.name,approved=excluded.approved;
insert into public.onchain_events(id,event_type,tx_sig)
values (9223372036854770000,'LEGACY_TEST',repeat('A',88))
on conflict (id) do update set
  event_type=excluded.event_type,tx_sig=excluded.tx_sig;

set local role anon;
select is(
  (select count(*)::integer from public.requests
    where id in ('OSI-RLS-TEST-PENDING-20260728','OSI-RLS-TEST-APPROVED-20260728')),
  1,'anonymous reads only the approved legacy request fixture');
select is(
  (select count(*)::integer from public.requests
    where id='OSI-RLS-TEST-PENDING-20260728'),
  0,'anonymous cannot read a pending legacy request');
select throws_ok(
  $$insert into public.requests(id,name,approved)
    values ('OSI-RLS-ANON-INSERT','blocked',false)$$,
  '42501','permission denied for table requests',
  'anonymous request spam insert is denied by effective privilege');
select throws_ok(
  $$update public.requests set name='tampered'
    where id='OSI-RLS-TEST-APPROVED-20260728'$$,
  '42501','permission denied for table requests',
  'anonymous cannot update a legacy request');
select throws_ok(
  $$delete from public.requests
    where id='OSI-RLS-TEST-APPROVED-20260728'$$,
  '42501','permission denied for table requests',
  'anonymous cannot delete a legacy request');
select is(
  (select count(*)::integer from public.onchain_events
    where id=9223372036854770000),
  1,'anonymous retains historical on-chain event reads');
select throws_ok(
  $$insert into public.onchain_events(id,event_type,tx_sig)
    values (9223372036854770001,'FAKE',repeat('B',88))$$,
  '42501','permission denied for table onchain_events',
  'anonymous cannot forge a legacy on-chain event');

reset role;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select is(auth.uid(),'10000000-0000-4000-8000-000000000001'::uuid,
  'first authenticated identity is active for the authorization attempt');
select throws_ok(
  $$update public.requests set name='first identity tamper'
    where id='OSI-RLS-TEST-APPROVED-20260728'$$,
  '42501','permission denied for table requests',
  'first authenticated identity cannot update another request');
select throws_ok(
  $$delete from public.requests
    where id='OSI-RLS-TEST-APPROVED-20260728'$$,
  '42501','permission denied for table requests',
  'first authenticated identity cannot delete another request');

reset role;
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',true);
set local role authenticated;
select is(auth.uid(),'20000000-0000-4000-8000-000000000002'::uuid,
  'a different authenticated identity is active for the second attempt');
select throws_ok(
  $$insert into public.requests(id,name,approved)
    values ('OSI-RLS-AUTH-INSERT','blocked',false)$$,
  '42501','permission denied for table requests',
  'a different authenticated identity cannot use the former spam insert');
select throws_ok(
  $$insert into public.onchain_events(id,event_type,tx_sig)
    values (9223372036854770002,'FAKE',repeat('C',88))$$,
  '42501','permission denied for table onchain_events',
  'authenticated callers cannot forge legacy on-chain events');

reset role;
select is(
  (select count(*)::integer from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname in ('osi storage upload','osi storage read')),
  0,'osi-uploads has neither anonymous upload nor listing policy');
select ok(
  not exists (
    select 1 from pg_policies
     where schemaname='public' and tablename='requests'
       and cmd in ('INSERT','UPDATE','DELETE','ALL')
       and (
         coalesce(qual,'') ~ $$auth[.]role[(][)] *= *'authenticated'$$
         or coalesce(with_check,'') ~ $$auth[.]role[(][)] *= *'authenticated'$$
         or coalesce(with_check,'') ~ 'approved *= *false'
       )
  ),'semantic authenticated-wide and approved-false request policies are gone');
select is(
  (select count(*)::integer from pg_policies
    where schemaname='public' and tablename='requests' and cmd='SELECT'
      and roles @> array['anon'::name,'authenticated'::name]
      and qual='(approved IS TRUE)'),
  1,'the sole browser request policy is the approved-only projection boundary');

select * from finish();
rollback;
