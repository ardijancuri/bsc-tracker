# bscan

Public, read-only BNB Smart Chain KOL trade tracker. The 226 wallets and X handles in `server/roster.json` were normalized from the user-supplied GMGN KOL CSV. The app tracks exactly this roster and needs no GMGN API key. Names, handles, and wallet addresses are data supplied by the roster; bscan does not independently verify identity ownership.

## Pages

- `/trades` — observed swaps initiated by tracked wallets, with filters and BscScan links
- `/tokens` — tokens traded by tracked wallets, ordered by recent activity
- `/leaderboard` — 1, 7, and 30 day realized USD profit from valued observed trades
- `/kol/:address` — wallet profile, X link, trades, tokens, and observed P&L

The worker follows new BSC blocks via WebSocket and queries the local HTTP RPC for ERC-20 transfers, transactions, and receipts. It waits six blocks, stores trades once, and rescans after short reorganizations. BNB/USD comes from the [Chainlink BNB/USD feed on BSC](https://data.chain.link/feeds/bsc/mainnet/bnb-usd), read through the local node. BNB-quoted swaps are valued at the price reported near their block; stablecoin-quoted swaps use the quoted amount. Ambiguous interactions remain unpriced.

The leaderboard uses FIFO cost basis for observed, valued buys and sells, including buys before the selected period when they are in the indexed history. If any sale in a period lacks a verified, fully valued cost basis, its P&L is a dash rather than a partial total. A wallet with no observed sales in the period shows $0. The worker verifies previously imported trades against historical BSC receipts through `BSC_HISTORICAL_RPC_HTTP` (defaulting to the official public endpoint); unverified imports do not affect P&L. New roster wallets begin accumulating trades when the worker first sees them. Token prices are the last observed swap price, not a market quote. The site has no wallet connection or trading action.

## Run

Use Node.js 22+, PostgreSQL 17, and a BSC node with HTTP and WebSocket RPC. Copy `.env.example` to a private `.env`, set `BSCAN_DB_PASSWORD`, and run `docker compose up -d --build` on the VPS. The API binds to loopback port 3300; PostgreSQL binds to loopback port 5434. RPC access remains private. `GET /api/health` checks the API and database. `GET /api/overview` reports roster and data freshness.

For local development, run `npm install`, then `npm run dev` and `npm run dev:api`. The worker runs with `npm run dev:worker`. Use `npm run check` and `npm test` to verify the code.

## KOL images

`node scripts/fetch-kol-avatars.mjs` reads the roster's X handles, saves publicly available profile images in `public/kol-avatars/`, and records their source URLs in `server/x-avatars.json`. It skips images already saved; pass `--refresh` to fetch current photos again. Rebuild the app and worker after updating the manifest. Wallets with no retrievable X photo show their initial instead of an unrelated image. The worker retries missing public X photos weekly.

## Leaderboard P&L

Set `GMGN_API_KEY` in the deployment `.env` to load 1-day, 7-day, and 30-day realized USD profit from GMGN's official batch wallet profits API. The worker refreshes it every two minutes. This read-only endpoint needs an API key but no wallet private key. Without a key, the leaderboard shows an explicitly labeled estimate calculated from the on-chain trades indexed by this app. These estimates can differ from GMGN because the indexed history and cost basis may be incomplete. Never commit the API key.
