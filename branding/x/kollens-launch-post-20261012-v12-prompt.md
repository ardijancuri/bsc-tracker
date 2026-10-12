# Circular lens and short labels — v12

Route: built-in ImageGen edit. Source: `kollens-launch-post-20261012-v11.png`. Original token artwork inputs are in `references-v11/`.

## Prompt

Use case: precise-object-edit
Asset type: kollens X launch post, 1672×941.
Input1 is the exact post to edit. Inputs2,3,4 are the original token artwork for WangChai, Funds Are Safu (SAFU), and GREEN MORNING (GM).

Make ONLY these changes:
1. Replace the second row's name "Funds Are Safu" with the exact short label "SAFU".
2. Replace the third row's name "GREEN MORNING" with the exact short label "GM".
Keep the first row name "WangChai" unchanged, and retain all three trade rows.
3. Make the transparent lens glass a PERFECT CIRCLE, seen exactly straight on. Its visible outline must have equal width and height and a constant radius, with no oval or tilted perspective. Use a circular optical disc approximately600px diameter, centered around x1225,y435, clear of the left subtitle. The outermost optical edge and its inner edge must both form true concentric circles. Keep its rim continuous without cut-outs. Keep the same transparent floating glass, restrained soft gray reflections, small warm gold edge accent and subtle shadow, with no new frame, handle, camera housing, mechanical rings, tick marks or excessive shiny lighting.

Preserve the authentic token images from inputs2-4 and their neutral KOL avatars, wallet pictograms, arrows, Live trades heading, green BUY / red SELL / green BUY badges. Keep typography readable and row layout consistent. Token thumbnails may be normal circular portraits, with original artwork faithfully retained. No new tokens, prices, values, percentages or identities.
Preserve the current official gold logo and white lowercase kollens, large Now live., smaller KOL tracking on BNB Chain. and Wallets. Trades. Tokens., feature line Live trades • Watchlists • P&L • Replays, and kollens.com. Exact existing sizes, letterforms, spacing and placement. Keep1672×941 canvas and all other background, palette and design elements unchanged. No watermark.

## Export

`export-launch-post-v12.mjs` preserves the native branding and smaller typography from v11, and inserts the original token artwork into the illustrated thumbnail slots. The [geometry repair prompt](kollens-launch-post-20261012-v12-repair-prompt.md) corrects the remaining vertical elongation of the glass.
