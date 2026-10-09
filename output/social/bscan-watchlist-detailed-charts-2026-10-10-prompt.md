# Detailed market charts X graphic

Generated using the built-in image_gen tool.

Edit target: `bscan-watchlist-gm-2026-10-10.png`.
Supporting data reference: `market-sparkline-reference-2026-10-10.png`.

The reference paths were rendered from actual GeckoTerminal USD close candles saved in `current-token-*.json`, paired with bscan market cap and tracked KOL volume snapshots. Values change after this snapshot. The generated artwork approximates these chart shapes for a social graphic.

## Final prompt

Use case: precise-object-edit.
Asset type: bscan X update graphic, landscape.
Input image 1 is the edit target. Input image 2 is a supporting reference containing actual current 24h market chart shapes and numeric snapshots for the four tokens in the same order.
Primary request: update ONLY the four small charts in the right-hand table of image 1 to be much more detailed, following the dense real market price paths in image 2. Preserve chronological orientation and overall shape; GM has a large step upward near the last third, 旺柴 has an irregular rising path, 中国人能飞 has a flat first half followed by a sharp rise then a plateau, TRUMAN dips in the first half then recovers with several upward steps. All four are green because their actual end prices exceed their start prices. Show many small fluctuations instead of the old 3–6 straight segments. Keep these charts neatly inside their existing compact chart cells. Do not invent candlesticks, axis numbers or extra data.
Update the MCAP numeric cells to the verified snapshot: GM "$2.32M", 旺柴 "$14.36M", 中国人能飞 "$3.30M", TRUMAN "$1.38M". Keep tracked volumes respectively "$24.66K", "$3.72K", "$7.26K", "$5.92K".
Invariants: keep the exact correct gold fingerprint bscan logo and white wordmark, near-black background, composition, typography, existing token avatars, four token names, gold stars, and all left-hand text. Preserve the thin gold connector WITHOUT a dot. Keep table column labels "Token", "MCAP", "Tracked vol.", "Chart · 24h"; keep "Your watchlist.", "A clearer view.", "Scan tokens. Compare activity.", "24h / 1 week / 1 month", "bscan.fun | NEW UPDATE". Same aspect ratio, same design. No background icon, no globe, no watermark. Image 2 is only a chart/data reference, do not insert its background or explanatory text into the poster.
