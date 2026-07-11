# OSI V2 — Current → V2 Mapping Appendix

**Status:** Blueprint / design-only. Maps every current function/table/UI element to its proposed V2 destination among the **authoritative 32 tables** (`OSI_V2_DOMAIN_MODEL.md §1`). **Ambiguities are flagged, never silently invented.** Line references are approximate (current `origin/main` `1491377`).

---

## 1. Tables

| Current table | V2 destination | Confidence | Note |
|---|---|---|---|
| `bounties` | `cases` (+ optional `reward_pledges.case_id`) | high | investigation-first; reward becomes an attached pledge |
| `reports` (filed under a bounty) | `case_reports` (header) + `case_report_versions` v1 (FK `case_id`/`report_id`) | medium | matched via free-text `bounty` → **⚠ heuristic**; unmatched → manual queue |
| `reports` (Wire dispatch, `submitIntel`, `bounty:''`) | `wire_reports` (header) + `wire_report_versions` v1 | high | report-first |
| `reports` (standalone approved, investigation-like) | `cases` **or** `wire_reports` | low | **⚠ D1 decision → manual queue** |
| `vouches` | typed review tables (`case_report_reviews` / `wire_report_reviews`), historical `is_active` | high | imported as historical decisions; **receipts `server_verified=false`** |
| `challenges` | `challenges` v2 (physical **`challenges_v2`** to avoid the v1 name collision; untyped `item_type`/`item_id` → **one typed target FK** + `evidence_items` FK; admissibility states) | high | id crosswalk + target-type resolution |
| `escalation_packs` (`case_ref`=report id) | `ai_packs` (per Case) + `ai_pack_versions` | medium | **⚠ depends on report→Case map** |
| `onchain_events` | `event_receipts` (verbatim import; `proof_type='legacy_imported'`, `server_verified=false`) | high | keep legacy memo + version |
| `analysts` | `analyst_profiles` | high | status from `verified`/`approved` |
| `analysts` history | `analyst_contributions` | low | **⚠ conservative backfill only; no inflation** |
| `osi_config` | `osi_config` | high | reuse (one of the 32) |
| `bounty_boosts` | (retire, D9/D12) | — | **⚠ decision** |
| `request_votes`, `requests` | (evaluate, D12) | — | **⚠ decision** |
| `profiles` | fold into `analyst_profiles` | medium | **⚠ decision** |

New V2 tables with **no v1 predecessor** (created additively, not mapped from legacy): `case_report_versions`, `wire_report_versions`, `evidence_items`, `case_evidence_links`, `case_report_version_evidence`, `wire_report_version_evidence`, `ai_pack_version_evidence`, `case_initial_reviews`, `resolution_reviews`, `challenge_reviews`, `ai_pack_reviews`, `analyst_application_reviews`, `case_resolutions`, `analyst_applications`, `analyst_application_versions`, `analyst_reputation_snapshots`, `ai_pack_owner_feedback`, `reward_pledges`, `reward_payments`, `support_events`. (Legacy `vouches` seeds only the two report-review tables; other typed reviews start empty.)

**Infrastructure tables (NOT among the 32 domain tables, no v1 predecessor):** `osi_nonces` (Stage-5 replay/idempotency), `migration_crosswalk`, `migration_manual_queue` — private, service-only (`OSI_V2_DOMAIN_MODEL.md §9`, `OSI_V2_MIGRATION_ROLLOUT_PLAN.md §2.2`).

## 2. Fields

| Current field | V2 destination | Note |
|---|---|---|
| `reports.bounty` (free text) | `case_reports.case_id` (FK, via header) | **⚠ free text → FK is heuristic** (D1); unmatched → manual queue |
| `reports.wallet` | `case_report_versions.created_by_wallet` **only if proven submitter** | current field is submitter-declared/unverified; V2 sets from verified signature, and `cases.subject_refs` holds *reported* wallets separately |
| `reports` body | `case_report_versions.body_private` / `content_public_safe` | body moves to the immutable **version** row |
| `reports.approved`/`review_status` | `case_report_versions.status` + `case_report_reviews` | vocabulary unified; reviews target the exact version |
| `reports.sealed` | `cases.sealed_at` (seal is a **Case** concept in V2) | seal moves from report to case |
| `bounties.winner_wallet` | `case_resolutions.winning_report_version_id` when a Report exists; else `case_resolutions.state='resolved_legacy'` | **⚠ wallet→version may lack a Report → `resolved_legacy`, no synthetic Report (D2)** |
| `bounties.reward_sol` | `reward_pledges.amount_lamports` | unit change SOL→lamports |
| `escalation_packs.case_ref` (=report id) | `ai_packs.case_id` (real Case) | **⚠ needs report→Case map** |
| `escalation_packs.status` (`review_required`/`approved`; `attested` dead) | `ai_pack_versions.lifecycle_state` | expanded lifecycle; `attested` dead value dropped; staleness is a separate axis (`is_stale`) |
| `onchain_events.actor_wallet` (client-set, anon) | `event_receipts.actor_wallet` (server-set from sig) | integrity upgrade |
| `onchain_events.status` (hardcoded `confirmed`) | `event_receipts.server_verified` (imports `false`) + `proof_type` + `tx_sig` | honest labeling; four proof types |

## 3. UI / functions

| Current UI / function (file) | V2 destination |
|---|---|
| Field Office "Open a Case" → `submitBounty` (`74-community-cases.js`) | Case submission (`cases`) + optional `reward_pledges` |
| Bounty "Apply" → `submitBountyReport` (`74-community-cases.js`) | Submit `case_reports` + `case_report_versions` v1 to a Case |
| The Wire "dispatch" → `submitIntel` (`40-wire-field.js`) | Submit `wire_reports` + `wire_report_versions` v1 |
| `vouch` (`20-safety-consensus.js`) + `osiReviewAction` (`22-analyst-intake.js`) | Typed review Edge Fns writing `case_report_reviews` / `wire_report_reviews` / `case_initial_reviews` |
| `chxOpen`/`chxSubmit` (`20-safety-consensus.js`) | V2 challenge flow (`challenges` + admissibility + `challenge_reviews`) |
| `escGenerate`/`escLoadCases` (`80-ai-pack.js`) — **currently unreachable (no `esc-case` DOM)** | reachable AI Pack tab in Case Detail + Ops Center (`ai_packs` + `ai_pack_versions`) |
| `escApprovePack`/`escSealCase` (`80-ai-pack.js`) | Pack approval (`ai_pack_reviews`) / Case seal (`case_resolutions`) |
| `renderCaseRecords` (`84-public-records.js`, reads `reports?approved`) | Public Records over `cases` + published `wire_report_versions` |
| `renderFieldOffice` (bounties) | Field Office over `cases` |
| Maintainer Ops Center disabled placeholder buttons (`54-maintainer-console.js`) | Real signed maintainer actions (every button → modeled transition) |
| `osiSignEvent`/`osiBuildMemo` (`10-signed-events.js`) → OSI1 | OSI2 grammar + hybrid transport (`OSI_V2_MEMO_EVENT_SPEC.md`) |
| Analyst apply flow | `analyst_applications` + `analyst_application_reviews` |
| Support flow `openTip`/`osiTipSend` (`70-support-transfer.js`) | `support_events` (author/analyst) + `reward_payments` (winner) — **split into two** |

## 4. Highest-risk / ambiguous mappings (do not implement without decisions)
1. **`reports.bounty` free text → `case_id` FK** (D1) — no reliable linkage; needs rule + manual queue.
2. **`bounties.winner_wallet` → winning version** (D2) — winner may have no Report; resolved via `resolved_legacy`, **no synthetic Report**.
3. **Standalone approved report → Case vs Wire** (D1) — manual queue.
4. **`escalation_packs.case_ref`=report id → Case** — cascades from #1/#3.
5. **`onchain_events` anon-writable, client-labeled** → V2 server receipts — historical rows import verbatim, labeled `legacy_imported` / `server_verified=false`.
6. **Support flow currently one path** → must split into reward (winner) vs voluntary support (author/analyst) with distinct events and tables.
7. **Analyst contribution history** — thin/ambiguous; conservative backfill only, **no weight inflation**.

## 5. Preserved security invariants (carried unchanged into V2)
Pending privacy · maintainer wallet+auth double-gate + auth-UUID RLS · server-side analyst verification · no self-verification · no direct anon review insert (Edge Fn / service role only) · server-only `event_receipts` insertion · Stage-5 receipt authenticity before writes (D14) · AI Pack restricted content authorized-only · public metadata minimization · no service-role/model key in client · no escrow/custody · no fake data (ambiguous → manual queue) · no automatic AI decisions · no guilt/legal-certainty claims · no private-evidence leakage. Each has a named server enforcement point in `OSI_V2_ROLE_PERMISSION_MATRIX.md`.
