# kollens

Public, read-only BNB Smart Chain KOL trade tracker. The 226 wallets and X handles in `server/roster.json` were normalized from the user-supplied GMGN KOL CSV. The app tracks exactly this roster and needs no GMGN API key. Names, handles, and wallet addresses are data supplied by the roster; kollens does not independently verify identity ownership.

## Brand assets

The approved source logo is preserved in `branding/kollens-approved/source.svg`. The white/yellow variants in `public/kollens-logo-{white,yellow}.svg` and `public/kollens-icon-{white,yellow}.svg` are the build's canonical assets. The app's header and footer both use the yellow K with white wordmark. `npm run brand:export` regenerates only the favicons, touch icon, trade replay artwork and native-path fallbacks, and the website's social preview. Artwork URLs are versioned to avoid stale browser and social caches. The export runs before every production build. Final X assets are listed in `branding/README.md`.

Link previews use a 1200 × 630 PNG with the current gold K/white wordmark. Open Graph and X metadata point to the same `/social/kollens-preview-<PNG-content-hash>.png` pathname, so changed preview artwork receives a new URL independently of favicon versions. The legacy header-image path also serves the current artwork. Third-party previews already cached for a page can remain stale until that service fetches the page again.

## Pages

- `/trades` — observed swaps initiated by tracked wallets, with filters and BscScan links
- `/tokens` — tokens traded by tracked wallets, ordered by recent activity
- `/leaderboard` — profit realized in the last 24 hours using historical FIFO costs, fees and marked transfers; incomplete results remain unranked
- `/kol/:address` — wallet profile, X link, paginated trades from the last 24 hours, tokens, and 24-hour tracked P&L

The worker follows new BSC blocks via WebSocket and queries the local HTTP RPC for ERC-20 transfers, transactions, and receipts. It waits six blocks, stores trades once, and rescans after short reorganizations. BNB/USD comes from the [Chainlink BNB/USD feed on BSC](https://data.chain.link/feeds/bsc/mainnet/bnb-usd), read through the local node. BNB-quoted swaps are valued at the price reported near their block; stablecoin-quoted swaps use the quoted amount. Ambiguous interactions remain unpriced.

The public leaderboard uses the shared exact-decimal accounting ledger. The rolling 24-hour window selects realized sales, marked transfer-out gains and authenticated fee-only costs; FIFO purchase lots can come from earlier history. Acquisition fees enter the original lots, and disposal fees are counted once. The worker prepares versioned snapshots from stored node evidence and reconciled historical imports; page requests only read committed results. Complete results are ranked. An incomplete wallet can show an explicitly labeled known subtotal without being ranked; an unresolved result stays unavailable instead of becoming zero. Profile statistics read the identical stored snapshot, including its original as-of time and coverage. Existing token exclusions and public/private wallet isolation also apply to this accounting.

The token tracker includes recognized meme launchpad contracts and known meme coins, excluding quote assets, LP tokens and dividend trackers. Its initial one-hour window uses on-chain trade timestamps. Logos are validated by decoding their image bytes, cached locally and served through `/api/token-image/:address` with a content version. IPFS images retry independent gateways; oversized animation uses a compact still frame. Coins with unavailable artwork keep a readable initial while background retries continue.

KOL profiles exclude quote assets, LPs, dividend trackers, registered stock tokens and the reward/pair-asset contracts listed in `server/kolProfileToken.ts` from token cards, trade lists, activity counts and last-trade timestamps. The contract list includes the requested oANTHROPIC, TRX and ZEC assets, other verified established payout/pair assets, Paimon market assets, the CMC20 index and verified wrapped xStocks observed in KOL activity. The same filter prevents their per-token P&L, replay preparation and Telegram trade alerts. It runs before pagination; raw indexed trades and transfer evidence remain available for accounting of other tokens. Unknown contracts, unrelated tokens with matching names and dividend-paying meme tokens remain eligible.

## Run

Use Node.js 22+, PostgreSQL 17, and a BSC node with HTTP and WebSocket RPC. Copy `.env.example` to a private `.env`, set `BSCAN_DB_PASSWORD`, and run `docker compose up -d --build` on the VPS. The API binds to loopback port 3300; PostgreSQL binds to loopback port 5434. RPC access remains private. `GET /api/health` checks the API and database. `GET /api/overview` reports roster and data freshness.

For local development, configure a private `.env` with `DATABASE_URL` and optional worker-only historical import credentials, run `npm install`, then `npm run dev` and `npm run dev:api`. The API reads the local `.env` automatically. The worker runs with `npm run dev:worker`. Use `npm run check` and `npm test` to verify the code.

Telegram login is optional. Login opens the Kollens bot, which sends a one-time link back to the app for explicit account confirmation. Configure the dedicated bot's server-only Bot API credentials, authenticated webhook and OIDC recovery/consent callback using [Telegram login setup](docs/telegram-login.md). Empty credentials keep guest watchlists working without sign-in. Credentials belong only to server containers.

The Watchlist KOL tab offers separately opted-in Telegram live trade alerts. Once activated, all favorite KOLs send confirmed buys/sells unless individually muted; users can pause alerts and select sides. Delivery uses a durable worker outbox, groups rapid follow-up trades into ten-second summaries, and skips trades older than five minutes. It does not wait for GMGN, P&L or replay loading. The existing bot's separate Bot API token is required; production webhook registration is an explicit release operation, never automatic. See the setup guide for local testing, consent and `/stop`. Run `npm run test:integration:notifications` only with a disposable `bscan_notifications_test` database.

## KOL images

`node scripts/fetch-kol-avatars.mjs` reads the roster's X handles, saves publicly available profile images in `public/kol-avatars/`, and records their source URLs in `server/x-avatars.json`. It skips images already saved; pass `--refresh` to fetch current photos again. Rebuild the app and worker after updating the manifest. Wallets with no retrievable X photo show their initial instead of an unrelated image. The worker retries missing public X photos weekly.

## Trades, P&L and replays

Normal financial requests read PostgreSQL evidence captured from the VPS node. One exact FIFO ledger supplies public KOL profiles, private Portfolio positions, trade details and replay exports. Public KOLs retain lifetime imported baselines; Portfolio begins at each wallet membership's addition boundary. Six initial token cards include compact batched P&L summaries.

Current prices and genuine independent market candles come from authenticated token markets, including other traders' swaps and confirmed pool-state quotes. GMGN is restricted to resumable public historical migration/onboarding imports; no live financial DexScreener, CoinMarketCap or GeckoTerminal fallback remains. Unknown costs, unsupported decoding, inconsistent balances and incomplete chart coverage remain explicit.

The public 24-hour leaderboard now uses historical FIFO costs from the same node-owned accounting flow as token positions. Its worker refreshes stored period snapshots every 30 seconds; neither the API nor the leaderboard calculation requests live financial providers. Older unknown costs remain explicit until reconciled historical recovery completes. Legacy window-only calculations and GMGN leaderboard snapshot switches are retired.

See [Node-owned financial data](docs/node-owned-data.md) for collection stages, accounting policy, historical imports, immutable replay preparation, privacy and the separately authorized release procedure.

## Radar, watchlists, holdings and launches

The app supports English and Simplified Chinese. The language selector is on the right side of the header, with a compact control on mobile; the selection is saved in browser local storage and applies across pages, accessible labels, dates and number formatting. Token/KOL identities and on-chain data remain unchanged. UI copy is maintained in `src/zh-CN.ts`; translations do not require external requests.

Chinese token detail pages show a short English name beneath the original title. `/api/tokens/:address/translation` translates the Chinese full name, or symbol when a Chinese full name is unavailable. Successful translations persist by normalized source text, so duplicate token names share a cache and renamed tokens use a new entry. English/Japanese/Korean names are skipped. MyMemory receives only public token names and the language pair, never browser cookies or wallet data. Its [documented API](https://mymemory.translated.net/doc/spec.php) allows 500-byte inputs; requests share a persistent 5,000-character daily anonymous allowance, with two concurrent lookups and an hour between failed attempts. A provider outage or exhausted allowance exposes a compact Google Translate link rather than an incorrect name. These are automatic translations, not official token renames.

`/trades?view=radar` shows 20 signals at a time with expandable transaction evidence. `/trades?view=watchlist` groups followed KOLs/tokens and their signals. Signals use fixed system detection settings; there are no saved token or KOL Radar filter controls. Live triggers use confirmed chain order and a ten-minute cooldown. Imported activity is silent; corrected signals remain visible after a reorganization.

A secure HttpOnly, SameSite=Strict cookie identifies an anonymous watchlist; the server stores its hash. No wallet connection or account signup is needed. Optional Telegram login saves favorite tokens and KOLs to an account for access across devices. Sign-in merges guest favorites without duplicates. Follow stars appear on profiles, token cards and leaderboard rows. Removing favorites does not end an authenticated login. Logout revokes this device's session and returns to an empty guest watchlist; account favorites remain saved. Each watchlist supports up to 100 tokens and 100 KOLs. An over-limit merge leaves both lists unchanged.

Holding badges use confirmed `balanceOf` snapshots and tracked-wallet ERC-20 movements, including transactions initiated by other wallets. Initial positive balances establish Holding; later labels require matching movement evidence. Zero without a known sale, mixed/unexplained changes, RPC failures and snapshots more than five minutes old show Unknown. Exact quantities are available on expansion. Holdings do not alter the rolling 24-hour P&L calculation. Reconciliation uses four concurrent balance RPC calls and prioritizes new movements and watched positions.

`/tokens?view=launches` covers Four.meme classic V1/V2 and Flap tokens already traded by the roster. Membership comes from Helper3/Portal state and official events; address suffixes do not establish launch membership. Progress uses each token's on-chain target; 90% starts Near graduation. Initial discovery of an already-graduated token is silent. Dates come from contract timestamps or indexed events and remain unavailable when history is missing. Flap Infinity uses its separate pool ID, never a vault as a pair. Unsupported node liquidity valuations remain explicitly unavailable; previously stored observations retain their original timestamps. OpenFour and other launch protocols are unavailable in this release.

The migration is in `server/intelligenceSchema.ts`. Collection, signal evidence, movement snapshots, launch observations persist in PostgreSQL. Reorg handling marks signals corrected and removes affected observations. Independent collector loops keep launch RPC retries from delaying Radar. `GET /api/intelligence/health` reports processing lag, stale positions; `/api/overview` includes chain lag.

### Token market charts

Token pages and trade modals request genuine stored OHLC candles through the existing chart endpoint. Minute bars aggregate to 5m, 1h, 4h and daily intervals without splitting coarse bars or inventing empty candles. State quotes update valuation without adding trading volume. Sparse or unavailable coverage and estimated historical market capitalization remain explicit. Browser chart caches preserve original observation timestamps.

Trade exports use the single server replay-preparation endpoint, binding the approved full-history window to the modal's immutable accounting/valuation snapshot. Token exports use the same database market service. The existing canvas styling, 15.5-second duration and MP4 encoder remain unchanged. See [Replay implementation](src/tradeReplayREADME.md).

### Validation

Chart requests begin on deliberate hover, keyboard focus or pointer-down on token links and interval buttons, and alongside token details. Trade cards also warm the lazy modal code. Equivalent 24h/5m and 30d/1h browser caches supply an immediate initial chart (with monthly history clipped for weekly views), and shared subscribers update as soon as a preload completes. The browser retains the last twelve charts with verified, unexpired supply in session storage, so reopening or reloading can display real cached history immediately while fresh data loads. Incoming candles with temporarily missing supply can reuse that token's timestamped supply across intervals, but never extend its two-day validity. Restricted browser storage leaves the memory cache usable.

Production HTML revalidates on each navigation; fingerprinted `/assets/` files have immutable caching. Missing asset paths return an uncached 404 instead of the SPA shell. Compose mounts `bscan_frontendassets` at `FRONTEND_ASSET_CACHE_DIR`; startup retains the current release's fingerprinted assets and removes omitted files older than seven days. Keep this volume across deployments. When first enabling it, seed fingerprinted assets from the currently running app before replacing its container so existing tabs can still open lazy trade details. Later releases retain these files automatically. A popup import failure checks the current HTML entry: if the build changed, it reloads once and restores the selected KOL/token; otherwise a closeable error dialog offers a manual reload. Hover preload failures never reload the page.

Live data hooks share one `/api/stream` connection per tab. Transport errors close the failed connection and retry after 2, 4, 8, 16, 32, then at most 60 seconds. The connection pauses offline and in hidden tabs; existing polling remains the fallback. These changes reduce duplicate connections and retry noise; they do not change the reverse proxy's HTTP/3 configuration.

Run `npm run check`, `npm test`, and `npm run build`. For database-backed validation, create a disposable PostgreSQL database named `bscan_intelligence_test` or `bscan_intelligence_test_<digits>` and set its private `DATABASE_URL`, then run `npm run test:integration`. The runner refuses other database names, mocks RPC, and tests migrations, profile backfills, isolation, movements, stale/failed checks, launch milestones, pool IDs and reorgs. `INTELLIGENCE_PREVIEW_FIXTURES=1` leaves synthetic fixtures for isolated desktop/mobile QA; never use them in production.

With a separate, empty database using the same test-only naming convention, `npm run test:integration:kol-profile` checks the real profile and pagination routes, excluded-asset P&L/replay rejection and preservation of stored trades. Provider HTTP access is disabled during this test.
