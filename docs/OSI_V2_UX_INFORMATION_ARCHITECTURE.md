# OSI V2 — UX & Information Architecture

**Status:** Accepted information architecture with a current-production overlay. Every visible button maps to a **real modeled action** (state-machine transition + server enforcement). **No disabled placeholder may be presented as functional; a disabled button states its exact unmet prerequisite.** No support-based ranking anywhere (correction #15).

Current production is narrower than the complete future model in two places. AI Pack is visible only to the full double-gated maintainer and creates private operational drafts; owner/analyst review, feedback, approval, publication, and public discovery are absent. Solana Pay is available only after trusted V2 preparation and only for a single server-derived recipient; atomic multi-recipient support stays Phantom-only. The D17 cold-start channel is separate from analyst quorum and applies only to Case Report publication, Wire Report publication, resolution / winning-Report selection, and seal while the server-computed live eligible-analyst count is below 50. Every such surface must show the current tier, exact remaining support, author/conflict state, and `maintainer_bootstrap` process notice.

Navigation: **Home · Field Office · The Wire · Public Records · Analysts · Proof Log · My OSI** (+ maintainer lock icon → Operations Center).

Global states per surface: **empty** (neutral + primary CTA), **loading** (skeleton, no fake data), **error** (neutral, retry, never raw DB/SQL/token), **unauthorized** (explains how to gain access).

### Public and personal surface boundary (current release)

Public surfaces are anonymous-readable and never trigger a wallet call: Field Office / Cases, public Case detail, **Published Reports** inside a public Case, The Wire, Public Records (sealed outcomes only), Proof Log, Analyst Network. Personal and authorized surfaces are **My OSI, My Cases, My Reports, Review Queue** and the maintainer workspace. The Field Office rail item for the author workspace is labeled **My Reports**, never "Reports", because it lists only the connected wallet's own immutable versions.

Navigating to a personal surface never calls `connect`, `signMessage` or `sendTransaction`. It renders an inline locked panel that names the boundary and offers one explicit control ("Connect wallet and authorize private read"), and that control states that it costs one message signature and no Solana transaction. A missing wallet extension is only reported after the user activates that control.

Public Case detail has a canonical shareable route, `#case/<public_ref>`. Every entry point (Home, Field Office row, Proof Log, Operations) resolves the same reference to the same drawer and the same URL, so direct links, reload and browser back/forward all work. The route carries a public reference only, never a token, nonce or wallet value. The drawer opens immediately from the already-loaded public projection and refreshes in place, so a slow public read can never look like a dead button.

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
| **Publish via maintainer bootstrap** | Reports / Operations | full double-gated maintainer, exact version not authored, D17 active, server tier support met, standard quorum not already available | exact-version publication prepare/commit → finalized `REPORT_PUBLISHED`; receipt `decision_channel='maintainer_bootstrap'` | "Maintainer bootstrap is not analyst consensus" / exact tier, conflict, support, or finality prerequisite |
| **Select resolution candidate** | Votes tab | analyst, not author/owner; resolution in `selection_open` | `resolution_reviews` cast on an exact same-Case candidate version | "Owner/author excluded" / "Needs published report versions" |
| **Finalize winning Report** | Resolution/maintainer | **maintainer required**, after count and weight quorum | server sets the unique winner from the exact tally and emits only `REPORT_SELECTED_WINNING` for this finalization | "Finalize unavailable: needs 1 more independent analyst" |
| **Finalize winner via maintainer bootstrap** | Resolution / Operations | full double-gated maintainer, D17 active, exact same-Case version, server tier support met, no author/conflict | D17 exact-version finalization → `REPORT_SELECTED_WINNING`; receipt `decision_channel='maintainer_bootstrap'` | "Maintainer bootstrap is not analyst consensus" / exact tier or conflict prerequisite |
| **Seal via maintainer bootstrap** | Resolution / Operations | full double-gated maintainer, D17 active, challenge window complete, no admissible pause, server tier support met | D17 seal finalization → `RECORD_SEALED`; receipt `decision_channel='maintainer_bootstrap'` | exact challenge-window, pause, tier, or conflict prerequisite |
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
| **Publish Wire via maintainer bootstrap** | Wire detail / Operations | full double-gated maintainer, exact version not authored, D17 active, server tier support met | exact-version publication → `WIRE_REPORT_PUBLISHED`; receipt `decision_channel='maintainer_bootstrap'` | "Maintainer bootstrap is not analyst consensus" / exact tier or conflict prerequisite |

Tab contents: **Overview** (public summary, stage timeline, key dates, reward chip, counts) · **Evidence** (public evidence; restricted gated; reported wallets labeled *reported/unverified*) · **Reports** (versions with status; published bodies public; pending gated; reviews target exact version; support-author action) · **AI Pack** (per AI Pack Trust Model §9) · **Votes** (decision totals + **public analyst attribution** — handle, wallet, decision, weight snapshot, timestamp, proof type; quorum two-gate meter) · **Challenges** (admissibility state, pause indicator, open challenge form) · **Rewards & Support** (pledge history/status, exact sealed winner + author, outstanding amount, partial/finalized payments, 1–4 same-version contributor support, retry-finality state; never "paid" pre-finality) · **Proof Log** (receipts with honest proof-type labels plus exact verified transfer manifest/finality fields).

Payment interaction starts with trusted server preparation, then an exact review of mainnet, purpose, recipient manifest, amounts, Memo, irreversibility, and no custody. Phantom signs the exact transaction and remains the only multi-recipient option. A single-recipient intent also offers Solana Pay with a local QR, explicit mobile deep link, copy fallback, expiring server-bound reference, and polling. Neither scan nor wallet open means paid; both methods use the same finalized server verification and receipt commit.

## 4. The Wire (report-first, no rewards)
"Publish a Wire Report" (finding-first) → new `wire_report_versions` → Memo `WIRE_REPORT_VERSION_SUBMITTED` (v1 & every revision). Card: title, author, review state, support chip (display only). Filters: category, newest (**no most-supported sort**). Published Wire Report → "Promote to Case" (analyst/maintainer). Author cannot review own. Standard publication uses independent analyst quorum; the D17 alternative is visible only to a full double-gated maintainer, follows the live tier, excludes its author, and is permanently labeled `maintainer_bootstrap`.

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

Resolution operations appear only after the configured admin wallet and configured Supabase maintainer identity both pass. The console may finalize a unique analyst-quorum leader, admit a challenge through the full-maintainer admissibility route, and finalize a seal after its standard analyst seal quorum. Outside the four D17 outcomes it never substitutes maintainer authority for counted analyst quorum. For an active D17 lane it shows the live server tier, required independent analyst count/weight, exact target and conflict state before exposing the separate bootstrap action; the confirmation and receipt state plainly that the outcome is maintainer bootstrap, not analyst consensus.

`My Reviews` groups real work by Case initial review, Report publication, analyst applications, Wire publication, Resolution selection, Challenge admissibility, Challenge adjudication, and Seal review. Every row identifies the exact public target, stage, submitter/author conflict state, server deadline where applicable, current active vote, server-derived weight snapshot, and exact next action. Report rows keep analyst review capability and full-maintainer bootstrap capability separate. A lane shows “No authorized tasks” only after a successful server response containing an empty array; loading, expired-session, authorization, and API-error states retain their own retry/reconnect recovery. The queue exposes refresh and last-updated state, and selecting a task opens its exact Case, Report, application, Wire, resolution, challenge, or seal surface.
Sections include real pending review/governance queues plus **Private AI Pack Operations** and **SAS Authority Operations**. AI Pack shows exact access mode, write/provider state, private draft count, in-progress count, and eligible Cases; it offers generation/inspection only and no approval control in `maintainer_only` mode. SAS shows exact program, Credential, Schema, issuer, issuance/enforcement state, current credential ledger state, check timestamp, and an idempotent reconcile action. The removed “Ready to Publish” and “Safety Flags” placeholders have no authoritative source and are not shown. Future safety, bad-faith, resume, fallback, and governed AI approval controls must appear only when their exact endpoint and state transition are live. The maintainer's action is never an analyst vote and carries no analyst weight.

## 12. Mobile
Bottom-tab nav (7 sections); Case Detail tabs scroll horizontally; drawers full-screen; sticky primary CTA; challenge/pause banners always visible; overlays always closable (Escape + tap-out + ✕); no fixed-layer traps.

## 13. Terminology contract (identical across all documents)
**Case** = investigation (question-first, Field Office). **Report** = contribution to a Case (versioned). **Wire Report** = standalone finding (report-first, The Wire, versioned). **Public Record** = a published Case or Wire Report. **Reward** = optional pledge on a Case. **Seal** = a Case's final immutable resolution. "Bounty" is retired as a top-level noun (survives only as "reward pledge"). **Safety block** ≠ **investigation rejection** (never conflated).
