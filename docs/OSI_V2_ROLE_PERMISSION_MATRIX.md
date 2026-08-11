# OSI V2 — Role & Permission Matrix

**Status:** Blueprint / design-only. Every privileged row names a **server-side enforcement point**. A hidden or disabled button is never authorization (P10). Proof column uses the hybrid model (D15): **Memo** = Solana memo outcome; **Sig** = signMessage + server-verified receipt; **Sys** = system event.

## Roles
`anon` · `wallet` (connected ordinary) · `case_owner` (proven) · `report_author` (proven) · `wire_author` (proven) · `contributor` · `candidate` · `probationary` · `analyst` (verified+approved) · `senior` · `adm_wallet_only` (admin wallet, no auth) · `adm_auth_only` (auth, wrong wallet) · `maintainer` (double-gate) · `service` (Edge Function).

**Server enforcement legend:** `EF` = Edge Function verifies (signature and/or Supabase JWT + `analyst_profiles`/maintainer); `RLS` = row policy; client checks are UX-only.

**D17 cold-start overlay (Constitution P3/P5):** the standard analyst-quorum rows remain authoritative. While the server-computed live eligible-analyst count is below 50 and `OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED=true`, a full double-gated maintainer has a separate, self-decaying finalization channel for exactly four outcomes: Case Report publication, Wire Report publication, resolution / winning-Report selection, and seal. The server requires the D17 tier support (maintainer alone below 20; one independent analyst at 20–29; two independent analysts plus the reduced weight gate at 30–49; unavailable at 50+), rejects an author conflict, and records `decision_channel='maintainer_bootstrap'`. This channel is never a counted maintainer review and never represents independent analyst consensus. It does not apply to rejection, AI-Pack approval, challenge accept/reject, or Case initial rejection.

---

## 1. Case

| Operation | anon | wallet | owner | analyst | senior | maintainer | Enforcement | Proof | Public consequence |
|---|---|---|---|---|---|---|---|---|---|
| View public case | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | RLS visibility=public | – | – |
| View own private case | – | – | ✅ (proof) | ✅ | ✅ | ✅ | EF `OWNER_STATUS_PROOF` / analyst / maintainer | Sig | – |
| Submit case | – | ✅ | (owner) | ✅ | ✅ | ✅ | EF sig; RLS insert private | Memo `CASE_SUBMITTED` | none |
| Initial review (eligible analyst or full maintainer) | – | – | ❌ own | ✅ | ✅ | ✅ | EF analyst eligibility or maintainer double-gate; owner excluded | Sig `CASE_INITIAL_REVIEW_CAST` | – |
| Open case (outcome) | – | – | ❌ | ✅(1) | ✅ | ✅ | EF analyst ≥1 + Σweight ≥0.50 **OR** full maintainer wallet+auth; opening actor owns active `approve_open` | Memo `CASE_OPENED` | case public; not truth/guilt approval |
| Safety block | – | – | – | – | – | ✅ / server policy | EF maintainer/policy (moderation, no factual quorum) | Memo `CASE_SAFETY_BLOCKED` (class A) | private neutral notice |
| Safety-block lift | – | – | – | – | – | ✅ | EF maintainer | Memo `CASE_SAFETY_LIFTED` | re-enters review |
| Normal initial reject | – | – | ❌ | quorum | quorum | (counts as analyst only) | EF ≥2 indep **+ Σweight ≥2.00** (**no maintainer gate**) | Memo `CASE_INITIAL_REVIEW_REJECTED` | private; appeal |
| Appeal a rejection | – | – | ✅ (owner) | – | – | – | EF owner sig | Sig `CASE_APPEAL_SUBMITTED` | re-enters review |
| Select exact primary Report (standard) | – | – | ❌ decisive | quorum | ✅ | ✅ **maintainer required** | EF ≥2 indep **+ Σweight ≥2.50 + maintainer**; winner = unique server quorum leader; exact tie remains unresolved | Memo `REPORT_SELECTED_WINNING` | winner shown as analyst-quorum outcome |
| Select exact primary Report (D17 cold start) | – | – | ❌ decisive | tier support only | tier support only | ✅ full double-gate | EF D17 overlay; exact same-Case version; maintainer cannot be its author or a counted reviewer | Memo `REPORT_SELECTED_WINNING`; receipt `decision_channel='maintainer_bootstrap'` | winner shown with maintainer-bootstrap process notice |
| Seal (standard) | – | – | – | fallback-only | – | ✅ **maintainer required** | EF ≥2 indep **+ Σweight ≥2.50 + maintainer** | Memo `RECORD_SEALED` | sealed badge; analyst-quorum outcome |
| Seal (D17 cold start) | – | – | – | tier support only | tier support only | ✅ full double-gate | EF D17 overlay after the challenge window and all other seal prerequisites | Memo `RECORD_SEALED`; receipt `decision_channel='maintainer_bootstrap'` | sealed badge with maintainer-bootstrap process notice |
| Halt (emergency) | – | – | – | – | – | ✅/fallback | EF maintainer | Memo `CASE_HALTED` | frozen |
| Resume from halt | – | – | – | – | – | ✅ | EF maintainer | Memo `CASE_RESUMED` | resumed |
| Reopen | – | – | appeal | quorum | quorum | ✅ | EF ≥2 indep **+ Σweight** | Memo `CASE_REOPENED` | reopened |

## 2. Report + versions

| Operation | wallet | author | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| Submit report / new version (v1 & every revision) | ✅ | ✅ | ✅ | ✅ | EF sig; RLS insert private version | Memo `CASE_REPORT_VERSION_SUBMITTED` |
| View pending version | – | ✅ (proof) | ✅ | ✅ | EF owner-proof/analyst/maintainer | Sig |
| Review exact version | – | ❌ own | ✅ | only if separately analyst-eligible | EF verify analyst; **author≠reviewer**; targets `case_report_versions.id`; maintainer status adds no vote | Sig `CASE_REPORT_REVIEW_CAST`/`_REVISED` |
| Publish version (standard outcome) | – | ❌ | quorum | (analyst only) | EF ≥2 indep **+ Σweight ≥2.00** (**no maintainer gate**); advances header `current_published_version_id` (never set-once) | Memo `REPORT_PUBLISHED` |
| Publish exact version via D17 cold start (v1 or correction) | – | ❌ | tier support only | ✅ full double-gate | EF D17 overlay; author conflict and counted-maintainer-review conflict denied; standard quorum remains separate | Memo `REPORT_PUBLISHED`; receipt `decision_channel='maintainer_bootstrap'` |
| Reject version (outcome) | – | ❌ | quorum | (analyst only) | EF ≥2 indep **+ Σweight** (**no maintainer gate**) | Memo `REPORT_REJECTED` |
| Author post-publication correction | – | ✅ | – | – | EF author sig; new version → normal review | Memo `CASE_REPORT_VERSION_SUBMITTED` |
| Publish a **corrected** version (standard outcome) | – | ❌ | quorum | (analyst only) | EF ≥2 indep **+ Σweight** (**no maintainer gate**); prior published version keeps history, resolution stays bound to its exact version | Memo `REPORT_PUBLISHED` (new version) |
| Select winning version (standard outcome) | – | ❌ | quorum | ✅ **maintainer required** | EF ≥2 indep **+ Σweight ≥2.50 + maintainer**; server sets winner from quorum tally | Memo `REPORT_SELECTED_WINNING` |
| Select winning version via D17 cold start | – | ❌ | tier support only | ✅ full double-gate | EF D17 overlay; exact same-Case version; author/counted-review conflicts denied | Memo `REPORT_SELECTED_WINNING`; receipt `decision_channel='maintainer_bootstrap'` |

## 3. Wire

| Operation | wallet | wire_author | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| Submit wire report / version (v1 & every revision) | ✅ | (author) | ✅ | ✅ | EF sig | Memo `WIRE_REPORT_VERSION_SUBMITTED` |
| Review exact wire version | ❌ | ❌ own | ✅ | ✅ | EF verify **eligible analyst**; **ordinary connected wallets cannot write `wire_report_reviews`**; **author excluded** | Sig `WIRE_REPORT_REVIEW_CAST`/`_REVISED` |
| Publish (standard outcome) | – | ❌ | quorum | (analyst only) | EF ≥2 indep **+ Σweight ≥2.00** (**no maintainer gate**) | Memo `WIRE_REPORT_PUBLISHED` |
| Publish via D17 cold start | – | ❌ | tier support only | ✅ full double-gate | EF D17 overlay; author conflict and counted-maintainer-review conflict denied | Memo `WIRE_REPORT_PUBLISHED`; receipt `decision_channel='maintainer_bootstrap'` |
| Promote to case | – | – | ✅ | ✅ | EF analyst/maintainer | Memo `WIRE_PROMOTED` |
| Support author | ✅ | – | ✅ | ✅ | EF derives current published author; trusted RPC finality | `SUPPORT_PAYMENT_CONFIRMED` (no ranking effect) |

## 4. Challenge (admissibility gate)

| Operation | wallet | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|
| Submit challenge | ✅ | ✅ | ✅ | EF sig + reason + **`evidence_item_id` FK** (URL first becomes an `evidence_items` row) + **exactly-one typed target FK** + rate-limit + one-active + cooldown; sets `admissibility_ttl_at` | Sig `CHALLENGE_SUBMITTED` |
| Accept admissibility (→ pauses sealing) | – | ✅ | ✅ | EF one eligible analyst or full double-gated maintainer; **≠challenger, Case owner, selected Report author**; sets `review_deadline_at` | Sig `CHALLENGE_ADMISSIBILITY_ACCEPTED` |
| Reject admissibility (inadmissible) | – | ✅ | ✅ | EF one eligible analyst or full double-gated maintainer; same conflict exclusions; **no penalty**; no pause | Sig `CHALLENGE_ADMISSIBILITY_REJECTED` |
| Merit review (per analyst) | – | ✅ | ✅ | EF **eligible independent analyst, ≠challenger** (and ≠ target author/owner/creator); `challenge_reviews{phase:merit}` | Sig `CHALLENGE_REVIEW_CAST`/`_REVISED` |
| Accept/reject (outcome) | – | quorum | (analyst only) | EF ≥2 indep **+ Σweight ≥2.50** (**no maintainer gate**); target-specific consequence (State Machines §5.1) | Memo `CHALLENGE_ACCEPTED`/`CHALLENGE_REJECTED` |
| Bad-faith review (per analyst) | – | ✅ | ✅ | EF **eligible independent analyst, ≠challenger**; only on a rejected/withdrawn/expired challenge; `challenge_reviews{phase:bad_faith}` | Sig `CHALLENGE_BAD_FAITH_REVIEW_CAST`/`_REVISED` |
| Bad-faith outcome | – | quorum | (analyst only) | EF ≥2 indep **+ Σweight ≥2.50**; sets `bad_faith_state` (server-derived) | Memo `CHALLENGE_BAD_FAITH_CONFIRMED`/`CHALLENGE_BAD_FAITH_DISMISSED` |
| Withdraw own (any non-terminal state) | challenger | – | – | EF sig; **not after a final accepted/rejected outcome** | Sig `CHALLENGE_WITHDRAWN` |
| Expire (timeout) | – | – | – | system on `admissibility_ttl_at`/`review_deadline_at`; releases pause | Sys `CHALLENGE_EXPIRED` |

Submission alone never pauses sealing; only `open`/`under_review` do. No non-terminal state is stuck — each has a TTL/escalation path. **The challenger is excluded from admissibility, merit review, and bad-faith review of their own challenge.** Honest rejection/withdrawal/expiry carries **no automatic penalty**; a penalty follows only a **confirmed** bad-faith quorum.

## 5. Wallet profile

| Operation | anon | wallet owner | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| View explicitly public profile | ✅ | ✅ | ✅ | ✅ | EF least-privilege projection; service-only table | – |
| View own private profile | – | ✅ | own only | own only | EF exact-wallet read session, dedicated `profile:self` scope | – |
| Create/update identity fields | – | ✅ own | own identity only | own identity only | EF Ed25519 + exact-revision nonce + transactional RPC | Sig `WALLET_PROFILE_UPDATED` |
| Change analyst status/tier/weight through profile | ❌ | ❌ | ❌ | ❌ | fields absent from profile contract; analyst lifecycle remains separate | – |
| Edit another wallet's profile | ❌ | ❌ | ❌ | ❌ | actor wallet is server-derived from verified signature | – |

Publishing and Case attribution are separate owner choices. A maintainer has no profile-edit override; maintainer authority remains double-gated and analyst authority remains derived only from `analyst_profiles` plus SAS enforcement where enabled.

## 6. Analyst application & lifecycle

| Operation | self | analyst | senior | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| Submit application version (Path A, v1) | ✅ | – | – | – | EF sig; RLS insert `analyst_applications` + immutable `analyst_application_versions` | Sig `ANALYST_APPLICATION_VERSION_SUBMITTED` |
| Resubmit/revise application (new version) | ✅ | – | – | – | EF; new `analyst_application_versions` (`supersedes_version_id`) | Sig `ANALYST_APPLICATION_VERSION_SUBMITTED` |
| Review application version | – | ✅ | ✅ | ✅ | EF eligible reviewer; **`reviewer_wallet≠applicant_wallet` (applicant cannot review own application)**; targets exact `analyst_application_versions.id` | Sig `ANALYST_APPLICATION_REVIEW_CAST`/`_REVISED` |
| Path B derivation | (auto) | – | – | – | server-derived from resolved case | Sys `ANALYST_CANDIDATE` |
| Promote candidate→probationary | – | – | ✅ (future ≥3 senior, flag) | ✅ | EF; **server-derived eligibility**, no discretionary tier | Memo `ANALYST_PROBATION` |
| Verify | – | – | – | ✅ | EF maintainer double-gate | Memo `ANALYST_VERIFIED` |
| Revoke | – | – | – | ✅ | EF maintainer | Memo `ANALYST_REVOKED` |
| **Self-verify** | ❌ | ❌ | ❌ | ❌ | impossible by design | – |

## 7. AI Pack

| Operation | owner | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|
| Generate draft | ✅ (own case) | ✅ | ✅ | EF `osi-ai-pack generate`, server evidence; case/version approved | Sys `PACK_SUBMITTED` |
| Owner feedback (advisory) | ✅ | – | – | EF; writes `ai_pack_owner_feedback` (**not** `ai_pack_reviews`), **uncounted**, owner-only | Sig `AI_PACK_OWNER_FEEDBACK_SUBMITTED` |
| View `content_owner_safe` | ✅ own | ✅ | ✅ | EF authorization | – |
| View `content_analyst_restricted` | ❌ | ✅ | ✅ | EF | – |
| View public brief | public | public | public | RLS (approved) | – |
| Attest support/dispute/request_revision | ❌ own | ✅ (≠creator) | ✅ | EF `ai_pack_reviews`, reviewer≠creator | Sig `AI_PACK_REVIEW_CAST`/`_REVISED` |
| Approve version (outcome) | ❌ | quorum (≠creator) | ✅ **maintainer required** | EF ≥2 indep **+ Σweight ≥2.50 + maintainer**, creator excluded | Memo `AI_PACK_APPROVED` |
| Reject version (outcome) | ❌ | quorum (≠creator) | (analyst only) | EF ≥2 indep **+ Σweight ≥2.50** (**no maintainer gate**), creator excluded | Memo `AI_PACK_REJECTED` (class A) |

## 8. Reward & Support

| Operation | owner | wallet | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| Create/revise/withdraw reward pledge | ✅ exact Case owner | – | – | no special power | EF signMessage + exact nonce/payload; private pre-open withdraw, public increase-only, sealed freeze | Sig `REWARD_PLEDGE_CREATED` / `_REVISED` / `_WITHDRAWN` |
| Send partial/full reward to winner | ✅ exact Case owner, sealed only | – | – | no special power | EF derives exact winning version author; Phantom System Program tx; trusted RPC finality; confirmed sum ≤ frozen pledge | `REWARD_PAYMENT_CONFIRMED` |
| Voluntary support published author / eligible analyst / counted reviewer | – | ✅ | ✅ | ✅ only when separately eligible as recipient | EF derives recipient; rejects self-support; 1–4 same-context recipients; trusted RPC finality; **no ranking/discovery/reputation/governance effect** | `SUPPORT_PAYMENT_CONFIRMED` |
| Voluntary support public maintainer profile | – | ✅ | ✅ | ✅ as the typed profile recipient, never as analyst authority | EF derives the singleton `maintainer_profile.wallet` and requires exact current `osi_config.admin_wallet` equality; one recipient only; rejects self-support; trusted RPC finality; **no ranking/discovery/reputation/governance/authority effect** | `SUPPORT_PAYMENT_CONFIRMED` with `recipient_type='maintainer'` |

## 9. Public analyst attribution (correction #14 / D16)
For any **public** governance decision (public Cases, published Reports/Wire Reports, approved AI Packs, resolutions, completed challenges), the public view shows for each participating analyst, full initial-open maintainer, or D17 bootstrap maintainer: **role, public profile/handle where applicable, wallet, decision, weight snapshot used where applicable (a maintainer action is never analyst weight), timestamp, proof type** (`solana_memo` / `wallet_signed_server_verified` / `system_event`), and a public-safe receipt/tx reference. A D17 outcome additionally shows `decision_channel='maintainer_bootstrap'` and an explicit notice that it is not independent analyst consensus. Restricted always: private notes, private evidence, moderation reason detail, sensitive reason text. Pre-open/private queue shows **counts only**.

## 10. The two half-maintainer roles

| Operation | `adm_wallet_only` | `adm_auth_only` | Reason |
|---|---|---|---|
| Any maintainer mutation | ❌ | ❌ | `resolveMaintainerAccess` needs **wallet AND auth**; RLS restricts writes to the maintainer auth UUID |
| Ops Center | locked | locked | double-gate |

## 11. Service role
`service` (Edge Function service-role key) is the only writer for publication, review tallies, resolution finalization, pack storage, reputation snapshots, and **all `event_receipts` inserts** (server-only Proof Log write — closes the current anon-writable gap). Never in client code. RLS denies anon/user writes to these.

## 12. Enforcement summary
Signature-verified identity for all owner/analyst actions (ed25519, purpose+target+payload-hash bound, **server-issued single-use nonce persisted/consumed in `osi_nonces`**, freshness). Analyst authorization = server `analyst_profiles` lookup. Maintainer = double-gate + auth-UUID RLS. Quorum/weight computed server-side. Pending privacy = RLS default-deny + owner-proof Edge path. No support-based ranking anywhere.

**Counted-review eligibility (correction #6 — applies to every counted Report / Wire / resolution / challenge / AI-Pack / application review):**
- Only **eligible verified analysts** cast counted reviews; **ordinary connected wallets never write any `*_reviews` table** (they may only *submit* Cases/Reports/Wire Reports/challenges and voluntary support).
- **Maintainer status alone confers no analyst voting weight.** A maintainer's vote is counted **only if the same wallet is separately analyst-eligible**, and then only after all exclusions pass. The independent full-maintainer Case initial-open path stores weight `0`, requires both maintainer gates, and authorizes only public investigation. The separate D17 cold-start channel may finalize only the four outcomes in the overlay above and likewise contributes no maintainer analyst vote. Neither path implies truth, guilt, or independent analyst consensus. Maintainer finalization remains distinct from casting a weighted analyst vote.
- **Server-enforced exclusions on every counted review:** author (Report/Wire), owner (Case/resolution), creator (AI Pack), applicant (analyst application), and challenger (challenge admissibility/merit/bad-faith) are excluded from deciding their own item — enforced in the Edge Function, never by a hidden button.
- **Both gates shown:** every standard analyst-quorum outcome that requires them lists `≥N_min independent` **and** `Σweight ≥ W_thr`; the three standard maintainer-gated outcomes (resolution/winner, AI-Pack approval, seal) additionally require a maintainer signature. Case initial open separately permits full maintainer approval as an alternative to, not an added gate on, its analyst path (D5). D17 is a second, explicitly labeled alternative only for Case Report publication, Wire Report publication, resolution/winner, and seal; its server-computed tier requirements self-retire at 50 live eligible analysts.
