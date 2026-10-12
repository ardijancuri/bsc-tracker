# Matte lens refinement — v9

Route: built-in ImageGen edit. Source: `kollens-launch-post-20261012-v8.png`.

## Prompt

Use case: precise-object-edit
Asset type: refined kollens X launch post, 1672×941.
Input image is the edit target.

Primary request: return the right-hand object to a LENS with NO handle, and make the whole visual calm, matte and much less shiny. Keep the concept of real KOL wallet trades seen in focus through the lens. Preserve the actual token thumbnails, names, BUY/SELL badges, branding and the already-smaller subtitle typography.

Remove the magnifying-glass handle, its gold connector, and all its shadows completely. Remove the glossy gold floor reflection and the embossed decorative ground texture. Restore a quiet near-black matte background behind and below the artwork.

Replace the ornate reflective rim with a single clean optical lens: a simple dark graphite circular housing with a slim flat brand-yellow accent #F9C932, approximately 5px thick. Matte anodized surface, understated fine grain, barely any bevel, diffuse lighting. Clear glass with only one extremely soft broad reflection, no visible facets or crystalline planes. No chrome, polished jewelry metal, blazing edge highlights, bloom, halos, specular glints, gold glow on the floor, dramatic lighting or glossy 3D product rendering. Make it look like an art-directed editorial product graphic, crisp, restrained and credible.

Keep the lens on the right, roughly x=950..1580,y=140..770, with clear separation from all left text. Do not enlarge it into the copy. Inside it, retain the existing three compact live-trade rows, neutral avatar and wallet symbols, simple arrows, authentic token artwork:
GM green portrait + exact name "GM" + green "BUY";
authentic Chinese yellow token icon + exact name "币安人生" + red "SELL";
authentic MUBARAK cartoon icon + exact name "MUBARAK" + green "BUY".
Keep "Live trades" above the rows. The rows should have plain charcoal surfaces, fine gray borders and flat badges; no shiny bevels. Keep all names and icons readable. Optional background feed blur stays subtle and restricted to far right.

Invariant: preserve the exact small official gold logo and white "kollens" at top left, large "Now live.", smaller "KOL tracking on BNB Chain." and "Wallets. Trades. Tokens.", the feature line "Live trades" • "Watchlists" • "P&L" • "Replays", and "kollens.com". Keep their text, font sizes, placements and spacing identical to the input. Do not change the token identities or add figures. No new words, no watermark. Keep original canvas and black/gold brand palette; existing token colors and green/red trade badges remain.

## Export

`export-launch-post-v9.mjs` restores the existing native brand and smaller subtitle text from v8. Canvas: 1672 × 941. Token source references are preserved in `references-v8/sources.md`.
