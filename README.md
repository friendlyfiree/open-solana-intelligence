# Open Solana Intelligence (OSI)

**Institutions say they hold SOL. We show the wallets.**

Open, on-chain forensic intelligence on institutional Solana activity. Every wallet is mapped through first-hand forensics, matched to public disclosures, and rated by confidence, so anyone can check institutional SOL holdings for themselves instead of trusting a filing.

> `// don't trust the filing, verify the chain`

**Live:** https://solana-treasury-watch-bmua.vercel.app &nbsp;·&nbsp; **Repo:** https://github.com/friendlyfiree/solana-treasury-watch

![Open Solana Intelligence](preview.png)

---

## What it is

Most trackers give you a number. OSI gives you the wallets behind the number: funding sources, custody controllers, and validator-level staking, with the evidence and a confidence label on every address.

Today it tracks **3 public companies** (Forward Industries, Solana Company / HSDT, Sharps Technology) across **38 attributed wallets**, with balances pulled live from the Solana chain. It is built to extend across the rest of institutional Solana: ETFs, foundations, VCs, DAOs, validators, liquid-staking protocols, and custodians.

---

## Why OSI is different

Most on-chain intelligence platforms sell attribution to whoever pays, and the answer stays locked to that one buyer. OSI runs the opposite way.

Demand funds an investigation, analysts do the work, their peers verify it, and the result becomes a **permanent public record** anyone can check. The market here is **reputation, not resale**. A closed marketplace stops at the buyer; OSI stops at the public.

```
Demand for intelligence
        |
Search the open registry  ->  found:     already on the record (free, public)
        |
        +-----------------> not found:  open a bounty (sponsor-pledged, not held by OSI)
                                              |
                                         analysts investigate
                                              |
                                         peer review (weighted consensus)
                                              |
                            Published to the public record (open, permanent)
                                              |
          Sponsor releases reward on-chain - patrons credited - reputation grows
                                              |
                            Everyone gets the intelligence
```

---

## What is inside

- **Entity Registry** : the institutions we track and the exact wallets behind their declared SOL, live balances pulled straight from the chain, and the gap between disclosure and reality made visible.
- **The Field Office** : a live bounty board. Take an open case, trace the wallets, and earn the SOL reward when your work clears review. Each case carries a countdown and closes automatically when it lapses.
- **The Wire** : an intelligence feed where anyone can file a dispatch and put new evidence on the public record.
- **DAT Watch** : a leaderboard and watchlist of digital-asset-treasury companies, verified and unverified.
- **Network Graph** : an autonomous, explorable map of funding and custody relationships between entities and wallets.
- **Investigations** : long-form flagship case files, each one a reproducible chain of evidence.
- **Methodology** : the full tradecraft behind every entry, with no black boxes. Walk it in order, check the work, or run your own.
- **Community / Analysts** : a verified analyst roster with tiers and reputation, a peer-review floor, and a path for new analysts to apply and earn their place.

---

## How attribution works

Wallet attribution can look like magic. It is not. It is a repeatable chain of evidence:

1. **Anchor** : start from a wallet or fact disclosed in a filing, press release, or on-chain label.
2. **Funding trace** : follow the SOL backwards to its source (foundations, market makers, exchanges).
3. **Custody mapping** : identify the controller (Coinbase Prime, Fireblocks, Anchorage, BitGo, and similar) by behaviour and counterparties.
4. **Validator and staking analysis** : map stake delegation to surface relationships filings never mention.
5. **Confidence grading** : every claim is rated (verified, high-confidence, publicly labeled) so readers know exactly how solid each link is.

Each entry on the registry is built from these steps and can be reproduced independently with a block explorer.

---

## Peer review and progressive decentralization

OSI is built to give power away over time.

- Verified analysts **vouch** on pending reports and bounties in the review floor.
- Each vouch carries a **weight** set on the analyst's roster row (server-side, never client-controlled).
- When approve-weight reaches a configurable **threshold**, the item clears.
- A maintainer seal stays final in the early phase. When the network and its identity guarantees are strong enough, auto-publish can be turned on and the community publishes without a gatekeeper.

This is the Wikipedia model applied to on-chain forensics: open contribution, weighted peer review, and a public record that belongs to everyone.

---

## Tech

- **Static single-page app.** No build step, no server to run. One `index.html` deploys anywhere.
- **Solana** via `@solana/web3.js` and Phantom for wallet connect, tipping, and on-chain bounty rewards. Solana Pay supported for tips.
- **Supabase** (Postgres + row-level security) for community data: reports, bounties, the analyst roster, peer-review vouches, and configuration. Read access is public where it should be and locked where it must be; writes are gated by RLS and a maintainer login.
- **Helius** RPC for live balances; **CoinGecko** for pricing.
- Design language: a dark forensic-intelligence terminal in Solana green, Archivo and JetBrains Mono.

---

## Run it locally

No toolchain required.

```bash
git clone https://github.com/friendlyfiree/solana-treasury-watch.git
cd solana-treasury-watch
# open index.html in a browser, or serve it:
python3 -m http.server 8080
# then visit http://localhost:8080
```

The registry, methodology, graph, and flagship investigations work entirely offline. The community layer (bounties, reports, roster, review) talks to Supabase.

### Configuring the backend (optional)

Community features expect a Supabase project. The SQL to provision every table, policy, storage bucket, and seed is idempotent:

- `osi_supabase_setup.sql` : tables, row-level security, storage, and the seeded bounty board.
- `osi_admin_setup.sql` : maintainer (authenticated) full access.
- `osi_security.sql` : delete and size-guard hardening.
- `osi_consensus.sql` : analyst roster weighting, the vouches table, and the peer-review consensus trigger.

---

## Contributing

OSI is a community intelligence project. Two ways in:

- **File evidence or take a bounty.** Connect a wallet, open the Field Office or the Wire, and contribute. Cleared work is published to the public record and the bounty sponsor releases the reward on-chain (OSI does not hold or guarantee the funds).
- **Join the analyst roster.** Apply from the Community tab. Applications are reviewed privately by the maintainer; verified analysts gain a weighted vote in peer review and a public, reputation-tracked profile.

Code contributions are welcome via pull request. Keep additions dependency-light and reproducible.

---

## Disclaimer

OSI publishes intelligence derived from public filings, press releases, and public on-chain data. Declared figures come from company disclosures; live balances come directly from the Solana chain and may differ. Nothing here is financial, investment, or legal advice. Attributions are analytical conclusions, presented with their confidence level, and are open to correction through the public review process.

---

*Built for the Solana community. Open intelligence, not a paywall.*
