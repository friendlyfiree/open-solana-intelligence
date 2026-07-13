# OSI Delivery Brief

Revision: 2026-07-13
Purpose: short operational memory for every OSI engineering task.
Authority: this brief summarizes accepted documents; it never overrides them.
Read order: AGENTS.md, this brief, then the relevant accepted V2 specifications.

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
- Payment status requires RPC verification of sender, recipient, amount, and cluster.
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
- `v2-preview.html` is not the main product.
- The frontend is static HTML, modular CSS, and classic JavaScript.
- The repository has no package-manager manifest or frontend build step.
- Supabase PostgreSQL and Edge Functions provide the backend.
- Six accepted additive V2 migrations precede the native Case slice.
- Those migrations cover schema, guards, default deny, Stage-5, and legacy materialization.
- The production Case read function is reachable and fail-closed.
- At this revision, the public V2 Case registry returns zero public Cases.
- The mature production shell responds successfully.
- The native Case lifecycle migration and write function are a merge/deploy candidate.
- Production is unchanged until the reviewed PR is merged and rollout gates pass.
- Broad `OSI_V2_WRITES_ENABLED` remains false.
- Broad `OSI_V2_PROOF_ENABLED` remains false.
- The Case slice uses exact `OSI_V2_CASE_WRITES_ENABLED` gating.
- Missing, malformed, or unavailable flags fail closed.

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
- The wallet menu exposes My Reviews.
- The wallet menu exposes Profile.
- The wallet menu exposes Settings.
- The wallet menu exposes Disconnect.
- Operations Center is visible only to a full maintainer.
- A full maintainer requires configured admin wallet plus maintainer auth UUID.
- Wallet-only and auth-only half-maintainers are denied.
- Field Office lists real public V2 Cases.
- My Cases uses a fresh signed, single-use private read.
- My Reviews uses an eligible reviewer-only signed queue read.
- Case detail uses one drawer rather than a separate product shell.
- Case detail sections are Overview and Evidence.
- Case detail sections include Reports and Reviews.
- Case detail sections include Resolution & Challenges.
- Case detail sections include Proof Log and Reward & Support.
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
- A full maintainer may record an approval acknowledgement with weight zero.
- Maintainer status alone cannot satisfy analyst quorum or open a Case.
- A maintainer who is separately analyst-eligible must use the analyst path to count.
- This is the least-privileged resolution of an accepted-document conflict.
- The higher-order Constitution and role rules deny maintainer status its own weight.
- The physical schema and implementation contract still require a maintainer initial-review path.
- The implementation preserves that path without allowing unilateral publication.
- Initial rejection is disabled until its counted outcome transition exists.
- `needs_more` remains revisable and does not fabricate a terminal outcome.
- Public opening requires at least one counted analyst and total weight of at least 0.50.
- The opening analyst must own an active counted approval on that Case.
- `CASE_OPENED` requires a separate confirmed canonical Solana Memo.
- The counted approving analyst wallet is the class-A anchor actor for `CASE_OPENED`.
- Only that atomic transition changes stage to `open_public` and visibility to public.
- Field Office then reads the Case through the public projection.
- Proof Log distinguishes Memo proof from wallet-signature proof.
- Proof Log shows actor, role, decision, weight, timestamp, and receipt link when available.
- Proof Log explicitly states that provenance is not a truth or legal verdict.

## 8. Next roadmap gates

- Merge and deploy the reviewed Case lifecycle slice first.
- Run a soak period with broad V2 writes still disabled.
- Add immutable Case Report intake next.
- Add exact-version Report review after Report intake.
- Add complete initial rejection quorum and terminal transition before enabling rejection.
- Add resolution proposal and nullable-state checks.
- Add finalized resolution and seven-day challenge window.
- Add accepted-challenge effects exactly as the blueprint specifies.
- Add analyst application and reputation snapshot flows.
- Add AI Pack and The Wire write flows after their evidence scopes are enforced.
- Add reward, support, My OSI expansion, and Operations Center later.
- Retire legacy writes only after soak, reconciliation, and explicit cutover approval.

## 9. Production operation rules

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
