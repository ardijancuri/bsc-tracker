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

A foreground chart request reads the database immediately and queues bounded missing historical windows in `node_import_chart_jobs`. Recovery is limited to times before the durable node-capture boundary. Future data continues to come from node capture. Dormant tokens with no saved bars use their latest public trade time to select a historical window; trades never substitute for market candles.

The worker's independent chart loop leases one fixed segment at a time, rechecks public eligibility, and uses the existing market-key queue. It does not wait for wallet activity, P&L reconciliation or a baseline. Completed provider pages are shared with the historical wallet importer. Repeated visits preserve progress and cooldowns; selections expire after two minutes without refresh. Live capture lag takes priority over import work.

Charts remain visible during recovery. The client polls independently of accounting and shows recovery/cooldown status. Without verified supply it displays genuine USD prices, labeled **Price**, rather than guessing market cap. Missing history stays explicit; no synthetic candles or flat extensions are generated.

## Validation

- `npm run check`, `npm test`, `npm run build`.
- `npm run test:integration:node-owned` uses disposable local PostgreSQL databases and includes chart migration/recovery cases. It validates isolation, idempotency, original timestamps, overlapping resolutions, independent recovery while accounting fails, worker leases, page sharing, cooldowns and expired selections.
- Check older token pages at several intervals in a real browser. Candles must remain visible when accounting is unavailable or verified supply is missing.

Local validation on the cloned database restored 112,947 genuine candles from 4,264 saved files/chunks. The live database and source backup were not modified.
