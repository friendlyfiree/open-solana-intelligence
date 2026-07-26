-- Align the final database boundary with the owner-approved contributor
-- intake contract. This changes required-field shape only; Edge safety
-- screening, proof binding, replay protection and lifecycle rules are
-- unchanged.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.wire_report_versions
  drop constraint wire_report_versions_title_check,
  add constraint wire_report_versions_title_check
    check (
      title_public_safe is null
      or (
        title_public_safe = btrim(title_public_safe)
        and char_length(title_public_safe) between 3 and 160
      )
    ),
  drop constraint wire_report_versions_uncertainties_check,
  add constraint wire_report_versions_uncertainties_check
    check (
      uncertainties_private is null
      or (
        uncertainties_private = btrim(uncertainties_private)
        and char_length(uncertainties_private) between 0 and 4000
      )
    );

create or replace function osi_private.osi_v2_validate_wire_content(
  p_title_public_safe text,
  p_content_public_safe text,
  p_body_private text,
  p_uncertainties_private text,
  p_revision_reason_code text,
  p_is_revision boolean
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_title_public_safe is null
     or p_title_public_safe is distinct from btrim(p_title_public_safe)
     or char_length(p_title_public_safe) not between 3 and 160 then
    raise exception 'Wire title must contain between 3 and 160 trimmed characters'
      using errcode = '23514';
  end if;
  if p_content_public_safe is null
     or p_content_public_safe is distinct from btrim(p_content_public_safe)
     or char_length(p_content_public_safe) not between 10 and 4000 then
    raise exception 'Wire summary must contain between 10 and 4000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_body_private is null
     or p_body_private is distinct from btrim(p_body_private)
     or char_length(p_body_private) not between 20 and 100000 then
    raise exception 'Wire analysis must contain between 20 and 100000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_uncertainties_private is not null
     and (
       p_uncertainties_private is distinct from btrim(p_uncertainties_private)
       or char_length(p_uncertainties_private) > 4000
     ) then
    raise exception 'Wire uncertainties must be empty or contain at most 4000 trimmed characters'
      using errcode = '23514';
  end if;
  if p_is_revision then
    if p_revision_reason_code not in (
      'author_correction', 'new_evidence', 'clarification', 'review_response'
    ) then
      raise exception 'A Wire revision requires an allowed reason code'
        using errcode = '23514';
    end if;
  elsif p_revision_reason_code is not null then
    raise exception 'Initial Wire version cannot claim a revision reason'
      using errcode = '23514';
  end if;
  return true;
end
$$;

create or replace function osi_private.osi_v2_valid_profile_expertise(value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(value) = 'array'
    and jsonb_array_length(value) between 0 and 6
    and not exists (
      select 1
      from jsonb_array_elements_text(value) as item(value)
      where item.value not in (
        'blockchain_forensics', 'scam_analysis', 'exploit_research',
        'data_analysis', 'osint', 'protocol_research'
      )
    )
    and jsonb_array_length(value) = (
      select count(distinct item.value)
      from jsonb_array_elements_text(value) as item(value)
    )
$$;

revoke all privileges on function osi_private.osi_v2_validate_wire_content(
  text, text, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function osi_private.osi_v2_validate_wire_content(
  text, text, text, text, text, boolean
) to service_role;

revoke all privileges on function osi_private.osi_v2_valid_profile_expertise(jsonb)
  from public, anon, authenticated;
grant execute on function osi_private.osi_v2_valid_profile_expertise(jsonb)
  to service_role;

comment on column public.wire_report_versions.uncertainties_private is
  'Optional limitations and uncertainty statement; private until a separately authorized publication.';
comment on function osi_private.osi_v2_validate_wire_content(
  text, text, text, text, text, boolean
) is
  'Enforces the owner-approved required Wire fields and bounded optional uncertainties at the final database boundary.';
comment on function osi_private.osi_v2_valid_profile_expertise(jsonb) is
  'Accepts zero to six unique allowlisted public expertise values; expertise is optional for analyst intake.';

commit;
