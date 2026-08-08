begin;
set local lock_timeout = '5s';

-- Wire follows the same split as Case Reports: publication exposes the
-- public-safe summary and approved public evidence, never the restricted
-- analysis body or uncertainty notes. Keep the richer private helper scoped
-- to service-role callers, and make the client-facing RPC fail closed with an
-- explicit top-level allowlist at the SQL boundary. The null branch preserves
-- the existing not-found contract instead of manufacturing an object of nulls.
create or replace function public.osi_v2_get_public_wire_report(
  p_version_ref text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with source as (
    select osi_private.osi_v2_get_public_wire_report(p_version_ref) as report
  )
  select case when source.report is null then null else jsonb_build_object(
    'author', source.report->'author',
    'challenge_state', source.report->'challenge_state',
    'challenges', source.report->'challenges',
    'contested_at', source.report->'contested_at',
    'evidence', source.report->'evidence',
    'is_current_published', source.report->'is_current_published',
    'promoted', source.report->'promoted',
    'promoted_case_public_ref', source.report->'promoted_case_public_ref',
    'proof_log', source.report->'proof_log',
    'publication', source.report->'publication',
    'published_at', source.report->'published_at',
    'reviews', source.report->'reviews',
    'summary', source.report->'summary',
    'support', source.report->'support',
    'title', source.report->'title',
    'version_no', source.report->'version_no',
    'version_public_ref', source.report->'version_public_ref',
    'wire_report_public_ref', source.report->'wire_report_public_ref'
  ) end
  from source
$$;

revoke all privileges on function public.osi_v2_get_public_wire_report(text)
  from public, anon, authenticated;
grant execute on function public.osi_v2_get_public_wire_report(text)
  to service_role;

comment on function public.osi_v2_get_public_wire_report(text) is
  'Published Wire public-safe projection. Restricted analysis, uncertainty notes, private reviews, signatures, nonces, payload hashes and internal identifiers are excluded.';

commit;
