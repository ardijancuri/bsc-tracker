# Kollens token details background plate

Method: native built-in ImageGen. One initial edit and one focused panel geometry repair. No raster resizing or other image editing applied after ImageGen.

## Inputs

- Edit target: C:/Users/PC/Documents/ChatGPT/kolscan-bnb/branding/x/kollens-launch-approved-20261012-v5/key-visual-source.png
- Composition/style reference: C:/Users/PC/Documents/ChatGPT/kolscan-bnb/branding/x/kollens-launch-approved-20261012-v5/kollens-launch-post.png

## Initial prompt

Use case: precise-object-edit
Asset type: empty raster background plate for Kollens token-details and market-cap-chart feature post, wide 16:9, desired 1600 x 900 pixels.
Input images: Image 1 (key-visual-source.png) is the EDIT TARGET. Image 2 (kollens-launch-post.png) is ONLY the approved composition, dark glass, and muted gold style reference. Do not retain or create any foreground copy, logo, token images, charts, numbers, or symbols from Image 2.

Primary request: Preserve the edit target's wide, dark charcoal/glass/gold composition and its perfectly circular large glass lens on the right. Keep a quiet, EMPTY near-black left half for later typography. Replace the THREE existing blank horizontal token panels inside the lens with exactly ONE empty flat wide dark chart/detail panel. The new panel has a subtle restrained charcoal edge and soft corner radius; it contains no content whatsoever.

Composition/geometry: At 1600 x 900 final coordinates, lens center is approximately x1140, y415 and radius330. Its circular silhouette, placement, smooth concentric rings and full uncropped perimeter must match the reference. The ONE dark panel is approximately x904,y284,width472,height330; front-facing, flat, wide rectangular, clean and empty, with no perspective rotation or diagonal edges. Use these proportions at the native output resolution. The left half remains empty, quiet and near-black.

Background outside lens: an extremely heavily blurred chart-and-token-details application interface in dark charcoal, only soft indistinct UI blocks and faint green/red hints. No readable chart shapes, data, text, labels or numbers anywhere. Preserve soft background blur and glass surface quality.

Materials/light: transparent dark glass with subdued reflections, a smooth thin muted gold circular outer rim and delicate concentric charcoal/glass rim. Keep all circles smooth and continuous. Restrained ambient gold only, without a bright lower-rim shine or gold pool.

Constraints: Change only the three inner panels into one empty chart/detail panel and adapt background to the heavily blurred token-detail UI. Preserve lens geometry, dark color mood, soft glass and wide composition. No foreground text, axis labels, logo, token images, line graphs, candles or financial numbers: exact real content will be composited later.
Avoid: cracks, kinks, diagonal strokes/lines, floor, contact shadow, gold bounce pool, bright lower-rim shine, neon, lens flare, readable UI, extra panels, foreground content, watermark.

## Focused repair prompt

Use case: precise-object-edit
Input image: the attached generated plate is the EDIT TARGET.
Make ONLY ONE geometry correction: resize/reposition the single empty dark detail panel inside the lens. Keep all other pixels/composition as closely unchanged as possible.

On this native 1672 x 941 canvas the panel must have bounds approximately left945, top297, width493, height345 (right1438, bottom642). This corresponds to x904,y284,width472,height330 on a 1600x900 final image. The new panel is TALLER than the existing one while slightly narrower. It remains a front-facing flat dark charcoal blank rectangle with subtly rounded corners and a very thin restrained charcoal-gray edge. No gold frame around the inner panel. No content.

Keep invariant: the exact existing perfectly circular glass lens, its center/scale/placement, full perimeter, thin muted gold concentric rim, glass highlights, blurred dark background, and entirely empty near-black left half. Preserve the background as softly blurred token-detail UI with only faint green/red hints. No text, axis labels, logos, token images, charts, candles, line graphs, numbers, symbols, floor, contact shadow, gold bounce pool, bright lower-rim shine, neon, lens flare, diagonal lines, cracks, kinks, extra panels or watermark.

## Outputs

- Initial native output: C:/Users/PC/.codex/generated_images/01a1316e-1c8e-75a3-923f-b22d34d8e51f/exec-5597a277-b45a-4671-8a64-533e92f6513b.png
- Selected repaired native output: C:/Users/PC/.codex/generated_images/01a1316e-1c8e-75a3-923f-b22d34d8e51f/exec-33605a52-bcfa-41a6-9924-cd8af9fb9e69.png
- Saved plate: C:/Users/PC/Documents/ChatGPT/kolscan-bnb/branding/x/kollens-feature-series-20261012-v2/03-token-details/background.png
- Native dimensions: 1672 x 941.
- Observed selected panel approximate native bounds: x980, y259, width446, height355. At 1600x900 this is approximately x938, y248, width427, height340. The model did not follow the requested panel bounds exactly, so the compositor should align real chart content to the actual panel or cover the panel with its exact dark content panel. Circle remains full and smooth; no foreground content.
