# Optic Fold refinement

Meaning: A folded optical ribbon combines the trader and token views in one lens.

The native ImageGen source and exact generation prompt are retained as `95-optic-fold-generated.png` and `95-optic-fold-prompt.md`.

The production SVG redraws the generated folded ribbon geometry using clean straight runs and quadratic curves. It preserves the rising main band, upper left return, lower band, right return, angular aperture, and subtle K relationship. Band widths were regularized, hairline fold cuts were opened into comfortable gaps, and the lower return was simplified. Raster speckles and lighting variations were removed by defining native vector geometry in one exact flat color, `#F9C932`.

The production canvas is 128 × 128; all geometry stays within the specified 10..118 bounds. The PNG is rendered directly from the SVG with a transparent background.
