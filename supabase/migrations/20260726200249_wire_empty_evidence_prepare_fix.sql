-- Complete the owner-approved Wire intake contract at the database boundary.
-- Structured Wire evidence is optional, while every supplied reference keeps
-- the existing Report evidence validation for kind, hash, uniqueness, Solana
-- identifiers, and HTTPS-only URLs.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create or replace function osi_private.osi_v2_wire_evidence_manifest(
  p_evidence jsonb
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_evidence is null
     or jsonb_typeof(p_evidence) <> 'array'
     or jsonb_array_length(p_evidence) > 12 then
    raise exception 'Wire evidence must contain between 0 and 12 references'
      using errcode = '23514';
  end if;

  if jsonb_array_length(p_evidence) = 0 then
    return '[]'::jsonb;
  end if;

  return osi_private.osi_v2_report_evidence_manifest(p_evidence);
end
$$;

revoke all privileges on function osi_private.osi_v2_wire_evidence_manifest(jsonb)
  from public, anon, authenticated;
grant execute on function osi_private.osi_v2_wire_evidence_manifest(jsonb)
  to service_role;

comment on function osi_private.osi_v2_wire_evidence_manifest(jsonb) is
  'Builds an ordered manifest for zero to twelve Wire references; non-empty manifests retain the existing strict Report evidence validation.';

commit;
