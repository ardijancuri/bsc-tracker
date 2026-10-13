# Kollens V1 feature thread

Six replies to the existing Kollens launch post. Reply 1 introduces V1; replies 2–6 explain each feature. Reply to the previous post each time to keep everything in one continuous thread.

| Reply | Image in ZIP | Caption in ZIP |
| --- | --- | --- |
| 1/6 · V1 overview | `01-kollens-v1.png` | `01-kollens-v1.txt` |
| 2/6 · Live KOL trades | `02-live-trades.png` | `02-live-trades.txt` |
| 3/6 · Watchlists | `03-watchlists.png` | `03-watchlists.txt` |
| 4/6 · Token details | `04-token-details.png` | `04-token-details.txt` |
| 5/6 · KOL profiles & P&L | `05-kol-profiles.png` | `05-kol-profiles.txt` |
| 6/6 · Trade replays | `06-trade-replays.png` | `06-trade-replays.txt` |

`thread.md` contains the full copy in posting order. Every reply fits X's 280-character limit. The thread has not been posted to X.

## Overview design

The overview is 1600 × 900 and follows the approved Kollens campaign: exact current SVG logo, brand gold, Manrope font, dark app backdrop, and restrained smoked-glass panels. Its feature list covers live KOL trades, watchlists, market-cap charts and token details, KOL profiles, tracked 24-hour P&L rankings, and shareable trade replays.

The feature labels use a two-column, three-row layout with consistent icon alignment and spacing. Every right-side card title is inside its own container, with space reserved above the card content.

The right side contains actual saved app examples:

- Afeng's BIBI buy and 0xAA's okt sell, with original avatars, token images, amounts, and UTC times.
- WangChai, SAFU, and GM, with genuine recorded weekly candle closes and returned market caps.
- 0xLuck's tracked 24-hour realized P&L, with matched and excluded sales identified.
- clukz's actual GM replay, rendered by the app from its complete 18-fill record.

The opener names every KOL and token visible in this overview. Feature replies explain the app's functions, with token and wallet examples in the relevant captions.

Figures are point-in-time examples from the existing public app snapshot, captured on 12 October 2026; the GM replay uses actual fills from 29 September 2026. Data and original artwork are referenced from the retained sibling folder `../kollens-feature-series-20261012-v2/shared/`.

Reply 6 was revised on 13 October 2026 to use the supplied **Afeng/BIBI app replay**, dated 12 October 2026. Its original pixels, chart, logo and trade markers are preserved. The matching caption identifies **@aa_AFeng**, **BIBI**, and the supplied image's **+$1,578.01 realized P&L (+102.43%)**. The overview still uses the original clukz example, so its opener names remain accurate.

## Generation and export

One new background plate was created with the built-in ImageGen tool. The native image's panels were kept empty; exact logo geometry, font glyphs, artwork, chart data, and the actual app replay card were composed with SVG and Sharp. No trade, chart, financial result, or endorsement was generated. The native prompt is saved in `generation-prompt.md`.

Native source: `C:/Users/PC/.codex/generated_images/01a0deed-e93b-7573-9540-7d96188a7440/exec-d3eb47c6-6ec6-42e9-b00b-21f8c275c52b.png`. A durable copy is saved as `background.png`.

Re-export from the repository root:

```powershell
node branding/x/kollens-v1-thread-20261012/export.mjs
```

The script uses Sharp, Fontkit at `.cache/launch-font-tools/node_modules/fontkit`, and the app's saved Manrope fonts. `manifest.json` records the generation route, source snapshot times, exact logo and image hashes, and reply lengths. The final composition was visually inspected for layout and readable feature labels.
