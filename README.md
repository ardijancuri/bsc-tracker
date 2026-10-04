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

## Radar, watchlists, holdings and launches

The app supports English and Simplified Chinese. The language selector is on the right side of the header, with a compact control on mobile; the selection is saved in browser local storage and applies across pages, accessible labels, dates and number formatting. Token/KOL identities and on-chain data remain unchanged. UI copy is maintained in `src/zh-CN.ts`; translations do not require external requests.

Chinese token detail pages show a short English name beneath the original title. `/api/tokens/:address/translation` translates the Chinese full name, or symbol when a Chinese full name is unavailable. Successful translations persist by normalized source text, so duplicate token names share a cache and renamed tokens use a new entry. English/Japanese/Korean names are skipped. MyMemory receives only public token names and the language pair, never browser cookies or wallet data. Its [documented API](https://mymemory.translated.net/doc/spec.php) allows 500-byte inputs; requests share a persistent 5,000-character daily anonymous allowance, with two concurrent lookups and an hour between failed attempts. A provider outage or exhausted allowance exposes a compact Google Translate link rather than an incorrect name. These are automatic translations, not official token renames.

`/trades?view=radar` shows 20 signals at a time with expandable transaction evidence. `/trades?view=watchlist` groups followed KOLs/tokens and their signals. Filters are saved in the same browser: 5/10/30 minute buying windows, 2–10 distinct buyers, categories. A new filter profile backfills the last day without alerting. Live triggers use confirmed chain order and a ten-minute cooldown. Imported activity is silent; corrected signals remain visible after a reorganization.

A secure HttpOnly, SameSite=Strict cookie identifies an anonymous watchlist; the server stores its hash. No wallet connection or account signup is needed. Follow stars appear on profiles, token cards and leaderboard rows. Clearing Watchlist deletes its session and preferences. Cross-device recovery is deferred.

Holding badges use confirmed `balanceOf` snapshots and tracked-wallet ERC-20 movements, including transactions initiated by other wallets. Initial positive balances establish Holding; later labels require matching movement evidence. Zero without a known sale, mixed/unexplained changes, RPC failures and snapshots more than five minutes old show Unknown. Exact quantities are available on expansion. Holdings do not alter the rolling 24-hour P&L calculation. Reconciliation uses four concurrent balance RPC calls and prioritizes new movements and watched positions.

`/tokens?view=launches` covers Four.meme classic V1/V2 and Flap tokens already traded by the roster. Membership comes from Helper3/Portal state and official events; address suffixes do not establish launch membership. Progress uses each token's on-chain target; 90% starts Near graduation. Initial discovery of an already-graduated token is silent. Dates come from contract timestamps or indexed events and remain unavailable when history is missing. Flap Infinity uses its separate pool ID, never a vault as a pair. DEX Screener observations keep their timestamp and explicitly recorded first liquidity baseline. OpenFour and other launch protocols are unavailable in this release.

The migration is in `server/intelligenceSchema.ts`. Collection, signal evidence, movement snapshots, launch observations persist in PostgreSQL. Reorg handling marks signals corrected and removes affected observations. Independent collector loops keep launch RPC retries from delaying Radar. `GET /api/intelligence/health` reports processing lag, stale positions; `/api/overview` includes chain lag.

### Validation

Run `npm run check`, `npm test`, and `npm run build`. For database-backed validation, create a disposable PostgreSQL database named `bscan_intelligence_test` or `bscan_intelligence_test_<digits>` and set its private `DATABASE_URL`, then run `npm run test:integration`. The runner refuses other database names, mocks RPC/DEX Screener, and tests migrations, profile backfills, isolation, movements, stale/failed checks, launch milestones, pool IDs and reorgs. `INTELLIGENCE_PREVIEW_FIXTURES=1` leaves synthetic fixtures for isolated desktop/mobile QA; never use them in production.
