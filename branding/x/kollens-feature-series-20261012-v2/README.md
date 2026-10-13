# Kollens feature posts — revised design

Five 1600 × 900 X post images with tighter headline spacing: the headline baseline step is 84px for 88px Manrope text, reduced from 101px.

## Visual directions

1. **Live KOL trades:** a gold activity timeline connects real trades by Afeng, Tavern, 0xAA, and Cupsey. Their original app avatars are prominent, with token artwork and names beneath them.
2. **Watchlists:** a saved-token board with a bookmark, favorites, authentic token artwork, weekly mini charts, and market caps.
3. **Token details:** the circular lens focuses on an actual token chart and metrics.
4. **KOL profiles:** a wallet profile card links to its traded tokens.
5. **Trade replays:** layered replay frames and a playback rail surround the supplied Afeng/BIBI app replay image.

The logo, gold-and-charcoal palette, and Manrope font follow the approved launch design. Images 1, 2, 4, and 5 use new native ImageGen backgrounds; image 3 retains its original lens background. Exact foreground content is composed with SVG, font outlines, and Sharp. Each post's generation prompt is saved alongside its PNG, and the complete prompt set is in `PROMPTS.md`.

## Publishing files

Use the retained PNG and caption files directly:

| Post | Image | Caption |
| --- | --- | --- |
| Live KOL trades | [01-live-trades/post.png](01-live-trades/post.png) | [01-live-trades/post.txt](01-live-trades/post.txt) |
| Watchlists | [02-watchlists/post.png](02-watchlists/post.png) | [02-watchlists/post.txt](02-watchlists/post.txt) |
| Token details | [03-token-details/post.png](03-token-details/post.png) | [03-token-details/post.txt](03-token-details/post.txt) |
| KOL profiles | [04-kol-profiles/post.png](04-kol-profiles/post.png) | [04-kol-profiles/post.txt](04-kol-profiles/post.txt) |
| Trade replays | [05-trade-replays/post.png](05-trade-replays/post.png) | [05-trade-replays/post.txt](05-trade-replays/post.txt) |

`posts.md` contains all five captions. Every caption fits X's 280-character limit. These files have not been posted to X. The duplicate ZIP upload pack was removed.

## Source content

The saved public app snapshot was captured on 12 October 2026. It includes real trades, market figures, charts, and KOL statistics. Original token images and KOL avatars are preserved in `shared/`.

- The live-trades image was refreshed from the public trade API with four distinct tracked KOLs: `@aa_AFeng`, `@TurtleTavernTV`, `@0xAA_Science`, and `@Cupseyy`. The exact transactions, UTC dates, amounts, original names, and source URLs are saved in `shared/live-kols-snapshot.json`. The displayed English alias Afeng comes from the roster's name `阿峰_Afeng`. Chinese token names use the app's Microsoft YaHei fallback; this installed Windows font is outlined at export and is not redistributed.
- The watchlist examples are WangChai, SAFU, and GM, with actual available weekly candle closes and returned market caps.
- The KOL example is 0xLuck, with tracked 24-hour realized P&L and unmatched sales explicitly excluded.
- The replay example is the supplied **Afeng/BIBI** app replay, dated **12 October 2026** and received on 13 October 2026. The entire supplied image is preserved, including its original avatar, chart, trade markers, logo and displayed **+$1,578.01 realized P&L / +102.43% realized return**. Only its display size changes to fit the existing frame. The source image and provenance are retained as `shared/afeng-bibi-trade-replay.png` and `shared/afeng-bibi-source.json`. The earlier clukz card stays available for the V1 overview, which still depicts that example.
- Logo and Manrope font files are copied from the app's approved assets; the font license is included.

`manifest.json` records dimensions, hashes, caption lengths, generation route, and headline spacing. All five final images were visually inspected for text alignment, safe spacing, and correct placement of app content.

## Re-export

From the repository root:

```powershell
node branding/x/kollens-feature-series-20261012-v2/export-series.mjs
```

To export one post, append its folder name, for example `02-watchlists`. The exporter uses saved native backgrounds, source snapshots, Sharp, and Fontkit at `.cache/launch-font-tools/node_modules/fontkit`.

The current Afeng portrait card uses the supplied PNG directly; no reconstruction or new image generation is needed. The prior CryptoCharming source and its exporter are retained as historical source files and are not consumed by the current export.

The live-trade foreground uses an installed Windows font at `C:/Windows/Fonts/msyh.ttc` for Chinese token names. To refresh these four KOL trades and original artwork again, run `node branding/x/kollens-feature-series-20261012-v2/refresh-live-kols.mjs` before exporting.
