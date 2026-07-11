# OSI V2 — Migration & Rollout Plan

**Status:** Blueprint / design-only. **No SQL is created or executed here. No production data, Supabase state, or deployment configuration is touched.** This is an *additive* strategy: new tables and compatibility views alongside the current schema, never destructive renames. The **authoritative V2 table count is 32** (identical in `OSI_V2_DOMAIN_MODEL.md §1`, `OSI_V2_README.md`, and the final report).

**Hard gate (locked, D14 / Stage-5):** `OSI_V2_WRITES_ENABLED` stays **false** and **no authoritative V2 write cutover happens before step 10 (Stage-5 verification) passes.** Steps 1–9 are schema, policy, infrastructure, a one-time non-authoritative backfill, and read-only surfaces only. See §3.

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

`osi_config` is reused; the other **31 are additive-new domain tables**. No current table is renamed or dropped during migration. The three tables added in this revision (`analyst_application_versions`, `ai_pack_owner_feedback`, `ai_pack_version_evidence`) have **no v1 predecessor** — they are created empty and populated only by native V2 writes.

### 2.1 Physical-name collision (v1 `challenges`)
The v1 schema already has a `challenges` table with a different shape, and additive migration keeps it. To avoid a collision the **V2 challenge domain table is created under the physical name `challenges_v2`** and is referred to by its logical name `challenges` throughout the blueprint. (`osi_config` is the only intentional name reuse; no other V2 domain name collides with a v1 table.) A rename to `challenges` may happen only in the destructive-free far-future *after* v1 retirement, never during transition.

### 2.2 Infrastructure tables (named, NOT among the 32 domain tables)
Separately from the 32 domain tables, the physical model includes private, service-only infrastructure:
- **`osi_nonces`** — Stage-5 replay/idempotency ledger (`OSI_V2_DOMAIN_MODEL.md §9`).
- **`migration_crosswalk`** — durable old-id ↔ new-id map (V2 id, v1 id, entity kind, confidence, created_at); retained for dual-read and audit, never discarded.
- **`migration_manual_queue`** — unclassifiable legacy rows (v1 ref, candidate kinds, reason, status `pending`/`resolved`) awaiting owner/maintainer categorization; nothing is auto-guessed.

These carry no domain data and are counted/named separately so the "32" never conceals security or migration infrastructure.

---

## 3. Rollout order (14 steps)

The order is fixed. **No authoritative V2 write cutover happens before step 10 (Stage-5 verification) passes.** Steps 1–9 create schema, policies, infrastructure, a one-time non-authoritative backfill, and read-only surfaces only. The **controlled backfill (step 6)** is a one-time, service-only import — **not** the authoritative live write path, and it never creates native unverified receipts (legacy imports are `server_verified=false` by design).

| # | Step | What happens | Authoritative write cutover? |
|---|---|---|---|
| 1 | **Final blueprint approval** | All blueprint docs agree; `OSI_V2_OPEN_DECISIONS.md` D1–D16 signed off | no |
| 2 | **Additive V2 schema** | Create the **31 additive domain tables** (V2 challenge table as physical `challenges_v2`, §2.1) + version/header structure; `osi_config` reused; create infra tables `osi_nonces`, `migration_crosswalk`, `migration_manual_queue` (§2.2). No drop/rename | no (DDL only) |
| 3 | **RLS / default-deny policies** | Default-deny on every V2 + infra table; owner-proof read paths; maintainer auth-UUID write restriction; service-role-only `event_receipts`/`osi_nonces` access; `security_invoker=true` on every exposed view (§6) | no |
| 4 | **Stage-5 nonce / replay / server-receipt infrastructure** | `osi_nonces` issuance/expiry/atomic-consumption, purpose+target+payload-hash binding, freshness/idempotency, actor-role verification, server-only receipt insertion, replay tests | no (infra only) |
| 5 | **Read-only migration classification** | Read-only extract + classification; write **only** to `migration_crosswalk` / `migration_manual_queue`; validate against §5 rules; **no writes to domain V2 tables** | no |
| 6 | **Controlled backfill application** | One-time, **service-only, idempotent** import of *classified* legacy rows into V2 domain tables, driven by `migration_crosswalk`; ambiguous rows stay in `migration_manual_queue` (never imported by guess); imported `event_receipts` are `legacy_imported`/`server_verified=false`; V2 tables are **not yet authoritative or served** | no (non-authoritative import) |
| 7 | **Read-only V2 UI** | Public Records, Case Detail read, Proof Log render over V2 tables (incl. backfilled data) while **v1 stays the authoritative writer** and the unchanged v1 frontend keeps reading untouched v1 tables (§6) | no |
| 8 | **V2 intake endpoints** | Deploy `osi-v2-*` case/report/wire intake Edge Functions, **kept disabled behind `OSI_V2_WRITES_ENABLED=false`** | staged, still gated |
| 9 | **V2 review endpoints** | Deploy typed-review + resolution + challenge + AI-Pack-review + application-review endpoints, also **gated** | staged, still gated |
| 10 | **Verify all native V2 receipts are `server_verified=true`** | Prove every native write path produces a server-verified receipt (nonce consumed atomically in `osi_nonces`, target/payload bound, role verified, replay tests green). Imported legacy stays `server_verified=false`. **This is the Stage-5 gate.** | verification only |
| 11 | **Enable `OSI_V2_WRITES_ENABLED`** | Flip the flag **only after step 10 passes**. V2 becomes the authoritative writer; v1 submission disabled | **yes — the cutover** |
| 12 | **Per-surface rollout** | Flip `OSI_V2_UI` per surface: intake → review/quorum → AI Pack UI (finally reachable) → rewards | yes, per surface |
| 13 | **Soak period** | Monitor under real load; validation stays green; instant per-surface rollback available | — |
| 14 | **Legacy retirement** | Only after soak: retire v1 submission → v1 review → v1 AI pack → v1 Edge Functions; then (optionally) compat views. Keep `onchain_events`/legacy memos as historical record indefinitely | — |

**Gate restated:** steps 1–10 perform **no authoritative V2 write cutover**; the step-6 backfill is a one-time non-authoritative import. Step 10 (Stage-5 receipt authenticity) must pass before step 11. This is the locked Stage-5 requirement (`OSI_V2_OPEN_DECISIONS.md` D14).

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
| `challenges` (v1, `item_type`/`item_id`) | `challenges` v2 (physical `challenges_v2`, §2.1) with the untyped pair remapped to **exactly one typed target FK** + an `evidence_items` FK | id remap + type resolution needed |
| `onchain_events` | `event_receipts` (verbatim import; `proof_type='legacy_imported'`, `server_verified=false`, original `event_version` preserved) | keep legacy memo strings verbatim |
| `analysts` | `analyst_profiles` (status derived: verified+approved→`verified_analyst`) | contributions backfilled conservatively, low confidence |

## 5. Backfill rules (locked)

0. **When legacy rows are written into V2 (timing):** classification (step 5) writes **only** to `migration_crosswalk` / `migration_manual_queue`. Legacy rows are written into the V2 **domain** tables **only at the controlled backfill step (step 6)** — a one-time, service-only, idempotent import — and never before. No live/authoritative V2 write occurs until cutover (step 11).
1. **Read-only extract** of current tables — no mutation of live data.
2. **Build the crosswalk maps** (`bounty→case`, `report→{case_report | wire_report | case}`) in **`migration_crosswalk`**, using `bounty` text linkage, presence of `detail`, and `approved`/`sealed` state. **Un-classifiable rows go to `migration_manual_queue` — never auto-guessed, never imported by guess.**
3. **Legacy events remain `server_verified=false`.** Every row imported from `onchain_events` is `proof_type='legacy_imported'`, `server_verified=false`, with its original memo string and version preserved verbatim. No import is ever relabeled as server-verified or on-chain-native.
4. **No synthetic Report for a legacy winner.** A `bounties.winner_wallet` with no corresponding Report becomes `case_resolutions.state='resolved_legacy'` (D2). **No fake/stub `case_reports` or `case_report_versions` is invented** to satisfy the winning-version FK; the legacy winner wallet is preserved only in a read-only legacy view.
5. **Ambiguous Case/Wire mappings go to manual review.** Free-text `reports.bounty`, standalone approved reports, and thin-detail bounties are queued for owner/maintainer categorization, not classified by guess.
6. **No reputation inflation.** Seed `analyst_profiles` from `analysts`; seed `analyst_contributions` only from clearly-attributable accepted/winning items. Ambiguous history contributes **nothing**; no weight is raised from uncertain data. Probationary seeds start at 0.50.
7. **Preserve legacy crosswalks.** `migration_crosswalk` is retained for dual-read and audit; it is never discarded after cutover.
8. **No dual authoritative writes.** During transition there is exactly one authoritative writer per record: **v1 stays authoritative until cutover (step 11)** and the unchanged v1 frontend reads untouched v1 tables (§6). The step-6 backfill is a one-time non-authoritative import, not a second writer. There is never a window where both v1 and V2 authoritatively write the same record.
9. **No destructive migration.** No current table is dropped, renamed, or overwritten. Migration is purely additive; `onchain_events` and legacy memos are kept as historical record indefinitely.

## 6. Dual-read / compatibility phase (corrected)

- **The unchanged v1 frontend keeps reading the untouched v1 tables directly.** Because migration is additive and no v1 table is dropped or renamed, the old client continues to query `reports`, `bounties`, etc. as-is while v1 remains the authoritative writer (steps 1–10). **We do NOT claim the unchanged frontend silently adopts a differently-named `*_compat` view** — a view cannot transparently take over an existing table's name without first dropping that table (a destructive step we avoid in the first release).
- **`*_compat` views are a documented later option, not a transition dependency.** If v1 tables are ever retired (step 14), a compatibility shim for any remaining old client requires either (a) updating that client to the V2/new names, or (b) recreating same-named views *after* the table is dropped (name reuse post-retirement). Neither is relied upon during transition.
- **RLS-safe views (mandatory):** every exposed compatibility view and every public-safe projection is created with **`security_invoker = true`** (and `security_barrier` where filtering), so the view executes with the querying role's RLS — a view can **never** bypass default-deny or leak pending/private rows. Public-safe projections expose only the minimal public columns (`OSI_V2_MEMO_EVENT_SPEC.md §6`).
- New V2 frontend reads V2 tables directly. Both run against the same DB; **only one side is ever the authoritative writer** of a given record (§5.8); the step-6 backfill is a one-time non-authoritative import, not a second writer.

## 7. Feature flags

- `OSI_V2_SCHEMA_READY`, `OSI_V2_WRITES_ENABLED` (**false until step 10 verified**), `OSI_V2_UI` (per-surface), `OSI_V2_FALLBACK_GOVERNANCE` (default off, D3). Flags let each surface flip independently and roll back instantly.

## 8. Edge Function rollout

- Ship `osi-v2-*` functions (case intake, typed review, resolution, challenge, ai-pack v2, application review) **alongside** current `osi-analyst-intake`/`osi-ai-pack`. Do not change deployed v1 behavior. Cut client calls over per flag (steps 7–8 deploy disabled; step 10 enables). Retire v1 functions only after cutover + soak (step 13).

## 9. Data validation (must be green before step 11 cutover)

- Crosswalk completeness — every migrated row maps or is queued.
- No orphan `case_reports`/`case_report_versions` (all have `case_id`/`report_id`).
- Every `analyst_application_reviews` row targets an immutable `analyst_application_versions.id` (never a bare header).
- Every `ai_pack_versions` row has a complete `ai_pack_version_evidence` manifest and consistent per-layer manifest hashes; `ai_pack_owner_feedback` never appears in `ai_pack_reviews`.
- Every `challenges` row has exactly one non-null typed target FK and a real `evidence_item_id`; no non-terminal challenge lacks a TTL/deadline.
- No pending row publicly readable (RLS default-deny test).
- Reputation sanity — no weight > 3.00; probationary = 0.50; no inflation from ambiguous history.
- Proof Log parity — every legacy `onchain_events` row present as a `legacy_imported`, `server_verified=false` receipt.
- **Receipt authenticity (Stage-5, step 10):** every native V2 write path produces `server_verified=true` with the nonce atomically consumed in `osi_nonces` and target/payload bound; replay tests green; no live V2 write can create an unverified receipt.
- Every V2 `challenges_v2` row has exactly one typed target FK; every `resolution_reviews` row names a same-Case candidate; every native `case_resolutions` in a finalized state has a non-null `winning_report_version_id` (except `resolved_legacy`).

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

- Pending privacy preserved (RLS default-deny on V2 + infra tables; owner-proof reads, D6).
- **Every exposed view / public-safe projection is `security_invoker=true`** — views cannot bypass RLS or leak pending/private rows.
- `osi_nonces` / `migration_crosswalk` / `migration_manual_queue` are **service-only** (RLS default-deny to all other roles).
- Maintainer double-gate + auth-UUID RLS carried to V2.
- Server-only `event_receipts` insertion (service role) — closes the current anon-writable Proof Log gap.
- No service-role/model key in client at any stage.
- No fake rows created during backfill; ambiguous data is queued, never invented (§5).
- Stage-5 receipt authenticity verified (step 10) before any authoritative V2 write cutover (step 11).
