# kollens — feature-based launch post directions

Generated using built-in ImageGen edits. All three final images preserve the existing official logo and launch copy, restored from v4 with `export-launch-post-v7.mjs`.

Each illustration is a conceptual representation of app features. No market prices, returns, wallet addresses or financial amounts are invented.

## 1. Live trades in focus

An optical lens frames KOL wallet activity and BUY/SELL rows.

- Final: [trade lens](kollens-launch-post-20261012-v7-trade-lens.png)
- [Exact prompt](kollens-launch-post-20261012-v7-trade-lens-prompt.md)
- [Spacing and token-marker repair prompt](kollens-launch-post-20261012-v7-trade-lens-repair-prompt.md)

## 2. Watchlist scanner

Saved-token stars, compact candlestick charts and a focused GM row represent scanning tokens without opening each one.

- Final: [watchlist](kollens-launch-post-20261012-v7-watchlist.png)
- [Exact prompt](kollens-launch-post-20261012-v7-watchlist-prompt.md)
- [Spacing and GM-icon repair prompt](kollens-launch-post-20261012-v7-watchlist-repair-prompt.md)

The GM portrait uses the project's saved token image reference, `output/social/references/gm-current.png`. The other rows use neutral token markers.

## 3. KOL performance

Three ranked wallet rows and gold, silver and bronze accents represent comparing tracked 24-hour realized P&L.

- Final: [performance](kollens-launch-post-20261012-v7-performance.png)
- [Exact prompt](kollens-launch-post-20261012-v7-performance-prompt.md)

## Reproduce final exports

Run `node branding/x/export-launch-post-v7.mjs` from the repository root. The script prefers corrected ImageGen outputs where available, exports 1672 × 941 PNGs and verifies that the native logo and copy interiors match v4 pixel-for-pixel.
