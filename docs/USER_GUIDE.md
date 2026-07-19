# OSI User Guide

The complete handbook for every role on Open Solana Intelligence: what you can do, how authority is earned, and how every rule is enforced.

**Live application:** https://open-solana-intel.vercel.app

> OSI is informational intelligence only. It is not legal or financial advice, holds no custody, guarantees no recovery, and never declares guilt. Every published record remains challengeable.

---

## Contents

1. [Core concepts in two minutes](#1-core-concepts-in-two-minutes)
2. [Visitors: reading the public record](#2-visitors-reading-the-public-record)
3. [Connected wallets: your first actions](#3-connected-wallets-your-first-actions)
4. [Case owners: running an investigation request](#4-case-owners-running-an-investigation-request)
5. [Report authors: contributing findings](#5-report-authors-contributing-findings)
6. [The Wire: publishing standalone intelligence](#6-the-wire-publishing-standalone-intelligence)
7. [Analysts: earning and using review authority](#7-analysts-earning-and-using-review-authority)
8. [The analyst ladder: tiers and voting weight](#8-the-analyst-ladder-tiers-and-voting-weight)
9. [On-chain credentials (SAS)](#9-on-chain-credentials-sas)
10. [The maintainer: powers, limits, and how they shrink](#10-the-maintainer-powers-limits-and-how-they-shrink)
11. [Challenges: disputing any outcome](#11-challenges-disputing-any-outcome)
12. [AI Packs: evidence-bound briefs](#12-ai-packs-evidence-bound-briefs)
13. [Money: rewards and support](#13-money-rewards-and-support)
14. [Signatures: when your wallet will ask, and when it must not](#14-signatures-when-your-wallet-will-ask-and-when-it-must-not)
15. [The Proof Log: reading evidence honestly](#15-the-proof-log-reading-evidence-honestly)
16. [What OSI will always refuse](#16-what-osi-will-always-refuse)

---

## 1. Core concepts in two minutes

**A Case** is a request to investigate a public-evidence question about Solana: a drained wallet, a suspicious cluster, a treasury movement, an impersonation campaign. Cases start private, get reviewed, open publicly, collect Reports, select a winner, survive a challenge window, and are sealed forever.

**A Report** is a signed contribution of findings attached to exactly one Case. Reports are immutable: every edit creates a new numbered version, and nothing is ever silently rewritten.

**A Wire Report** is standalone intelligence that needs no Case and no victim: publish a finding, have it independently reviewed, and it becomes part of the public record. A strong finding can later be promoted into a full Case.

**Analysts** are the reviewers. Their vote carries a weight between 0.50 and 3.00 that is earned, never bought. Critical decisions always require multiple independent analysts.

**The maintainer** is the operator of last resort with strictly bounded powers that automatically shrink as the analyst network grows.

**Everything is signed.** Individual decisions use wallet signatures verified by the server. Public outcomes are anchored to Solana mainnet with Memo transactions anyone can check on a block explorer.

---

## 2. Visitors: reading the public record

No wallet needed. You can:

- Browse public Cases in the Field Office with their full lifecycle timeline: who opened them, which Reports were published, what was decided, at what weight, and whether it was challenged.
- Read published Wire Reports and published Case Report versions, including their evidence manifests with direct Solscan links.
- See every reviewer's public identity, decision, and voting-weight snapshot on public outcomes. OSI does not anonymize public governance.
- Open the Proof Log and verify any Memo-anchored event yourself on Solana.
- View analyst public profiles: handle, expertise, tier, current weight, and contribution history.
- Verify any wallet's analyst credential directly against Solana (see section 9), without trusting OSI at all.

What you can never see: private Cases, unpublished Reports and their existence, restricted evidence, analyst private notes, or anyone's personal data. If a screen is empty, it is honestly empty; OSI never invents activity.

## 3. Connected wallets: your first actions

Connect any Solana wallet (Phantom is the primary supported flow). Connection alone identifies you; it grants no authority and costs nothing.

From day one, any connected wallet can:

| Action | What it costs |
|---|---|
| Open a Case (private by default) | One Memo transaction (network fee only) |
| Submit a Report version to an eligible public Case | One Memo transaction |
| Submit a Wire Report | One Memo transaction |
| Submit a challenge against a published outcome | One signature |
| Send voluntary support to an author or analyst | One transfer you approve |
| Apply to become an analyst | One signature |
| Read your own private material (My Cases, My Reports, My Wire Reports) | One signature per 5-minute session |

Your wallet address is your identity on OSI. It is attribution, not identity verification: OSI never claims to know who is behind a wallet.

## 4. Case owners: running an investigation request

**Opening.** Fill the Case form in the Field Office: a category, a neutral title, a public-safe summary, and a restricted detail section for sensitive specifics. Structured evidence references (wallets, transactions, HTTPS sources) are validated at intake. You may attach an optional, non-binding reward intent. Signing the CASE_SUBMITTED Memo creates the Case, private by default.

**While private.** Only you, eligible analysts, and the maintainer can see it. You can read your own Case any time through My Cases with a single 5-minute session signature.

**Opening to the public** requires an approval you cannot give yourself: either one eligible analyst with weight at or above 0.50, or the double-authenticated maintainer, records approve_open, and the approver anchors the CASE_OPENED Memo. Opening a Case never means the claim is true; it means the question deserves public investigation.

**What you control after opening:**

- The public-safe versus restricted split of your material.
- Your reward pledge: revise or withdraw it freely before opening, only increase it after opening. Sealing freezes it.
- Advisory feedback on AI Packs for your Case (recorded, shown, never counted as a vote).

**What you can never do:** approve your own Case, read another author's unpublished Report on your Case, cast counted analyst votes on your own material, or influence which Report wins. Ownership grants zero governance authority.

**Paying the reward.** After sealing, the exact winning author becomes payable. You pay directly from your wallet, in one or more transfers; each is verified as finalized on mainnet before OSI labels anything paid. The confirmed total can never exceed your frozen pledge. OSI never touches the funds.

## 5. Report authors: contributing findings

Any connected wallet can author a Report on a public Case that is accepting submissions.

- One Report header per wallet per Case; every submission or revision appends an immutable numbered version under it.
- Each version binds an ordered evidence manifest (wallet addresses, Solana transactions, HTTPS sources) whose hash you sign before submission. The server verifies your WIRE-style Memo before anything is stored.
- Unpublished versions are private to you, eligible analysts, and the maintainer. Their existence is not even visible publicly.
- Publication is never yours to decide: it requires at least 2 independent analysts with combined weight at or above 2.00 (3 and 4.00 for high-risk Cases), finalized by a REPORT_PUBLISHED Memo. You can never review your own version; the database itself rejects it.
- Published versions are permanent. A correction is a new version; the record of what you published earlier never disappears.

If your version is selected as a Case's winning Report, two things happen: you become the payable reward recipient after sealing, and your wallet automatically becomes an analyst candidate (see section 8, Path B).

## 6. The Wire: publishing standalone intelligence

The Wire is for findings that need no victim and no existing Case: cluster analyses, fund-flow tracing, treasury research, on-chain verification of public claims, educational post-mortems of known incidents.

The flow mirrors Case Reports:

1. Submit your finding with a public-safe title and summary, full analysis, and a validated evidence manifest. Sign the WIRE_REPORT_VERSION_SUBMITTED Memo. The submission is private.
2. Revisions append immutable versions; history is permanent.
3. Independent analysts review the exact version. You cannot review your own.
4. Publication requires at least 2 independent analysts with combined weight at or above 2.00, anchored by a WIRE_REPORT_PUBLISHED Memo. No maintainer signature is required on the normal path.
5. Published findings appear in The Wire and Public Records with full attribution, and can receive voluntary support.
6. Any published Wire Report can be challenged (section 11), and an eligible analyst or the maintainer can promote it into a full Case with a WIRE_PROMOTED Memo. Promotion creates a normal Case that follows every normal Case rule; the original Wire Report is preserved and cross-referenced. Rewards exist only on Cases, never on the Wire itself.

## 7. Analysts: earning and using review authority

Analysts are the human backbone of OSI. An eligible analyst can:

- Cast initial reviews that open Cases to the public.
- Review exact Report and Wire Report versions: approve, reject, request revision, or abstain.
- Form publication quorums.
- Review resolution selections that pick a Case's winning Report.
- Judge challenge admissibility and merit.
- Approve seals and AI Packs.
- Build a public, portable, wallet-linked track record of every decision they made.

Every counted review is wallet-signed and server-verified, targets one exact immutable version, and lands in an append-only history: changing your mind creates a new record and preserves the old one. Conflict rules are absolute and database-enforced: you never review your own work, your own Case, or any target where you hold a stake the role matrix excludes.

**Becoming an analyst has two doors:**

**Path A, application.** Submit a wallet-signed application with your handle, expertise, and optional restricted detail. Applications are immutable and versioned like everything else. Review happens in process; the applicant can never approve or activate themselves. Approval never grants a chosen tier: activation is anchored by an ANALYST_PROBATION Memo and always starts at probationary tier with weight exactly 0.50.

**Path B, contribution.** When your Report version is selected as a Case's winner through real quorum, your wallet is automatically promoted from contributor to analyst candidate. Candidacy is a door, not a badge: full activation still goes through the same reviewed application gate as Path A.

## 8. The analyst ladder: tiers and voting weight

Voting weight is bounded to the range 0.50 to 3.00 and is derived entirely from documented, server-computed thresholds. Nobody, including the maintainer, can hand out weight by preference.

| Tier | Entry condition | Weight |
|---|---|---|
| Probationary | Activated after review, ANALYST_PROBATION Memo | 0.50 |
| Analyst I | At least 3 accepted contributions, 0 reversals in the last 5 | 1.00 |
| Analyst II | At least 8 accepted, at least 1 winning Report, reversal rate under 10% | 1.50 |
| Senior | At least 20 accepted, at least 3 winning, reversal rate under 5%, 90 days tenure | 2.25 |
| Distinguished | At least 40 accepted, at least 6 winning, reversal rate under 5% | 3.00 |

What moves you up: accepted contributions, winning Reports, and a clean record of decisions that survive challenges. What moves you down: a reversal (a decision of yours overturned through the challenge process) or a policy violation drops you one tier, with probationary as the floor. Long inactivity decays your standing gradually toward the floor, never below it.

Three guarantees hold at every tier:

1. **Count beats weight.** Critical outcomes need at least 2 independent analysts. Since maximum weight is 3.00 and thresholds are set above it where it matters, one analyst can never decide alone.
2. **Money buys nothing.** Support, donations, and payments have zero effect on weight, tier, ranking, review priority, or eligibility. This is enforced, not promised.
3. **Raw volume is not power.** Weight follows quality-adjusted history, not case count.

## 9. On-chain credentials (SAS)

Every active analyst holds an OSI_VERIFIED_ANALYST attestation on Solana mainnet, issued through the Solana Attestation Service the moment their tier is granted and revoked or superseded the moment it is lost. The credential stores only integer tier and status codes: no names, no personal data, no case content.

Because the credential lives on chain, anyone can verify a wallet's analyst status without asking OSI:

- Check the wallet's attestation under OSI's exact Credential and Schema (addresses are listed in the README) on any explorer.
- Or call the public verifier endpoint, which performs a live on-chain check and answers honestly for any wallet, with no authentication required.

OSI's own database is treated as a cache. Solana is the source of truth. In a future phase, credential enforcement will make an on-chain credential a hard requirement for counted reviews; the system already records verification state on every review in preparation.

## 10. The maintainer: powers, limits, and how they shrink

The maintainer is the operator of last resort, not an authority over truth. Understanding what the maintainer can and cannot do is the heart of trusting OSI.

**Double gate, always.** Every maintainer action requires both the configured admin wallet signature and an authenticated operator login. Either alone is refused. There is no single-key backdoor.

**What the maintainer can always do:**

- Open a Case as the alternative to analyst initial review (recorded at analyst weight zero: it is an operator act, never an analyst vote).
- Review analyst applications and anchor activations (again at governance weight zero).
- Finalize outcomes that already earned their analyst quorum: the server-computed winning Report, the seal after a clean challenge window, an AI Pack that analysts already approved. Finalization executes a result; it cannot invent one.
- Apply safety blocks on prohibited content, which are explicitly labeled as moderation and never presented as a factual verdict.

**What the maintainer can never do, at any network size:**

- Cast counted analyst votes or add analyst weight to any quorum.
- Choose a winning Report that the analyst tally did not produce.
- Judge challenges. Challenge admissibility and merit are always independent analyst decisions, because challenges exist to check the maintainer too.
- Approve an AI Pack without its analyst quorum.
- Assign tiers or weight by preference, edit history, or touch user funds.

**Bootstrap mode and how maintainer power decays.** A young network has too few analysts to reach quorum, so a transparent cold-start mode exists. While active, the maintainer may advance three outcome types (Report publication, Wire publication, winner selection, and sealing) without full analyst quorum. Two safeguards make this honest:

1. Every bootstrap decision is permanently recorded on a distinct maintainer_bootstrap channel, visible in the Proof Log and on every public surface. It is never displayed as analyst consensus.
2. The mode dismantles itself in code, based on a live count of activated analysts:

| Eligible analysts | What the maintainer needs for those outcomes |
|---|---|
| Fewer than 20 | May act alone (double-gated, labeled bootstrap) |
| 20 to 29 | Must be joined by at least 1 independent analyst |
| 30 to 49 | Must be joined by at least 2 independent analysts |
| 50 or more | Bootstrap retires; full analyst thresholds apply, no substitution |

There is no way to hold power at scale: the thresholds are computed live from the database at the moment of each decision, not from a setting anyone can forget to change. A maintainer can also never bootstrap-advance material they authored themselves.

## 11. Challenges: disputing any outcome

Any connected wallet can challenge a public outcome: a Case, a published Report version, a published Wire version, an AI Pack version, or a resolution. You need no rank and no permission; you need evidence.

- A challenge targets exactly one thing and must reference a real evidence item. Rate limits, one active challenge per wallet per target, and a cooldown keep it spam-resistant.
- Submission alone pauses nothing. A challenge first passes an admissibility review; only an admitted, open challenge pauses sealing.
- Merit is decided by at least 2 independent analysts with combined weight at or above 2.50. The challenger, the Case owner, and the affected author are all excluded from judging it. The maintainer never judges challenges, in any mode.
- An accepted challenge never erases history: the old outcome stays on record, the Case reopens, and a new selection cycle begins.
- A rejected or expired challenge carries no automatic penalty. Bad faith is a separate, explicitly reviewed finding, never an assumption.
- Deadlines are enforced: a challenge that stalls expires by timeout and releases anything it was blocking. Nothing can be held hostage.

## 12. AI Packs: evidence-bound briefs

An AI Pack is a structured brief generated by a language model from server-approved Case evidence, built for handing a coherent picture to an exchange, a compliance desk, or a newcomer to the Case.

What keeps it honest:

- **It is an artifact, not a verdict.** OSI never displays an accuracy percentage, a truth probability, or a guilt score. Instead, every Pack carries an Evidence Confidence Profile with transparent components: public verifiability, on-chain reproducibility, evidence coverage, source consistency, and analyst attestation.
- **Three layers, separately sealed.** Each version has a public-safe brief, an owner-safe layer, and an analyst-restricted layer. Each layer draws only from evidence at its permitted scope and carries its own manifest hash. You see exactly the layer your role allows, never more.
- **Immutable and staleness-aware.** Versions are permanent. When underlying evidence changes, the affected layers are marked stale rather than silently regenerated.
- **Generation is controlled.** Verified analysts and the maintainer can generate drafts, under strict rate limits, daily quotas, and cost caps. The AI provider key exists only on the server.
- **Approval is analyst-only.** Public release requires at least 2 independent analysts with combined weight at or above 2.50 plus maintainer finalization, and the Pack's creator is always excluded. This is one of the two decisions (with challenges) that bootstrap mode can never touch.
- **The owner speaks, but does not vote.** Case owner feedback on a Pack is recorded and displayed as advisory, with zero weight.

## 13. Money: rewards and support

Two flows exist, and they never mix with governance.

**Pledged rewards** belong to Cases. The owner pledges, the pledge freezes at sealing, and only the exact winning author is payable, directly wallet to wallet. Partial payments are fine; exceeding the frozen pledge is impossible. Every payment is labeled confirmed only after the server verifies the finalized mainnet transaction: exact payer, exact recipient, exact lamports, canonical memo, replay-bound.

**Voluntary support** is a thank-you anyone can send to a published author or an active analyst: direct transfer, up to 4 distinct recipients in one transaction, self-support rejected. Support changes nothing: not ranking, not weight, not priority, not reputation. OSI displays it as generosity, never as influence.

OSI holds no balances, runs no escrow, takes no commission, and can never move your funds. Every transfer is a transaction you personally approve in your wallet.

## 14. Signatures: when your wallet will ask, and when it must not

OSI treats your signature as sacred. The exact contract:

| Situation | Wallet prompts |
|---|---|
| Connecting on a trusted site revisit | 0 (silent restore) |
| First private read (My Cases, My Reports, review queue) | 1 signature, valid 5 minutes for all private reads |
| Navigating between private screens within the session | 0 |
| Reload with a valid session | 0 |
| Each governance write (review, application, challenge) | Exactly 1 signature |
| Each public anchor (Case submit, Report submit, publication, seal) | Exactly 1 transaction approval |
| Each SOL transfer (reward, support) | Exactly 1 transaction approval |

Two things are never legitimate: a prompt that appears when the table says 0, and anything asking for your seed phrase or private key, which OSI will never do, anywhere, for any reason. Cancelling any prompt is always safe: nothing is written, and retrying is clean.

If your private-read session expires (5 minutes), the next private screen asks for one fresh signature. That is the designed behavior, not a bug.

## 15. The Proof Log: reading evidence honestly

Every receipt in the Proof Log carries exactly one of four labels, and the distinction is never blurred:

| Label | Meaning | Verifiable where |
|---|---|---|
| Memo-anchored on Solana | A confirmed mainnet transaction with the canonical OSI2 memo | Any block explorer, forever |
| Wallet-signed, server-verified | An Ed25519 message signature checked by the server | OSI's records; explicitly not on-chain |
| System event | A server-generated transition | OSI's records |
| Legacy import, not server-verified | Historical V1 data | Marked so you never mistake it for native proof |

Public outcomes additionally show the decision channel: a normal analyst quorum or a labeled maintainer bootstrap decision. The Proof Log records process and provenance. It is never a factual, legal, or guilt verdict.

## 16. What OSI will always refuse

At intake and at every layer beneath it, OSI rejects:

- Seed phrases, private keys, or requests to obtain them.
- Doxxing and investigation of private individuals' non-public data.
- Harassment, stalking, or targeting.
- Illegally obtained access or material.
- Fabricated transactions, wallets, analysts, metrics, or reviews.
- Any framing of OSI output as legal certainty, guaranteed recovery, or established guilt.

A safety block is moderation, clearly labeled as such, and is never presented as a factual finding about your claim.

---

*This guide describes enforced behavior, not aspirations. Every rule above is backed by a database constraint, a server-side check, or an on-chain record, and the source is open: read the constitution in docs/OSI_V2_PRODUCT_CONSTITUTION.md and the decision register in docs/OSI_V2_OPEN_DECISIONS.md to see exactly why each rule exists.*
