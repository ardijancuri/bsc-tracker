# kollens launch post — v5

Route: built-in ImageGen edit.

Edit target: `kollens-launch-post-20261012-v4.png`.

## Prompt

Use case: precise-object-edit
Asset type: kollens X launch post, landscape 1672 by 941 pixels.
Input image 1 is the edit target. Replace ONLY the visual artwork on the right side. Keep the entire left side, the official small logo at top left, all typography and exact existing words, colors, placement, sizes and the near-black background unchanged.
Primary request: create a different visual on the right, replacing the oversized gold lens symbol completely with an elegant abstract network of tracked wallet activity.
New right-side artwork: a sophisticated sculptural network of fine gold signal paths, a few gold connection nodes and dark graphite floating geometric planes. A clear, dynamic diagonal flow connects different points through space, like observing transactions across a live network. Use depth, precise geometry, very subtle warm reflections, and restrained detail. Compose the visual in the rightmost 40 percent of the canvas, with the main shapes to the right of x=1000; keep left typography unobstructed. Let a few thin paths extend toward the edges. This should be a premium, distinctive brand illustration, not a product dashboard.
Palette: the same exact kollens gold #F9C932 with charcoal and near-black, white belongs to existing text only. Preserve the current subtle dark background texture.
Invariants: the top-left logo and all original copy must remain exactly unchanged: "kollens", "Now live.", "KOL tracking on BNB Chain.", "Wallets. Trades. Tokens.", "Live trades", "Watchlists", "P&L", "Replays", "kollens.com".
Remove the giant gold lens symbol on the right. Do not introduce another big logo, fingerprint, globe, sphere, central bullseye, concentric circular motif, large solid gold disc, new text, token names, mock financial data, or UI cards. Keep the left side clean and the overall composition polished and spacious.

## Export

The original logo and text regions are restored from v4 after generation with soft background edges. Their interiors are checked pixel-for-pixel against v4. Final canvas: 1672 × 941. Reproduce with `node branding/x/export-launch-post-v5.mjs`.
