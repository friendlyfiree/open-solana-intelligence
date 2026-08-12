# Verify OSI yourself

Every claim OSI makes about itself is checkable without trusting OSI. This page
is the shortest path from "they say so" to "I checked". It needs no wallet, no
account, no API key, and no permission from the maintainer.

Nothing on this page performs a write. Every command is read-only.

- [1. The live site](#1-the-live-site)
- [2. The on-chain analyst credential](#2-the-on-chain-analyst-credential)
- [3. Any analyst wallet, straight from the chain](#3-any-analyst-wallet-straight-from-the-chain)
- [4. Governance memos on mainnet](#4-governance-memos-on-mainnet)
- [5. The public record, from the public API](#5-the-public-record-from-the-public-api)
- [6. Default deny, tested from outside](#6-default-deny-tested-from-outside)
- [7. Live configuration against the documentation](#7-live-configuration-against-the-documentation)
- [8. The full one-command audit](#8-the-full-one-command-audit)
- [9. The code and its tests](#9-the-code-and-its-tests)

Constants used throughout:

```bash
OSI_WEB="https://open-solana-intel.vercel.app"
OSI_API="https://afibxpniwfnavdobecrn.supabase.co"
OSI_KEY="sb_publishable_ZMeLittgGgqke81us9GY7g_qpcWoilm"   # publishable, safe to expose
RPC="https://api.mainnet-beta.solana.com"
```

The publishable key is not a secret. It authorizes nothing on its own: every
privileged path is behind row level security, service-only RPCs, and wallet
proofs. Section 6 lets you confirm that rather than take it on trust.

## 1. The live site

```bash
curl -sI "$OSI_WEB" | grep -Ei 'content-security-policy|strict-transport|x-frame|x-content-type'
```

Expected: a `Content-Security-Policy` with an explicit `default-src`,
`script-src`, and `connect-src`; HSTS with a two-year max-age and `preload`;
`X-Frame-Options: DENY`; `X-Content-Type-Options: nosniff`.

## 2. The on-chain analyst credential

OSI's analyst authority lives in the Solana Attestation Service, not in OSI's
database. Three accounts define it:

| Role | Address |
|---|---|
| SAS program | `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` |
| OSI Credential | `D2tsrEHEXYPL82chv5PuwsQtALv1i5hXrWZorqyefJgX` |
| `OSI_VERIFIED_ANALYST` Schema | `897TYTVN9aQfLWj2BJyhByQawsSuydLZcTpanZWCtxKz` |
| Operational issuer | `FcwxSJJY6x7K4fPBzTVVtvaeYpg3E472ZNXL97aFmUkG` |

Read the schema account straight from mainnet and decode it:

```bash
curl -s -X POST "$RPC" -H 'Content-Type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"getAccountInfo",
  "params":["897TYTVN9aQfLWj2BJyhByQawsSuydLZcTpanZWCtxKz",{"encoding":"base64"}]
}' | python3 -c "import base64,json,sys; \
d=json.load(sys.stdin)['result']['value']; \
print('owner:', d['owner']); \
print(base64.b64decode(d['data'][0]).decode('utf-8','replace'))"
```

Expected in the decoded bytes: the schema name `OSI_VERIFIED_ANALYST`, the
field names `tier` and `status`, and the description
`OSI verified analyst review-authority tier/status. No PII, no case data.`
The account owner must be the SAS program above.

That last line is the privacy claim, on chain, in the schema itself: the only
things OSI ever writes to an analyst's attestation are two integers. No name,
no handle, no case content, no personal data.

## 3. Any analyst wallet, straight from the chain

OSI exposes a public verifier, and the verifier is itself checkable because it
reports its inputs:

```bash
curl -s -X POST "$OSI_API/functions/v1/osi-v2-proof" \
  -H "Content-Type: application/json" -H "apikey: $OSI_KEY" \
  -H "Authorization: Bearer $OSI_KEY" \
  -d '{"mode":"sas_verify","wallet":"<ANY_WALLET>"}'
```

The response names the exact credential, schema, issuer, and program it checked
against, whether the source was a live chain read or a fresh cache entry, and
the check time. A wallet with no OSI attestation returns
`"valid": false, "state": "invalid", "reason": "absent"`.

If you would rather not use OSI's endpoint at all, section 8 derives the
attestation PDA and reads it from mainnet yourself.

## 4. Governance memos on mainnet

Every public governance outcome is a confirmed Solana Memo transaction under a
documented envelope grammar. There are four shipped profiles, not one, and the
difference matters for what you can read off the chain. The publication family
uses `v1_expiring`:

```
OSI2|<v>|<EVENT>|t=<target type>|id=<public ref>|a=<actor wallet>|r=<role>|d=<decision>|n=<nonce>|h=<payload hash>|ts=<unix>
```

The resolution, challenge and seal family uses the older
`historical_governance_v0` profile instead, which carries `t`, `id`, `ref`,
`a`, `h`, `n`, `ts` and `exp` and **has no `r` field**. For those events the
deciding role is not on chain; it is in the server-verified receipt, readable
through the public API in section 5 as `actor_role` and `decision_channel`. The
full profile table is in
[docs/OSI_V2_MEMO_EVENT_SPEC.md](OSI_V2_MEMO_EVENT_SPEC.md). This is named here
because an earlier revision of this page described the grammar as if one shape
covered every event, and a verification guide that overstates what the chain
carries is worse than no guide.

Pull one and read it:

```bash
SIG="pXwMcsNr6cjh9T22Da1kBS2QGdJmw4hbTxBoFyw9kWChqJ6qJKhiypGefqZGcnKE1yumA7MYFCQm3HnSbRQAEiK"
curl -s -X POST "$RPC" -H 'Content-Type: application/json' -d "{
  \"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getTransaction\",
  \"params\":[\"$SIG\",{\"encoding\":\"jsonParsed\",\"maxSupportedTransactionVersion\":0}]
}" | python3 -c "import json,sys; r=json.load(sys.stdin)['result']; \
[print(i.get('parsed')) for i in r['transaction']['message']['instructions'] if 'memo' in str(i.get('program',''))]; \
print('signer:', r['transaction']['message']['accountKeys'][0]['pubkey'])"
```

Two things to look for. On a publication event the `r=` field states the role
that made the decision, so a report published through the transparent
cold-start bootstrap channel reads `r=maintainer` on the chain itself and
cannot be dressed up as analyst consensus afterwards. On a resolution,
challenge or seal event there is no `r=` field, so check the role and channel
through the public API in section 5 instead. And no memo field carries a
subject name, an allegation, or any case content, by design
(`docs/OSI_V2_MEMO_EVENT_SPEC.md`).

The full memo event catalogue is in
[docs/OSI_V2_MEMO_EVENT_SPEC.md](OSI_V2_MEMO_EVENT_SPEC.md).

## 5. The public record, from the public API

```bash
curl -s -X POST "$OSI_API/functions/v1/osi-v2-case-read" \
  -H "Content-Type: application/json" -H "apikey: $OSI_KEY" \
  -H "Authorization: Bearer $OSI_KEY" -d '{"op":"list_public_cases"}'

curl -s -X POST "$OSI_API/functions/v1/osi-v2-wire" \
  -H "Content-Type: application/json" -H "apikey: $OSI_KEY" \
  -H "Authorization: Bearer $OSI_KEY" -d '{"op":"list_public_wire_reports"}'

curl -s -X POST "$OSI_API/functions/v1/osi-v2-analyst" \
  -H "Content-Type: application/json" -H "apikey: $OSI_KEY" \
  -H "Authorization: Bearer $OSI_KEY" -d '{"op":"list_public_profiles"}'
```

Each public Case carries its reviews with reviewer wallets, decisions, counted
weight, and SAS authority state; its report versions; its proof log with
transaction signatures; and its money state. Cross-check any signature in the
proof log against section 4. The counts you get back are the real network size
and are summarized, with their limitations stated, in
[docs/NETWORK_STATUS.md](NETWORK_STATUS.md).

## 6. Default deny, tested from outside

The publishable key must not be able to read a governance table directly. These
are the real V2 domain table names, so a `404` here would mean this page sent
you to a table that does not exist rather than proving anything:

```bash
for T in cases case_reports case_report_versions case_report_reviews \
         wire_reports wire_report_versions evidence_items \
         event_receipts analyst_profiles reward_payments; do
  printf '%-24s ' "$T"
  curl -s -o /dev/null -w '%{http_code}\n' \
    "$OSI_API/rest/v1/$T?select=*&limit=1" \
    -H "apikey: $OSI_KEY" -H "Authorization: Bearer $OSI_KEY"
done
```

Expected: `401` on all ten. Public data is reachable only through the read
functions in section 5, which apply explicit field allowlists rather than
exposing rows.

**One result that looks like a failure and is not.** A handful of frozen V1
tables (`reports`, `analysts`, `profiles`, `vouches`, `requests`,
`bounty_boosts`, `config`) still answer `200` because their compatibility read
policies remain. At the 2026-08-08 check, the first six returned an empty array
and `config` retained two non-secret compatibility rows. Their write policies
were revoked in
`20260727170000_osi_v1_legacy_policy_hardening.sql` and
`20260727173000_osi_v1_legacy_counter_readonly.sql`. Legacy helper modules remain
in the static bundle for `legacy.html` compatibility, but the V2 claims in this
guide are reproduced only through the dedicated read functions in section 5,
not from these rows. They are named here rather than left for you to trip over,
because a verification page that hides its own awkward results is not a
verification page.

Note that `reports` is a V1 table and is **not** the V2 report store. The V2
equivalents are `case_reports` and `case_report_versions`, both of which are in
the list above and both of which answer `401`.

## 7. Live configuration against the documentation

`osi_config` is deliberately readable by anyone. Governance thresholds that
decide what gets published are not the kind of thing a public-record system
should keep private, and a reader can hold the running system to its own
documentation:

```bash
curl -s "$OSI_API/rest/v1/osi_config?select=key,value" \
  -H "apikey: $OSI_KEY" -H "Authorization: Bearer $OSI_KEY"
```

Compare the result against the tables in
[docs/OSI_PRODUCTION_FEATURE_STATUS.md](OSI_PRODUCTION_FEATURE_STATUS.md). Every
flag classified there as live must read `true` in production, and every flag
classified as intentionally false must read `false`. A mismatch is a
documentation bug and is worth reporting.

What this exposes, on purpose: quorum count and weight thresholds, the
challenge window, the bootstrap tier ladder, and the rate-limit and quota
parameters. What it never exposes: any secret, key, or credential. Secrets live
in Edge Function environment variables and never in this table.

## 8. The full one-command audit

`scripts/verify-sas-mainnet.mjs` is a dependency-free Node script that does the
whole credential audit from scratch: it confirms the RPC is really mainnet by
genesis hash, checks that the SAS program is executable under the upgradeable
loader, checks that the Credential and Schema accounts are owned by that
program and have the expected byte shapes, confirms the Schema is cryptographically
bound to OSI's Credential, asserts the privacy statement and the `tier`/`status`
fields are present, then derives each analyst's attestation PDA and evaluates it.

It imports the same decision core the production Edge Functions run, so it is
not a re-implementation that could drift from what the server does.

```bash
git clone https://github.com/friendlyfiree/open-solana-intelligence
cd open-solana-intelligence

SOLANA_RPC_URL="https://api.mainnet-beta.solana.com" \
SAS_CREDENTIAL="D2tsrEHEXYPL82chv5PuwsQtALv1i5hXrWZorqyefJgX" \
SAS_SCHEMA="897TYTVN9aQfLWj2BJyhByQawsSuydLZcTpanZWCtxKz" \
SAS_ISSUER="FcwxSJJY6x7K4fPBzTVVtvaeYpg3E472ZNXL97aFmUkG" \
SAS_WALLETS="<comma separated analyst wallets>" \
node scripts/verify-sas-mainnet.mjs
```

It exits non-zero and prints the exact failed invariant if anything is wrong.
On success it prints a JSON audit record. The same script runs inside the
production launch workflow, so the audit a third party runs is the audit the
maintainer is held to.

Node 18 or newer. No install step, no dependencies.

## 9. The code and its tests

```bash
# every dependency-free suite, no install step
for t in tests/*.test.js tests/*.test.mjs; do node "$t"; done

# database authorization and lifecycle suites, needs the Supabase CLI + Docker
supabase db start
supabase db reset --local --no-seed      # applies every migration from zero
supabase db lint --local --level error
supabase test db                         # pgTAP
bash tests/osi-v2-concurrency.test.sh    # two-connection replay and race tests
```

The Node suites exercise the same `supabase/functions/_shared/*.mjs` decision
cores that run in production under Deno, so governance, payment, proof, wire,
and SAS logic is tested as shipped rather than as a copy.

## What verification does not tell you

Being able to check all of the above proves that OSI's process is what OSI says
it is. It does not prove that any conclusion inside a record is correct. OSI's
product is process integrity, not truth, and no amount of cryptography changes
that. A published record is a reviewed, attributable, challengeable claim. It
is never a verdict, and attribution stays challengeable permanently.
