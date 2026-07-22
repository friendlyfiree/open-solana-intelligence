# OSI bug and prompt-hardening audit — 2026-07-22

## Scope and baseline

- Branch: `codex/bug-hardening-audit`
- Local `main` and local `origin/main` baseline: `c52ec5acb86cbaa511036df831aaec0488328664`
- Remote refresh was attempted but GitHub DNS resolution was unavailable, so the local tracking ref is the recorded baseline.
- Production project named by the delivery brief: `afibxpniwfnavdobecrn`
- Production URL checked read-only: `https://open-solana-intel.vercel.app`
- No production database, Edge Function, feature flag, secret, or Vercel deployment was changed.

The audit prompt says that native AI Pack is merged. The accepted delivery brief and V2 blueprint say native AI Pack remains a later rollout slice and the production root intentionally exposes no native generation control. The safer accepted interpretation was used: legacy reviewed-pack compatibility remains read-only and generation stays fail-closed until its native schema, three evidence layers, Stage-5 write proof, quota, and dedicated capability flag exist.

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
- AI Pack: native V2 is not yet implemented under the accepted delivery brief. The unsafe legacy generation lane was contained instead of being presented as native or production-ready.
- UI truth and responsive behavior: production and local root were checked in a real Chrome session; local viewport was explicitly set to 390px. No horizontal overflow or console warning/error was observed. Root exposes no native AI generation control.
- Capability flags: read-session checks accept exactly `"true"`; absent, malformed, or unavailable configuration denies restricted legacy reads. Legacy review and AI generation do not have an enable path in this slice.
- Data model and migration safety: no migration, destructive SQL, rename, drop, data rewrite, or schema count change was introduced.

## Tests and evidence

- All 23 top-level Node test files passed after the fix.
- New `tests/osi-security-hardening.test.mjs`: 17/17 passed.
- Existing SAS suite: 48/48 passed.
- Existing XSS suite: 35/35 passed.
- JavaScript syntax checks passed for every modified browser script.
- Browser: production root loaded without console warnings/errors; local root at 390px had `scrollWidth === clientWidth`; local legacy document loaded without console warnings/errors.
- Not run: Deno type-check/lint, pgTAP/RLS matrix, clean database migration from zero, database lint, Supabase dry-run, two-connection PostgreSQL concurrency, and repository Playwright suite. The required runtimes/CLI packages are not available locally; no result is inferred for them.
- No Phantom signing or transaction action was triggered. Existing provider-call tests cover rejection, duplicate prompting, reconnect, expiry, retry, and one-approval-per-action logic without changing production state.

## Rollout and rollback

This branch has no production effect until reviewed and deployed. A safe rollout requires current `main`, the exact project ref, green CI including database/RLS jobs, function diff review, and read-only smoke checks. Deploy only `osi-analyst-intake` and `osi-ai-pack` if the reviewed workflow names them; static assets and the SAS issuer change follow the normal site/function rollout.

The rollback for the containment controls is a forward fix, not re-enabling the unsafe legacy writes. If restricted legacy reads fail after deployment, keep writes and generation disabled, verify the exact allowed origin and `OSI_V2_READ_SESSION_ENABLED`, and correct configuration or code through a focused PR. Do not drop or rewrite data.

## Required manual follow-up

1. Revoke/rotate the browser-exposed RPC provider credential in its provider dashboard. Secret rotation is intentionally not performed from this audit.
2. Run the protected CI database/RLS and Deno jobs on the PR.
3. Before any legacy admin mutation surface is relied upon, inspect production V1 RLS for ordinary-auth and both half-maintainer cases or retire those mutations behind native server gateways.
