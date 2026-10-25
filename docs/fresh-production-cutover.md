# Fresh v1.4 production database cutover

This operator procedure was executed following the October 25 release request.
See [the completed production release](fresh-v14-release-20261025.md) for the
exact application commit, boundary, preservation checks and handoff. The canceled
eight-hour local trial stays closed. Do not rerun an initial import against the
existing production database.

Use [the isolated deployment configuration](fresh-v14-deployment.md),
[`compose.fresh.vps.yaml`](../compose.fresh.vps.yaml) and the separately reviewed
[`compose.fresh.activate.yaml`](../compose.fresh.activate.yaml). Do not combine
Fresh with the old Compose project or reuse its database volume.

## Data and ownership contract

| Resource | Legacy source | Fresh destination |
| --- | --- | --- |
| PostgreSQL | `bscan`, loopback `5434` | new `kollens_fresh_v14`, loopback `5437` |
| Trading history | Preserved in its original database | Starts at one explicitly selected confirmed block |
| Accounts and settings | Read-only consistent export | All 21 feature tables, checked after typed import |
| KOLs | Addresses, public/private role and identity | Same identities; no old totals, positions or trades |
| Portfolio | Original memberships, labels, added time and revision | Same memberships; effective financial start is the later of the existing since-added time and Fresh boundary |
| Telegram | Existing sender until the sealed handoff | Disabled until final seal, activation checkpoint and separate runtime override |

The whitelist preserves authentication users/sessions/attempts, guest and account
favorites, creator ownership/profiles/challenges, Portfolio memberships, Telegram
settings, per-KOL consent, bot update/pacing records and notification delivery
deduplication. Original trading rows, financial facts, token/market history,
candles, positions and snapshot tables are never exported into Fresh. Existing
favorites can still refer to old addresses without importing their trading data.

The source is opened in a repeatable-read **read-only** transaction. Exported
PostgreSQL JSON is passed directly to typed record insertion; bigint values,
microsecond timestamps, bytea and JSON values do not round-trip through JavaScript
numbers. Every file has a byte count, row count and SHA-256. The manifest binds
both database names, the boundary, file hashes and the bundled operator hash.
Changed source/destination schemas, files, roles or conflicting manifests fail
closed. An identical applied manifest is a no-op. Final seal verifies every
latest source delivery row after upsert and retains destination-only dedup rows;
their counts and full destination digests are recorded in the seal.

No old database is reset, renamed, deleted or compacted by this tool. The private
export is a bounded cutover artifact, not a new permanent backup framework. Keep
it restricted and retain it through release verification; later cleanup needs a
separate instruction. Do not delete any existing database, migration copy or
volume as part of this procedure.

## Prepare before the maintenance window

1. Record the old Compose project/service names, image IDs, public API port,
   database volume, webhook URL/secret and frontend asset cache. Confirm a single
   sender owns Telegram delivery. Do not change node or webhook configuration.
2. Prepare the reviewed Fresh image with an immutable `FRESH_RELEASE_ID`, new
   database password, stable replay secret, GMGN chart credentials and existing
   auth/webhook configuration in a private env file outside Git. The candidate
   API uses port `3303`; old port `3300` stays in place until traffic switches.
3. Set `FRESH_CUTOVER_SOURCE_DATABASE_URL` to the legacy database connection on
   loopback port `5434`, preferably with a read-only role. The destination URL is
   fixed by the isolated Compose file. Never paste credentials into commands or
   print rendered Compose configuration.
4. Pre-create `FRESH_CUTOVER_DIR` on the VPS with owner-only permissions. Only the
   operator mounts it at `/app/.cutover`; the application does not. Create no
   export folder inside it in advance: each plan requires a new folder.
5. Validate configuration with `config --quiet`, build the image and start only
   `fresh-db`. Do not start Fresh API or worker before guarded initialization.
   Pre-stage the existing hashed frontend assets for the later public switch.
6. Verify the deployed legacy sender still uses the reviewed five-minute trade
   age, public/token exclusions and subscriber consent gates. The final backlog
   classification is pinned as `legacy_alert_policy_v1`; a changed old sender
   policy requires a reviewed operator update before release.
7. A read-only `plan` without `--choose-boundary` can audit source sizes and table
   compatibility without selecting a new financial boundary. Inspect counts and
   manifest hashes locally on the server; exports contain private account data.

Commands below use `<private-env-file>` and returned hash placeholders. They
describe the later release; they are not authorization to execute it now.

```sh
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml config --quiet
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml build app
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml up -d fresh-db
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml --profile operators run --rm cutover plan --folder /app/.cutover/preflight
```

## Initial import and parallel capture

Enter maintenance for account/settings writes and public traffic; stop the old
API and await in-flight login deliveries. Leave its worker capturing and sending
existing alerts while Fresh is initialized. The operator requires an explicit
acknowledgment that source account/settings writers are paused. No app process
may be pointed at the new database before initialization completes.

Select the new boundary only at this approved release step. It is the canonical
node head minus six confirmations. Review the returned block/hash and table
counts. Initial apply rechecks the same canonical header and requires a plan no
older than five minutes; an expired plan has no writes and must be replaced.

```sh
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml --profile operators run --rm cutover plan --folder /app/.cutover/initial --choose-boundary
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml --profile operators run --rm cutover apply --manifest /app/.cutover/initial/manifest.json --sha256 <initial-sha> --ack-source-writers-paused
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml --profile operators run --rm cutover apply --manifest /app/.cutover/initial/manifest.json --sha256 <initial-sha> --ack-source-writers-paused --apply --confirm-database kollens_fresh_v14
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml --profile runtime up -d app worker
```

The first `apply` is dry-run. The second explicit apply atomically imports all
feature rows, creates public and private collection scopes and sets capture/decode
to the same boundary. Fresh captures from the following block. Its preview API
and worker have empty bot tokens and `FRESH_TELEGRAM_ACTIVE=false`; there are no
real preview messages. Keep the old worker running until Fresh is near the
confirmed head. Both collectors write separate databases.

Check canonical capture/decode/urgent evidence health, current quotes, public and
private isolation, stored profile/leaderboard equality, chart access and a real
local or preview replay. A new unresolved trade remains explicitly incomplete.
Do not waive accounting checks to satisfy the five-minute maintenance target. If
the cutover cannot finish in the agreed window, restore the old API to the
untouched legacy database and defer the release; account/settings changes then
require a new reviewed import into a new destination, not overwriting Fresh.

## Final seal and alert ownership handoff

With account/settings writers still paused, allow the legacy worker to drain
delivery and pending live trade processing. Stop its **collector and sender** and
await in-flight network requests. Its final `worker_state['node']` block/hash is
the handoff **B**. Fresh capture must reach B and retain its matching header.

A seal plan refuses to approve pending or leased outbox rows, unresolved bot-login
send leases, or currently deliverable unprocessed public trades through B.
Missing identity/hash evidence or a future timestamp on a potentially eligible
public trade also blocks. It uses the legacy sender's five-minute age, token and
subscriber-consent rules. Expired, private, excluded, non-trade and unsubscribed
rows remain untouched and silent; their reason counts and an ordered ID/reason
digest are recorded in `legacyBacklog`. This avoids treating intentionally silent
old rows as work that must be sent. Do not silently cancel, rewrite or resend
blocked work. If it remains, resume the old sender using its
existing database and resolve them there; stop it again, then produce a new
seal plan. Failed/uncertain evidence remains unchanged and is not auto-resubmitted.

```sh
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml --profile operators run --rm cutover plan --phase seal --folder /app/.cutover/seal
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml --profile operators run --rm cutover seal --manifest /app/.cutover/seal/manifest.json --sha256 <seal-sha> --ack-source-writers-paused --ack-legacy-collector-stopped --ack-legacy-sender-stopped
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml --profile operators run --rm cutover seal --manifest /app/.cutover/seal/manifest.json --sha256 <seal-sha> --ack-source-writers-paused --ack-legacy-collector-stopped --ack-legacy-sender-stopped --apply --confirm-database kollens_fresh_v14
```

Final seal compares all unchanged account/settings rows and the fixed monitored
wallet role set, synchronizes the latest seven Telegram delivery tables, proves
their source rows match exactly and writes `production_cutover_seal`. It never
changes source rows or copies old trades. A changed feature table blocks release
instead of overwriting concurrent edits. Fresh must not accept user edits before
the seal.

## Activate the approved release

Activation validates the final seal, current Fresh canonical capture **C** no
older than 30 seconds, **C ≥ B**, retained B and uninterrupted parent/hash
continuity from B through C. The durable alert floor remains **B**, not C: otherwise
trades arriving while the services switch could be silently skipped. New alerts
require block **strictly greater than B**. Imported old outbox rows remain intact
and are excluded by the activation time gate. Reorg below the floor invalidates
activation rather than continuing from orphaned evidence.

```sh
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml --profile operators run --rm cutover activate --sha256 <seal-sha> --ack-source-writers-paused --ack-legacy-collector-stopped --ack-legacy-sender-stopped
docker compose --env-file <private-env-file> -f compose.fresh.vps.yaml --profile operators run --rm cutover activate --sha256 <seal-sha> --ack-source-writers-paused --ack-legacy-collector-stopped --ack-legacy-sender-stopped --apply --confirm-database kollens_fresh_v14
```

This writes only `production_activation`; it does not send a message, change
webhooks, flip environment flags or switch public traffic. After separately
confirming the old services have stopped, use the reviewed activation override
and public port change described in the deployment guide. Preserve old frontend
hashes before that switch. Verify login/session continuity, favorites, creator
ownership, Portfolio privacy/boundaries, notification deduplication, fresh stored
P&L and a replay whose MP4 ending matches the prepared modal.

After Fresh owns capture and delivery, do not restart the legacy sender in
parallel. A handback after new alerts have been sent needs a reviewed deduplication
handoff; a blind service restart could duplicate notifications. The old database
and all prior financial history remain preserved throughout.

## Local rehearsal evidence

`server/fresh/cutover.integration.ts` creates only explicitly named disposable
`kollens_cutover_source_test_*` and `kollens_cutover_dest_test_*` databases on local
port 5436. They are retained; it does not touch or delete the user's app database.
It uses fake canonical node responses and sends zero real messages. Rehearsal
checks cover the 21-table lossless transfer, bigint/microsecond/bytea fidelity,
private-wallet isolation, Portfolio boundary mapping, absence of imported
financial history, idempotence, delivery drain, final delivery proof and the
legacy B alert floor when Fresh has already advanced to C. Artifacts and private
manifests are under `.cache/fresh/private/v14-cutover-rehearsal-*`.
