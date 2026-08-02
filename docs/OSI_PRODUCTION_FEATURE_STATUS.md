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

## SAS display contract

Every authority surface uses the public verifier result or a fresh trusted
verification record and includes the check time. The only public states are:
verified, verification pending, expired, invalid/revoked, and unavailable.
A database analyst role alone never creates a verified badge.
