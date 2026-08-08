# OSI production feature and gate status

Verified baseline: 2026-08-02  
Project: `afibxpniwfnavdobecrn`  
Web: `https://open-solana-intel.vercel.app`

This is the operational classification for production flags and visible
surfaces. A false value is not automatically unfinished work. Missing,
malformed, or unavailable values always fail closed.

## Scoped live capabilities

| Gate or mode | Launch-completion value | User-visible result |
| --- | --- | --- |
| `OSI_V2_CASE_WRITES_ENABLED` | `true` | Native private Case intake, initial review, normal rejection, owner appeal, and public opening |
| `OSI_V2_ANALYST_WRITES_ENABLED` | `true` | Analyst application and activation lifecycle |
| `OSI_V2_REPORT_WRITES_ENABLED` | `true` | Immutable Case Report intake |
| `OSI_V2_REPORT_REVIEW_WRITES_ENABLED` | `true` | Exact-version review and publication |
| `OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED` | `true` | Winner, challenge window, reopen, and seal |
| `OSI_V2_PAYMENT_WRITES_ENABLED` | `true` | Reward pledges/payments and voluntary support |
| `OSI_V2_SOLANA_PAY_ENABLED` | `true` | Secondary Solana Pay choice for one exact recipient |
| `OSI_V2_READ_SESSION_ENABLED` | `true` | Scoped private-read sessions with a 30-minute inactivity window and eight-hour absolute lifetime |
| `OSI_V2_WIRE_WRITES_ENABLED` | `true` | Wire intake, review, publication, and support |
| `OSI_V2_SAS_CREDENTIAL_ISSUANCE_ENABLED` | `true` | Server-derived issuance/revocation lifecycle |
| `OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED` | `true` | Invalid/unavailable credentials carry zero quorum authority |
| `OSI_V2_AI_PACK_ACCESS_MODE` | `maintainer_only` | Pack discovery, generation, and private reads require both maintainer gates |
| `OSI_V2_AI_PACK_WRITES_ENABLED` | `true` | Private immutable maintainer draft generation |
| `OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED` | `true` | Transparently labeled, self-decaying cold-start outcomes only |

Normal Case rejection is not a maintainer shortcut. It requires at least two
independent SAS-valid analysts and total counted weight `2.00`, followed by a
confirmed `CASE_INITIAL_REVIEW_REJECTED` Solana Memo from an eligible rejecting
analyst. The Case remains private. Its owner may appeal only with newly appended
private evidence and one wallet signature; the original intake, rejection proof,
and earlier reviews remain immutable and earlier reviews do not count in the new
review cycle.

## Every intentionally false production flag

| Flag | Classification | Why it stays false | Visible treatment |
| --- | --- | --- | --- |
| `OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED` | User-facing feature gate | Governed review/publication has not been separately launched. It still requires independent SAS-valid analyst count and weight quorum, creator exclusion, and maintainer finalization. | Review, owner feedback, approval, publication, and public Pack discovery controls are absent. |
| `OSI_V2_FALLBACK_GOVERNANCE` | Emergency/fallback control | Fallback governance is a deferred exceptional path and must not weaken normal quorum. | No active fallback action is advertised. |
| `OSI_V2_PROOF_ENABLED` | Legacy compatibility control | Native slices use exact Stage-5 and dedicated gates. The broad historical proof master remains off so unfinished/legacy consumers cannot inherit authority. | No user prerequisite depends on turning it on. |
| `OSI_V2_SCHEMA_READY` | Internal safety/default-deny control | This broad cutover marker is not the readiness signal for additive, independently gated production slices. | Not shown as an unfinished user feature. |
| `OSI_V2_WRITES_ENABLED` | Legacy compatibility control | Native production writes use dedicated per-slice gates. The broad historical master stays off to prevent accidental activation of abandoned or unfinished consumers. | No visible native action asks for it. |

## Dormant and misleading surface audit

| Surface found | Classification | Production disposition |
| --- | --- | --- |
| Root `tip-modal` and `assets/js/70-support-transfer.js` OSI1 direct-tip path | Legacy compatibility control | Removed from the primary document. The runtime and `OSI1\|SUPPORT_SENT` builder are confined to `legacy.html` and guard their own pathname. |
| Old Wire “Support” and OSI project-support cards | Legacy compatibility control | Hidden outside `legacy.html`; active V2 support uses the trusted payment gateway. |
| Operations Center “Ready to Publish” | Misleading placeholder | Removed. Replaced by protected private AI draft counts and eligible Case actions. |
| Operations Center “Safety Flags” and unconnected health telemetry | Misleading placeholder | Removed. Replaced by protected SAS and AI Pack status endpoints. No unsupported moderation count is invented. |
| AI Pack tab for public, owner, analyst, or half-maintainer | User-facing feature gate | Not rendered and does not call a Pack endpoint. |
| AI Pack review/feedback/approval/publication | Unfinished roadmap item | Server and database fail closed in `maintainer_only`; ordinary UI has no control. |
| Fallback-governance dashboard | Emergency/fallback control | Not presented as an active ordinary action. |
| Permanent Arweave mirror | Unfinished roadmap item | Documentation only; not labeled Live and no dormant button exists. |
| Placeholder input text and honest loading/error messages | Not a feature gate | Retained where they explain valid input or a retryable dependency failure. They do not claim an action completed. |
| Analyst "contributions" counter reading from the never-written `analyst_contributions` table | Misleading placeholder | Fixed. The table stays authoritative where it has rows; where it is silent the profile derives the list from that analyst's own server-verified receipts rather than publishing zero next to a non-empty proof history. See the public contribution contract below. |

## Payment surface contract

The active payment flow is always: amount choice, trusted server preparation,
exact review, explicit wallet-method choice, wallet approval, trusted finalized
verification, and atomic commit to the existing payment/support/receipt model.

- Phantom remains available for every supported recipient manifest.
- Solana Pay appears only for one exact server-derived recipient.
- Desktop gets a local high-contrast QR and copy link.
- Mobile gets an explicit compatible-wallet deep link and copy fallback.
- The wallet is never opened automatically.
- Multi-recipient support remains one atomic Phantom transaction.
- Scan/open/submission is never displayed as paid.
- A broadcast transfer is normally not finalized yet when the first trusted
  verification runs, so the client re-verifies the exact same signature
  automatically on a bounded schedule, and re-checks a signature broadcast in
  an earlier visit once the wallet is known again. Neither path opens a
  wallet, sends a transaction, or marks anything paid: only a successful
  server verification writes the payment, the support row and the receipt.
- The Phantom path stays recoverable after the single-use intent expires
  through `recover_payment`, which re-verifies the existing signature and
  never creates a second transfer.

## Public contribution contract

`analyst_contributions` is the authoritative record of an analyst's public work
and stays that way: wherever it has rows for a wallet, those rows are what the
public profile publishes. Nothing writes to it yet, so where it is silent the
profile derives the list from that analyst's own server-verified receipts
instead of asserting zero contributions next to a non-empty proof history.

A derived contribution is only ever the analyst's own attributable public work:

- Counted: submitting a Case, a Case Report version or a Wire Report version;
  proposing a resolution; submitting a challenge; and casting or revising any
  Case, Report, Wire, resolution, challenge, admissibility, bad-faith, AI Pack
  or analyst-application review.
- Never counted: operator decisions such as opening a Case, publishing a
  Report, activating an analyst or changing config, because those are the
  maintainer's acts even when a maintainer also holds an analyst profile;
  money, because a transfer is not a contribution; and applying or withdrawing.
- A cast review and its later revision are one contribution on one subject, so
  a revision never inflates the count.
- Each row carries the subject's public reference (`OSI-...`), never an
  internal id, and a receipt with no public reference is omitted rather than
  published as something a reader cannot look up.

## Public work record

The public profile publishes a work record rather than a bare contribution
list. Each row is the intersection of two independently public facts: a receipt
the wallet signed, and the current public state of the subject that receipt
points at. A row therefore states what the wallet did, to which record a reader
can open, what stage that record reached, and where its mainnet transaction is.

An outcome is a process state, never a verdict on whether an analysis was
correct, and the surface says so in its own copy.

Publishability is decided by whether the subject resolves for a public reader,
using the same test the Case read core enforces:

- A private Case, an unpublished Report, an unpublished Wire Report, a
  published Report whose parent Case is still private, a legacy import and an
  archived Case are all unresolvable and are never named.
- A review references the exact immutable version it judged, so `OSI-RV-*` and
  `OSI-WV-*` resolve through their parent header and inherit that header's
  publication test unchanged.
- Work on an unresolvable subject is counted in an unlisted total and never
  named, so the record stays truthful without announcing that a private subject
  exists. The stored `analyst_contributions` table stays authoritative where it
  has rows but does not get to name an unresolvable subject either.
- A receipt on an unresolvable subject keeps its proof in the proof history and
  loses its public reference.
- An unavailable subject index publishes an empty record rather than falling
  open.

The maintainer profile publishes the same record, built by the same code. That
confers no analyst standing: operator decisions are excluded upstream by the
contribution-kind map, and the record carries no status, tier, weight or vote.

The roster's work column and the profile summary both read the record's own
count, so the two can never disagree.

`#analyst/<handle>` and `#maintainer` are canonical public profile routes,
carrying a public identifier and nothing else. A profile with no public handle
has no shareable address rather than a wallet-bearing one.

## SAS display contract

Every authority surface uses the public verifier result or a fresh trusted
verification record and includes the check time. The only public states are:
verified, verification pending, expired, invalid/revoked, and unavailable.
A database analyst role alone never creates a verified badge.
