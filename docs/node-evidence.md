# Durable node evidence and optional private tracing

The collection worker commits canonical block headers, relevant complete
transactions/receipts and range coverage before metadata, pricing or decoding.
`node_collection` is the raw checkpoint; `node` advances after raw execution
decoding. `node_monitored_wallets` records separate decoded coverage. Optional
legacy feed projection has its own lease/retry loop and cannot block either.
Public KOLs and private Portfolio subscriptions share collection without changing
public roster flags. Failed transactions and token transfers before purchases
are retained. Metadata/valuation retries use saved receipts after node pruning.

Raw evidence has no expiry policy. Monitor database growth, raw/decode lag,
collection errors and remaining pruning margin before production activation.
Historical repair does not set `observed_live` and cannot generate live alerts.

## First release and an expired collection cursor

Normal startup resumes only from the durable `node_collection` checkpoint.
Prototype headers and legacy trade checkpoints do not prove permanent receipt
coverage. Existing evidence without that checkpoint stops with
`node_capture_bootstrap_required`; missing blocks/receipts never advance it.

Before an authorized release, preflight the saved cursor against node retention.
If its uncollected interval has been pruned, a separately authorized operator
must run the worker once with `NODE_CAPTURE_BOOTSTRAP=1`, then remove that setting
before starting normal workers. This one-shot command exits after recording a
fresh six-confirmation boundary, a historical-gap audit row and new monitoring
generations. It keeps old raw evidence, invalidates affected accounting and
immutable snapshot versions/balance proofs, revokes affected private replay
leases and leaves Portfolio membership dates/boundaries unchanged. It also
anchors future market collection at the new boundary and marks old market
ranges intersecting the recorded gap incomplete without deleting observations.
It never creates a
completed collection range for the missing interval. Public historical imports
must reconcile a new baseline; affected Portfolio history stays unavailable.

Future collection starts immediately after the new durable boundary. Historical
raw decode is lower priority than the fresh segment. Reorg audits use that
segment; rollback keeps its still-canonical prefix or boundary. A fork crossing
the boundary pauses for another explicit recovery rather than concealing a gap.
The bootstrap implementation is tested only against disposable local databases;
this change does not run it against production or modify VPS configuration.

Catch-up capture uses at most 512 blocks when more than 512 confirmed blocks
behind, returning to 128-block ranges near the head. Full-block loading stays
bounded at 16 requests, independent transfer/operation log filters overlap, and
receipt loading is bounded at eight requests. Every receipt remains mandatory
before any range/checkpoint commit. Validated headers are checked and inserted
in batches under the same rollback lock. `node_collection_metrics` separates
block loading, discovery, receipts, persistence and rollback-lock wait time;
larger batches never change confirmation or freshness requirements.

The same raw transaction enqueues urgent metadata/feed jobs by block hash. An
independent leased stage captures exact-block token precision/supply and trusted
fee-feed evidence before state pruning, without waiting for market discovery.
Transfer tokens are coalesced per block; all chunks of at most twenty tokens
are processed and successful token/feed progress survives partial retries.
Fresh live jobs lead the queue. Unavailable older state remains a dated failure
with backoff, and deleting orphaned headers cascades to pending/leased jobs.
The urgent/selected ordering is bounded by the latest saved canonical block minus
128, independently of wall-clock freshness. Eight independent leases drain work;
bounded same-block RPC batches preserve individual request identity and failures.

Execution-aware trade projection replaces the old transaction/wallet/token
uniqueness constraint with separate partial indexes for legacy and per-operation
rows. Legacy IDs and notification references are preserved. A release must switch
API and worker together: old binaries using an unconditional conflict target are
not compatible with the new partial index. Do not roll back only the image after
repeated-operation rows have been written; use the verified release rollback
procedure and retain a database backup.

`BSC_TRACE_IPC` optionally names an absolute, private local Geth IPC socket. It is
disabled when absent. The worker API permits only `debug_traceTransaction` with
fixed `callTracer`, two-second node timeout and bounded reexecution. Results are
limited to 2 MB, 5,000 calls and 32 levels; world-accessible sockets are rejected.
No public debug HTTP port or general-purpose RPC proxy is introduced.

Mounting the node socket or configuring a tracing broker is a separate deployment
action and must be authorized. Node IPC itself exposes broader methods to its OS
owner: do not share it with web processes or untrusted containers. Keep the API
container without the mount; permit only the collection worker OS identity.
If tracing is unavailable, receipt evidence is still collected and unsupported
native payouts remain an explicit valuation/decoder limitation.

## VPS release configuration

`compose.vps.yaml` grants the trusted worker alone a read-only bind mount of
the existing `/var/lib/bsc/geth.ipc` socket. Use it together with `compose.yaml`
on the VPS; ordinary local startup does not require that host path. The socket
must already exist with private permissions. This does not enable public debug
RPC or change the BSC service configuration. Recreate the worker if a node
restart replaces the mounted socket inode, and check tracing progress afterward.

For the first authorized cutover, build the immutable release before stopping
the old API and worker. Save a verified database/configuration/image backup,
stop both old processes, run the new worker once with
`NODE_CAPTURE_BOOTSTRAP=1`, and then start the new API before the normal worker.
The one-shot flag must not be persisted in the normal environment. Check the
recorded boundary and gap, consecutive collection ranges, receipts, decoding,
urgent valuation evidence and tracing after startup. Historical imports resume
independently and old positions may remain explicitly incomplete while they run.

An old-image-only rollback is unsafe after the execution-identity migration.
Keep the old images and database archive together. If rollback is necessary,
stop the new processes first and restore the saved database to a separate
database/volume, verify it, then switch the old application to that restored
copy. Preserve the new database and any post-backup activity for recovery; do
not overwrite it automatically from a deployment error handler.
