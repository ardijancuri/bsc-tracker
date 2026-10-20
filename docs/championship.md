# GMGN championship

`/championship` shows the first 20 official GMGN Global Championship ranks in Daily and Overall tabs. It uses neutral charcoal page surfaces, green profit figures, and gold, silver and bronze podium cards. The header features GMGN's Aston Martin Vantage grand-prize image. Daily dates use UTC, independent of the viewer's timezone. Daily PnL is realized PnL; GMGN's live Overall ranking includes unrealized PnL and its final ranking uses realized PnL only.

The source is the public [GMGN competition](https://gmgn.ai/ggc?ch=webmenu&chain=bsc), season `ggc-s1`. Competition rankings aggregate competition wallets across chains. `shared/championship.ts` records the verified October 17–27 UTC qualifier interval (the last full day is October 26).

## Data and freshness

`server/championship.ts` reads `https://gmgn.ai/pf/api/v1/global_championship/daily_leaderboard?championship_id=ggc-s1&date=YYYYMMDD` or `leaderboard?championship_id=ggc-s1`. The public contracts were verified in the GMGN browser page and API responses on October 20, 2026. Rank and identity come from the provider, without locally recalculating or filtering them to Kollens' roster. ROI is a ratio, converted to a percentage exactly once in the view.

Every page load, tab/date change, manual refresh and return to a visible page requests `refresh=1`, bypassing the server's one-minute polling cooldown even after failures. Background polling retains the cooldown. Upstream requests bypass HTTP caching, have a five-second timeout, and share an in-flight promise per period/date. The existing `worker_state` table stores normalized snapshots under `championship:ggc-s1:*`. There is no database migration, worker accounting change, or credential requirement.

The verified reference in `server/data/championship-reference.json` retains provider timestamps and the public trader identities observed on GMGN. It contains only the first 20 ranks of each board. Known names, avatars and GMGN verification markers are a reference capture; a newly ranked trader falls back to their current X handle and an initial. Live financial numbers always come from the official board, never from identity metadata.

Direct server requests currently return HTTP 403 in the local environment, while the public page works in the browser. The reference is therefore a **saved snapshot**, identified by a compact badge and the original update time in the footer. The verbose saved-data message and Overall PnL policy paragraph are removed. When ordinary upstream HTTP requests succeed, the service resumes updates and saves newer snapshots. An old Daily snapshot is only available for its exact UTC date. The UI never labels a failed refresh, a regressed response, or an update older than five minutes as live. Unavailable dates return HTTP 503 with a 60-second retry interval; invalid dates return HTTP 400.

No browser session, anti-bot cookie, API key, trade endpoint or challenge bypass is included. Restoring unattended live updates requires GMGN to permit the deployment server's ordinary requests or provide an approved championship feed.

## Artwork

`public/championship/ggc-logo.svg`, `edge-{gold,silver,bronze}.svg` and `mascot-{gold,silver,bronze}.png` are the native public artwork from GMGN's `/static/ggc/` directory, exported from the supplied reference page. `aston-martin-vantage.webp` is the original 1536 × 1024 transparent GMGN `/static/ggc/vantage-raw.webp`, saved from the reference page without image modification. Rank-card gradients and layout are CSS. Kollens' shared header, existing leaderboard and other pages retain their styling.

The full-width hero uses `public/championship/stadium-arena-v2.webp`, an edited version of the user's stadium reference. It shows the arena seating, overhead lights and reflective floor, with the reference vehicle removed so the actual Aston Martin prize can remain a separate image. Equal side columns center the prize on the stadium's centerline, with a contact shadow beneath the tires. CSS uses a full-cover crop and a separate dark overlay, with stronger shading behind the copy. The original ceiling-only `stadium.webp` remains available as an unused source asset.

The qualifier countdown shows each number in its own charcoal tile, with visible borders and gaps between Days, Hours and Minutes. The tiles shrink at tablet and mobile widths; on mobile the countdown label sits above the tiles so the numbers remain readable without crowding the date.

### Stadium background generation

Created with the built-in ImageGen tool, using the user's attached `codex-clipboard-3beaa8ab-f583-45bc-b800-f574d41d488d.webp` as the edit target. The selected PNG was encoded as WebP at quality 88 for the page; the generated original remains in the local generated-images directory.

Saved asset: `public/championship/stadium-arena-v2.webp`.

Final prompt:

> Use case: precise-object-edit. Asset type: full-width championship website hero background. Edit the supplied stadium image: remove ONLY the green sports car and its vehicle-shaped reflection, seamlessly reconstructing the empty reflective circular platform and floor where it stood. Preserve the same wide cinematic framing, enormous indoor stadium, visible spectator tiers on both sides, suspended circular ceiling lights, central overhead spotlight, illuminated circular floor rings, perspective and photographic detail. Keep the complete arena seating and floor in frame, not just the roof. Keep lighting neutral charcoal with soft warm-white/gold lamps; reduce the green light spill on the empty floor while preserving the original dark atmospheric scene. The website will overlay its existing green Aston Martin separately, so the output must contain absolutely no vehicle, vehicle-shaped silhouette, or vehicle reflection. No added text, logos, labels, borders, UI, or watermarks. Preserve a landscape panoramic composition close to the supplied image, with clearly recognizable curved arena seating.

## Verification

Run `npm run check`, `npx vitest run server/championship.test.ts server/championshipApi.test.ts src/i18n.test.ts`, and `npm run build`. Browser checks cover tab switching, URL/back navigation, date selection, saved-data labeling, source links, and responsive card layouts.
