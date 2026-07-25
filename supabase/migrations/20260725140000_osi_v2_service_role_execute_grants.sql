-- OSI V2 — restore the service_role execute grants the invoker chain needs.
--
-- Every function in osi_private is `security invoker`: there is not one
-- `security definer` among the 138. That is deliberate — nothing runs with the
-- owner's authority — but it means the caller's own privileges are what count
-- at every hop, not just the first one. A public wrapper is likewise invoker,
-- so `service_role` calling public.osi_v2_issue_analyst_nonce() executes
-- osi_private.osi_v2_issue_analyst_nonce() as service_role, which in turn
-- executes osi_private.osi_v2_analyst_ref() as service_role, and so on.
--
-- The slice migrations revoke each private function from public, anon and
-- authenticated, then grant the *public* wrapper to service_role. Several of
-- them stopped there. Revoking from `public` removes the default PUBLIC
-- execute grant, so with no explicit grant to service_role the very next hop
-- raises insufficient_privilege (42501), which the Edge Functions surface as
-- `not_authorized`.
--
-- The analyst slice shows the whole shape of it: 20260713184533 granted
-- osi_private.osi_v2_analyst_writes_enabled() to service_role and none of the
-- four functions the flow actually runs, so analyst application submission,
-- maintainer review and probation activation were all unreachable in
-- production — and with them SAS credential issuance, which only ever fires
-- from osi_v2_commit_analyst_probation(). The same omission reaches the
-- governance, resolution, challenge, seal, wire and payment helpers.
--
-- This grants execute to service_role on every osi_private function that was
-- still missing it. It adds no function, changes no body, and widens nothing
-- beyond service_role: public, anon and authenticated keep the revokes the
-- slice migrations applied, and the private schema itself stays unreachable
-- from PostgREST. Two of the grants (the profile validators) matter for a
-- reason worth naming: they are called from CHECK constraints on
-- analyst_application_versions, and a CHECK is evaluated with the privileges
-- of whoever runs the DML, so service_role needs them to insert at all.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Analyst activation slice (20260713184533): the four functions the flow runs,
-- the two ref helpers they call, and the two validators its CHECK constraints
-- evaluate.
grant execute on function osi_private.osi_v2_issue_analyst_nonce(
  text, text, text, text, text, text, text, text
) to service_role;
grant execute on function osi_private.osi_v2_commit_analyst_application(
  text, text, text, text, text, text, jsonb, jsonb, jsonb, text, text, text
) to service_role;
grant execute on function osi_private.osi_v2_commit_application_review(
  text, text, text, text, text
) to service_role;
grant execute on function osi_private.osi_v2_commit_analyst_probation(
  text, text, text, text, timestamptz
) to service_role;
grant execute on function osi_private.osi_v2_analyst_ref(text) to service_role;
grant execute on function osi_private.osi_v2_application_ref(uuid) to service_role;
grant execute on function osi_private.osi_v2_valid_profile_expertise(jsonb) to service_role;
grant execute on function osi_private.osi_v2_valid_profile_links(jsonb) to service_role;

-- Governance, resolution, challenge and seal helpers reached from the
-- already-granted prepare/commit governance functions.
grant execute on function osi_private.osi_v2_governance_writes_enabled() to service_role;
grant execute on function osi_private.osi_v2_governance_payload_hash(
  text, text, text, text, text, jsonb, jsonb
) to service_role;
grant execute on function osi_private.osi_v2_ensure_resolution(uuid) to service_role;
grant execute on function osi_private.osi_v2_resolution_quorum(uuid) to service_role;
grant execute on function osi_private.osi_v2_challenge_quorum(uuid) to service_role;
grant execute on function osi_private.osi_v2_seal_quorum(uuid) to service_role;
grant execute on function osi_private.osi_v2_check_challenge_rate(
  text, text, timestamptz
) to service_role;
grant execute on function osi_private.osi_v2_eligible_analyst(text) to service_role;
grant execute on function osi_private.osi_v2_full_maintainer_binding(text, text) to service_role;
grant execute on function osi_private.osi_v2_bootstrap_tier() to service_role;
grant execute on function osi_private.osi_v2_bootstrap_selection_support(
  uuid, uuid, text
) to service_role;
grant execute on function osi_private.osi_v2_config_integer(text, integer, integer) to service_role;
grant execute on function osi_private.osi_v2_make_public_ref(text, uuid) to service_role;

-- Native SOL payment slice helpers reached from the granted prepare/commit
-- payment, pledge and Wire support functions.
grant execute on function osi_private.osi_v2_payment_writes_enabled() to service_role;
grant execute on function osi_private.osi_v2_payment_config_integer(
  text, integer, integer
) to service_role;
grant execute on function osi_private.osi_v2_payment_hash(jsonb) to service_role;
grant execute on function osi_private.osi_v2_payment_rate_limit(
  text, text, timestamptz
) to service_role;

-- The private schema stays closed to every browser-facing role. These revokes
-- are already in place; restating them keeps this migration's intent explicit
-- and makes it self-contained if read on its own.
revoke all privileges on schema osi_private from anon, authenticated;

commit;
