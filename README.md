# Solana Treasury Watch

**Public companies say they hold SOL. We show the wallets.**

An open, on-chain-verified registry of public-company Solana treasuries — traced wallet-by-wallet through on-chain forensics, matched to public disclosures, and rated by confidence.

> `// don't trust the filing — verify the chain`

🔗 **Live:** `add-your-vercel-url-here`

---

## What it is

Trackers show you a *number*. Solana Treasury Watch shows you the *wallets* behind the number — funding sources, custody controllers, and validator-level staking — with the evidence and a confidence label on every address, so anyone can verify institutional SOL concentration for themselves.

Currently tracking **3 public companies** (Forward Industries · Solana Company / HSDT · Sharps Technology) across **38 attributed addresses**, with live balances pulled directly from the Solana chain.

## What makes it different

- **A verification layer, not a claim.** Nothing is presented as absolute. Every wallet carries a confidence level — Verified / High confidence / Publicly labeled.
- **Open methodology.** The full attribution technique is published, step by step, so anyone can reproduce or challenge a result. The trick isn't a secret.
- **Live, not static.** Wallet balances and the SOL price are fetched in real time; the gap between *declared* and *on-chain* is exactly what the registry surfaces.
- **A real Solana dApp.** Connect a Phantom wallet and signal demand / score reports with a verifiable on-chain memo transaction — no fees are collected, only the standard network fee applies.

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

- Static front end — `index.html` (HTML + CSS + JS, no build step).
- **All company + wallet data lives in `data.js`**, separate from the app code, so the registry can be updated without touching application logic.
- Live balances via Solana JSON-RPC (`getBalance`); live price via CoinGecko.
- Wallet connection + on-chain memo voting via [`@solana/web3.js`](https://github.com/solana-labs/solana-web3.js) and Phantom.

## Run it

Two files, served together: `index.html` and `data.js` (data.js must sit in the same folder). Deploy the folder to any static host (e.g., Vercel: drag the folder in → Deploy). To update the registry, edit `data.js` — the file documents exactly how to add a company.

## Roadmap

- **Now** — verified treasury registry (live).
- **Next** — more entities, this repo opened, Weekly Brief.
- **Soon** — community intelligence network: anyone requests an investigation, volunteer researchers contribute, every report open-source *with* its methodology.
- **Later** — on-chain escrow for bounties + on-chain, portable researcher reputation.

## Disclaimer

This is research, not financial advice. Wallet attribution is inherently probabilistic; labels reflect evidentiary strength, not legal certainty. Always verify independently before acting.

## License

[MIT](./LICENSE)
