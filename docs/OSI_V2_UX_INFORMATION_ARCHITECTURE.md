# OSI V2 — UX & Information Architecture

**Status:** Blueprint / design-only. No `index.html`/CSS/JS is changed. This defines the target page structure, replacing the current terminology tangle (Field Office "case" = bounty; Public Records "case" = report) with a single Case-centered model.

Navigation (V2): **Home · Field Office · The Wire · Public Records · Analysts · Proof Log · My OSI** (+ maintainer lock icon → Operations Center).

Global state conventions for every surface: **empty** (neutral "nothing here yet" + primary CTA), **loading** (skeleton, no fake data), **error** (neutral message, retry, never raw DB/SQL/token text), **unauthorized** (explains how to gain access, never a silent hide for owner/analyst paths).

---

## 1. Home
- **Audience:** everyone. **Purpose:** explain the product + start the right journey.
- Hierarchy: hero (one-sentence value) → primary CTA "File a report" / secondary "Open an investigation" + "Join as analyst" → 4-step "How it works" → role explainer → AI Pack explainer → Proof Log explainer → Public Records preview → disclaimer.
- Actions: CTAs route to Field Office/Wire/Analysts. "View Live Console" = demo tour (gated `OSI_DEMO_MODE`).
- States: static; Public Records preview loads real approved cases (empty→"no public cases yet").

## 2. Field Office (Case-centered investigation surface)
- **Audience:** everyone (public cases); owners/analysts (own private). **Purpose:** browse and open Cases.
- Tabs/filters: `Open investigations` · `In review` · `Resolved` · `Sealed` · `Mine` · category filter · search.
- Primary action: **"Open a Case"** (question/investigation; optional reward pledge). Card shows: public_ref, title, category, stage badge, report count, analyst-decision totals, challenge state, optional reward chip, "View Case."
- Role/state visibility: private cases never listed publicly; owner sees own via "Mine" (owner-proof). Reward is a chip, not the headline.
- Empty: "No open investigations. Open the first Case." Loading: card skeletons. Error: retry.
- **Fixes:** "case" now means Case (not bounty); reward is optional and secondary.

## 3. Case Detail (the heart of V2)
- **Audience:** public (open+ cases) with restricted tabs for owner/analyst/maintainer.
- Header: public_ref, title, category, stage, risk tier, challenge banner if paused, disclaimer.
- **Exact tabs:**
  1. **Overview** — public-safe summary, stage timeline, key dates (opened, resolution proposed, challenge deadline, sealed), reward chip, participant counts.
  2. **Evidence** — public evidence list (links, tx, wallets labeled *reported/unverified*); restricted evidence gated.
  3. **Reports** — list of Case Reports with status; published bodies public; pending visible only to author(proof)/analyst/maintainer; "Submit a Report" (any wallet), authors excluded from reviewing own.
  4. **AI Pack** — pack state, public-safe brief (if approved), Evidence Confidence *profile*, generate/attest/approve controls per role (see AI Pack Trust Model §10), "stale" badge, download (restricted gated).
  5. **Votes** — analyst decision **totals** + public attestations (no private reason codes); quorum progress meter; two-gate status.
  6. **Challenges** — open/under_review/resolved list; "Open a challenge" (signed, reason + evidence_ref); pause indicator.
  7. **Reward** — pledge amount/status, winning report + author, resolution date, challenge deadline, payment status; "Send reward" (owner→winner, confirmed tx); never shows "paid" pre-confirmation.
  8. **Proof Log** — this Case's event receipts (minimal refs), on-chain vs signed labels honest.
- States: unauthorized users see public tabs; owner/analyst see restricted content with clear "why you can see this."

## 4. The Wire (standalone intelligence lane)
- **Audience:** everyone. **Purpose:** publish/browse standalone findings **without** a Case. **No bounties.**
- Actions: "Publish a Wire Report" (finding-first). Card: title, author, review state, support chip. Filters: category, newest, most-supported.
- Distinct from Field Office: Wire = *report-first*; Field Office = *question-first*. A published Wire Report offers "Promote to Case" (analyst/maintainer).
- **Fixes:** removes Field Office/Wire overlap by giving each a clear starting object.

## 5. Wire Report Detail
- Tabs: Overview · Evidence · Reviews (totals) · Challenges · Support · Proof Log. "Support author" (voluntary, non-influencing). Author cannot review own.

## 6. Public Records
- **Audience:** everyone. **Purpose:** the archive of published/resolved/sealed public outcomes (Cases + published Wire Reports).
- Card: public_ref, title, category, status (Reviewed/Resolved/Sealed — vocabulary aligned to states), analyst review summary, challenge state, AI Pack availability (metadata), "Open record."
- **Fixes:** "case record" now maps to a real Case, with visible review context (who reviewed, challenge state) — closes the current "no investigation context" gap.

## 7. Analysts
- **Audience:** everyone (roster); analysts (Review Floor). Tabs: **Roster** (verified analysts, tier, contribution stats) · **Review Floor** (analyst-gated: pending Cases/Reports/Wire/Challenges/Packs to review) · **Apply** (Path A) · **Path B status** (contributor→candidate progress).
- Review Floor: clear locked state for non-analysts with "Apply" path; each item shows two-gate progress and the self-review exclusion.

## 8. Analyst Profile
- Identity, tier, weight (bounded), contribution ledger (accepted/winning/reversals — transparent), attestation history, support-received. No fake metrics.

## 9. Proof Log
- **Audience:** everyone. Unified timeline over `event_receipts` (OSI1/legacy/OSI2). Filters by event type/target. Honest labels: "Memo-anchored on Solana" only with a real `tx_sig`; "wallet-signed" / "system event" otherwise; standing "provenance, not verdict" note. No hardcoded "confirmed."

## 10. My OSI (owner/author dashboard — closes the "where did my submission go?" gap)
- **Audience:** connected wallet (owner-proof). **Exact sections:**
  - **My Cases** — my opened Cases + private stage/status (owner-proof path).
  - **My Reports** — my Case Reports + review status + winning flag.
  - **My Wire Reports** — my Wire Reports + review status.
  - **My AI Packs** — packs I generated + state/version/stale.
  - **My Votes** — my analyst decisions (if analyst) with history.
  - **My Challenges** — challenges I opened + state.
  - **Rewards & Payments** — pledges I made/owe, payment status; rewards I'm owed as a winner.
  - **Support Received** — voluntary support to me as author/analyst.
- States: each section has empty/loading/error; private data only via fresh signature proof.

## 11. Maintainer Operations Center
- **Audience:** maintainer (double-gate). Sections: pending initial reviews, quorum-ready finalizations, analyst verification queue, AI Pack approvals, challenge adjudications, resolution/seal actions, config, emergency halt, fallback-governance dashboard.
- **Every action is a real signed mutation** (no disabled placeholders): approve/verify/finalize/seal wired to the signed Edge paths. Fixes the current "Requires hardened backend" dead buttons.

## 12. Mobile considerations
- Bottom-tab nav for the 7 primary sections; Case Detail tabs become a horizontally-scrollable tab bar; drawers full-screen; sticky primary CTA; challenge/pause banners always visible; overlays always closable (Escape + tap-out + explicit ✕); no fixed layer traps.

## 13. Terminology contract (single source, applied everywhere)
- **Case** = an investigation (question-first, Field Office). **Report** = a contribution to a Case. **Wire Report** = standalone finding (report-first, The Wire). **Public Record** = a published Case or Wire Report. **Reward** = optional pledge on a Case. **Seal** = a Case's final immutable resolution. The word "bounty" is retired from the UI as a top-level noun (survives only as "reward pledge").
