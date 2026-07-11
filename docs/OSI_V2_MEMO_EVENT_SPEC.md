# OSI V2 — Memo & Event Specification

**Status:** Blueprint / design-only. **No existing memo formats are changed by this document.** Defines the target `OSI2` grammar and the **hybrid signature model** (locked decision D15): individual analyst decisions use `signMessage` + server-verified receipts; final public governance outcomes are Solana-Memo-anchored.

---

## 1. Hybrid signature model (D15 — locked)

**Individual analyst/owner decisions do NOT require a separate Solana transaction.** They use:
1. wallet `signMessage`, 2. a **server-issued single-use nonce**, 3. an exact purpose string, 4. an exact target id/version, 5. an exact payload hash, 6. a freshness/expiry window, 7. server-side ed25519 verification, 8. server-side analyst-role verification, 9. an immutable **server-verified `event_receipts` row** (`server_verified=true`, `proof_type=wallet_signed_server_verified`).

**Public governance outcomes remain Solana-Memo-anchored** (`proof_type=solana_memo`, a real tx with `tx_sig`).

**The Proof Log distinguishes exactly four proof types** and never conflates them:
- `solana_memo` — "Memo-anchored on Solana" (real `tx_sig`).
- `wallet_signed_server_verified` — "Wallet-signed & server-verified" (signMessage receipt; **never** labeled on-chain).
- `system_event` — "System event."
- `legacy_imported` — "Legacy / not server-verified" (imported V1/legacy).

Optional future **batch/Merkle-root anchoring** of server-verified receipts is documented as a future enhancement (§8); it is **not required** for the first V2 release.

## 2. Canonical grammar (`OSI2`)

For **Memo-anchored** outcomes (transport class A), the on-chain memo:
```
OSI2|<ver>|<event_type>|t=<target_type>|id=<target_ref>|a=<actor_wallet>|r=<actor_role>|d=<decision>|n=<nonce>|h=<payload_hash>|ts=<unix>
```
For **signMessage** decisions (class B) the *signed message* uses the same field set (purpose = `event_type`), verified server-side; no memo tx is created — a server-verified receipt is written instead.

| Field | Meaning | Rules |
|---|---|---|
| `ver` | grammar version | integer, starts `1` |
| `event_type` | see registry §4 | canonical UPPER_SNAKE |
| `t` target_type | `case`/`report_version`/`wire_version`/`resolution`/`challenge`/`pack_version`/`pack_owner_feedback`/`analyst`/`application_version`/`reward`/`config` | enum |
| `id` target_ref | **short public ref** (e.g. `OSI-7F3A2C`) or version ref, never private uuid, never narrative | ≤ 24 chars |
| `a` actor_wallet | signer base58 | – |
| `r` actor_role | `owner`/`analyst`/`senior`/`maintainer`/`service` | enum |
| `d` decision | e.g. `approve`/`reject`/`open`/`resolve`/`seal`/`paid` or empty | enum/empty |
| `n` nonce | **server-issued single-use** (Stage-5 enforced) | consumed once |
| `h` payload_hash | sha256 of the off-chain payload (reason codes, ids, exact version) | hex |
| `ts` | unix seconds | – |

### Privacy rules (hard)
Memos and any public field **never** contain: incident narrative, allegations, personal data, private evidence, private messages, seed phrases, private keys, analyst notes, or `subject_refs` framed as guilt. `id` is a public ref only; content is referenced by `h`.

## 3. Transport class per action

Each canonical event has **exactly one** class (A / B / Sys) — no `A or Sys`, `Sys/Memo`, or `Memo/Sig` alternatives anywhere.

| Action | Class | Proof type | Memo? |
|---|---|---|---|
| Case submission | A | solana_memo | ✅ `CASE_SUBMITTED` |
| Case opening | A | solana_memo | ✅ `CASE_OPENED` |
| Case safety block | A | solana_memo | ✅ `CASE_SAFETY_BLOCKED` (auditable maintainer/policy action; carries only refs+hash, no narrative; the blocked Case content stays private) |
| Case initial review (per analyst) | B | wallet_signed_server_verified | ❌ `CASE_INITIAL_REVIEW_CAST` / `_REVISED` |
| Case initial rejection (outcome) | A | solana_memo | ✅ `CASE_INITIAL_REVIEW_REJECTED` |
| **Case Report version submission (v1 & every revision)** | A | solana_memo | ✅ `CASE_REPORT_VERSION_SUBMITTED` |
| Report review (per analyst) | B | wallet_signed_server_verified | ❌ `CASE_REPORT_REVIEW_CAST` / `_REVISED` |
| Report publication (outcome) | A | solana_memo | ✅ `REPORT_PUBLISHED` |
| **Report rejection (outcome)** | A | solana_memo | ✅ `REPORT_REJECTED` |
| **Wire Report version submission (v1 & every revision)** | A | solana_memo | ✅ `WIRE_REPORT_VERSION_SUBMITTED` |
| Wire review (per analyst) | B | wallet_signed_server_verified | ❌ `WIRE_REPORT_REVIEW_CAST` / `_REVISED` |
| Wire publication (outcome) | A | solana_memo | ✅ `WIRE_REPORT_PUBLISHED` |
| Wire promoted to a new Case | A | solana_memo | ✅ `WIRE_PROMOTED` |
| Resolution review (per analyst) | B | wallet_signed_server_verified | ❌ `RESOLUTION_REVIEW_CAST` / `_REVISED` |
| Resolution proposed / winner selected | A | solana_memo | ✅ `RESOLUTION_PROPOSED`, `REPORT_SELECTED_WINNING` |
| Challenge submitted | B | wallet_signed_server_verified | ❌ `CHALLENGE_SUBMITTED` |
| Challenge admissibility accepted | B | wallet_signed_server_verified | ❌ `CHALLENGE_ADMISSIBILITY_ACCEPTED` |
| Challenge admissibility rejected | B | wallet_signed_server_verified | ❌ `CHALLENGE_ADMISSIBILITY_REJECTED` |
| Challenge review (per analyst) | B | wallet_signed_server_verified | ❌ `CHALLENGE_REVIEW_CAST` / `_REVISED` |
| Challenge withdrawn | B | wallet_signed_server_verified | ❌ `CHALLENGE_WITHDRAWN` |
| Challenge expired (timeout) | Sys | system_event | ❌ `CHALLENGE_EXPIRED` |
| Challenge accepted/rejected (outcome) | A | solana_memo | ✅ `CHALLENGE_ACCEPTED` / `CHALLENGE_REJECTED` |
| Case resolved/reopened/sealed/halted | A | solana_memo | ✅ `CASE_RESOLVED`/`CASE_REOPENED`/`RECORD_SEALED`/`CASE_HALTED` |
| **Analyst application version submission (v1 & revisions)** | B | wallet_signed_server_verified | ❌ `ANALYST_APPLICATION_VERSION_SUBMITTED` |
| **Analyst application review (per reviewer)** | B | wallet_signed_server_verified | ❌ `ANALYST_APPLICATION_REVIEW_CAST` / `_REVISED` |
| Analyst probation/senior (lifecycle) | A | solana_memo | ✅ `ANALYST_PROBATION` / `ANALYST_SENIOR` |
| Analyst verified/revoked (outcome) | A | solana_memo | ✅ `ANALYST_VERIFIED` / `ANALYST_REVOKED` |
| AI Pack generation | Sys | system_event | ❌ `PACK_SUBMITTED` (not a truth decision) |
| AI Pack review (per analyst) | B | wallet_signed_server_verified | ❌ `AI_PACK_REVIEW_CAST` / `_REVISED` |
| **AI Pack owner feedback (advisory, uncounted)** | B | wallet_signed_server_verified | ❌ `AI_PACK_OWNER_FEEDBACK_SUBMITTED` |
| AI Pack approval (outcome) | A | solana_memo | ✅ `AI_PACK_APPROVED` |
| **AI Pack rejection (outcome)** | A | solana_memo | ✅ `AI_PACK_REJECTED` (single proof class — correction #7) |
| AI Pack attach / supersede / stale | Sys | system_event | ❌ `PACK_ATTACHED`/`PACK_SUPERSEDED`/`PACK_STALE` |
| Owner status proof read | B | wallet_signed_server_verified | ❌ `OWNER_STATUS_PROOF` |
| Reward pledged / paid | A | solana_memo | ✅ `REWARD_PLEDGED` / `REWARD_PAID` |
| Voluntary support | A | solana_memo | ✅ `SUPPORT_SENT` (already a transfer tx) |
| Config change | A | solana_memo | ✅ `CONFIG_CHANGED` |

## 4. Canonical event-type registry (`OSI2`)

**Server-verified signMessage receipts (class B):**
`CASE_INITIAL_REVIEW_CAST, CASE_INITIAL_REVIEW_REVISED, CASE_REPORT_REVIEW_CAST, CASE_REPORT_REVIEW_REVISED, WIRE_REPORT_REVIEW_CAST, WIRE_REPORT_REVIEW_REVISED, RESOLUTION_REVIEW_CAST, RESOLUTION_REVIEW_REVISED, CHALLENGE_SUBMITTED, CHALLENGE_ADMISSIBILITY_ACCEPTED, CHALLENGE_ADMISSIBILITY_REJECTED, CHALLENGE_REVIEW_CAST, CHALLENGE_REVIEW_REVISED, CHALLENGE_WITHDRAWN, AI_PACK_REVIEW_CAST, AI_PACK_REVIEW_REVISED, AI_PACK_OWNER_FEEDBACK_SUBMITTED, ANALYST_APPLICATION_VERSION_SUBMITTED, ANALYST_APPLICATION_REVIEW_CAST, ANALYST_APPLICATION_REVIEW_REVISED, OWNER_STATUS_PROOF.`

**Solana-Memo-anchored outcomes (class A):**
`CASE_SUBMITTED, CASE_OPENED, CASE_SAFETY_BLOCKED, CASE_INITIAL_REVIEW_REJECTED, CASE_REPORT_VERSION_SUBMITTED, REPORT_PUBLISHED, REPORT_REJECTED, WIRE_REPORT_VERSION_SUBMITTED, WIRE_REPORT_PUBLISHED, WIRE_PROMOTED, RESOLUTION_PROPOSED, REPORT_SELECTED_WINNING, CHALLENGE_ACCEPTED, CHALLENGE_REJECTED, CASE_RESOLVED, CASE_REOPENED, RECORD_SEALED, CASE_HALTED, ANALYST_PROBATION, ANALYST_SENIOR, ANALYST_VERIFIED, ANALYST_REVOKED, AI_PACK_APPROVED, AI_PACK_REJECTED, REWARD_PLEDGED, REWARD_PAID, SUPPORT_SENT, CONFIG_CHANGED.`

**System events (class Sys):**
`CASE_QUORUM_READY, CHALLENGE_EXPIRED, PACK_SUBMITTED, PACK_ATTACHED, PACK_SUPERSEDED, PACK_STALE, REWARD_ASSIGNED, ANALYST_CANDIDATE.`

These names are **canonical and identical** across all documents, each with **exactly one** class. No old name is retained once a canonical name is chosen. Notable resolutions in this revision (correction #10): `CASE_REPORT_VERSION_SUBMITTED` / `WIRE_REPORT_VERSION_SUBMITTED` replace the ambiguous generic `REPORT_SUBMITTED`; `REPORT_REJECTED` and `AI_PACK_REJECTED` are **class A** governance outcomes (no longer "Sys/Memo"); `CASE_SAFETY_BLOCKED` is **class A** (no longer "A or Sys"); `CHALLENGE_EXPIRED` is the single `Sys` timeout event; `ANALYST_APPLICATION_VERSION_SUBMITTED` + `ANALYST_APPLICATION_REVIEW_CAST`/`_REVISED` replace `ANALYST_APPLICATION_SUBMITTED`/`ANALYST_APPLICATION_REVIEWED`. `CASE_SAFETY_BLOCKED` (moderation) and `CASE_INITIAL_REVIEW_REJECTED` (factual) are **never** used interchangeably.

## 5. Migration from current grammars
Current production emits three grammars: (a) `OSI1|<TYPE>|case=|report=|actor=|role=|ts=`; (b) `OSI1|SUPPORT_SENT|from=|to=|amount=|ts=`; (c) legacy `OSI_ANALYST_VOUCH|…`, `OSI_CHALLENGE_FILED|…`, `OSI_CASE_BACKED|…`.
- **Never rewrite historical on-chain memos.** The Proof Log parser accepts OSI1 + legacy `OSI_*` + OSI2 permanently.
- Imported rows → `event_receipts{event_version:OSI1|legacy, server_verified:false, proof_type:legacy_imported}`.
- Reader mapping (display only): legacy `analyst_vouch`→`CASE_REPORT_REVIEW_CAST`, `support`→`SUPPORT_SENT`, `maintainer_seal`→`RECORD_SEALED`, and any generic legacy report-submission memo → `CASE_REPORT_VERSION_SUBMITTED` / `WIRE_REPORT_VERSION_SUBMITTED` by lane. The ambiguous generic `REPORT_SUBMITTED` name is **retired** for new writes; **new OSI2 writes use only the canonical names** in §4 — legacy parsing maps old names for display but never emits them.
- **`OSI_CASE_BACKED` retired** (D9): it embeds `subject=<target text>`; V2 removes narrative from memos. Any replacement demand signal is a class-Sys receipt with **no subject text and no governance/ranking consequence**.

## 6. Off-chain payload (`event_receipts`)
`{ event_version, event_type, target_type, target_id(uuid private), public_ref, actor_wallet, actor_role, decision, reason_code, related_ids[], weight, nonce, payload_hash, proof_type, tx_sig?, signature?, server_verified, occurred_at }`. Public projection exposes only `public_ref, event_type, actor_wallet, actor_role, decision, weight (for public decisions, correction #14), proof_type, tx_sig, occurred_at`; uuids/reason_code stay restricted.

## 7. Truthfulness rules for the Proof Log
- Label a row on-chain **only** if `proof_type=solana_memo` with a real `tx_sig`.
- `wallet_signed_server_verified` rows are "wallet-signed & server-verified," never on-chain.
- `legacy_imported` rows (`server_verified=false`) are labeled "legacy / not server-verified."
- No row implies guilt, truth, or legal outcome (P6).

## 8. Future enhancement (not first release)
Server-verified receipts may later be batched and anchored via a periodic Merkle root memo, giving class-B decisions an optional on-chain inclusion proof without a per-decision tx. Documented only; out of scope for V2.1.
