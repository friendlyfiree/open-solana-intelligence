# OSI V2 — Current → V2 Mapping Appendix

**Status:** Blueprint / design-only. Maps every current function/table/UI element to its proposed V2 destination. **Ambiguities are flagged, never silently invented.** Line references are approximate (current `origin/main` `1491377`).

---

## 1. Tables

| Current table | V2 destination | Confidence | Note |
|---|---|---|---|
| `bounties` | `cases` (+ optional `reward_pledges`) | high | investigation-first; reward becomes an attached pledge |
| `reports` (filed under a bounty) | `case_reports` (FK `case_id`) | medium | matched via free-text `bounty` → **⚠ heuristic** |
| `reports` (Wire dispatch, `submitIntel`, `bounty:''`) | `wire_reports` | high | report-first |
| `reports` (standalone approved, investigation-like) | `cases` **or** `wire_reports` | low | **⚠ D1 decision** |
| `vouches` | `reviews` (`target_type`, historical `is_active`) | high | clean shape match |
| `challenges` | `challenges` v2 (remapped ids) | high | id crosswalk needed |
| `escalation_packs` (`case_ref`=report id) | `ai_packs` (per Case) + `ai_pack_versions` | medium | **⚠ depends on report→Case map** |
| `onchain_events` | `event_receipts` (verbatim import) | high | keep legacy memo + version |
| `analysts` | `analyst_profiles` | high | status from `verified`/`approved` |
| `analysts` history | `analyst_contributions` | low | **⚠ conservative backfill only** |
| `osi_config` | `osi_config` | high | reuse |
| `bounty_boosts` | (retire, D9/D12) | — | **⚠ decision** |
| `request_votes`, `requests` | (evaluate, D12) | — | **⚠ decision** |
| `profiles` | fold into `analyst_profiles` | medium | **⚠ decision** |

## 2. Fields

| Current field | V2 destination | Note |
|---|---|---|
| `reports.bounty` (free text) | `case_reports.case_id` (FK) | **⚠ free text → FK is heuristic** (D1) |
| `reports.wallet` | `case_reports.author_wallet` **only if proven submitter** | current field is submitter-declared/unverified; V2 sets from verified signature, and `subject_refs` holds *reported* wallets separately |
| `reports.approved`/`review_status` | `case_reports.status` + `reviews` | vocabulary unified |
| `reports.sealed` | `cases.sealed_at` (seal is a **Case** concept in V2) | seal moves from report to case |
| `bounties.winner_wallet` | `case_resolutions.winning_report_id` | **⚠ wallet→Report, may lack a Report (D2)** |
| `bounties.reward_sol` | `reward_pledges.amount_lamports` | unit change SOL→lamports |
| `escalation_packs.case_ref` (=report id) | `ai_packs.case_id` (real Case) | **⚠ needs report→Case map** |
| `escalation_packs.status` (`review_required`/`approved`; `attested` dead) | `ai_pack_versions.state` | `attested` dead value dropped |
| `onchain_events.actor_wallet` (client-set, anon) | `event_receipts.actor_wallet` (server-set from sig) | integrity upgrade |
| `onchain_events.status` (hardcoded `confirmed`) | `event_receipts.server_verified` (default false) + `tx_sig` | honest labeling |

## 3. UI / functions

| Current UI / function (file) | V2 destination |
|---|---|
| Field Office "Open a Case" → `submitBounty` (`74-community-cases.js`) | Case submission (`cases`) + optional reward pledge |
| Bounty "Apply" → `submitBountyReport` (`74-community-cases.js`) | Submit `case_report` to a Case |
| The Wire "dispatch" → `submitIntel` (`40-wire-field.js`) | Submit `wire_report` |
| `vouch` (`20-safety-consensus.js`) + `osiReviewAction` (`22-analyst-intake.js`) | `reviews` via V2 review Edge Fn |
| `chxOpen`/`chxSubmit` (`20-safety-consensus.js`) | V2 challenge flow |
| `escGenerate`/`escLoadCases` (`80-ai-pack.js`) — **currently unreachable (no `esc-case` DOM)** | reachable AI Pack tab in Case Detail + Ops Center |
| `escApprovePack`/`escSealCase` (`80-ai-pack.js`) | Pack approval (`ai_pack_reviews`) / Case seal (`case_resolutions`) |
| `renderCaseRecords` (`84-public-records.js`, reads `reports?approved`) | Public Records over `cases` + published `wire_reports` |
| `renderFieldOffice` (bounties) | Field Office over `cases` |
| Maintainer Ops Center disabled placeholder buttons (`54-maintainer-console.js`) | Real signed maintainer actions |
| `osiSignEvent`/`osiBuildMemo` (`10-signed-events.js`) → OSI1 | OSI2 grammar (`OSI_V2_MEMO_EVENT_SPEC.md`) |
| Support flow `openTip`/`osiTipSend` (`70-support-transfer.js`) | `support_events` (author/analyst) + `reward_payments` (winner) — **split into two** |

## 4. Highest-risk / ambiguous mappings (do not implement without decisions)
1. **`reports.bounty` free text → `case_id` FK** (D1) — no reliable linkage; needs rule + manual queue.
2. **`bounties.winner_wallet` → winning Report** (D2) — winner may have no Report row.
3. **Standalone approved report → Case vs Wire** (D1).
4. **`escalation_packs.case_ref`=report id → Case** — cascades from #1/#3.
5. **`onchain_events` anon-writable, client-labeled** → V2 server receipts — historical rows import verbatim but must be labeled unverified.
6. **Support flow currently one path** → must split into reward (winner) vs voluntary support (author/analyst) with distinct events.
7. **Analyst contribution history** — thin/ambiguous; conservative backfill only, no weight inflation.

## 5. Preserved security invariants (carried unchanged into V2)
Pending privacy · maintainer wallet+auth double-gate + auth-UUID RLS · server-side analyst verification · no self-verification · no direct anon `vouches`/review insert (Edge Fn only) · AI Pack restricted content authorized-only · public metadata minimization · no service-role/model key in client · no escrow/custody · no fake data · no automatic AI decisions · no guilt/legal-certainty claims · no private-evidence leakage. Each has a named server enforcement point in `OSI_V2_ROLE_PERMISSION_MATRIX.md`.
