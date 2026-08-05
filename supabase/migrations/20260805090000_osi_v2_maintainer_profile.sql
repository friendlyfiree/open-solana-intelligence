-- Maintainer profile.
--
-- The person who operates OSI is not an analyst. They hold no review weight,
-- cast no governance vote, and are counted in no quorum. They were also
-- invisible, because the only public identity the product had was an analyst
-- profile, and the roster only publishes the three analyst tiers.
--
-- Closing that gap by giving the maintainer an analyst row would have been the
-- cheap way and the wrong one. `osi_private.osi_v2_bootstrap_tier()` counts
-- every approved analyst profile with no exception for the operator, so the
-- maintainer would have been inflating the very number that decides when their
-- own cold-start privilege retires. A separate record cannot do that, and says
-- what it is instead of implying something untrue.
--
-- Additive and independently gated, like every slice before it. Nothing here
-- touches analyst_profiles, quorum, weight, or the bootstrap ladder.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create table if not exists public.maintainer_profile (
  -- Exactly one row, enforced by the key itself rather than by convention.
  singleton boolean primary key default true
    constraint maintainer_profile_singleton_check check (singleton),
  wallet text not null
    constraint maintainer_profile_wallet_check
    check (
      char_length(wallet) between 32 and 44
      and wallet ~ '^[1-9A-HJ-NP-Za-km-z]+$'
    ),
  display_name text
    constraint maintainer_profile_display_name_check
    check (display_name is null or char_length(display_name) <= 80),
  bio text
    constraint maintainer_profile_bio_check
    check (bio is null or char_length(bio) <= 1000),
  -- https only. A javascript: or data: URL rendered into an anchor or an image
  -- is the ordinary way a profile field becomes an execution surface.
  avatar_url text
    constraint maintainer_profile_avatar_url_check
    check (avatar_url is null or avatar_url ~ '^https://[^[:space:]<>"'']+$'),
  proof_of_work_url text
    constraint maintainer_profile_proof_url_check
    check (proof_of_work_url is null or proof_of_work_url ~ '^https://[^[:space:]<>"'']+$'),
  expertise_public jsonb not null default '[]'::jsonb
    constraint maintainer_profile_expertise_shape_check
    check (jsonb_typeof(expertise_public) = 'array' and jsonb_array_length(expertise_public) <= 8),
  links_public jsonb not null default '[]'::jsonb
    constraint maintainer_profile_links_shape_check
    check (jsonb_typeof(links_public) = 'array' and jsonb_array_length(links_public) <= 6),
  updated_at timestamptz not null default now(),
  updated_by_auth uuid
);

comment on table public.maintainer_profile is
  'Public identity of the deployment operator. Carries no analyst standing, no review weight, and no governance authority. Never read by any quorum, weight or bootstrap computation.';

-- Default deny, exactly as every client-reachable V2 table. The browser reads
-- this through the allowlisted projection in osi-v2-analyst and never directly.
alter table public.maintainer_profile enable row level security;
alter table public.maintainer_profile force row level security;
revoke all privileges on table public.maintainer_profile from public, anon, authenticated;
grant select, insert, update on table public.maintainer_profile to service_role;

-- Writing is a service-role RPC behind the Edge function's maintainer double
-- gate, matching every other privileged write in this schema. The function
-- refuses any wallet that is not the configured admin wallet at write time, so
-- a rotated admin wallet cannot keep editing through a stale caller.
--
-- `security invoker`, like every other function in this schema: the caller's
-- own privileges decide every hop, so a widening mistake anywhere in the chain
-- shows up as a refusal rather than being papered over by a definer's rights.
-- That property is asserted for the whole schema in
-- supabase/tests/osi_v2_service_role_execute_grants.sql.
create or replace function osi_private.osi_v2_save_maintainer_profile(
  p_wallet text,
  p_display_name text,
  p_bio text,
  p_avatar_url text,
  p_proof_of_work_url text,
  p_expertise jsonb,
  p_links jsonb,
  p_auth_uuid text
)
returns table (
  wallet text,
  display_name text,
  bio text,
  avatar_url text,
  proof_of_work_url text,
  expertise_public jsonb,
  links_public jsonb,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  saved public.maintainer_profile%rowtype;
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Maintainer profile writes are service-only' using errcode = '42501';
  end if;

  -- One definition of "the maintainer", shared with every other maintainer-only
  -- path: the configured admin wallet plus a real authenticated identity. A
  -- rotated admin wallet therefore revokes editing here without a code change.
  --
  -- `is distinct from true`, the same form every other maintainer gate uses,
  -- and for the same reason: the binding returns NULL rather than false when
  -- p_auth_uuid is null, and `if not null then` does not fire. Written the
  -- obvious way, a caller with no authenticated identity would be let through.
  if osi_private.osi_v2_full_maintainer_binding(p_wallet, p_auth_uuid) is distinct from true then
    raise exception 'Maintainer profile may only be written by the configured admin wallet'
      using errcode = '42501';
  end if;

  insert into public.maintainer_profile as target (
    singleton, wallet, display_name, bio, avatar_url, proof_of_work_url,
    expertise_public, links_public, updated_at, updated_by_auth
  )
  values (
    true, p_wallet, p_display_name, p_bio, p_avatar_url, p_proof_of_work_url,
    coalesce(p_expertise, '[]'::jsonb), coalesce(p_links, '[]'::jsonb),
    now(), p_auth_uuid::uuid
  )
  on conflict (singleton) do update set
    wallet = excluded.wallet,
    display_name = excluded.display_name,
    bio = excluded.bio,
    avatar_url = excluded.avatar_url,
    proof_of_work_url = excluded.proof_of_work_url,
    expertise_public = excluded.expertise_public,
    links_public = excluded.links_public,
    updated_at = now(),
    updated_by_auth = excluded.updated_by_auth
  returning target.* into saved;

  return query
    select saved.wallet, saved.display_name, saved.bio, saved.avatar_url,
           saved.proof_of_work_url, saved.expertise_public, saved.links_public,
           saved.updated_at;
end;
$$;

-- The PostgREST-reachable surface. osi_private is not an exposed schema, so
-- without this thin wrapper the Edge function's rpc() call would resolve to
-- nothing. Same shape as every other V2 write: public wrapper, private logic,
-- both revoked from the browser-facing roles.
create or replace function public.osi_v2_save_maintainer_profile(
  p_wallet text,
  p_display_name text,
  p_bio text,
  p_avatar_url text,
  p_proof_of_work_url text,
  p_expertise jsonb,
  p_links jsonb,
  p_auth_uuid text
)
returns table (
  wallet text,
  display_name text,
  bio text,
  avatar_url text,
  proof_of_work_url text,
  expertise_public jsonb,
  links_public jsonb,
  updated_at timestamptz
)
language sql
security invoker
set search_path = ''
as $$
  select * from osi_private.osi_v2_save_maintainer_profile(
    p_wallet, p_display_name, p_bio, p_avatar_url, p_proof_of_work_url,
    p_expertise, p_links, p_auth_uuid
  )
$$;

revoke all privileges on function osi_private.osi_v2_save_maintainer_profile(
  text, text, text, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
revoke all privileges on function public.osi_v2_save_maintainer_profile(
  text, text, text, text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function osi_private.osi_v2_save_maintainer_profile(
  text, text, text, text, text, jsonb, jsonb, text
) to service_role;
grant execute on function public.osi_v2_save_maintainer_profile(
  text, text, text, text, text, jsonb, jsonb, text
) to service_role;

commit;
