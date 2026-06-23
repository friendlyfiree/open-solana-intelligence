# Open Solana Intelligence (OSI)

**An open, community-run desk for on-chain investigations.**

When SOL leaves a wallet and you cannot trace it yourself, the usual options are a paid analyst who answers to one client, or silence. OSI is the opposite. Anyone can open a case for free, verified analysts trace where the funds went and how, their peers review the work, and the finding becomes a permanent public record. It works the same for a drained wallet and for an institution's treasury. We follow the money, not people, and we never promise to recover funds.

> `// you should not have to trace it alone`

<!-- ============================================================= -->
<!--  MAINTAINER: paste the live URL on the line below after you   -->
<!--  rename or redeploy the Vercel project, then re-upload this   -->
<!--  file. No code change is needed; the app does not hardcode    -->
<!--  its own address.                                             -->
<!-- ============================================================= -->

**Live:** `<< PASTE YOUR VERCEL URL HERE >>`

**Source:** https://github.com/friendlyfiree/solana-treasury-watch

---

## What we promise, and what we never will

OSI is built to be safe for the people who need it most. Three lines are non-negotiable, and they appear throughout the product:

- **No recovery, ever.** On-chain transfers are final. OSI traces and documents what happened. It cannot reverse, freeze, or recover funds, and it will never promise to.
- **We never DM you first.** OSI and its analysts never message you out of the blue, and never ask for a fee, a seed phrase, or wallet access. Anyone promising to recover your funds for a payment is a scammer.
- **The money, not the person.** Investigations follow the fund flow and the mechanism, every step backed by a transaction hash. No accusations, no identities, no doxxing.

Before any case or report is submitted, a hard-stop safety screen makes the contributor confirm they are not sharing a private key, and that only publicly verifiable, open-source evidence will be published. Private messages and personal data never belong here.

## How it works

1. **Something needs tracing.** A drained wallet, a suspicious flow, or an institution's treasury.
2. **Open a case, free.** Describe what happened and sign it on-chain. No fee to open.
3. **Analysts investigate.** Verified analysts trace funding, custody, and validators directly on the chain.
4. **Peers review.** Other analysts vouch for or flag the work. Weak or unproven attribution is caught here.
5. **Consensus publishes.** A finding goes public only when enough independent analysts agree. No single voice decides.
6. **Always correctable.** Every entry stays open and can be challenged with better evidence.

OSI governs itself like Wikipedia for on-chain investigations. Today a maintainer holds the final seal while the analyst roster grows, so nothing slips through unchecked. As the roster grows, that power moves to the network: a record no one, including us, can quietly control.

## What is shipped

This is a working product, not a mockup. Live today:

- **Field Office** is the live case board. Anyone posts a case for free; analysts claim it and trace the wallets. The Wire, a feed for unprompted dispatches, sits alongside it as a sub-tab.
- **DAT Watch** tracks every public Solana treasury company and whether it has been traced yet, with coverage totals on top. The Network map, an explorable graph of how SOL moves between foundations, market makers, custodians, and treasuries, sits alongside it as a sub-tab.
- **Registry** is the wallets behind each tracked institution, with a confidence grade on every address.
- **Investigations** is the published, long-form case files.
- **Methodology** is exactly how the attribution is done, in the open.
- **Community** is the open roster, the peer-review floor, and the path to self-governance.
- A **guided tour** walks the whole product end to end, no wallet needed.

The registry today covers 3 public companies (Forward Industries, the Solana Company / HSDT, and Sharps Technology) across 38 attributed wallets, with balances pulled live from the chain. It is built to extend across the rest of institutional Solana, and the same tradecraft applies to tracing an individual incident.

## On-chain and verifiable

OSI is a real Solana dApp. Connect Phantom and the core actions, opening a case, vouching on a report, signaling demand, and sending support, each write a signed SPL memo to Solana mainnet. Every action is a public audit trail, links straight to Solscan, and can be checked by anyone. A memo is evidence of an action, not a verdict, and OSI never holds or moves your funds. Support and any optional reward move over Solana Pay, peer to peer, settled on-chain. No fee is collected beyond the standard network cost.

## Safety and security by design

- **Only the public key ships.** The page carries the Supabase publishable (anon) key only, which is public by design. Row-level security and a maintainer-approval step govern what can be read or published. No admin or service key ever touches the code.
- **Domain-locked RPC.** The Helius key shipped in the page only works from the project's own origin.
- **No raw HTML, safe links only.** Nothing a visitor types is rendered as raw HTML, and only http and https links are accepted, so the board cannot be used for injection.
- **Open-source evidence only.** Contributors are required to keep submissions to publicly verifiable, on-chain facts. Private messages, personal data, and accusations are rejected by design.

## Stack and data

No framework and no build step. The app is a single static `index.html`, self-contained, that runs anywhere static files are served.

- **Live balances:** [Helius](https://www.helius.dev) RPC on Solana mainnet, with the public node as an automatic fallback.
- **Live price:** the CoinGecko public API, so the gap between declared and on-chain is always shown in current dollars.
- **Wallet and on-chain actions:** [`@solana/web3.js`](https://github.com/solana-labs/solana-web3.js) with Phantom and the SPL Memo program, with payments over Solana Pay.
- **Shared community layer:** an optional [Supabase](https://supabase.com) backend for the global case board, the roster, peer review, and the on-chain action index, all governed by row-level security.
- **Form delivery:** analyst applications and the weekly brief reach the maintainer through [Web3Forms](https://web3forms.com).

All entity and wallet data is auditable. Every attribution carries its evidence and a confidence label, and the methodology to reproduce it is published in full.

## Run it locally

Serve `index.html` from any static host. With Vercel, drag the file in and deploy. No build, no backend required. To turn on the shared community layer, create a free Supabase project, run the SQL from the setup notes, and paste your project URL and publishable key into the two constants near the top of the script.

## Roadmap

- **Live now, the desk is open.** Open a case, traced wallets, case files, and the safety rules, all live. Free to use, public to read.
- **Next, open the code.** The full codebase and dataset on GitHub, more entities on the registry, and the weekly brief wired up.
- **Soon, grow the roster.** More verified analysts reviewing each other's work. Consensus clears a finding, never one single voice.
- **Later, hand it to the network.** Approval moves from the maintainer to the analysts themselves, weighted by reputation. A Wikipedia for on-chain investigation, run by the people who do the work.

The near-term list is deliberately small and achievable for a solo maintainer. The later list is the direction of travel, not a promise with a date.

## Contributing

New attributions and case work are welcome, see [CONTRIBUTING.md](./CONTRIBUTING.md). The bar is deliberately high: every claim needs an on-chain trail, a documented confidence level, and only public, open-source evidence. No private data, ever.

## Disclaimer

This is open-source research, not financial, legal, or recovery advice. On-chain attribution is probabilistic; labels reflect evidentiary strength, not legal certainty. OSI does not recover funds and never promises to. Always verify independently before acting.

## License

[MIT](./LICENSE)
