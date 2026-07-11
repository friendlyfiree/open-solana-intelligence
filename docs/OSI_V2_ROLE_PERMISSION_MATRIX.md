# OSI V2 — Role & Permission Matrix

**Status:** Blueprint / design-only. Every privileged row names a **server-side enforcement point**. A hidden or disabled button is never authorization (P10).

## Roles

| Role | Definition |
|---|---|
| `anon` | not connected |
| `wallet` | connected ordinary Phantom wallet |
| `case_owner` | proven `submitted_by_wallet` of a case |
| `report_author` | proven `author_wallet` of a case/wire report |
| `wire_author` | proven author of a wire report |
| `contributor` | ≥1 accepted contribution, no voting power |
| `candidate` | `analyst_candidate` (Path B derived) |
| `probationary` | `probationary_analyst`, weight 0.50 |
| `analyst` | `verified_analyst` (verified=true, approved=true) |
| `senior` | `senior_analyst` (higher cap, quorum-eligible) |
| `adm_wallet_only` | admin wallet connected, **no** Supabase auth |
| `adm_auth_only` | Supabase maintainer session, **wrong** wallet |
| `maintainer` | admin wallet **AND** Supabase auth (double-gate) |
| `service` | Edge Function service-role (server only) |

**Server enforcement legend:** `EF=osi-*` Edge Function verifies (wallet signature and/or Supabase JWT + `analyst_profiles`/maintainer); `RLS` = row policy; `EF+RLS` both. Client checks are UX-only.

---

## 1. Case operations

| Operation | anon | wallet | case_owner | analyst | senior | maintainer | Server enforcement | Signature | Proof Log | Public effect |
|---|---|---|---|---|---|---|---|---|---|---|
| View public (open+) case | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | RLS (visibility=public) | – | – | – |
| View own private case | – | – | ✅ (proof) | ✅ | ✅ | ✅ | EF owner-proof / analyst / maintainer | signMessage | – | – |
| Submit case | – | ✅ | (becomes owner) | ✅ | ✅ | ✅ | EF verify sig; RLS insert visibility=private | memo | `CASE_SUBMITTED` | none |
| Initial approve→open | – | – | ❌ (own) | ✅ | ✅ | ✅ | EF analyst/maintainer; **owner excluded** | memo | `CASE_OPENED` | case public |
| Propose resolution | – | – | ❌ decisive | ✅ (quorum) | ✅ | ✅ finalize | EF ≥2 indep + maintainer | memo | `RESOLUTION_PROPOSED` | winner shown |
| Seal | – | – | – | quorum-only via fallback | – | ✅ | EF ≥2 indep + maintainer | memo | `RECORD_SEALED` | sealed badge |
| Emergency halt | – | – | – | – | – | ✅ (or fallback) | EF maintainer | memo | `CASE_HALTED` | frozen |
| Reopen | – | – | appeal | quorum | quorum | ✅ | EF ≥2 indep | memo | `CASE_REOPENED` | reopened |

## 2. Report operations

| Operation | anon | wallet | author | analyst | maintainer | Enforcement | Sig | Proof Log |
|---|---|---|---|---|---|---|---|---|
| Submit report to open case | – | ✅ | ✅ | ✅ | ✅ | EF sig; RLS insert private | memo | `REPORT_SUBMITTED` |
| View pending report | – | – | ✅ (proof) | ✅ | ✅ | EF owner-proof/analyst/maintainer | signMessage | – |
| Review report | – | – | ❌ own | ✅ | ✅ | EF verify analyst; **author≠reviewer**; RLS | signMessage(+memo) | `REPORT_REVIEWED` |
| Publish report | – | – | ❌ | quorum | finalize | EF ≥2 indep + weight | memo | `REPORT_PUBLISHED` |
| Unpublish | – | – | – | quorum | ✅ | EF ≥2 indep | memo | `REPORT_UNPUBLISHED` |
| Select winning | – | – | ❌ | quorum | ✅ | EF ≥2 indep + maintainer | memo | `REPORT_SELECTED_WINNING` |

## 3. Wire operations

| Operation | wallet | wire_author | analyst | maintainer | Enforcement | Proof Log |
|---|---|---|---|---|---|---|
| Submit wire report | ✅ | (becomes author) | ✅ | ✅ | EF sig | `WIRE_SUBMITTED` |
| Review wire report | ✅→❌ own | ❌ own | ✅ | ✅ | EF analyst; **author excluded** | `WIRE_REVIEWED` |
| Publish wire report | – | ❌ | quorum | finalize | EF ≥2 indep + weight | `WIRE_PUBLISHED` |
| Promote to case | – | – | ✅ | ✅ | EF analyst/maintainer | `WIRE_PROMOTED` |
| Support wire author | ✅ | – | ✅ | ✅ | EF (support endpoint) | `SUPPORT_SENT` |

## 4. Challenge operations

| Operation | wallet | analyst | maintainer | Enforcement | Sig | Proof Log |
|---|---|---|---|---|---|---|
| Open challenge | ✅ | ✅ | ✅ | EF sig + reason + evidence_ref | memo | `CHALLENGE_OPENED` |
| Judge challenge | – | ✅ | ✅ | EF analyst quorum | signMessage | `CHALLENGE_REVIEWED` |
| Accept/reject (final) | – | quorum | finalize | EF ≥2 indep | memo | `CHALLENGE_ACCEPTED/REJECTED` |
| Withdraw own | challenger | – | – | EF sig | – | receipt |

## 5. Analyst lifecycle

| Operation | self | analyst | senior | maintainer | Enforcement | Notes |
|---|---|---|---|---|---|---|
| Apply (Path A) | ✅ | – | – | – | EF sig; RLS insert `analyst_profiles{status:candidate,verified:false}` | no weight |
| Path B derivation | (auto) | – | – | – | server-derived from resolved case | never auto-verifies |
| Promote candidate→probationary | – | – | ✅(≥2) | ✅ | EF senior-quorum or maintainer | weight 0.50 |
| Verify | – | – | – | ✅ | EF maintainer double-gate | `ANALYST_VERIFIED` |
| Revoke | – | – | – | ✅ | EF maintainer | freezes reviews |
| **Self-verify** | ❌ | ❌ | ❌ | ❌ | impossible by design | P3 |

## 6. AI Pack operations

| Operation | case_owner | analyst | maintainer | Enforcement | Proof Log |
|---|---|---|---|---|---|
| Generate draft | ✅ (own case, server evidence) | ✅ | ✅ | EF `osi-ai-pack generate`; report/case approved | none (no memo) |
| View restricted content | ✅ (own case) | ✅ | ✅ | EF `get` — **owner/analyst/maintainer only** | – |
| View public brief | public | public | public | RLS/public_meta (approved only) | – |
| Attest support/dispute | ❌ own | ✅ (not own creation) | ✅ | EF `ai_pack_reviews`, reviewer≠creator | receipt |
| Approve pack | ❌ own | quorum (not own) | finalize | EF ≥2 indep (creator excluded) | `ESCALATION_PACK_APPROVED` |
| Download restricted | ✅ own | ✅ | ✅ | EF authorization | – |

**Owner restriction:** case owner may generate/view/download their pack but **cannot** approve it or contribute analyst confidence weight (Constitution §14).

## 7. Reward & Support

| Operation | case_owner | wallet | analyst | maintainer | Enforcement | Proof Log |
|---|---|---|---|---|---|---|
| Pledge reward | ✅ | – | – | – | EF sig; records intent (no custody) | `REWARD_PLEDGED` |
| Send reward (to winner) | ✅ | – | – | – | client tx + EF records on **RPC confirm** | `REWARD_PAID` |
| Voluntary support (author/analyst) | – | ✅ | ✅ | ✅ | EF support endpoint, confirmed tx | `SUPPORT_SENT` |
| Cancel pledge (pre-assign) | ✅ | – | – | – | EF | receipt |

## 8. The two "half-maintainer" roles (critical)

| Operation | `adm_wallet_only` | `adm_auth_only` | Reason |
|---|---|---|---|
| Any maintainer mutation | ❌ | ❌ | `resolveMaintainerAccess` requires **wallet AND Supabase auth**; server RLS restricts writes to the maintainer auth UUID |
| See Ops Center | ❌ (locked) | ❌ (locked) | double-gate |

Both are treated exactly as an ordinary connected wallet until **both** conditions hold. This preserves the current double-gate.

## 9. Service role
`service` (Edge Function service-role key) is the only writer for: publication, review tallies, pack storage, reputation snapshots, and Proof Log receipts. **Never present in client code.** RLS denies anon/user writes to these; the Edge Function is the single authorization funnel.

## 10. Enforcement summary
- **Signature-verified identity** for all owner/analyst actions (ed25519, purpose-bound, freshness window; Stage-5 replay binding compatible).
- **Analyst authorization** = server lookup `analyst_profiles.verified AND approved AND status active`, never client state.
- **Maintainer** = double-gate + RLS-restricted auth UUID.
- **Quorum/weight** computed server-side from `reviews`/`analyst_reputation_snapshots`; the client cannot assert a threshold met.
- **Pending privacy** = RLS default-deny + owner-proof Edge path; no broad public SELECT on private rows.
