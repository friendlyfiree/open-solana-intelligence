begin;

create extension if not exists pgtap with schema extensions;
select plan(9);

select lives_ok(
  $test$
    select osi_private.osi_v2_validate_wire_content(
      'abc', repeat('s', 10), repeat('a', 20), '', null, false
    )
  $test$,
  'database accepts the exact minimal required Wire fields with empty optional uncertainties'
);

select lives_ok(
  $test$
    select osi_private.osi_v2_validate_wire_content(
      'abc', repeat('s', 10), repeat('a', 20), null, null, false
    )
  $test$,
  'database accepts null optional Wire uncertainties'
);

select throws_ok(
  $test$
    select osi_private.osi_v2_validate_wire_content(
      'ab', repeat('s', 10), repeat('a', 20), '', null, false
    )
  $test$,
  '23514',
  'Wire title must contain between 3 and 160 trimmed characters',
  'database still rejects a Wire title below the approved minimum'
);

select throws_ok(
  $test$
    select osi_private.osi_v2_validate_wire_content(
      'abc', repeat('s', 9), repeat('a', 20), '', null, false
    )
  $test$,
  '23514',
  'Wire summary must contain between 10 and 4000 trimmed characters',
  'database still rejects a Wire summary below the approved minimum'
);

select throws_ok(
  $test$
    select osi_private.osi_v2_validate_wire_content(
      'abc', repeat('s', 10), repeat('a', 19), '', null, false
    )
  $test$,
  '23514',
  'Wire analysis must contain between 20 and 100000 trimmed characters',
  'database still rejects Wire analysis below the approved minimum'
);

select throws_ok(
  $test$
    select osi_private.osi_v2_validate_wire_content(
      'abc', repeat('s', 10), repeat('a', 20), repeat('u', 4001), null, false
    )
  $test$,
  '23514',
  'Wire uncertainties must be empty or contain at most 4000 trimmed characters',
  'optional Wire uncertainties remain bounded'
);

select ok(
  osi_private.osi_v2_valid_profile_expertise('[]'::jsonb),
  'database accepts an empty optional analyst expertise list'
);

select ok(
  not osi_private.osi_v2_valid_profile_expertise('["invented_specialty"]'::jsonb),
  'database still rejects expertise outside the allowlist'
);

select ok(
  (
    select pg_get_constraintdef(oid) like '%char_length(title_public_safe) >= 3%'
      or pg_get_constraintdef(oid) like '%char_length(title_public_safe) BETWEEN 3 AND 160%'
    from pg_constraint
    where conrelid = 'public.wire_report_versions'::regclass
      and conname = 'wire_report_versions_title_check'
  )
  and (
    select pg_get_constraintdef(oid) like '%char_length(uncertainties_private) >= 0%'
      or pg_get_constraintdef(oid) like '%char_length(uncertainties_private) BETWEEN 0 AND 4000%'
    from pg_constraint
    where conrelid = 'public.wire_report_versions'::regclass
      and conname = 'wire_report_versions_uncertainties_check'
  ),
  'persisted Wire constraints match the relaxed function boundary'
);

select * from finish();
rollback;
