"""Outline the original lowercase kollens glyphs from four local static fonts."""
from __future__ import annotations

import json
from pathlib import Path
import sys
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / ".cache" / "wordmark-font-tools"))

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

TEXT = "kollens"
FILL = "#F3F5F6"
HEIGHT = 128.0
MANROPE = ROOT / "node_modules" / "@fontsource" / "manrope" / "files"
OPTIONS = [
    (23, "clean-manrope", "Manrope", 700, -0.02, MANROPE / "manrope-latin-700-normal.woff"),
    (24, "geometric-gothic", "Century Gothic", 700, -0.015, Path("C:/Windows/Fonts/GOTHICB.TTF")),
    (25, "airy-manrope", "Manrope", 600, 0.015, MANROPE / "manrope-latin-600-normal.woff"),
    (26, "compact-segoe", "Segoe UI", 700, -0.01, Path("C:/Windows/Fonts/segoeuib.ttf")),
]


def number(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".") or "0"


def positioning(value):
    if value is None:
        return (0, 0, 0, 0)
    return tuple(getattr(value, key, 0) or 0 for key in ("XPlacement", "YPlacement", "XAdvance", "YAdvance"))


def pair_position(subtable, first, second):
    coverage = subtable.Coverage.glyphs
    if first not in coverage:
        return None
    if subtable.Format == 1:
        for record in subtable.PairSet[coverage.index(first)].PairValueRecord:
            if record.SecondGlyph == second:
                return positioning(record.Value1), positioning(record.Value2)
    elif subtable.Format == 2:
        class1 = subtable.ClassDef1.classDefs.get(first, 0)
        class2 = subtable.ClassDef2.classDefs.get(second, 0)
        record = subtable.Class1Record[class1].Class2Record[class2]
        return positioning(record.Value1), positioning(record.Value2)
    return None


def kerning_lookups(font):
    if "GPOS" not in font:
        return []
    table = font["GPOS"].table
    if table.FeatureList is None or table.LookupList is None:
        return []
    feature_indices = None
    if table.ScriptList:
        scripts = {record.ScriptTag: record.Script for record in table.ScriptList.ScriptRecord}
        script = scripts.get("latn") or scripts.get("DFLT")
        if script and script.DefaultLangSys:
            language = script.DefaultLangSys
            feature_indices = list(language.FeatureIndex)
            if language.ReqFeatureIndex != 0xFFFF:
                feature_indices.append(language.ReqFeatureIndex)
    records = table.FeatureList.FeatureRecord
    if feature_indices is None:
        feature_indices = range(len(records))
    indices = []
    for feature_index in feature_indices:
        record = records[feature_index]
        if record.FeatureTag == "kern":
            for lookup_index in record.Feature.LookupListIndex:
                if lookup_index not in indices:
                    indices.append(lookup_index)
    return [table.LookupList.Lookup[index] for index in indices]


def layout(font, glyph_names, tracking):
    advances = [float(font["hmtx"].metrics[name][0]) for name in glyph_names]
    offsets = [[0.0, 0.0] for _ in glyph_names]
    lookups = kerning_lookups(font)
    adjustments = []
    for index, (first, second) in enumerate(zip(glyph_names, glyph_names[1:])):
        totals = [0, 0, 0, 0, 0, 0, 0, 0]
        if lookups:
            for lookup in lookups:
                for subtable in lookup.SubTable:
                    lookup_type = lookup.LookupType
                    if lookup_type == 9:
                        lookup_type = subtable.ExtensionLookupType
                        subtable = subtable.ExtSubTable
                    if lookup_type != 2:
                        continue
                    values = pair_position(subtable, first, second)
                    if values is not None:
                        first_value, second_value = values
                        offsets[index][0] += first_value[0]
                        offsets[index][1] += first_value[1]
                        advances[index] += first_value[2]
                        offsets[index + 1][0] += second_value[0]
                        offsets[index + 1][1] += second_value[1]
                        advances[index + 1] += second_value[2]
                        totals = [a + b for a, b in zip(totals, first_value + second_value)]
                        break
        elif "kern" in font:
            value = sum(
                subtable.kernTable.get((first, second), 0)
                for subtable in font["kern"].kernTables
                if getattr(subtable, "coverage", 1) & 1
                and not (getattr(subtable, "coverage", 0) & 4)
                and hasattr(subtable, "kernTable")
            )
            advances[index] += value
            totals[2] = value
        adjustments.append({"pair": TEXT[index:index + 2], "positioningFontUnits": totals})
    positions = []
    cursor = 0.0
    for index in range(len(glyph_names)):
        positions.append((cursor + offsets[index][0], offsets[index][1]))
        cursor += advances[index]
        if index < len(glyph_names) - 1:
            cursor += tracking * font["head"].unitsPerEm
    method = "GPOS kern" if lookups else ("legacy kern" if "kern" in font else "font advances; no kerning table")
    return positions, method, adjustments


def outline(option):
    identifier, slug, family, weight, tracking, font_file = option
    font = TTFont(font_file)
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    glyph_names = [cmap[ord(character)] for character in TEXT]
    positions, method, adjustments = layout(font, glyph_names, tracking)
    bounds = BoundsPen(glyph_set)
    for name, (x, y) in zip(glyph_names, positions):
        glyph_set[name].draw(TransformPen(bounds, (1, 0, 0, 1, x, y)))
    xmin, ymin, xmax, ymax = bounds.bounds
    padding = (ymax - ymin) * 0.02
    scale = HEIGHT / (ymax - ymin + 2 * padding)
    width = (xmax - xmin + 2 * padding) * scale
    paths = []
    for name, (x, y) in zip(glyph_names, positions):
        pen = SVGPathPen(glyph_set, ntos=number)
        transform = (scale, 0, 0, -scale, (x - xmin + padding) * scale, (ymax + padding - y) * scale)
        glyph_set[name].draw(TransformPen(pen, transform))
        paths.append(pen.getCommands())
    output = f"{identifier}-{slug}.svg"
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{number(width)}" height="128" '
        f'viewBox="0 0 {number(width)} 128" role="img" aria-label="kollens">\n'
        '  <title>kollens</title>\n'
        f'  <desc>{escape(family)} {weight}; original lowercase glyph outlines with {tracking:+.3f} em tracking.</desc>\n'
        f'  <path fill="{FILL}" d="{" ".join(paths)}"/>\n'
        '</svg>\n'
    )
    (HERE / output).write_text(svg, encoding="utf-8")
    result = {
        "id": identifier, "slug": slug, "text": TEXT, "letterCount": len(TEXT),
        "typeface": family, "weight": weight, "trackingEm": tracking,
        "fontFile": str(font_file.resolve()), "unitsPerEm": font["head"].unitsPerEm,
        "kerning": method, "pairAdjustments": adjustments,
        "glyphNames": glyph_names, "originalGlyphOutlines": True,
        "fill": FILL, "transparent": True, "paddingFractionOfInkHeight": 0.02,
        "width": float(number(width)), "height": HEIGHT, "viewBox": [0, 0, float(number(width)), HEIGHT],
        "inkBoundsFontUnits": [xmin, ymin, xmax, ymax], "file": output,
    }
    font.close()
    return result


def main():
    HERE.mkdir(parents=True, exist_ok=True)
    records = [outline(option) for option in OPTIONS]
    (HERE / "wordmark-fonts.json").write_text(
        json.dumps({"brand": TEXT, "construction": "Unmodified local font glyphs outlined as SVG paths", "options": records}, indent=2) + "\n",
        encoding="utf-8",
    )
    for record in records:
        print(f'{record["file"]}: {record["width"]:.3f} x 128; {record["kerning"]}')


if __name__ == "__main__":
    main()
