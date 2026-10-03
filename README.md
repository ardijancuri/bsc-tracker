# bscan

Public, read-only BNB Smart Chain KOL trade tracker. The 226 wallets and X handles in `server/roster.json` were normalized from the user-supplied GMGN KOL CSV. The app tracks exactly this roster and needs no GMGN API key. Names, handles, and wallet addresses are data supplied by the roster; bscan does not independently verify identity ownership.

## Pages

- `/trades` — observed swaps initiated by tracked wallets, with filters and BscScan links
- `/tokens` — tokens traded by tracked wallets, ordered by recent activity
- `/leaderboard` — wallets active in the last 24 hours, ranked by realized USD profit from positions bought and sold within that rolling window
- `/kol/:address` — wallet profile, X link, paginated trades from the last 24 hours, tokens, and 24-hour tracked P&L

The worker follows new BSC blocks via WebSocket and queries the local HTTP RPC for ERC-20 transfers, transactions, and receipts. It waits six blocks, stores trades once, and rescans after short reorganizations. BNB/USD comes from the [Chainlink BNB/USD feed on BSC](https://data.chain.link/feeds/bsc/mainnet/bnb-usd), read through the local node. BNB-quoted swaps are valued at the price reported near their block; stablecoin-quoted swaps use the quoted amount. Ambiguous interactions remain unpriced.

The public leaderboard uses a continuously moving 24-hour window and FIFO cost basis from observed, valued purchases made within that window. Sales without enough priced purchases in the window are excluded; complete sales still contribute, with an asterisk indicating excluded sales. A dash means sales occurred but none could be fully valued, while no sales means $0 realized. Auxiliary dividend trackers and ambiguous quote values duplicated across multiple assets in one transaction do not inflate P&L. These are tracked estimates: unobserved transfers, incomplete indexing, trading fees and gas can affect actual wallet profit. The worker verifies previously imported trades against historical BSC receipts through `BSC_HISTORICAL_RPC_HTTP` (defaulting to the official public endpoint); unverified imports do not affect P&L. New roster wallets begin accumulating trades when the worker first sees them. Token prices are the last observed swap price, not a market quote. The site has no wallet connection or trading action.

The token tracker includes recognized meme launchpad contracts and known meme coins, excluding quote assets, LP tokens and dividend trackers. Its initial one-hour window uses on-chain trade timestamps. Logos are validated by decoding their image bytes, cached locally and served through `/api/token-image/:address` with a content version. IPFS images retry independent gateways; oversized animation uses a compact still frame. Coins with unavailable artwork keep a readable initial while background retries continue.

## Run

Use Node.js 22+, PostgreSQL 17, and a BSC node with HTTP and WebSocket RPC. Copy `.env.example` to a private `.env`, set `BSCAN_DB_PASSWORD`, and run `docker compose up -d --build` on the VPS. The API binds to loopback port 3300; PostgreSQL binds to loopback port 5434. RPC access remains private. `GET /api/health` checks the API and database. `GET /api/overview` reports roster and data freshness.

For local development, run `npm install`, then `npm run dev` and `npm run dev:api`. The worker runs with `npm run dev:worker`. Use `npm run check` and `npm test` to verify the code.

## KOL images

`node scripts/fetch-kol-avatars.mjs` reads the roster's X handles, saves publicly available profile images in `public/kol-avatars/`, and records their source URLs in `server/x-avatars.json`. It skips images already saved; pass `--refresh` to fetch current photos again. Rebuild the app and worker after updating the manifest. Wallets with no retrievable X photo show their initial instead of an unrelated image. The worker retries missing public X photos weekly.

## Leaderboard P&L

The public 24-hour leaderboard is calculated from verified indexed trades every two minutes and stores period `1d` with its rolling window start. Optional `GMGN_API_KEY` still populates separate legacy 7-day and 30-day snapshots through the official batch wallet profits API; these are not used for the public ranking. Never commit the API key.
