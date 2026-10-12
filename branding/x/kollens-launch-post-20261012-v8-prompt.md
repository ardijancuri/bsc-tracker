# Refined magnifying-glass launch post — v8

Route: built-in ImageGen edit with the selected v7 live-trade lens image and three authentic token artwork references.

## Prompt

Use case: compositing
Asset type: refined kollens X launch post, landscape 1672 by 941 pixels.
Input roles:
Image 1 is the selected launch post to edit. Images 2, 3 and 4 are authentic token artwork to insert, respectively GM (green-tinted man's face), 币安人生 / Binance Life (yellow Chinese typography on black), and MUBARAK (the cartoon character dressed in white). Use these exact references faithfully; do not invent coin logos or replace them with generic symbols.

Primary edit: refine the selected optical-lens concept into an unmistakable handheld MAGNIFYING GLASS. Keep the luxurious black-and-gold appearance, but make the form cleaner: a fine polished gold rim, clear dark optical glass, believable slight magnification, restrained reflections and a substantial dark handle with gold metal edging. The handle extends diagonally down-right from the rim, fully visible, making the magnifying-glass silhouette obvious. Do not show a hand. Main circular glass is around x=1290,y=400, approximately 520px diameter; keep all new artwork to the right of x=1000 and the handle within x=1660,y=870. Avoid collisions with the left copy. Keep all three trade rows sharply visible through the glass, with subtle feed blur outside it restricted to the far right.

Trade feed refinement:
Preserve the heading "Live trades" and three compact dark trade rows, clean spacing, refined thin borders.
Each row shows: small neutral KOL avatar silhouette, tiny wallet icon, subtle arrow, real token thumbnail with its readable name, and BUY or SELL badge.
Row 1: image 2 token artwork, exact name "GM", green "BUY".
Row 2: image 3 token artwork, exact name "币安人生", muted red "SELL".
Row 3: image 4 token artwork, exact name "MUBARAK", green "BUY".
Size thumbnails and names to fit comfortably inside the glass; no crowding or clipping. Do not use Ethereum/Bitcoin/BNB icons, substitute logos, Token A/B, or generic yellow coin markers. No financial amounts, prices, marketcaps, profit figures, wallet addresses or invented KOL identities. This is a conceptual illustration of the app's trade feed.

Typography preparation for exact final native composition:
Keep the official top-left gold icon and white lowercase "kollens" unchanged, and keep the large "Now live." unchanged.
Clear ONLY the two existing subtitle lines "KOL tracking on BNB Chain." and "Wallets. Trades. Tokens." from the area x=55..980,y=430..625, restoring uninterrupted near-black background there. These two exact lines will be restored from the original in final export at 85% of their previous size, so do NOT render any replacement text in that area.
Keep the original feature line "Live trades" • "Watchlists" • "P&L" • "Replays" and bottom-left "kollens.com" unchanged. Keep the canvas, layout, subtle textured background, native logo color #F9C932 and white typography. No added slogans or watermarks. All edits are confined to the right illustration and the two subtitle lines that need smaller final typesetting.

## Final export

`export-launch-post-v8.mjs` restores native logo and original copy. It scales the two subtitle lines to 85% of their original size and prefers the corrected ImageGen output. Token references and verification sources are recorded in [sources](references-v8/sources.md). The [repair prompt](kollens-launch-post-20261012-v8-repair-prompt.md) refines the illustration's size, placement and full handle visibility.
