# Right of reply, correction, and personal data

OSI publishes reviewed intelligence about on-chain activity. Some of that
activity belongs to identifiable people and organisations, and some of them
will never be OSI users. This page states what they can do about it, what OSI
will do in response, and exactly which parts of the record can and cannot be
changed.

It is the operational companion to the hard prohibitions in
[docs/OSI_V2_PRODUCT_CONSTITUTION.md](OSI_V2_PRODUCT_CONSTITUTION.md) sections 3
and 9. Where this page and the constitution disagree, the constitution wins.

## The standing position

A published OSI record is a **reviewed, attributable, challengeable claim about
public evidence**. It is never a verdict, never a finding of guilt, criminality,
or fraud, and never a legal or financial determination. Attribution remains
challengeable permanently, including after a record is sealed. Every public
record carries that disclaimer, and public copy is bound to source-bound
language: reported, alleged, observed on chain, unverified claim,
analyst-reviewed, under review.

If a record reads as an accusation rather than an observation, that is a defect
in the record and worth reporting under this page.

## What is out of scope before anything is published

The following are refused at intake and again at the server authorization
point, so they should never reach a state where a reply is needed:

- doxxing or investigation of non-public personal data
- harassment, stalking, or targeting of private individuals
- unsupported guilt, criminality, or fraud determinations
- private-account compromise or illegal-access requests
- private-key or seed-phrase material of any kind

A refusal on these grounds is a safety block. It is a policy refusal, not a
factual verdict, and OSI does not present it as one.

## Three routes, depending on who you are

### 1. You hold the wallet, and you want to answer on the record

Use the challenge mechanism. Connect the wallet, submit a signed challenge
against the exact record version, and the dispute enters admissibility review
and then analyst review as a first-class governance object. A challenge that
passes admissibility pauses sealing.

This is the strongest route, because your answer becomes a permanent, reviewed
part of the same public record rather than a note attached to the outside of
it. A challenge verdict is always an analyst-quorum outcome. The maintainer
cannot decide a challenge in any bootstrap tier, including a challenge against
the maintainer's own bootstrap decision.

### 2. You are a named subject without a wallet, or you do not want to sign anything

Send a notice through the private channel in [SECURITY.md](../SECURITY.md),
using the repository Security tab. You do not need a wallet, an account, or a
lawyer. Include the record's public reference (`OSI-...`), the exact statement
you dispute, and whatever supports your position.

What happens next:

1. **Acknowledgement**, normally within 72 hours.
2. **Triage** against the categories below.
3. **Outcome**, communicated to you, and recorded publicly on the record where
   the outcome is a public one.

You are not required to accept any outcome. Route 1 stays open, and so does
anything available to you outside OSI.

### 3. You believe the record contains a factual error, and you are anyone at all

Same channel, same timeline. A correction request does not need standing. OSI
would rather receive a correction from an uninvolved reader than publish an
error because nobody with standing bothered.

## What OSI will actually do

| Category | Response |
|---|---|
| **Factual error in a published version** | A new version is submitted and reviewed. The original stays visible and is superseded, never edited or deleted. Corrections add. |
| **Language that implies guilt, criminality, or legal certainty** | Treated as a constitution violation and corrected on priority, independently of whether the underlying observation holds. |
| **Prohibited content that passed intake** | Removed from public projection immediately, without waiting for quorum. A safety block needs no factual review. |
| **Personal data that should never have been published** | Removed from public projection immediately, then handled under the personal-data section below. |
| **Disputed interpretation, evidence is sound** | Not removed. Your reply is published alongside the record, and route 1 remains available. OSI does not withdraw a properly reviewed observation because its subject dislikes it. |
| **Demand to remove a correct, public-evidence observation** | Declined, with reasons, in writing. |

That last row is the point of the whole system. A record that disappears under
pressure is worth nothing to the victim it was meant to serve.

## Personal data, immutability, and erasure

OSI is append-only by construction. Published versions, reviews, and receipts
cannot be edited or deleted, including by the maintainer, and that is enforced
by database triggers rather than by policy. This is in obvious tension with a
right to erasure, and the tension is resolved by never putting personal data
where it cannot be reached.

**What is on chain.** Memos carry only a versioned event type, a target type, a
public reference, an actor wallet, a role, a decision, a nonce, a content hash,
and a timestamp. No name, no allegation, no narrative, no case content, no
personal data, ever. The `OSI_VERIFIED_ANALYST` attestation stores two integers,
tier and status, and the schema says so on chain in its own description.

**Consequence.** Because nothing personal is ever written to Solana, an erasure
request never requires rewriting chain history, and OSI never has to claim it
can do something it cannot. What is on chain is a process fingerprint, not a
dossier.

**What is in the database.** Case and report content lives off chain. Where a
lawful erasure or minimisation obligation applies to material there:

1. The material is removed from every public projection immediately.
2. The record keeps its provenance: the version existed, was reviewed, and was
   redacted, with the redaction itself recorded as an event. The public sees
   that something was removed and why in general terms. It does not see the
   removed material.
3. The content hash and the evidence manifest remain, so nobody can later claim
   the record said something it did not.

Redaction is therefore visible and auditable rather than silent. A system that
could quietly make text disappear without a trace would not be a public record.

**Standing minimisation rules.** Wallet addresses and transaction signatures are
public chain data and are treated as such. Analyst profile fields are
self-authored and self-managed. Private Case material stays restricted to the
owner, verified analysts, and the maintainer, and is never exposed by a broad
public policy, including after a Case opens.

**Jurisdiction.** OSI is operated by an individual maintainer, not a company,
and makes no claim of legal authority anywhere. Where a jurisdiction imposes an
obligation on this material, the maintainer will meet it and will record what
was done and why, publicly, to the extent the obligation permits.

## Transparency about removals

Where a public record is redacted or withdrawn, the fact of the change is
public. OSI will not silently unpublish. If a request results in no change, that
is also recorded on the record so a reader can see that the claim was contested
and survived review.

The only exception is a request whose disclosure would itself expose personal
data or endanger someone. In that case the change is recorded without the
requester's details.

## What this page is not

It is not a promise of recovery, a legal process, a takedown service, or an
appeals court. It is a stated, testable commitment about how a public-good
intelligence record answers the people it names. Failures to honour it are
reportable through the same channel and are treated as defects.
