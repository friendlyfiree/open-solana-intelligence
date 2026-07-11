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

**Wire Reports — the explicit standalone exception to the Case-centered lane.** OSI is Case-centered (P1), with **one deliberate exception:** a **Wire Report** is a standalone, report-first intelligence publication that does **not** require an existing Case (§5.3). It has no owner-investigation, hosts no reward, and lives in a separate publication lane (The Wire). Everything else — evidence, reviews, AI Packs, challenges, rewards, resolution, seal — remains attached to a Case. A Wire Report may later be *promoted* into a new Case, at which point the Case-centered rules apply to that Case.

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

A **safety block** (a moderation/policy refusal of prohibited content) is **never** the same event as a **normal initial-review rejection** (a factual "not enough here to open" quorum outcome). A safety block requires no factual analyst quorum, produces a neutral private notice, and must never be presented as a factual review verdict; a normal rejection is a quorum outcome and is appealable. The two are separate states and separate memo events throughout the design (`OSI_V2_STATE_MACHINES.md §1`).

## 4. Immutable product principles

These principles are constitutional. Changing any of them is a governance decision recorded in `OSI_V2_OPEN_DECISIONS.md`, never a silent code change.

- **P1 — Case is the primary entity, with one standalone exception.** Everything (Case Reports, evidence, reviews, AI Packs, challenges, rewards, resolution, seal) hangs off a Case. A bounty is *not* a core entity; it is an optional reward pledge attached to a Case. **The single deliberate exception is the Wire Report** (§2, §5.3): a standalone, report-first publication that requires no Case and hosts no reward, in its own lane.
- **P2 — Private by default.** A newly signed Case/Report is private and readable only by its owner (via a proof-bound path), verified analysts, and the maintainer, until an explicit initial-review approval opens it.
- **P3 — No self-decisive authority.** No actor may be the sole authority for publication, rejection, AI-Pack approval, or resolution — of their own contribution or in general. Critical outcomes require **≥ 2 independent analyst wallets**.
- **P4 — Quality-adjusted, bounded reputation.** Analyst voting power is derived from *quality-adjusted* history and is mathematically bounded to **[0.50, 3.00]**. Weight can never let one analyst finalize a critical outcome alone.
- **P5 — Maintainer is a finalizer only where the locked thresholds require it, never the truth.** Per the locked thresholds (D5, `OSI_V2_VOTING_REPUTATION_MODEL.md §5`), a maintainer signature is an **explicit requirement for exactly three outcomes: resolution / winning-Report selection, AI-Pack approval, and seal.** The other quorum outcomes — Case initial open/rejection, Case Report and Wire Report publication/rejection, and challenge accept/reject — finalize on the **two-gate analyst quorum alone** (≥N_min independent analysts *and* Σweight ≥ W_thr); **no maintainer gate is added to them.** The maintainer never invents or overrides a quorum result; a stricter no-maintainer fallback for the three maintainer-gated outcomes is designed but gated behind product-owner approval (D3).
- **P6 — Process, not verdict.** The Proof Log records *actions and provenance*. It is not a legal or factual verdict. Public copy must never imply otherwise. The Proof Log labels each receipt by its **honest proof type** — Memo-anchored on Solana, wallet-signed and server-verified, system-generated, or legacy-imported-not-server-verified — and **never** presents a wallet-signed receipt as an on-chain transaction (hybrid signature model, D15).
- **P7 — Non-custodial payments.** Rewards and voluntary support are always direct wallet-to-wallet, confirmed on-chain, never escrowed. Support never influences review, ranking, weight, publication, or resolution.
- **P8 — Evidence-bound AI.** AI Packs summarize *only* server-approved Case evidence. Generation is never a truth decision, never auto-approves, never auto-publishes. Full/restricted content is authorized-only; the public sees minimized metadata and a public-safe brief.
- **P9 — Minimal, privacy-preserving memos.** On-chain memos carry only minimal references (versioned type + target ref + actor + role + ts + hashes). Never narrative, allegation, personal data, private evidence, keys, or analyst notes.
- **P10 — Server-enforced authorization.** Every privileged action names a **server-side** enforcement point (Edge Function auth and/or RLS). Client checks are UX only.

## 5. Core definitions

### 5.1 Case
The first-class unit of work. A signed, initially-private request to investigate a public-evidence question, with a category (from §2 scope), a public-safe title/summary, an owner, a lifecycle stage, an optional reward pledge, and a collection of Reports, evidence, reviews, AI Packs, challenges, and (eventually) a resolution and seal. **Bounty = optional reward pledge on a Case, not a separate entity.**

### 5.2 Report (Case Report)
A signed contribution of findings that **belongs to exactly one Case**. Authored by the Case owner, an ordinary wallet, a researcher, or an analyst. **Case Report privacy:** a Case Report version is **private** (author + verified analysts + maintainer only, via proof-bound access) until an analyst-quorum publication makes that exact version public; unpublished versions never leak. A Report author may **never** review their own Report, and the Case owner may never create a decisive self-review path. One Report version may be chosen as the Case's **winning / resolution Report**; it remains an immutable contribution record forever.

### 5.3 Wire Report
A standalone signed intelligence publication that does **not** require an existing Case (e.g., a wallet-cluster finding, treasury map, token-distribution analysis, public-claim verification) — the explicit standalone exception to the Case-centered lane (§2, P1). The Wire is a separate publication lane from Field Office; it **hosts no bounties**. **Wire Report privacy** mirrors Case Report privacy: a Wire Report version is private until an analyst-quorum publication makes that exact version public. A Wire author cannot approve their own Wire Report; publication requires independent weighted review. A Wire Report may later be **promoted** into a new Case as source evidence.

### 5.4 AI Pack
A versioned, evidence-bound intelligence brief generated from server-approved Case evidence. It has **exactly three access/content layers:** a **public-safe brief** (`content_public_brief`, public evidence only), an **owner-safe** layer (`content_owner_safe`, for the proven Case owner), and an **analyst-restricted** layer (`content_analyst_restricted`, verified analysts/maintainer only — still excludes secrets, keys, illegal-access material, and highly sensitive personal data). Carries an **Evidence Confidence Profile** (transparent components — *not* an accuracy/probability/guilt score). Provenance is an **immutable per-layer evidence manifest** (`ai_pack_version_evidence`) with **three manifest hashes** (public / owner-safe / analyst-restricted) — **not a single generic evidence snapshot hash**; each layer draws only from evidence at its permitted scope and goes stale per layer when that layer's evidence changes.

### 5.5 Governance objects
**Initial review** (opens a Case), **Report review** (approve/reject/request_revision/abstain, unique-and-historical per analyst per exact Report version), **Challenge** (signed dispute referencing an `evidence_items` row against exactly one typed target; **submission alone does not pause sealing** — only a challenge that has passed admissibility into `open`/`under_review` pauses it), **Resolution** (analysts select a candidate winning Report version → maintainer finalizes → 7-day challenge window → sealed → archived), **Analyst profile / contributions / reputation snapshot**, **Reward pledge & payment**, **Voluntary support**, and **Proof Log event receipts**.

## 6. Governance principles

- Publication, rejection, AI-Pack approval, resolution, challenge accept/reject, and seal are **two-gate quorum outcomes**, each gated by a minimum independent-analyst count **and** a weighted threshold (D5). A **maintainer signature is additionally required for exactly three of them — resolution / winning-Report selection, AI-Pack approval, and seal** — and for nothing else; Case Report / Wire Report publication and rejection, Case initial open/rejection, and challenge accept/reject finalize on the analyst two-gate alone. The maintainer never overrides or invents a quorum result.
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
- For a **public** governance decision, analyst participation is **publicly attributed**: the public view shows each participating analyst's public profile/handle, wallet, decision, voting-weight snapshot, timestamp, and proof type, with a public-safe receipt/tx reference. Private notes, private evidence, detailed moderation reasons, and sensitive reason text stay restricted; pre-open/private-queue activity may show only counts (D16). OSI does not describe normal public decisions as "anonymized."
- Restricted AI Pack content is available only to authorized Case owner / verified analysts / maintainer and still excludes secrets and highly sensitive personal information.
- No service-role key and no model API key ever enters client code.

## 9. Public language rules

Public-facing copy, memos, AI Packs, and Proof Log labels must **never** state or imply: confirmed scam/fraud/theft/criminality, legal guilt, legal certainty, guaranteed recovery, guaranteed publication, guaranteed analyst agreement, AI verification of truth, or that OSI is a legal/enforcement authority. Use neutral, source-bound language: *reported*, *alleged*, *observed on-chain*, *unverified claim*, *analyst-reviewed*, *under review*, *challengeable*. Every public record and pack carries the standing disclaimer: **informational intelligence only; not legal or financial advice; no custody; no recovery guaranteed; attribution remains challengeable.**

---

*Companion documents:* `OSI_V2_DOMAIN_MODEL.md`, `OSI_V2_STATE_MACHINES.md`, `OSI_V2_ROLE_PERMISSION_MATRIX.md`, `OSI_V2_VOTING_REPUTATION_MODEL.md`, `OSI_V2_AI_PACK_TRUST_MODEL.md`, `OSI_V2_MEMO_EVENT_SPEC.md`, `OSI_V2_UX_INFORMATION_ARCHITECTURE.md`, `OSI_V2_MIGRATION_ROLLOUT_PLAN.md`, `OSI_V2_OPEN_DECISIONS.md`.
