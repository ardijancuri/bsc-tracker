"""Compose a custom K with real Manrope 800 outlines and optical spacing."""
from pathlib import Path
import importlib.util
import json
import re
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / '.cache' / 'wordmark-font-tools'))
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

spec = importlib.util.spec_from_file_location('wordmark_layout', ROOT / 'branding' / 'kollens-wordmark-options' / 'outline-wordmarks.py')
layout_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout_module)
layout_module.TEXT = 'ollens'

def number(value):
    return f'{value:.6f}'.rstrip('0').rstrip('.') or '0'

font_file = ROOT / 'node_modules' / '@fontsource' / 'manrope' / 'files' / 'manrope-latin-800-normal.woff'
font = TTFont(font_file)
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
names = [cmap[ord(letter)] for letter in 'ollens']
tracking = -0.022
positions, kerning_method, adjustments = layout_module.layout(font, names, tracking)

letter_l_bounds = BoundsPen(glyphs)
glyphs[cmap[ord('l')]].draw(letter_l_bounds)
ascender_top = letter_l_bounds.bounds[3]
baseline = letter_l_bounds.bounds[1]
# A small outline expansion matches the reference's heavier lettering while
# preserving the native circular counters and flat crossbar geometry.
outline_expansion = 3
font_scale = (160 - 2 * outline_expansion) / (ascender_top - baseline)
text_bounds_pen = BoundsPen(glyphs)
for name, (x, y) in zip(names, positions):
    glyphs[name].draw(TransformPen(text_bounds_pen, (1, 0, 0, 1, x, y)))
xmin, ymin, xmax, ymax = text_bounds_pen.bounds

padding = 8
k_width = 145
ink_gap = 8
text_ink_x = padding + k_width + ink_gap
text_origin_x = text_ink_x - xmin * font_scale + outline_expansion
text_baseline_y = padding + outline_expansion + ascender_top * font_scale
canvas_width = text_ink_x + (xmax - xmin) * font_scale + 2 * outline_expansion + padding
canvas_height = padding + (ascender_top - min(ymin, baseline)) * font_scale + 2 * outline_expansion + padding

paths = []
for letter, name, (x, y) in zip('ollens', names, positions):
    pen = SVGPathPen(glyphs, ntos=number)
    glyphs[name].draw(TransformPen(pen, (font_scale, 0, 0, -font_scale, text_origin_x + x * font_scale, text_baseline_y - y * font_scale)))
    paths.append(f'<path data-letter="{letter}" d="{pen.getCommands()}"/>')

k_source = (HERE / '37-integrated-k-symbol.svg').read_text(encoding='utf-8')
k_path = re.search(r'<path\b[^>]*\bd="([^"]+)"', k_source)
if not k_path:
    raise RuntimeError('The custom K must contain its native filled path.')

records = []
for identifier, label, k_fill in [(37, 'white', '#F3F5F6'), (38, 'gold-accent', '#F9C932')]:
    filename = f'{identifier}-integrated-k-{label}.svg'
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{number(canvas_width)}" height="{number(canvas_height)}" '
        f'viewBox="0 0 {number(canvas_width)} {number(canvas_height)}" fill="none" role="img" aria-label="Kollens">\n'
        '  <title>Kollens Integrated K Wordmark</title>\n'
        '  <desc>A continuous geometric K is the first letter of Kollens. Real Manrope 800 lowercase glyph outlines have a small optical weight expansion, native kerning, and deliberate spacing. Both l ascenders align to the K height and baseline.</desc>\n'
        f'  <path data-letter="K" fill="{k_fill}" transform="translate({padding} {padding})" d="{k_path.group(1)}"/>\n'
        f'  <g fill="#F3F5F6" stroke="#F3F5F6" stroke-width="{2 * outline_expansion}" stroke-linejoin="round" paint-order="stroke fill">{"".join(paths)}</g>\n'
        '</svg>\n'
    )
    (HERE / filename).write_text(svg, encoding='utf-8')
    records.append({'id': identifier, 'name': label, 'file': filename, 'customKFill': k_fill, 'width': canvas_width, 'height': canvas_height})

metadata = {
    'brand': 'Kollens', 'spelling': 'Kollens', 'letterCount': 7,
    'reference': 'C:/Users/PC/Downloads/photo_2026-10-12_16-43-07.jpg',
    'method': 'Custom native K geometry plus real outlined font glyphs, informed by an ImageGen concept',
    'font': 'Manrope 800', 'fontFile': str(font_file),
    'fontScale': font_scale, 'opticalOutlineExpansion': outline_expansion, 'trackingEm': tracking, 'kerning': kerning_method,
    'pairAdjustments': adjustments,
    'customKBounds': [padding, padding, padding + k_width, padding + 160],
    'wordmarkAscenderBounds': [padding, padding + 160],
    'KToOInkGap': ink_gap, 'transparentBackground': True,
    'options': records,
}
(HERE / 'wordmark-geometry.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
font.close()
print(json.dumps({'options': [record['file'] for record in records], 'dimensions': [canvas_width, canvas_height], 'gap': ink_gap}))
