# OSI V2 — AI Pack Trust Model

**Status:** Blueprint / design-only. Builds on the deployed `osi-ai-pack` Edge Function; no Edge Function behavior is changed by this document. AI Pack generation is **never** a truth decision (Constitution P8, §14).

---

## 1. Creators & restrictions

| Creator | May generate | May approve own pack | Contributes analyst weight to own pack | Sees restricted analyst notes |
|---|---|---|---|---|
| **Case owner** | ✅ draft from server-approved evidence | ❌ | ❌ | ❌ |
| **Verified analyst** | ✅ | ❌ (own creation) | ❌ (own) | ✅ |
| **Maintainer** | ✅ | ❌ alone (cannot make own pack high-confidence solo) | n/a | ✅ |

**Self-review prohibition (hard):** a reviewer/attester may never review or approve a version they created; enforced server-side in `ai_pack_reviews` (`reviewer_wallet != version.created_by_wallet`). Approval count **excludes** the creator (P3).

## 2. Reviewer restrictions
- Only verified analysts (weight ≥ 0.50) and the maintainer may attest.
- One active attestation per (version, reviewer); changes are historical (`superseded_by`).
- Case owner attestations, if allowed at all, are **advisory and uncounted** (never contribute confidence weight).

## 3. Evidence snapshots & versioning
- Each `ai_pack_versions` row stores `evidence_snapshot_hash` = `sha256` over the **ordered, canonicalized set of public Case evidence** (`case_evidence` where relevant) used to generate it.
- Versions are **immutable** except controlled `state` transitions.
- **Stale detection:** a background check compares the current Case evidence hash to each approved/current version's `evidence_snapshot_hash`. On drift → version `state=stale`, header shows "stale — regenerate," and the pack loses "current" status until a new version is generated and re-reviewed.

## 4. States (see State Machines §7)
`draft → review_required → (supported | disputed) → approved → attached_to_resolution → superseded`, plus `stale`. A version can only be **public** (public-safe brief) once `approved`.

## 5. Two outputs

| Output | Audience | Contents | Excludes |
|---|---|---|---|
| **Public-safe brief** (`content_public_brief`) | public (after approval, via `public_meta`-style path) | only public evidence, neutral framing, disclaimer | private evidence, analyst notes, restricted context, any personal data |
| **Restricted escalation pack** (`content_restricted`) | authorized case owner / verified analysts / maintainer (via `get`) | lawful operational context, restricted-but-lawful references | secrets, seed phrases, keys, highly sensitive personal information |

Neither output may state guilt, criminality, legal certainty, or recovery. Both carry the standing disclaimer.

## 6. Evidence Confidence Profile (NOT an accuracy %)

A transparent, component-based profile stored in `ai_pack_versions.confidence_profile` (jsonb). **Explicitly NOT** legal certainty, NOT probability of guilt, NOT model confidence, NOT automatic truth verification. Components (each 0–100, with caps and provenance):

| Component | Meaning | Source | Cap rule |
|---|---|---|---|
| `public_verifiability` | share of cited evidence that is publicly checkable (on-chain tx, public URL) | evidence set | capped by fraction of `is_public` evidence |
| `onchain_reproducibility` | cited tx/wallets that resolve on a public RPC/explorer | server re-check | 0 if any cited tx unresolvable |
| `evidence_coverage` | completeness vs the Case's declared questions | analyst grade | ≤ median analyst coverage mark |
| `source_consistency` | independent sources agreeing | analyst grade | ≤ number of independent corroborations · scaling |
| `analyst_attestation` | weighted independent analyst support | `ai_pack_reviews` | **count-gated**: 0 until ≥2 independent supporters (creator excluded) |

**Composite** is shown as a **profile (radar/bars), not a single number**, to avoid an "accuracy score." If the product owner insists on one headline number, it must be labeled "Review Signal" and be the *minimum* of the count-gated components (so it cannot be inflated by any single input).

### Anti-gaming
- `analyst_attestation` is 0 until the two-gate count is met (creator excluded).
- Owner/creator inputs never raise the profile.
- Re-generation resets attestation components to 0 (new version = new review).
- On-chain components are server-recomputed, not model-claimed.

### Examples
- **Strong:** all cited tx resolve on-chain, 3 independent analysts support, high coverage → high `public_verifiability`/`onchain_reproducibility`, `analyst_attestation` populated. Profile shows strong verifiability, explicitly *not* "true."
- **Weak:** off-chain-only claims, 1 supporter → `analyst_attestation=0` (count gate unmet), `onchain_reproducibility=0`. Profile shows "insufficient independent verification."

## 7. Attestations & attribution
Every review/approval/version change is attributable via `ai_pack_reviews` + an `event_receipts` row. The public brief may show **anonymized-but-attributable** analyst attestation totals; it never shows private reason codes.

## 8. Public display & downloads

| Surface | Shows |
|---|---|
| Public Records Case Detail → AI Pack tab | pack existence, type, `state`, public-safe brief (if approved), confidence *profile*, disclaimer, "stale" badge if applicable |
| `public_meta` endpoint | `case_id, pack_type, state, version_no, created_at` — **no content** |
| Restricted `get` | full restricted content — **only** owner/analyst/maintainer, via signature/JWT auth |
| Download | public brief: public; restricted: authorized only |

## 9. Memo / event requirements
- **Generation:** no Solana memo (not a truth decision) — server receipt `PACK_SUBMITTED` only.
- **Attestation (support/dispute/request_revision):** signMessage + server receipt (`PACK_SUPPORTED`/`PACK_DISPUTED`).
- **Approval:** memo `ESCALATION_PACK_APPROVED` (Solana tx) + receipt (governance-relevant, matches current signed behavior).
- **Attach to resolution / supersede / stale:** server receipts.

## 10. Exact UI states & button rules (Case Detail → AI Pack tab)

| State | Owner sees | Analyst sees | Maintainer sees |
|---|---|---|---|
| no pack | "Generate draft" (if case has approved evidence) | "Generate draft" | "Generate draft" |
| generating | spinner, buttons disabled | same | same |
| `review_required` | "Awaiting analyst review" + own draft (restricted view) | "Review" / "Support" / "Dispute" / "Request revision" (**not if own**) | + "Approve" (disabled until quorum; **not own alone**) |
| `supported` (quorum partial) | progress meter | attest buttons | "Approve" enabled when ≥2 independent + weight (creator excluded) |
| `approved` | "View public brief", "Download restricted" | same + attest history | + "Attach to resolution" |
| `disputed` | banner "under dispute" | dispute detail | resolve dispute path |
| `stale` | "Evidence changed — regenerate" | same | same |
| unauthorized viewer (public) | public brief only (if approved) + profile + disclaimer | — | — |

Button truthfulness rule: no button may imply publication/approval it cannot perform; "Approve" is disabled with an explanation when the count/weight gate is unmet, never a silent no-op. This directly fixes the current dormant/hidden AI-Pack UI.
