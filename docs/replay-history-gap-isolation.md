# Token replay isolation from older wallet gaps

Implemented and validated locally on October 30, 2026. The subsequent v1.5 release
request authorizes deployment with the existing database, trades, accounts and
settings preserved. The canceled validation campaign remains stopped.

## Shared eligibility rule

`positionGapCoverage.ts` replaces the blanket wallet-gap predicate used by
current-position reads, balance scheduling/commit, public position responses
and signed replay revision validation. This applies to every accounting scope;
existing public/private membership filters remain in their callers.

An expired-history gap is irrelevant only when its complete retained compact
expiry journal starts at the wallet's original gap marker and every relevant
missing receipt through the selected cutoff precedes the token's authenticated
creation. A creation certificate is required; names, suffixes, pool dates and
unverified launch timestamps cannot establish existence. Same-block gaps remain
relevant. Later gaps beyond a frozen replay cutoff do not invalidate that cutoff.

Unknown/unbounded registration gaps, malformed journal references, contradictory
earlier token facts, current pending receipts/trades, missing costs and actual
balance mismatches keep their existing accounting restrictions. An eligible
new token still requires an exact balance at a canonical captured block.

The existing protocol/creation certificate survives routine header expiry.
Retained canonical birth/parent headers, when present, must agree. Start/capture
lineages must agree, and reorg-invalidated creation facts cannot authorize a
replay. No new tables, financial-response snapshots, financial totals or accounting
policy are added.

For legacy wallets without a complete old expiry journal, the upgraded maintenance
writer records one shared `coverage:position_gap_journal` checkpoint at a committed
capture block. It conservatively bounds all earlier gaps; only tokens created
after that bound can use it. Later expired receipts remain individually checked
through the selected cutoff. The current maintenance health must identify the
upgraded journal writer. Routine polls retain the marker, and a reorg invalidates
an orphaned anchor. This metadata is neither a tracking reset nor financial approval.

## Preventing recurrence

Normal completion/expiry removes ordinary receipt-repair jobs but preserves an
already existing compact `expiredEvidence` reference. It marks that repair done
without deleting the original identity or error stored in its manifest. This
prevents a completed repair from making an older bounded history gap unbounded
again. The wallet marker is not cleared and no historical cost is invented.

Replay preparation returns a terminal historical-evidence status for a remaining
durable wallet gap, instead of polling indefinitely.

## Local evidence

The live database was exported read-only to a separate PostgreSQL instance at
127.0.0.1:5439, database `kollens_replay_gap_20261029`. Existing databases were
not reset or deleted. Local artifacts are under `.cache/replay-gap-local-20261029/`.

0xDavid (`0x7a2363a401b2340c7941dd2eeff0196a5078d2e6`) / ZERODAY
(`0x75d5c2e31ef374f92b201c06d83e2d98368c7777`) has 12 recorded buys,
32 sells and 32 fee events. The selected source refresh preserved all 76 facts.
Its original expired gap precedes the token's authenticated Flap creation.

The local balance worker matched 2,053,989.757564302463126955 tokens at canonical
block 130558609. Preparation completed in approximately 365 ms with 37 genuine
GMGN candles and a valid manifest. Independent stored event results reproduce
realized profit of 2908.4267995413203629192049263791078658 USD.

The actual 10,228,020-byte, 1080 × 1350, 15.5-second MP4 was generated and played
to its ending. Its frozen total profit of 3203.861081299952597696794845455964996614
USD and ROI of 6.001696539229722187467409667368258409 match the modal.
These are dated observations, not current market prices.

`positionGapCoverage.integration.ts` and `balanceScheduling.integration.ts` run
rollback-only TEMP fixtures, including concurrent expiry/reorg/membership changes,
bad certificates, real mismatches, frozen cutoffs and expiry-journal retention.
Regression runners and preservation hashes are retained beside the artifacts.

The final suite passed 5,371 tests (two skipped), both TypeScript projects and the
production build. The four rollback-only PostgreSQL runners passed 144 checks.
All 37,732 cloned financial facts, their P&L inputs and 40,109 original receipt
bodies retained their preservation hashes.
