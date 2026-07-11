# OSI V2 — AI Pack Trust Model

**Status:** Blueprint / design-only. Builds on the deployed `osi-ai-pack` Edge Function; no Edge Function behavior is changed. AI Pack generation is **never** a truth decision (Constitution P8, §14). Event names are canonical per `OSI_V2_MEMO_EVENT_SPEC.md`. The **authoritative table count is 32** (`OSI_V2_DOMAIN_MODEL.md §1`); the AI-Pack group is three real tables — `ai_packs`, `ai_pack_versions`, `ai_pack_owner_feedback` — plus the `ai_pack_version_evidence` manifest in the evidence group. None is deferred "to implementation."

---

## 1. Creators & restrictions

| Creator | Generate draft | Approve own version | Contributes counted weight to own version | Sees `content_analyst_restricted` |
|---|---|---|---|---|
| **Case owner** | ✅ (own case, server-approved evidence) | ❌ | ❌ (feedback advisory/uncounted) | ❌ |
| **Verified analyst** | ✅ | ❌ (own creation) | ❌ (own) | ✅ |
| **Maintainer** | ✅ | ❌ alone (cannot make own version approved/high-confidence solo) | n/a | ✅ |

**Self-review prohibition (hard):** a reviewer may never review/approve a version they created (`ai_pack_reviews.reviewer_wallet != version.created_by_wallet`, server-enforced). Approval count **excludes** the creator. Maintainer finalization cannot replace the analyst quorum.

## 2. Review model (corrections #1, #13)
- **Case owners** may: request/generate a draft, view owner-authorized content, submit **owner feedback**, and request correction. Owner feedback is a **first-class but advisory, uncounted** record in the real table **`ai_pack_owner_feedback`** (`OSI_V2_DOMAIN_MODEL.md`), **never** in `ai_pack_reviews`, and never called an analyst attestation.
- **`ai_pack_owner_feedback` model (correction #1):** `id`, `pack_version_id` (FK→`ai_pack_versions`), `owner_wallet`, `feedback_type` (`correction_request`/`clarification`/`evidence_note`), `public_safe_summary` (nullable), `feedback_restricted` (nullable), `event_receipt_id`, `created_at`, `superseded_by` (nullable, revision allowed), `is_active`. Rules: only the **proven Case owner** may submit; **advisory**; **zero voting weight**; **never** appears in `ai_pack_reviews`; **never** changes the Evidence Confidence Profile automatically; **never** approves or rejects a Pack; sensitive feedback stays restricted. Canonical event **`AI_PACK_OWNER_FEEDBACK_SUBMITTED`**, transport **class B** (signMessage + server-verified receipt). Its UI button maps to this table and a modeled endpoint (§9), never a placeholder.
- Only eligible **independent analysts** contribute counted Pack review weight (`ai_pack_reviews`, decisions `support`/`dispute`/`request_revision`/`approve`).
- Historical, non-erasing: changed decisions (and changed owner-feedback notes) insert a new active row + `superseded_by`.

## 3. Expanded lifecycle (correction #11) with orthogonal staleness
`ai_pack_versions.lifecycle_state`: `draft → review_required → (revision_requested | supported | disputed) → (approved | rejected) → attached_to_resolution → superseded`.

**Staleness is a separate axis**, not a lifecycle state — fields `is_stale`, `stale_at`, `stale_reason`, `superseded_by_version_id`. An `approved`/`attached_to_resolution` version may become `is_stale=true` (evidence drift) while its lifecycle history remains fully visible. `stale` is **never** used to erase whether a version was approved or attached.

Exact transitions:
- **request_revision:** ≥1 analyst → `revision_requested`; creator resubmits → **new version** (v+1), old version `superseded`.
- **mixed support/dispute:** the tally is net; `disputed` if unresolved disputes stand; dispute resolution is a quorum outcome.
- **rejection:** quorum (≥2 independent) → `rejected` (**`AI_PACK_REJECTED`, class A Solana Memo — one proof class, correction #7**); a new version may be generated later. Individual dispute/reject/revision votes remain class B (`AI_PACK_REVIEW_CAST`/`_REVISED`).
- **approval:** quorum (≥2 independent, creator excluded) + maintainer → `approved` (`AI_PACK_APPROVED`, memo); public brief becomes public.
- **attachment:** on resolution selection → `attached_to_resolution` (`PACK_ATTACHED`).
- **supersession:** a newer approved version → prior `superseded` (`PACK_SUPERSEDED`).
- **staleness:** evidence hash drift → `is_stale=true` (`PACK_STALE`), independent of lifecycle.

## 4. Evidence manifest & per-layer versioning (correction #8)
Each pack version has an **immutable evidence manifest** in the real table **`ai_pack_version_evidence`**: rows of `(pack_version_id, evidence_item_id, access_scope ∈ {public, owner_safe, analyst_restricted}, ordinal, evidence_hash_at_generation, created_at)`, immutable for an existing version. From it, each version stores or derives **three manifest hashes**:

| Manifest hash (on `ai_pack_versions`) | Computed over | Feeds content layer |
|---|---|---|
| `public_evidence_manifest_hash` | ordered `access_scope='public'` rows | `content_public_brief` (public evidence **only**) |
| `owner_safe_evidence_manifest_hash` | ordered `public` + `owner_safe` rows | `content_owner_safe` |
| `analyst_restricted_evidence_manifest_hash` | ordered allowed restricted-scope rows | `content_analyst_restricted` |

Rules: the public brief may cite **only** `public` evidence; owner-safe may add `owner_safe`; analyst-restricted may use its allowed scopes but **never** secrets, keys, illegal-access material, or highly sensitive personal information. Versions are immutable content. **Staleness is checked per layer**: a background job recomputes each scope's manifest from current Case evidence and compares it to the stored per-layer hash → on drift sets `is_stale` (and records which layer drifted in `stale_reason`). A version is **reproducible**: the manifest shows exactly which evidence items and hashes produced each output layer, without exposing restricted evidence publicly.

## 5. Three content/access layers (correction #12)

| Field | Audience | Contents | Excludes |
|---|---|---|---|
| `content_public_brief` | public (after approval) | public evidence only, neutral framing, disclaimer | private evidence, notes, restricted context, personal data |
| `content_owner_safe` | Case owner (+analyst+maintainer) for their Case | owner-relevant summary, no analyst-only notes | analyst-only notes, secrets |
| `content_analyst_restricted` | verified analyst / maintainer | lawful operational context | secrets, seed phrases, keys, prohibited personal info, illegal-access material |

Each layer draws **only** from evidence linked at its allowed `ai_pack_version_evidence.access_scope` (§4): public brief ← `public`; owner-safe ← `public`+`owner_safe`; analyst-restricted ← its allowed scopes. Private analyst review reasons/notes live in **`ai_pack_reviews.reason_code`** (restricted), **not** embedded in the Pack body. No tier ever exposes secrets/keys/prohibited personal data.

Access enforcement (server):
- public → `content_public_brief` only, and only if `approved`.
- Case owner → public brief + `content_owner_safe` (their Case), via owner-proof.
- verified analyst/maintainer → `content_analyst_restricted` via signature/JWT auth.
- creator approval restriction still applies.

## 6. Evidence Confidence Profile (NOT an accuracy %)
Stored in `ai_pack_versions.confidence_profile` (jsonb). **Explicitly NOT** legal certainty, probability of guilt, model confidence, or automatic truth verification. **Component profile only — no single headline accuracy/probability score** (D7, correction #13).

| Component | Meaning | Source | Cap |
|---|---|---|---|
| `public_verifiability` | share of cited evidence publicly checkable | evidence set | ≤ fraction `is_public` |
| `onchain_reproducibility` | cited tx/wallets resolvable on public RPC | server re-check | 0 if any cited tx unresolvable |
| `evidence_coverage` | completeness vs the Case's questions | analyst grade | ≤ median analyst coverage mark |
| `source_consistency` | independent sources agreeing | analyst grade | ≤ corroboration scaling |
| `analyst_attestation` | weighted independent analyst support | `ai_pack_reviews` | **count-gated: 0 until ≥2 independent supporters (creator excluded)** |

Displayed as a radar/bars profile, never one number. Owner/creator inputs never raise it; re-generation resets attestation to 0; on-chain components are server-recomputed.

## 7. Public display & downloads

| Surface | Shows |
|---|---|
| Case Detail → AI Pack tab | existence, type, `lifecycle_state`, public brief (if approved), confidence profile, disclaimer, `is_stale` badge, version history |
| public metadata endpoint | `case_id, pack_type, lifecycle_state, version_no, created_at, is_stale` — **no content** |
| restricted `get` | `content_analyst_restricted` — analyst/maintainer only |
| owner `get` | `content_owner_safe` — case owner only |
| download | public brief public; owner-safe → owner; restricted → analyst/maintainer |

## 8. Memo / event requirements
Generation = class-Sys `PACK_SUBMITTED` (no memo). Attestation = class-B `AI_PACK_REVIEW_CAST`/`_REVISED`. **Owner feedback = class-B `AI_PACK_OWNER_FEEDBACK_SUBMITTED` (advisory, uncounted).** Approval = class-A memo `AI_PACK_APPROVED`. **Rejection = class-A memo `AI_PACK_REJECTED` (one proof class — correction #7).** Attach/supersede/stale = class-Sys. Each event has exactly one transport class (no `Sys/Memo`).

## 9. UI states & button rules (Case Detail → AI Pack tab)

| State | Owner | Analyst | Maintainer |
|---|---|---|---|
| no pack | "Generate draft" (if case has approved evidence) | "Generate draft" | "Generate draft" |
| generating | spinner, disabled | same | same |
| `review_required` | own draft (owner-safe) + "Submit feedback" (advisory) / "Request correction" | "Review": Support/Dispute/Request revision (**hidden if own**) | + "Approve" (disabled until quorum; **not own alone**) |
| `revision_requested` | "Resubmit revision" (if creator) | shows requested changes | same |
| `supported` (partial) | progress meter | attest buttons | "Approve" enabled at ≥2 independent + weight (creator excluded) |
| `disputed` | "under dispute" banner | dispute detail | resolve-dispute path |
| `approved` | "View public brief", "Download owner-safe" | + "Download restricted", attest history | + "Attach to resolution" |
| `rejected` | "Rejected — regenerate?" | rejection detail | same |
| `is_stale` (any) | "Evidence changed — regenerate" + prior state still shown | same | same |
| public viewer | public brief only (if approved) + profile + disclaimer | — | — |

The owner's **"Submit feedback"** / **"Request correction"** buttons map to `ai_pack_owner_feedback` (`feedback_type` = `clarification`/`evidence_note` / `correction_request`) via a modeled endpoint emitting `AI_PACK_OWNER_FEEDBACK_SUBMITTED` (class B) — advisory, uncounted, never an approval/rejection path, never shown as an analyst attestation.

**Disabled buttons state the exact unmet prerequisite** (e.g., "Approve — needs 1 more independent analyst"); never a silent no-op or a placeholder implying it works. This fixes the current unreachable AI-Pack UI.
