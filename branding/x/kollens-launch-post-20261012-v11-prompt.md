# Floating optical glass and requested meme coins — v11

Route: built-in ImageGen edit. Target: `kollens-launch-post-20261012-v9.png`. Supporting images: the authentic WangChai, Funds Are Safu and GREEN MORNING artwork in `references-v11/`.

## Prompt

Use case: compositing
Asset type: kollens launch post for X, landscape1672×941.
Input1 is the existing poster to edit. Inputs2,3,4 are authentic token artwork for WangChai, Funds Are Safu, GREEN MORNING.

Primary request: replace the right-side lens design with a distinctly different, refined visual and use the three requested real meme coins. Preserve the official brand and already-smaller left typography.

New optical concept: a FLOATING TRANSPARENT GLASS LENS, seen at a gentle oblique angle, with a clearly curved optical profile and delicate refraction at its edge. No opaque circular frame. No camera barrel, mechanical rings, black casing, ribbed grip, tick marks, magnifying-glass handle, jewelry-gold rim or hard circular UI outline. It is one elegantly shaped clear optical glass element, with thickness visible along one slender edge, neutral soft glass shading and a small warm-gold edge reflection. Use depth and a subtle contactless shadow to make the transparent glass feel tangible. Keep lighting diffuse and controlled: no bright specular glare, shiny chrome, gold floor glow, crystalline facets, neon bloom or excessive glossy 3D effects. The result should feel like a polished editorial visual for a wallet analytics product.

Meaningful layout: the glass hovers in front of three compact rows of onchain KOL trade activity. The rows are sharper and slightly enlarged as seen through the lens; a short continuation of the feed is gently blurred beyond the glass at far right. Let the rows and the transparent optic have a little perspective and layering, giving the scene an intentional sense of focus and depth. Keep the glass and rows comfortably separated from the headline and subtitle. Main artwork is in the right part, x=960..1660,y=140..810. Clear near-black margin after the left subtitle, no glass edge or row behind lettering.

Three rows, exact labels and authentic artwork:
1. Input2: the yellow Shiba dog emoji portrait, exact label "WangChai", green "BUY".
2. Input3: the original white smiling Wojak face on light green, exact label "Funds Are Safu", muted red "SELL".
3. Input4: the original green-tinted photographic face, exact label "GREEN MORNING", green "BUY".
Faithfully use the supplied images, without redrawing, beautifying or substituting token art. Make all full names readable, adapting thumbnail sizes and row spacing to the longer labels. Preserve simple neutral KOL avatar silhouettes, small wallet symbols and transaction arrows, and the heading "Live trades". Dark charcoal rows and flat badges, fine understated borders, clean modern typography. No fake metrics, prices, amounts, addresses, returns, extra coins or new identities.

Brand invariants: keep official small gold icon and white lowercase "kollens" upper left, large "Now live.", smaller "KOL tracking on BNB Chain." and "Wallets. Trades. Tokens.", feature line "Live trades" • "Watchlists" • "P&L" • "Replays", and bottom-left "kollens.com". Exact existing letterforms, font sizes, placement, spacing and canvas. Keep near-black backdrop and brandgold #F9C932 for brand accents, white/gray text and existing green/red trade colors. No watermarks, slogans or other text. Completely remove the previous opaque lens ring and old tokens.

## Export

`export-launch-post-v11.mjs` prefers the corrected ImageGen output, then restores and verifies the existing brand and smaller typography from v9. It places the original token PNGs directly in the illustrated thumbnail slots, resized and ellipse-clipped to match perspective, and verifies their opaque interiors. A [repair prompt](kollens-launch-post-20261012-v11-repair-prompt.md) adds clear space between the glass and subtitle. Token artwork references and verified contract identities are recorded in [sources](references-v11/sources.md).
