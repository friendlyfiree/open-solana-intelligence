# OSI V2 — Decision Register

**Status:** Blueprint / design-only. This is the authoritative decision register after product-owner and architecture review. Filename kept for stable links. Each decision is marked **RESOLVED**, **DEFERRED (feature flag)**, or **IMPLEMENTATION DETAIL (requires measurement)**. Recommendations in earlier revisions are now decisions.

Legend: **Sec** security · **UX** · **Impl** effort · **Mig** migration.

---

### D1 — Existing standalone Reports → Case vs Wire — **RESOLVED**
Rule-based classification (investigation `detail`/parent → Case; standalone finding → Wire) **plus a manual review queue** for ambiguous records. No invented mapping. *Sec low · UX high · Impl medium · Mig high.*

### D2 — Legacy bounty winner without a Report — **RESOLVED**
Represent as `case_resolutions.state = 'resolved_legacy'`. **Do not create a fake/synthetic Report.** Legacy payout references may remain linked to the historical winner wallet in a read-only legacy view. *Sec low · UX medium · Impl medium · Mig high.*

### D3 — Maintainer-absence fallback governance — **DEFERRED (feature flag)**
Designed (Voting Model §5; State Machines §8) but **disabled in first release**: `OSI_V2_FALLBACK_GOVERNANCE=false`. High-risk outcomes remain maintainer-finalized initially. *Sec high · UX medium · Impl high · Mig low.*

### D4 — Reputation model — **RESOLVED**
Tier model live; full formula runs in **shadow mode** producing snapshots for comparison. Same two-gate guarantee either way. *Sec medium · UX medium · Impl tier=small · Mig low.*

### D5 — Voting thresholds — **RESOLVED (initial defaults)**
- Standard Report publication: **≥2 independent analysts, Σweight ≥ 2.00**.
- High-risk: **≥3 independent analysts, Σweight ≥ 4.00**.
- Resolution/winner: ≥2 (std) / ≥3 (high) + maintainer, Σweight ≥ 2.50 / 4.50.
- AI Pack approval: ≥2 independent (creator excluded) + maintainer, Σweight ≥ 2.50.
- Challenge accept/reject: ≥2 independent, Σweight ≥ 2.50.
- Seal: ≥2 + maintainer, Σweight ≥ 2.50.
- Case initial open: ≥1, Σweight ≥ 0.50. Normal initial rejection: ≥2.
These are listed identically in `OSI_V2_VOTING_REPUTATION_MODEL.md §5`. *Sec high · UX medium · Impl small · Mig low. Exact numbers are an **implementation detail requiring measurement** and may be tuned via `osi_config` without a schema change.*

### D6 — Owner private reads — **RESOLVED**
Nonce-protected, signature-proof Edge endpoint (`OWNER_STATUS_PROOF`). **No broad pending-row public RLS.** *Sec high · UX high · Impl medium · Mig low.*

### D7 — AI Pack confidence — **RESOLVED**
Component **profile only**. **No headline accuracy/probability score.** *Sec medium · UX high · Impl small.*

### D8 — Case owner Pack review — **RESOLVED**
Owner feedback is **advisory and uncounted** (stored outside `ai_pack_reviews`). Owner is never an analyst attester on their own Pack. *Sec medium · UX medium.*

### D9 — `OSI_CASE_BACKED` — **RESOLVED**
**Retire** the narrative-bearing memo. No subject text in any replacement. Any demand signal has **no governance/ranking consequence** and no subject narrative. *Sec medium (memo leak) · UX low.*

### D10 — Wire rewards — **RESOLVED**
The Wire has **no rewards**. A Wire Report must first be **promoted to a Case** before a reward may be pledged. *Sec low · UX medium.*

### D11 — Challenge eligibility — **RESOLVED**
Any connected wallet may **submit**, but **only an admissible challenge (`open`/`under_review`) pauses sealing** (correction #5). Rate limit + one-active-per-(wallet,target) + evidence requirement + cooldown. No auto-penalty for honestly rejected challenges. *Sec medium (spam) · UX medium.*

### D12 — Ancillary legacy tables — **RESOLVED (migration policy)**
Retire/archive `bounty_boosts` after preserving history (with D9); fold `profiles` into `analyst_profiles` only where identity mapping is reliable; inventory `requests`/`request_votes`; migrate only records with a clear V2 meaning; preserve uncertain records in read-only legacy/archive views; never invent mappings. *Mig medium.*

### D13 — Reward attribution — **RESOLVED**
One primary winning Report version → one reward recipient initially. Supporting contributors receive **attribution only**; no automatic split payment in the first implementation. *Sec low · UX medium.*

### D14 — Replay/authenticity — **RESOLVED**
**Stage-5 enforcement is required before `OSI_V2_WRITES_ENABLED` is set true** (see `OSI_V2_MIGRATION_ROLLOUT_PLAN.md`). Native V2 receipts are created `server_verified=true`; imported legacy remain `false`. *Sec high · Impl high.*

### D15 — Analyst decision transport — **RESOLVED**
**Hybrid model:** individual decisions = `signMessage` + server-verified receipt; final public governance outcome = Solana Memo. Proof Log distinguishes the four proof types (`OSI_V2_MEMO_EVENT_SPEC.md §1`). *Sec high · UX medium · Impl medium.*

### D16 — Public analyst accountability — **RESOLVED**
Public governance decisions (public Cases, published Reports/Wire Reports, approved AI Packs, resolutions, completed challenges) show **analyst public profile/handle, wallet, decision, voting-weight snapshot, timestamp, and proof type**, with a public-safe receipt/tx reference. Private notes, private evidence, detailed moderation reasons, and sensitive reason text stay restricted. The phrase "anonymized-but-attributable" is **removed** for normal public decisions. Pre-public/private queue activity may show only counts until the Case opens. *Sec medium · UX high.*

---

## Remaining deferred feature flags
- `OSI_V2_WRITES_ENABLED` — default **false** until Stage-5 write-gate work is verified (D14).
- `OSI_V2_FALLBACK_GOVERNANCE` — default **false** first release (D3).
- Per-surface `OSI_V2_UI` flags for staged rollout.

## Implementation details requiring measurement
- Exact threshold numbers (D5) — tunable via `osi_config`.
- Reputation formula constant `K` and independence/ring parameters (D4).
- Challenge cooldown/rate-limit values (D11).
- Staleness re-check cadence.

**Rule:** none of the above is silently changed in code; each requires a written product-owner sign-off before the corresponding implementation stage.
