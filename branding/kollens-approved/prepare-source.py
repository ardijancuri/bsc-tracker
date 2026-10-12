"""Normalize the supplied Illustrator SVG without changing its letter geometry."""
from pathlib import Path
import json
import re
import sys
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / '.cache' / 'wordmark-font-tools'))
from fontTools.svgLib.path import parse_path
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen

SOURCE = HERE / 'source.svg'
WHITE, YELLOW = '#FFFFFF', '#F9C932'
def n(value):
    return f'{value:.9f}'.rstrip('0').rstrip('.') or '0'

glyphs = []
for element in ET.parse(SOURCE).getroot():
    kind = element.tag.rsplit('}', 1)[-1]
    if kind not in ('path', 'polygon'):
        continue
    bounds = BoundsPen(None)
    outline = SVGPathPen(None, ntos=n)
    for pen in (bounds, outline):
        if kind == 'path':
            parse_path(element.attrib['d'], pen)
        else:
            values = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', element.attrib['points'])]
            pen.moveTo(tuple(values[:2]))
            for i in range(2, len(values), 2):
                pen.lineTo(tuple(values[i:i + 2]))
            pen.closePath()
    glyphs.append({'d': outline.getCommands(), 'bounds': bounds.bounds})
assert len(glyphs) == 7
# The first path is the K; its bounds place it left of every other letter.
assert glyphs[0]['bounds'][0] == min(g['bounds'][0] for g in glyphs)
x0, y0 = min(g['bounds'][0] for g in glyphs), min(g['bounds'][1] for g in glyphs)
x1, y1 = max(g['bounds'][2] for g in glyphs), max(g['bounds'][3] for g in glyphs)
scale = 42 / (y1 - y0)
width = (x1 - x0) * scale
kx0, ky0, kx1, ky1 = glyphs[0]['bounds']
icon_scale = 108 / (ky1 - ky0)
icon_x = (128 - (kx1 - kx0) * icon_scale) / 2
for suffix, color in [('white', WHITE), ('yellow', YELLOW)]:
    paths = '\n'.join(f'    <path id="brand-{i}" fill="{color if i == 0 else WHITE}" fill-rule="evenodd" d="{g["d"]}"/>' for i, g in enumerate(glyphs))
    logo = f'<svg xmlns="http://www.w3.org/2000/svg" width="{n(width)}" height="42" viewBox="0 0 {n(width)} 42" role="img" aria-label="Kollens">\n  <title>Kollens</title>\n  <g transform="scale({n(scale)}) translate({n(-x0)} {n(-y0)})">\n{paths}\n  </g>\n</svg>\n'
    icon = f'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Kollens K icon">\n  <title>Kollens K icon</title>\n  <path id="brand-k" fill="{color}" fill-rule="evenodd" transform="translate({n(icon_x)} 10) scale({n(icon_scale)}) translate({n(-kx0)} {n(-ky0)})" d="{glyphs[0]["d"]}"/>\n</svg>\n'
    for name, content in [('logo', logo), ('icon', icon)]:
        filename = f'kollens-{name}-{suffix}.svg'
        (ROOT / 'public' / filename).write_text(content, encoding='utf-8')
(HERE / 'manifest.json').write_text(json.dumps({'source': 'source.svg', 'method': 'Exact supplied SVG outlines; only whitespace crop, uniform scaling, and requested colors', 'glyphCount': 7, 'sourceInkBounds': [x0, y0, x1, y1], 'KBounds': [kx0, ky0, kx1, ky1], 'logoSize': [width, 42], 'iconSize': [128, 128], 'iconInkHeight': 108, 'colors': {'white': WHITE, 'yellow': YELLOW}}, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'logoSize': [width, 42], 'sourceBounds': [x0, y0, x1, y1], 'KBounds': [kx0, ky0, kx1, ky1]}))
