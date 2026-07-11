# OSI V2 — Migration & Rollout Plan

**Status:** Blueprint / design-only. **No SQL is created or executed here. No production data is touched.** This is an *additive* strategy: new tables and compatibility views alongside the current schema, never destructive renames.

---

## 1. Current tables & semantics (baseline)

| Table | Current semantics | Notes |
|---|---|---|
| `reports` | report OR "public case record"; `approved`, `review_status`(`approved`/`rejected`/`disputed`/`challenged`), `sealed`; text `id` (client `rep_…`) | `bounty` is a **free-text** parent label, not an FK |
| `bounties` | Field Office "case" + optional reward; `approved`, `review_status`(`approved_public`), `winner_wallet` | text `id` (`bnt_…`) |
| `challenges` | disputes; `item_type`/`item_id`, `status`(`open`) | |
| `vouches` | analyst votes; written **only** by Edge Fn | `approve`/`reject` |
| `escalation_packs` | AI packs; `case_ref` = **a report id**; `status`(`review_required`/`approved`) | `attested` read but never written |
| `onchain_events` | Proof Log; anon-writable; `status` hardcoded `confirmed` | client-labeled |
| `analysts` | `wallet`, `verified`, `approved` | maintainer-set |
| `osi_config` | governance config | reuse |
| `bounty_boosts`, `request_votes`, `requests`, `profiles` | ancillary/legacy | evaluate for retirement |

## 2. Target tables
Per `OSI_V2_DOMAIN_MODEL.md`: `cases, case_reports, wire_reports, case_evidence, case_initial_reviews, reviews, challenges(v2), challenge_reviews, case_resolutions, analyst_profiles, analyst_contributions, analyst_reputation_snapshots, ai_packs, ai_pack_versions, ai_pack_reviews, reward_pledges, reward_payments, support_events, event_receipts, osi_config`.

## 3. Legacy → new mapping

| Current | V2 destination | Ambiguity? |
|---|---|---|
| `bounties` row (has `detail`, investigation ask) | **`cases`** (question-first) + optional `reward_pledges` (if `reward_sol>0`) | ⚠ some bounties are pure reward with thin detail → flag for owner/maintainer categorization |
| `bounties.winner_wallet` | `case_resolutions.winning_report_id` + `reward_pledges.winning_report_id` | ⚠ current winner is a **wallet**, not a Report; V2 winner is a **Report** — no report may exist to point at (see §12) |
| `reports` where filed under a bounty (`bounty` text set) | **`case_reports`** attached to the migrated Case (match by `bounty` text → bounty→case) | ⚠ `bounty` is free text; matching is heuristic, not guaranteed |
| `reports` with no bounty (Wire dispatch, `submitIntel`) | **`wire_reports`** | wire dispatches set `bounty:''` |
| approved standalone `report` that is really an investigation | **`cases`** (with the report as its first `case_report`) OR `wire_report` | ⚠ **ambiguous** — needs a rule/owner decision |
| `escalation_packs` (`case_ref`=report id) | `ai_packs` (per **Case**) + `ai_pack_versions` v1; link the report's Case | ⚠ requires the report→Case mapping first |
| `vouches` | `reviews` (as historical decisions; `is_active` on latest per analyst) | clean |
| `challenges` (v1) | `challenges` (v2) with `target_type`/`target_id` remapped to new ids | id remap needed |
| `onchain_events` | `event_receipts` (historical import; `server_verified=false`, keep `event_version` of original) | keep legacy memo strings verbatim |
| `analysts` | `analyst_profiles` (status derived: verified+approved→`verified_analyst`) | contributions backfilled as best-effort, low confidence |

## 4. Backfill strategy
1. **Freeze-free, read-only extract** of current tables (no mutation).
2. Build a **bounty→case** map and a **report→(case_report | wire_report | case)** classification, using: `bounty` text linkage, presence of `detail`, `approved`/`sealed` state. Un-classifiable rows go to a **manual review queue**, never auto-guessed.
3. Generate new-id ↔ old-id crosswalk table (kept for dual-read).
4. Backfill `event_receipts` from `onchain_events` verbatim (preserve original memo/version; mark `server_verified=false`).
5. Reputation: seed `analyst_profiles` from `analysts`; seed `analyst_contributions` conservatively (only clearly-attributable accepted/winning items) → probationary/verified per current flags; **do not inflate weight** from ambiguous history.

## 5. Dual-read / compatibility phase
- Create **read-only compatibility views** (e.g. `reports_compat`, `bounties_compat`) that project V2 tables back into the old column shapes so the *current* frontend keeps working unchanged during transition.
- New V2 frontend reads V2 tables directly. Both run against the same DB.

## 6. Dual-write risks
Dual-write (writing both old and new on every action) is **high-risk** (consistency, partial failures, double memos). **Recommended: avoid dual-write.** Instead: cutover writes to V2 behind a feature flag; old frontend served the compat views (read-only) during the window; no simultaneous authoritative writers.

## 7. Feature flags
- `OSI_V2_SCHEMA_READY`, `OSI_V2_WRITES_ENABLED`, `OSI_V2_UI` (per-surface), `OSI_V2_FALLBACK_GOVERNANCE` (default off). Flags let each surface flip independently and roll back instantly.

## 8. Staged frontend rollout
1. Read-only V2 surfaces (Public Records, Case Detail read) over V2 tables while writes still go to v1 via compat.
2. Enable V2 **submission** (cases/reports/wire) behind `OSI_V2_WRITES_ENABLED`; v1 submission disabled.
3. Enable V2 review/quorum, then AI Pack UI (finally reachable), then rewards.
4. Retire v1 surfaces.

## 9. Edge Function rollout
- Ship `osi-v2-*` functions (case intake, review, resolution, ai-pack v2) **alongside** current `osi-analyst-intake`/`osi-ai-pack`. Do not change deployed v1 behavior. Cut client calls over per flag. Retire v1 functions only after cutover + soak.

## 10. Data validation
- Crosswalk completeness (every migrated row maps or is queued).
- No orphan `case_reports` (all have `case_id`).
- No pending row publicly readable (RLS test).
- Reputation sanity (no weight > 3.00; probationary = 0.50).
- Proof Log parity (every legacy `onchain_events` row present as a receipt).

## 11. Rollback
- Additive design → rollback = flip flags back to v1 + compat views; V2 tables remain but unused. No destructive change to roll back.
- Per-surface flags allow partial rollback.

## 12. Cutover & the winner-wallet problem
Explicit risks to resolve **before** cutover:
- **`bounties.winner_wallet` → winning Report:** current winners are wallets with possibly **no Report row**. Rule needed: create a synthetic `case_report` stub attributed to the winner, or mark the Case resolved-legacy without a V2 winning Report. → Open Decision.
- **`reports.bounty` free text:** cannot reliably FK reports to cases. Unmatched reports → manual queue. → Open Decision.
- **Standalone approved reports:** case vs wire classification rule. → Open Decision.
- **`escalation_packs.case_ref`=report id:** depends on report→Case mapping; packs whose report can't be mapped stay legacy-only. → Open Decision.
- **Historical memos:** never rewritten; the V2 Proof Log parser must accept OSI1 + legacy `OSI_*` + OSI2 permanently.

## 13. Legacy retirement
Only after: V2 writes stable, compat views unused by any live client, validation green, and a soak period. Retire in order: v1 submission → v1 review → v1 AI pack → compat views → v1 Edge Functions. Keep `onchain_events`/legacy memos **as historical record** indefinitely.

## 14. Security preservation during migration
- Pending privacy preserved (RLS default-deny on V2 tables; owner-proof reads).
- Maintainer double-gate + auth-UUID RLS carried to V2.
- No service-role/model key in client at any stage.
- No fake rows created during backfill; ambiguous data is queued, never invented.
