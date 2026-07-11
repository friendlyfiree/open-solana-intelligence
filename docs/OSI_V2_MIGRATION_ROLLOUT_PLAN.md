# OSI V2 — Migration & Rollout Plan

**Status:** Blueprint / design-only. **No SQL is created or executed here. No production data, Supabase state, or deployment configuration is touched.** This is an *additive* strategy: new tables and compatibility views alongside the current schema, never destructive renames. The **authoritative V2 table count is 32** (identical in `OSI_V2_DOMAIN_MODEL.md §1`, `OSI_V2_README.md`, and the final report).

**Hard gate (locked, D14 / Stage-5):** `OSI_V2_WRITES_ENABLED` stays **false** and **no V2 write cutover happens before step 9 is verified.** Steps 1–8 are read-only or infrastructure-only. See §3.

---

## 1. Current tables & semantics (baseline)

| Table | Current semantics | Notes |
|---|---|---|
| `reports` | report OR "public case record"; `approved`, `review_status`(`approved`/`rejected`/`disputed`/`challenged`), `sealed`; text `id` (client `rep_…`) | `bounty` is a **free-text** parent label, not an FK |
| `bounties` | Field Office "case" + optional reward; `approved`, `review_status`(`approved_public`), `winner_wallet` | text `id` (`bnt_…`) |
| `challenges` | disputes; `item_type`/`item_id`, `status`(`open`) | |
| `vouches` | analyst votes; written **only** by Edge Fn | `approve`/`reject` |
| `escalation_packs` | AI packs; `case_ref` = **a report id**; `status`(`review_required`/`approved`) | `attested` read but never written |
| `onchain_events` | Proof Log; anon-writable; `status` hardcoded `confirmed` | client-labeled, **not server-verified** |
| `analysts` | `wallet`, `verified`, `approved` | maintainer-set |
| `osi_config` | governance config | reuse |
| `bounty_boosts`, `request_votes`, `requests`, `profiles` | ancillary/legacy | evaluate for retirement (D12) |

## 2. Target tables (the authoritative 32)

Per `OSI_V2_DOMAIN_MODEL.md §1`, grouped exactly as there:

- **Case & Report headers/versions (5):** `cases`, `case_reports`, `case_report_versions`, `wire_reports`, `wire_report_versions`
- **Evidence & Pack evidence manifests (5):** `evidence_items`, `case_evidence_links`, `case_report_version_evidence`, `wire_report_version_evidence`, `ai_pack_version_evidence`
- **Governance reviews — typed, real FKs (7):** `case_initial_reviews`, `case_report_reviews`, `wire_report_reviews`, `resolution_reviews`, `challenge_reviews`, `ai_pack_reviews`, `analyst_application_reviews`
- **Resolution & challenge (2):** `case_resolutions`, `challenges`
- **Analyst (5):** `analyst_applications`, `analyst_application_versions`, `analyst_profiles`, `analyst_contributions`, `analyst_reputation_snapshots`
- **AI Pack (3):** `ai_packs`, `ai_pack_versions`, `ai_pack_owner_feedback`
- **Money (3):** `reward_pledges`, `reward_payments`, `support_events`
- **Proof & config (2):** `event_receipts`, `osi_config`

`osi_config` is reused; the other 31 are additive-new. No current table is renamed or dropped during migration. The three tables added in this revision (`analyst_application_versions`, `ai_pack_owner_feedback`, `ai_pack_version_evidence`) have **no v1 predecessor** — they are created empty and populated only by native V2 writes.

---

## 3. Rollout order (13 steps — locked)

The order is fixed. **No V2 write is enabled before step 9 is verified.** Steps 1–8 create schema, policies, infrastructure, and read-only surfaces only.

| # | Step | What happens | Write-enabling? |
|---|---|---|---|
| 1 | **Final blueprint approval** | All blueprint docs agree; `OSI_V2_OPEN_DECISIONS.md` D1–D16 signed off | no |
| 2 | **Additive V2 schema** | Create the 28 additive tables + version/header structure; `osi_config` reused. No drop/rename | no (DDL only) |
| 3 | **RLS / default-deny policies** | Default-deny on every V2 table; owner-proof read paths; maintainer auth-UUID write restriction; service-role-only `event_receipts` insert | no |
| 4 | **Stage-5 nonce / replay / server-receipt infrastructure** | Server-issued single-use nonce, nonce expiry/consumption, purpose+target+payload-hash binding, freshness/idempotency, actor-role verification, server-only Proof Log receipt insertion, replay tests | no (infra only) |
| 5 | **Read-only migration / backfill validation** | Read-only extract + classification + crosswalk generation; validate against §5 rules; **no writes to authoritative V2 tables driving live behavior** | no |
| 6 | **Read-only V2 UI** | Public Records, Case Detail read, Proof Log render over V2 tables while writes still go to v1 via compat views | no |
| 7 | **V2 intake endpoints** | Deploy `osi-v2-*` case/report/wire intake Edge Functions, **kept disabled behind `OSI_V2_WRITES_ENABLED=false`** | staged, still gated |
| 8 | **V2 review endpoints** | Deploy typed-review + resolution + challenge + AI-Pack-review + application-review endpoints, also **gated** | staged, still gated |
| 9 | **Verify all native V2 receipts are `server_verified=true`** | Prove that every write path that would run under step 10 produces a server-verified receipt (nonce consumed, target/payload bound, role verified). Imported legacy stays `server_verified=false`. **This is the Stage-5 gate.** | verification only |
| 10 | **Enable `OSI_V2_WRITES_ENABLED`** | Flip the flag **only after step 9 passes**. V2 becomes the authoritative writer; v1 submission disabled | **yes — the cutover** |
| 11 | **Per-surface rollout** | Flip `OSI_V2_UI` per surface: intake → review/quorum → AI Pack UI (finally reachable) → rewards | yes, per surface |
| 12 | **Soak period** | Monitor under real load; validation stays green; instant per-surface rollback available | — |
| 13 | **Legacy retirement** | Only after soak: retire v1 submission → v1 review → v1 AI pack → compat views → v1 Edge Functions. Keep `onchain_events`/legacy memos as historical record indefinitely | — |

**Gate restated:** steps 1–9 write **no authoritative V2 governance data** into a live-serving path. Step 9 must be verified before step 10. This is the locked Stage-5 requirement (`OSI_V2_OPEN_DECISIONS.md` D14).

---

## 4. Legacy → new mapping

| Current | V2 destination | Ambiguity? |
|---|---|---|
| `bounties` row (has `detail`, investigation ask) | **`cases`** (question-first) + optional `reward_pledges` (`reward_pledges.case_id`, if `reward_sol>0`) | ⚠ some bounties are pure reward with thin detail → **manual review queue**, never auto-categorized |
| `bounties.winner_wallet` | `case_resolutions` with `state='resolved_legacy'`; historical winner wallet kept in a read-only legacy view | ⚠ current winner is a **wallet**, not a Report version; **no synthetic Report is created** (§5, D2) |
| `reports` filed under a bounty (`bounty` text set) | **`case_reports`** + a v1 `case_report_versions` row, attached to the migrated Case | ⚠ `bounty` is free text; matching is heuristic → ambiguous rows go to manual queue |
| `reports` with no bounty (Wire dispatch, `submitIntel`, `bounty:''`) | **`wire_reports`** + a v1 `wire_report_versions` row | wire dispatches set `bounty:''` |
| approved standalone `report` that is really an investigation | **`cases`** (report as first `case_report_versions`) OR `wire_reports` | ⚠ **ambiguous (D1)** → manual queue |
| `escalation_packs` (`case_ref`=report id) | `ai_packs` (per **Case**) + `ai_pack_versions` v1; requires the report→Case map first | ⚠ packs whose report can't be mapped stay legacy-only |
| `vouches` | historical decisions imported into the matching typed review table (`case_report_reviews` / `wire_report_reviews`), `is_active` on the latest per analyst per target | clean shape; **imported receipts `server_verified=false`** |
| `challenges` (v1) | `challenges` (v2) with `target_type`/`target_id` remapped to new version ids | id remap needed |
| `onchain_events` | `event_receipts` (verbatim import; `proof_type='legacy_imported'`, `server_verified=false`, original `event_version` preserved) | keep legacy memo strings verbatim |
| `analysts` | `analyst_profiles` (status derived: verified+approved→`verified_analyst`) | contributions backfilled conservatively, low confidence |

## 5. Backfill rules (locked)

1. **Read-only extract** of current tables — no mutation of live data.
2. **Build the crosswalk maps** (`bounty→case`, `report→{case_report | wire_report | case}`) using `bounty` text linkage, presence of `detail`, and `approved`/`sealed` state. **Un-classifiable rows go to a manual review queue — never auto-guessed.**
3. **Legacy events remain `server_verified=false`.** Every row imported from `onchain_events` is `proof_type='legacy_imported'`, `server_verified=false`, with its original memo string and version preserved verbatim. No import is ever relabeled as server-verified or on-chain-native.
4. **No synthetic Report for a legacy winner.** A `bounties.winner_wallet` with no corresponding Report becomes `case_resolutions.state='resolved_legacy'` (D2). **No fake/stub `case_reports` or `case_report_versions` is invented** to satisfy the winning-version FK; the legacy winner wallet is preserved only in a read-only legacy view.
5. **Ambiguous Case/Wire mappings go to manual review.** Free-text `reports.bounty`, standalone approved reports, and thin-detail bounties are queued for owner/maintainer categorization, not classified by guess.
6. **No reputation inflation.** Seed `analyst_profiles` from `analysts`; seed `analyst_contributions` only from clearly-attributable accepted/winning items. Ambiguous history contributes **nothing**; no weight is raised from uncertain data. Probationary seeds start at 0.50.
7. **Preserve legacy crosswalks.** The new-id ↔ old-id crosswalk table is retained for dual-read and audit; it is never discarded after cutover.
8. **No dual authoritative writes.** During transition there is exactly one authoritative writer per record. The old frontend is served **read-only compat views**; V2 writes go to V2 tables. There is never a window where both v1 and V2 authoritatively write the same record.
9. **No destructive migration.** No current table is dropped, renamed, or overwritten. Migration is purely additive; `onchain_events` and legacy memos are kept as historical record indefinitely.

## 6. Dual-read / compatibility phase

- Create **read-only compatibility views** (e.g. `reports_compat`, `bounties_compat`) that project V2 tables back into the old column shapes so the *current* frontend keeps working unchanged during transition.
- New V2 frontend reads V2 tables directly. Both run against the same DB; only one side ever writes a given record (§5.8).

## 7. Feature flags

- `OSI_V2_SCHEMA_READY`, `OSI_V2_WRITES_ENABLED` (**false until step 9 verified**), `OSI_V2_UI` (per-surface), `OSI_V2_FALLBACK_GOVERNANCE` (default off, D3). Flags let each surface flip independently and roll back instantly.

## 8. Edge Function rollout

- Ship `osi-v2-*` functions (case intake, typed review, resolution, challenge, ai-pack v2, application review) **alongside** current `osi-analyst-intake`/`osi-ai-pack`. Do not change deployed v1 behavior. Cut client calls over per flag (steps 7–8 deploy disabled; step 10 enables). Retire v1 functions only after cutover + soak (step 13).

## 9. Data validation (must be green before step 10)

- Crosswalk completeness — every migrated row maps or is queued.
- No orphan `case_reports`/`case_report_versions` (all have `case_id`/`report_id`).
- Every `analyst_application_reviews` row targets an immutable `analyst_application_versions.id` (never a bare header).
- Every `ai_pack_versions` row has a complete `ai_pack_version_evidence` manifest and consistent per-layer manifest hashes; `ai_pack_owner_feedback` never appears in `ai_pack_reviews`.
- Every `challenges` row has exactly one non-null typed target FK and a real `evidence_item_id`; no non-terminal challenge lacks a TTL/deadline.
- No pending row publicly readable (RLS default-deny test).
- Reputation sanity — no weight > 3.00; probationary = 0.50; no inflation from ambiguous history.
- Proof Log parity — every legacy `onchain_events` row present as a `legacy_imported`, `server_verified=false` receipt.
- **Receipt authenticity (Stage-5, step 9):** every native V2 write path produces `server_verified=true` with nonce consumed and target/payload bound; no live V2 write can create an unverified receipt.

## 10. Rollback

- Additive design → rollback = flip flags back to v1 + compat views; V2 tables remain but unused. No destructive change to roll back.
- Per-surface `OSI_V2_UI` flags allow partial rollback.

## 11. Cutover risks resolved by decision (no invention)

- **`bounties.winner_wallet` → winning version:** resolved by D2 → `resolved_legacy`, **no synthetic Report** (§5.4).
- **`reports.bounty` free text:** cannot reliably FK reports to cases → manual queue (D1).
- **Standalone approved reports:** Case vs Wire classification → manual queue (D1).
- **`escalation_packs.case_ref`=report id:** depends on the report→Case map; unmappable packs stay legacy-only.
- **Historical memos:** never rewritten; the V2 Proof Log parser accepts OSI1 + legacy `OSI_*` + OSI2 permanently, labeling imports `legacy_imported` / `server_verified=false`.

## 12. Security preservation during migration

- Pending privacy preserved (RLS default-deny on V2 tables; owner-proof reads, D6).
- Maintainer double-gate + auth-UUID RLS carried to V2.
- Server-only `event_receipts` insertion (service role) — closes the current anon-writable Proof Log gap.
- No service-role/model key in client at any stage.
- No fake rows created during backfill; ambiguous data is queued, never invented (§5).
- Stage-5 receipt authenticity verified (step 9) before any authoritative V2 write (step 10).
