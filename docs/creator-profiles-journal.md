# Creator profiles and private journal

These features use the existing Telegram account/session, PostgreSQL database,
BSC RPC and GMGN credentials. They introduce no new provider keys or archive
subscription. No production activation is part of local implementation.

## Creator ownership

Only seeded, tracked KOL wallets can claim `/kol/:address`. A Telegram account
requests a ten-minute, single-use ERC-4361 message bound to the configured
`PUBLIC_APP_URL` origin, browser session, wallet, action and BSC chain 56. The
server checks EOAs with ERC-191 and deployed ERC-1271 wallets against its own
confirmed BSC node checkpoint. Undeployed smart wallets and WalletConnect are
unsupported. No transaction or token allowance is requested.

Claims, challenges and customization live in separate `creator_*` tables.
`published_kols` overlays names, avatars and links on the seeded roster without
changing membership or automatic trading statistics. The view never exposes
the managing account. An owner can release a claim with fresh wallet proof;
another account cannot overwrite it. Browser EIP-6963 discovery also supports
injected mobile wallet browsers.

Names are limited to 60 characters and bios to 400. Links require HTTPS; social
links additionally require their respective X/Twitter or Telegram host. Image
uploads accept static JPEG, PNG or WebP up to 2 MiB, reject animation, strip
metadata and normalize to 512×512 WebP. Wallet-control badges are not social or
performance endorsements.

Routes: `GET /api/creator/profiles`, `GET/PATCH /api/kols/:wallet/creator`,
`POST .../creator/challenge`, `POST .../creator/claim`,
`POST .../creator/avatar`, `GET .../creator/avatar` and
`POST .../creator/release`. Mutations require the exact configured Origin and
an active account session. The client includes `X-Watchlist-Owner` to reject
account changes during a form or wallet prompt.

## Private subscriptions and collection

Each account can subscribe to three BNB wallet addresses without proving
ownership. Labels are private membership data. Removing a membership revokes
all private routes and its saved replay leases, even if another subscriber
still needs the same public blockchain evidence.

The worker collects the union of public KOLs and active journal subscriptions.
It keeps `kols.is_tracked` reserved for the public roster. Registration records
the committed node checkpoint and a repair cursor; a wallet added while a scan
is running is repaired independently. Missing or mismatched transaction
receipts fail the range. Journal evidence, coverage, opening balances and
snapshots participate in reorg rollback. Private-only activity is excluded
from public feeds, counts, rankings, searches, signals, KOL alerts and roster
positions. Public signal APIs also withhold stale mixed/private signal rows.

The first activity window is seven days. **Load older history** extends it in
seven-day increments. Eligible positions may need earlier purchase history,
so the activity window is never described as a performance period. Existing
quote/reward/dividend/LP exclusions apply before position preparation.

GMGN history recovery stores resumable completed pages independently of
canonical indexed trades, without fabricated block numbers. Requests keep the
existing accounting/market credential queues, budgets and shared upstream
coalescing. Complete node evidence can prepare a new position without GMGN;
missing old costs require recovery or remain explicitly unknown.

## Accounting and replays

`journalLedger.ts` evaluates a selected wallet set as one exact-decimal FIFO
ledger. Matched internal transfers move the original lots and acquisition
cost; they add no income, profit or investment. Fees are attributed once to
their wallet/execution. External transfers retain the existing receipt/marked
valuation policy. Total profit includes sales, marked external transfer-outs,
remaining value, purchase/receipt costs and known wallet-paid fees. ROI uses
fee-inclusive acquisition capital and excludes internal transfers. It does
not sum wallet-level provider percentages. Missing costs, fees, balance
reconciliation or uncertain execution ordering remain visible limitations.

Ready positions can appear while other positions prepare. Complete combined
totals are published only when the selected inputs reconcile. During temporary
delays, a dated valid snapshot may be returned. Its identity includes the
account membership revisions, selected wallet set and valuation time.

Journal trade details reuse the market chart, canvas and MP4 encoder. A
server-side, account-bound replay snapshot freezes accounting and ending
valuation for both the modal and video. Its private lease is checked around
preparation and export; private labels never enter replay identity. The public
KOL identity is used when available, otherwise a neutral wallet identity.
Historical frame estimates and an approved final use distinct policies;
aggregate fees are never spread backward into prior frames.

Private routes require account membership before and after asynchronous work,
send `private, no-store` and do not log private payloads. Routes:

- `GET/POST /api/journal/wallets`
- `PATCH/DELETE /api/journal/wallets/:wallet`
- `POST /api/journal/wallets/:wallet/older`
- `GET /api/journal/summary?wallet=all|address`
- `GET /api/journal/positions?wallet=all|address`
- `GET /api/journal/activity?wallet=all|address&cursor=...`
- `GET /api/journal/wallets/:wallet/tokens/:token/activity`
- `GET /api/journal/wallets/:wallet/tokens/:token/replay-chart`

Replay requests can supply the returned `snapshot` ID. A removed/re-added
membership cannot reuse an earlier lease. There are no public journal pages,
notes, manual trades, calendars or advanced performance analytics.

## Local validation

Run `npm run check`, `npm test -- --maxWorkers=2`, and `npm run build`.
Database integration scripts refuse non-local or non-disposable database names:
`server/creatorProfiles.integration.ts`, `server/creatorPublic.integration.ts`
and `server/journal.integration.ts`. Never point them at the app database.
`src/journalReplay.fixture.ts` is synthetic and can be used to inspect a real
local MP4 without provider or account secrets. Its ending profit is $186.50
with acquisition capital $101 and total fees $3.50.

Deployment must start both updated API and worker with the normal schema
initialization. Commit, deployment, production activation and real wallet
claim testing require a separate release or explicit test action.
