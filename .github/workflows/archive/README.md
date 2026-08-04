# Archived production rollouts

These are completed, one-shot production rollout workflows. Each one applied a
specific migration slice, deployed the Edge Functions that slice named, enabled
its dedicated feature flag, and smoke-tested the result against the live
project. They have all run, and none of them is meant to run a second time: a
rollout that has already applied its migrations is not idempotent in any useful
sense, and re-dispatching one is more likely to be an accident than an
intention.

**GitHub Actions does not read workflow files from subdirectories.** Moving a
file here disables it. That is the point. Nothing here can be dispatched by
mistake, and anything genuinely needed again can be restored with one
`git mv` back to `.github/workflows/`.

They are kept rather than deleted because they are the audit trail. Each file
records the exact migration count it expected, the flags it snapshotted before
and after, the row counts it compared, and the failure path it would have taken.
For a project whose product is verifiable public record, deleting the record of
how production reached its current state would be the wrong instinct.

## What still lives one directory up

| Workflow | Why it stays live |
|---|---|
| `osi-v2-foundation.yml` | The validation gate. The only workflow that runs on a pull request, and the only one that runs without a human dispatching it. |
| `osi-v2-function-deploy.yml` | Reusable deploy of the read-only `osi-v2-case-read` function. |
| `osi-v2-analyst-function-deploy.yml` | Reusable deploy of exactly the `osi-v2-analyst` function. |
| `osi-v2-report-write-function-deploy.yml` | Reusable deploy of exactly the `osi-v2-report-write` function. |
| `osi-production-migration-audit.yml` | Read-only diagnostic. Applies, repairs and mutates nothing. |
| `osi-core-flow-production-verification.yml` | Read-only verification. Deploys nothing and changes no flag. |

The rule: a workflow stays live if it is a gate or a tool that can be run again
safely. Everything that was a one-time state transition is archived.

## These files are still tested

Archiving does not remove them from the test battery.
`tests/osi-security-hardening.test.mjs` walks this directory recursively and
holds every file here to the same supply-chain rule as a live one: every
external action must be pinned to an immutable commit SHA. An archived workflow
is one `git mv` away from running again, and a float-tagged action inside it
would be exactly as dangerous then as it is now.

The same suite also asserts that exactly one workflow in the entire repository
runs without a human dispatching it. If a rollout in this directory ever grew an
automatic trigger, the pull request that did it would fail.
