# OSI Architecture

A technical map of how Open Solana Intelligence is built and why. For the product rules themselves, see the constitution and the decision register; this document explains the machinery that enforces them.

## Design goals

1. **Process integrity over trust.** Every state transition is attributable to a wallet signature or a confirmed Solana transaction. The system's honesty does not depend on trusting its operator.
2. **Fail closed.** Missing configuration, a failed check, or an unreachable dependency always degrades to "no", never to "yes".
3. **Immutability.** Versions, reviews, and receipts are append-only. Corrections add; nothing rewrites.
4. **Least privilege.** Browsers can read public projections and nothing else. All writes cross a server that independently derives the actor's identity, role, and rights.
5. **No custody.** Money moves wallet to wallet on Solana. The platform can verify transfers but can never make one.

## The stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Static HTML, modular CSS, classic JavaScript | No build step, no framework, no package manifest |
| Wallet | Phantom via injected provider | connect, signMessage, transaction approval |
| Backend | Supabase Edge Functions (Deno) | All privileged logic |
| Database | Supabase PostgreSQL | FORCE row level security, service-only RPCs |
| Chain | Solana mainnet | SPL Memo, System Program, Solana Attestation Service |
| Hosting | Vercel (static) plus Supabase | Git-driven deploys for the frontend |
| AI | Anthropic API, server-side only | Bounded input/output, quota and cost caps |

## Request flow

```
Browser
  |  1. public reads: anonymous POST to a read function, allowlisted DTO out
  |  2. private reads: 5-minute HMAC read-session token (one signMessage)
  |  3. writes: Stage-5 proof (nonce + signature or Memo tx) per action
  v
Edge Function (verify_jwt=false, in-function authorization)
  - derives actor identity from the proof, never from client claims
  - checks the dedicated feature flag (fail closed)
  - checks role/eligibility/conflicts server-side
  |  service-role client, service-only RPC
  v
PostgreSQL (osi_private schema functions)
  - re-validates bindings inside the transaction
  - consumes the nonce atomically with the effect and the receipt
  - enforces no-self-review and lifecycle constraints at the boundary
```

`verify_jwt=false` on the gateway does not mean unauthenticated: each function implements a stricter, purpose-built authorization model than a generic JWT check could express (wallet proofs, read-session validation, maintainer double gate).

## Identity and authorization model

**Wallets are actors.** A base58 wallet address is the identity for every user-facing role. The server verifies possession cryptographically per action; it never trusts a wallet string sent by a client.

**Roles are derived, never claimed.** Analyst status, tier, and weight come from `analyst_profiles`, written only by reviewed activation flows. The maintainer is defined by a configured admin wallet plus an authenticated operator identity; each alone is refused everywhere ("half-maintainer denial").

**Read model.** Public data flows through explicit field allowlists (never `select *`). Private reads use a short-lived signed session: one wallet signature buys a 5-minute token bound to wallet, origin, expiry, and bounded scopes, stored only in memory and sessionStorage. The token can never authorize a write.

**Write model (Stage-5).** Every signed write requires: a cryptographically random single-use server nonce with short expiry; exact purpose, target, and payload-hash binding; server-side Ed25519 verification (class B) or confirmed Memo transaction verification (class A: signer, exact memo text, mainnet genesis hash, finality, freshness); atomic nonce consumption in the same transaction as the effect and receipt; and idempotent retry that returns the original result. Stateless nonce checking is forbidden; the ledger is a durable table.

## Data model

32 domain tables defined by the blueprint (Cases, Reports and versions, Wire Reports and versions, evidence and manifests, seven review tables, resolutions, challenges, analyst tables, AI Pack tables, money tables, receipts, config), plus infrastructure tables (nonce ledger, read nonces, SAS verification state, migration crosswalk). Key invariants, enforced by constraints and triggers:

- Headers and immutable content versions are separate; `current_version_id` tracks the latest submission, `current_published_version_id` moves only through quorum publication.
- A resolution binds permanently to its exact winning version.
- Challenges use typed foreign keys with an exactly-one-target CHECK.
- Reviews are append-only with immutability triggers; a changed vote is a new row.
- Money uses bigint lamports and validated base58/signature formats.
- Every governance receipt carries a `decision_channel` that distinguishes a normal quorum from a labeled bootstrap decision, constrained by CHECK to the outcomes where bootstrap is legal.

## The proof ledger

`event_receipts` is the append-only provenance log. Four proof types (`solana_memo`, `wallet_signed_server_verified`, `system_event`, `legacy_imported`) with `server_verified` true only for native verified events. Class-A outcomes store the transaction signature; the UI links only validated Solscan URLs.

## Governance enforcement

Quorum functions compute count and weight over eligible, non-conflicted, active reviews only, with thresholds read from `osi_config` at decision time. Two-gate rule: both a minimum independent-analyst count and a minimum total weight, so no single actor can decide. Bootstrap mode, when enabled, relaxes only the analyst count/weight requirement for four outcome types (Report publication, Wire publication, winner selection, seal) on a live analyst-count tier ladder, never the maintainer double gate, and never for challenges or AI Pack approval. SAS shadow validation records each reviewing wallet's on-chain credential state per review, preparing for hard enforcement without changing today's outcomes.

## SAS credential subsystem

On-chain: one OSI Credential account and one OSI_VERIFIED_ANALYST schema (tier u8, status u8) under the Solana Attestation Service program, created once by the maintainer wallet. Two authorized signers: the maintainer wallet (manual control, rotation) and a dedicated low-privilege operational issuer whose secret lives only in a server secret and whose only power is issuing/revoking this one credential type. Issuance and revocation fire automatically on tier transitions and never block the underlying activation. Reads are SDK-free (manual PDA derivation plus JSON-RPC) so the public verifier works within Edge runtime constraints; Solana is authoritative and the database is a cache.

## Payments

Server-side verification of finalized mainnet transactions: exact fee payer, exact System Program recipients and lamports from the server-issued intent manifest, canonical memo, freshness window, and replay binding to the intent nonce. Reward payments additionally bind to the sealed Case's frozen pledge and exact winning author; confirmed totals can never exceed the pledge. Support allows up to 4 server-derived recipients per transaction and rejects self-support. Nothing in the money path joins into any governance computation.

## Feature flags

Every capability has a dedicated `osi_config` key read server-side at action time, treating missing/malformed as false. Broad kill switches stay off (`OSI_V2_WRITES_ENABLED`, `OSI_V2_PROOF_ENABLED` are legacy-scoped and false); scoped flags gate each slice (case, analyst, report, review, resolution, payment, read session, wire, AI pack, bootstrap, SAS issuance/enforcement). Rollback is always "turn one flag off", never a schema rollback.

## Delivery pipeline

- **CI (every PR):** dependency-free Node suites, Deno type checks, clean PostgreSQL migration from zero, database lint at error level, full pgTAP, two-connection replay/concurrency, browser contracts at desktop and 390px, stored-XSS regressions.
- **Production rollouts:** typed-confirmation, main-only GitHub Actions workflows, one per slice. Each pins the project ref, verifies current main, re-runs the full validation battery, dry-runs and applies exactly the expected migrations, deploys only the named functions, snapshots every flag and legacy row count before and after, smoke-tests read-only endpoints, and on any failure disables only the slice's flag.

## Repository layout

```
index.html                     application shell
legacy.html                    frozen V1 fallback
assets/css/, assets/js/        design system and behavior modules
supabase/migrations/           ordered additive SQL (never edited in place)
supabase/functions/            Deno gateways + _shared cores
  _shared/*.mjs                dependency-free logic cores (unit-testable in Node)
supabase/tests/                pgTAP suites
tests/                         Node suites, browser E2E, concurrency script
docs/                          constitution, domain model, state machines,
                               role matrix, memo spec, decision register, guides
.github/workflows/             CI + per-slice production rollouts
tools/                         one-time maintainer utilities
```

The `_shared/*.mjs` core-module pattern is deliberate: governance, payment, proof, wire, and SAS decision logic lives in dependency-free ES modules that run identically under Deno (production) and Node (tests), so the exact production logic is what the test battery exercises.
