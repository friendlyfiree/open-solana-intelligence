# OSI V2 — Role & Permission Matrix

**Status:** Blueprint / design-only. Every privileged row names a **server-side enforcement point**. A hidden or disabled button is never authorization (P10). Proof column uses the hybrid model (D15): **Memo** = Solana memo outcome; **Sig** = signMessage + server-verified receipt; **Sys** = system event.

## Roles
`anon` · `wallet` (connected ordinary) · `case_owner` (proven) · `report_author` (proven) · `wire_author` (proven) · `contributor` · `candidate` · `probationary` · `analyst` (verified+approved) · `senior` · `adm_wallet_only` (admin wallet, no auth) · `adm_auth_only` (auth, wrong wallet) · `maintainer` (double-gate) · `service` (Edge Function).

**Server enforcement legend:** `EF` = Edge Function verifies (signature and/or Supabase JWT + `analyst_profiles`/maintainer); `RLS` = row policy; client checks are UX-only.

---

## 1. Case

| Operation | anon | wallet | owner | analyst | senior | maintainer | Enforcement | Proof | Public consequence |
|---|---|---|---|---|---|---|---|---|---|
| View public case | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | RLS visibility=public | – | – |
| View own private case | – | – | ✅ (proof) | ✅ | ✅ | ✅ | EF `OWNER_STATUS_PROOF` / analyst / maintainer | Sig | – |
| Submit case | – | ✅ | (owner) | ✅ | ✅ | ✅ | EF sig; RLS insert private | Memo `CASE_SUBMITTED` | none |
| Initial review (per analyst) | – | – | ❌ own | ✅ | ✅ | ✅ | EF; owner excluded | Sig `CASE_INITIAL_REVIEW_CAST` | – |
| Open case (outcome) | – | – | ❌ | ✅(1) | ✅ | ✅ | EF ≥1 | Memo `CASE_OPENED` | case public |
| Safety block | – | – | – | – | – | ✅ / server policy | EF maintainer/policy | Memo `CASE_SAFETY_BLOCKED` (class A) | private neutral notice |
| Normal initial reject | – | – | ❌ | quorum | quorum | ✅ | EF ≥2 indep | Memo `CASE_INITIAL_REVIEW_REJECTED` | private; appeal |
| Propose resolution | – | – | ❌ decisive | quorum | ✅ | ✅ finalize | EF ≥2 indep + maintainer | Memo `RESOLUTION_PROPOSED` | winner shown |
| Seal | – | – | – | fallback-only | – | ✅ | EF ≥2 indep + maintainer | Memo `RECORD_SEALED` | sealed badge |
| Halt (emergency) | – | – | – | – | – | ✅/fallback | EF maintainer | Memo `CASE_HALTED` | frozen |
| Reopen | – | – | appeal | quorum | quorum | ✅ | EF ≥2 indep | Memo `CASE_REOPENED` | reopened |

## 2. Report + versions

| Operation | wallet | author | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| Submit report / new version (v1 & every revision) | ✅ | ✅ | ✅ | ✅ | EF sig; RLS insert private version | Memo `CASE_REPORT_VERSION_SUBMITTED` |
| View pending version | – | ✅ (proof) | ✅ | ✅ | EF owner-proof/analyst/maintainer | Sig |
| Review exact version | – | ❌ own | ✅ | ✅ | EF verify analyst; **author≠reviewer**; targets `case_report_versions.id` | Sig `CASE_REPORT_REVIEW_CAST`/`_REVISED` |
| Publish version (outcome) | – | ❌ | quorum | finalize | EF ≥2 indep + weight; advances header `current_published_version_id` (never set-once) | Memo `REPORT_PUBLISHED` |
| Reject version (outcome) | – | ❌ | quorum | finalize | EF ≥2 indep | Memo `REPORT_REJECTED` |
| Publish a **corrected** version | – | ❌ | quorum | finalize | EF ≥2 indep + weight; prior published version keeps history, resolution stays bound to its exact version | Memo `REPORT_PUBLISHED` (new version) |
| Select winning version | – | ❌ | quorum | ✅ | EF ≥2 indep + maintainer; exact version | Memo `REPORT_SELECTED_WINNING` |

## 3. Wire

| Operation | wallet | wire_author | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| Submit wire report / version (v1 & every revision) | ✅ | (author) | ✅ | ✅ | EF sig | Memo `WIRE_REPORT_VERSION_SUBMITTED` |
| Review exact wire version | ✅→❌ own | ❌ own | ✅ | ✅ | EF; **author excluded** | Sig `WIRE_REPORT_REVIEW_CAST`/`_REVISED` |
| Publish (outcome) | – | ❌ | quorum | finalize | EF ≥2 indep + weight | Memo `WIRE_REPORT_PUBLISHED` |
| Promote to case | – | – | ✅ | ✅ | EF analyst/maintainer | Memo `WIRE_PROMOTED` |
| Support author | ✅ | – | ✅ | ✅ | EF support endpoint | Memo `SUPPORT_SENT` (no ranking effect) |

## 4. Challenge (admissibility gate)

| Operation | wallet | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|
| Submit challenge | ✅ | ✅ | ✅ | EF sig + reason + **`evidence_item_id` FK** (URL first becomes an `evidence_items` row) + **exactly-one typed target FK** + rate-limit + one-active + cooldown; sets `admissibility_ttl_at` | Sig `CHALLENGE_SUBMITTED` |
| Accept admissibility (→ pauses sealing) | – | ✅ | ✅ | EF analyst/maintainer; sets `review_deadline_at` | Sig `CHALLENGE_ADMISSIBILITY_ACCEPTED` |
| Reject admissibility (inadmissible) | – | ✅ | ✅ | EF analyst/maintainer; **no penalty**; no pause | Sig `CHALLENGE_ADMISSIBILITY_REJECTED` |
| Judge (per analyst) | – | ✅ | ✅ | EF analyst | Sig `CHALLENGE_REVIEW_CAST`/`_REVISED` |
| Accept/reject (outcome) | – | quorum | finalize | EF ≥2 indep | Memo `CHALLENGE_ACCEPTED`/`CHALLENGE_REJECTED` |
| Withdraw own (any non-terminal state) | challenger | – | – | EF sig; **not after a final accepted/rejected outcome** | Sig `CHALLENGE_WITHDRAWN` |
| Expire (timeout) | – | – | – | system on `admissibility_ttl_at`/`review_deadline_at`; releases pause | Sys `CHALLENGE_EXPIRED` |

Submission alone never pauses sealing; only `open`/`under_review` do. No non-terminal state is stuck — each has a TTL/escalation path.

## 5. Analyst application & lifecycle

| Operation | self | analyst | senior | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| Submit application version (Path A, v1) | ✅ | – | – | – | EF sig; RLS insert `analyst_applications` + immutable `analyst_application_versions` | Sig `ANALYST_APPLICATION_VERSION_SUBMITTED` |
| Resubmit/revise application (new version) | ✅ | – | – | – | EF; new `analyst_application_versions` (`supersedes_version_id`) | Sig `ANALYST_APPLICATION_VERSION_SUBMITTED` |
| Review application version | – | ✅ | ✅ | ✅ | EF; targets exact `analyst_application_versions.id` | Sig `ANALYST_APPLICATION_REVIEW_CAST`/`_REVISED` |
| Path B derivation | (auto) | – | – | – | server-derived from resolved case | Sys `ANALYST_CANDIDATE` |
| Promote candidate→probationary | – | – | ✅ (future ≥3 senior, flag) | ✅ | EF; **server-derived eligibility**, no discretionary tier | Memo `ANALYST_PROBATION` |
| Verify | – | – | – | ✅ | EF maintainer double-gate | Memo `ANALYST_VERIFIED` |
| Revoke | – | – | – | ✅ | EF maintainer | Memo `ANALYST_REVOKED` |
| **Self-verify** | ❌ | ❌ | ❌ | ❌ | impossible by design | – |

## 6. AI Pack

| Operation | owner | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|
| Generate draft | ✅ (own case) | ✅ | ✅ | EF `osi-ai-pack generate`, server evidence; case/version approved | Sys `PACK_SUBMITTED` |
| Owner feedback (advisory) | ✅ | – | – | EF; writes `ai_pack_owner_feedback` (**not** `ai_pack_reviews`), **uncounted**, owner-only | Sig `AI_PACK_OWNER_FEEDBACK_SUBMITTED` |
| View `content_owner_safe` | ✅ own | ✅ | ✅ | EF authorization | – |
| View `content_analyst_restricted` | ❌ | ✅ | ✅ | EF | – |
| View public brief | public | public | public | RLS (approved) | – |
| Attest support/dispute/request_revision | ❌ own | ✅ (≠creator) | ✅ | EF `ai_pack_reviews`, reviewer≠creator | Sig `AI_PACK_REVIEW_CAST`/`_REVISED` |
| Approve version (outcome) | ❌ | quorum (≠creator) | finalize | EF ≥2 indep, creator excluded | Memo `AI_PACK_APPROVED` |
| Reject version (outcome) | ❌ | quorum (≠creator) | finalize | EF ≥2 indep, creator excluded | Memo `AI_PACK_REJECTED` (class A) |

## 7. Reward & Support

| Operation | owner | wallet | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| Pledge reward | ✅ | – | – | – | EF sig; intent, no custody | Memo `REWARD_PLEDGED` |
| Send reward to winner | ✅ | – | – | – | client tx + EF records on RPC confirm | Memo `REWARD_PAID` |
| Voluntary support author/analyst | – | ✅ | ✅ | ✅ | EF support endpoint, confirmed tx; **no ranking/discovery effect** | Memo `SUPPORT_SENT` |

## 8. Public analyst attribution (correction #14 / D16)
For any **public** governance decision (public Cases, published Reports/Wire Reports, approved AI Packs, resolutions, completed challenges), the public view shows for each participating analyst: **public profile/handle, wallet, decision, weight snapshot used, timestamp, proof type** (`solana_memo` / `wallet_signed_server_verified` / `system_event`), and a public-safe receipt/tx reference. Restricted always: private notes, private evidence, moderation reason detail, sensitive reason text. Pre-open/private queue shows **counts only**.

## 9. The two half-maintainer roles

| Operation | `adm_wallet_only` | `adm_auth_only` | Reason |
|---|---|---|---|
| Any maintainer mutation | ❌ | ❌ | `resolveMaintainerAccess` needs **wallet AND auth**; RLS restricts writes to the maintainer auth UUID |
| Ops Center | locked | locked | double-gate |

## 10. Service role
`service` (Edge Function service-role key) is the only writer for publication, review tallies, resolution finalization, pack storage, reputation snapshots, and **all `event_receipts` inserts** (server-only Proof Log write — closes the current anon-writable gap). Never in client code. RLS denies anon/user writes to these.

## 11. Enforcement summary
Signature-verified identity for all owner/analyst actions (ed25519, purpose+target+payload-hash bound, server-issued nonce, freshness). Analyst authorization = server `analyst_profiles` lookup. Maintainer = double-gate + auth-UUID RLS. Quorum/weight computed server-side. Pending privacy = RLS default-deny + owner-proof Edge path. No support-based ranking anywhere.
