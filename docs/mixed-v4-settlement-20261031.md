# Mixed V2/V3/V4 execution repair — local, October 31

CryptoCharming's GANG transaction
`0x99038d7f2dd6e5b2dc1fae0be5f1b0b183ff84e1dab3234fc1fd8d7a769bdc93`
was captured with its complete private-IPC trace about four seconds after block
130557825. It was not a missing block or missing trace. The older decoder
rejected the mixture of PCS V2/V3 and three official Uniswap V4 swaps.

`mixedV4Settlement.ts` now validates these ordinary single-target wallet
executions through one shared proof, including purchases and sales. It matches
canonical logs to successful trace calls and returned deltas, authenticates PCS
pool addresses by their deployed CREATE2 formulas, authenticates V4 pool keys,
and reconciles every target-token movement. Arbitrary router names, forged
Swap topics, unsupported hooks and wallet reentry do not approve a trade.
The previous native-buy helper delegates to this shared validator.

This proof supplies no price, fee, acquisition basis or profit. The existing
dated native/quote valuation and FIFO accounting remain authoritative. Existing
repair jobs retry receipts after release; late insertions use the existing
locked scope rebuild and stable execution identities. No new trading tables,
snapshot writes or retention-policy changes were introduced. New unsupported
protocols remain explicit repairs, rather than approved guessed values.

The retained public transaction/trace is a compressed regression fixture.
Offline normalization recovers exactly 1,394,663.19949007314267573 GANG for
5 BNB, using the original block's $703.90623 BNB/USD observation. The purchase
is $3,519.53115; gas is a separate $0.08396470808861593292289.

A read-only live export of 73 existing GANG financial records reproduced the
stored position exactly. Adding the recovered purchase in memory yielded
3,266,000.704404748186215933 GANG, exactly matching the independently checked
node balance at confirmed block 130859390. No production financial writes were
made. Recovered event identity is stable on repeated normalization.

Tests cover the original five-pool transaction, prior native split fixtures,
ordinary quote-settled sales, refunds, false token returns, forged pool keys,
changed deltas/quantities/recipients, missing/reverted calls and wallet reentry.
Evidence and reports are under `.cache/gang-replay-diagnosis-20261031/`.
The source fix was validated locally before release. Production replay preparation
remains pending until the authorized release processes its repair
and refreshes the confirmed balance. No claim of a production or MP4 check is
made by the offline accounting validation.
