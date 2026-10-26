# WPC discovery repair and local recovery

This work is local and uncommitted. Production, existing local databases and
the canceled timed validation are unchanged. The preview uses port 5174 with
API 3306 and the separate `kollens_tempo_wpc_20261025_192724` database on 5436.

## Failure and correction

Tempo's wallet `0x8168b8af46261bccbaa673c2f86bd78153c47bc6` was monitored and
its original receipts were collected. WPC
`0xd4d12753850347694c40b329b58706484713c6ea` was deployed through CREATE2 in
an unrecognized factory transaction. The previous boolean launch check treated
an absent launch fact as exclusion. It marked the receipts done without
creating financial events. The BSC connection itself had not missed them.

The decoder now distinguishes eligible, proven excluded and discovery pending.
Supported target-linked swaps and explicit paid acquisitions/outgoing actions
with unresolved token discovery stay in durable receipt repair. Unknown
approval/failed-action gas remains unattributed, rather than being declared an
excluded token's expense. Unsolicited incoming distributions do not become
trades or start a false repair. Official v4 swap recognition also verifies the
target's signed raw amount against a single canonical manager swap.

There is one bounded discovery job per token in the existing jobs table. It
stores references and first/last progress, not trade histories. The independent
stage yields to capture; failure never approves unknown accounting. Exact
creation receipts/full CREATE traces or canonical adjacent code-birth states
can authenticate a launch. The state-birth proof labels a same-block mint as a
witness when the actual creation transaction is unknown. Pool creation alone,
default precision and current metadata cannot establish historical eligibility.
Positive contract code at the original boundary can instead establish an old
token exclusion, with the original boundary and GANG exception unchanged.

The optional `FRESH_DISCOVERY_ARCHIVE_RPC_URL` is server-only and unset by
default. Missing node history without an explicitly configured proof source
remains visibly pending. This is not a promise that every unknown factory can
be verified from the VPS node's short state window. The change guarantees that
qualifying unknown activity is retained for repair instead of silently skipped.
Future receipts use the new logic immediately. No broad decoder-version bump
or historical financial rebuild is used; older already-done omissions require
a finite audit/requeue such as the six exact WPC contexts below.

Public profile and leaderboard accounting return null while discovery is
pending. The profile displays “Token verification pending” instead of a ready
zero-trade result. Its pending badge respects the active public scope,
registration block/time and monitoring bounds, so earlier private activity
cannot leak. Worker discovery health is included as an aggregate status.

## Finite WPC evidence and recovery

The authenticated deployment is block 129752966 at 2026-10-25 18:23:24 UTC,
transaction `0xc0245dafec886b4b92450fe57c9615572b44900c8a0bafc593e786eda27605b8`.
Canonical parent code is empty; birth code is 13,095 bytes. The complete
transaction-bound CREATE2 frame at path `[2,0]` returns that exact runtime.
This supplies an actual creation fact, rather than a token-specific exception.

The original VPS receipts supply two buys and two sells. Two existing target
blocks already held precision/supply and dated BNB/USD evidence; bounded
archive reads recovered those exact inputs for the other two blocks. Optional
current name/symbol enrichment is separate from every historical amount.
The existing receipt settlement helpers prove native purchase expense and
sale proceeds; current prices or full transaction-value guesses are not used.
Both approvals retain their authentic attributable gas. No GMGN wallet/P&L
request was used. GMGN only supplies genuine chart/replay candles.

| UTC time | Side | WPC quantity | BNB amount |
|---|---|---:|---:|
| 18:24:46 | Buy | 1,217,562.257276083 | 0.1 |
| 18:25:36 | Sell | 608,781.128638041 | 0.090534848440781476 |
| 18:27:09 | Buy | 31,713.192055297 | 0.005 |
| 18:27:43 | Sell | 640,494.320693339 | 0.084101188487357319 |

Ordinary FIFO persistence added six compact events: four swaps and two approval
fees. Ending quantity is zero. Exact realized profit after all six gas fees is
`51.48569388966672523256305` USD; total gas is `0.0843912137851752` USD. The
profile, stored rolling leaderboard and selected trade modal agree exactly.
The original clone capture at block 129761481 independently confirms zero
balance using that block's state, rather than a later balance. All four trade
MCAPs use their authentic v4 swap state, exact supply and dated BNB/USD evidence.

The closed replay prepares from five genuine candles with profit above and ROI
`0.661932501414409922617928292830141647`. Actual Save video produced a
7,203,769-byte MP4. Playback and frozen-ending verification are retained with
the local preview artifacts under `.cache/tempo-wpc-live/`.

The downloaded MP4 played to its 15.5-second ending at 1080 × 1350, showing
`+$51.49` and `+66.19%`, equal to the modal. The signed replay manifest also
validated after preparing on the final local runtime. A separate read-only
VPS-node check proved the authenticated WPC v4 market supplies a valid current
price/MCAP with decimals 9. That later quote was deliberately not written into
the older static snapshot or used for its historical profit.

## Preservation and validation

The initial read-only production export is retained privately. Every original
3,548 financial row, 7,823 transaction/receipt body and expiry, 21 settings-table
digest and the start block 129627586 match after recovery. Only six financial
events and one compressed creation receipt were added. The imported recovery
events are marked silent; no real Telegram/X message, production mutation,
commit, push or deployment ran. No snapshots, balance histories or new domain
tables were introduced.

Tests cover genuine v4 linkage, fake/unrelated swaps, private/incoming activity,
old versus unknown contracts, proof/code/chain mismatches, lease ownership,
concurrency, reorgs, cancellation, cooldowns, bounded retries and preserved raw
evidence. PostgreSQL lifecycle and privacy fixtures are rollback-only. Final
unit, TypeScript, build and feature results are stored in
`.cache/release/tempo-recovery/`; evidence containing accounts or signed replay
objects is under the denied `.cache/fresh/private/tempo-wpc-20261025/` directory.

Final validation: 4,058 tests passed, zero failed, two opt-in cases skipped
across 239 test files; both TypeScript projects and the production build passed.
Eight rollback-only discovery PostgreSQL lifecycle groups and five rollback-only
public/private visibility checks passed. Twenty actual profile reads had p95
about 150 ms; the private Portfolio route returned 401 without authentication.
The initial full run's three outdated clock-query fixtures and its report were
retained; only their mocks changed, preserving the original timing assertions.
