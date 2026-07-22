# OSI bug and prompt-hardening audit — 2026-07-22

## Scope and baseline

- Branch: `codex/bug-hardening-audit`
- Verified remote `origin/main` baseline: `fcf8d311940f3f716d5c01d4b1eea2b7b1d36a51`
- The task started from stale local tracking commit `c52ec5acb86cbaa511036df831aaec0488328664` while GitHub DNS was unavailable. When connectivity returned, current `origin/main` was fetched and merged without rewriting history before final validation.
- Production project named by the delivery brief: `afibxpniwfnavdobecrn`
- Production URL checked read-only: `https://open-solana-intel.vercel.app`
- No production database, Edge Function, feature flag, secret, or Vercel deployment was changed.

Current `main` includes native V2 AI Pack Phase 1 in a dedicated `osi-v2-ai-pack` gateway. It was audited separately from the legacy V1 `osi-ai-pack` endpoint. The native slice has immutable Case-bound versions, three isolated evidence layers, exact manifest hashes, Stage-5 proofs, durable provider reservations, quota/cooldown controls, independent review quorum, class-A maintainer approval, minimized DTOs, and dedicated fail-closed flags. The unsafe legacy lane remains read-only and cannot generate, approve, or seal.

## Findings register

| ID | Priority | Finding | Evidence before fix | Resolution |
|---|---|---|---|---|
| SEC-01 | P0 | A keyed third-party Solana RPC URL was shipped in a browser JavaScript bundle. | `assets/js/44-prooflog-deck.js` contained a provider URL credential and both HTML documents loaded the bundle. | Fixed. The keyed provider and constant were removed; public RPC fallbacks remain. A browser-bundle credential scan now fails the test suite if this pattern returns. The exposed provider credential still requires manual revocation/rotation in the provider dashboard. |
| SEC-02 | P0 | Legacy pending-intake reads treated any valid Supabase user JWT as a maintainer; analyst proofs were stateless and replayable. | `osi-analyst-intake` accepted `auth.getUser()` without the configured maintainer UUID/admin-wallet pair and accepted a client-created timestamp/nonce proof. | Fixed. Reads now require the exact-origin V2 read-session capability with `case:review`, then recheck the current V2 analyst roster or both maintainer gates. Missing/malformed/disabled read-session configuration fails closed. |
| GOV-01 | P0 | Legacy review writes could accept an unverified transaction string, replace vote history, and publish on a count-only threshold. | The endpoint deleted/reinserted `vouches`, did not verify a Solana transaction, and could update V1 publication state. | Fixed by containment. The legacy mutation is disabled at the UI and Edge boundary and routes users to native Case review. No legacy vote or publication write remains in the endpoint. This avoids silently inventing a second governance model. |
| AI-01 | P0 | Legacy AI Pack generation/retrieval had the same any-user maintainer bug, replayable wallet proof, and no durable quota/cost gate. | Any authenticated Supabase user could enter the maintainer branch; generation could call the model provider and store content. | Fixed by containment. Public metadata remains an explicit four-field projection. Restricted content requires a `report:review` read session plus role recheck. Generation makes no provider call and returns `native_ai_pack_generation_disabled`. Legacy direct pack content queries, approval, and sealing mutations were removed. |
| SAS-01 | P1 | A submitted SAS transaction was cached immediately as `verified` or `revoked` before confirmation. | `sendTransaction` returned, then `osi_v2_sas_record_wallet_state` wrote a terminal verification state. The public verifier may use a fresh terminal cache. | Fixed. Submission writes `pending_verification`; public verification must perform the existing live confirmed-state check before returning a terminal state. |
| PRIV-01 | P1 | Several legacy browser reads used `select=*`, including the maintainer console and public analyst/bounty reads. | Browser PostgREST queries requested every column; the console also requested full escalation-pack rows. | Fixed. Queries now use explicit minimum projections. The operations console does not directly request escalation-pack content. |
| LEG-01 | P1 | Other legacy maintainer mutations still call V1 PostgREST directly. Their real authorization depends on production V1 RLS, which is not represented in this repository. | `30-analysts-identity.js`, `34-maintainer-config.js`, and `54-maintainer-console.js` contain direct V1 mutation helpers behind client-side gate checks. | Reported, not expanded in this slice. Migrating every V1 admin mutation is an architectural retirement/cutover task. Before any legacy admin surface is re-enabled, inspect production V1 RLS with maintainer wallet-only, auth-only, full-maintainer, and ordinary-auth tests; move permitted mutations behind double-gated server endpoints. |

## Control-by-control audit result

- Private/public Case and Report reads: native V2 DTOs use explicit projections and private/nonpublished rows are excluded from public paths. Existing negative tests cover wrong wallet and unpublished records.
- Maintainer authorization: native V2 uses the configured Supabase auth UUID plus configured admin wallet. The two legacy service endpoints changed in this slice now use the same two-gate rule. Half-maintainer states are denied.
- Analyst authorization and no-self-review: native review gateways derive eligibility server-side and the database trigger covers typed review families. Existing governance tests cover self-review and bootstrap publication denial.
- Replay, nonce, idempotency, and receipts: native V2 writes use durable single-use nonces, exact purpose/target/payload binding, atomic consumption, immutable receipts, and idempotent replay. Existing source and concurrency tests remain green. Read-session capabilities are explicitly read-only and cannot authorize a write.
- RLS/default deny: migration tests confirm forced RLS/default-deny source contracts for V2 tables. A live database policy inspection and pgTAP authorization matrix could not be run because Supabase CLI, Docker, and a local PostgreSQL runtime are unavailable.
- SAS: setting/issuer/schema/credential checks remain fail-closed; the premature terminal cache state was corrected. Mainnet issuance itself was not exercised because it requires the protected issuer and an external write.
- Payments/support: existing tests cover exact sender, recipients, lamports, mainnet/finality, memo binding, partial payment, retry/idempotency, and support isolation. No transfer was attempted.
- Proof semantics: wallet-signed, Memo-anchored, verified SOL, system, and legacy labels remain distinct. Invalid transaction references do not become Solscan proof links.
- The Wire: native typed evidence, uncertainty field, governance, promotion, challenge, and support boundaries remain covered by the existing 47 core and 19 UI tests.
- AI Pack: native Phase 1 uses a separate V2 gateway and additive migration. Public output independently requires an approval receipt/time and exposes only the public brief plus the five-component confidence profile. Owner-safe and analyst-restricted layers, private notes, provider telemetry, and unapproved versions stay out of public DTOs. Generation is denied to Case owners, evidence is filtered before provider contact, and reservations enforce per-wallet, per-fingerprint, per-Case, and global limits. Twenty-five core and twenty-three UI checks passed. The unsafe legacy lane was contained rather than mixed into native governance.
- UI truth and responsive behavior: production and local root were checked in a real Chrome session; local viewport was explicitly set to 390px. No horizontal overflow or console warning/error was observed. Native AI Pack is a real Case-drawer surface whose controls follow server capabilities; the legacy generator stays retired.
- Capability flags: read-session and native AI Pack checks accept exactly `"true"`; absent, malformed, or unavailable configuration denies the affected path. Native generation requires the base write/proof flags plus `OSI_V2_AI_PACK_WRITES_ENABLED`; review/approval additionally require `OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED`. Legacy review and legacy AI generation have no enable path in this slice.
- Data model and migration safety: no migration, destructive SQL, rename, drop, data rewrite, or schema count change was introduced.

## Tests and evidence

- All 25 top-level Node test files passed after merging current `origin/main` and applying the fix.
- New `tests/osi-security-hardening.test.mjs`: 17/17 passed.
- Native AI Pack core suite: 25/25 passed; native AI Pack UI suite: 23/23 passed.
- Existing SAS suite: 48/48 passed.
- Existing XSS suite: 36/36 passed.
- JavaScript syntax checks passed for every modified browser script.
- Browser: production root loaded without console warnings/errors; local root at 390px had `scrollWidth === clientWidth`; local legacy document loaded without console warnings/errors.
- Not run: Deno type-check/lint, pgTAP/RLS matrix, clean database migration from zero, database lint, Supabase dry-run, two-connection PostgreSQL concurrency, and repository Playwright suite. The required runtimes/CLI packages are not available locally; no result is inferred for them.
- No Phantom signing or transaction action was triggered. Existing provider-call tests cover rejection, duplicate prompting, reconnect, expiry, retry, and one-approval-per-action logic without changing production state.

## Rollout and rollback

This branch has no production effect until reviewed and deployed. A safe rollout requires current `main`, the exact project ref, green CI including database/RLS jobs, function diff review, and read-only smoke checks. The audit diff changes only the legacy `osi-analyst-intake` and `osi-ai-pack` functions; the native `osi-v2-ai-pack` implementation arrived unchanged from current `main`. Static assets and the SAS issuer change follow the normal reviewed rollout. Deploy only task-scoped functions named by that workflow.

The rollback for the containment controls is a forward fix, not re-enabling the unsafe legacy writes. If restricted legacy reads fail after deployment, keep writes and generation disabled, verify the exact allowed origin and `OSI_V2_READ_SESSION_ENABLED`, and correct configuration or code through a focused PR. Do not drop or rewrite data.

## Required manual follow-up

1. Revoke/rotate the browser-exposed RPC provider credential in its provider dashboard. Secret rotation is intentionally not performed from this audit.
2. Run the protected CI database/RLS and Deno jobs on the PR.
3. Before any legacy admin mutation surface is relied upon, inspect production V1 RLS for ordinary-auth and both half-maintainer cases or retire those mutations behind native server gateways.
