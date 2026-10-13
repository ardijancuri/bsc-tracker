# Current Kollens brand files

## App branding

- Original supplied vector: `kollens-approved/source.svg`.
- Source preparation: `kollens-approved/prepare-source.py`; writes the four canonical white/yellow SVG variants into `public/`.
- Canonical variants: `../public/kollens-logo-white.svg`, `../public/kollens-logo-yellow.svg`, `../public/kollens-icon-white.svg`, `../public/kollens-icon-yellow.svg`.
- Build exporter: `../scripts/export-app-brand.mjs`; creates the website favicons, touch icon, social preview and replay artwork/fallback paths.

## Final X assets

- Profile: `x/kollens-approved-profile-header/kollens-x-profile-400.png` (upload), plus the 1024px master and editable SVG.
- Header: `x/kollens-market-header/kollens-x-header-centered-1500x500.png`, plus `kollens-x-header-centered.svg`; regenerate the PNG with that folder's `export.mjs`.
- Launch post: `x/kollens-launch-approved-20261012-v5/kollens-launch-post.png`.
- Launch copy: `x/kollens-launch-approved-20261012-v5/launch-post.txt`.
- Five feature posts, revised: `x/kollens-feature-series-20261012-v2/` (tighter headline spacing and varied visuals for live trades, watchlists, token details, KOL profiles, and trade replays); includes final PNGs, captions, prompts, snapshots, and the export script.
- V1 reply thread: `x/kollens-v1-thread-20261012/` (new overview image plus six numbered replies to the launch post); includes the complete thread and upload pack.
- Daily leaderboard: `x/kollens-daily-leaderboard/` (reusable five-KOL daily image, first announcement copy, dated public API snapshots, manifests and upload packs). The installed `kollens-leaderboard` skill refreshes the current rolling 24-hour rankings, exact app logo, avatars and P&L in the same template.

Each final X folder includes its export script and source/provenance files. ZIP upload packs, the superseded first feature series, and local `output/` release and preview files stay outside source control. Token images and KOL avatars used by the app are kept in place.
