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
| Safety block | – | – | – | – | – | ✅ / server policy | EF maintainer/policy | Memo/Sys `CASE_SAFETY_BLOCKED` | private neutral notice |
| Normal initial reject | – | – | ❌ | quorum | quorum | ✅ | EF ≥2 indep | Memo `CASE_INITIAL_REVIEW_REJECTED` | private; appeal |
| Propose resolution | – | – | ❌ decisive | quorum | ✅ | ✅ finalize | EF ≥2 indep + maintainer | Memo `RESOLUTION_PROPOSED` | winner shown |
| Seal | – | – | – | fallback-only | – | ✅ | EF ≥2 indep + maintainer | Memo `RECORD_SEALED` | sealed badge |
| Halt (emergency) | – | – | – | – | – | ✅/fallback | EF maintainer | Memo `CASE_HALTED` | frozen |
| Reopen | – | – | appeal | quorum | quorum | ✅ | EF ≥2 indep | Memo `CASE_REOPENED` | reopened |

## 2. Report + versions

| Operation | wallet | author | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| Submit report / new version | ✅ | ✅ | ✅ | ✅ | EF sig; RLS insert private version | Memo `REPORT_SUBMITTED` (v1) / Sig (revisions) |
| View pending version | – | ✅ (proof) | ✅ | ✅ | EF owner-proof/analyst/maintainer | Sig |
| Review exact version | – | ❌ own | ✅ | ✅ | EF verify analyst; **author≠reviewer**; targets `case_report_versions.id` | Sig `CASE_REPORT_REVIEW_CAST`/`_REVISED` |
| Publish version (outcome) | – | ❌ | quorum | finalize | EF ≥2 indep + weight | Memo `REPORT_PUBLISHED` |
| Unpublish | – | – | quorum | ✅ | EF ≥2 indep | Memo `REPORT_UNPUBLISHED`* |
| Select winning version | – | ❌ | quorum | ✅ | EF ≥2 indep + maintainer; exact version | Memo `REPORT_SELECTED_WINNING` |

*`REPORT_UNPUBLISHED` is a class-A outcome if used; retained from V1 semantics.

## 3. Wire

| Operation | wallet | wire_author | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| Submit wire report / version | ✅ | (author) | ✅ | ✅ | EF sig | Memo `REPORT_SUBMITTED`-equiv |
| Review exact wire version | ✅→❌ own | ❌ own | ✅ | ✅ | EF; **author excluded** | Sig `WIRE_REPORT_REVIEW_CAST`/`_REVISED` |
| Publish (outcome) | – | ❌ | quorum | finalize | EF ≥2 indep + weight | Memo `WIRE_REPORT_PUBLISHED` |
| Promote to case | – | – | ✅ | ✅ | EF analyst/maintainer | Memo `WIRE_PROMOTED` |
| Support author | ✅ | – | ✅ | ✅ | EF support endpoint | Memo `SUPPORT_SENT` (no ranking effect) |

## 4. Challenge (admissibility gate)

| Operation | wallet | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|
| Submit challenge | ✅ | ✅ | ✅ | EF sig + reason + evidence_ref + rate-limit + one-active + cooldown | Sig `CHALLENGE_SUBMITTED` |
| Accept admissibility (→ pauses sealing) | – | ✅ | ✅ | EF analyst/maintainer | Sig `CHALLENGE_ADMISSIBILITY_ACCEPTED` |
| Judge (per analyst) | – | ✅ | ✅ | EF analyst | Sig `CHALLENGE_REVIEW_CAST`/`_REVISED` |
| Accept/reject (outcome) | – | quorum | finalize | EF ≥2 indep | Memo `CHALLENGE_ACCEPTED`/`CHALLENGE_REJECTED` |
| Withdraw own | challenger | – | – | EF sig | Sig |

Submission alone never pauses sealing; only `open`/`under_review` do.

## 5. Analyst application & lifecycle

| Operation | self | analyst | senior | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|---|
| Submit application (Path A) | ✅ | – | – | – | EF sig; RLS insert `analyst_applications` | Sig `ANALYST_APPLICATION_SUBMITTED` |
| Resubmit/revise application | ✅ | – | – | – | EF | Sig |
| Review application | – | ✅ | ✅ | ✅ | EF | Sig `ANALYST_APPLICATION_REVIEWED` |
| Path B derivation | (auto) | – | – | – | server-derived from resolved case | Sys `ANALYST_CANDIDATE` |
| Promote candidate→probationary | – | – | ✅ (future ≥3 senior, flag) | ✅ | EF; **server-derived eligibility**, no discretionary tier | Memo `ANALYST_PROBATION` |
| Verify | – | – | – | ✅ | EF maintainer double-gate | Memo `ANALYST_VERIFIED` |
| Revoke | – | – | – | ✅ | EF maintainer | Memo `ANALYST_REVOKED` |
| **Self-verify** | ❌ | ❌ | ❌ | ❌ | impossible by design | – |

## 6. AI Pack

| Operation | owner | analyst | maintainer | Enforcement | Proof |
|---|---|---|---|---|---|
| Generate draft | ✅ (own case) | ✅ | ✅ | EF `osi-ai-pack generate`, server evidence; case/version approved | Sys `PACK_SUBMITTED` |
| Owner feedback (advisory) | ✅ | – | – | EF; stored outside `ai_pack_reviews`, **uncounted** | Sig (advisory) |
| View `content_owner_safe` | ✅ own | ✅ | ✅ | EF authorization | – |
| View `content_analyst_restricted` | ❌ | ✅ | ✅ | EF | – |
| View public brief | public | public | public | RLS (approved) | – |
| Attest support/dispute/request_revision | ❌ own | ✅ (≠creator) | ✅ | EF `ai_pack_reviews`, reviewer≠creator | Sig `AI_PACK_REVIEW_CAST`/`_REVISED` |
| Approve version (outcome) | ❌ | quorum (≠creator) | finalize | EF ≥2 indep, creator excluded | Memo `AI_PACK_APPROVED` |

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
