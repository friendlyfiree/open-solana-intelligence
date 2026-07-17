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

### D19 — SAS Verified Analyst credential (mandatory review-authority gate) — **RESOLVED (2026-07-16, product-owner decision)**
Problem: an analyst's review authority is today derived only from OSI's own database tier. There is no independently verifiable, third-party-checkable proof that a reviewing wallet was ever a real OSI analyst at the moment its review counted. For the grant application and for public trust, review authority should be attestable on a permissionless public ledger, not only inside OSI's private tables.

Decision: adopt the **Solana Attestation Service (SAS)** — the live, permissionless mainnet protocol (program `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`, TypeScript SDK `sas-lib`) — and treat `OSI_VERIFIED_ANALYST` as a **mandatory review-authority credential, not a cosmetic profile badge**. Once enforcement is turned on (a separate future rollout), an analyst review counts toward a governance quorum only if the reviewing wallet holds a currently valid, unexpired, correctly-issued-and-schema'd SAS credential under OSI's exact Credential/Schema/issuer at the moment of counting. **No PII, case data, or personal information is ever written to an on-chain credential — only the wallet's review-authority tier/status.** The attestation subject is the analyst wallet itself (used as the attestation nonce so the account is deterministically re-derivable for verification); the schema carries integer tier/status codes only, with no name, no case reference, and no free text.

This ships in ordered steps, front-loaded so the cheapest, most concretely verifiable artifact lands first:

- **Step 0 — real on-chain Credential + Schema.** A standalone, one-time maintainer setup tool (`tools/osi-sas-setup.html`, separate from the product design system) connects Phantom and lets the configured OSI maintainer wallet sign exactly two mainnet transactions: create the OSI Credential account and define the `OSI_VERIFIED_ANALYST` Schema under it. The tool **never holds or requests a private key**; every signature is one normal human Phantom approval, and no agent signs anything. The two resulting public keys are recorded as plain (non-secret) values in `osi_config` (`OSI_V2_SAS_CREDENTIAL_PUBKEY`, `OSI_V2_SAS_SCHEMA_PUBKEY`, plus the issuer authority `OSI_V2_SAS_ISSUER_PUBKEY`), because they are public on-chain addresses, not secrets.
- **Step 1 — issuance, live-capable.** Because issuance only *adds* a credential and never changes any existing counted outcome, it is safe **enabled by default once Step 0's pubkeys exist**. Guard: **`OSI_V2_SAS_CREDENTIAL_ISSUANCE_ENABLED`** — default `true` once the Step 0 pubkeys are present in `osi_config`; **fail closed to a logged no-op if those pubkeys (or the issuer authority secret) are absent**. Analyst activation (DB state, Memo) always succeeds on its own; SAS issuance is an additive side effect that must never block or crash the underlying analyst-activation transaction. Every existing tier-changing transition (`ANALYST_PROBATION`, promotion, demotion, revocation) also triggers a credential-state reconciliation attempt so DB tier and on-chain credential state never drift silently.
- **Step 2 — public verifier.** A read-only, unauthenticated endpoint (`op:"sas_verify"` on `osi-v2-proof`) takes any wallet address from any external caller and returns whether that wallet currently holds a valid `OSI_VERIFIED_ANALYST` credential under OSI's exact schema/issuer, **checked live against Solana** (SAS is authoritative; any DB record is a cache/index only). Rate-limited using the existing `_shared` nonce/rate-limit patterns.
- **Step 3 — shadow validation, telemetry, and fail-closed quorum code, built now, enforcement gated off.** Additive service-only tables (`osi_v2_sas_wallet_credentials`, `osi_v2_sas_review_verifications`, FORCE RLS, service-role only) record per-wallet last-known state plus per-review the verification state that applied *at the time the review was cast* (a review's own historical snapshot never changes retroactively once resolved). A best-effort bounded-timeout SAS check is wired into the five live review-commit paths; on RPC/timeout failure the review still succeeds and its state is recorded `pending_verification`. The five live quorum-computation functions (report publication, case initial review, resolution, seal, challenge) are modified so that when **`OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED=true`** a review counts toward the tally only if its current verification state is `verified` (one lazy bounded-timeout re-check first if stale or `pending_verification`). Re-verification is lazy — there is no cron in this codebase — happening the next time a dependent quorum computation runs.

Flag defaults and why: `OSI_V2_SAS_CREDENTIAL_ISSUANCE_ENABLED` is **live-capable by default once Step 0 exists** because issuance is purely additive and cannot change any counted outcome. `OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED` ships **`false`** and stays off in this task; when the flag is `false`, every one of the five quorum functions is provably behaviorally identical to current `main` regardless of any wallet's credential state (the single most safety-critical regression requirement here). Enabling enforcement later is a separate rollout, permitted only after (a) at least three distinct wallets hold a live, independently-verifiable credential and (b) shadow-mode telemetry shows the live verification path is reliable and fast enough — a manual precondition, not a runtime check.

Prospective-only invariant: enforcement, once enabled, changes which *new* reviews count from that moment forward and **never retroactively recounts, invalidates, or rewrites any already-recorded review, quorum tally, publication, resolution, or seal**, preserving the existing "published/resolved history is never rewritten" invariant.

Bootstrap-channel exclusion: the maintainer's own double-gate actions and the D17 `maintainer_bootstrap` decision channel are **permanently out of scope** for this credential gate in either flag state. Bootstrap decisions are maintainer authority, not simulated analyst authority, and must never be subject to (or blocked by) the SAS check. *Sec high (mandatory gate; on-chain proof; no PII or issuer key material anywhere) · UX low (read-only wallet credential status only) · Impl high · Mig medium (additive service-only tables + fail-closed config keys; five quorum functions replaced identically-when-off).*

---

## Remaining deferred feature flags
- `OSI_V2_WRITES_ENABLED` — default **false** until Stage-5 write-gate work is verified (D14).
- `OSI_V2_FALLBACK_GOVERNANCE` — default **false** first release (D3).
- `OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED` — default **false**; time-boxed cold-start mechanism, self-decaying by live analyst count (D17).
- `OSI_V2_SAS_CREDENTIAL_ISSUANCE_ENABLED` — **live-capable**; default `true` once Step 0 pubkeys exist, fail-closed no-op when they are absent (D19).
- `OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED` — default **false**; when off the five quorum functions are byte-for-byte behaviorally identical to `main`; prospective-only when later enabled (D19).
- Per-surface `OSI_V2_UI` flags for staged rollout.

## Implementation details requiring measurement
- Exact threshold numbers (D5) — tunable via `osi_config`.
- Reputation formula constant `K` and independence/ring parameters (D4).
- Challenge cooldown/rate-limit values (D11).
- Staleness re-check cadence.

**Rule:** none of the above is silently changed in code; each requires a written product-owner sign-off before the corresponding implementation stage.
