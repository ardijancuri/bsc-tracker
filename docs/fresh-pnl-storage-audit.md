# Stored P&L, position readiness and storage audit

Local audit: October 24, 2026, Europe/Skopje. This work does not reopen the canceled eight-hour validation or authorize a production release.

## Financial read path

`fresh.kols` already contains `today_realized_q`, `today_capital_q`, trade/token counters and a UTC date. The decoder commits compact financial events, FIFO lot/position changes and the affected KOL counters together. These exact rational amounts are formatted for REST responses; ordinary profile and leaderboard reads do not recalculate FIFO or call financial providers. UTC midnight changes daily counters while preserving original holdings and purchase lots. This is a calendar day, not a rolling 24-hour return.

The ranking bug was an explicit fallback to `today_known_realized_q` for incomplete totals. That subtotal remains diagnostic data and is no longer ranked or painted as complete realized profit. Complete losses rank above unknown totals. The profile and leaderboard consume the same stored figure. A nullable `metrics_updated_at` records actual accounting writes; it is not refreshed by a page request or fabricated for old rows.

Each position already has its own stored realized result. A wallet-wide unresolved-receipt gate was unnecessarily blocking unrelated positions. The replacement can narrow a receipt's dependencies only from its checksum-verified complete call trace, bound to the original transaction and receipt. Every entered contract, delegate call, reverted call and original log emitter is retained. An absent or invalid trace remains opaque and blocks conservatively. The compact dependency index lives beside the same temporary receipt; it is not another permanent financial history.

Known realized P&L does not require a current market quote. An open position's estimated ending value and replay do. Unknown original costs or fees, relevant incomplete execution evidence, durable coverage gaps and contradictory balances still prevent approval. The app now distinguishes those reasons instead of labeling them all as a generic pending calculation.

## Measured storage

The audited Fresh database is `kollens_fresh_20261022_24h`, not an old ledger-migration database. At 23:44 UTC on October 23 it allocated 307,254,975 bytes (293 MiB), with 35 tables, 6,877 financial events, 2,747 positions, 2,287 open lots and 460 tracked tokens.

| Category | Measured bytes |
|---|---:|
| Permanent financial data | 22,863,872 |
| Temporary evidence and headers | 167,215,104 |
| Current identities and feature data | 36,290,560 |
| Indexes | 69,361,664 |
| Chart disk cache, separate | 236,150 |
| Shared local PostgreSQL WAL, separate | 167,772,160 |
| Logs, separate | 2,693,239 |

Forty real requests (twenty leaderboard and twenty profile) changed no financial/current row digests, revisions or write counters. Measured p95 was 30.95 ms and 25.41 ms respectively. The large cumulative PostgreSQL update counters also include rolled-back integration fixtures; they do not measure equivalent committed application growth. Unchanged repair retries already skip applied financial events. Genuine corrections and late insertions rebuild affected books to preserve FIFO order.

Controlled-time PostgreSQL checks verified the existing 72-hour receipt/header expiration, bounded deletion, preservation of permanent financial facts and explicit coverage warnings for expired incomplete evidence. The chart cache has a 256 MiB limit, seven-day historical-page expiry and fifteen-second recent-tail refresh. No application history was deleted during this audit. The measured capture period was shorter than 72 hours, so the live dataset had not yet reached retention equilibrium.

The `.cache/fresh` directory additionally includes about 1.04 GB of retained exports/repair artifacts and 93.9 MB of old validation reports. Its PostgreSQL subdirectory overlaps database and WAL figures. Adding these directories together would double-count storage. Old databases and migration copies remain preserved separately at the user's request. These measurements do not establish a 50 GB/week growth rate.

Evidence: `.cache/fresh/private/current-app-storage-audit-20261024/{storage,page-read-proof,retention-proof}.json`.

After the additive fixes, normal collection resumed and measured PostgreSQL allocation was 309,696,191 bytes (about 295 MiB), still 35 tables. `storage-final.json` records that later measurement. No old database, export or financial history was deleted.

## What the comparison platforms document

- [GMGN's official token-page guide](https://docs.gmgn.ai/index/token-page-chart-multicharts-activity-trading-system) separates realized proceeds from unrealized holdings. Its [official CLI documentation](https://github.com/GMGNAI/gmgn-skills/blob/main/docs/cli-usage.md) exposes batch wallet-profit summaries with period and all-time fields. This confirms the public data contract, not its private database layout, retention or query implementation.
- [Pump.fun's official swap documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/PUMP_SWAP_TRADE_V2.md) defines protocol-specific Buy/Sell events with explicit fees and reserve semantics. Its [reserve adjustment documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/VIRTUAL_QUOTE_RESERVES_FEE_ADJUSTMENT.md) tells indexers how to distinguish retained fees from actual liquidity. A documented native protocol supplies execution details directly; arbitrary third-party BSC wrappers can require additional execution evidence.
- [Fomo's official leaderboard explanation](https://fomo.family/answers/how-to-find-profitable-crypto-traders) describes verified on-chain performance and multiple time windows. Its [terms](https://fomo.family/terms) explain that quoted Fomo fees and third-party execution/network fees are separate. Neither source publishes its P&L database schema or storage footprint.

For Kollens, the appropriate implementation is the one already chosen: capture relevant executions once, maintain compact events/lots and current totals incrementally, serve current rows, and fetch charts on demand. The bugs addressed here concern ranking completeness and overly broad position dependencies. Another wholesale database redesign is not required to fix those bugs. Missing historical execution facts must remain explicit rather than being replaced with invented amounts.
