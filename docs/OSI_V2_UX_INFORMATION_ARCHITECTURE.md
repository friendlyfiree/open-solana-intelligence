# OSI V2 — UX & Information Architecture

**Status:** Blueprint / design-only. No `index.html`/CSS/JS is changed. Every button maps to a **real modeled action** (state-machine transition + server enforcement). **No disabled placeholder may be presented as functional; a disabled button states its exact unmet prerequisite.** No support-based ranking anywhere (correction #15).

Navigation: **Home · Field Office · The Wire · Public Records · Analysts · Proof Log · My OSI** (+ maintainer lock icon → Operations Center).

Global states per surface: **empty** (neutral + primary CTA), **loading** (skeleton, no fake data), **error** (neutral, retry, never raw DB/SQL/token), **unauthorized** (explains how to gain access).

---

## 1. Home
Hero (one-sentence value) → primary CTA "File a report" / secondary "Open an investigation" + "Join as analyst" → 4-step "How it works" → role explainer → AI Pack explainer → Proof Log explainer (four honest proof types) → Public Records preview → disclaimer. "View Live Console" = demo tour (`OSI_DEMO_MODE`).

## 2. Field Office (Case-centered)
Filters: `Open investigations` · `In review` · `Resolved` · `Sealed` · `Mine` · category · search (**no most-supported/most-backed sort**). Card: public_ref, title, category, stage badge, report count, analyst-decision totals, challenge state, optional reward chip, "View Case." Private cases never listed publicly; owner sees own via "Mine" (owner-proof).

## 3. Case Detail — tabs: Overview · Evidence · Reports · AI Pack · Votes · Challenges · Reward · Proof Log

**Per-action button/state rules (each → modeled transition):**

| Button | Where | Role/state gate | Modeled action | Disabled-state message example |
|---|---|---|---|---|
| **Open a Case** | Field Office | connected wallet | Case submit → `CASE_SUBMITTED` | "Connect a wallet to open a Case" |
| **Add evidence** | Evidence tab | owner/analyst on open case | insert `evidence_items` + link | "Case must be open to add evidence" |
| **Submit Report** | Reports tab | connected wallet, case open | new `case_report_versions` v1 → `REPORT_SUBMITTED` | "Case not open yet" |
| **Submit Report revision** | Reports tab | report author, version in `revision_requested` | new version (`supersedes_version_id`) | "Only the author can revise; no revision requested" |
| **Review this version** | Reports tab | analyst, **not author** | `case_report_reviews` cast → Sig | "Authors can't review their own report" / "Verified analysts only" |
| **Propose resolution candidate** | Reports/Votes | analyst quorum context | `resolution_reviews` select | "Needs published report versions" |
| **Review resolution candidate** | Votes tab | analyst, not author/owner | `resolution_reviews` cast | "Owner/author excluded" |
| **Finalize winning Report** | Votes/maintainer | maintainer after quorum | `REPORT_SELECTED_WINNING` (exact version) | "Approve — needs 1 more independent analyst" |
| **Submit challenge** | Challenges tab | connected wallet | `challenges` submit → `CHALLENGE_SUBMITTED` | "One active challenge per target; cooldown active" |
| **Challenge pending admissibility** | Challenges tab | (display) | shows `submitted`/`admissibility_review` — **not yet pausing sealing** | — |
| **Review challenge** | Challenges tab | analyst | admissibility accept / `challenge_reviews` cast | "Verified analysts only" |
| **Generate AI Pack** | AI Pack tab | owner/analyst/maintainer, case has approved evidence | `osi-ai-pack generate` → `PACK_SUBMITTED` | "Needs approved case evidence" |
| **Submit Pack revision** | AI Pack tab | version creator, `revision_requested` | new `ai_pack_versions` | "Only the creator can resubmit" |
| **Review Pack version** | AI Pack tab | analyst, **not creator** | `ai_pack_reviews` cast → Sig | "Creators can't review their own pack" |
| **Approve Pack after quorum** | AI Pack tab | maintainer, ≥2 independent (creator excluded) | `AI_PACK_APPROVED` | "Approve — needs 1 more independent analyst" |
| **Send pledged reward** | Reward tab | case owner, winner assigned | `reward_payments` confirmed tx → `REWARD_PAID` | "No winner assigned yet" |
| **Support Report Author** | Reports/Overview | any wallet | `support_events` (author) → `SUPPORT_SENT` | "Connect a wallet" |
| **Support Analyst** | Analyst profile | any wallet | `support_events` (analyst) | "Connect a wallet" |

Tab contents: **Overview** (public summary, stage timeline, key dates, reward chip, counts) · **Evidence** (public evidence; restricted gated; reported wallets labeled *reported/unverified*) · **Reports** (versions with status; published bodies public; pending gated; reviews target exact version) · **AI Pack** (per AI Pack Trust Model §9) · **Votes** (decision totals + **public analyst attribution** — handle, wallet, decision, weight snapshot, timestamp, proof type; quorum two-gate meter) · **Challenges** (admissibility state, pause indicator, open challenge form) · **Reward** (pledge/status, winning version + author, resolution date, challenge deadline, payment status; never "paid" pre-confirmation) · **Proof Log** (this Case's receipts with honest proof-type labels).

## 4. The Wire (report-first, no rewards)
"Publish a Wire Report" (finding-first). Card: title, author, review state, support chip (display only). Filters: category, newest (**no most-supported sort**). Published Wire Report → "Promote to Case" (analyst/maintainer). Author cannot review own.

## 5. Wire Report Detail
Tabs: Overview · Evidence · Reviews (totals + public attribution) · Challenges · Support · Proof Log. "Support author" (voluntary, non-influencing). Evidence is first-class (`wire_report_version_evidence`).

## 6. Public Records
Archive of published/resolved/sealed public outcomes (Cases + published Wire Reports). Card: public_ref, title, category, status (Reviewed/Resolved/Sealed), analyst review summary + **public attribution**, challenge state, AI Pack availability (metadata), "Open record." No support-based ordering.

## 7. Analysts
Tabs: **Roster** (verified analysts, tier, contribution stats) · **Review Floor** (analyst-gated: pending Cases/Report versions/Wire versions/Challenges/Packs; each shows two-gate progress + self-review exclusion) · **Apply** (Path A → `analyst_applications`) · **Path B status** (contributor→candidate progress). Locked state for non-analysts links to Apply.

## 8. Analyst Profile
Identity, tier, bounded weight, contribution ledger (accepted/winning/reversals — transparent, server-derived), attestation history, support-received (display only, no influence). No fake metrics.

## 9. Proof Log
Unified timeline over `event_receipts` (OSI1/legacy/OSI2). Honest proof-type labels: **Memo-anchored on Solana** (real tx), **Wallet-signed & server-verified** (signMessage receipt), **System event**, **Legacy / not server-verified**. Filters by event type/target/proof type. Standing "provenance, not verdict" note. No hardcoded "confirmed."

## 10. My OSI (owner/author dashboard, owner-proof) — exact-version status
Sections: **My Cases** · **My Case Reports** (with exact version + review status + winning flag) · **My Wire Reports** (with version + review status) · **My AI Packs** (version/lifecycle/stale) · **My Challenges** (state) · **My analyst applications** (status/revisions) · **Rewards & Payments** (pledges made/owed; rewards owed as winner; payment status) · **Support Received** (voluntary, display only). Private data only via fresh signature proof.

## 11. Maintainer Operations Center
Sections: pending initial reviews, safety-block queue, quorum-ready finalizations, analyst application/verification queue, AI Pack approvals, challenge adjudications, resolution/seal actions, config, emergency halt, fallback-governance dashboard (disabled first release). **Every action is a real signed mutation** wired to the modeled Edge paths — no "Requires hardened backend" placeholders. Disabled actions state the exact unmet prerequisite.

## 12. Mobile
Bottom-tab nav (7 sections); Case Detail tabs scroll horizontally; drawers full-screen; sticky primary CTA; challenge/pause banners always visible; overlays always closable (Escape + tap-out + ✕); no fixed-layer traps.

## 13. Terminology contract (identical across all documents)
**Case** = investigation (question-first, Field Office). **Report** = contribution to a Case (versioned). **Wire Report** = standalone finding (report-first, The Wire, versioned). **Public Record** = a published Case or Wire Report. **Reward** = optional pledge on a Case. **Seal** = a Case's final immutable resolution. "Bounty" is retired as a top-level noun (survives only as "reward pledge"). **Safety block** ≠ **investigation rejection** (never conflated).
