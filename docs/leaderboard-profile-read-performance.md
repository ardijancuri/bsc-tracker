# Leaderboard and KOL profile read performance

Implemented and validated locally on October 30, 2026. The subsequent v1.5
release request authorizes deployment with all existing financial records,
accounts and settings preserved. The canceled Fresh validation campaign remains
stopped.

## Read changes

The leaderboard now materializes a narrow set of pending receipt identities and
their canonical header times once per query. A lateral primary-key lookup avoids
rebuilding a hash of the full recent-block table for each wallet. Completed
receipts and raw payloads are absent from this temporary query input.

For relevant token-birth checks, the query validates the selected indexed
certificate using the same canonical birth and parent headers. It does not
substitute the more permissive durable-header path or change evidence approval.
The six initial profile summaries use this same bounded certificate lookup.

Profiles consume a shared public ranking frame, retaining the exact global rank
and all existing financial fields. Recent trades start as soon as that frame is
available, while token summaries may still be loading. The complete response and
its pagination contract are unchanged.

## Bounded result sharing

Each API service owns a cache of raw public ranking rows: at most two entries,
4 MiB in total, with a maximum one-second retention. Simultaneous readers with
the same database-visible state share one load. Each request projects its own
dated response; stored P&L write times are never replaced with the request time.

Every read samples `pg_current_snapshot()` inside its existing repeatable-read,
read-only transaction. A changed visibility snapshot prevents reuse after a
committed repair, reorg, tracking change, metadata edit or accounting update.
This deliberately permits conservative invalidation by unrelated writes.

Separate time bounds expire reuse at rolling contribution boundaries, inclusive
discovery edges, future evidence entering the window, activation timestamps and
the maintenance-health deadline. Elapsed monotonic time accounts for a paused
request or a wait behind another owner. A late result cannot extend a prior
health approval. Failures are returned, never replaced by stale approved rows.
The bounds use indexed next-event lookups per public wallet/scope rather than
scanning permanent financial history.

Portfolio position reads do not enter this public cache. No new database tables,
indexes, financial snapshots, migrations, provider calls or background writers
are introduced.

## Local validation

Artifacts are in `.cache/leaderboard-load-local-20261030/`. Tests use the retained
live-data clone `kollens_replay_gap_20261029` on local PostgreSQL port 5439.

- All 226 leaderboard responses match the legacy query at the same cutoff,
  including ranks, counters, exact/estimated P&L, source and evidence reasons.
- Complete 0xDavid and Afeng profile responses match the legacy handler, including
  six token summaries, trades, global rank, window and cursors.
- Latest local samples: leaderboard about 214 ms on the first request,
  20–24 ms with reuse and 131 ms on a later refill; profiles about 117–289 ms.
  Eight concurrent mixed requests finished in about 519 ms.
- Before optimization, the same local legacy leaderboard took about 16.7 seconds.
  The first optimized SQL sample took 84 ms; its measured execution plan took
  about 37 ms. These local results are not a production latency guarantee.
- TEMP-only SQL fixtures verify missing/orphan headers, window edges, opaque
  repairs, scope isolation, expiry, repairs, metadata changes and reorgs.
- Both indexed and legacy birth predicates pass the same 87 certificate and
  regression checks. Unknown costs and original receipt data remain intact.

Preservation hashes, type checks, unit suites and the production build are
recorded alongside the timing reports. No collector or real messaging transport
is started by these checks.

The full unit suite passed 5,392 tests (two skipped). New query/cache PostgreSQL
fixtures passed 28 checks; the paired birth predicate runners passed 174 checks.
All 37,732 financial records, their position P&L inputs and 40,109 original receipt
bodies retain the earlier verified preservation hashes.
