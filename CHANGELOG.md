# Changelog

## v1.4.0 — 2026-10-20

- Restore numbered positions and gold/silver/bronze podium highlights for known partial P&L, retaining partial labels and leaving unknown results unranked.

- Sort partial leaderboard results by their known realized P&L using exact decimal values, with trade activity only breaking ties. Keep complete rankings separate and unknown results below available partial totals.
- Restore genuine saved chart history into PostgreSQL with original source/timestamps, resumable import checkpoints and conservative coverage claims.
- Recover selected public token charts independently of P&L, sharing completed provider pages and preserving cooldowns without blocking node capture.
- Display genuine token-price candles when verified supply is unavailable, including very small token prices. Preserve real gaps and unknown volume.


## v1.3 updates — 2026-10-18

- Start Telegram login in the Kollens bot, with an expiring private return link, explicit account confirmation, source-browser favorite merging and legacy account recovery.
- Fix trade replay preparation during GMGN cooldowns: reuse reconciled accounting and the modal's validated current valuation without waiting for an optional aggregate refresh.
- Join genuine recent one-minute observations to retained replay history, support independent market-history recovery, and keep provider retry delays separate.
- Show accounting, chart coverage, quote and provider-specific preparation errors; preserve frozen modal/video profit and return consistency.
- Add a blank line below the dollar/BNB amount in Telegram buy and sell alerts.
- Restore the KOL watchlist table's complete border and matching rounded top/bottom corners; keep the toolbar separate.
- Remove BscScan buttons and linked timestamps from Telegram trade alerts, retaining plain trade times and Kollens links.
- Offer an optional Telegram alert invitation after sign-in; active accounts skip it, and paused accounts can resume.
- Keep the header Login button visually unchanged while opening Telegram.
- Improve trade alert hierarchy with buy/sell emojis, bold names and values, linked token names and individual transaction times, and labelled links.
- Place followed KOLs and alert settings in two desktop columns, with settings first on mobile; separate Radar filters from Telegram preferences and remove the divider below the KOL toolbar.

## v1.3.0 — 2026-10-17

The v1.3 release series begins with the Telegram alerts update (commit `f6a395b`), originally committed with a v1.2 label.

- Added separately opted-in Telegram alerts for favorite KOLs, with buys/sells filters, pause/resume, individual muting, and English/Chinese messages.
- Deliver confirmed live trades independently of GMGN and P&L loading, with durable delivery, ten-second follow-up summaries, freshness limits, and reorg corrections.
- Added separate messaging consent and authenticated Telegram webhook handling while preserving ordinary login and synced favorites.
- Expanded reward/pair-asset exclusions from KOL token cards, trade lists, per-token P&L, replays and alerts, including `0xce24439f2d9c6a2289f741120fe202248b666666`. Indexed evidence remains stored.
- Moved the token favorite control before the replay button and renamed the button to “Share replay”.

## v1.2 fixes — 2026-10-16

- Recover verified lifetime GMGN totals for positions whose older cycles predate indexed trades, retaining earlier losses, transfer values and fees.
- Recover missing recent account-abstraction sales without an archive node; label independently reconciled tracked profit separately when GMGN omits those sales.
- Reuse matched transaction FX when indexed USD marks are missing, improve accounting failure messages, and refresh provider-history results before their proof expires.
- Keep lifetime profile recovery separate from replay event accounting; validate paginated history and ranking candidates before displaying totals.

## v1.2.0 — 2026-10-15

- Fixed trade replay generation when historical RPC data is unavailable by sharing verified GMGN movements and current balance checks with profile P&L; estimated profit now follows each movement, including transfers and fees.
- Resume partially loaded replay chart history after provider cooldowns without reusing stale live quotes.
- Improved KOL token P&L reliability: open positions show estimated profit, valid same-second transfers are accepted, and verified GMGN history can recover missing historical RPC data.
- Added authenticated smart-account trade indexing and a bounded repair queue for missing swaps, with atomic persistence and reorg checks.
- Improved P&L request scheduling and retries, retained recent verified values during provider cooldowns, and expire displayed values when their original proof or price becomes stale.
- Added optional Telegram login with a visible account name and photo, device sessions, and logout.
- Saved token and KOL favorites now sync across devices. Signing in merges guest favorites without duplicates; logging out preserves saved account favorites.
- Account favorites retain background market-data refresh priority after guest favorites are merged.
- Updated the responsive header with the yellow K logo, white navigation and icons, compact mobile controls, and consistent spacing.
- Matched trade and token replay share controls with dark, borderless buttons and white icons. Search now uses the share modal's dark background and backdrop blur.

Telegram credentials remain server-only. Existing guest watchlists continue working without login. Database migrations are additive.
