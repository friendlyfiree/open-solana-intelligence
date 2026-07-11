# OSI V2 — AI Pack Trust Model

**Status:** Blueprint / design-only. Builds on the deployed `osi-ai-pack` Edge Function; no Edge Function behavior is changed. AI Pack generation is **never** a truth decision (Constitution P8, §14). Event names are canonical per `OSI_V2_MEMO_EVENT_SPEC.md`.

---

## 1. Creators & restrictions

| Creator | Generate draft | Approve own version | Contributes counted weight to own version | Sees `content_analyst_restricted` |
|---|---|---|---|---|
| **Case owner** | ✅ (own case, server-approved evidence) | ❌ | ❌ (feedback advisory/uncounted) | ❌ |
| **Verified analyst** | ✅ | ❌ (own creation) | ❌ (own) | ✅ |
| **Maintainer** | ✅ | ❌ alone (cannot make own version approved/high-confidence solo) | n/a | ✅ |

**Self-review prohibition (hard):** a reviewer may never review/approve a version they created (`ai_pack_reviews.reviewer_wallet != version.created_by_wallet`, server-enforced). Approval count **excludes** the creator. Maintainer finalization cannot replace the analyst quorum.

## 2. Review model (correction #13)
- **Case owners** may: request/generate a draft, view owner-authorized content, submit **owner feedback**, and request correction. Owner feedback is **advisory and uncounted** — stored separately (an `ai_pack_owner_feedback` advisory record), **never** in `ai_pack_reviews`, and never called an analyst attestation.
- Only eligible **independent analysts** contribute counted Pack review weight (`ai_pack_reviews`, decisions `support`/`dispute`/`request_revision`/`approve`).
- Historical, non-erasing: changed decisions insert a new active row + `superseded_by`.

## 3. Expanded lifecycle (correction #11) with orthogonal staleness
`ai_pack_versions.lifecycle_state`: `draft → review_required → (revision_requested | supported | disputed) → (approved | rejected) → attached_to_resolution → superseded`.

**Staleness is a separate axis**, not a lifecycle state — fields `is_stale`, `stale_at`, `stale_reason`, `superseded_by_version_id`. An `approved`/`attached_to_resolution` version may become `is_stale=true` (evidence drift) while its lifecycle history remains fully visible. `stale` is **never** used to erase whether a version was approved or attached.

Exact transitions:
- **request_revision:** ≥1 analyst → `revision_requested`; creator resubmits → **new version** (v+1), old version `superseded`.
- **mixed support/dispute:** the tally is net; `disputed` if unresolved disputes stand; dispute resolution is a quorum outcome.
- **rejection:** quorum (≥2 independent) → `rejected` (`AI_PACK_REJECTED`, class-Sys/Memo); a new version may be generated later.
- **approval:** quorum (≥2 independent, creator excluded) + maintainer → `approved` (`AI_PACK_APPROVED`, memo); public brief becomes public.
- **attachment:** on resolution selection → `attached_to_resolution` (`PACK_ATTACHED`).
- **supersession:** a newer approved version → prior `superseded` (`PACK_SUPERSEDED`).
- **staleness:** evidence hash drift → `is_stale=true` (`PACK_STALE`), independent of lifecycle.

## 4. Evidence snapshots & versioning
Each `ai_pack_versions` stores `evidence_snapshot_hash` = sha256 over the **ordered, canonicalized public evidence set** (`case_evidence_links` / relevant `*_version_evidence`). Versions are immutable content. A background check compares current Case evidence hash vs the version hash → on drift sets `is_stale`.

## 5. Three content/access layers (correction #12)

| Field | Audience | Contents | Excludes |
|---|---|---|---|
| `content_public_brief` | public (after approval) | public evidence only, neutral framing, disclaimer | private evidence, notes, restricted context, personal data |
| `content_owner_safe` | Case owner (+analyst+maintainer) for their Case | owner-relevant summary, no analyst-only notes | analyst-only notes, secrets |
| `content_analyst_restricted` | verified analyst / maintainer | lawful operational context | secrets, seed phrases, keys, prohibited personal info, illegal-access material |

Private analyst review reasons/notes live in **`ai_pack_reviews.reason_code`** (restricted), **not** embedded in the Pack body. No tier ever exposes secrets/keys/prohibited personal data.

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
Generation = class-Sys `PACK_SUBMITTED` (no memo). Attestation = class-B `AI_PACK_REVIEW_CAST`/`_REVISED`. Approval = class-A memo `AI_PACK_APPROVED`. Attach/supersede/stale = class-Sys.

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

**Disabled buttons state the exact unmet prerequisite** (e.g., "Approve — needs 1 more independent analyst"); never a silent no-op or a placeholder implying it works. This fixes the current unreachable AI-Pack UI.
