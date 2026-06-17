/* ============================================================
   Solana Treasury Watch — COMPANY DATA
   ============================================================
   All company + wallet data lives HERE, separate from the app
   code on purpose: editing this file can never break how the
   site works. To update the registry you only ever touch this file.

   HOW TO ADD A COMPANY
   Copy one { ... } block inside companies[ ] and change the fields:
     id          : short slug, lowercase-with-dashes (must be unique)
     name        : display name
     ticker      : stock ticker, e.g. "STSS"
     exchange    : e.g. "NASDAQ"
     declaredSOL : number the company says it holds  (NO quotes, NO commas)
     avgCost     : average $/SOL, or null
     confidence  : "high"  (default dot colour for its wallets)
     custodians  : ["Coinbase Prime", ...]
     validators  : ["Jupiter", ...]            (use [] if none)
     summary     : one short paragraph
     timeline    : [{ date:"2025-09-01", event:"..." }, ...]
     sources     : [{ label:"...", url:"https://..." }, ...]   (or [])
     wallets     : [{ addr:"WALLET_ADDRESS", type:"label" }, ...]
                   add  confidence:"verified"  to a wallet for the green dot

   RULES THAT KEEP IT WORKING
   - Keep every "quote", , comma and { } [ ] bracket balanced.
   - Numbers have NO quotes and NO commas (declaredSOL: 2000000).
   - Every wallet needs an addr and a type.
   - After editing: re-deploy (or commit on GitHub) and you're done.
   ============================================================ */

window.TREASURY_DATA = {
  companies: [
    {
      id: "forward-industries",
      name: "Forward Industries",
      ticker: "FORD",
      exchange: "NASDAQ",
      declaredSOL: 6900000,
      avgCost: null,
      source: "community",
      confidence: "high",
      custodians: ["Coinbase Prime", "Fireblocks"],
      validators: [],
      summary: "The largest publicly-traded Solana treasury. 25 identified addresses across Coinbase Prime and Fireblocks custody, plus dedicated stake accounts. This wallet set is community-aggregated and cross-checked — not first-party attribution by this project.",
      timeline: [
        { date: "2025-09", event: "Treasury strategy established via PIPE financing" },
        { date: "2025-09", event: "Bulk SOL accumulation begins" }
      ],
      sources: [],
      wallets: [
        { addr: "FYPQEy1hPa5owwLRPrRDDE6AWZKXusufwaCGe72pLXvj", type: "Coinbase Prime Custody" },
        { addr: "7d4ZhfBRamc2szcuHbVGYbuKFNfjZoKeXm2S3JC2uXeP", type: "Coinbase Prime Custody" },
        { addr: "DrUaDcRmjVhuEoTNExydnVWisu6wwTWoe8f5DVJZJ5Bh", type: "Coinbase Prime Custody" },
        { addr: "96LHAJCo1AaKQKmRXAQ2pWDTRz7v7qWSiSRziEzXPkeR", type: "Coinbase Prime Custody" },
        { addr: "5tsTE13chYaj2AtakSyfxrMFuGRxLowXLbnpkJk6W3Y", type: "Coinbase Prime Custody" },
        { addr: "HTqfGde83HAGquU9JbfX8CkwaR56AELrrdu4X6aHCk2y", type: "Coinbase Prime Custody" },
        { addr: "EuHYgyQwp1M1D155jJRtSnpnw8Rf1mTKVFqAWvk4DBeT", type: "Coinbase Prime Custody" },
        { addr: "4PTib8Hv9T6DmtYVNjFKPSd6hTJXVxQ8VSADvTYvxqF1", type: "Coinbase Prime Custody" },
        { addr: "2RoTFMkfrzryYqkt3feBA5UaxAwvEWkoCzg1NUG8XnFV", type: "Coinbase Prime Custody" },
        { addr: "5wjSnZti7gXdFwMRKSGCx3pTaR111tby33VZ1JYm2c4g", type: "Coinbase Prime Custody" },
        { addr: "B6dtH1n1n7xCAyneSYM8GJTDdzm4ZHwr3Yt79h1xbiak", type: "Coinbase Prime Custody" },
        { addr: "Gft3xmznZdiMeSDz9m6MpBZCs4Gghk6Vj5pm4HgcsuKb", type: "Fireblocks Custody" },
        { addr: "5AYVHr45axSVr3Nw314PFcEY87cUG6iPiBbaiDAu5NYp", type: "Fireblocks Custody" },
        { addr: "3sDXAL3ojojK4znGuZJYL4bdMTXd9c5N4nSULAjgQJ6j", type: "Fireblocks Custody" },
        { addr: "26de9hfRYYCmGrGkYb8z48yDd49UZeXfXei6ms39azzY", type: "Fireblocks Custody" },
        { addr: "9mZyj53THUNMiCSUEzaDSo4oc42XUbbAJzYDwu4YF71U", type: "Stake Account" },
        { addr: "6W72bUKNUcrNhTE13x7PbXuaUDUy8pTkKhofA6JaQ7Fp", type: "Stake Account" },
        { addr: "5kuumvgSX6GFgEvWsRw1NXJhggAXKp1TRRXVRfrueifD", type: "Stake Account" },
        { addr: "2rCQCiAWqh5qZU6eLVfmwyk8K1rZaZ6GEabxPMbS2FbT", type: "Stake Account" },
        { addr: "ByDgEPVKudwLBHFYYhzq1khCWKHBNQfZVJD1L7gMQkw7", type: "Stake Account" },
        { addr: "HNhYTNCXgaskLRV2Zh6gVmTHSokKj19XcXsEsU2hKMqk", type: "Stake Account" },
        { addr: "Eqo5ep3A6A1kng6AybSvG1BExwGp48TbP6HymWupCTe7", type: "Stake Account" },
        { addr: "Foa3XmYxiFRsptJKPovTz8v1Mg4ZdgtHneTxRifK6WrN", type: "Stake Account" },
        { addr: "GTw9vw39HEVUJTbzJkstghpNyS3XDSXf6rKfX4QpsPVc", type: "Stake Account" },
        { addr: "4ZB8dPDb6V8cces72dYKQqiyewontUdXqPbFCJ9qQaUr", type: "Fundraise" }
      ]
    },
    {
      id: "solana-company",
      name: "Solana Company",
      ticker: "HSDT",
      exchange: "NASDAQ",
      declaredSOL: 2300000,
      avgCost: 232.50,
      source: "independent",
      confidence: "high",
      custodians: ["Coinbase Prime", "Anchorage Digital", "BitGo"],
      validators: ["Helius", "Twinstake"],
      summary: "Formerly Helius Medical Technologies. Holds a direct discount-purchase agreement with the Solana Foundation — received 1M+ SOL directly from a Foundation non-circulating supply wallet.",
      timeline: [
        { date: "2025-09-18", event: "$500M PIPE completed" },
        { date: "2025-09-22", event: "First SOL purchase announced (760,190 SOL)" },
        { date: "2025-09-29", event: "Renamed to Solana Company + Foundation discount agreement" },
        { date: "2025-10-06", event: "2.2M+ SOL holdings announced" },
        { date: "2025-10-10", event: "Coinbase, BitGo, Anchorage added as custodians" },
        { date: "2025-10-23", event: "Helius + Twinstake staking partnership" },
        { date: "2025-10-29", event: "2.3M SOL confirmed, ~7.03% APY" }
      ],
      sources: [
        { label: "First SOL purchase (GlobeNewswire)", url: "https://www.globenewswire.com/news-release/2025/09/22/3153779/0/en/Helius-NASDAQ-HSDT-Begins-Purchases-of-SOL-the-Native-Asset-of-Solana-Blockchain.html" },
        { label: "Foundation agreement + name change", url: "https://www.globenewswire.com/news-release/2025/09/29/3157697/0/en/Preeminent-SOL-Treasury-Company-Helius-NASDAQ-HSDT-Announces-Corporate-Name-Change-to-Solana-Company-and-Letter-of-Intent-with-Solana-Foundation.html" },
        { label: "2.2M SOL holdings", url: "https://www.globenewswire.com/news-release/2025/10/06/3161658/0/en/Solana-Company-NASDAQ-HSDT-Formerly-Helius-Continues-Amassing-SOL-the-Native-Asset-of-Solana-Blockchain.html" },
        { label: "Custodians added", url: "https://www.globenewswire.com/news-release/2025/10/10/3164820/0/en/Preeminent-SOL-Treasury-Vehicle-Solana-Company-NASDAQ-HSDT-Adds-Coinbase-BitGo-and-Anchorage-Digital-as-Custodians.html" },
        { label: "Staking services", url: "https://www.globenewswire.com/news-release/2025/10/23/3172120/0/en/Solana-Company-NASDAQ-HSDT-Strengthens-Treasury-Strategy-with-Helius-Anchorage-Digital-and-Twinstake-Staking-Services.html" }
      ],
      wallets: [
        { addr: "7kBQy7e14gW4CJ9BNBHhrxoHFtBthBmZyUWcuSCKkVEY", type: "Primary — Foundation transfer (1M+ SOL), Helius stake", confidence: "verified" },
        { addr: "9ggSjgTeNnvSGQYmMQJ1TwjiRmUFGCFfdUG54Gg2QCe3", type: "Helius + Twinstake stake, Coinbase Prime funded" },
        { addr: "BsnXPFsKpXSoHq5LLg2MhEhiyLwbx8h6fbemsm6gKeuo", type: "Cluster (shared deposit address)" },
        { addr: "98k8sDazxJbdvb6ENaapRmamyZoCDJY5FZjvakMfrL8X", type: "Cluster (shared deposit address)" },
        { addr: "Nw5Trj8i5jKzuJufc9iNp5azTYtk8pnAc2yhsm6BqRv", type: "Cluster (shared deposit address)" },
        { addr: "AMTdpu1npRe16Mkr9Wnz8uNyHN7oQ5xSzCcv4tt49zkK", type: "Cluster (shared deposit address)" },
        { addr: "BPA6SSHNWAVgr4RNxEUQUmMyejS71Jvkv1nF3Lpi8Lqj", type: "Cluster (shared deposit address)" },
        { addr: "DAtyhwj3AExisi2FS3Jw4ZU4Pq5PvATJ6fHzgsadzMHF", type: "Helius stake account (300K SOL)" }
      ]
    },
    {
      id: "sharps-technology",
      name: "Sharps Technology",
      ticker: "STSS",
      exchange: "NASDAQ",
      declaredSOL: 2000000,
      avgCost: null,
      source: "independent",
      confidence: "high",
      custodians: ["Coinbase Prime"],
      validators: ["Jupiter", "Chorus One", "Anchorage Digital"],
      summary: "Raised $400M+ to establish a Solana treasury. Six identified holding addresses across Coinbase Prime custody, with staking split across Jupiter, Chorus One and Anchorage Digital validators.",
      timeline: [
        { date: "2025-08-25", event: "$400M+ private placement announced" },
        { date: "2025-08-28", event: "Treasury strategy launched" },
        { date: "2025-09-02", event: "2M+ SOL acquisition announced" },
        { date: "2025-09-23", event: "Jupiter staking partnership" },
        { date: "2025-10-09", event: "Coinbase strategy expansion" }
      ],
      sources: [
        { label: "$400M placement announced", url: "https://www.prnewswire.com/news-releases/sharps-technology-inc-announces-over-400-million-private-placement-seeking-to-establish-the-largest-solana-digital-asset-treasury-strategy-302537587.html" },
        { label: "2M SOL acquisition", url: "https://www.prnewswire.com/news-releases/sharps-technology-inc-acquires-over-2-million-sol-the-native-asset-of-solana-the-fastest-and-most-used-public-blockchain-302543683.html" },
        { label: "Jupiter staking partnership", url: "https://www.prnewswire.com/news-releases/sharps-technology-and-jupiter-exchange-announce-staking-partnership-to-accelerate-solana-adoption-302563898.html" },
        { label: "Coinbase expansion", url: "https://www.prnewswire.com/news-releases/sharps-technology-expands-digital-asset-treasury-strategy-with-coinbase-302579160.html" }
      ],
      wallets: [
        { addr: "HHSNLApE2Txh6U2p2QsmfocE2fzoBk9fY5Vir9ndHM23", type: "Coinbase Prime Custody (Primary)" },
        { addr: "5tfHZEKdQFTEfYCNoGYbV8Sq6vfmCS83sVADFUSrTBE", type: "Coinbase Prime Custody (Secondary) — Jupiter" },
        { addr: "72aSNbcPea1QN7NbxmEuQqDmBVowZpvFi1AvNdUekX5C", type: "Cluster A Holding — Jupiter" },
        { addr: "DGVxn3q4TNFvDUXDHzM8gSTcYDNaqNmZ1vBkTiU4zCoX", type: "Cluster C Holding — Chorus One / Anchorage" },
        { addr: "4vvMe3mYNHrNb3rwZiqCWh3QCbTi6DaLN2NHbDxgSHM5", type: "Cluster C Holding — Anchorage Digital" }
      ]
    }
  ]
};


/* ============================================================
   CASE STUDIES — worked forensic reports (credited by author)
   ============================================================
   Each report renders as a collapsible card on the site.
   To add one, copy a { ... } block inside CASE_STUDIES[ ] and fill:
     id, company, ticker, exchange, author,
     declaredSOL, identifiedSOL   (numbers, no commas),
     summary  : one line shown on the collapsed card,
     intro    : opening paragraph,
     timeline : [{ date:"2025-09-01", event:"..." }, ...],
     clusters : [{ tag:"Cluster A", title:"...", body:"...",
                   proofs:[{ label:"↗ ...", url:"https://..." }] }, ...],
     holdings : [{ addr:"FULL_ADDRESS", short:"AAAA…ZZZZ",
                   balance:"450,537", validator:"..." }, ...],
     note     : closing "why it holds up" paragraph.
   ============================================================ */
window.CASE_STUDIES = [
  {
    id: "sharps-technology",
    company: "Sharps Technology",
    ticker: "STSS",
    exchange: "NASDAQ",
    author: "aksusarya",
    declaredSOL: 2000000,
    identifiedSOL: 1253407,
    summary: "Declared ~2M SOL → 1,253,407 SOL traced across 5 wallets. FalconX-funded, Coinbase Prime custody, staked on Jupiter, Chorus One & Anchorage.",
    intro: "Sharps Technology (NASDAQ: STSS) declared a ~2,000,000 SOL treasury. Starting only from its public filings, the chain led to 1,253,407 SOL across the five wallets below — funded through FalconX, held under Coinbase Prime Custody, and staked with Jupiter, Chorus One and Anchorage. These are the same addresses listed in the Sharps entry above; here's how they were found.",
    timeline: [
      { date: "2025-08-25", event: "$400M+ private placement announced (ParaFi, Pantera, FalconX, RockawayX…)" },
      { date: "2025-08-28", event: "Placement closes, treasury strategy launches → wallets must be funded on/after this date" },
      { date: "2025-09-02", event: "2M+ SOL acquisition announced → accumulation window is Aug 28 → early Oct" },
      { date: "2025-09-23", event: "Jupiter staking partnership → wallets should show Jupiter staking" },
      { date: "2025-10-09", event: "Coinbase expansion → wallets should interact with Coinbase Prime Custody" }
    ],
    clusters: [
      { tag: "Cluster A", title: "FalconX inflow → Coinbase custody → Jupiter",
        body: "Wallet 32pFK…uaws received 341,173 SOL from FalconX (Aug 30 – Sep 1), routed through Coinbase Prime Custody, then staked on Jupiter. Consolidated into 72aSN…kX5C.",
        proofs: [
          { label: "↗ 230K SOL FalconX inflow", url: "https://intel.arkm.com/explorer/tx/k1g1qQRzaykHiwoZeNxwbt6esMEbNS2pqeEXXiZtw3PtyhLnggCT9z6A56F7H8Bovc8VCZV9gF6Nny1RaKzA2LX" },
          { label: "↗ stake deployment", url: "https://intel.arkm.com/explorer/tx/3f72LPordFugdt4nywq3maZPpQDuVG9zhF6DaDXg3WkMkzDNLQb8bPcVuP35fuGbtaEjUhb4zwfamfPPpnK1ADJK" }
        ] },
      { tag: "Cluster B", title: "Secondary accumulation, same fingerprints",
        body: "Wallet 9i8p3…2zgV took 270K+ SOL from FalconX (Sep 1–5), staked via the same Coinbase Prime Custody wallet on Jupiter. Holdings under 2GyX8…fT1aX.",
        proofs: [
          { label: "↗ Jupiter stake proof", url: "https://intel.arkm.com/explorer/tx/g7i1bGENKGVZ4SDS8Zbnn43tJ9JXhy487MaEfyqitaUU1EksjA7vCU8Ge74a3pBKTT5fCDf4UV7uX14KGtKR1j5" }
        ] },
      { tag: "Cluster C", title: "Linked group, Chorus One + Anchorage",
        body: "Wallets DGVxn…zCoX and 4vvMe…SHM5 hold 507K SOL staked with Chorus One and Anchorage — tied to Cluster A by a direct transfer to 72aSN…kX5C.",
        proofs: [
          { label: "↗ inter-wallet link", url: "https://intel.arkm.com/explorer/tx/3qr19DGUYtV5cSr5WMUsSijHpMUSFGExnL1B2mCGTfXJc88QDmV18eppwZBNRaEcuQE3mEZqMhc9btuM48ctXMdC" }
        ] }
    ],
    holdings: [
      { addr: "HHSNLApE2Txh6U2p2QsmfocE2fzoBk9fY5Vir9ndHM23", short: "HHSNL…HM23", balance: "450,537", validator: "Coinbase Prime → Jupiter" },
      { addr: "5tfHZEKdQFTEfYCNoGYbV8Sq6vfmCS83sVADFUSrTBE", short: "5tfHZ…RTBE", balance: "202,580", validator: "Coinbase Prime → Jupiter" },
      { addr: "72aSNbcPea1QN7NbxmEuQqDmBVowZpvFi1AvNdUekX5C", short: "72aSN…kX5C", balance: "93,191", validator: "Jupiter" },
      { addr: "DGVxn3q4TNFvDUXDHzM8gSTcYDNaqNmZ1vBkTiU4zCoX", short: "DGVxn…zCoX", balance: "201,270", validator: "Chorus One + Anchorage" },
      { addr: "4vvMe3mYNHrNb3rwZiqCWh3QCbTi6DaLN2NHbDxgSHM5", short: "4vvMe…SHM5", balance: "305,829", validator: "Anchorage" }
    ],
    note: "Why this holds up. Assets moved under Coinbase Prime Custody control two days before the Oct 9 Coinbase announcement, and Jupiter staking appeared days before the Sep 23 partnership — on-chain behavior that pre-empts the public reveal. Combined with matching funding timelines, FalconX inflows, shared custody controllers and inter-wallet transfers, the convergence makes coincidental overlap highly unlikely. Still probabilistic, not legal proof — but a robust, independently verifiable attribution."
  },
  {
    id: "solana-company",
    company: "Solana Company",
    ticker: "HSDT",
    exchange: "NASDAQ",
    author: "aksusarya",
    declaredSOL: 2300000,
    identifiedSOL: 3000000,
    headlineValue: "1M+",
    headlineLabel: "DIRECT FROM FOUNDATION",
    summary: "999,999 SOL received directly from a Solana Foundation supply wallet — one day before the discount deal was public. Plus dual-validator (Helius + Twinstake) staking and a Coinbase-funded deposit cluster. Declared 2.3M.",
    intro: "Solana Company (NASDAQ: HSDT, formerly Helius Medical) declared 2,300,000 SOL. The standout finding: wallet 7kBQy…kVEY received 999,999 SOL directly from a Solana Foundation non-circulating-supply wallet — one day before the discount agreement was even announced. These wallets expand on the Solana Company entry above; here is the full trace.",
    timeline: [
      { date: "2025-09-18", event: "$500M PIPE completed → wallets must be funded on/after this date" },
      { date: "2025-09-22", event: "First SOL purchase announced (760,190 SOL at ~$231)" },
      { date: "2025-09-29", event: "Renamed Solana Company + discount-purchase agreement (LOI) with the Solana Foundation" },
      { date: "2025-10-06", event: "2.2M+ SOL holdings, average cost $232.50" },
      { date: "2025-10-10", event: "Coinbase, BitGo and Anchorage Digital added as custodians" },
      { date: "2025-10-23", event: "Helius, Anchorage and Twinstake staking services" },
      { date: "2025-10-29", event: "2.3M SOL confirmed, ~7.03% APY, $15M cash/stablecoins" }
    ],
    clusters: [
      { tag: "Cluster A", title: "Dual-validator wallet (Helius + Twinstake)",
        body: "9ggSj…QCe3 staked to BOTH Helius and Twinstake — first transfer 19 Sep (right after the 18 Sep PIPE), funded from Coinbase Prime and FalconX. Its Twinstake stake landed one day before the 23 Oct validator deal. ~$8M USDC also passed through, matching the disclosed $15M cash.",
        proofs: [
          { label: "↗ first transfer (19 Sep)", url: "https://intel.arkm.com/explorer/tx/KAAXeCotaFSdQqidJLBTyrma3wog1bHh7xDXxNiYXEzaCy1VpcDXHXkaDj6qGZ9bS2UVR3CiM4jVg3sZYt1H4si" },
          { label: "↗ 227K SOL from Coinbase Prime", url: "https://intel.arkm.com/explorer/tx/5kiM7Za5w5TUr9NdR1QPjfNcKRT7JGhNTwbmZT3RutNwJZF4wqVBhKcveWkED61gU432h2pqJM6hod6Y1dibJbXB" },
          { label: "↗ Twinstake stake", url: "https://intel.arkm.com/explorer/tx/33dErAdt42MLR7QvVPEgs8YbMwFzNJ6ZN9J5Rxn4Z3RuMLRg9ciNniEZuyauQRJ8bWoEgwSgxUccgWvi5R3T38Hx" }
        ] },
      { tag: "Cluster B", title: "The Solana Foundation transfer",
        body: "7kBQy…kVEY received 999,999 SOL (part of a 1,382,655 SOL move) straight from a Foundation non-circulating-supply wallet, co-signed by the Genesis community-allocation vault — one day before the 29 Sep agreement. 1,405,425 SOL staked from it, ~460K to Helius.",
        proofs: [
          { label: "↗ 1.38M / 999,999 SOL from Foundation", url: "https://intel.arkm.com/explorer/tx/MihnmxENnMhVYtXfrA6Cj4T3TxwDKJeCK2MLi7hMa2tgKvF7fZqxw4jtTDHkymLAhfsGmdGkkNGy7rwGiS2CUTi" },
          { label: "↗ Foundation transfer", url: "https://intel.arkm.com/explorer/tx/4DKFMKzJzzYgfS1RSbe4jHe41drUMnWiC1TcJZSXCZXhHuo6Xs6kDoPUwHFVj4q65aae3QcETNLUsb3zPXb7uK6a" }
        ] },
      { tag: "Cluster C", title: "Coinbase-funded deposit cluster",
        body: "BsnX, 98k8, Nw5T, AMTd and BPA6 were opened with 0.05 SOL each via Coinbase on 23 Sep and feed the same deposit address as 9ggSj — with a tell-tale sequential fingerprint (0.049 / 0.051 / 0.052 / 0.053 …) at near-identical timestamps.",
        proofs: [
          { label: "↗ 0.05 SOL wallet open (23 Sep)", url: "https://intel.arkm.com/explorer/tx/ncfmT8rHzCJVTfJcJ11riqXrHBfvLat8SDjJHWK7NyN8Tq9ZNfVFJa1fzjvnmQfMXNF2y5KN81JUtUVdhnDctsm" }
        ] }
    ],
    holdings: [
      { addr: "7kBQy7e14gW4CJ9BNBHhrxoHFtBthBmZyUWcuSCKkVEY", short: "7kBQy…kVEY", balance: "1,382,655", validator: "Foundation transfer → Helius" },
      { addr: "9ggSjgTeNnvSGQYmMQJ1TwjiRmUFGCFfdUG54Gg2QCe3", short: "9ggSj…QCe3", balance: "573,305", validator: "Helius + Twinstake" },
      { addr: "DAtyhwj3AExisi2FS3Jw4ZU4Pq5PvATJ6fHzgsadzMHF", short: "DAtyh…zMHF", balance: "300,000", validator: "Helius stake account" }
    ],
    footer: "On-chain footprint ≈ 3,000,000 SOL — exceeds the 2,300,000 declared because some addresses are commingled Anchorage custody or Foundation escrow. The 999,999 SOL direct from the Foundation is the definitive link.",
    note: "Why this holds up. The 999,999 SOL came straight from a Foundation non-circulating-supply wallet, co-signed by the Genesis community-allocation vault — keys only the Foundation controls — and landed one day before the discount agreement was public. Add dual-validator staking that matches the disclosed Helius/Twinstake deal, Coinbase Prime + FalconX funding, and a deposit cluster with sequential 0.05-SOL fingerprints, and coincidence is effectively ruled out. The aggregate footprint exceeds the declared 2.3M because some addresses are commingled custody or Foundation escrow — still probabilistic, but about as strong as on-chain attribution gets."
  }
];
