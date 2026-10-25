# Fresh v1.4 deployment configuration

This configuration was deployed following the October 25 release request. See
[the completed production release](fresh-v14-release-20261025.md) for exact
versions and results. The legacy database and volumes remain intact; the legacy
API and sender are stopped. The BSC-node configuration is unchanged.

## Isolation and startup

`compose.fresh.vps.yaml` is a standalone Compose document using JSON syntax
(valid YAML), so its safety properties can also be tested without a YAML parser
or production credentials. Do not combine it with the old `compose.yaml`.

| Resource | Fresh candidate | Existing live installation |
| --- | --- | --- |
| Compose project | `kollens-fresh-v14` | unchanged |
| PostgreSQL database/role | `kollens_fresh_v14` / `kollens_fresh` | `bscan` remains intact |
| PostgreSQL loopback port | `5437` | `5434` remains intact |
| PostgreSQL data volume | `kollens-fresh-v14_fresh_pgdata` | never reused or removed |
| API | Preview `127.0.0.1:3303`; activated Fresh now uses `3300` | legacy API stopped; shared proxy unchanged |
| GMGN chart cache | new volume at `/app/.cache/fresh/charts` | old chart cache untouched |

An unqualified `up` can start only the new database. API and worker require the
explicit `runtime` profile; the cutover CLI requires `operators`. The worker
waits for API health as well as database health, so initial schema setup does not
race live capture. The API supports `HOST` and is loopback-only in this config.

Do not start API/capture before the guarded cutover initialization is complete.
The operator is built as `dist-server/freshCutover.js` and ships in the image;
its private export/manifest directory is mounted at `/app/.cutover` only for the
operator. The host directory must already exist with restricted permissions:
Compose refuses to silently create it. It is excluded from Git and image builds.

## Server-only configuration

Prepare a private release env file outside the repository. Required values are
`FRESH_RELEASE_ID`, a new `FRESH_DB_PASSWORD`, and a stable `FRESH_REPLAY_SECRET`
containing at least 32 random characters. Use a long hex or other URL-safe
database password because Compose also places it in a PostgreSQL URI. Never
reuse the old database password. `FRESH_RELEASE_ID` must identify the exact
reviewed candidate; do not reuse a mutable tag for another build.

The API receives `GMGN_CHART_API_KEY` and `GMGN_ACCOUNTING_API_KEY`, with the
existing generic fallback. Those credentials stay server-only. The worker does
not request GMGN accounting or chart data. Chart pages persist in the API's
correctly mounted 256 MiB bounded cache. The replay signing secret survives API
recreation, while prepared financial objects remain bounded in process memory.

The operator uses `FRESH_CUTOVER_SOURCE_DATABASE_URL` only for its guarded
read-only source transaction. Its destination URL is fixed to the new database
on port 5437. See [the production cutover runbook](fresh-production-cutover.md)
for the manifest, checksums, tracking boundary and preservation gates;
configuration alone does not authorize apply.

Use `docker compose --env-file <private-file> -f compose.fresh.vps.yaml config
--quiet` to validate a future release configuration. Do not print rendered
configuration or commit env files: rendered configuration contains credentials.
Local configuration tests do not install Docker or alter server services.

## Existing private node access

The worker reads the existing HTTP/WebSocket endpoints on the host loopback and
mounts the existing IPC socket read-only at `/run/bsc/geth.ipc`. The API has no IPC
mount. `create_host_path:false` refuses a missing socket instead of creating a
directory. The code checks socket type and permissions without changing them.
No debug HTTP RPC, node flag, socket ownership or webhook change is introduced.

A bind-mounted socket retains its inode if the node replaces the host socket.
Before accepting the candidate, compare the mounted socket with the host socket
and verify a private connection from the new worker. Recreate only the approved
worker container if a later node restart leaves its mount stale; do not broaden
the mount to the entire node directory. A healthy HTTP endpoint does not prove
that an older container's IPC mount still works.

Production uses separate bounded private IPC loaders for normal decoding and
urgent receipt capture, just as local operation uses separate SSH queues. The
transport allows only receipt lookup and a fixed bounded `callTracer` request,
checks canonical transaction/receipt positions before and after, and validates
the returned call tree. Trace failure stays an explicit repair condition.

Capture uses at most 32 blocks per atomic page when the confirmed head is more
than 32 blocks ahead. It returns to 16-block pages near the head so newly captured
receipts remain available to the bounded urgent trace stage. This selection
reuses the same confirmed head read and retains all receipt and coverage gates.

## Preserve open-tab frontend assets

The active implementation is `server/frontendRoutes.ts`. It retains hashed
files under `dist/assets`, serves the retained cache at `/assets/`, and prunes
cache files older than seven days. The new cache volume starts empty. Both the
old running image's `dist/assets` and its retained cache must therefore be
seeded, together with the candidate image's current assets, **before the
candidate API starts and before public traffic switches**.

`scripts/fresh/seed-frontend-assets.mjs` is a standalone Node operator with no
database or network access. Its default is a read-only plan. Apply requires the
printed plan SHA-256 and exact target confirmation. It copies only the same
fingerprinted filenames the API serves; relative paths are retained. Source
and target roots must be existing absolute, separate directories. Symlinks,
target hardlinks, overlapping paths, changed plans and same-path content
conflicts are refused. Files are checksummed before copying, fsynced and
read-back checked before exclusive publication, then verified in the target.
Existing verified target files keep their contents/inodes; only destination
retention timestamps refresh. It never deletes or overwrites source assets.

These are **future, separately approved release commands**, run from the
reviewed checkout on the VPS. They create only a new private export directory
and the new candidate volume. Keep the old app running while extracting its
immutable files; do not clear either old cache or old image. Choose a fresh
export path and the exact reviewed candidate image tag:

```sh
export FRESH_RELEASE_ID='<exact-reviewed-image-tag>'
export LEGACY_ASSET_EXPORT='/opt/bscan/.cutover/frontend-assets-<unique-release-id>'
export SEED_SCRIPT="$(pwd)/scripts/fresh/seed-frontend-assets.mjs"
test -f "$SEED_SCRIPT"
docker volume inspect bscan_bscan_frontendassets --format '{{.Name}}'
mkdir -m 700 "$LEGACY_ASSET_EXPORT"
docker cp bscan-app-1:/app/dist/assets "$LEGACY_ASSET_EXPORT/assets"
test -d "$LEGACY_ASSET_EXPORT/assets"
docker volume create kollens-fresh-v14_fresh_frontendassets

docker run --rm --network none --read-only \
  --mount "type=bind,src=$SEED_SCRIPT,dst=/seed-frontend-assets.mjs,readonly" \
  --mount type=volume,src=bscan_bscan_frontendassets,dst=/legacy-cache,readonly \
  --mount "type=bind,src=$LEGACY_ASSET_EXPORT/assets,dst=/legacy-dist,readonly" \
  --mount type=volume,src=kollens-fresh-v14_fresh_frontendassets,dst=/new-cache \
  --entrypoint node "kollens-fresh:$FRESH_RELEASE_ID" /seed-frontend-assets.mjs \
  --source /legacy-cache --source /legacy-dist --source /app/dist/assets \
  --target /new-cache
```

Review the dry-run's asset count, paths, hashes and plan SHA-256. Run the same
image, sources and target to apply, adding the reviewed SHA:

```sh
docker run --rm --network none --read-only \
  --mount "type=bind,src=$SEED_SCRIPT,dst=/seed-frontend-assets.mjs,readonly" \
  --mount type=volume,src=bscan_bscan_frontendassets,dst=/legacy-cache,readonly \
  --mount "type=bind,src=$LEGACY_ASSET_EXPORT/assets,dst=/legacy-dist,readonly" \
  --mount type=volume,src=kollens-fresh-v14_fresh_frontendassets,dst=/new-cache \
  --entrypoint node "kollens-fresh:$FRESH_RELEASE_ID" /seed-frontend-assets.mjs \
  --source /legacy-cache --source /legacy-dist --source /app/dist/assets \
  --target /new-cache --apply --sha256 '<reviewed-plan-sha256>' \
  --confirm-target /new-cache
```

The helper runs from a read-only script mount, so it needs no host Node install
and is not silently added to the application entrypoint. Its only writable
mount is the new cache. A second run reuses identical files. A conflict or stale
operator lock stops the process for inspection; do not remove or overwrite
unknown files to force it through. After starting the preview API, request an
old lazy module and its dependencies, CSS/font assets and a current module on
port 3303, and compare their response hashes with the plan before switching
public traffic. The local regression fixture exercises these requests through
the real frontend routes, including preservation beyond the seven-day cutoff.

## Activation remains separate

Both candidate services have an empty bot token and
`FRESH_TELEGRAM_ACTIVE=false`. Preview/capture must send no real Telegram
messages. `compose.fresh.activate.yaml` is a separate later override requiring
`FRESH_TELEGRAM_BOT_TOKEN` and the approved notification start-block/ownership
handoff. Do not use it while the old delivery worker owns live notifications.

The public port is changed from 3303 to 3300 only during the later approved
cutover, after the existing app releases that port. Do not run `down -v`, remove
old containers/images needed for handback, or delete either database. Complete
the asset seeding and preview checks above so previously opened tabs can still
fetch their old chunks. No old financial history is copied into the Fresh
trading core.

All commands above describe a later release; this preparation does not execute
them. The canceled eight-hour validation is not resumed.
