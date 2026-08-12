# Network status

What is actually in the production network, stated plainly, with the exact
queries that produce it. This page exists because a platform whose product is
verifiable public record cannot describe its own adoption in adjectives.

**Observed:** 2026-08-12
**How to reproduce:** every number below comes from the public endpoints in
[docs/VERIFY.md](VERIFY.md) section 5. Nothing here is read from an internal
dashboard.

## The honest count

| Measure | Value |
|---|---|
| Public Cases | 3 |
| Cases sealed | 0 |
| Published Case Reports | 2 |
| Published Wire Reports | 0 |
| Analysts with an active profile | 3 |
| Analysts above probationary tier | 0 |
| Public openings through an independent analyst approval | 0 |
| Public openings through the full-maintainer approve-open path | 3 |
| Publications through independent analyst quorum | 1 |
| Publications through the labeled maintainer bootstrap channel | 1 |
| Resolutions finalized | 1, in its challenge window |
| Challenges opened | 0 |
| Confirmed reward payments | 0 |
| Confirmed voluntary support transfers | 1, for 100,000 lamports |
| Seals | 0 |

All three live analysts hold the `probationary` tier at review weight `0.50`,
and the public verifier returned `valid` for all three
`OSI_VERIFIED_ANALYST` credentials on Solana mainnet at the observation time.

## What that means, without softening it

**The machinery is built and the network is not.** Every lifecycle stage from
intake through winner selection has now run at least once in production against
real mainnet transactions, and the first challenge window is open as of
2026-08-12. Sealing and reward payment have never run outside test
environments.

**One publication has cleared an independent analyst quorum, and it is worth
stating exactly how.** On 2026-08-09 report version `OSI-RV-84E1DCA675CA4480`
was published on the ordinary analyst path: two independent analysts reviewed
the exact version, the author was excluded at the database boundary, and the
`REPORT_PUBLISHED` memo reads `r=analyst` with
`decision_channel='standard'`. The other published Report, from 2026-08-03,
went out through the cold-start bootstrap channel and reads `r=maintainer` with
`decision_channel='maintainer_bootstrap'`. Both are visible on chain and the
interface never presents the second as analyst consensus.

The qualifier that belongs next to that first number: both approving analysts
sit at the `0.50` probationary floor, so the publication cleared a standard
weight gate of `1.00`. That gate was `2.00` until 2026-08-07, when D21
calibrated it for a roster where every analyst is still at the floor. A gate of
`2.00` would have required four unanimous approvers, which the live
three-analyst network cannot produce, and the practical effect was to push
routine publication onto the bootstrap channel that is supposed to stay
exceptional. The constitutional count gate was not touched and cannot be
configured below two independent analysts. The reasoning, what deliberately did
not change, and the restore trigger are recorded in
`supabase/migrations/20260807154829_osi_v2_cold_start_weight_gate_calibration.sql`.
The governance thesis has now run once in production. It has not yet run at
earned weight.

**No Case has been sealed, and the first resolution used the bootstrap
channel.** Winner selection on Case `OSI-E0F2D49EA78B` was finalized on
2026-08-12 through D17, because no analyst had cast a selection review and the
standard resolution gate needs weight `2.50` against a live maximum of `1.50`.

Its `REPORT_SELECTED_WINNING` memo anchors the exact resolution and the acting
wallet, and the deciding role travels in the server-verified receipt as
`actor_role='maintainer'` with `decision_channel='maintainer_bootstrap'`. It
does not read `r=maintainer` on chain, and an earlier revision of this page said
it did. The resolution, challenge and seal family emits the
`historical_governance_v0` envelope, which carries `t`, `id`, `ref`, `a`, `h`,
`n`, `ts` and `exp` and has no `r` field at all; only the publication family
carries the role on chain. All four shipped profiles are tabled in
[docs/OSI_V2_MEMO_EVENT_SPEC.md](OSI_V2_MEMO_EVENT_SPEC.md), so the
specification was right and this page was wrong. Bringing the governance family
onto a versioned profile, so a seal carries its role on chain rather than only
in the receipt, is open work and is named as such rather than left implied.

The seven-day
challenge window closes 2026-08-19, and sealing faces the same arithmetic, so
the first seal will also travel the labeled bootstrap channel unless the roster
grows earned weight first.

**No Case has been opened by an analyst either.** All three public Cases were
opened on the full-maintainer approve-open path, which the model permits as an
independent initial-open route at analyst weight zero. Each of those receipts
records `actor_role='maintainer'`, so the Proof Log does not present any of them
as an analyst decision. Note the channel they carry, because it is the one
number on this page a reader could misread: a maintainer approve-open records
`decision_channel='standard'`, not `maintainer_bootstrap`, since it is a
modelled route rather than the cold-start substitution the bootstrap channel
names. The role field is what distinguishes it, and the count above is stated
separately so nobody has to work that out from a channel label.

**The one support transfer is not adoption.** It is 100,000 lamports sent by
the maintainer wallet to a report author to exercise the payment path end to
end against mainnet. It is recorded here as what it is: a production test of
the money path, not demand.

## What would change these numbers honestly

The bootstrap channel decays on its own as real analysts arrive: at 20 eligible
analysts the maintainer needs an independent analyst alongside every decision,
at 30 it takes two, and at 50 the channel retires and the original thresholds
take over. That ladder is computed by the server from the live analyst count
rather than flipped by hand, so nobody has to be trusted to give up the
privilege on schedule.

Between here and there, the number that matters most is not Cases or page
views. It is **publications that cleared a quorum with no maintainer weight in
it**, which is currently one. One is not a network. The next honest thresholds
are a sealed record that completes the lifecycle, a Wire Report published on
the same independent path, and a roster carrying enough earned weight that
resolution and sealing stop needing the bootstrap channel at all. Until those
move, the correct description of OSI is a working system at cold start, and any
other description would be the kind of invented traction this project's own
constitution forbids.

## Why there are no vanity metrics here

Page views, wallet connections, unique visitors, and total transactions are all
easy to produce and none of them says whether the review process works. They
are deliberately absent. The public metrics OSI intends to publish later are
listed in the README roadmap and share one property: each is independently
verifiable by a third party against the chain or the public read API, using the
same commands in [docs/VERIFY.md](VERIFY.md).

## Refreshing this page

This file is updated by hand from the public endpoints, not generated by a
privileged query, so that any reader can arrive at the same numbers. If it
disagrees with what the API returns, the API is right and this file is stale.
Report the drift.
