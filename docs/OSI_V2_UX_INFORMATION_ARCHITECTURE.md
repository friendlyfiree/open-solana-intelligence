# OSI V2 — UX & Information Architecture

**Status:** Blueprint / design-only. No `index.html`/CSS/JS is changed. Every button maps to a **real modeled action** (state-machine transition + server enforcement). **No disabled placeholder may be presented as functional; a disabled button states its exact unmet prerequisite.** No support-based ranking anywhere (correction #15).

Navigation: **Home · Field Office · The Wire · Public Records · Analysts · Proof Log · My OSI** (+ maintainer lock icon → Operations Center).

Global states per surface: **empty** (neutral + primary CTA), **loading** (skeleton, no fake data), **error** (neutral, retry, never raw DB/SQL/token), **unauthorized** (explains how to gain access).

---

## 1. Home
Hero (one-sentence value) → primary CTA "File a report" / secondary "Open an investigation" + "Join as analyst" → 4-step "How it works" → role explainer → AI Pack explainer → Proof Log explainer (four honest proof types) → Public Records preview → disclaimer. "View Live Console" = demo tour (`OSI_DEMO_MODE`).

## 2. Field Office (Case-centered)
Filters: `Open investigations` · `In review` · `Resolved` · `Sealed` · `Mine` · category · search (**no most-supported/most-backed sort**). Card: public_ref, title, category, stage badge, report count, analyst-decision totals, challenge state, optional reward chip, "View Case." Private cases never listed publicly; owner sees own via "Mine" (owner-proof).

## 3. Case Detail — current release tabs: Overview · Evidence · Reports · Resolution · Challenges · Rewards & Support · Proof Log

The current release keeps the executable governance and payment paths in seven focused tabs. Resolution contains the exact candidate-version tally, unique-leader/tie state, attributed selection reviews, selected primary version, and process-seal quorum. Challenges contains the server countdown, admissibility state, blocking label, merit history, and terminal outcome. Rewards & Support contains the real pledge, sealed-winner payment, contributor support, finality retry, and receipt surfaces; no dormant control is shown as functional.

**Per-action button/state rules (each → modeled transition):**

| Button | Where | Role/state gate | Modeled action | Disabled-state message example |
|---|---|---|---|---|
| **Open a Case** | Field Office | connected wallet | Case submit → `CASE_SUBMITTED` | "Connect a wallet to open a Case" |
| **Add evidence** | Evidence tab | owner/analyst on open case | insert `evidence_items` + link | "Case must be open to add evidence" |
| **Submit Report** | Reports tab | connected wallet, case open | new `case_report_versions` v1 → Memo `CASE_REPORT_VERSION_SUBMITTED` | "Case not open yet" |
| **Submit Report revision** | Reports tab | report author, version in `revision_requested` | new version (`supersedes_version_id`) → Memo `CASE_REPORT_VERSION_SUBMITTED` | "Only the author can revise; no revision requested" |
| **Review this version** | Reports tab | analyst, **not author** | `case_report_reviews` cast → Sig | "Authors can't review their own report" / "Verified analysts only" |
| **Select resolution candidate** | Votes tab | analyst, not author/owner; resolution in `selection_open` | `resolution_reviews` cast on an exact same-Case candidate version | "Owner/author excluded" / "Needs published report versions" |
| **Finalize winning Report** | Resolution/maintainer | **maintainer required**, after count and weight quorum | server sets the unique winner from the exact tally and emits only `REPORT_SELECTED_WINNING` for this finalization | "Finalize unavailable: needs 1 more independent analyst" |
| **Submit challenge** | Challenges tab | connected wallet | `challenges` submit (typed target FK + `evidence_item_id`) → `CHALLENGE_SUBMITTED` | "One active challenge per target; cooldown active" |
| **Challenge pending admissibility** | Challenges tab | (display) | shows `submitted`/`admissibility_review` + admissibility countdown — **not yet pausing sealing** | — |
| **Withdraw challenge** | Challenges tab | challenger, non-terminal state | `challenges` → `CHALLENGE_WITHDRAWN` | "Cannot withdraw after a final outcome" |
| **Review challenge** | Challenges tab | analyst | admissibility accept/reject / `challenge_reviews` cast | "Verified analysts only" |
| **Generate AI Pack** | AI Pack tab | owner/analyst/maintainer, case has approved evidence | `osi-ai-pack generate` → `PACK_SUBMITTED` | "Needs approved case evidence" |
| **Submit Pack revision** | AI Pack tab | version creator, `revision_requested` | new `ai_pack_versions` | "Only the creator can resubmit" |
| **Review Pack version** | AI Pack tab | analyst, **not creator** | `ai_pack_reviews` cast → Sig | "Creators can't review their own pack" |
| **Submit Pack owner feedback** | AI Pack tab | proven Case owner | `ai_pack_owner_feedback` → Sig `AI_PACK_OWNER_FEEDBACK_SUBMITTED` (advisory, uncounted) | "Only the Case owner may submit feedback" |
| **Approve Pack after quorum** | AI Pack tab | maintainer, ≥2 independent (creator excluded) | `AI_PACK_APPROVED` | "Approve — needs 1 more independent analyst" |
| **Create/revise/withdraw pledge** | Rewards & Support tab | exact Case owner | Class-B pledge receipt; no SOL moves | "Pledged, not escrowed" / exact lifecycle reason |
| **Send pledged reward** | Rewards & Support tab | exact Case owner, Case sealed, unpaid amount > 0 | server-derived winner + finalized `reward_payments` tx → `REWARD_PAYMENT_CONFIRMED` | "Challenge window must end and Case must be sealed" |
| **Support Report Author / contributors** | Reports / Rewards & Support | any connected wallet | server-derived 1–4 recipient manifest → `SUPPORT_PAYMENT_CONFIRMED` | "Connect a wallet" / exact self-support or target reason |
| **Support Analyst** | Analyst profile | any connected wallet; recipient must be an eligible verified analyst | server-derived `support_events` recipient → `SUPPORT_PAYMENT_CONFIRMED` | "Connect a wallet" / exact self-support or eligibility reason |

Tab contents: **Overview** (public summary, stage timeline, key dates, reward chip, counts) · **Evidence** (public evidence; restricted gated; reported wallets labeled *reported/unverified*) · **Reports** (versions with status; published bodies public; pending gated; reviews target exact version; support-author action) · **AI Pack** (per AI Pack Trust Model §9) · **Votes** (decision totals + **public analyst attribution** — handle, wallet, decision, weight snapshot, timestamp, proof type; quorum two-gate meter) · **Challenges** (admissibility state, pause indicator, open challenge form) · **Rewards & Support** (pledge history/status, exact sealed winner + author, outstanding amount, partial/finalized payments, 1–4 same-version contributor support, retry-finality state; never "paid" pre-finality) · **Proof Log** (receipts with honest proof-type labels plus exact verified transfer manifest/finality fields).

Primary payment interaction is in-app Phantom signing. No Solana Pay control is shown until a future implementation can reuse the exact server-issued intent, reference, Memo, manifest, and trusted RPC verification without weakening binding.

## 4. The Wire (report-first, no rewards)
"Publish a Wire Report" (finding-first) → new `wire_report_versions` → Memo `WIRE_REPORT_VERSION_SUBMITTED` (v1 & every revision). Card: title, author, review state, support chip (display only). Filters: category, newest (**no most-supported sort**). Published Wire Report → "Promote to Case" (analyst/maintainer). Author cannot review own.

## 5. Wire Report Detail
Tabs: Overview · Evidence · Reviews (totals + public attribution) · Challenges · Support · Proof Log. "Support author" (voluntary, non-influencing). Evidence is first-class (`wire_report_version_evidence`).

## 6. Public Records
Archive of published/resolved/sealed public outcomes (Cases + published Wire Reports). Card: public_ref, title, category, status (Reviewed/Resolved/Sealed), analyst review summary + **public attribution**, challenge state, AI Pack availability (metadata), "Open record." No support-based ordering.

## 7. Analysts
Tabs: **Roster** (verified analysts, tier, contribution stats) · **Review Floor** (analyst-gated: pending Cases/Report versions/Wire versions/Challenges/Packs; each shows two-gate progress + self-review exclusion) · **Apply** (Path A → `analyst_applications` header + immutable `analyst_application_versions`; each submit/revision is a new version) · **Path B status** (contributor→candidate progress). Locked state for non-analysts links to Apply.

## 8. Analyst Profile
Identity, tier, bounded weight, contribution ledger (accepted/winning/reversals — transparent, server-derived), attestation history, support-received (display only, no influence). No fake metrics.

## 9. Proof Log
Unified timeline over `event_receipts` (OSI1/legacy/OSI2). Honest proof-type labels: **Memo-anchored on Solana** (real tx), **Wallet-signed & server-verified** (signMessage receipt), **System event**, **Legacy / not server-verified**. Filters by event type/target/proof type. Standing "provenance, not verdict" note. No hardcoded "confirmed."

## 10. My OSI (owner/author dashboard, owner-proof) — exact-version status
Sections: **My Cases** (with **Withdraw Case** on a pre-open Case → `CASE_WITHDRAWN`, and **Appeal** on a normal-rejected Case → `CASE_APPEAL_SUBMITTED`) · **My Case Reports** (exact current version, current published version, review status, winning flag — publication history preserved; **Submit correction** on a published Report → new version) · **My Wire Reports** (version + review status; same correction action) · **My AI Packs** (version/lifecycle/per-layer stale) · **My Challenges** (state + admissibility/review countdown; **Withdraw** while non-terminal) · **My analyst applications** (application status, **exact current version**, revision requests, **prior submitted versions**, per-version review state — over `analyst_applications` + immutable `analyst_application_versions`) · **Rewards & Payments** (pledges made/owed; rewards owed as winner; payment status) · **Support Received** (voluntary, display only). Private data only via fresh signature proof.

## 11. Maintainer Operations Center

Resolution operations appear only after the configured admin wallet and configured Supabase maintainer identity both pass. The console may finalize a unique analyst-quorum leader, admit a challenge through the full-maintainer admissibility route, and finalize a seal only after its analyst seal quorum. It never offers a control that substitutes maintainer authority for counted analyst quorum.

`My Reviews` groups real work by Report publication, Resolution selection, Challenge admissibility, Challenge adjudication, and Seal review. Every row identifies the exact public target, server deadline where applicable, conflict state, current active vote, server-derived weight snapshot, and exact next action. A lane with no authorized tasks shows an honest empty state rather than sample activity.
Sections: pending initial reviews, safety-block queue (with **Lift safety block** → `CASE_SAFETY_LIFTED`), quorum-ready finalizations (**resolution/winner** and **seal** — the two maintainer-gated Case outcomes; report/wire publication does **not** appear here since it needs no maintainer), analyst application/verification queue, **AI Pack approval** (maintainer-gated), challenge adjudications (including the **bad-faith review phase** → `CHALLENGE_BAD_FAITH_CONFIRMED`/`DISMISSED`), **Resume from halt** → `CASE_RESUMED`, config, emergency halt, fallback-governance dashboard (disabled first release). **Every action is a real signed mutation** wired to the modeled Edge paths — no "Requires hardened backend" placeholders. Disabled actions state the exact unmet prerequisite. The maintainer's finalization signature is **not** an analyst vote and carries no analyst weight.

## 12. Mobile
Bottom-tab nav (7 sections); Case Detail tabs scroll horizontally; drawers full-screen; sticky primary CTA; challenge/pause banners always visible; overlays always closable (Escape + tap-out + ✕); no fixed-layer traps.

## 13. Terminology contract (identical across all documents)
**Case** = investigation (question-first, Field Office). **Report** = contribution to a Case (versioned). **Wire Report** = standalone finding (report-first, The Wire, versioned). **Public Record** = a published Case or Wire Report. **Reward** = optional pledge on a Case. **Seal** = a Case's final immutable resolution. "Bounty" is retired as a top-level noun (survives only as "reward pledge"). **Safety block** ≠ **investigation rejection** (never conflated).
