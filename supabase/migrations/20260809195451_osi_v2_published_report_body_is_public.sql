begin;
set local lock_timeout = '5s';

-- Publishing a Report makes the reviewed analysis readable.
--
-- Until now publication promoted the evidence manifest to public-safe and left
-- the analysis behind: the public read a short summary while the work that
-- justified it stayed restricted. The first Report to clear an analyst quorum
-- made the cost obvious. Its author wrote 10,651 characters of traced, sourced,
-- carefully hedged on-chain analysis for readers, and the public projection
-- carried 607 of them. A platform whose purpose is public, reviewable evidence
-- cannot publish the conclusion and withhold the reasoning.
--
-- `body_private` is named for the state it holds before publication, when a
-- version is under review and restricted to its author, eligible analysts and
-- the maintainer. Publication is the act that ends that state, and it already
-- ends it for evidence: osi_v2_commit_report_publication promotes every pending
-- evidence item on the published version in the same transaction. This column
-- lets the body follow the same rule.
--
-- It defaults to true because a Report is written to be read, and because the
-- analysts who approve a version read the full body before approving it, so a
-- published body carries nothing the quorum did not review. An author who needs
-- a version's analysis to stay restricted after publication can hold this false
-- for that version; the column is per-version and immutable content is never
-- rewritten by it, only exposed.
--
-- Additive only: one nullable-free boolean with a default. No data is moved, no
-- policy is widened, and nothing outside a published version is affected,
-- because every read path gates on lifecycle_state = 'published' as well.

alter table public.case_report_versions
  add column if not exists body_is_public boolean not null default true;

comment on column public.case_report_versions.body_is_public is
  'When true, the full body of this version becomes public once the version is published. Publication remains the gate: an unpublished version is never public regardless of this flag.';

commit;
