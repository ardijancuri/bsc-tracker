# Chart overlay design QA

final result: passed

## Scope and visual truth

This is a scoped update to the existing Kollens chart, preserving its authenticated market data, app typography, branding, controls, and replay accounting. The requested visual change is a single uninterrupted price chart with translucent volume at the bottom, following the supplied GMGN example. It does not copy another token's price path, supply, indicators, or wallet annotations.

- Source visual truth: `C:/Users/PC/AppData/Local/Temp/codex-clipboard-d72836b9-295f-43e4-b52b-2d4963d28939.png` (1280 × 462).
- Earlier Kollens state: `C:/Users/PC/AppData/Local/Temp/codex-clipboard-44d49b68-06e9-408b-be57-4edd8a68ae2f.png` (1275 × 653).
- Desktop implementation: `C:/Users/PC/Documents/ChatGPT/kolscan-bnb/.cache/v14-gmgn-chart-release/local-overlay-desktop.png` (1280 × 720).
- Trade-modal implementation: `C:/Users/PC/Documents/ChatGPT/kolscan-bnb/.cache/v14-gmgn-chart-release/local-overlay-modal.png` (1280 × 720).
- Mobile implementation: `C:/Users/PC/Documents/ChatGPT/kolscan-bnb/.cache/v14-gmgn-chart-release/local-overlay-mobile-viewport.png` (390 × 844).

The mobile capture is the real token route inside a 390 × 844 CSS-pixel iframe, not a recreated mobile mock. Its unscaled viewport was cropped from the larger browser screenshot in `local-overlay-mobile.png`; the empty surrounding desktop canvas is excluded. Desktop and modal captures use the 1280 × 720 browser viewport. No density upsampling was used for the implementation evidence.

## Comparison evidence and state

Both the source and rendered implementation were opened before review. They were then placed together and inspected in these combined comparison artifacts:

- Full chart comparison: `C:/Users/PC/Documents/ChatGPT/kolscan-bnb/.cache/v14-gmgn-chart-release/chart-overlay-comparison.png`.
- Focused lower-chart comparison: `C:/Users/PC/Documents/ChatGPT/kolscan-bnb/.cache/v14-gmgn-chart-release/chart-volume-focused-comparison.png`.

The full comparison crops the desktop chart/legend to 1221 × 483 and proportionally fits the 1280 × 462 source to the same comparison column. The focused comparison proportionally normalizes the lower chart regions to at most 600 pixels wide. These crops compare pane structure, volume placement, grid continuity, axis separation, and chart typography. The source contains Laura's 1m market history; the desktop implementation contains genuine SAFU 5m candles, the mobile route uses SAFU 1m, and the trade modal shows the existing Quack market. Price-path and numerical differences are intentional data differences, not targets to reproduce.

## Findings and iteration history

1. **[P1, fixed] White draggable divider split price and volume.** The earlier Kollens screenshot has a separate volume pane and a conspicuous white horizontal separator. The shared component now adds the histogram to the existing candle pane on its own `volume` price scale. Volume occupies the bottom 20%; candle scaling reserves the lower 24%. Pane resizing is disabled. The desktop, mobile, and modal captures all show one continuous grid without that divider.
2. **[P2, checked] Overlay must remain independent from price scaling.** The histogram has a distinct overlay price-scale ID and no price line or last-value label. The focused captures show the actual dollar/MCAP axis remains the candle axis, with volume contained at the bottom. No synthetic candles or volume were introduced.
3. **[P2, checked] Shared layout must work in the narrower trade modal and mobile viewport.** Both actual captures retain readable candle/axis content and bottom volume without recreating a second pane or covering persistent chart controls. Existing mobile legend wrapping is retained.

No actionable P0, P1, or P2 chart-layout differences remain after the implementation captures were compared with the reference. Sparse historical observations are still truthful data limitations; this QA pass does not claim that a visual change creates missing market history. Their recovery and availability remain covered by the separate chart-import and replay preparation tests.

## Required fidelity surfaces

- **Fonts and typography:** Existing Manrope chart/legend typography and adaptive price precision are retained. Small axis labels remain readable on desktop, modal, and mobile. GMGN's distinct typography and token annotations are not substituted for the Kollens identity.
- **Spacing and layout rhythm:** One pane replaces two. Volume is confined to the bottom portion; the price grid continues through it. Existing chart heights, legend spacing, time axis, and responsive layout remain consistent with the app.
- **Colors and tokens:** Existing dark background, subdued grid, green/red candles, and translucent green/red volume remain consistent across both chart consumers. The removed white separator no longer interrupts the dark chart.
- **Image quality and asset fidelity:** Existing token artwork, Kollens branding, and TradingView attribution are retained. Charts remain genuine interactive financial series, not rasterized substitutes or decorative approximations. No new image assets were required.
- **Copy and content:** Existing OHLC, volume, timestamps, cached-state, and honest limited-history notices remain. No provider prices, token names, or wallet annotations were copied from the visual reference into unrelated token data.

## Functional verification

- The actual local token chart switched from 1m to 5m correctly.
- Dragging/panning the actual chart worked; hover/crosshair updated the legend.
- Existing viewport and chart tests preserve zoom/pan through real history updates.
- Actual desktop, mobile, and trade-modal captures show the shared overlay layout.
- Browser errors reported during the verification: none (`[]`).
- Focused chart/viewport suites: 62 passing tests. Both TypeScript projects passed after the component change.

## Implementation checklist

- [x] Use one pane for candle and volume series.
- [x] Keep independent volume scaling and disable pane resizing.
- [x] Preserve actual OHLC, timestamps, volume, chart controls, and replay visuals.
- [x] Verify desktop, mobile, and shared trade-modal rendering.
- [x] Inspect full and focused combined source/implementation comparisons.
- [x] Keep the local app available for further inspection.

Follow-up polish: none required for this scoped chart-layout update.
