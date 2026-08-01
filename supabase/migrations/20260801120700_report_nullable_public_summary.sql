begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A public-safe summary is optional Report content. Publication still requires
-- the exact lifecycle state, immutable publication timestamp and receipt, but
-- it must never manufacture or copy the restricted body into a public field.
do $migration$
declare
  current_definition text;
  expected_definition constant text :=
    'CHECK ((lifecycle_state = ANY (ARRAY[''published''::text, ''superseded''::text])) AND published_at IS NOT NULL AND publication_receipt_id IS NOT NULL AND content_public_safe IS NOT NULL OR (lifecycle_state <> ALL (ARRAY[''published''::text, ''superseded''::text])) AND published_at IS NULL AND publication_receipt_id IS NULL)';
begin
  select pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
    into current_definition
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as table_row
      on table_row.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as namespace_row
      on namespace_row.oid = table_row.relnamespace
   where namespace_row.nspname = 'public'
     and table_row.relname = 'case_report_versions'
     and constraint_row.conname = 'case_report_versions_publication_state_check';

  if current_definition is distinct from expected_definition then
    raise exception 'Report publication-state constraint drifted from the reviewed definition'
      using errcode = '55000';
  end if;
end
$migration$;

alter table public.case_report_versions
  drop constraint case_report_versions_publication_state_check;

alter table public.case_report_versions
  add constraint case_report_versions_publication_state_check
  check (
    (
      lifecycle_state in ('published', 'superseded')
      and published_at is not null
      and publication_receipt_id is not null
    )
    or (
      lifecycle_state not in ('published', 'superseded')
      and published_at is null
      and publication_receipt_id is null
    )
  ) not valid;

alter table public.case_report_versions
  validate constraint case_report_versions_publication_state_check;

comment on constraint case_report_versions_publication_state_check
  on public.case_report_versions is
  'Published and superseded Report versions require their immutable publication timestamp and receipt. Unpublished versions require both fields to remain null. The public-safe summary is optional and the restricted body is never a publication fallback.';

commit;
