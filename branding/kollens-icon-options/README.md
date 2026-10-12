# Kollens icon options

Three original SVG concepts using the existing brand gold #F9C932 and rounded strokes. Transparent backgrounds, no embedded raster images, no visible lettering.

1. **Lens:** concentric optics with three iris arcs and a center point.
2. **KOL focus:** a person centered in a rounded focus frame.
3. **Signal lens:** an abstract eye surrounding a lens.

Each SVG uses a 128 × 128 viewBox and scales without losing quality. These are options for selection; Balanced offset optic (46) is currently being previewed in the local app header.

## Second round

Four additional native SVG variations based on the preferred Lens and KOL focus directions:

4. **Iris frame:** a lens iris inside a rounded square housing.
5. **Open lens:** circular optics with an open rim and a tracking point.
6. **KOL lens:** a person within two curved lens arcs.
7. **KOL spotlight:** a person cut out of a solid lens inside focus corners.

All use exact #F9C932, transparent backgrounds and no visible letters. `comparison-round-2.png` presents the four options together. The PNGs are previews; the SVGs are the native source files.

Initial visual exploration used built-in imagegen. Following the user's SVG/no-letter request, the final options were constructed as native vector paths and circles. No imagegen output is embedded in the SVG files.

## Third round

Five more exploratory native SVG concepts:

8. **Human aperture:** a person formed in negative space inside an iris.
9. **Linked lenses:** two interwoven lens rings.
10. **Wallet lens:** an optical center inside a rounded wallet.
11. **Orbit lens:** a lens surrounded by a tilted, open orbit.
12. **Shared focus:** two people viewed through a single lens.

These retain exact #F9C932, transparent backgrounds, rounded strokes and no visible lettering. `comparison-round-3.png` compares the five.

## Fourth round: abstract optics

Following rejection of the previous directions, this round moves to three abstract optical marks without people, wallet outlines, or literal lettering:

13. **Optical cut:** a rounded diamond with an oblique lens-shaped void.
14. **Ribbon lens:** three bent optical ribbons around an open center.
15. **Light prism:** a faceted housing with an offset optical cut.

Native SVGs with transparent backgrounds and exact #F9C932. `comparison-round-4.png` compares these three. `16-flow-focus.svg` is an unselected intermediate exploration.

## Fifth round: variations of the preferred abstract marks

17. **Twin optic:** two optical voids in a rounded diamond.
18. **Folded iris:** four rounded folds surrounding an open optical center.
19. **Prism focus:** a focal diamond inside an open hexagonal lens frame.
20. **Split prism:** a refracting lens shape with two outgoing cuts.

All are native transparent SVGs using exact #F9C932, with no visible letters. `comparison-round-5.png` shows the four options.

## Sixth round: lens, KOL focus and ribbons

Based on the user's preferred directions (01, 02 and 14):

21. **Iris lens:** folded aperture ribbons inside a lens rim.
22. **Focus iris:** a segmented iris framed by rounded focus corners.
23. **Portrait iris:** a KOL portrait inside an optical reticle.
24. **Ribbon focus:** three flowing aperture ribbons around a focal point.

The four SVGs use exact #F9C932 and transparent backgrounds, with no visible letters or embedded images. `comparison-round-6.png` shows the four together.

## Seventh round: more lens options

25. **Soft shutter:** five rounded aperture blades around an open center.
26. **Offset optic:** two open optical rings and a focal point.
27. **Folded lens:** four bent ribbons forming a rounded square aperture.
28. **Focus orbit:** four rotating focus corners around a lens ring.

These are native SVGs using exact #F9C932 with transparent backgrounds and no visible lettering. Each also has a `-header.svg` lockup using the existing kollens wordmark and header proportions. `comparison-round-7.png` shows the large icons and 30 px header previews. The comparison uses a dark background for viewing; the source icons and lockups are transparent. Rebuild the previews with `node branding/kollens-icon-options/render-round-7.mjs`.

## Eighth round: K + lens

Following the user's request to derive a lens from the letter K, these concepts intentionally introduce K geometry:

29. **K optic:** a rounded K inside a circular lens rim.
30. **K cut lens:** the K is a transparent cutout through a gold optical disc.
31. **Open K lens:** a curved K shares its strokes with an open lens rim.
32. **Shutter K:** three rounded aperture ribbons suggest the K.

All four are native transparent SVGs with exact #F9C932. The cutout in 30 uses a vector mask, with no embedded bitmap. Each includes a `-header.svg` lockup with the existing kollens wordmark; `comparison-round-8.png` presents icons and 30 px header previews. Rebuild with `node branding/kollens-icon-options/render-round-8.mjs`.

## Ninth round: the K as shutter geometry

The user requested K-derived lenses closer to Soft shutter, with the K's structure forming the lens itself:

33. **Forked shutter:** three curved segments, each with two inward branches inspired by the K.
34. **K ribbon iris:** flowing curved stems and branches surrounding an aperture.
35. **Split K lens:** the K's stem and diagonal arms bend into three optical ribbons.
36. **K fold shutter:** four repeated curved forks around a larger central opening.

All use exact #F9C932 and transparent native SVGs. Each includes a matching `-header.svg` lockup. `comparison-round-9.png` shows the icons and 30 px header previews. Rebuild with `node branding/kollens-icon-options/render-round-9.mjs`. These remain exploration files; Offset optic (26) is the local header preview.

## Tenth round: K as the space between lens blades

This round uses broader, simpler blades and a clear optical opening. The K's stem and diagonals define the spaces between the blades:

37. **K aperture:** a straight stem gap and two diagonal openings.
38. **Folded K:** curved stem geometry and rounded optical folds.
39. **K flow:** an asymmetric stem gap with swept diagonal folds.

These are native filled vector paths with rounded corners, transparent backgrounds and exact #F9C932. No masks, filters or bitmaps are embedded in the final SVGs. Each has a matching `-header.svg`; `comparison-round-10.png` includes 30 px header previews. Rebuild with `node branding/kollens-icon-options/render-round-10.mjs`.

## Eleventh round: flowing K ribbons

Fresh silhouettes explored with built-in ImageGen and reconstructed as smooth native vector paths:

40. **Wrap optic:** the K's arms wrap around an offset optical opening.
41. **Swept iris:** broad flowing ribbons create a shutter with a subtle K structure.
42. **Ribbon K optic:** three curved K strokes define the lens opening themselves.

Final SVGs use exact #F9C932 with transparent backgrounds. No source bitmap, gradient, mask or filter is embedded. `comparison-round-11.png` includes the large icons and existing wordmark at 30 px header size. Original generated references are preserved in `round-11-sources/`; prompts are recorded in `round-11-prompts.md`.

`vectorize-round-11.py` reads the reference alpha outlines and exports `round-11-contours.json`. `render-round-11.mjs` fits cubic paths using `fit-curve` and renders the SVGs and previews. The development helper dependency lives in the ignored `.cache/vector-tools/`; install it with `npm install --prefix .cache/vector-tools fit-curve --no-save --no-audit --no-fund` if needed. The final SVGs work independently of these helpers.

## Twelfth round: defined optical geometry

The user requested cleaner, more defined shapes:

43. **Geometric shutter:** six precise aperture blades around a hexagonal opening, with circular outer arcs and consistent gaps. Its straight and diagonal joints echo the K construction.
44. **Open K optic:** one circular optical stroke folds into two K-inspired diagonals around a focal point.
45. **Focus shutter:** a geometric aperture inside four consistent rounded focus corners.

Native transparent SVGs with exact #F9C932; no raster images or effects are embedded. Each has a `-header.svg` lockup and a PNG preview. `comparison-round-12.png` includes 30 px header previews. Rebuild the geometry with `python branding/kollens-icon-options/create-round-12.py`, then render with `node branding/kollens-icon-options/render-round-12.mjs`. Offset optic (26) remains the local header preview.

## Thirteenth round: Offset Optic spacing

This round refines the preferred Offset optic (26). The new arcs are exactly centered at (64, 64), with radii 48 and 24. Both rings have the same stroke weight, and the center point's radius is half that weight, producing matching radial gaps:

46. **Balanced:** 14-unit strokes, 7-unit center dot, 10-unit clearances.
47. **Airy:** 12-unit strokes, 6-unit center dot, 12-unit clearances.
48. **Bold:** 16-unit strokes, 8-unit center dot, 8-unit clearances.

The opening angles preserve the original Offset Optic direction. `comparison-round-13.png` compares the original with all three refinements and 30 px header lockups. All SVGs are transparent and use exact #F9C932. Rebuild with `node branding/kollens-icon-options/render-round-13.mjs`. Balanced (46) is being previewed in the local header; the public app has not been deployed with this change.

## Fourteenth round: square versions of Balanced

49. **Rounded square optic:** the two circular arcs become open rounded squares with matching corner construction.
50. **50% corner optic:** the bottom-left corner uses a radius equal to half its square's side: 48 units on the outer 96-unit square and 24 units on the inner 48-unit square.

Both retain 14-unit gold strokes, a 7-unit center dot, exact #F9C932, transparent backgrounds and 10-unit gaps between the nested contours. The normal corners use radii 34 and 10 to keep the outlines parallel. Each has a matching `-header.svg` lockup and PNG preview. `comparison-round-14.png` compares the two at large size and 30 px header size. Rebuild with `node branding/kollens-icon-options/render-round-14.mjs`.

## Fifteenth round: defined square outline, circular lens

51. **Square lens:** a square outer outline with 20-unit rounded corners, longer straight sides and a right-hand opening centered vertically.
52. **50% corner:** the same outline with its bottom-left corner enlarged to 48 units, half the 96-unit square's side.

Both retain the approved Balanced icon's circular inner arc, 7-unit center dot, 14-unit strokes and exact #F9C932. The backgrounds are transparent. Each includes a matching header lockup and PNG preview. `comparison-round-15.png` shows the two large icons and 30 px header previews. Rebuild with `node branding/kollens-icon-options/render-round-15.mjs`.

## Sixteenth round: all layers square

53. **Square layers:** both open outlines are squares with smaller rounded corners, and the central circle becomes a 14-unit rounded square.
54. **50% corner:** all three layers are square with a 50% bottom-left corner: radii 48, 24 and 7 for side lengths 96, 48 and 14.

Both use exact #F9C932 and transparent native SVGs, with 14-unit strokes on the two outlines. The regular corners use radii 16 on the outer square, 8 on the inner square and 3 on the center. Each includes a header lockup and PNG preview. Rebuild `comparison-round-16.png` with `node branding/kollens-icon-options/render-round-16.mjs`.

## Seventeenth round: rounded inner cutouts

55. **Rounded corners:** square layers with visibly rounded inside and outside corners.
56. **50% corner:** the same rounding improvement, retaining 50% bottom-left corners on all three layers.

The inner outline's centerline radius increases to 13 units. With a 14-unit stroke, its interior cutout now has a 6-unit radius, rather than the previous nearly square 1-unit radius. The outer cutout has a 9-unit radius, and the center's regular corners have a 4-unit radius. Exact #F9C932, transparent native SVGs. Each includes a header lockup and PNG preview. Rebuild `comparison-round-17.png` with `node branding/kollens-icon-options/render-round-17.mjs`.

## Eighteenth round: supplied K references with lenses

Four original SVG directions inspired by the user's supplied focus frame, curved K, diagonal stripe K and split K references:

57. **Focus lens:** rounded focus brackets surround an optical opening whose left edge is a K-inspired angle.
58. **Curved K:** a curved K body forms one side of the lens, with an opposing optical arc and focal point.
59. **Diagonal lens:** parallel diagonal strokes connect to a lens in the K junction.
60. **Split K lens:** a diagonal spine separates the upper K fork from a lower arm shaped as a half lens.

All are native transparent SVGs with exact #F9C932. No reference image pixels are embedded. Each has a matching header lockup and PNG preview. `comparison-round-18.png` includes 30 px header-size previews. Rebuild with `node branding/kollens-icon-options/render-round-18.mjs`.

## Nineteenth round: the lens opening within the K

Fresh forms explored with built-in ImageGen, then reconstructed as native SVG curves:

61. **K aperture:** a rounded upright and diagonal arms share a circular optical opening.
62. **Diagonal aperture:** angled components form a K around a lens opening at their junction.
63. **Curved aperture:** a broad spine and two curved arms define the central optical counter.

The final icons use exact #F9C932, transparent backgrounds and compound vector paths, preserving lens openings as transparent space. No bitmap, filter or mask is embedded. Each has a header lockup and PNG preview; `comparison-round-19.png` includes 30 px header previews. Source generations are retained in `round-19-sources/`, and prompts are in `round-19-prompts.md`.

To reconstruct, run `python branding/kollens-icon-options/vectorize-round-19.py`, then `node branding/kollens-icon-options/render-round-19.mjs`. The latter uses the development helper dependency `fit-curve` in `.cache/vector-tools/`, as documented in round 11. Final SVGs do not depend on those helpers.

## Twentieth round: K with a shared lens frame

Three original directions inspired by the supplied focus-frame K, square K monogram and circular K references:

64. **Square K optic:** the K arms share the rounded square optical frame.
65. **Open K lens:** K strokes join a circular lens rim with an opening on the right.
66. **Focus K lens:** the K spine integrates the left focus corners, balanced by two right focus corners.

Following the user's refinement, the center circular counters are removed from 65 and 66. All final icons use exact #F9C932, native vector paths and transparent backgrounds. Each has a PNG preview and header lockup. `comparison-round-20.png` shows the three concepts and 30 px header previews. Built-in ImageGen source explorations are retained in `round-20-sources/`; the prompts and final refinement are recorded in `round-20-prompts.md`.

Reconstruct with `python branding/kollens-icon-options/vectorize-round-20.py`, then `node branding/kollens-icon-options/render-round-20.mjs`. The renderer applies the requested circle removal. No app assets are replaced by this exploration.

## Twenty-first round: clean geometric K lenses

67. **Open optic K:** a precise circular lens rim joins a straight K spine and rounded diagonal arms, leaving a broad opening on the right.
68. **Square focus K:** a rounded square housing and K share their edges. Straight rails, circular corner fillets and a small triangular counter replace the irregular traced curves from the previous square direction.
69. **Shutter K:** a solid K silhouette uses two curved optical blades as its arms. There is no separate outer ring or central opening.

All three are authored directly as native SVG geometry in exact #F9C932, with transparent backgrounds and no center circle or dot. Each includes a PNG and header lockup. `comparison-round-21.png` includes 30 px header previews. Generate the deliverables with `node branding/kollens-icon-options/render-round-21.mjs`; no raster tracing or ImageGen is used for this round. App branding is unchanged.

## Twenty-second round: retry with the supplied references

Fresh built-in ImageGen explorations using the original focus-frame, square-monogram and circular-optic references:

70. **Square aperture K:** a square lens housing shares the K strokes, with two diagonal breaks in the frame.
71. **Curved focus K:** the curved left lens housing forms the K spine, with a solid central junction and two straight arms.
72. **Focus frame K:** the K spine joins the left focus corners, paired with two compact right focus corners.

Final exports are transparent native SVG paths in exact #F9C932, without a central circle, dot or pupil. Source generations are retained in `round-22-sources/`, and the prompt set is in `round-22-prompts.md`. Each icon includes a PNG and header lockup. `comparison-round-22.png` includes 30 px lockup previews. The vector fitting preserves angular corners and samples straight runs to keep edges straight.

Reconstruct with `python branding/kollens-icon-options/vectorize-round-22.py`, then `node branding/kollens-icon-options/render-round-22.mjs`. App assets are unchanged.

## Twenty-third round: option 70 with equal widths and a separate left frame

Three native geometric refinements of the user's selected Square aperture K:

73. **Balanced:** 14-unit frame and diagonal widths, with an 8-unit gap between the left rail and the rounded K joint.
74. **Light:** 12-unit widths, with a 10-unit gap.
75. **Bold:** 16-unit widths, with a 7-unit gap.

The left rail is separate from the inner K in every option. The 45-degree diagonal edges use perpendicular offsets to match the horizontal and vertical frame widths. Outer and inner frame corner radii share centers, maintaining the same width around the rounded corners. All final files are transparent native SVGs in exact #F9C932, with no center circle or dot. Each includes a PNG and header lockup, and `comparison-round-23.png` includes small header previews.

Rebuild with `node branding/kollens-icon-options/render-round-23.mjs`. This is a native vector refinement of option 70; no new ImageGen generation is used. App assets are unchanged.

## Twenty-fourth round: refined bold option

76. **Refined bold:** the user's selected option 75 with larger inner frame corners and a straight lower-right K arm.

The frame corners use 5-unit inner radii and 21-unit outer radii, retaining the 16-unit frame width. The lower K diagonal runs directly to its terminal cap, removing the small horizontal step. The separate left frame and 7-unit gap remain. This is a transparent native SVG in exact #F9C932, with a PNG preview and matching header lockup. `comparison-round-24.png` shows the refined icon and wordmark. Rebuild with `node branding/kollens-icon-options/render-round-24.mjs`.

## Twenty-fifth round: rounder frame corners and corrected spacing

77. **Rounded frame:** a refinement of option 76 with 8-unit inner frame radii and 24-unit outer radii, preserving the 16-unit width through both corner curves. The upper-left end and the upper K-to-rail junctions use sharp corners as requested. The lower-right rail extends to give a 7-unit perpendicular gap beside the lower K arm; the lower-left diagonal gap also measures 7 units. The housing is slightly wider to allow the larger right inner curve, and the exported mark is centered in its 128-unit viewBox.

The SVG is transparent and uses exact #F9C932, with a PNG and header lockup. `comparison-round-25.png` shows the updated mark and wordmark. Rebuild with `node branding/kollens-icon-options/render-round-25.mjs`.
