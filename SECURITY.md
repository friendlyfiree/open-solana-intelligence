# Security Policy

OSI handles wallet-signed evidence, private case material, and payment verification. Security reports are taken seriously and handled with priority.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub: use the repository's **Security** tab and open a private security advisory ("Report a vulnerability"). Include:

- A description of the issue and its impact.
- Steps to reproduce, a proof of concept, or the affected endpoint/table/function.
- The wallet addresses or test data you used, if any.

You will receive an acknowledgment as quickly as possible, normally within 72 hours. Please allow a reasonable window for a fix before any public disclosure. Good-faith research is welcome; we will not pursue researchers who respect user privacy, avoid destructive testing, and report responsibly.

## Scope

In scope:

- The production application at `open-solana-intel.vercel.app`.
- Supabase Edge Functions and database policies in this repository.
- Authorization boundaries: row level security, privilege escalation, half-authenticated maintainer access.
- Replay, nonce, and signature verification (the Stage-5 model).
- Payment verification logic and any path that could mislabel an unconfirmed payment.
- Privacy: any leak of private Cases, unpublished Reports or their existence, restricted evidence, or analyst private notes through any projection, log, or error message.
- The public SAS credential verifier and credential issuance logic.

Out of scope:

- Phantom, Supabase, Vercel, or Solana platform vulnerabilities (report those upstream).
- Denial of service by volume, rate-limit exhaustion without an authorization bypass.
- Social engineering of maintainers or users.
- Findings that require a compromised user device or seed phrase.

## What counts as critical

Highest priority is given to:

1. Reading or inferring private/unpublished material without authorization.
2. Writing to governance tables without a valid wallet proof, or replaying a consumed proof.
3. Counting a vote that conflict rules exclude, or bypassing a count/weight gate.
4. Getting a payment labeled confirmed without a finalized on-chain transfer.
5. Acting as maintainer with only one of the two required credentials.
6. Issuing, forging, or falsely verifying an analyst credential.

## Handling of secrets

No secret belongs in this repository, its history, its issues, or its logs: no service-role keys, no database passwords, no AI provider keys, no issuer private keys, and never a user's seed phrase or private key, which OSI never asks for. If you find an exposed secret, report it privately and do not use it.

## Design documents

The threat model is embedded in the public design documents: default-deny row level security, the Stage-5 replay defense, the four-label proof model, the double-gated maintainer, and the fail-closed flag discipline are specified in [AGENTS.md](AGENTS.md) and the `docs/OSI_V2_*.md` set. Reports that reference the specific guarantee they break are the fastest to triage.
