# Changelog

## v1.2.0 — 2026-10-15

- Added optional Telegram login with a visible account name and photo, device sessions, and logout.
- Saved token and KOL favorites now sync across devices. Signing in merges guest favorites without duplicates; logging out preserves saved account favorites.
- Account favorites retain background market-data refresh priority after guest favorites are merged.
- Updated the responsive header with the yellow K logo, white navigation and icons, compact mobile controls, and consistent spacing.
- Matched trade and token replay share controls with dark, borderless buttons and white icons. Search now uses the share modal's dark background and backdrop blur.

Telegram credentials remain server-only. Existing guest watchlists continue working without login. Database migrations are additive.
