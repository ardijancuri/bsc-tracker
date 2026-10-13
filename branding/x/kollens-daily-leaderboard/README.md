# Kollens daily leaderboard template

The reusable daily design uses a smaller exact current Kollens logo, Manrope, the same black market-grid background as the X profile header, authentic KOL avatars, and gold/silver/bronze filled rows for the top three. Fourth and fifth place have no background fill or border. Large, centered rows display wallet names and handles, trade counts and tracked 24-hour realized P&L. There is no outer board or frame. The only foreground content outside the rows is the logo and kollens.com; headings, promotional copy, dates, table headers and footnotes have been removed from the image.

Rows are 1272 x 112px with 72px avatars. First place uses a stronger gold fill and thin gold outline without a separate left accent. P&L amounts are bold 46px (50px for the leader), aligned to the vertical center of their rows using the font's glyph bounds. The renderer fits long amounts within the reserved column. The logo is 232px wide.

The installed skill is `C:/Users/PC/.codex/skills/kollens-leaderboard/SKILL.md`. The portable skill and template are packaged as `kollens-leaderboard-template.zip`. The current design is an editable native SVG template. Daily refreshes reuse the original grayscale market grid, decorative price line and candles embedded in `../kollens-market-header/kollens-x-header-centered.svg`, scaled to the leaderboard canvas at 40% opacity over black. The skill bundles this exact artwork and its source hashes. Exact foreground content is composed deterministically with SVG glyph outlines and Sharp.

## Generate another daily post

```powershell
node C:/Users/PC/.codex/skills/kollens-leaderboard/scripts/generate.mjs --project C:/Users/PC/Documents/ChatGPT/kolscan-bnb
```

For an announcement that says the leaderboard will be posted every day, append `--announcement`. Normal runs produce a dated daily caption. New outputs are stored under `YYYY-MM-DD/snapshot-HHMMSS/` using Europe/Skopje time. Each folder contains a publishable PNG, a self-contained SVG, X text, the API snapshot, original avatars, a provenance manifest, the Manrope license and `post-pack.zip`.

Append `--top 3` to show only the first three eligible ranks in the image and caption. The displayed row group stays centered; the default remains five.

Three-rank posts use larger 168px rows, 24px gaps and 96px avatars, with 56px P&L (60px for first place). Names, ranks and trade counts scale up with the rows. Five-rank posts retain the existing 112px layout.

The caption mentions the top five when it fits X's 280-character limit; otherwise it uses the top three. Handles and figures come directly from the same snapshot used by the image. The complete original names remain in the source JSON; decorative emoji are omitted from rendered name labels when necessary for font support. Chinese glyphs use installed Microsoft YaHei, which is not redistributed.

## Source and time window

The source is the public `https://kollens.com/api/leaderboard`, alongside `/api/overview` for the calculation time. The app reports rolling last-24-hour P&L from positions bought and sold within that window. Sales with missing prices or purchase costs are excluded. This is tracked P&L, not a claim of complete wallet performance or final calendar-day results.

The caption identifies the figures as tracked 24h realized P&L. Source JSON and the manifest retain the date, snapshot time, rolling 24h period and exclusion rule. The image preserves API order, excludes inactive or unranked wallets, and never fills missing values with zero. Rankings are wallets; identities with several wallets are not merged. The generator stops if live data is stale, unavailable or has an unexpected contract.

The first announcement was captured on 13 October 2026 at 01:10 UTC+2. It features `@hzjxhcyy`, `@aa_AFeng`, `@XIGUA0903`, `@0xyukaz`, and `@888upupup`. Its exact figures and hashes are saved alongside the PNG.

The retained exports are the original announcement in `2026-10-13/snapshot-011044/` and the latest three-rank design in `2026-10-13/snapshot-234209-header-bg-subtle/`. The latter reuses the recorded 23:42 snapshot with the current 40%-opacity header background; it is not a newly fetched ranking. Earlier plain, full-strength and 70%-opacity variants of that same snapshot were removed during cleanup.

To re-export a recorded snapshot, pass `--snapshot` with its absolute `source.json` path and optionally `--out`. Keep its original date and values. This workflow creates local drafts; it does not schedule daily generation or publish to X.
