# Layered matte optical lens — v10

Route: built-in ImageGen edit. Source: `kollens-launch-post-20261012-v9.png`.

## Prompt

Use case: precise-object-edit
Asset type: kollens launch post for X, 1672×941.
Input is the selected matte lens post. Refine this existing design; do not redesign the poster.

Primary request: the current single flat circular lens is too simple. Give it richer, believable optical construction and depth while preserving the calm matte finish. Aim for the middle ground between a flat UI circle and an excessively shiny fantasy object.

Right-hand object: a proper detached optical lens with a slightly angled perspective, a clear curved front element, and a short visibly layered housing. Use two or three carefully spaced concentric structural edges of matte graphite, one narrow satin brand-gold inlay #F9C932, and a small amount of fine machined ribbing on the visible side of the housing. Subtle engraved focus ticks are fine, without words or numerical specifications. The outer barrel has real thickness and quiet texture. Avoid ornate jewelry details. Keep the front glass visually clean, with soft studio reflections and subtle edge refraction. Give the glass a gentle sense of depth and magnification, but keep all coin names and trade badges crisp. A soft diffuse shadow behind the lens can separate it from the background.

Composition: keep the lens on the right, slightly move it farther right so the layered housing has room and does not overlap the left copy. Main optical assembly should fit roughly x=930..1630,y=110..790. Make it feel substantial and finely made. The trade feed continues softly out of focus in the far-right background, and becomes sharp through the lens, emphasizing kollens focusing on KOL wallet trades. Keep just the existing three rows. This connection should feel deliberate, not like an unrelated mechanical ornament.

Materials and lighting: graphite and understated brushed gold accents, neutral broad diffuse light, restrained surface detail, a few soft gray reflections. Enough shading to read the layered construction, no blazing gold highlights, chrome, crystalline facets, bloom, neon outlines, excessive gloss, glowing ground reflections or decorative floor texture. No magnifying-glass handle, camera body, globe, random network, ribbons or extra UI panels.

Exact content invariants:
Preserve the real token artwork and labels already present: GM green portrait with GM and green BUY; yellow Chinese logo with 币安人生 and red SELL; MUBARAK cartoon with MUBARAK and green BUY. Keep neutral KOL avatars, wallet icons, arrows, heading Live trades. Do not add invented figures or new coins.
Preserve official top-left icon and white lowercase kollens, large Now live., already-smaller KOL tracking on BNB Chain. and Wallets. Trades. Tokens., feature line Live trades • Watchlists • P&L • Replays, and kollens.com. Keep their font sizes, letters, placement and spacing unchanged. Same canvas and black/gold palette with existing green/red badges and token artwork. No extra wording or watermark.

## Export

`export-launch-post-v10.mjs` prefers the corrected ImageGen output, then restores and verifies the existing official branding and smaller typography from v9. The [repair prompt](kollens-launch-post-20261012-v10-repair-prompt.md) refines layout clearance and token-artwork fidelity. Token identities and artwork remain based on the source references in `references-v8/sources.md`.
