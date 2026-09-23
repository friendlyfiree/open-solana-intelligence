# Network status

What is actually in the production network, stated plainly, with the exact
queries that produce it. This page exists because a platform whose product is
verifiable public record cannot describe its own adoption in adjectives.

**Observed:** 2026-09-18
**Re-checked:** 2026-09-23, every count unchanged
**How to reproduce:** every number below comes from the public endpoints in
[docs/VERIFY.md](VERIFY.md) section 5. Nothing here is read from an internal
dashboard.

## The honest count

| Measure | Value |
|---|---|
| Public Cases | 3 |
| Cases sealed | 1 |
| Published Case Reports | 2 |
| Published Wire Reports | 0 |
| Analysts with an active profile | 3 |
| Analysts above probationary tier | 0 |
| Analysts invited from the maintainer's own network | 3 |
| Analysts who joined through public outreach | 0 |
| Public openings through an independent analyst approval | 0 |
| Public openings through the full-maintainer approve-open path | 3 |
| Publications through independent analyst quorum | 1 |
| Publications through the labeled maintainer bootstrap channel | 1 |
| Resolutions finalized | 1, sealed |
| Challenges opened | 0 |
| Confirmed reward payments | 0 |
| Confirmed voluntary support transfers in the public Proof Log | 1, for 100,000 lamports |
| Seals | 1 |

All three live analysts hold the `probationary` tier at review weight `0.50`,
and the public verifier returned `valid` for all three
`OSI_VERIFIED_ANALYST` credentials on Solana mainnet at the observation time.

## Who the current analysts are

OSI has not been announced, so all three analysts on the roster are colleagues
from the maintainer's own analyst network, based in different countries, who
have worked with the maintainer on earlier investigations and joined at the
maintainer's invitation to support the cold start. They are real, separate
people with public X accounts linked from their OSI profiles. None of them
arrived through public outreach, and none of them is evidence of outside
demand.

On this page and across OSI, an **independent analyst** means a reviewer who is
not the author of the exact version under review, which the database enforces.
It does not mean a reviewer with no relationship to the maintainer. The first
analysts who join without an invitation are the real test of the network,
which is why the table above counts them separately.

The maintainer pays the roster's network fees and other costs of their OSI work
personally. Those transfers are visible on chain in both directions and are fee
and cost cover, not payment for reviews. So far they involve one roster member
only.

## What that means, without softening it

**The machinery is built and the network is not.** As of 2026-09-18 one Case has
run the entire lifecycle in production against real mainnet transactions, from
intake through publication, winner selection, a completed challenge window and
`RECORD_SEALED`. Reward payment is the one step that has still never run outside
a test environment, because that Case carried no pledge.

**One publication has cleared an independent analyst quorum, and it is worth
stating exactly how.** On 2026-08-09 report version `OSI-RV-84E1DCA675CA4480`
was published on the ordinary analyst path: two independent analysts reviewed
the exact version, the author was excluded at the database boundary, and the
`REPORT_PUBLISHED` memo reads `r=analyst` with
`decision_channel='standard'`. The other published Report, from 2026-08-03,
went out through the cold-start bootstrap channel and reads `r=maintainer` with
`decision_channel='maintainer_bootstrap'`. Both are visible on chain and the
interface never presents the second as analyst consensus. `OSI-RV-84E1DCA675CA4480`
and its Case were written and submitted from one of the maintainer's own
wallets,
[`9KZXnfzt...dmgUVJQXb`](https://solscan.io/account/9KZXnfztWnBNJARVGyMoPuT7dF759bKuPwgdmgUVJQXb),
on behalf of the person who asked for help, and the database excluded that
author from its review like any other.

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

**The first Case is sealed, and both its resolution and its seal used the
bootstrap channel.** Winner selection on Case `OSI-E0F2D49EA78B` was finalized
on 2026-08-12 through D17, because no analyst had cast a selection review and
the standard resolution gate needs weight `2.50` against a live maximum of
`1.50`. Sealing met the same arithmetic on 2026-09-18 and travelled the same
labeled channel, recorded as `actor_role='maintainer'` with
`decision_channel='maintainer_bootstrap'`. The seal transaction is
[`2WHUEpv9...UD5LqDQ`](https://solscan.io/tx/2WHUEpv9NHFPPfpa3ZuH6cLt7khyqDY14rZp88aQbmz5J1ocVTMnrG9hisBWExa31XiEooW5yUgrXmpP9UD5LqDQ),
finalized on mainnet. What it proves is that the lifecycle completes in
production. It is not analyst consensus and no surface presents it as one.

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
in the receipt, is open work and is named as such rather than left implied. The
seal memo above is the clearest example to pull: fetch it from any Solana RPC
and it reads `OSI2|RECORD_SEALED|t=resolution|id=...|ref=...|a=...|h=...|n=...|ts=...|exp=...`,
with no role segment anywhere in it.

**Why the seal is dated a month after its window closed.** The challenge window
closed on 2026-08-19 and `RECORD_SEALED` was anchored on 2026-09-18. Nothing
technical blocked it: no challenge was pending and the action was available
throughout. It was held for two reasons. The Case owner had said to expect an
off-chain development concerning the traced funds, and the seal had been named
as a milestone in a pending grant application. Both treated the seal as if it
closed the investigation rather than the process, and that was a mistake.

A seal records that the process completed, so waiting does not improve one.
Material that arrives after a window closes has its own modelled paths, a new
Report version, a challenge, or a reopen, none of which need the Case to sit
unsealed in the meantime. A seal belongs at the close of its window, and that is
where the next one goes.

**The first sealed Case produced a Report its owner could use.** The Case owner
reports taking the published Report to the exchange the receiving address was
attributed to, and that the assets held at that address were frozen, with the
matter now pursued through official channels. A published Report becoming
something the person it was written for can act on is the point of this process,
and this is the first time it has happened here.

It is recorded as an owner report and nothing more. OSI has not verified it: it
is not on chain and no exchange or authority has stated it publicly. No part of
it was carried out by OSI, which approached no exchange and no authority and
represented nobody. The owner took the published Report to their own counterparties;
what OSI did was publish it through a reviewed process and seal the record. It
is not a recovery, and OSI promises none. The published Report is unchanged by
it and remains a reviewed, attributable and permanently challengeable
observation about public evidence rather than a finding of wrongdoing by anyone.

There is a product observation in it too. A sealed Case is a completed process
record, and OSI has no modelled way to attach what happened next to one. An
outcome has no reviewed path into the record it belongs to, so it sits on a
status page instead. That is a named gap rather than a design choice.

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

**The support transfers are not adoption.** The one in the public Proof Log is
100,000 lamports sent by the maintainer wallet to a report author on 3 August
to exercise the payment path end to end against mainnet. An earlier test on 25
July sent 0.001 SOL from the maintainer wallet to the same roster member under
the analyst-profile support target; its `SUPPORT_PAYMENT_CONFIRMED` memo is on
chain, but the transfer does not appear in the public Proof Log projection.
Both are recorded here as what they are: production tests of the money path,
not demand.

## What would change these numbers honestly

The bootstrap channel decays on its own as real analysts arrive: at 20 eligible
analysts the maintainer needs an independent analyst alongside every decision,
at 30 it takes two, and at 50 the channel retires and the original thresholds
take over. That ladder is computed by the server from the live analyst count
rather than flipped by hand, so nobody has to be trusted to give up the
privilege on schedule.

Between here and there, the number that matters most is not Cases or page
views. It is **publications that cleared a quorum with no maintainer weight in
it**, which is currently one. One is not a network. A sealed record that
completes the lifecycle was on that list until 2026-09-18 and has now been
struck off it, which moves the remaining thresholds up rather than shortening
them: a confirmed reward payment to an author outside the maintainer and the
invited roster, a Wire Report published on the independent analyst path, the
first analysts who join without an invitation, and a roster carrying enough
earned weight that resolution and sealing stop needing the bootstrap channel at
all. Until those move, the correct description of OSI is a working system at
cold start, and any other description would be the kind of invented traction
this project's own constitution forbids.

## Why there are no vanity metrics here

Page views, wallet connections, unique visitors, and total transactions are all
easy to produce and none of them says whether the review process works. They
are deliberately absent. The public metrics OSI intends to publish later are
listed in the README roadmap and share one property: each is independently
verifiable by a third party against the chain or the public read API, using the
same commands in [docs/VERIFY.md](VERIFY.md).

## Review support ledger

Support for a counted review on a published Case Report travels on the
counted-reviewer rail, which binds the payment to that reviewer's active review
of that exact published version. Support
for any other review, including Wire reviews and reviews of versions that were
not published, can only travel on the analyst-profile rail, which does not bind
a payment to a review. A counted review is any review that counts toward a
quorum decision, whether it approves or rejects. Every analyst-profile payment
the maintainer sends for a review is listed here against the review it pays
for, so the link can be checked.

None has been sent yet.

## Refreshing this page

This file is updated by hand from the public endpoints, not generated by a
privileged query, so that any reader can arrive at the same numbers. If it
disagrees with what the API returns, the API is right and this file is stale.
Report the drift.
