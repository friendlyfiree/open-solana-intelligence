# Production artefact audit

A read-only comparison of what is deployed in the production Supabase project
against what exists in this repository. Run 2026-08-07 against project
`afibxpniwfnavdobecrn`.

The reason this file exists: this project's central claim is that everything it
runs is publicly inspectable. That claim is only true if the set of things
running in production equals the set of things in this repository. This audit
records where those two sets differ, so a reader can hold the claim against the
evidence rather than take it on trust.

## Method

For each deployed Edge Function, the deployed bundle was fetched and compared
file by file against the repository source. Migration history was compared by
version. Nothing was mutated.

## Finding 1 — a deployed function with no source in this repository

| | |
| --- | --- |
| Slug | `generate-escalation-pack` |
| Function id | `48bd0977-7e7c-4edb-8412-a7300258087a` |
| Version | 10 |
| Status | ACTIVE |
| `verify_jwt` | true |
| Bundle sha256 | `ecbea0854c8d50c962f057894ed7e1f3239fdfff2df58466165a365455d35748` |
| Created | 2026-06-25 |
| Source in this repository | **none, in any commit on any branch** |
| References in the shipped page | **none** |

It is a pre-V2 escalation-pack generator: it sends already-reviewed evidence to
the Anthropic API with the deployment's own key and writes the draft to an
`escalation_packs` table. It carries its own prohibitions in its system prompt
(no invented facts, no legal advice, no recovery promise, mandatory
human-review banner), and it reads every credential from the environment, so no
literal secret appears in its source.

Three things are true about it at once, and all three matter:

1. **It has no public source.** It is the one thing running in production that a
   stranger cannot read, which is precisely the property the rest of this
   repository exists to guarantee.
2. **Nothing calls it.** No reference exists anywhere in `index.html` or
   `assets/js/`. The V2 AI Pack slice superseded it.
3. **Its authorization is weaker than the V2 contract.** It gates on
   `admin.auth.getUser(token)` returning any user at all. The V2 maintainer
   contract requires *both* the configured admin wallet and the specific
   configured maintainer auth UUID, and treats either credential alone as a
   half-maintainer to be denied. This function would admit any authenticated
   Supabase user, who could then spend the deployment's Anthropic quota up to
   its own 25-per-day cap.

**Recommendation:** delete the deployed function. It is unreferenced, it is
superseded by the V2 AI Pack, and its gate does not meet the standard every
other maintainer surface here is held to. This is a product decision rather than
an implementation one — the owner may still invoke it out of band — so it is
recorded here rather than acted on unilaterally. Retrieving the exact source
before deletion is a single read-only call, so nothing is lost by deleting it
afterwards.

## Finding 2 — deployed functions running older shared cores

Every function below is deployed from a commit older than the current `main`.
The listed drift is what the deployed bundle differs by, not a guess from dates.

| Slug | Deployed | Drift |
| --- | --- | --- |
| `osi-v2-proof` | 2026-07-25 | `osi-v2-proof-core.mjs`, `osi-v2-sas-core.mjs`, `osi-v2-sas-onchain.ts` differ; `index.ts` is identical |
| `osi-ai-pack` | 2026-07-26 | legacy V1 surface, superseded by `osi-v2-ai-pack` |
| `osi-analyst-intake` | 2026-07-26 | legacy V1 surface, superseded by `osi-v2-analyst` |

`osi-v2-proof` was checked for behavioural drift rather than assumed. It has two
meaningful surfaces, and both were executed rather than read.

*The set of class-B purposes it will issue a nonce for.* The deployed copy
hardcodes that set; the repository derives it from the central event registry.
**Both sets contain exactly the same 28 purposes**, so the deployed issuer
accepts and refuses exactly what the current source would.

*The canonical message a client signs.* This one matters more than it looks: the
issuer builds the string, and a different function — `osi-v2-case-write`,
`osi-v2-report-write`, `osi-v2-governance-write` — rebuilds it to verify the
signature. If the two disagreed by a single byte, every Stage-5 write would fail
verification. The deployed copy joins the ten fields literally; the repository
delegates to `canonicalOsi2Envelope(..., "v2_expiring_minimal")`. Both were
imported into the same process and run against the same binding:

```
OSI2|2|CASE_INITIAL_REVIEW_CAST|t=case|id=…|a=…|n=…|h=…|ts=…|exp=…
```

**Byte-identical.** The refactor preserved the wire format exactly, which is why
production has kept anchoring Memos across the drift.

The `osi-v2-sas-core.mjs` drift is the addition of `reconcileLiveAction`, which
`osi-v2-proof` does not call. The `osi-v2-sas-onchain.ts` drift is real and does
change behaviour — `attachReviewAuthority` became fail-closed (an unresolved
review is now explicitly `counted:false, state:"authority_unavailable"` instead
of silently unlabelled) and `sasReviewAuthority` now chunks past 400 ids instead
of truncating. But `osi-v2-proof` imports only `publicVerify` from that module.
The only two functions that call the changed helpers are `osi-v2-case-read` and
`osi-v2-report-read`, and both were redeployed on 2026-08-07, so the fail-closed
version is what production actually runs.

So `osi-v2-proof` is stale but not wrong. Redeploying it is hygiene, not a fix.
It is deliberately excluded from the Case-visibility rollout so that slice
deploys exactly what it changed, and it is left alone here rather than churned
through a new workflow for a change that has been demonstrated to be a no-op on
the one path that carries every wallet signature on the platform.

## Finding 3 — migration history

Production migration history is exactly this repository's chain. At audit time
34 of the 35 migrations were applied, the only pending one being
`20260807090000_osi_v2_case_report_visibility_publication.sql`, which the
Case-visibility rollout applies.

Additionally, `pg_get_functiondef` was hashed for all nine functions that
migration replaces and compared against a database built from zero on the same
chain. **All nine matched byte for byte**, so production carries no manual
schema edit and no drift from the recorded history.

## Re-audit after the Case-visibility rollout

Repeated 2026-08-07 after workflow run `31181908839` applied the migration and
redeployed eight functions, to answer one question directly: *is anything
written in this repository not actually running in production?*

**Schema: nothing pending.** All 35 migrations are applied. The chain in
production is exactly the chain here, in exactly this order, with nothing extra.

**Functions: every slug in this repository is deployed.** Twelve function
directories exist here and all twelve are ACTIVE in production. Comparing
deployed bundles file by file against the source:

| Slug | Deployed source vs repository |
| --- | --- |
| the eight in the rollout | redeployed from this commit on 2026-08-07 |
| `osi-v2-payment` | **all four files byte-identical** |
| `osi-v2-proof` | three shared cores stale — see Finding 2, proven a no-op |
| `osi-ai-pack`, `osi-analyst-intake` | legacy V1 read-only shims, unchanged in this repository since 2026-07-22 and deployed after that |

So the answer is no: no behaviour written here is missing from production. The
divergence runs the other way — Finding 1, a function running in production with
no source here at all.
