# Solana Treasury Watch

**Public companies say they hold SOL. We show the wallets.**

An open, on-chain-verified registry of public-company Solana treasuries — each wallet mapped through original on-chain forensics, matched to public disclosures, and rated by confidence.

> `// don't trust the filing — verify the chain`

**🔗 Live:** _add your Vercel URL here_ &nbsp;·&nbsp; **Repo:** https://github.com/friendlyfiree/solana-treasury-watch

![Solana Treasury Watch](preview.png)

---

## What it is

Trackers show you a *number*. Solana Treasury Watch shows you the *wallets* behind the number — funding sources, custody controllers, and validator-level staking — with the evidence and a confidence label on every address, so anyone can verify institutional SOL concentration for themselves.

Currently tracking **3 public companies** (Forward Industries · Solana Company / HSDT · Sharps Technology) across **38 attributed addresses**, with live balances pulled directly from the Solana chain.

The dashboard is organized into four sections: **Registry** (the wallets), **Methodology** (how the attribution is done), **Case Studies** (full forensic write-ups), and **Community** (the contribution layer).

## What makes it different

- **Original attribution, not relabeled data.** The wallet mapping is first-hand forensic work — funding traces, custody fingerprints and stake clustering done from the raw chain, not copied from third-party label sets.
- **A verification layer, not a claim.** Nothing is presented as absolute. Every wallet carries a confidence level — Verified / High confidence / Publicly labeled.
- **Open methodology.** The full attribution technique is published, step by step, so anyone can reproduce or challenge a result. The trick isn't a secret.
- **Live, not static.** Wallet balances and the SOL price are fetched in real time; the gap between *declared* and *on-chain* is exactly what the registry surfaces.
- **A real Solana dApp.** Connect a Phantom wallet and signal demand / score reports with a verifiable on-chain memo transaction — no fees are collected, only the standard network fee applies.

## Case studies

Beyond the registry, each attribution is backed by a full, reproducible write-up — timeline, evidence clusters, and links to the on-chain transactions.

- **Solana Company (HSDT)** — declared 2.3M SOL. The decisive link: a treasury wallet received **999,999 SOL directly from a Solana Foundation non-circulating-supply wallet**, co-signed by the Genesis community-allocation vault, one day before the discount agreement was public — alongside dual-validator (Helius + Twinstake) staking and a Coinbase-funded deposit cluster.
- **Sharps Technology (STSS)** — declared 2M SOL. Assets moved under Coinbase Prime Custody control *two days before* the custody partnership was announced, with Jupiter staking appearing days before that partnership went public — on-chain behavior that pre-empts the disclosure.

Each write-up carries the same honest caveat: the evidence converges, but clustering is not legal proof.

## Methodology (short version)

1. **Anchor on a disclosure** — an SEC filing or press release with a date and an amount.
2. **Match the funding flow** — find on-chain inflows whose timing and size line up with the disclosure.
3. **Fingerprint the custodian** — Coinbase Prime, Fireblocks, Anchorage and BitGo each leave recognizable on-chain patterns.
4. **Cluster stake & deposit accounts** — group accounts by shared stake / withdraw authority and common funding.
5. **Cross-validate before labeling** — require at least two independent signals, then assign a confidence level, not a verdict.

**Confidence taxonomy**

| Label | Meaning |
|---|---|
| **Verified** | A definitive on-chain link (e.g., a direct transfer from a known Foundation/entity wallet). |
| **High confidence** | Strong evidentiary clustering — timing, size, custody and disclosure converge — but no single proof of ownership. |
| **Publicly labeled** | Disclosed by the entity or its custodian; relayed here and independently sanity-checked. |

> On-chain attribution is probabilistic. "High confidence" means the evidence strongly converges — **not** legal certainty. Every attribution here can be challenged with better evidence, in the open.

## Tech

- Static front end — `index.html` (HTML + CSS + JS, no build step, no framework).
- **All company + wallet data lives in `data.js`**, separate from the app code, so the registry can be updated without touching application logic. The file documents exactly how to add a company and a case study.
- Live balances via Solana JSON-RPC (`getBalance`); live price via CoinGecko.
- Wallet connection + on-chain memo voting via [`@solana/web3.js`](https://github.com/solana-labs/solana-web3.js) and Phantom.

## Run it

Two files, served together: `index.html` and `data.js` (data.js must sit in the same folder). Deploy the folder to any static host (e.g., Vercel: drag the folder in → Deploy). To update the registry, edit `data.js` — no build, no backend.

## Contributing

New attributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). The bar is deliberately high: every submitted wallet needs **both** an on-chain trail and an off-chain disclosure to match, plus a documented confidence level.

## Roadmap

- **Now** — verified treasury registry, open methodology, and the first case studies (live). Repo public.
- **Next** — more entities and case studies; the Weekly Brief.
- **Soon** — community intelligence: anyone can open a request *and* anyone can back it with a tip, so a bounty is funded by the whole community rather than a single buyer; volunteer researchers pick it up, every report open-source *with* its methodology.
- **Later** — pooled on-chain escrow for bounties + portable, on-chain researcher reputation.

## Disclaimer

This is research, not financial advice. Wallet attribution is inherently probabilistic; labels reflect evidentiary strength, not legal certainty. Always verify independently before acting.

## License

[MIT](./LICENSE)
