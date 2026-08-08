# OSI Delivery Brief

Revision: 2026-07-28
Purpose: short operational memory for every OSI engineering task.
Authority: this brief summarizes accepted documents; it never overrides them.
Read order: AGENTS.md, this brief, then the relevant accepted V2 specifications.
Operational flag and dormant-surface classification:
`docs/OSI_PRODUCTION_FEATURE_STATUS.md`.

## 1. Product principles that do not change

- OSI is a public-good intelligence platform for Solana investigations.
- A Case is the primary investigation entity.
- The Wire is the explicit standalone finding exception.
- Product value is process integrity and attributable provenance.
- OSI does not declare automatic truth, guilt, fraud, or legal certainty.
- OSI does not promise recovery, payment, or enforcement.
- Community review is challengeable and preserves history.
- Wallet attribution is not identity verification by itself.
- A wallet signature is not an on-chain transaction.
- Only a confirmed Solana Memo transaction is labeled Memo-anchored on Solana.
- A server-verified signMessage receipt is labeled wallet-signed and server-verified.
- Legacy and unverified records remain visibly distinct.
- Private Cases are private by default.
- Restricted content is never exposed by a public projection.
- Case ownership never grants analyst or governance authority.
- Authors cannot review their own exact artifact versions.
- Count gates and weight gates both apply where the blueprint defines both.
- Maintainers finalize eligible outcomes; they do not invent normal-path winners.
- Published immutable content versions are never rewritten or deleted.
- A resolution remains bound to one exact immutable Report version.
- Report approval never closes a Case automatically.
- Challenge submission alone does not pause sealing.
- Only admissible open or under-review challenges pause sealing.
- Reward and voluntary support are separate.
- OSI never holds custody, escrow, or a platform balance.
- Payment status requires trusted server RPC verification of Solana mainnet genesis, finality, exact payer/signer, exact System Program recipient manifest and bigint lamports, canonical Memo, freshness, instruction structure, and replay binding.
- Support never changes ranking, review priority, reputation, or voting power.
- AI generation creates artifacts, not truth decisions.
- AI surfaces never display one guilt, truth, or legal-certainty score.

## 2. Source of truth and compatibility

- The V2 Product Constitution has highest product authority.
- The V2 Domain Model follows it.
- The V2 State Machines follow the Domain Model.
- The V2 Role Permission Matrix follows the State Machines.
- Other OSI_V2 documents supply implementation detail.
- V1 is a compatibility reference, not the V2 architecture.
- V2 database changes are additive during coexistence.
- V1 tables are not renamed, dropped, or destructively repurposed.
- Physical name collisions require a documented cutover mapping.
- The stable pre-V2 checkpoint is `v0.9.0-stable-pre-case-model` at `1491377`.
- Accepted-document conflicts are reported, not silently normalized.
- The safer least-privileged interpretation is used when product meaning remains intact.
- Writes remain disabled when a conflict needs a product decision.

## 3. Current production and repository state

- Production project ref is `afibxpniwfnavdobecrn`.
- Production web URL is `https://open-solana-intel.vercel.app`.
- The `/` route is the mature OSI application and remains the main product.
- `legacy.html` is the fallback and must keep working.
- `v2-preview.html` is retired; Vercel permanently redirects that path to `/`.
- The frontend is static HTML, modular CSS, and classic JavaScript.
- The repository has no package-manager manifest or frontend build step.
- Supabase PostgreSQL and Edge Functions provide the backend.
- Production migration history was observed additive through `20260808153040_remove_private_wire_fields_from_public_rpc.sql` after the successful Wire privacy rollout on 2026-08-08. The repository also contains the later additive wallet-profile migration `20260808163737_osi_v2_wallet_profiles.sql`; it is not production-live until its dedicated reviewed workflow proves the exact one-file delta. Every production delivery must re-read both histories and accept only its exact reviewed delta.
- The deployed V2 slices cover schema, integrity guards, default deny, Stage-5 proofs, legacy materialization, complete Case initial review including normal rejection and owner appeal, Report/Wire lifecycles, governance, native SOL payments, read sessions, SAS issuance/enforcement, and AI Pack foundations.
- Production Case, Report, Wire, analyst, governance, proof, payment, and read functions are reachable behind their dedicated gates.
- The mature production shell responds successfully.
- Solana Pay and maintainer-only AI Pack generation are live behind their dedicated narrow flags; AI Pack review writes remain disabled.
- The Supabase organization is currently on the Free plan, where leaked-password protection is unavailable. Treat that as a non-blocking platform limitation; do not weaken application authorization or claim the control is enabled.
- Broad `OSI_V2_WRITES_ENABLED` remains false.
- Broad `OSI_V2_PROOF_ENABLED` remains false.
- The Case slice uses exact `OSI_V2_CASE_WRITES_ENABLED` gating.
- Normal Case rejection requires at least two independent SAS-valid analysts and total counted weight `2.00`; a maintainer cannot replace that quorum. An eligible rejecting analyst anchors the outcome with a confirmed Solana Memo.
- An owner appeal appends new private evidence with one wallet signature, preserves the original intake and rejection proof, and starts a fresh review cycle in which earlier votes carry no authority.
- The analyst slice uses exact `OSI_V2_ANALYST_WRITES_ENABLED` gating.
- The Report and Wire slices use their exact dedicated gates and are live.
- Missing, malformed, or unavailable flags fail closed.
- SAS review authority uses exact `OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED` gating; issuance and enforcement are true in production.
- An analyst review counts only when that caster's exact SAS credential verified live on chain or through a fresh trusted verification record.
- A wallet with no verifiable credential contributes zero weight and is labeled, never silently dropped.
- RPC failure yields pending/unavailable and zero count/weight; it never invents verification.
- Solana Pay uses `OSI_V2_SOLANA_PAY_ENABLED` and is available only when payment writes, an explicit trusted RPC secret, the additive reference schema, and the deployed path are all ready.
- AI Pack uses `OSI_V2_AI_PACK_ACCESS_MODE=maintainer_only` plus its dedicated generation flag. Review/publication stays false.

## 4. Global information architecture

- One shared shell owns navigation, wallet state, and content width.
- Primary navigation is Home.
- Primary navigation is Field Office.
- Primary navigation is The Wire.
- Primary navigation is Public Records.
- Primary navigation is Analysts.
- Primary navigation is Proof Log.
- Primary navigation is About.
- My OSI is not a primary navigation section.
- The wallet menu exposes My Cases.
- The wallet menu exposes My Reports only when its real gate exists.
- My Reports uses a fresh signed, single-use private read and shows the author's exact immutable version history.
- Report Queue uses a fresh signed read and is limited to an eligible analyst or full maintainer.
- The wallet menu exposes My Reviews.
- The wallet menu exposes My Profile.
- The wallet menu exposes My Applications.
- The wallet menu exposes Disconnect.
- Operations Center is visible only to a full maintainer.
- A full maintainer requires configured admin wallet plus maintainer auth UUID.
- Wallet-only and auth-only half-maintainers are denied.
- Field Office lists real public V2 Cases.
- My Cases uses a fresh signed, single-use private read.
- My Reviews uses an eligible reviewer-only signed queue read.
- Case detail uses one drawer rather than a separate product shell.
- Case detail has one canonical shareable route, `#case/<public_ref>`, and every public entry point resolves to it.
- The Case drawer opens before its network read completes and never leaves a click without visible feedback.
- The Field Office author workspace is labeled My Reports, never Reports.
- Published Reports are read from public Case detail with no login, wallet, signature or transaction.
- Navigating to a personal or authorized surface never calls a wallet API; an inline locked panel offers one explicit connect control.
- Case detail sections are Overview and Evidence.
- Case detail sections include Reports and Reviews.
- Case detail sections include Resolution & Challenges.
- Case detail sections include Proof Log and Reward & Support.
- Reward pledges use wallet-signed server proof and are never labeled on-chain or escrowed. Reward payment activates only after seal for the exact winning version author; voluntary support may atomically include at most four server-derived recipients for one exact published Report version.
- The payment review first shows exact mainnet, purpose, manifest, amounts, Memo, irreversibility, and no custody. Phantom handles every atomic manifest. Solana Pay is a secondary choice for exactly one server-derived recipient.
- Each Solana Pay reference is a cryptographically random 32-byte public key atomically bound to the existing nonce, payer, purpose, target, recipient manifest/hash, lamports, Memo, payload hash, mainnet, expiry, and idempotency key.
- QR scan or wallet open never marks payment. Reference discovery and signature submission converge on the same finalized parsed/raw transaction verification and existing payment/support/receipt commit.
- Multi-recipient support stays Phantom-only and is never split.
- Unimplemented sections explain the exact missing gate.
- Dormant placeholder controls are not presented as working actions.

## 5. Visual design contract

- Preserve OSI dark surfaces and amber identity.
- Use no more than two nested surface levels.
- Prefer lists and tables for comparative data.
- Prefer a timeline for lifecycle and provenance.
- Prefer a drawer for detailed investigation context.
- Use modals only for short forms or confirmation.
- Normal text targets at least 4.5:1 contrast.
- Body copy should remain readable near a 16px baseline.
- New UI must not use 9px micro text.
- Buttons target approximately 40 to 44px height.
- Focus states must be visible.
- Keyboard paths must expose the same real actions as pointer paths.
- Color is paired with a label, shape, or icon.
- Solana gradients are reserved for genuine chain proof.
- Animation is short, calm, and optional.
- `prefers-reduced-motion` is supported.
- Empty states never invent activity or metrics.
- The UI contains no stock hacker imagery.
- User-visible copy contains no em dash.
- UI tests scan HTML, JavaScript, and CSS for em dash regressions.
- Untrusted data is escaped for its exact HTML, attribute, and URL context.
- Proof links accept only validated Solscan transaction URLs.

## 6. Security boundaries

- Browsers never receive service-role credentials.
- Browsers do not insert V2 Case rows directly.
- Every native signed Case write is committed by trusted server code.
- The server issues cryptographically random single-use nonces.
- Nonces have short validated expiry.
- Nonces bind exact purpose, actor, target, payload hash, and idempotency key.
- Submission target UUIDs are generated by the server.
- Nonce consumption and effect creation share one database transaction.
- Idempotent retry returns the original receipt and effect.
- Changed proof data after consumption is rejected.
- Review signatures use server-side Ed25519 verification.
- Memo events use confirmed RPC transaction inspection.
- Memo verification checks signer, exact memo, status, and time window.
- Native receipts are inserted only by trusted server functions.
- Event receipts are immutable.
- Read challenges use durable database nonces.
- Per-isolate memory is never a replay security boundary.
- A read nonce creates no governance or Proof Log receipt.
- Default-deny RLS applies to every client-reachable V2 table.
- Public DTOs use explicit least-privilege fields.
- Public Case DTOs omit restricted detail and private pending evidence.
- Public Case DTOs omit unpublished Report existence, count, author, receipt, body, summary, evidence, hash, and submission metadata.
- Owner DTOs omit analyst-restricted reason codes.
- Analyst and full-maintainer DTOs receive only their authorized projection.
- No-self-review is rechecked at the database boundary.
- Analyst role, eligibility, and weight are server-derived.
- Maintainer authority is double-gated on the server.
- Restricted material is not logged.
- Seed phrases, private keys, illegal-access material, and prohibited personal data are rejected.

## 7. Native Case milestone

- Native intake records category and a neutral title.
- Native intake separates public-safe summary from restricted detail.
- Native intake accepts structured wallet, transaction, and HTTPS references.
- Evidence begins private and pending.
- Optional reward intent is non-binding and non-custodial.
- `CASE_SUBMITTED` requires a confirmed canonical Solana Memo.
- The Case owner wallet is the class-A anchor actor for `CASE_SUBMITTED`.
- A submitted Case enters `initial_review` with private visibility.
- The owner can retrieve it through My Cases after a fresh wallet proof.
- Eligible analysts can cast or revise typed initial reviews.
- An analyst approval uses the server-derived live weight snapshot.
- A full maintainer may record an `approve_open` review with analyst weight zero.
- Full maintainer means the configured admin wallet and exact Supabase maintainer auth UUID both pass; either half-maintainer is denied.
- That active full-maintainer approval is an independent initial-open path and does not require an analyst profile.
- Maintainer status still confers no analyst count or voting weight in any analyst quorum.
- Initial rejection is disabled until its counted outcome transition exists.
- `needs_more` remains revisable and does not fabricate a terminal outcome.
- Public opening requires either at least one counted analyst with total weight at least 0.50, or one active full-maintainer `approve_open` review.
- The opening wallet must own the active approval for the path it uses.
- `CASE_OPENED` requires a separate confirmed canonical Solana Memo.
- The qualifying analyst or full-maintainer wallet is the class-A anchor actor for `CASE_OPENED`.
- Only that atomic transition changes stage to `open_public` and visibility to public.
- Field Office then reads the Case through the public projection.
- Proof Log distinguishes Memo proof from wallet-signature proof.
- Proof Log shows actor, role, decision, weight, timestamp, and receipt link when available.
- Proof Log names each receipt by its exact registry event type and files it under the matching filter.
- Proof Log repeats a maintainer bootstrap mark so a cold-start decision never reads as analyst quorum.
- Proof Log explicitly states that provenance is not a truth or legal verdict.
- The Intelligence Passport counts only exact V2 registry receipts attributable to the connected wallet, from the same public projections any visitor can read.
- A voluntary transfer never becomes a record's headline verification; money receipts stay in the reward and support surfaces.

## 8. Native analyst activation milestone

- Public analyst profiles use an explicit least-privilege DTO.
- Public fields are handle, display name, bio, expertise, safe links, safe owned avatar, status, tier, weight, contributions, and proof history.
- Pending application versions, restricted application evidence, nonces, signatures, payload hashes, and private notes are never public.
- Profile images accept only validated PNG or JPEG bytes from 64 to 1024 pixels and at most 512 KB.
- Browser roles cannot mutate the analyst avatar bucket directly.
- Application submission creates an immutable exact version with Stage-5 nonce, payload, signature, replay, and idempotency binding.
- Revisions create a new version and preserve prior versions and decisions.
- My Applications uses a fresh signed single-use private read.
- The Operations Center application queue requires both maintainer gates and a fresh signed queue read.
- Application reviews target one exact current version and preserve prior decisions.
- The applicant cannot review or activate their own application.
- The canonical application decisions are approve, reject, and request revision; abstain is unavailable in this model.
- Maintainer application reviews have governance weight zero.
- Approval does not allow a client-selected tier or weight.
- `ANALYST_PROBATION` requires a separate confirmed canonical Solana Memo from the full maintainer.
- The probation transition derives `probationary_analyst`, tier `probationary`, and weight exactly 0.50 on the server.
- Support never changes status, tier, weight, ordering, review priority, or reputation.

## 9. Native Case Report intake milestone

- A connected wallet may submit to a public Case only in `open_public`, `in_review`, or `reopened`.
- One native Report header is permitted for an exact Case and author wallet.
- Version numbers and exact supersedes links are derived under a server lineage lock.
- Every submission appends an immutable version and preserves all earlier versions and receipts.
- Evidence is an ordered manifest of validated wallet, Solana transaction, or HTTPS references.
- The evidence manifest hash and complete private payload are bound before wallet approval.
- `CASE_REPORT_VERSION_SUBMITTED` is a class-A Memo anchored by the Report author wallet.
- The server verifies mainnet genesis, transaction status, signer, exact Memo, freshness, nonce, target, and payload binding.
- Nonce consumption, receipt, header adoption or creation, immutable version, evidence links, and current pointer update share one transaction.
- `current_published_version_id` is never advanced by intake or revision.
- Public reads expose only an exact published Report pointer and never reveal an unpublished Report's existence.
- Authors receive full private history through My Reports.
- Eligible analysts and full maintainers receive a read-only awaiting-review projection.
- Case ownership alone does not grant access to another author's unpublished Report.
- Report publication, resolution selection, challenge/seal lifecycle, reward, and support are live behind dedicated gates. AI Pack is separate and private to the full maintainer.

## 10. Native Wire milestone

- Any connected wallet may prepare a new standalone Wire finding or revise one of its own native Wire headers.
- Each version binds a public-safe title and summary, restricted analysis and uncertainties, and an ordered evidence manifest before wallet approval.
- `WIRE_REPORT_VERSION_SUBMITTED` is a class-A Memo anchored by the author wallet and verified against Solana mainnet by the dedicated gateway.
- Nonce consumption, receipt creation, header creation when needed, immutable version append, private evidence links, and the current-version pointer advance share one transaction.
- Revisions preserve all earlier versions and fail safely if their reserved lineage becomes stale.
- `current_published_version_id`, promotion, reviews, challenges, support, and public Wire projections are not changed by Phase 1.
- My Wire Reports uses the existing shared read-session token with the exact `wire:mine` scope and no TTL or binding relaxation.
- Public requests have no Wire list operation in Phase 1, and unpublished Wire existence, content, evidence, and author identity remain private.
- The dedicated `osi-v2-wire` function isolates Wire behavior from the existing Report gateways and minimizes flag-off regression risk.

## 11. Next roadmap gates

### Wallet profile backend/spec slice (2026-08-08)

- `wallet_profiles` is the 33rd domain table; `WALLET_PROFILE_UPDATED` is the 71st canonical event and uses wallet-signed/server-verified proof.
- The schema is additive, service-only under forced RLS, and performs no legacy or analyst backfill.
- Owner writes bind a single-use nonce to the profile UUID and exact current revision, consume it in the same transaction as the receipt and profile revision, and are disabled by default with `OSI_V2_PROFILE_WRITES_ENABLED=false`.
- Existing analyst identity remains an owner-only fallback until a wallet profile is created. Only identity fields mirror to an existing analyst record; authority fields are outside the profile contract.
- Avatar replacement/removal advances the profile reference but retains older immutable content-addressed objects; Storage deletion is not atomic with the receipt transaction. The UI slice must disclose that a previously shared public avatar URL may remain reachable. A retention cleanup job is deferred rather than hidden in the owner write.
- Public profile and Case-attribution UI/read integration ship in this reviewed slice. They must not be described as production-live before the dedicated migration/function workflow, frontend deployment and role/privacy smoke verification all pass.

- Soak the server-bound Solana Pay single-recipient path; retain Phantom for atomic multi-recipient support.
- Keep broad V2 write/proof/schema flags false while dedicated production slices remain independently gated.
- Keep AI Pack review, owner feedback, approval, publication, and public discovery false until a separately reviewed governed mode enforces independent SAS-valid analyst count and weight quorum plus creator exclusion.
- Soak the live Case rejection and owner-appeal loop while preserving its dedicated fail-closed flag and immutable review-cycle history.
- Add reputation snapshot progression after sufficient real attributable contributions exist.
- Improve My OSI and notification coverage only with real read/write contracts.
- Retire legacy writes only after soak, reconciliation, and explicit cutover approval.
- Permanent external storage remains an unfinished roadmap item, not a Live claim.

## 12. Production operation rules

- Start from verified current `main` on a dedicated `codex/` task branch.
- Never commit directly to `main`.
- A PR is required before integration.
- Never auto-merge `main` under the engineering contract.
- Verify exact project ref, branch, and commit before production action.
- Compare local and remote migration status.
- Reset only a disposable local database from zero.
- Run database lint at error level.
- Run constraints, indexes, RLS, authorization, replay, and application tests.
- Run `supabase db push --dry-run` before an additive production push.
- Confirm the dry-run contains only the exact expected migrations in order.
- Record the disable and forward-fix plan.
- Case rollback means set only the Case feature gate false through a reviewed forward fix.
- Analyst rollback means set only the analyst feature gate false through a reviewed forward fix.
- Report rollback means set only `OSI_V2_REPORT_WRITES_ENABLED=false` through a reviewed trusted-server change, retain immutable history, and forward-fix.
- Rollback never pretends a populated schema can be safely dropped.
- Verify schema, RLS, flags, and smoke reads after deployment.
- Deploy Edge Functions only from the exact reviewed commit.
- Do not reset a remote database.
- Do not drop, truncate, repair migration history, or rewrite irreversible data.
- Do not run broad delete or broad update.
- Do not expose secrets in commands, logs, prompts, commits, or reports.
- Do not merge or deploy while required CI is red.
- If local Docker is unavailable, CI must prove the clean database path before rollout.
- If GitHub, Supabase, or Vercel authentication is unavailable, stop at the safe handoff.
- End every task with status, files, diff, tests, risks, production impact, and PR guidance.
