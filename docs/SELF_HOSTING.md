# Self-Hosting OSI

OSI is open source and designed to be forkable: a community that wants its own intelligence desk can run the full stack itself. This guide covers a complete deployment from zero.

> Level: comfortable with a terminal. Time: roughly an hour for a working stack, plus one-time on-chain setup.

## What you need

| Requirement | Purpose | Cost |
|---|---|---|
| A Supabase project | Database, Edge Functions, secrets | Free tier works to start |
| A static host (Vercel or any) | Serves `index.html` and assets | Free tier works |
| A Solana mainnet RPC endpoint | Memo/payment verification, SAS reads | Free tiers exist (e.g. Helius) |
| A Solana wallet with a few dollars of SOL | Admin wallet, one-time SAS setup, Memo fees | Cents per transaction |
| Anthropic API key (optional) | AI Pack generation | Only if you enable AI Packs |
| Supabase CLI + Docker (for development) | Local stack and tests | Free |

## 1. Database

```bash
git clone https://github.com/friendlyfiree/open-solana-intelligence
cd open-solana-intelligence

supabase login
supabase link --project-ref <your-project-ref>
supabase db push --linked --dry-run   # inspect: should list every migration in order
supabase db push --linked
```

Migrations are ordered and additive; applied from zero they create the full schema: domain tables, forced row level security with default deny, service-only RPCs, and every feature flag in its safe default (off).

## 2. Edge Functions

Deploy every function in `supabase/functions/` (each performs its own authorization; the gateway JWT check stays off by design):

```bash
for fn in osi-v2-case-read osi-v2-case-write osi-v2-report-read osi-v2-report-write \
          osi-v2-governance-write osi-v2-payment osi-v2-analyst osi-v2-proof \
          osi-v2-wire osi-analyst-intake; do
  supabase functions deploy "$fn" --project-ref <your-project-ref> --no-verify-jwt --use-api
done
```

## 3. Secrets

Set these as Edge Function secrets (Dashboard: Edge Functions, Secrets). Never commit them anywhere.

| Secret | Purpose |
|---|---|
| `SOLANA_RPC_URL` | Your mainnet RPC endpoint (falls back to the rate-limited public one) |
| `OSI_V2_ALLOWED_ORIGIN` | Your exact production web origin, e.g. `https://your-site.example` |
| `OSI_V2_SAS_ISSUER_SECRET` | Dedicated credential-issuer keypair (created in step 6) |
| `ANTHROPIC_API_KEY` | Only if you enable AI Pack generation |

The Supabase service-role key is available to functions automatically; it must never appear in frontend code.

## 4. Frontend

Point the public client config at your project (public URL and publishable anon key only; these are safe to expose) in `assets/js/01-public-config.js`, then deploy the repository root to your static host. On Vercel, importing the Git repository is enough; `vercel.json` carries the required redirects.

## 5. Maintainer configuration

The maintainer is double-gated: a configured admin wallet plus an authenticated Supabase operator account. Create the operator user in Supabase Auth, then set the admin wallet and the operator's UUID in your instance's configuration (see the maintainer entries in `osi_config` and the function environment). Test the gate: wallet alone and login alone must both be refused.

## 6. One-time on-chain setup (SAS credentials)

Open `tools/osi-sas-setup.html` on your deployed site, connect the admin wallet, and follow the four steps: generate the dedicated issuer keypair (store its secret ONLY in `OSI_V2_SAS_ISSUER_SECRET`), sign the two mainnet transactions that create your Credential and Schema accounts, and fund the issuer with about 0.01 SOL for future fees. Paste the resulting three public keys into `osi_config` (`OSI_V2_SAS_CREDENTIAL_PUBKEY`, `OSI_V2_SAS_SCHEMA_PUBKEY`, `OSI_V2_SAS_ISSUER_PUBKEY`). They are public addresses, not secrets.

Until this step is done, credential issuance is a safe no-op and everything else works normally.

## 7. Turning features on

Every capability ships off. Enable deliberately, one flag at a time, in `osi_config`:

```sql
update osi_config set value='true' where key='OSI_V2_CASE_WRITES_ENABLED';
-- then, as you are ready:
-- OSI_V2_ANALYST_WRITES_ENABLED, OSI_V2_REPORT_WRITES_ENABLED,
-- OSI_V2_REPORT_REVIEW_WRITES_ENABLED, OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED,
-- OSI_V2_PAYMENT_WRITES_ENABLED, OSI_V2_READ_SESSION_ENABLED,
-- OSI_V2_WIRE_WRITES_ENABLED, OSI_V2_AI_PACK_WRITES_ENABLED,
-- OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED   (cold-start mode, see USER_GUIDE)
```

Recommended order: case, analyst, report, review, resolution, payment, read session, wire, and only then AI Pack (it spends provider credits). Bootstrap mode is your choice: with it on, your maintainer can run the full lifecycle before you have 20 analysts, with every such decision honestly labeled.

Quorum thresholds, rate limits, and quotas are `osi_config` keys too; the shipped defaults match the documented governance model, and any tuning is visible in your database rather than hidden in code.

## 8. Verify your deployment

```bash
BASE="https://<your-project-ref>.supabase.co/functions/v1"
ORIGIN="https://your-site.example"

# public read works, leaks nothing restricted
curl -X POST "$BASE/osi-v2-case-read" -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' -d '{"op":"list_public_cases"}'

# read-session challenge is issued for your origin, refused for others
curl -X POST "$BASE/osi-v2-case-read" -H "Origin: https://evil.example" \
  -H 'Content-Type: application/json' \
  -d '{"op":"issue_read_session_challenge","wallet":"<any-wallet>"}'   # expect 403

# public credential verifier answers honestly
curl -X POST "$BASE/osi-v2-proof" -H "Origin: $ORIGIN" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"sas_verify","wallet":"<any-wallet>"}'
```

For deeper assurance, run the repository's own battery against a local stack (`supabase test db`, the Node suites, and `tests/osi-v2-concurrency.test.sh`); it is the same battery the upstream project gates every release on.

## Operating notes

- **Rollback is a flag, never a schema revert.** If a capability misbehaves, set its one flag to false. Data stays intact.
- **Never edit applied migrations.** New change, new migration file.
- **Watch AI Pack spend** through its telemetry table and quotas before raising any limit.
- **Keep `legacy.html` or remove it consciously**: it is the upstream project's frozen V1 fallback and is not required for a fresh instance.
- Upstream production rollouts run through the typed workflows in `.github/workflows/`; forks can reuse them by setting the same repository secrets (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID`) and editing the pinned project ref and origin.
