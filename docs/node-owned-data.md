# Node-owned financial data

Normal API requests read PostgreSQL. The collection worker is the only normal
financial RPC consumer; GMGN signing/queues are used only by historical import
jobs. No live DexScreener, CoinMarketCap or GeckoTerminal financial fallback
remains. Optional logos and social metadata are independent enrichment.

## Durable stages

`node_collection` commits relevant complete receipts and canonical headers with
range coverage. Execution decoding, compatibility trade projection, market
collection, valuation and accounting have independent checkpoints/leases. A
missing receipt or conflicting block never advances collection. Re-decode uses
saved evidence after pruning; decoder errors do not stop raw collection.

Token precision and trusted conversion-feed evidence have a separate urgent
queue, enqueued atomically with each relevant receipt block. Fresh work takes
priority over old repairs, partial token chunks survive retries, and fee-only
blocks also retain conversion evidence. Block/log retention does not imply
historical contract-state retention: current state may be pruned within about
128 blocks. Live metadata age is monitored separately from the block-retention
margin. Catch-up cannot silently turn missing historical metadata into current
proofs.
Authenticated market swaps by other wallets enqueue the same urgent work in
their raw-range transaction. Relevant registered quote assets retain their
precision and USD-conversion evidence too. Append-only precision/feed writes
keep canonical rollback protection without waiting for the market projection
lock. Registry synchronization leaves already-active checkpoints untouched.
Eight independent metadata leases keep slow quote conversions from blocking an
entire batch. Selected-token priority applies only inside the retained 128-block
state horizon; pruned repairs cannot displace fresh ordinary evidence. Independent
same-block reads use validated JSON-RPC batches of at most 32 elements. Converted
quotes reuse a short-lived authenticated pool candidate catalogue while reading
new canonical precision, state, liquidity and feed evidence for every price.

Public tracked KOLs and Portfolio memberships share monitoring. Portfolio
accounting is scoped to account, membership revision, registration block and
addition time. Historical public imports never change that private boundary.
Removing a membership revokes reads/exports immediately, including after an
in-flight preparation finishes. Public feeds/alerts still require tracked KOLs.

See [node-evidence.md](node-evidence.md) for execution identities, reorg rollback
and the optional private IPC tracing boundary. No raw financial evidence has an
automatic expiry. Fifteen-minute immutable replay versions are separate from
permanent evidence and the dated latest accounting snapshots.

## Prices and accounting

Authenticated Pancake V2/V3, FourMeme, Flap and encountered Infinity markets
collect swaps from all participants. Genuine swap observations build minute
candles and longer aggregates. Confirmed pool-state observations refresh quotes
without adding volume or manufacturing candles. Contract decimals, supply and
trusted conversion-feed rounds are stored with canonical block evidence.
Unsupported versions retain raw evidence and expose a decoder reason.

One exact rational FIFO ledger computes sales plus marked outgoing transfers
plus remaining value, less purchases, incoming receipt valuation and known
wallet-paid fees. Internal Portfolio transfers move original lots/costs. ROI
uses fee-inclusive acquisition capital; disposal fees reduce profit, without
being counted again in that denominator. Unsupported fee allocation and unknown
opening costs remain unknown. Node values follow Kollens policy, rather than
promising numerical parity with an external provider.

Historical accounting is cached separately from fresh balance/market marks.
Six initial token cards receive one compact summary batch. Ordinary activity,
summary and chart reads never scan historical RPC or invoke financial providers.
Selected work promotes an existing durable accounting job. Temporary repair
delays preserve a dated valid result; reorgs, contradictory balances and unknown
costs do not revive stale approval.
The worker refreshes selected and open-token marks before ordinary historical
markets, yielding once a priority mark was checked within fifteen seconds.
An unavailable unrelated conversion feed cannot stop every token's refresh.
Discovery and state-price batches renew their confirmed checkpoint during slow
work; current valuations do not reuse a lagging collection checkpoint. Accounting
still waits for independently current, complete wallet coverage and balance.

## Replays

`GET /api/kols/:wallet/tokens/:token/replay-preparation` is the only public trade
preparation flow. The Portfolio equivalent is account-authorized under
`/api/journal/wallets/:wallet/tokens/:token/replay-preparation`. Responses carry
stages, reason/retry timing, an immutable accounting snapshot and an approved
full-history window. `snapshot=` binds a public modal to its frozen financial
version; private requests use the account-bound saved replay version.
An expired or invalidated media lease is refreshed as a whole, so retries cannot
remain pinned to an old valuation. Closed windows require real observations
bracketing their final movement, including transfer-only endings.

The browser validates version, identity, membership context, freshness and
chart/snapshot agreement. It performs one bounded poll at a time. Long windows
use real coarse history plus a minute ending segment; a daily bar cannot excuse
a stale flat tail. Historical values and MCAP using uncertain supply are marked
as estimates. The existing canvas, branding, 15.5-second duration and encoder
remain shared by trade/token exports.
Replay lines may use genuine recorded swap/state observations where candles
are still decoding. This is a separate sampled read, with original block/time
and supply evidence, complete raw coverage, genuine price brackets and no
uncovered sample gap over 180 seconds. Completed imported intervals can cover
the historical prefix. Truncated or mismatched samples are rejected; normal
candlestick completeness remains strict. The line is marked sparse and no
candles or trading volume are synthesized. A fresh frozen quote may bridge the
fractional current minute only when the recent genuine price remains fresh.
Known historical supply changes travel with individual observations. Token
exports preserve actual swap/state timestamps rather than extending bucket
boundaries into an invented ending. Selected missing market pages backfill from
the recent gap first, within the existing bounded collection budget.

## Historical migration and onboarding

Public-only resumable wallet discovery finds older token pairs, including pairs
absent from canonical trade rows. Pair jobs retain completed pages, original
movements, aggregates and genuine chart observations. Provider-only rows keep
unset block positions and never enter canonical trades or live alerts.

An imported baseline must match overlapping indexed transactions and a
confirmed node balance/checkpoint. Original FIFO lots, earlier realized gains
and acquisition capital survive a zero-balance handoff. Aggregate fee residuals
remain in the baseline, never in earlier frames. Unknown residual allocation
does not become an invented lot cost. The existing dual-key queues and cooldowns
are unchanged; failed requests never rotate to the other key.

Historical quantity reconciliation preserves each raw JSON quantity and its
source representation. GMGN display numbers, including numeric strings that
round-trip exactly through IEEE754, receive only the source's half-last-decimal
and half-ULP rounding bounds, capped by token precision and the existing small
relative limit. Full decimal strings keep their stricter precision; zero never
matches a nonzero balance. Independently matched indexed quantities replace
display quantities for ledger calculation. Only unmatched provider movements'
own bounds can reach the ending balance check. The sanitized
`server/fixtures/node-import-quantity-rounding.json` records this policy
explicitly. Aggregate fee differences remain ending-baseline evidence, never
historical frame fees or invented FIFO allocations. Independently reconciled
cash flows may establish estimated ending total profit while the FIFO split
remains explicitly unavailable.

Chart imports request an explicit 1,000-candle limit and persist that request
limit beside the original rows. A full page resumes at its earliest returned
candle instead of skipping to the requested start. An explicitly exhausted
request records queried coverage separately from actual observations, so a
sparse or empty interval creates no candles or volume. Price observations must
still bracket the replay appropriately, and a fresh node valuation cannot make
an old market tail fresh. Selected public replay windows can resume incomplete
chart jobs while retaining pages and provider cooldowns.

`NODE_HISTORICAL_IMPORTS=0` disables import traffic. API containers receive no
GMGN credentials in Compose. Live capture has priority over imports; pruning
gaps are recorded and cannot be silently skipped.
Imported public token pages and favorites require a valid public baseline and
canonical checkpoint; imported movements never inflate canonical trade counts.
An expired legacy capture cursor needs the explicit, audited one-shot procedure
in [node-evidence.md](node-evidence.md), during a separately authorized release.

## Validation and later release

Unit tests and guarded disposable PostgreSQL integrations cover raw capture,
execution/fee attribution, independent market history, exact accounting,
public/private boundaries, imports, replay contracts and notification delivery.
The sanitized April–October fixture retains all 127 historical movements.
Tests use fake transports; local tests do not change the production webhook.
Run `npm run check`, `npm test -- --maxWorkers=2`,
`npm run test:integration:node-owned` and `npm run build`. The integration runner
requires PostgreSQL on localhost port 5435 and creates/deletes only fresh,
uniquely named disposable databases. It removes bot/provider credentials from
its child processes; the importer uses its explicitly supplied fake transport.
The local API smoke test returned six compact token summaries in 8 ms. Those
unpopulated positions correctly remained pending; this measures cached/database
response time, not completed historical import or provider latency.

Worker-state metrics include collection/decode/projection pending work,
collection lag/pruning margin, approximate database rows/bytes, accounting and
market stage durations, import progress and failure categories. Provider queue
diagnostics remain credential-free.

This implementation is local. Before a separately authorized release: back up
the database, switch API and worker together for the execution uniqueness
migration, validate replacement evidence/snapshots in shadow, then enable the
new reads and migration jobs. Do not revert only the old worker image after
execution-level rows exist. Production node tracing setup, cutover and production
validation require separate authorization.

Local visual validation generated `.cache/node-owned-regression.mp4`: a genuine
1080×1350, 15.5-second MP4 using the existing encoder. Its prepared modal and
encoded ending both show $186.50 profit and 184.6535% return; the middle frame
shows moving estimated profit. Encoding took 1.97 seconds in the local browser.
This synthetic regression is separate from importing existing production data.

Cloned-database validation on 2026-10-19 generated and decoded two actual
1080×1350, 15.5-second MP4s with production accounting and encoding:

- Yukaz / 五花羊: final −$32.3674705950 and −6.3410607143%, matching the
  frozen modal; 2.63 seconds encoding, 2,711,780 bytes.
- Afeng / BEMWHEEL: final −$242.1226623812 and −2.5292332232%, matching the
  frozen modal; 3.17 seconds encoding, 9,355,726 bytes. Historical frames move
  through positive and negative estimated profit. Its chart joins genuine
  imported history to independent node observations, with sparse disclosure.

Videos and decoded middle/ending PNGs are retained in the local Downloads
folder; `.cache/replay-qa/validation.json` records the frozen identities.
Two additional real closed positions returned complete node-only P&L with
GMGN disabled. Their unavailable older quote precision/conversion evidence
was left explicit rather than fabricated for a video.

Final local validation: 2,023 unit/regression tests across 129 files, all fifteen
PostgreSQL integration suites (including 21 fake Telegram delivery scenarios),
both TypeScript projects and the production build passed. The local capture
worker caught up to the six-confirmation head and remains running with the
API and Vite UI. Its Telegram delivery and external financial imports are
disabled. Historical recovery was bounded to the two selected public pairs;
other old positions still require valid historical coverage. No commits,
pushes, deployment or production database/configuration changes were made.
The final warm eight-lease sample completed 112 jobs/minute against 96 arrivals;
100 of 101 blocks within the retained state horizon had native-fee proofs and
91 were fully complete, with remaining fresh work largely leased. Unsupported
quote routes and old pruned precision remain explicit limitations. One additional
bounded historical chart request recovered the local restart gap; sparse imported
islands retain genuine endpoints and complete retrieval coverage. Uncovered node
sample gaps are still rejected.

### Sustained local collection follow-up, 2026-10-19

A longer cloned-database run exposed a collector CPU stall that the selected
replay checks did not cover. Shared Flap/FourMeme controller logs were decoded
once per registered token, including unrelated tokens. Controller logs are now
indexed by their address words before the existing authenticated decoder runs.
The scale regression retains all 2,354 genuine log identities for 700 targets
while performing only 2,354 candidate decodes. Completed RPC memo entries are
bounded; pending requests remain coalesced and reorg generations detach them.

Raw capture now takes priority over old metadata retries and registration
repairs while it is more than 128 blocks behind. Feed projection publishes
authenticated trade identity and side even when exact token metadata is pending;
unavailable amounts remain null and later precision repair updates the same
execution instead of duplicating it. ERC-20 decimals are never guessed. Visible
accounting work rotates ahead of retrying old selections, and token-card price
refreshes are queued in one database batch.

Historical recovery also handles a null legacy display quantity by checking
successful, authenticated execution flows with the same wallet, transaction,
token, block and hash. Missing or ambiguous evidence remains an explicit error.
Aggregate-order progress survives provider cooldowns rather than repeating the
first negative lookup. Existing pages and request pacing are preserved.

Browser JSON reads bypass the HTTP cache. A previously cached redirect from
localhost to the live site caused the local trade feed to fail even though the
local API returned fresh rows. The restored browser feed was verified with
new confirmed trades while the collector remained near its six-confirmation
checkpoint. This validation does not modify the production database or services.

Visible public historical recovery is promoted in one database batch ahead of
ordinary migration; an explicitly selected trade stays highest. Background
recovery still owns all provider requests. Completing a card's baseline releases
its priority before chart imports, preserving selected replay priority and
provider cooldowns. Six initially inspected Afeng positions were recovered and
returned complete P&L through the ordinary API. Newly visible older positions
continue through the migration queue instead of requiring manual recovery.

Verified cash-flow endings with unknown FIFO allocation retain their original,
dated valid result if only the current quote becomes unavailable. This narrow
case requires unchanged historical evidence, confirmed matching quantities,
matching costs/cash flows and an uninvalidated snapshot. Cost corrections,
balance changes, missing proofs and reorgs cannot use it to conceal disagreement.

The final follow-up passed 2,051 tests across 132 files, both TypeScript projects,
the production build and all fifteen PostgreSQL integration suites. Accounting,
Portfolio and importer integrations were also rerun after the final priority and
dated-retention changes. The local API, UI and worker remain running; historical
public migration is now enabled using the existing queues and conservative
budgets, while Telegram delivery remains disabled. The earlier offline worker
configuration is still available without its explicit `--historical-imports`
local launcher flag. Production remains unchanged.

The visible Afeng list changed again during live capture. Automatic migration
restored five of its six current cards. The remaining `0xf08d1886e2a69dfabd22a45eed8e1407b338b97e`
has missing acquisition quantity and internally contradictory historical totals;
neither its normalized movements nor its aggregate establish a defensible
ending. It remains numerically unavailable and displays **Unverified** with a
specific historical-accounting explanation. This is distinct from a quote delay
or active history recovery. No zero-cost purchase or guessed fee was introduced.
The final additional client/server reason regressions passed in a 363-test
focused run. Current API states and timings are recorded separately in the
ignored `.cache/replay-qa/pnl-feed-validation.json` artifact.

### Token identities, chart loading and live replay validation, 2026-10-19

Token names and symbols now have their own durable, canonical node evidence and
retry queue. Selected tokens take priority, followed by recent public trades;
legacy discovery is throttled independently. Standard string and bytes32
identity returns are bounded and validated. Optional identity reads do not
block financial precision or raw collection. Published names notify open pages,
and cached trade activities overlay current display identity without changing
their accounting snapshot, prices or original observation time.

Custom chart requests also bypass cached HTTP redirects. Full-history request
scope is distinct from completeness: genuine partial candles display with their
coverage notice instead of failing response validation. Stored node, imported
and mixed history uses bounded database pagination, preserves genuine timestamps
and completed pages, and stops at unavailable coverage. Replay eligibility still
uses its stricter accounting and market coverage checks.

Native BNB amounts in accounting and feed projections share one proof function.
Purchases use the traced wallet's net expenditure, including refunds; sales use
strict authenticated receipt payouts or a matching trace. Whole smart-account
bundles are not attributed to an individual operation. Durable, bounded trace
jobs validate the root transaction and canonical block, retain retry state and
prioritize recent blocks. Successful corrections invalidate dependent financial
snapshots and reproject amounts. Pair locks and preparation-time checks prevent
a concurrent stale first snapshot from overwriting corrected evidence.

An open snapshot cannot include a trade newer than its price observation. This
condition queues a fresh node valuation and remains pending instead of reporting
an accounting contradiction. Older non-pinned quote conversions can reuse an
authentic preceding proof within the existing two-minute bound when historical
state reads are unavailable. Proof time, block and complete market evidence are
retained; a successful contradictory route read still rejects that fallback.

Live sampling exposed a separate market decoder starvation: the selection query
could exceed the entire work budget before decoding began. The bounded decode
work timer now starts after selection. Selected windows process their earliest
pending evidence first, so a current price does not continually displace the
replay's initial price. Raw collection, decoding and valuation remain separate.

Local validation uses the cloned `bscan_chart_preview` database and read-only
VPS node access. The ignored local trace adapter uses pinned SSH to the existing
private IPC, accepts only a transaction hash and a fixed bounded tracer, and
does not expose debug RPC or change VPS services/configuration. Financial
provider credentials and real Telegram delivery are disabled during the final
sustained run. Imported older fixtures keep their original provenance; fresh
DAC accounting uses creation evidence and node transactions captured during
this run. No deployment or commit is part of this validation.

Sustained testing also reproduced a collection deadlock: trade projection held
the shared rollback lock while awaiting work that needed another connection
from the exhausted pool. Metadata, conversion and trace inputs now load before
the projection transaction. The extracted projection writer uses only its
supplied connection and prepared inputs. A real PostgreSQL regression with a
two-connection pool proves that projection commits while collection waits for
the exclusive lock, releasing both the connection and collection progress.

Market decoding runs independently of collection and current quote refresh.
Within the existing row and time bounds it shares capacity between fresh
evidence and selected replay history; ordinary background work only fills spare
slots. Captured block headers authorize writes under the existing rollback lock
without redundant header RPCs. A contradictory stored header rejects the write;
uncaptured historical backfills retain their canonical node check. Completed
post-change 17:16 and 17:17 UTC cohorts contained respectively 429 and 453 decoded
logs, 26 unsupported logs each, and zero pending or missing-quote logs. Older
unavailable history is not concealed by these completed fresh cohorts.

Optional identity discovery now also examines a bounded batch from the entire
public 24-hour feed every thirty seconds. A repeated-trade burst cannot leave
older visible tokens behind the recent 512-row input limit. Its eligibility
matches the realtime feed, so visible quote assets can receive display metadata
without changing accounting or KOL-page exclusions. Selected work retains
priority. The actual twenty-page local API audit at 17:20 UTC covered 1,926
trades across 376 tokens with no missing names or symbols; WBNB also returned
its authentic `Wrapped BNB` name. Regression coverage includes the 600-row burst,
partial names, visible quote assets, account isolation and discovery throttling.

Actual local MP4s were encoded and decoded for inspection: an open mixed Teto
trade, a closed imported FOM trade, a fully node-covered DAC trade and a DAC token
replay. DAC's frozen modal/video ending matched at $28.056604188515237 profit
and 7.146002634805188% return, with moving historical profit. Its production
encoder took approximately 2.07 seconds for the 15.5-second, 1080-by-1350 MP4.
The token replay visibly marks genuine history gaps rather than drawing an
invented continuous market curve. Artifacts and measured proofs are in the
ignored local `.cache/node-soak` directory.

Final validation passed 2,074 tests across 134 files, both TypeScript projects,
the production build and all eighteen PostgreSQL integration suites. The last
identity-only adjustment was additionally checked in its disposable PostgreSQL
suite. A flaky test fixture's pre-existing trace timestamps were made explicit;
the production concurrent trace-publication rejection guard remains unchanged.

The final twenty-minute acceptance window ran from 17:01:02 to 17:21:02 UTC,
including controlled local restarts to load the fixes and concurrent regression
tests. The corresponding coverage audit found 2,682 consecutive stored headers,
zero missing heights or broken parent links, 30 relevant complete receipts with
zero invalid identities, and all 227 monitored wallets collected through the
same checkpoint. There were no long idle projection transactions. Collection
ended seven blocks behind the node (twelve blocks at the 95th percentile;
maximum 32 during restarts). Six chart-fetch parse failures belonged to two
planned API restart samples; they are retained in the report rather than counted
as successful requests. Later samples returned all three charts successfully.
This was a run with progressive fixes, not a claim of twenty minutes on an
unchanged executable.

After the provider-disabled validation, the existing local historical-import
mode was restored for unavailable older public history. Normal API financial
reads remain database/node based, real Telegram delivery remains disabled, and
the local app stays available on port 5173. The VPS database, app configuration
and services were not modified. Nothing was committed, pushed or deployed.

### Unattended capture requirements and separate retention margins

The node's retained block bodies and its usable contract state are different
resources. Collection currently uses a 600,000-block body-retention budget;
state-dependent metadata, quote conversion and native tracing use the existing
conservative 128-block operational window. A large body-retention margin does
not establish that a delayed native payout can still be traced. These budgets
are operational guards, not a promise that every historical RPC call succeeds.

`nodeOperationalReadiness` reports body, decoding, market-capture and pending
state-evidence margins separately. It preserves a temporary trace helper's
original heartbeat and expiry instead of refreshing them when the status is
read. Missing, malformed and future checkpoints remain unknown. Native tracing
is reported as private IPC, a temporary helper, or unavailable; a temporary
helper cannot establish readiness for unattended operation. The focused suite
also checks pruning boundaries, registration repairs and confirmed unavailable
trace evidence. A configured IPC path also needs a successful bounded trace
through the worker's transport; a path alone does not prove access permissions.

The local validation helper uses pinned SSH to the node's existing private IPC
and expires after its explicitly bounded run. The ordinary local worker clears
`BSC_TRACE_IPC`, so stopping that helper removes this native-trace transport.
A later production release must configure the persistent worker's permitted
private IPC access and verify it with a real trace. This local-only task does
not change node permissions, configure a tracing service, expose debug RPC, or
establish that the live VPS app is already running the replacement capture flow.

An additional read-only audit of the cloned database at approximately 18:02 UTC
on 2026-10-19 examined evidence captured since 17:16 UTC. All 32 fee-paying EOA
executions had exact gas evidence and a matching block-specific BNB/USD feed
proof. Pending multi-feed checkpoint jobs did not imply that this BNB proof was
missing. Independent market capture retained events from more than 10,000
transactions across 273 markets; more than 11,000 decoded node swap observations
belonged to transactions absent from the KOL trade table. Valuation therefore
follows genuine market activity beyond the monitored wallets' own trades.

These observations do not conceal the remaining explicit coverage limits:
some old pending market rows and quote/precision proofs are unavailable, and
new protocol or sponsored smart-account formats can require a decoder upgrade.
Raw evidence remains stored and undecoded work does not advance as completed.
Complete opening purchase history is also required for lifetime realized P&L;
monitoring a wallet today cannot invent purchases made before durable capture.

Fresh financial metadata is scheduled by its earliest usable state checkpoint,
with foreground selection only breaking equal-deadline priority. Continuous
newer blocks must not repeatedly overtake an older unattempted job until its
state is pruned. The drain now supports independently bounded precision and
feed stages over the same durable queue. Precision workers publish token chunks
without waiting for route discovery. Fixed feeds have independent leases and
retry deadlines, so slow precision cannot hide a fee valuation checkpoint and
a blocked feed cannot delay token precision. The same eight workers are divided
between three precision workers, two fixed-feed workers, two conversion workers
and one historical worker. Conversion workers reuse both completed urgent stages.
A successful handoff neither increments failure attempts
nor adds backoff. Fresh-only workers never accept already expired historical
jobs; separate historical capacity retains those proofs and their existing
backoff. The observed node head can advance the deadline horizon beyond a
lagging collection checkpoint.

The independent fixed-feed stage captures the authenticated conversion feeds needed
for native gas and trusted quote assets. Its separate durable
`pinned_feed_complete` flag survives retries and restarts, including receipts
without ERC-20 transfers. This fast path never waits for generic conversion
route discovery. Feed workers accept the handoff only after these fixed proofs
and token precision are saved; `feed_complete` still means the entire current
token dependency scope is covered. Adding another token preserves fixed feed
progress while requiring its own precision and remaining conversion checks.

Each metadata lease lasts ten seconds and renews every two seconds during live
work. Hard-stopped workers no longer leave a ninety-second lease that outlives
the node's state window. Renewals and publication recheck the current clock
after database waits; an expired owner cannot resume or clear its replacement.
Normal completion releases only its own claimed rows. No startup-wide lease
reset is used, so another healthy worker retains its ownership.

Disposable PostgreSQL regressions prove progress under continuing newer
foreground arrivals, precision progress while a feed request is blocked, no
database transaction spanning either RPC stage, and separation of pruned jobs
from the live-state budget. Partial chunks, coalesced token additions and reorg
deletion continue to use the same retained queue records. These scheduling
changes do not recover precision evidence that was already unavailable before
the fix, and never substitute current or assumed token decimals for it.

### Full-history 24-hour realized leaderboard

The leaderboard and public profile header now read the same versioned, stored
24-hour snapshot. The window selects disposals, marked external transfer-outs
and authenticated fee-only costs; it does not discard earlier FIFO purchases.
Acquisition fees follow the disposed lots, and a wallet-paid disposal or failed
execution fee is charged once. Open-position mark-to-market changes do not
enter this realized ranking. There is no separate legacy `server/pnl.ts` engine.

The worker refreshes the period rollup every thirty seconds. Its bounded
database adapter consumes the existing accounting histories and coalesced jobs;
HTTP reads do not scan receipts or call financial providers. Completed range
coverage is checked as genuine interval unions for the monitoring generation.
Publication rechecks financial evidence under short row locks, so a same-chain
trace or valuation repair cannot publish an invalidated calculation. Current
spot-price refreshes alone do not change the financial history fence.

Complete wallets can be ranked. Partial wallets are explicitly unranked; only
independently supported position contributions and known fee-only costs enter
their subtotal. Unknown opening lots, contradictory balances, incomplete
quantity coverage and ambiguous movement evidence suppress the affected
position rather than assigning zero purchase cost. Opaque historical aggregate
fee differences are never assigned to invented dates. A fully closed cycle
before the window does not contaminate a later independently proven cycle.

A fully closed imported lifetime can contribute its verified aggregate profit
and fees once when its complete movement history lies entirely inside this
period. This requires a canonical zero-balance checkpoint, empty remaining FIFO
lots, complete pagination, matching historical fingerprints and reconciled
financial totals. Open, truncated and window-straddling histories do not qualify.
EOA transaction fees covered by that aggregate are not charged again through
node fee evidence; independently authenticated smart-account operation fees keep
their separate execution identities. Aggregate fees never enter earlier replay
frames or acquire invented individual dates.

An independently confirmed zero opening balance can establish quantities for
future captured periods without completing old GMGN discovery. It does not
establish an earlier lifetime profit. Authenticated complete node history also
takes precedence over a retained imported baseline; the baseline remains a
fallback when node costs, fees, precision or payout evidence are incomplete.

Local validation includes provider-disabled PostgreSQL scenarios for older
purchase lots, transfer marks, fee attribution, partial results, atomic ordering,
public/private isolation, reorgs and publication races. The cloned database
still has gaps before durable capture began, so current wallets can truthfully
remain partial even when the accounting implementation is working. This is not
proof of complete historical production coverage or unattended VPS readiness.

Hot market decoding reads persisted precision and canonical dated quote proofs;
it does not perform route discovery or historical RPC. Bounded indexed cohorts
reserve current work, selected replay windows and newly ready `missing_quote`
rows. Independent persisted recovery cursors cycle through older evidence.
Genuine Sync-only state observations queue both asset precisions as well, while
remaining state observations with no invented trading volume or candles.

Leaderboard publication preserves PostgreSQL registration timestamp precision,
locks monitoring rows before financial histories, and permits normal forward
collection. Registration changes, repairs, reorgs and financial corrections
invalidate eligibility. A transient proof change receives bounded early retries;
the stored original observation time is retained until a valid result commits.
Monitoring verification uses nonblocking shared row locks: a concurrently
advancing collector makes publication roll back and retry, rather than waiting
while each transaction owns a different wallet row. The existing financial
fences still stay locked through publication. A concurrent PostgreSQL regression
exercises reverse wallet-lock order with the actual decode checkpoint writer.

Decoder-version and wallet-registration repairs invalidate the union of removed
and newly decoded position histories, snapshots and affected 24-hour rollups in
the same transaction. Removed fee-only executions invalidate their wallet's
rollup as well. Ordinary first decoding and current-version no-ops preserve dated
valid results. Repair failure rolls back the invalidation with the evidence;
unrelated positions and other period rows remain intact.

Canonical quote-proof lookups constrain native heights and timestamps before
merging their two indexed sources. Immutable observation inserts share the reorg
guard without acquiring the mutable market-projection lock; candles remain
serialized. This prevents repeated full quote-table scans and collection lock
waits from starving current valuations. Historical header fallback RPC occurs
before transaction start and captured hashes are checked again under the reorg
guard. A disposable regression decodes genuine swaps while the projection lock
is held and rejects newer orphan quote evidence.

Market decoding reserves bounded turns for selected history, current events
and retained recovery work. Persisted cursors advance only after examination;
separate recovery turns prevent continuous recent quote retries from consuming
the older pending/decoder-repair budget. One-row-deadline PostgreSQL tests keep
all current queues full, recreate the service between calls and still require
an older canonical observation to complete without RPC or duplicate volume.

### Latest local leaderboard and future-capture validation

The final local executable was checked against the cloned database with GMGN
credentials removed and historical imports disabled. The 2026-10-19
19:24:51–19:29:52 UTC API run retained 650 consecutive authentic headers, no
missing heights or broken parents, and three complete decoded relevant receipts.
All sampled leaderboard/profile snapshots and amounts agreed; no API errors,
stale period samples or recurring financial worker deadlocks were observed.
Leaderboard reads had a 982 ms 95th percentile during that run. Persisted GMGN
budget timestamps and import page counts stayed unchanged.

The independent final state/market audit observed 1,195 exact token proofs and
393 fixed-feed checkpoints before their 128-block state deadline, with no urgent
expiry during the five-minute run. Its mature market cohort decoded 1,368 of
1,386 genuine eligible events, with no ready-but-undecoded rows. Eighteen events
still lacked authenticated USD conversion for their quote assets (BEM/taptap and
HackiOS/GOOGLB); their raw evidence and exact precision are retained and no USD
amount is invented. All six sampled active node quotes were fresh. The separate
legacy recovery cursor advanced, but its older pending backlog was not cleared.

Validation passed 2,153 unit tests, both TypeScript projects, the production
build and twenty-one PostgreSQL integration suites. The final scheduling and
publication refinements were additionally checked in their focused PostgreSQL
regressions. An actual node-only MP4 showed -$8.44 and -11.24%, matching its
prepared modal accounting; an independent positive node case showed +$28.06.

This does not certify complete old data or production cutover. Historical
unknown costs and the retained older market backlog remain explicit; incomplete
wallet subtotals retain explicit partial labels. Local native tracing still uses the bounded
helper and cannot establish unattended production access. No commit, push,
deployment, VPS database write or VPS configuration change was performed.
