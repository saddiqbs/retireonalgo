# retireonalgo.com

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A free, open-source Algorand DeFi dashboard for new and existing users — the easy door into Algorand DeFi.

Live at **[retireonalgo.com](https://retireonalgo.com)**.

## What it does

- **Connect your wallet** and see every liquidity position you hold across Algorand DEXes in one place (Tinyman V2 and Pact today, more to follow).
- **Summary strip** — total portfolio value, active pools, and $Retire held at a glance.
- **Top Opportunities** — the highest-APR pools on Algorand, ranked live from the Tinyman Analytics API and the Pact API. Unlocked by holding $Retire.
- **Get $Retire** — direct swap links to Tinyman and Vestige.

## Why

Algorand DeFi is growing but scattered — users have to jump between Tinyman, Pact, Folks, Vestige, and a block explorer to understand their own positions. retireonalgo.com pulls that into a single dashboard with plain language, so new users can actually see what's happening with their money.

## Tech stack

- **React 19 + Vite 8** — client-only SPA, no backend
- **[algosdk](https://github.com/algorand/js-algorand-sdk)** — chain reads via public Algonode endpoints
- **[@tinymanorg/tinyman-js-sdk](https://github.com/tinymanorg/tinyman-js-sdk)** — Tinyman V2 pool data
- **[@txnlab/use-wallet](https://github.com/TxnLab/use-wallet) + [@perawallet/connect](https://github.com/perawallet/connect)** — wallet integration
- **Cloudflare Pages** — hosting

No custom backend. All data comes from official SDKs and public APIs (Tinyman Analytics, Pact API, NFD, Algonode).

## Roadmap

- [x] Multi-wallet connect with $Retire detection
- [x] My Positions (Tinyman V2 + Pact)
- [x] Summary strip
- [x] Top Opportunities (locked behind $Retire)
- [x] Get $Retire swap links
- [ ] Learn section — beginner DeFi guides
- [ ] Smart contracts (staking, rewards) — to be written in [AlgoKit](https://github.com/algorandfoundation/algokit-cli) + [Puya](https://github.com/algorandfoundation/puya)

## Run locally

```bash
git clone https://github.com/saddiqbs/retireonalgo.git
cd retireonalgo
npm install
npm run dev
```

The dev server starts on `http://localhost:5173`.

## Build

```bash
npm run build     # production build to /dist
npm run preview   # build + serve via Wrangler locally
npm run deploy    # build + deploy to Cloudflare
```

## License

MIT — see [LICENSE](LICENSE). Free to fork, copy, and reuse.

## Contact

Built by [saddiqbs](https://github.com/saddiqbs), creator of the [$Retire](https://explorer.perawallet.app/asset/2581523977/) token on Algorand.
