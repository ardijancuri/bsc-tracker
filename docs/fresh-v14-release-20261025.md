# Fresh Kollens v1.4 production release — October 25, 2026

Fresh is live at https://kollens.com. The final traffic switch completed at
approximately 03:21:02 UTC, with an 83.27-second final maintenance window.

Application commit: `a6d8afb632c3c8802cbe02ca16b87622b9ecd4f0`.
Immutable release tag: `v1.4-fresh-20261025.2`.
Linux image: `sha256:b64828597387077c5172f75090352f6460033f99c25ca7f196959e52c191fc8f`.
The existing `v1.4.0` tag was not moved. GitHub main and the release branch contain
the reviewed implementation; the original checkout's unrelated X work is intact.

## Preserved data and tracking ownership

All 21 account, authentication, settings, favorites, creator, Portfolio and
Telegram datasets were transferred and checked as typed PostgreSQL records.
The two existing accounts, three session records and 229 KOL identities were
preserved. Private memberships remain isolated from public rankings and feeds.

Fresh trading begins after confirmed block **129627586**, hash
`0x11a1ab790a8a32d1ef7569c17447bb0283ab534d5231951fc6e3f384cd049d27`,
dated 02:42:03 UTC. This is the agreed new tracking boundary, not an import of
older financial history. The legacy `bscan` database and its complete previous
history remain intact on PostgreSQL port 5434. Fresh uses the separate
`kollens_fresh_v14` database and volume on port 5437. No database was dropped or
reset. Local databases, migration originals and prior evidence remain retained.

The final source collector/sender handoff was sealed at block **129632716**,
hash `0xa3de0f32eec5b2464c820acd3ac7c196fde828c6e9461947fe2036ba6bdf08c6`.
Activation verified canonical parent/hash continuity to Fresh capture. New alerts
start strictly after that handoff block. The old API and worker are stopped;
the old database stays running. Do not restart the old sender alongside Fresh.
Proxy, webhook and BSC-node configuration were not changed.

## Verification

- The financial release passed 3,606 regression tests, both TypeScript projects,
  the production build and 16 PostgreSQL integration programs. The subsequent
  operator-only indexed-join fix passed 20 focused tests, both TypeScript projects,
  another production build and seven PostgreSQL preservation/query-plan checks.
- The exact Linux image passed native Sharp rendering and actual private IPC
  tracing in the worker, with canonical transaction/receipt checks.
- All 166 retained frontend assets passed HTTP checksum verification. Account,
  session and settings digests matched before activation; private API routes
  rejected anonymous requests.
- The final account/delivery seal retained the original import manifest and
  verified source rows without rewriting that manifest. Primary-key equality
  reduced a local 200-row verification batch against 27,191 rows from
  2,286.559 ms to 3.443 ms, preserving full typed-row comparison.
- Before handoff, all 62 recorded buys/sells had known values and positions had
  zero balance mismatches. The original SPCXB-settled trade was repaired from
  authentic historical node evidence, preserving its ID, quantity and gas.
- Public HTTPS health and leaderboard checks passed after activation. A genuine
  closed-position replay prepared in 105 ms and its fresh signed manifest
  validated. Profit `8.6048939154121190220124368` and ROI
  `0.13956385682595305568512251842869962` matched the frozen accounting object.
  Previously generated and inspected local MP4 evidence remains retained.
- The independent 03:22:37 UTC post-deployment audit verified 267 continuous
  canonical headers from handoff B through capture C, two-block confirmed-head
  lag, all 14 current identity digests and every nonempty preserved source-row
  subset. All 66 public buys/sells then recorded had known USD values; private
  activity leaked into no public feed or ranking.

Two transfer-only contract interpretation repairs remain explicit. These
contracts have no authenticated launch, token row or financial trade; their
recipient books have no buys/sells. No costs, fees or profit were invented and
active complete rankings are unaffected. Unsupported historical evidence is
still reported honestly, including the preserved older local accounting gaps.

The new production database measured 85,808,819 bytes across 35 base tables at
03:22:37 UTC. Heap/TOAST categories were 581,632 bytes of permanent financial
records, 6,791,168 bytes of temporary evidence and 57,376,768 bytes of current
identity/features (including preserved delivery records); relation indexes used
11,476,992 bytes. Catalog/other allocation accounts for the remainder. Separate
storage was WAL 167,772,160 bytes, chart cache 920 bytes, frontend cache
22,439,888 bytes and container logs 31,169 bytes. These are initial measured
allocations, not a monthly growth prediction. The preserved legacy database,
other databases, original evidence and operator exports are additional storage.

## Operator evidence and limitations

Private release manifests and logs live under
`/opt/bscan/.cutover/fresh-v14-669d4d3/`; the successful handoff is
`final-handoff-20261025T031939-2563420/traffic-switched.json`.
Local release evidence is retained under
`.cache/fresh/private/v14-release-20261025/`. These files can contain account or
session data and are not public artifacts.

Earlier aborted attempts and their checks remain recorded. The first was an
incorrect private QA response-field assertion; the second exposed the slow
operator join. Both restored the legacy service before activation and retained
all data. The successful final attempt used the verified indexed join.

The canceled eight-hour trial remains closed. Its 4,160.051 audited seconds are
preserved; no scheduled validation, trial monitor or wakefulness guard was
restarted. Ordinary production collection and explicitly activated Telegram
delivery now belong to Fresh. No arbitrary Telegram or X test post was sent.

## GANG follow-up release contract

The later October 25 request authorizes the recovered GANG feature and its
one-time history import on the existing live Fresh database. This is an
additive upgrade, not another initial database cutover. The legacy database
was subsequently deleted at the user's explicit request; the initial
cutover/seal instructions above must not be rerun.

This release preserves the separately deployed GGC disk snapshots, import CLI
and four-hour app scheduler. Its exact live source patches were recovered from
the retained production build manifests. Unrelated uncommitted replay-motion
changes and original-checkout X work are excluded.

The GANG-only historical bundle contains 220 canonical receipt contexts,
181 reconciled provider movements, 220 compact financial facts and 177 trades
across 21 trading KOLs. All 177 transaction MCAPs use dated verified supply,
pool reserves and BNB/USD evidence. The checksummed import operator defaults to
read-only planning, binds the existing production database/start, preserves
original known financial inputs and receipt bodies/TTLs, applies exact
Portfolio membership floors and silences historical delivery. An identical
rerun adds no facts or accounting rebuilds. Missing GANG artwork is seeded
from its previously authenticated public image without replacing existing art.

Normal collection, prices, balances and incremental accounting remain node
driven. GMGN supplies charts/replay candles; its wallet-history API was used
only for the explicitly authorized recovery. No QA token-coverage checkpoint,
local preview refresher, trading reset or periodic financial snapshots are
installed in production. The existing global start and notification activation
remain unchanged.

The isolated release candidate passed 3,954 regression tests, including the
preserved GGC suites, both TypeScript projects and the production build. The
final operator and its default decoder path passed focused follow-up tests and
nine rollback-only PostgreSQL groups, with independent preservation,
membership, canonical-source and idempotency review. The production import
manifest SHA-256 is
`3c2733bbe6da8fed47db0cc56fdc3e0a3d7b949381df09e11a20be9567e81532`.
Runtime and post-deployment verification are recorded separately when complete.

## GANG follow-up deployed

The additive follow-up was deployed on October 25 at approximately 15:26 UTC.
Runtime commit is `b37abebabf1c959835f26b6db6d33d602e0e88be`, tagged
`v1.4-gang-20261025`. Both live containers use image
`sha256:d7e643e6dbd421ce203c425d61f5140209b89b71e98139ab9b010d04ce48f3fe`.
The existing Fresh database, volume, initial tracking boundary and notification
activation remain unchanged; no initial cutover or financial reset ran.

The guarded import committed 220 financial facts and 177 buy/sell trades across
21 trading KOLs. It added 200 receipt contexts and merged 20 existing contexts
without replacing their original bodies or expiry times. All 177 imported
trades have quantities, amounts and dated transaction market caps. Historical
facts are not live observations and were marked already processed for alerts.
No historical Telegram message or X test post was sent.

Independent checks compared every one of the 2,968 original financial row
digests, 7,006 receipt-body checksums and expiry times, and 21 account/settings
table digests. All matched exactly after import and after traffic switched.
The fixed GANG bundle also matched the final capture tail through block
129729010 before import. No additional GANG context was omitted in that tail.

The new worker resumed the same checkpoint with its private read-only IPC
mount. Capture advanced and capture/decode/quote block hashes matched the VPS
node. Exactly one worker remains. Temporary preview containers were removed.
The existing chart/frontend/championship cache volumes, both championship
snapshots and the single four-hour championship scheduler were preserved.

Public token details, artwork and genuine charts were checked on kollens.com.
All 177 trade rows have complete amounts, quantities and MCAPs. All 21 KOL
profile/leaderboard stored realized totals agreed. CryptoCharming's GANG
position retains six buys, 28 sells and realized profit
`13666.00057317412279034487012538546883512` USD. Its live replay preparation
returned ready with 1,243 genuine chart observations in 429 ms and passed
manifest validation. The actual live share UI generated and downloaded a
12,582,248-byte MP4; its playback inspection is retained with the release
evidence.

That downloaded production MP4 played to completion at 15.5 seconds in
1080 × 1350 resolution. Its ending profit `+$16,418.30` and ROI `+287.55%`
matched the dated frozen prepared object. This estimated open-position ending
is separate from the lifetime realized figure above. All 15 imported
USDC-settled trades also retained their original amounts and displayed the
verified historical BNB equivalent. No external share/post action was used.

Four GANG position summaries still truthfully wait on pre-existing opaque
synthetic-transfer receipts for other tokens in those wallets. Those receipts
predate this import and are not in the GANG bundle. Their original unknown
settlement and accounting guards were preserved; this release does not claim
those unrelated historical gaps are repaired. The untraded distributor's
unknown acquisition basis likewise remains explicit.

Private production plans, original-row checks and post-switch reports are in
`/opt/bscan/deploy/gang-v14-20261025/`. Local release evidence is in
`.cache/release/` in the isolated `gang-live-v14` worktree. These artifacts may
contain private account data and must not be published. The canceled local
validation and unrelated X/replay-motion work were not restarted or changed.
