# OSI Engineering Contract

This file applies to the entire repository. It is the persistent operating
contract for Codex and any other engineering agent working on Open Solana
Intelligence (OSI).

## 1. Mission and authority

OSI is a public-good intelligence platform that turns open-source and
open-chain material into attributable, wallet-signed, community-reviewed and
challengeable records. Its product value is process integrity, not automatic
truth, guilt, legal certainty, recovery, custody or guaranteed payment.

The accepted V2 blueprint on `main` is the implementation baseline. Use these
documents as the source of truth, in this order:

1. `docs/OSI_V2_PRODUCT_CONSTITUTION.md`
2. `docs/OSI_V2_DOMAIN_MODEL.md`
3. `docs/OSI_V2_STATE_MACHINES.md`
4. `docs/OSI_V2_ROLE_PERMISSION_MATRIX.md`
5. The remaining `docs/OSI_V2_*.md` specifications
6. The legacy V1 implementation, only as a compatibility reference

Read `docs/OSI_DELIVERY_BRIEF.md` before every task.

Do not silently weaken or reinterpret a product invariant. If two accepted
documents conflict, identify the conflict in the task report and implement the
safer, least-privileged option when it can be done without changing product
meaning. Otherwise keep writes disabled for the affected path and record the
decision needed. Do not restart a broad blueprint-review loop.

The following accepted implementation details must be made explicit in the
relevant implementation slice before its production writes are enabled:

- exact cutover and rollback delta;
- exact effects of an accepted challenge;
- nullable-state checks for resolutions;
- the maintainer initial-open path alongside analyst initial review;
- the server actor responsible for each class-A Memo anchor.

## 2. Repository facts

- Frontend: static `index.html`, modular CSS and classic JavaScript; no build
  system and no package manager manifest.
- Backend: Supabase PostgreSQL and Edge Functions under `supabase/functions/`.
- Existing dependency-free regression test:
  `node tests/xss-escaping.test.js`.
- V2 database changes belong in ordered, additive files under
  `supabase/migrations/` once that directory is introduced.
- The stable pre-V2 checkpoint is tag
  `v0.9.0-stable-pre-case-model` at commit `1491377`.

Always inspect the repository and relevant blueprint sections before editing.
Do not assume the README's legacy examples describe the V2 architecture.

## 3. Autonomous working rules

Routine, reversible engineering work is autonomous: inspect, edit, run tests,
create a task branch, commit and open a PR without asking the product owner to
make technical choices. Explain material deviations and security findings.

For scope-limited OSI tasks, standing user authorization also covers the full
safe delivery loop without another routine approval: branch, commit, push, PR,
merge after all required CI is green, dispatch of an existing reviewed
main-only production workflow, dry-run-approved additive migrations, deployment
of only the Edge Functions named by the task, dedicated feature-flag
enable/disable, and read-only post-deployment smoke verification. This standing
authorization never broadens task scope and applies only when the exact project
ref, current `main`, intended production impact, rollback/disable plan, and
task-limited diff have all been verified.

If a rollout or smoke check fails, fail closed by disabling only the affected
dedicated feature flag, preserve immutable data, identify the exact log-backed
root cause, prepare a focused forward-fix PR, and resume the existing workflow
at most once after that PR merges with green CI. Do not repeatedly retry a
failing production workflow. Authentication, branch protection, or a mandatory
interactive browser/2FA challenge are valid manual blockers; otherwise do not
hand routine GitHub or Supabase delivery steps back to the product owner.

The product owner is nontechnical. Reports must use plain language and include
exact commands or buttons only when a manual step is genuinely unavoidable.
Never report "working" or "complete" from a narrative claim alone; prove it
with a diff, test, query result or deployment verification.

For every task:

1. Inspect current Git state and relevant files.
2. State the intended scope and production impact.
3. Make the smallest coherent implementation slice.
4. Test positive, negative and authorization paths in proportion to risk.
5. Inspect the final diff and ensure unrelated user changes are preserved.
6. Report the required handoff listed in section 14.

## 4. Git safety

- Start work from the current verified `main` and use a dedicated task branch.
- Never commit directly to `main`. A task-limited PR may be merged autonomously
  only when its required CI is fully green and branch protection permits it.
- Never use `git reset --hard`, destructive checkout, force push, history
  rewriting, or deletion of another contributor's work.
- Do not mix unrelated cleanup with a security or schema slice.
- Keep commits small, intentional and reviewable.
- A PR is required before main integration. Production database changes are
  separate from a GitHub merge and follow section 12.

## 5. Mandatory rollout gates

Implement V2 in independently reviewable slices, in this order unless a safer
dependency order is demonstrated:

1. repository contract and tooling baseline;
2. additive V2 schema;
3. default-deny RLS and database authorization tests;
4. Stage-5 nonce, signature, replay, idempotency and receipt infrastructure;
5. read-only migration/backfill validation;
6. read-only V2 UI;
7. Case and Report intake;
8. typed reviews, resolution and challenge;
9. analyst applications and reputation snapshots;
10. AI Pack and The Wire;
11. reward/support, My OSI and Operations Center;
12. soak period and legacy retirement last.

`OSI_V2_WRITES_ENABLED` must remain false until Stage-5 is implemented and its
replay/authorization tests pass. Read-only schema and UI may ship earlier.
Feature flags must fail closed when absent, malformed or unavailable.

## 6. Data model invariants

- The blueprint defines 32 V2 domain tables. Infrastructure tables such as
  nonce and migration-control tables are additional and must be labeled as
  infrastructure, not silently counted as domain entities.
- Create V2 additively. Do not rename, drop or destructively repurpose V1
  tables during the coexistence period. Where a V1 physical name collides,
  document the physical V2 name and its eventual cutover mapping.
- Use real foreign keys for modeled relationships, explicit check constraints
  for state and exactly-one-target rules, and indexes for foreign-key and RLS
  access paths.
- Parent/header records and immutable content versions are separate.
- Reviews target one exact immutable version. A revised vote creates history;
  it never erases the previous row.
- Published versions are never rewritten or deleted. Publication pointers move
  only through a server-authorized quorum transition.
- A resolution remains permanently bound to its selected exact Report version.
- Wallet addresses, signatures, transaction signatures, hashes and lamports
  must use validated canonical formats and appropriate database types.
- Store timestamps in UTC and enforce lifecycle transitions server-side.
- Every migration must be rerunnable only in the way Supabase migrations are
  intended to be applied once; do not hide partial failure with broad exception
  handlers.

## 7. Privacy, RLS and authorization

- New Cases are private by default. Pending/private rows must never become
  broadly readable through public RLS, views, RPCs, joins or storage URLs.
- Apply default-deny RLS to every client-reachable V2 table. Add narrowly scoped
  policies only after an explicit access matrix is tested.
- Derive actor wallet, auth UUID, role, tier and eligibility on the server.
  Never trust client-supplied role, owner, weight, status or actor fields.
- Maintainer mutation requires both the configured admin wallet and the
  authenticated Supabase maintainer identity. Either credential alone is a
  "half-maintainer" and must be denied.
- Case owner authority is not analyst authority and cannot replace governance.
- Enforce no-self-review at the database/server boundary, not only in the UI.
- Restricted analyst notes are never returned to Case owners or public clients.
- Use least-privilege projections for public/owner/analyst responses; avoid
  `select *` on mixed-sensitivity records.
- Service-role access stays inside trusted server code and is never exposed to
  the browser.

Every RLS slice needs tests for anonymous, wrong wallet, owner, contributor,
probationary analyst, verified analyst, maintainer wallet-only, maintainer
auth-only, full maintainer and service roles as applicable.

## 8. Stage-5 proof and replay requirements

Every native V2 signed write must use all of the following before it is
enabled:

- cryptographically random, server-issued single-use nonce;
- short nonce expiry and atomic consumption;
- exact purpose binding;
- exact target id and immutable target version binding;
- canonical payload hash binding;
- signature freshness;
- server-side Ed25519 signature verification;
- server-side actor-role and eligibility verification;
- idempotency that returns the original result without duplicating effects;
- server-only insertion of immutable event receipts;
- concurrency and replay tests.

Native V2 receipts use `server_verified=true` only after all verification has
succeeded. Legacy imports use `server_verified=false`. A wallet `signMessage`
receipt is "wallet-signed and server-verified", never "on-chain". Only a
confirmed Solana Memo transaction may be labeled "Memo-anchored on Solana".
System events and legacy/unverified events must remain visibly distinct.

## 9. Governance and lifecycle invariants

- A Case is the primary investigation entity; The Wire is the explicit
  standalone finding exception.
- One Case Report belongs to exactly one Case. Wire Reports do not require a
  Case and carry no reward until promoted through a modeled transition.
- Report authors, Wire authors, Pack creators and application authors cannot
  review their own exact versions.
- Count gates and weight gates both apply. A single analyst cannot decide a
  critical outcome even with maximum weight.
- Maintainers finalize eligible outcomes but cannot invent a winner or replace
  analyst quorum in the normal path.
- Tier eligibility and weight snapshots are server-derived. The formula stays
  shadow-only until separately approved; the live bounded tier model remains
  authoritative.
- `OSI_V2_FALLBACK_GOVERNANCE` defaults to false and fails closed.
- Report approval does not automatically resolve or close a Case.
- A finalized resolution opens a seven-day challenge window before sealing.
- Challenge submission alone does not pause sealing. Only admissible `open` or
  `under_review` challenges pause it.
- Challenge targets use typed foreign keys and exactly one target. Active-target
  uniqueness, evidence, cooldown, rate limits and deadlines are server-enforced.
- Rejection or expiry does not imply bad faith. Any bad-faith finding requires
  its own explicit reviewed outcome.
- Every nonterminal state needs an authorized next action plus a timeout or
  escalation path; do not create stuck states.

Use the exact quorum thresholds in the accepted blueprint. Never reduce a count
gate merely because the weight threshold was met.

## 10. AI Pack safety

- Generation is an artifact-generation action, not a truth decision.
- Pack versions and their evidence manifests are immutable and reproducible.
- Public, owner-safe and analyst-restricted layers use their exact permitted
  evidence scopes and manifest hashes.
- Owner feedback is advisory and uncounted; it is separate from analyst review.
- Creator self-review is forbidden and maintainer approval cannot replace
  analyst quorum.
- Staleness is layer-aware and orthogonal to lifecycle state.
- Do not produce or display one "accuracy", guilt, legal-certainty or truth
  probability score. Use the component Evidence Confidence Profile.
- Never send secrets, keys, seed phrases, prohibited personal data or
  illegal-access material to an AI provider or public response.

## 11. Money and UI honesty

- Reward and voluntary support are separate data models and events.
- Transfers are direct wallet-to-wallet through the Solana System Program. OSI
  never has custody, escrow or a platform balance.
- Never display paid/confirmed until the expected transaction is confirmed by
  RPC with the intended sender, recipient, amount and cluster.
- Support must not affect ranking, recommendation, review priority, reputation,
  voting power or governance.
- Every visible button must map to a real authorized endpoint/table transition.
  A disabled button states the exact unmet prerequisite. Do not present a
  placeholder or dormant control as functional.
- Escape untrusted data for its actual HTML/attribute/URL context. Preserve and
  extend stored-XSS regression coverage whenever rendering paths change.

## 12. Supabase and production controls

Read-only inspection, local development, linting, dry-runs, additive migration
preparation, and disposable database resets already defined inside reviewed CI
validation workflows are routine. Before any production additive migration or
approved Edge Function deployment, verify and record all of the following:

1. exact Supabase project name and project ref;
2. exact Git branch and commit;
3. local and remote migration status;
4. clean local database migration from zero;
5. database lint results;
6. constraints and required indexes;
7. RLS/authorization tests;
8. relevant application and replay tests;
9. `supabase db push --dry-run` output;
10. exact migrations that would be applied;
11. rollback/disable plan;
12. post-deployment schema, RLS and smoke verification.

After those gates pass, standing authorization permits the existing reviewed
main-only production workflow to apply only its dry-run-approved additive
migration, deploy only task-scoped Edge Functions, change only the dedicated
feature flag, and run read-only production verification and smoke tests.

Fresh, action-specific user approval is still required before any database
reset outside an already-reviewed disposable CI validation job; `DROP TABLE`,
`DROP SCHEMA`, `TRUNCATE`, broad `DELETE`, broad `UPDATE`; migration repair;
seed or data import; irreversible data rewrite or destructive type/column
conversion; project-ref changes; secret deletion or rotation; custody, escrow,
or smart-contract scope; and broad architectural work outside the stated task.
Stop and clearly report if one of these actions becomes genuinely necessary.

Prefer a forward-fix/feature-disable rollback for additive migrations. A
rollback plan must never pretend a populated schema can be safely dropped.

## 13. Secrets

Never print, paste into prompts, commit or log:

- Supabase service-role keys, database passwords or access tokens;
- Anthropic/OpenAI keys;
- private wallet keys or seed phrases;
- `.env` contents or credential-store values.

Use local authenticated tooling and secret stores. Public Supabase URL and
publishable/anon key may remain client-visible only where intended by the
current architecture. Redact accidental secrets from reports and stop before
they enter Git history.

## 14. Required task handoff

End every engineering task with:

1. `git status`;
2. exact changed files;
3. diff summary;
4. tests executed;
5. test results;
6. unresolved risks or decisions;
7. production impact (including whether Supabase/Vercel changed);
8. commit/PR recommendation.

If a test could not run, say why and do not substitute "should pass". If a
production surface was not changed, state that explicitly.
