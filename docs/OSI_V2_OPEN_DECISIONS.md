# OSI V2 — Decision Register

**Status:** Blueprint / design-only. This is the authoritative decision register after product-owner and architecture review. Filename kept for stable links. Each decision is marked **RESOLVED**, **DEFERRED (feature flag)**, or **IMPLEMENTATION DETAIL (requires measurement)**. Recommendations in earlier revisions are now decisions.

Legend: **Sec** security · **UX** · **Impl** effort · **Mig** migration.

---

### D1 — Existing standalone Reports → Case vs Wire — **RESOLVED**
Rule-based classification (investigation `detail`/parent → Case; standalone finding → Wire) **plus a manual review queue** for ambiguous records. No invented mapping. *Sec low · UX high · Impl medium · Mig high.*

### D2 — Legacy bounty winner without a Report — **RESOLVED**
Represent as `case_resolutions.state = 'resolved_legacy'` with `winning_report_version_id = NULL` (the **only** state where a NULL winner is allowed — a native resolution may not finalize without one, `OSI_V2_DOMAIN_MODEL.md`). **Do not create a fake/synthetic Report.** Legacy payout references may remain linked to the historical winner wallet in a read-only legacy view. *Sec low · UX medium · Impl medium · Mig high.*

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
- Case initial open: either ≥1 independent eligible analyst with Σweight ≥ 0.50, **or** one full double-gated maintainer `approve_open` review at analyst weight 0 followed by that wallet's `CASE_OPENED` Memo. Normal initial rejection: ≥2 analysts, Σweight ≥ 2.00.
- **A maintainer signature is required as an additional gate for exactly three outcomes: resolution / winning-Report selection, AI-Pack approval, and seal.** No maintainer gate is added to Case Report / Wire Report publication or rejection, Case initial rejection, or challenge accept/reject. Case initial open is the sole independent-path exception above; it authorizes public investigation and is never a truth/guilt decision (`OSI_V2_VOTING_REPUTATION_MODEL.md §2`).
These are listed identically in `OSI_V2_VOTING_REPUTATION_MODEL.md §5`. *Sec high · UX medium · Impl small · Mig low. Exact numbers are an **implementation detail requiring measurement** and may be tuned via `osi_config` without a schema change.*

### D6 — Owner private reads — **RESOLVED**
Nonce-protected, signature-proof Edge endpoint (`OWNER_STATUS_PROOF`). **No broad pending-row public RLS.** *Sec high · UX high · Impl medium · Mig low.*

### D7 — AI Pack confidence — **RESOLVED**
Component **profile only**. **No headline accuracy/probability score.** *Sec medium · UX high · Impl small.*

### D8 — Case owner Pack review — **RESOLVED**
Owner feedback is **advisory and uncounted**, stored in the first-class table **`ai_pack_owner_feedback`** (never in `ai_pack_reviews`), event `AI_PACK_OWNER_FEEDBACK_SUBMITTED` (class B). Owner is never an analyst attester on their own Pack; feedback contributes zero weight and never changes the confidence profile automatically. *Sec medium · UX medium.*

### D9 — `OSI_CASE_BACKED` — **RESOLVED**
**Retire** the narrative-bearing memo. No subject text in any replacement. Any demand signal has **no governance/ranking consequence** and no subject narrative. *Sec medium (memo leak) · UX low.*

### D10 — Wire rewards — **RESOLVED**
The Wire has **no rewards**. A Wire Report must first be **promoted to a Case** before a reward may be pledged. *Sec low · UX medium.*

### D11 — Challenge eligibility & lifecycle — **RESOLVED**
Any connected wallet may **submit**, but **only an admissible challenge (`open`/`under_review`) pauses sealing** (correction #5). Targets are **real typed FKs** (exactly-one-of `case_id`/`case_report_version_id`/`wire_report_version_id`/`ai_pack_version_id`/`resolution_id`, CHECK-enforced); evidence is an **`evidence_items` FK** (a URL is first inserted as an `evidence_items` row, `kind='url'`). Rate limit + one-active-per-(wallet,target) + cooldown. **No stuck states** (correction #6): `submitted`/`admissibility_review` carry an `admissibility_ttl_at`, `open`/`under_review` a `review_deadline_at`; a timeout emits `CHALLENGE_EXPIRED` (Sys) and releases the sealing pause. Withdrawal (`CHALLENGE_WITHDRAWN`) is allowed in any non-terminal state but **never after a final accepted/rejected outcome**. No auto-penalty for honestly rejected/expired challenges; bad-faith needs a separate explicit determination. *Sec medium (spam) · UX medium.*

### D12 — Ancillary legacy tables — **RESOLVED (migration policy)**
Retire/archive `bounty_boosts` after preserving history (with D9); fold `profiles` into `analyst_profiles` only where identity mapping is reliable; inventory `requests`/`request_votes`; migrate only records with a clear V2 meaning; preserve uncertain records in read-only legacy/archive views; never invent mappings. *Mig medium.*

### D13 — Reward attribution — **RESOLVED**
One primary winning Report version → one reward recipient initially. Supporting contributors receive **attribution only**; no automatic split payment in the first implementation. *Sec low · UX medium.*

### D14 — Replay/authenticity — **RESOLVED**
**Stage-5 enforcement is required before `OSI_V2_WRITES_ENABLED` is set true** (migration step 10; see `OSI_V2_MIGRATION_ROLLOUT_PLAN.md`). Nonces are issued, bound, expired, and **atomically consumed exactly once** in the mandatory private store **`osi_nonces`** (`OSI_V2_DOMAIN_MODEL.md §9`); a **stateless nonce check is forbidden**; consumption and the receipt insert commit in one transaction; replay tests (reused/expired/wrong-target/concurrent-double-consume/idempotent-retry) are part of the gate. Native V2 receipts are created `server_verified=true`; imported legacy remain `false`. *Sec high · Impl high.*

### D15 — Analyst decision transport — **RESOLVED**
**Hybrid model:** individual decisions = `signMessage` + server-verified receipt; final public governance outcome = Solana Memo. Proof Log distinguishes the four proof types (`OSI_V2_MEMO_EVENT_SPEC.md §1`). *Sec high · UX medium · Impl medium.*

### D16 — Public analyst accountability — **RESOLVED**
Public governance decisions (public Cases, published Reports/Wire Reports, approved AI Packs, resolutions, completed challenges) show the participating **analyst or full maintainer role, public profile/handle where applicable, wallet, decision, voting-weight snapshot (maintainer initial-open path = 0), timestamp, and proof type**, with a public-safe receipt/tx reference. Private notes, private evidence, detailed moderation reasons, and sensitive reason text stay restricted. The phrase "anonymized-but-attributable" is **removed** for normal public decisions. Pre-public/private queue activity may show only counts until the Case opens. *Sec medium · UX high.*

### D17 — Bootstrap maintainer quorum (cold-start) — **RESOLVED (2026-07-16, product-owner decision)**
Problem: before an independent analyst network exists, Report publication, resolution/winner selection, and seal cannot reach their normal count+weight quorum, and the product would appear stalled during the pre-grant period.

Decision: a new, explicitly enabled, fail-closed mechanism — **`OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED`** (default `false`) — lets the full double-gated maintainer (configured admin wallet **and** authenticated Supabase maintainer identity, exactly as every other maintainer action already requires) additionally finalize three outcomes while the live eligible-analyst count is low: **Report publication, resolution/winning-Report selection, and seal**. This is a bounded, code-computed extension of the existing Case-initial-open maintainer-alternative path (D5); it never touches AI Pack approval or challenge accept/reject, which always remain analyst-quorum-only (the maintainer must never rule on a challenge to their own prior bootstrap decision).

The server computes a live tier from `count(analyst_profiles where status in ('probationary_analyst','verified_analyst','senior_analyst') and approved)` — no manual flag flips:

| Live eligible-analyst count | Required signer(s) for the three bootstrap-eligible outcomes |
|---|---|
| < 20 | full maintainer alone |
| 20–29 | full maintainer + 1 independent analyst |
| 30–49 | full maintainer + 2 independent analysts, reduced Σweight threshold |
| ≥ 50 | bootstrap retired; original D5 thresholds apply with no maintainer substitution |

Non-negotiable honesty requirement: every receipt/Memo produced through this path is recorded and displayed with a distinct decision channel (e.g. `maintainer_bootstrap`) in the Proof Log and public projections. It must never be presented as, counted as, or visually resemble an independent multi-analyst quorum outcome. Fabricating or implying analyst consensus that did not occur remains a hard prohibition (Product Constitution §3) regardless of this flag.

This is a time-boxed, self-decaying transitional mode, not a permanent governance change: at 50+ real eligible analysts it has no remaining effect and the system matches the original locked design. *Sec high (must stay honestly labeled and narrowly scoped) · UX medium · Impl medium · Mig low (new fail-closed config keys only).*

### D18 — Path B analyst candidacy (contribution-based) — **RESOLVED (2026-07-16, product-owner decision)**
The `contributor → analyst_candidate` status transition exists in schema but has no live trigger. Decision: implement the designed Path B — a wallet whose Case Report version becomes a Case's `winning_report_version_id` (a real, server-computed, quorum-selected win, never a self-declared or fabricated one) is automatically promoted from `contributor` to `analyst_candidate`, exactly as an application submission already does. This only opens candidacy; it never grants `probationary_analyst` status or nonzero weight by itself; that still requires the existing application-review/`ANALYST_PROBATION` path (D5). Path A (direct application) and Path B (contribution-triggered candidacy) both remain live, non-exclusive routes to the same reviewed activation gate. *Sec low · UX medium · Impl small · Mig low (additive trigger only).*

---

## Remaining deferred feature flags
- `OSI_V2_WRITES_ENABLED` — default **false** until Stage-5 write-gate work is verified (D14).
- `OSI_V2_FALLBACK_GOVERNANCE` — default **false** first release (D3).
- `OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED` — default **false**; time-boxed cold-start mechanism, self-decaying by live analyst count (D17).
- Per-surface `OSI_V2_UI` flags for staged rollout.

## Implementation details requiring measurement
- Exact threshold numbers (D5) — tunable via `osi_config`.
- Reputation formula constant `K` and independence/ring parameters (D4).
- Challenge cooldown/rate-limit values (D11).
- Staleness re-check cadence.

**Rule:** none of the above is silently changed in code; each requires a written product-owner sign-off before the corresponding implementation stage.
