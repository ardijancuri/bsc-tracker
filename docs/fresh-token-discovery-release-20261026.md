# v1.4 token discovery and WPC production release

This is an additive upgrade of the existing `kollens_fresh_v14` database. The
original start block 129627586, accounts, sessions, favorites, creator ownership,
Portfolio boundaries, notification settings and retained financial/chart data
must remain intact. Do not run Fresh initialization, the earlier database
cutover or a financial reset. The canceled timed validation stays canceled.

The source includes the already-deployed `3819b11` replay presentation, including
the removal of the large-sell zoom/slow motion. It preserves the GGC disk
snapshots, import CLI, cache mounts and single four-hour scheduler. The old
image-only replay Compose overlay must not override the new app image; its
frontend is included in this source instead.

Discovery distinguishes verified eligibility, verified exclusion and unresolved
creation evidence. Unknown qualifying activity is retained in bounded leased
repair jobs and exposed as pending, with public/private scope protections.
Unsupported complex v4 execution remains explicit rather than being converted
into a transfer. The optional archive proof URL stays server-only and disabled
unless explicitly configured. No public debug RPC or node/tracing configuration
change is part of this release.

## Guarded WPC recovery

`freshWpcRecovery` is a server operator, not a public route. Its default read-only
plan checks the original production database/start, canonical transaction and
receipt membership, actual code/trace/state source provenance, current public
roles, Portfolio membership floors and existing financial overlaps. An apply
requires the exact checksum-bound bundle and current plan digest. All network
verification precedes the financial transaction. Capture/scope locks and a
reorg watermark protect the final commit. New historical facts are silent.

The finite reviewed bundle contains nineteen original WPC contexts across two
public KOLs: sixteen swaps and three attributable approval fees. The creation
proof is the actual successful CREATE2 transaction at block 129752966, not a
pool-as-launch inference. Added historical scalar reads match authentic
target-block response bodies and canonical header bookends; no current price,
default precision or provider P&L is substituted. The actual v4 initialization
authenticates the shared market and all sixteen dated swap MCAP observations.

Expected exact closed-position realized results, including gas:

| Public wallet | WPC trades | Realized USD | Ending quantity |
|---|---:|---:|---:|
| Tempo `0x8168b8af46261bccbaa673c2f86bd78153c47bc6` | 2 buys, 2 sells | 51.48569388966672523256305 | 0 |
| `0xc9e4a15b6795a0cf97206218b52e20d78bc13145` | 11 buys, 1 sell | 2.18603038024480815491469928 | 0 |

The operator preserves original financial identities and every known value,
receipt body/expiry, settings and account scope. It appends verified evidence,
uses the ordinary FIFO persistence once, and seeds the authenticated market.
The normal new worker must refresh current balances/quotes; the earlier local
capture-block balance is not imported as current production proof. An identical
rerun adds no facts or accounting work. Extra captured WPC contexts must be
included or explicitly caught before the handoff, never left silently done.

Local rehearsal used the existing isolated clone with six already-recovered
Tempo facts: thirteen additional facts were added, all known six preserved,
then the rerun produced zero facts/batches and unchanged scope epochs/counters.
The production dataset has no WPC financial facts before this release, so its
expected first apply is nineteen new facts.

## Release checks and evidence

Run the combined unit suite, both TypeScript projects and production build
after the final source freeze. Build and test the actual Linux image, native
image runtime, all eight entrypoints, private IPC mount, inactive preview
sender/scheduler and private routes. Run a production read-only import plan
before the brief capture-owner handoff. Keep all original data and normal live
collection; imported history cannot generate retroactive Telegram/X posts.

After apply, compare original financial/core-receipt/expiry/scope/settings
digests. Require live profile/leaderboard agreement, matched WPC balances,
current node valuation, genuine charts, signed replay validation and an actual
downloaded MP4 matching its frozen modal. Verify one active worker, advancing
canonical capture and the preserved championship scheduler/cache volumes.

Private recovery manifests, source proofs, operator plans and preservation
reports are under `.cache/fresh/private/wpc-release-20261026/` locally and
`/opt/bscan/deploy/wpc-discovery-v14-20261026/` on the VPS. These are finite
release audit artifacts, not new app snapshot/history tables or a permanent
rollback-backup system. Post-deployment results are appended after verification.

The app and worker database sessions disable PostgreSQL JIT compilation through
their explicit pool startup options. These online reads and update batches do not benefit from
seconds of compilation per request. This leaves global database configuration,
query results, account settings and financial evidence unchanged. The ranking
query also omits token-birth checks already dominated by its global opaque-
receipt gate; token-specific reads retain the complete authenticated proof.
