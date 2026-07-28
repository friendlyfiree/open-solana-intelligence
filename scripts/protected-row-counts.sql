begin read only;
select relation_name || '|' || row_count
from (
  select 'event_receipts' relation_name, count(*)::bigint row_count from public.event_receipts
  union all select 'cases', count(*) from public.cases
  union all select 'case_reports', count(*) from public.case_reports
  union all select 'case_report_versions', count(*) from public.case_report_versions
  union all select 'wire_reports', count(*) from public.wire_reports
  union all select 'wire_report_versions', count(*) from public.wire_report_versions
  union all select 'evidence_items', count(*) from public.evidence_items
  union all select 'case_evidence_links', count(*) from public.case_evidence_links
  union all select 'case_report_version_evidence', count(*) from public.case_report_version_evidence
  union all select 'wire_report_version_evidence', count(*) from public.wire_report_version_evidence
  union all select 'analyst_applications', count(*) from public.analyst_applications
  union all select 'analyst_application_versions', count(*) from public.analyst_application_versions
  union all select 'analyst_profiles', count(*) from public.analyst_profiles
  union all select 'analyst_contributions', count(*) from public.analyst_contributions
  union all select 'analyst_reputation_snapshots', count(*) from public.analyst_reputation_snapshots
  union all select 'ai_packs', count(*) from public.ai_packs
  union all select 'ai_pack_versions', count(*) from public.ai_pack_versions
  union all select 'ai_pack_version_evidence', count(*) from public.ai_pack_version_evidence
  union all select 'ai_pack_owner_feedback', count(*) from public.ai_pack_owner_feedback
  union all select 'case_resolutions', count(*) from public.case_resolutions
  union all select 'challenges_v2', count(*) from public.challenges_v2
  union all select 'reward_pledges', count(*) from public.reward_pledges
  union all select 'reward_payments', count(*) from public.reward_payments
  union all select 'support_events', count(*) from public.support_events
  union all select 'case_initial_reviews', count(*) from public.case_initial_reviews
  union all select 'case_report_reviews', count(*) from public.case_report_reviews
  union all select 'wire_report_reviews', count(*) from public.wire_report_reviews
  union all select 'resolution_reviews', count(*) from public.resolution_reviews
  union all select 'challenge_reviews', count(*) from public.challenge_reviews
  union all select 'ai_pack_reviews', count(*) from public.ai_pack_reviews
  union all select 'analyst_application_reviews', count(*) from public.analyst_application_reviews
  union all select 'osi_nonces', count(*) from public.osi_nonces
  union all select 'migration_crosswalk', count(*) from public.migration_crosswalk
  union all select 'migration_manual_queue', count(*) from public.migration_manual_queue
  union all select 'osi_v2_ai_pack_generation_runs', count(*) from public.osi_v2_ai_pack_generation_runs
  union all select 'osi_v2_sas_wallet_credentials', count(*) from public.osi_v2_sas_wallet_credentials
  union all select 'osi_v2_sas_review_verifications', count(*) from public.osi_v2_sas_review_verifications
  union all select 'osi_v2_sas_verify_events', count(*) from public.osi_v2_sas_verify_events
) counts
order by relation_name;
commit;
