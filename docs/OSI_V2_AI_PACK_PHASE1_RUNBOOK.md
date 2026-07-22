# OSI V2 AI Pack Phase 1 runbook

This runbook records the operational boundary for the first native V2 AI Pack
slice. The accepted product constitution and AI Pack trust model remain
authoritative if this file is incomplete.

## Delivery boundary

The implementation uses the dedicated `osi-v2-ai-pack` Edge Function. Extending
the legacy `osi-ai-pack` function would mix V1 `reports` and
`escalation_packs` authorization with the V2 Case, immutable-version, Stage-5,
layered-manifest, and governance model. A separate gateway is the smaller and
safer compatibility boundary.

The migration is additive. It reuses the five existing AI Pack domain tables
and adds one service-only infrastructure table for provider reservations,
usage, and estimated cost. It does not rename, drop, rewrite, or backfill V1
data. The rollout deploys only:

- `osi-v2-case-read`, because it issues the shared `aipack:detail` read scope;
- `osi-v2-ai-pack`, the new dedicated gateway.

No Vercel deployment is part of the database and function rollout workflow.

## Fail-closed cutover and rollback

`OSI_V2_AI_PACK_WRITES_ENABLED` and
`OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED` are inserted as `false`. Missing,
malformed, or unavailable values are treated as disabled. The Phase 1
production workflow cannot enable either flag. Generation enablement is a
separate, observed budget decision; review and approval enablement is a later
governance decision.

The exact rollout delta is one additive migration plus the two functions above.
Rollback is to keep or set only the two dedicated flags to `false`, retain all
immutable versions, manifests, receipts, reviews, feedback, and telemetry, and
deliver a focused forward fix. Dropping a populated schema, repairing migration
history, truncating data, or rewriting immutable records is not a rollback.

## Conservative provider controls

The database owns these defaults. The gateway refuses generation if any
required operational value is absent or malformed.

The existing governance keys remain fixed at
`OSI_V2_AI_PACK_MIN_COUNT=2` and `OSI_V2_AI_PACK_MIN_WEIGHT=2.50`. They are
preserved and verified by the rollout rather than redefined by this migration.

| Key | Default | Purpose |
| --- | ---: | --- |
| `OSI_V2_AI_PACK_MODEL` | `claude-sonnet-5` | Server-selected structured-output model |
| `OSI_V2_AI_PACK_RATE_WINDOW_SECONDS` | `3600` | Per-wallet rolling window |
| `OSI_V2_AI_PACK_MAX_PER_WALLET` | `2` | Provider reservations per wallet and window |
| `OSI_V2_AI_PACK_MAX_PER_FINGERPRINT` | `4` | Secondary abuse limit per window |
| `OSI_V2_AI_PACK_CASE_COOLDOWN_SECONDS` | `21600` | Six-hour Case generation cooldown |
| `OSI_V2_AI_PACK_DAILY_QUOTA` | `10` | Global daily provider reservations |
| `OSI_V2_AI_PACK_MAX_INPUT_CHARS` | `24000` | Total bounded evidence prompt characters |
| `OSI_V2_AI_PACK_MAX_OUTPUT_TOKENS` | `1000` | Maximum output tokens for each fixed layer |
| `OSI_V2_AI_PACK_MAX_OUTPUT_CHARS` | `12000` | Maximum accepted characters for each layer |
| `OSI_V2_AI_PACK_MAX_EVIDENCE_ITEMS` | `40` | Maximum evidence rows in one manifest |
| `OSI_V2_AI_PACK_PROVIDER_TIMEOUT_MS` | `45000` | Hard provider request timeout |
| `OSI_V2_AI_PACK_INPUT_USD_MICROS_PER_MTOK` | `3000000` | Conservative input-price snapshot |
| `OSI_V2_AI_PACK_OUTPUT_USD_MICROS_PER_MTOK` | `15000000` | Conservative output-price snapshot |

A single atomic database reservation enforces the wallet window, request
fingerprint window, Case cooldown, and global quota before provider contact.
The same nonce and idempotency key cannot reserve or charge twice. Input,
evidence count, output token, and output character limits are server-owned.
Wire promotion contributes only the exact evidence copied into
`case_evidence_links` by the promotion transaction. Later Wire revisions do
not silently enter that Case's AI Pack manifest.
The reservation rechecks that the Case is still public and in an eligible
lifecycle stage immediately before provider contact; the commit repeats that
check before storing the artifact. An expired reservation left by a terminated
Edge isolate is closed on the next signed reservation for that exact Case and
Pack type. Its telemetry remains null and is labeled as unreconciled rather
than inventing a zero-cost provider result.
Each reservation makes exactly three bounded requests, one for each fixed
layer, so the default ten-generation daily quota permits at most thirty
provider requests. Evidence containing secret or private-key material, seed
phrases, prohibited personal data, or illegal-access material is rejected
before the first provider request.
Token and conservative cost telemetry is service-only and never contains
prompts, generated content, signatures, authorization headers, or provider
keys.

`ANTHROPIC_API_KEY`, `OSI_MAINTAINER_AUTH_UUID`, and
`OSI_V2_ALLOWED_ORIGIN` are Edge Function secrets. `SOLANA_RPC_URL` is also
required for class-A mainnet Memo verification. The production workflow checks
all four names without reading or printing their values. The provider key is
never included in a client response, model prompt, telemetry row, log, or Git
file. The model identifier comes from `osi_config`, never the browser.

## Authorization, proof, and privacy

In Phase 1, generation is limited to a live eligible verified analyst or a full
maintainer with both the configured wallet and exact authenticated Supabase
identity. A Case owner is denied even if that wallet otherwise has an analyst
or maintainer role.

Generation authorization uses an exact single-use wallet signature, while the
resulting immutable `PACK_SUBMITTED` receipt remains honestly classified as a
system event. Analyst reviews and owner advisory feedback use class-B
wallet-message proofs. AI Pack approval uses a class-A confirmed mainnet Solana
Memo. The full maintainer submitting finalization is the on-chain transaction
signer and fee-paying actor; the server verifies that exact actor, Memo,
target-version, quorum hash, cluster, freshness, and confirmation before the
atomic approval commit. No server wallet signs on the maintainer's behalf.

Approval counts only active `approve` reviews from independent eligible
analysts other than the creator and Case owner. It requires at least two
analysts, total snapshotted weight at least `2.50`, and then full-maintainer
finalization. The `maintainer_bootstrap` decision channel is rejected for every
AI Pack approval path. Review and approval both recompute all three live
evidence-manifest hashes at the database boundary; any drift disables those
actions and requires regeneration. Live drift also releases the generation
surface even before the separate service refresh persists the layer-aware
`PACK_STALE` receipt. Owner feedback is stored separately, carries zero weight,
and never changes the confidence profile.

A committed response to `revision_requested` immediately marks that immutable
predecessor `superseded`. Other historical review or approval states remain
available until the replacement is approved, at which point they become
`superseded` and link to the new exact version. Supersession never fabricates
approval metadata for a version that was not approved.

Public reads are explicit allowlists and return only minimized metadata and an
approved public brief. Draft, review-required, disputed, rejected, owner-safe,
analyst-restricted, review-note, receipt-proof, provider, and telemetry fields
are absent. With review writes disabled and no approved native versions, the
production public projection must remain empty. A shared read session grants
only a short-lived `aipack:detail` capability; the gateway still rechecks live
Case ownership, analyst eligibility, or both maintainer gates before returning
private layers.
