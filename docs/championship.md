# GMGN championship

`/championship` shows the first 20 official GMGN Global Championship ranks in Daily and Overall tabs. It uses neutral charcoal page surfaces, green profit figures, and gold, silver and bronze podium cards. The header features GMGN's Aston Martin Vantage grand-prize image. Daily dates use UTC, independent of the viewer's timezone. Daily PnL is realized PnL; GMGN's live Overall ranking includes unrealized PnL and its final ranking uses realized PnL only.

The source is the public [GMGN competition](https://gmgn.ai/ggc?ch=webmenu&chain=bsc), season `ggc-s1`. Competition rankings aggregate competition wallets across chains. `shared/championship.ts` records the verified October 17–27 UTC qualifier interval (the last full day is October 26).

## Data and freshness

`server/championship.ts` reads `https://gmgn.ai/pf/api/v1/global_championship/daily_leaderboard?championship_id=ggc-s1&date=YYYYMMDD` or `leaderboard?championship_id=ggc-s1`. The public contracts were verified in the GMGN browser page and API responses on October 20, 2026. Rank and identity come from the provider, without locally recalculating or filtering them to Kollens' roster. ROI is a ratio, converted to a percentage exactly once in the view.

Every page load, tab/date change, manual refresh and return to a visible page requests `refresh=1`, bypassing the server's one-minute polling cooldown even after failures. Background polling retains the cooldown. Upstream requests bypass HTTP caching, have a five-second timeout, and share an in-flight promise per period/date. The legacy route stores normalized snapshots in `worker_state` under `championship:ggc-s1:*`; the Fresh app uses the dedicated snapshot volume described below. There is no database migration or worker accounting change.

The verified reference in `server/data/championship-reference.json` retains provider timestamps and the public trader identities observed on GMGN. It contains only the first 20 ranks of each board. Known names, avatars and GMGN verification markers are a reference capture; a newly ranked trader falls back to their current X handle and an initial. Live financial numbers always come from the official board, never from identity metadata.

Direct server requests currently return HTTP 403 in the local environment, while the public page works in the browser. The reference is therefore a **saved snapshot**, identified by a compact badge and the original update time in the footer. The verbose saved-data message and Overall PnL policy paragraph are removed. When ordinary upstream HTTP requests succeed, the service resumes updates and saves newer snapshots. An old Daily snapshot is only available for its exact UTC date. The UI never labels a failed refresh, a regressed response, or an update older than five minutes as live. Unavailable dates return HTTP 503 with a 60-second retry interval; invalid dates return HTTP 400.

No browser session, anti-bot cookie, trade endpoint or challenge bypass is included. Ordinary server polling still depends on GMGN permitting those requests. The existing GMGN API key is used for documented token/market/wallet APIs; no supported championship OpenAPI endpoint was found in the official client. The website championship endpoints still return HTTP 403 from this VPS. A timer must not be presented as successful data refresh while that source remains blocked.

### Scheduled verified snapshots

The Fresh deployment can opt into `CHAMPIONSHIP_SNAPSHOT_DIR=/app/.cache/championship`, backed by the dedicated `fresh_championship` Docker volume in `compose.fresh.championship.yaml`. This does not add database tables or modify KOL accounting. Files are `overall.json` and `daily.YYYY-MM-DD.json`, limited to this competition's UTC dates. Every explicit refresh or one-minute polling cycle checks for a newer file, so publishing requires no API or worker restart. An imported snapshot remains labelled saved when the ordinary GMGN request fails.

The file store validates ranks, identities, links and timestamps, writes through an exclusive lock and atomic rename, and prevents older provider timestamps from replacing newer ones. The compiled operator `dist-server/championshipImport.js` accepts exactly the current UTC Daily top 20 plus Overall top 20 on stdin. Captures must be less than 30 minutes old; provider data must be less than 15 minutes old while qualifiers are running. The final competition day is clamped to October 26 after qualifiers end.

For each browser capture, create a new directory under `.cache/championship-refresh-*` containing:

- `overall-raw.json` and `daily-YYYY-MM-DD-raw.json`, each wrapping the exact rendered public API JSON as `{ capturedAt, sourceUrl, payload }`.
- `daily-identities.json` and `overall-identities.json`, read from the visible board cards as `{ id, xHandle, name, avatarUrl, verified }`. Match both provider UUID and X handle; do not infer verification badges.

Navigate normally to the official GGC page and to the public leaderboard API URLs; read the rendered JSON text. Do not copy cookies, inspect hidden application state, solve challenges, or use browser fingerprint impersonation. A harmless update notice can be dismissed with its Finish button. If the public source cannot be read, preserve the previous snapshot and report the failed run.

Run `node --import tsx scripts/championship/prepare.mts <capture-directory>` to validate and normalize the packet. Then run `scripts/championship/publish.ps1 -CaptureDirectory <capture-directory>`. The publisher repeats validation, uploads only the public packet through the existing pinned SSH-key uploader, and invokes `/opt/bscan/deploy/ggc-auto-20261025/publish.sh`. That remote operator saves an audit copy, imports through the same file store, checks both API responses and verifies that neither API nor worker restarted. It does not touch the database, node, webhook, sender or other apps. Persistent lock contention must be reported and inspected; never blindly remove an active writer's lock.

### App-owned scheduling

`CHAMPIONSHIP_AUTO_REFRESH_HOURS=4` enables a background job in the API container. It starts one Daily/Overall attempt when Fastify is ready, repeats every four hours, and also checks at UTC midnight so the Daily date rolls over without visitors. Only one cycle can run at a time. Shutdown clears the timer and prevents late work from rearming it. The schedule runs on the VPS independently of Codex, this chat or the local computer. Empty configuration disables it; invalid intervals fail startup instead of silently choosing a cadence.

`GET /api/championship/status` reports the enabled cadence, current run, last attempt/completion, next attempt, last success and each board's provider/capture timestamps. HTTP 403 is reported as blocked; returning a saved board is not counted as a successful refresh. Existing snapshots and their original timestamps remain available. After qualifiers end, the Daily request stays on October 26. The regular app health route does not fail merely because the external competition source is unavailable.

The former recurring Codex task `refresh-ggc-rankings` is paused after the VPS scheduler is verified. The browser capture/publish commands remain an explicit manual recovery method. Successful unattended updates need GMGN to permit the VPS to read the championship endpoints or provide a documented authenticated championship feed. An existing market-data API key alone has not been shown to grant that access. No social posts or Telegram messages are part of either workflow.

The October 25 app-only patch is built from the exact deployed Fresh commit `a6d8afb632c3c8802cbe02ca16b87622b9ecd4f0` plus the championship service/store/importer changes. Its override must be retained when recreating the app. The worker keeps its existing image and runtime. Deployment evidence and rollback commands are stored at `/opt/bscan/deploy/ggc-auto-20261025`; later full Fresh releases should include these source changes and retain the snapshot volume and environment setting.

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
