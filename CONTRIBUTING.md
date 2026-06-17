# Contributing

Open Solana Intelligence (OSI) is an open registry. The most valuable contribution is a **new, well-evidenced wallet attribution**, but corrections, methodology improvements, and bug fixes are equally welcome.

## The bar for an attribution

Every wallet added to the registry must clear the same bar the existing entries did. A submission needs **both** halves:

1. **On-chain trail:** the transactions that link the wallet to the entity, including funding inflows, custody-controller fingerprints (Coinbase Prime, Fireblocks, Anchorage, BitGo, and others), and stake or withdraw-authority clustering. Include transaction signatures or explorer links.
2. **Off-chain anchor:** the public disclosure it matches, an SEC filing or press release with a **date and an amount** that the on-chain flow lines up with.

If you only have one half, it is not ready yet. Single-signal attributions are exactly what this project exists to replace.

## Confidence, not verdicts

Label every address with a confidence level, never a flat accusation:

- **Verified:** a definitive on-chain link (for example, a direct transfer from a known entity or Foundation wallet).
- **High confidence:** strong convergence of timing, size, custody, and disclosure, but no single proof of ownership.
- **Publicly labeled:** disclosed by the entity or its custodian, independently sanity-checked.

When in doubt, label down. "We can't be certain" is an acceptable and honest result.

## How to add a company or case study

All data lives in `data.js`, which contains step-by-step comment guides, **"HOW TO ADD A COMPANY"** and **"HOW TO ADD A CASE STUDY"**. You do not need to touch `index.html`: add your object to the data file and the app renders it.

## Process

1. Fork the repo and create a branch.
2. Add or edit your entry in `data.js`, following the in-file guide.
3. Open the page locally (just open `index.html` in a browser) and confirm it renders.
4. Open a pull request describing your evidence, and link the key transactions so a reviewer can verify the chain for themselves.

By contributing, you agree your work is released under the project's [MIT license](./LICENSE).
