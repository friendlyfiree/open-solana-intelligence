-- Cold-start calibration of the standard publication weight gate (D21).
--
-- The two-gate rule is a count gate and a weight gate. The count gate is the
-- constitutional guarantee: P3 requires at least two independent analyst
-- wallets, and every quorum function refuses a configured count below 2, so
-- that floor is not reachable from configuration at all. This migration does
-- not touch it. The weight gate is the tunable half, listed in
-- OSI_V2_OPEN_DECISIONS.md under "Implementation details requiring
-- measurement" as "Exact threshold numbers (D5) - tunable via osi_config".
--
-- Why it needs calibrating. Weight is bounded [0.50, 3.00] and every new
-- analyst starts at the 0.50 probationary floor, climbing only as validated
-- contributions accumulate. The standard weight gate of 2.00 therefore assumes
-- a roster that has already built reputation. Applied to a roster where every
-- analyst is still at the floor it needs four unanimous approvers, which means
-- the live three-analyst network could not publish a standard Case Report or
-- Wire Report even in complete agreement. That is not P3 protecting anything;
-- it is a mature-roster number applied to a cold-start roster, and the
-- practical effect was to push routine publication onto the D17 maintainer
-- bootstrap channel, which is exactly the channel that is supposed to stay
-- exceptional.
--
-- What changes. The standard weight gate moves 2.00 -> 1.00 for Case Report
-- and Wire Report publication, so two independent analysts at the probationary
-- floor satisfy both gates. Publication then travels the ordinary analyst
-- quorum path and is labelled as such. Nothing about the bootstrap channel
-- changes: it stays available, stays double-gated, and every receipt it
-- produces still carries decision_channel='maintainer_bootstrap'.
--
-- What deliberately does not change:
--   * both count gates stay at 2 (P3),
--   * high-risk publication stays at 3 analysts and weight 4.00,
--   * rejection, challenge, resolution, AI-Pack and seal thresholds are
--     untouched, so no adversarial or terminal outcome gets cheaper,
--   * the bootstrap ladder and its labelling are untouched.
--
-- Restore condition. This is a calibration for a floor-weight roster, not a
-- permanent loosening. Once the live roster carries real earned weight, the
-- standard gate should return toward the design default. D21 records the
-- restore trigger; it is deliberately a written decision rather than an
-- automatic flip, because unlike the D17 tier it depends on weight
-- distribution rather than a headcount the server can read on its own.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $$
declare
  changed integer;
begin
  -- Only the untuned design default is moved. If an operator has already set
  -- some other value this migration leaves it alone rather than clobbering a
  -- deliberate choice.
  update public.osi_config
     set value = '1.00', updated_at = statement_timestamp()
   where key in ('OSI_V2_REPORT_STANDARD_MIN_WEIGHT', 'OSI_V2_WIRE_STANDARD_MIN_WEIGHT')
     and value = '2.00';
  get diagnostics changed = row_count;
  raise notice 'Cold-start weight gate calibration updated % row(s)', changed;
end;
$$;

-- Fail the migration rather than ship a configuration the quorum functions
-- would reject at read time. Both functions require
-- minimum_weight between 1 and 20 and minimum_count between 2 and 10; a value
-- outside that range turns every publication attempt into a 55000 error.
do $$
declare
  report_weight numeric;
  wire_weight numeric;
  report_count integer;
  wire_count integer;
begin
  select value::numeric into report_weight from public.osi_config
   where key = 'OSI_V2_REPORT_STANDARD_MIN_WEIGHT';
  select value::numeric into wire_weight from public.osi_config
   where key = 'OSI_V2_WIRE_STANDARD_MIN_WEIGHT';
  select value::integer into report_count from public.osi_config
   where key = 'OSI_V2_REPORT_STANDARD_MIN_ANALYSTS';
  select value::integer into wire_count from public.osi_config
   where key = 'OSI_V2_WIRE_STANDARD_MIN_COUNT';

  if report_weight is null or report_weight not between 1 and 20
     or wire_weight is null or wire_weight not between 1 and 20 then
    raise exception 'Standard weight gate is outside the range the quorum functions accept'
      using errcode = '55000';
  end if;

  -- The constitutional floor. If this ever fails the deployment has a P3
  -- violation in its configuration and must not proceed.
  if report_count is distinct from 2 or wire_count is distinct from 2 then
    raise exception 'Standard count gate must remain at the P3 floor of 2 independent analysts'
      using errcode = '55000';
  end if;
end;
$$;

commit;
