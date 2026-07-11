# OSI V2 — Product Constitution

**Status:** Blueprint / design-only. Not implemented. No production code, schema, Edge Function, or Supabase state is changed by this document.
**Applies to:** the next major version of Open Solana Intelligence (OSI V2).
**Authority:** This is the constitutional contract. Where any later design document, state machine, permission matrix, or migration plan disagrees with this file, **this file wins** unless a technical contradiction is explicitly documented in `OSI_V2_OPEN_DECISIONS.md`.

---

## 1. Mission

OSI is a **public, wallet-signed, community-reviewed open-source intelligence desk for Solana.** It turns public on-chain and public off-chain evidence into reviewed, challengeable, attributable **Case records**. It exists so that victims, researchers, exchanges, compliance teams, and investigators can find *reviewed public intelligence* about Solana incidents and entities — never a verdict, never a recovery service.

OSI's product is **process integrity**, not truth. It proves *who signed what, when, and how it was reviewed* — it never proves guilt.

## 2. Scope

A **Case** is a request to investigate a public-evidence question about Solana. Cases are **not limited to hacks or scams.** In scope:

- security incident · wallet drain · rug / scam · impersonation
- suspicious fund movement · wallet attribution · treasury research
- DAT / DAO / project-wallet discovery · project / entity research
- token distribution · governance research · public-claim verification
- bridge / cross-chain fund-flow investigation
- any other lawful, **public-source** Solana intelligence request

## 3. Non-goals (hard prohibitions)

OSI **must reject, refuse to host, or design against** all of the following, at intake and in every downstream surface:

- private-key or seed-phrase requests or disclosure
- doxxing or non-public personal-data investigation
- harassment, stalking, or targeting of private individuals
- unsupported guilt / criminality / fraud determinations
- private-account compromise or illegal-access requests
- custody, escrow, or holding of user funds
- guaranteed recovery, guaranteed payment, or guaranteed outcome
- legal advice, financial advice, or claims of legal authority
- automatic AI truth-determination or auto-publication
- exposure of private/pending evidence to the public
- fabricated transactions, metrics, wallets, analysts, or reviews

A Case or Report that requires any prohibited action must be blocked at the **intake safety gate** (client pre-check) and again at the **server authorization point** (Edge Function / RLS). A hidden button is never authorization.

## 4. Immutable product principles

These principles are constitutional. Changing any of them is a governance decision recorded in `OSI_V2_OPEN_DECISIONS.md`, never a silent code change.

- **P1 — Case is the primary entity.** Everything (Reports, evidence, reviews, AI Packs, challenges, rewards, resolution, seal) hangs off a Case. A bounty is *not* a core entity; it is an optional reward pledge attached to a Case.
- **P2 — Private by default.** A newly signed Case/Report is private and readable only by its owner (via a proof-bound path), verified analysts, and the maintainer, until an explicit initial-review approval opens it.
- **P3 — No self-decisive authority.** No actor may be the sole authority for publication, rejection, AI-Pack approval, or resolution — of their own contribution or in general. Critical outcomes require **≥ 2 independent analyst wallets**.
- **P4 — Quality-adjusted, bounded reputation.** Analyst voting power is derived from *quality-adjusted* history and is mathematically bounded to **[0.50, 3.00]**. Weight can never let one analyst finalize a critical outcome alone.
- **P5 — Maintainer is a finalizer, not the truth.** The normal path is analyst quorum → `ready_for_finalization` → maintainer signed finalization → publication. A stricter no-maintainer fallback is designed but gated behind product-owner approval.
- **P6 — Process, not verdict.** The Proof Log records *actions and provenance*. It is not a legal or factual verdict. Public copy must never imply otherwise.
- **P7 — Non-custodial payments.** Rewards and voluntary support are always direct wallet-to-wallet, confirmed on-chain, never escrowed. Support never influences review, ranking, weight, publication, or resolution.
- **P8 — Evidence-bound AI.** AI Packs summarize *only* server-approved Case evidence. Generation is never a truth decision, never auto-approves, never auto-publishes. Full/restricted content is authorized-only; the public sees minimized metadata and a public-safe brief.
- **P9 — Minimal, privacy-preserving memos.** On-chain memos carry only minimal references (versioned type + target ref + actor + role + ts + hashes). Never narrative, allegation, personal data, private evidence, keys, or analyst notes.
- **P10 — Server-enforced authorization.** Every privileged action names a **server-side** enforcement point (Edge Function auth and/or RLS). Client checks are UX only.

## 5. Core definitions

### 5.1 Case
The first-class unit of work. A signed, initially-private request to investigate a public-evidence question, with a category (from §2 scope), a public-safe title/summary, an owner, a lifecycle stage, an optional reward pledge, and a collection of Reports, evidence, reviews, AI Packs, challenges, and (eventually) a resolution and seal. **Bounty = optional reward pledge on a Case, not a separate entity.**

### 5.2 Report (Case Report)
A signed contribution of findings that **belongs to exactly one Case**. Authored by the Case owner, an ordinary wallet, a researcher, or an analyst. Private until review requirements are met. A Report author may **never** review their own Report, and the Case owner may never create a decisive self-review path. One Report may be chosen as the Case's **winning / resolution Report**; it remains an immutable contribution record forever.

### 5.3 Wire Report
A standalone signed intelligence publication that does **not** require an existing Case (e.g., a wallet-cluster finding, treasury map, token-distribution analysis, public-claim verification). The Wire is a separate publication lane from Field Office; it **hosts no bounties**. A Wire author cannot approve their own Wire Report; publication requires independent weighted review. A Wire Report may later be **promoted** into a new Case as source evidence.

### 5.4 AI Pack
A versioned, evidence-bound intelligence brief generated from server-approved Case evidence. Two outputs: a **public-safe brief** (public evidence only) and a **restricted escalation pack** (authorized readers only, still excludes secrets and sensitive personal data). Carries an **Evidence Confidence Profile** (transparent components — *not* an accuracy/probability/guilt score). Immutable per version, bound to an evidence snapshot hash; goes stale when evidence changes.

### 5.5 Governance objects
**Initial review** (opens a Case), **Report review** (approve/reject/request_revision/abstain, unique-and-historical per analyst per Report), **Challenge** (signed dispute with public evidence reference; pauses sealing), **Resolution** (a chosen winning Report + 7-day challenge window → sealed → archived), **Analyst profile / contributions / reputation snapshot**, **Reward pledge & payment**, **Voluntary support**, and **Proof Log event receipts**.

## 6. Governance principles

- Publication, rejection, AI-Pack approval, and resolution are **quorum outcomes**, gated by a minimum independent-analyst count and a weighted threshold, then finalized by the maintainer (normal path).
- Analyst status is earned through **two onboarding paths** (direct signed application; or a validated high-quality Report contributing to a resolved Case), producing `contributor → analyst_candidate → probationary_analyst` (probation starts at weight 0.50). Path B never auto-grants full analyst status.
- The system is designed to **keep operating without the maintainer** via a stricter weighted-quorum fallback + waiting period + emergency halt + appeal/reopen — all gated behind explicit product-owner approval.
- Every governance-relevant action is attributable and produces a versioned Proof Log event.

## 7. Payment principles

Two strictly separate money flows, with distinct statuses and events:

- **A — Pledged reward:** Case owner → winning Report author. Direct wallet-to-wallet, no custody, no escrow. Amount/recipient are fixed by Case + winning-Report state. Phantom `SystemProgram` transfer primary; Solana Pay/QR optional. **Real confirmation required**; OSI does not guarantee payment.
- **B — Voluntary support:** support a Report author or an analyst. Optional, direct, non-custodial, and **has zero influence** on review, ranking, voting power, publication, or resolution.

## 8. Privacy principles

- Pending/private Cases and Reports are never exposed through a broad public RLS policy. Owner access is via **wallet-signed ownership proof**, not by trusting a stored wallet field or a reported target wallet.
- Public process visibility (stage, counts, decision totals, attestations, challenge state, Proof Log, pledged reward) becomes available only **after** a valid initial-review approval; **private Report content stays restricted** even then.
- Restricted AI Pack content is available only to authorized Case owner / verified analysts / maintainer and still excludes secrets and highly sensitive personal information.
- No service-role key and no model API key ever enters client code.

## 9. Public language rules

Public-facing copy, memos, AI Packs, and Proof Log labels must **never** state or imply: confirmed scam/fraud/theft/criminality, legal guilt, legal certainty, guaranteed recovery, guaranteed publication, guaranteed analyst agreement, AI verification of truth, or that OSI is a legal/enforcement authority. Use neutral, source-bound language: *reported*, *alleged*, *observed on-chain*, *unverified claim*, *analyst-reviewed*, *under review*, *challengeable*. Every public record and pack carries the standing disclaimer: **informational intelligence only; not legal or financial advice; no custody; no recovery guaranteed; attribution remains challengeable.**

---

*Companion documents:* `OSI_V2_DOMAIN_MODEL.md`, `OSI_V2_STATE_MACHINES.md`, `OSI_V2_ROLE_PERMISSION_MATRIX.md`, `OSI_V2_VOTING_REPUTATION_MODEL.md`, `OSI_V2_AI_PACK_TRUST_MODEL.md`, `OSI_V2_MEMO_EVENT_SPEC.md`, `OSI_V2_UX_INFORMATION_ARCHITECTURE.md`, `OSI_V2_MIGRATION_ROLLOUT_PLAN.md`, `OSI_V2_OPEN_DECISIONS.md`.
