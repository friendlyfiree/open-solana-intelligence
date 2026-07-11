# OSI V2 — Memo & Event Specification

**Status:** Blueprint / design-only. **No existing memo formats are changed by this document.** This defines the *target* canonical grammar (`OSI2`) and how the three current grammars (`OSI1|` signed events, `OSI1|SUPPORT_SENT`, legacy `OSI_*`) migrate. Replay protection and server-verified authenticity are a later stage; the grammar below is forward-compatible with them.

---

## 1. Canonical grammar (`OSI2`)

One pipe-delimited, versioned, privacy-preserving format for **on-chain memos**:

```
OSI2|<ver>|<event_type>|t=<target_type>|id=<target_ref>|a=<actor_wallet>|r=<actor_role>|d=<decision>|n=<nonce>|h=<payload_hash>|ts=<unix>
```

| Field | Meaning | Rules |
|---|---|---|
| `ver` | grammar version | integer, starts `1` |
| `event_type` | see registry §4 | UPPER_SNAKE |
| `t` target_type | `case`/`report`/`wire`/`challenge`/`pack`/`reward`/`analyst`/`config` | enum |
| `id` target_ref | **short public ref** (e.g. `OSI-7F3A2C`), never the private uuid, never narrative | ≤ 24 chars |
| `a` actor_wallet | signer base58 | – |
| `r` actor_role | `owner`/`analyst`/`senior`/`maintainer`/`service` | enum |
| `d` decision | `approve`/`reject`/`open`/`resolve`/`seal`/`paid`/… or empty | enum/empty |
| `n` nonce | replay nonce **placeholder** (Stage-5) | random; server tracks later |
| `h` payload_hash | sha256 of the off-chain payload (reason codes, ids) — proves integrity **without revealing content** | hex |
| `ts` | unix seconds | – |

The **full payload** (reason codes, related ids, weights) lives off-chain in `event_receipts.*` and is hashed into `h`. The memo is a minimal, privacy-safe pointer.

### Privacy rules (hard)
The memo (and any public field) must **never** contain: incident narrative, allegations, personal data, private evidence, private messages, seed phrases, private keys, analyst notes, reward amounts tied to identity, or `subject_refs` framed as guilt. `id` is a public ref only; content is referenced by hash.

## 2. Three transport classes

| Class | When | Mechanism |
|---|---|---|
| **A — Solana memo tx** | governance-relevant, publicly anchored actions | real `SystemProgram`/Memo tx; `tx_sig` recorded after confirmation |
| **B — signMessage only** | authenticated intent that needn't be on-chain-anchored (reviews, attestations, owner-status proofs) | ed25519 `signMessage`; verified server-side; `event_receipts.signature` set |
| **C — server receipt only** | system transitions (windows elapsing, staleness, snapshots) | no user signature; `event_receipts{actor_role:service}` |

`server_verified` (default false) is reserved for the Stage-5 server-side receipt-authenticity upgrade; the grammar already carries `n` and `h` to support it.

## 3. Transport class per action

| Action | Class | Memo? | Rationale |
|---|---|---|---|
| Case submission | A | ✅ | anchor the intent publicly |
| Case initial open | A | ✅ | governance-relevant |
| Report submission | A | ✅ | matches current REPORT_SUBMITTED |
| Report review (approve/reject/revision/abstain) | **B** | ❌ | per-review; anchoring every vote on-chain is costly & noisy — signMessage + hashed receipt is sufficient and cheaper |
| Report publication (quorum finalize) | A | ✅ | the *outcome* is anchored |
| Resolution proposed / winning selected | A | ✅ | governance |
| Challenge opened | A | ✅ | pauses sealing — must be public |
| Challenge reviewed | B | ❌ | per-vote |
| Challenge accepted/rejected (final) | A | ✅ | outcome |
| Case resolved / sealed / reopened / halted | A | ✅ | governance |
| Analyst application | B | ❌ | intent, not yet authoritative |
| Analyst verified/revoked | A | ✅ | authority change, anchor it |
| AI Pack generation | C/B | ❌ | not a truth decision (P8) |
| AI Pack attestation | B | ❌ | per-review |
| AI Pack approval | A | ✅ | governance outcome |
| Reward pledged | A | ✅ | public commitment |
| Reward paid | A | ✅ | anchor the confirmed payment tx (already a tx) |
| Voluntary support | A | ✅ | it is already a transfer tx (memo `SUPPORT_SENT`) |
| Config change | A | ✅ | maintainer authority |
| Window elapsed / staleness / snapshot | C | ❌ | system |

## 4. Event type registry (target `OSI2`)

`CASE_SUBMITTED, CASE_OPENED, CASE_QUORUM_READY, RESOLUTION_PROPOSED, REPORT_SELECTED_WINNING, CASE_RESOLVED, RECORD_SEALED, CASE_REOPENED, CASE_HALTED, CASE_INITIAL_REJECTED, REPORT_SUBMITTED, REPORT_REVIEWED, REPORT_PUBLISHED, REPORT_UNPUBLISHED, REPORT_REJECTED, REPORT_REVISION, WIRE_SUBMITTED, WIRE_REVIEWED, WIRE_PUBLISHED, WIRE_PROMOTED, CHALLENGE_OPENED, CHALLENGE_REVIEWED, CHALLENGE_ACCEPTED, CHALLENGE_REJECTED, ANALYST_APPLIED, ANALYST_CANDIDATE, ANALYST_PROBATION, ANALYST_VERIFIED, ANALYST_SENIOR, ANALYST_REVOKED, PACK_SUBMITTED, PACK_SUPPORTED, PACK_DISPUTED, ESCALATION_PACK_APPROVED, PACK_ATTACHED, PACK_SUPERSEDED, PACK_STALE, REWARD_PLEDGED, REWARD_ASSIGNED, REWARD_PAID, SUPPORT_SENT, CONFIG_CHANGED.`

## 5. Migration from current grammars

Current production emits three grammars (see the prior audit): (a) `OSI1|<TYPE>|case=|report=|actor=|role=|ts=` signed events; (b) `OSI1|SUPPORT_SENT|from=|to=|amount=|ts=`; (c) legacy `OSI_ANALYST_VOUCH|…`, `OSI_CHALLENGE_FILED|…`, `OSI_CASE_BACKED|…`.

Migration principles (documentation-only; no code change now):
- **Never rewrite historical on-chain memos** — they are immutable on Solana. The Proof Log renderer must keep recognizing all legacy formats (backward-compatible parser).
- **New writes** (post-cutover) use `OSI2`. The `event_receipts` table stores `event_version` so old (`OSI1`/legacy) and new (`OSI2`) coexist.
- **Reader mapping:** legacy `analyst_vouch`→`REPORT_REVIEWED`, `demand_signal`/`OSI_CASE_BACKED`→(informational; not a governance vote), `support`→`SUPPORT_SENT`, `maintainer_seal`→`RECORD_SEALED`. The V2 Proof Log presents a unified timeline over both.
- **`OSI_CASE_BACKED` subject leak:** the legacy boost memo embeds `subject=<target text>`. V2 `OSI2` removes narrative from memos entirely; the migration retires that memo type (backing/boost becomes a class-C receipt or is dropped per Open Decision).
- **`case=`/`report=` id fields:** legacy used raw ids; V2 uses `id=<public_ref>` only (no private uuid, no free text).

## 6. Off-chain payload (`event_receipts`) shape
`{ event_version, event_type, target_type, target_id(uuid, private), public_ref, actor_wallet, actor_role, decision, reason_code, related_ids[], weight, nonce, payload_hash, tx_sig?, signature?, server_verified, occurred_at }`. Only `public_ref`, `event_type`, `actor_role`, `decision`, `occurred_at`, `tx_sig` are ever exposed publicly; uuids, reason_code, and weights stay restricted.

## 7. Truthfulness rules for Proof Log rendering
- A row with a `tx_sig` may be labeled "Memo-anchored on Solana" **only** if a `tx_sig` exists; class-B/C rows are labeled "wallet-signed" or "system event" — never "on-chain."
- `server_verified=false` rows (all of them until Stage-5) must not be presented as cryptographically server-attested; the Proof Log is provenance, not verdict (P6).
- No row implies guilt, truth, or legal outcome.
