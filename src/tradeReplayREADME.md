# Trade and token replay implementation

The server owns accounting and export eligibility. See [Node-owned financial data](../docs/node-owned-data.md) and [Durable evidence](../docs/node-evidence.md).

Public and authenticated Portfolio replay-preparation endpoints return one immutable accounting snapshot, its frozen ending valuation, an approved full-history window and genuine database market observations. Repeated polls join durable accounting work; browser preparation has one bounded poll loop and no legacy activity/chart retry chain. Closing a share modal cancels the subscriber and encoder without cancelling shared worker jobs.

Modern contracts use version 2 and truthful node, mixed or imported provenance. The exact ledger preserves FIFO costs, transfer receipt valuations and wallet-paid fees. Historical frame profit is realized gains plus the displayed remaining value minus remaining basis. ROI uses fee-inclusive acquisition capital. Unknown costs produce unavailable affected frames, rather than zero. Imported aggregate fee residuals apply only in the baseline/final state.

Long histories combine genuine coarse candles with a minute ending segment. Sparse coverage is disclosed, real timestamps stay intact, and a coarse interval cannot authorize a prolonged flat ending. Closed positions need historical market coverage, without a current quote. Open positions use the modal's frozen current mark. Token replays use the same market service and disclose estimated MCAP where applicable supply is uncertain.

The renderer keeps Kollens branding, canvas dimensions, colors, glow, tooltip styling and deterministic seeking/export. Sell highlights retain their badge and pulse, but do not zoom the viewport or stretch playback around large transactions. Version 2 movement groups sharing a timestamp are atomic; transfers have IN/OUT markers and preserve their movement identities. Compact estimate/final and provenance indicators accompany the result. A separately approved ending never replaces earlier unknown costs.

The pinned Mediabunny encoder produces exactly 465 frames at 30 fps over 15.5 seconds and 1080 × 1350. AVC MP4 is preferred; supported WebM remains honestly labelled. MediaRecorder is only a pre-encoding capability fallback. Abort and encoding errors dispose partial output. Save image, copy image, video download and editable social share links keep their existing behavior; no automatic social posting occurs.

Regression coverage includes source identity, exact balance agreement, private membership revisions, frozen modal/video profit and ROI, moving historical profit, transfers, same-second groups, long charts, stale tails, coalescing, cancellation and actual local MP4 inspection.
