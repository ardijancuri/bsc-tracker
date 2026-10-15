# Changelog

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
