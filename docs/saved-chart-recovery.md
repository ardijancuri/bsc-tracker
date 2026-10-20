# Saved chart history and selected-token recovery

Token charts read PostgreSQL market observations independently of wallet accounting. A missing P&L baseline must not prevent a public token's historical chart from loading.

## One-time saved-cache import

Use an extracted copy of the previous `chart-cache` volume. The importer reads flat token chart JSON and GMGN `full-history` manifests/chunks. It never modifies or deletes the source files. Run against the intended **local** database first:

```powershell
npm run import:charts -- --directory=C:/path/to/extracted/chart-cache
npm run import:charts -- --directory=C:/path/to/extracted/chart-cache --apply
```

Dry run is the default. `--apply` writes to the configured `DATABASE_URL`. The production build also includes `dist-server/importSavedTokenCharts.js` for a separately authorized release. No automatic production import or deployment is performed by this change.

Only known, eligible public tokens are imported. Accounting and private-wallet caches are ignored. Original observation times and source provenance are retained. Forming bars are excluded using the original saved time, and unknown volume remains unknown. Legacy completeness flags and cached token supply are not trusted: restored bars provide usable history but do not prove exhaustive replay coverage or a fresh valuation.

Each successfully imported file/chunk has a content checkpoint. An interruption can be retried safely; completed imports are skipped. Raw pages are persisted before derived observations, and the checkpoint is saved afterward. Invalid files are reported separately; database failures stop the import for a resumable retry.

## Selected-token recovery

A foreground chart request reads the database immediately and queues bounded missing historical windows in `node_import_chart_jobs`, including gaps inside its loaded history and an explicitly selected older page. Ordinary background pagination remains a database-only read. Registered-market bootstrap imports stop at the later of the durable capture boundary and the first authenticated market checkpoint, clamped to the committed node head. The latter handles markets discovered after collection began: old logs can remain available after the precision and valuation state needed to decode them has been pruned. Future data continues to come from node capture. Dormant tokens with no saved bars use their latest public trade time to select a historical window; trades never substitute for market candles.

Newer uncovered ranges and pending captured logs receive bounded, coalesced node history jobs. Collected logs and decoded candles are separate stages; a complete log range must not hide pending decoding. Covered intervals without swaps trigger no synthetic bars or extra historical requests. Empty new-token charts can also promote their node repair work.

If a public token has no registered market, the wallet-monitoring start does not establish market capture for that token. Its older uncovered market history can be imported through the confirmed head, restricted to completed candles at least five minutes old. Recent activity remains on the node discovery path. Registered unsupported or repair markets retain their existing recovery policy; this unregistered-market rule does not reclassify them.

Historical gaps after bootstrap can also recover through the market key when the node has explicitly reported a pruned range, or when canonical pending raw evidence has an attempted historical precision/feed failure with required exact-block proofs absent. The latter requires the block to be beyond the 128-block state window and at least five minutes old. Mere age, a temporary metadata error, an unattempted job or an unsupported decoder does not authorize this fallback. Provider recovery preserves the raw node evidence; complete node ranges and imported proofs for the affected price buckets can then form one truthful mixed chart without importing already complete node history.

Source intervals are resolved before coarse OHLC aggregation. A recovered minute contributes alongside genuine native minutes elsewhere in its hour; a five-minute candle replaces only overlapping intervals. Coarse candles are never split into fabricated minutes, and their volumes are never counted again with constituent minute candles. PostgreSQL returns a bounded number of aggregate rows and computes its shared node-coverage proof once per query.

Native chart candles select their market using its trailing 24-hour trading activity as of each candle, clamped to the approved ending. A market's present-day status or later migration cannot rewrite earlier selection. A dated graduation recorded by the authenticated launch collector and matching a permanent canonical block ends that known FourMeme/Flap controller's eligibility from the first complete minute after the event, allowing genuine destination candles before their activity overtakes the former launchpad. The handoff minute retains its genuine launchpad candle without splitting its OHLC. Missing or orphaned graduation proofs retain the activity policy. Isolated swaps in another pool remain stored but do not replace the historically active market; if that market has no candle, the minute remains absent unless genuine imported history supplies it. Single-market price moves are retained regardless of their size or trading amount. No price threshold, invented candle or deletion of raw evidence is involved.

The worker's independent chart loop leases one fixed segment at a time, rechecks public eligibility, and uses the existing market-key queue. It does not wait for wallet activity, P&L reconciliation or a baseline. Completed provider pages are shared with the historical wallet importer. Repeated visits preserve progress and cooldowns; selections expire after two minutes without refresh. Live capture lag takes priority over import work.

Charts remain visible during recovery. The client polls independently of accounting and shows recovery/cooldown status. Without verified supply it displays genuine USD prices, labeled **Price**, rather than guessing market cap. Missing history stays explicit; no synthetic candles or flat extensions are generated.

Coverage is resolution-specific. Coarse imports cannot certify a missing minute series. The shared page loader qualifies import identities with their interval, including completed empty pages, while retaining the same raw-page cache. Legacy mixed-resolution identities remain conservative until recovery supplies an explicit proof. An initial token view avoids pulling a disconnected older segment across a major observation gap merely to fill the screen; earlier bars remain available by panning. The footer exposes major observation gaps and their original UTC windows.

Frozen replay windows use the same recovery service independently of accounting imports. A window ending partway through an already completed minute retrieves the genuine overlapping candle, while its approved accounting/window timestamps stay unchanged. Retrieval cannot extend into an unfinished or unconfirmed bucket. Completed empty provider pages persist their original coverage as an exhausted retrieval; they never become invented prices or an endless repeated request.

Closed trades also accept genuine market observations bracketing the final transaction within 180 seconds, bounded by the current clock. The approved financial window still ends at the final movement: the browser interpolates the historical estimate between those observations and trims the exported ending to that movement. A prior price alone, a missing price bracket or an excessive observation gap does not qualify. The modal and video continue to use the same frozen accounting final, and historical frames disclose their estimate status. Public recovery never publishes private Portfolio evidence.

Replay polling honors the persisted provider cooldown and the existing three-minute total budget. Confirmed exhausted market history produces an explicit unavailable state rather than offering the same automatic retry forever; an unfinished candle remains a pending state.

## Validation

- `npm run check`, `npm test`, `npm run build`.
- `npm run test:integration:node-owned` uses disposable local PostgreSQL databases and includes chart migration/recovery cases. It validates isolation, idempotency, original timestamps, overlapping resolutions, independent recovery while accounting fails, worker leases, page sharing, cooldowns and expired selections.
- Check older token pages at several intervals in a real browser. Candles must remain visible when accounting is unavailable or verified supply is missing.

Local validation on the cloned database restored 112,947 genuine candles from 4,264 saved files/chunks. The live database and source backup were not modified.

The 2026-10-20 SAFU regression subsequently recovered 62 genuine minute candles by decoding saved node evidence and filled the missing historical windows through the existing importer. The former October 19 03:08–16:21 break and the remaining 13:42–15:25 break were checked against genuine observations. The latter repair followed read-only node checks proving historical precision, reserve and feed state unavailable (`-32000: not supported`). This was a local historical repair, not a new live quote fallback. Original OHLC, volume and provenance remain intact; legitimate sparse intervals remain visible.

The later local LOL-token regression (`0x25e3fe8c2bea75768591f63d26c7530690057777`, October 19 12:23–16:56 UTC) recovered the remaining failed historical projection from 47 to 112 genuine minute candles and changed coverage from incomplete to complete. One market-key import completed in about 0.4 seconds. The final interval merge retains two additional independently captured native minutes, yielding 114 mixed-source candles; a warm reread uses zero provider requests. A separate SAFU October 12 five-minute window recovered 97 genuine bars from an empty local window. These are observations from the cloned database, not fixed production latency guarantees. No production data was changed.

The GM (`0x13920fe6467e9e3c852b8d365a036c995f0f7777`) local regression recovered both major minute-chart holes. The October 16–18 window grew from two to 1,524 genuine candles; the October 19 02:27–09:49 UTC window grew from 21 to 140 candles after fixing the unregistered-market boundary. Both have complete retrieval coverage, and warm recovery makes no provider requests. The public local chart has no remaining hour-long observation gap. Shorter inactive intervals remain sparse exactly as GMGN returned them.

The Rell/`0x483c9746b455e296622945758437f8c7593b7777` regression contains thirteen genuine movements ending October 20 at 12:19:40 UTC. A canonical final receipt was captured while its market projection remained pending. The database integration uses independently captured nearby market observations to prepare a replay without provider requests or wallet-import jobs. Its actual locally encoded 1080×1350, 15.5-second MP4 ends at the same frozen -$121.35 / -14.32% as the supplied position. The curated fixture intentionally retains pending raw logs and rejects a replay when the genuine later price bracket is removed.
