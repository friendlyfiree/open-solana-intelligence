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
      source: "independent",
      confidence: "high",
      custodians: ["Coinbase Prime", "Fireblocks"],
      validators: [],
      summary: "The largest publicly-traded Solana treasury. 24 identified addresses across Coinbase Prime and Fireblocks custody, plus dedicated stake accounts.",
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
