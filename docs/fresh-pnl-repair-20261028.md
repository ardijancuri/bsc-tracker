# Live rolling P&L repair, 28 October 2026

Current display policy: the user approved the separately labeled
`omit_unknown_costs_v1` fallback on 28 October. Incomplete recorded results may
be shown and ranked as **Estimated**, without replacing unknown financial
amounts or certifying exact ROI. The strict-readiness discussion below describes
exact accounting; it does not prohibit this explicit fallback. See
[the v1.4 release notes](releases/v1.4-pnl-replays-20261028.md).

The leaderboard and public profile read the same stored rolling totals in
`fresh.kols`. Normal page reads do not replay the ledger or call a financial
provider. Economic-event application and scheduled window expiration maintain
the totals. A pending total is not ranked as a complete realized result; an
approved estimated projection has its own value and visible quality label.

The recurring incident had several independent causes:

- The immutable Fresh start block outlived the owned node's retention. Discovery
  required its header from that node even after receiving the exact archived
  header. The exception now applies only to that initialized number/hash/time,
  including the RPC client's authenticated null-result error. A conflicting
  owned header still rejects the proof.
- A new receipt could update a token-discovery job while its worker was checking
  proof. Safe monotonic reference updates now merge; identity, lease, revision
  and canonical changes still reject stale work.
- Continuous new work starved due historical repairs. Three fresh-first passes
  now alternate with one due-repair-first pass, retaining the existing backoff,
  receipt bounds and whole-block commits.
- Nested acquisition proofs returned by PostgreSQL JSONB changed object key
  order. Recursive canonical serialization now recognizes the identical proof
  while rejecting changed nested values.
- Some actual native settlements and acquired-quote purchase paths were not
  recognized. Shared decoders now verify the original signed route, complete
  trace, actual wallet/asset movements, fees and returned change. The route-9
  three-leg controller path uses the approved actual acquisition-cost policy;
  it does not price retained change through a peg or a current quote.
- A genuine ERC-20 family stores decimals in immutable slot 6. Its canonical
  birth already commits the full audited runtime. Recovery now proves the
  runtime's storage/getter behavior and checks a raw canonical getter response
  under that same code. It does not assume 18 decimals from a symbol, factory,
  current token row or a later token with similar bytecode. This verifier
  conservatively excludes same-block birth/target consumers.
- Historical quote recovery must use the genuine authenticated pool's fee.
  The registered stock quote bridge can try the supported 0.25% and 1% routes;
  retained proofs replay their original fee. Original canonical swaps, the
  two-minute source limit, complete log bounds and the native conversion leg
  remain mandatory.

Full-code evidence also identified two nonledger emitter families. Finite,
audited corrections marked four false transfer interpretations noncanonical;
their original rows and receipts remain retained. No symbol or deployer
heuristic authorizes this exclusion.

The existing 72-hour original-evidence policy remains. Unresolved receipts now
retain compact expiry identity, checksum and dependency diagnostics in their
existing decode job when the raw body expires. This does not turn an expired
gap into approved coverage. Permanent financial facts are not expired.

## Approved realized trading policy

The user subsequently approved `sales_fifo_fees_v2`: realized sales less original
FIFO purchase costs and charged fees. Transfers consume or carry inventory and
do not create realized income. Observed transfer values remain financial facts;
a missing optional transfer mark is not a missing sale. Actual unknown sale
proceeds, consumed purchase costs and fees remain unknown.

Estimated trading profit is realized profit plus current remaining value minus
remaining FIFO cost. Unsold lots with unknown basis do not hide a fully known
realized result; they still prevent an approved estimate or ROI where required.
The existing acquisition-capital denominator and unknown incoming basis remain
explicit. Private internal transfers retain the original lots and their costs.

The finite policy cutover reprojects existing event results and current position,
daily and rolling totals, retaining facts, quantities and open lots. The old
financial writer stops before handoff. The new single worker keeps capture and
urgent state/trace collection running while its other stages wait for a complete
`accounting:realized_policy` checkpoint. New API readers withhold old-policy
profit during this short transition. Ordinary advancing capture does not change
the financial plan; the original canonical floor, start and reorg revision are
still checked, and the atomic application briefly locks its capture checkpoint.
Initializing a genuinely empty Fresh database creates its policy checkpoint;
running initialization against an existing database does not migrate or reset it.
Scope correction epochs invalidate leases prepared under the earlier policy.

Only independently authenticated pure transfers can finish decoding without a
market value. Unsupported execution, missing settlement, precision, fee or
receipt evidence cannot use that completion path. Missing historical costs,
unsupported routes and expired coverage remain explicit. No market price is
manufactured, the canceled timed trial is not restarted, and the tracking
boundary is unchanged. Account/settings preservation and live stored-total
equality are checked separately from decoder regression tests.

A shared, scope-specific readiness predicate also distinguishes an optional
transfer-price repair from missing financial facts. It requires a canonical
receipt/header, authenticated complete execution dependencies, every own-book
event result and charged fee, and no unpromoted buy/sell. Unknown actual sale
proceeds or consumed costs still block readiness. The receipt warning, original
payload, unknown incoming basis and repair job remain unchanged. Opaque receipts
cannot use this predicate. Leaderboard, profile positions, Portfolio and balance
scheduling use this same rule; they do not calculate historical P&L on reads.

Urgent inbound dependency capture also retains a valid completed incoming method
call when the ordinary decoder finishes first. This closes the capture race for
later trades in that token, without changing financial interpretation, trace
priority, the one-request budget or the twelve-second evidence window. Original
diagnostics and receipt status remain intact.

## Shared router and market recovery

A later router implementation upgrade caused fresh OpenID purchases to lose
their cost despite complete captured executions. Controller acquisition proof
now binds the entry and callback implementation to the same authenticated call
tree instead of pinning an implementation address. All native, token, pool,
commission, approval and returned-change checks remain closed. One optional
32-word all-`ff` calldata suffix is accepted only with the complete signed input
and the exact canonical settled route. Arbitrary trailing data is rejected.

Split native purchases across official Uniswap v4 and Pancake Infinity CL pools
use exact pool keys, returned packed deltas, official Swap events and delivered
wallet quantities. They still require complete original execution evidence and
the existing dated native-price evidence; unrelated movements remain pending.

Registered quote conversion can recover a genuine, hook-free v4/USDT market
observation before the execution, with an independently authenticated dated
USDT/WBNB leg. It retains exact canonical positions and a two-minute age bound.
It uses neither a peg nor a current price for historical accounting. Nested
JSONB ordering cannot discard an otherwise identical retained proof, while
changed identity, quantities, costs or evidence still fail validation.
