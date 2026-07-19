# Contributing to OSI

Thank you for considering a contribution. OSI is a public-good project and welcomes code, review, documentation, and analysis contributions. This document explains how to contribute without breaking the product's guarantees.

## Before you start

Read these, in order:

1. [AGENTS.md](AGENTS.md): the engineering contract. It applies to every contributor, human or AI-assisted.
2. [docs/OSI_V2_PRODUCT_CONSTITUTION.md](docs/OSI_V2_PRODUCT_CONSTITUTION.md): the product's immutable principles.
3. [docs/OSI_V2_OPEN_DECISIONS.md](docs/OSI_V2_OPEN_DECISIONS.md): the decision register. Every governance and architecture decision is recorded here; do not silently relitigate one in code.

The short version of the contract:

- **Additive, never destructive.** Migrations only add. Published versions, reviews, and receipts are append-only. Never rewrite history, never force-push, never commit to `main` directly.
- **Fail closed.** New capabilities ship behind a dedicated feature flag that treats missing or malformed as off.
- **Server-enforced authorization.** Client checks are UX. Every privilege boundary is enforced in an Edge Function or at the database, and tested there.
- **Honest UI.** Every visible control maps to a real endpoint. Disabled features state their exact unmet prerequisite. No invented data, no placeholder pretending to work, no em dash in visible copy.
- **The design system is fixed.** New surfaces are composed from existing tokens and components. Visual redesigns are product-owner decisions, not pull requests.

## Development setup

There is no build step and no package manifest. The frontend is static HTML, CSS, and classic JavaScript; the backend is Supabase (PostgreSQL plus Deno Edge Functions).

```bash
git clone https://github.com/friendlyfiree/open-solana-intelligence
cd open-solana-intelligence

# Frontend: open index.html through any static server
python3 -m http.server 8000

# Backend: requires the Supabase CLI and Docker
supabase db start
supabase db reset --local --no-seed   # applies every migration from zero
```

See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for a full environment walkthrough.

## Running the tests

All Node suites are dependency-free:

```bash
for t in tests/*.test.js tests/*.test.mjs; do node "$t"; done
```

Database suites (require the local Supabase stack):

```bash
supabase db lint --local --level error
supabase test db                      # pgTAP authorization and lifecycle suites
bash tests/osi-v2-concurrency.test.sh # two-connection replay and race tests
```

Deno type checks for any Edge Function you touch:

```bash
deno check supabase/functions/<function>/index.ts
```

A pull request is expected to keep every suite green. CI runs the full battery, including a clean PostgreSQL migration from zero and browser contracts at desktop and 390px widths.

## Making a change

1. Branch from current `main` with a descriptive name.
2. Keep the change one coherent slice. Do not mix a security fix with a refactor.
3. Add or extend tests in proportion to risk: positive, negative, and authorization paths. Anything touching a privilege boundary needs a test at that boundary.
4. If your change renders untrusted data, extend the stored-XSS regression coverage.
5. If your change needs a product decision, open an issue first. Decisions land in the decision register before the code that depends on them.
6. Open a pull request describing what changed, what was tested, and what the production impact would be. State explicitly if a migration, Edge Function, flag, or production data is affected.

## What will not be merged

- Anything that weakens a fail-closed flag, a count gate, a conflict-of-interest exclusion, or default-deny row level security.
- Anything that lets support or payment influence governance, ranking, or reputation.
- Anything that presents a wallet signature as an on-chain transaction, or blurs the four proof labels.
- Secrets, keys, or tokens in code, tests, fixtures, or history.
- Destructive migrations, direct `main` commits, or history rewrites.
- Placeholder UI presented as functional, invented data, or an em dash in user-visible copy.

## Security issues

Never open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Questions

Open a GitHub issue for product or architecture questions. The decision register and the docs directory answer most "why is it like this" questions with the original reasoning.
