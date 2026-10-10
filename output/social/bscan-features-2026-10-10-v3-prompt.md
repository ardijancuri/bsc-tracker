# Correct GM avatar and table typography

Generated with the built-in image_gen tool. Edit target: bscan-features-2026-10-10-v2.png. GM photograph: the user's supplied 5d3a42a294678e0dae60c613b9585fe2_v2l.webp.

App font verified in src/styles.css and src/main.tsx: Manrope, with system sans-serif fallback for Chinese. Table headings and token names use weight 700; numeric values use regular weight and tabular numerals. The generated poster requests the same natural Manrope proportions; text is image-generated rather than deterministically typeset from the actual font file.

## Final prompt

Use case: precise-object-edit.
Asset type: existing bscan X announcement poster, same landscape resolution and aspect ratio.
Input image 1 is the edit target. Input image 2 is the authoritative correct GM token photograph supplied by the user.

Make ONLY TWO changes:
1. Replace the first row's GM circular avatar with the actual photograph from image 2. The subject is lying sideways against a pillow, green night-vision tint, glasses, open mouth. Preserve this photograph and its actual face, expression and horizontal pose. Do not redraw it as a frontal upright portrait. Crop the meaningful middle photo area out of the top/bottom black letterbox, then crop that proportionally into the existing circular avatar. Keep the circle's size and placement. Keep enough of the pillow and sideways head to recognize the supplied image. No distortion of the photo.
2. Change ALL text in the right-hand table (headers, token names, MCAP values and tracked-volume values) to the app's Manrope typeface, natural normal-width proportions, upright, NOT condensed and NOT horizontally or vertically stretched. The actual app uses Manrope at normal width, table headers weight 700, token names weight 700, numeric cells regular weight 400/500, tabular-nums. Render a faithful Manrope-style geometric sans with open counters, natural rounded bowls, comfortably readable letter widths, no skinny elongated glyphs. For Chinese token names use a normal-width modern CJK sans fallback harmonizing with Manrope, upright unstretched glyphs. Keep current table font sizes approximately 25–27px at this poster scale, headers similar or slightly smaller. If text needs space, use existing column room and modest natural sizing; never squeeze or stretch glyphs. Numerals must have natural standard width and rounded proportions. Preserve exact strings and colors:
Headers: "Token", "MCAP", "Tracked vol.", "Chart · 24h".
Rows: "GM" "$2.54M" "$24.66K"; "旺柴" "$15.73M" "$3.72K"; "中国人能飞" "$3.76M" "$7.26K"; "TRUMAN" "$1.25M" "$5.92K".
Maintain neat aligned baselines.

Invariants: preserve everything else in image 1 exactly: bscan fingerprint logo and wordmark, all left-hand text and its typography, all four token identities except corrected GM photo, other three avatars, stars, table column positions, row heights, gold connector, black background, white/gold/green colors, every small chart shape, subtle dividers, footer, margins and overall layout. Do not change numeric values, add features, add panels, change the headline, introduce candles, create larger charts or introduce additional text. The output should look like the same poster with the two requested corrections.
