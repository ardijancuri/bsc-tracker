"""Build portable Kollens logos from the custom K and genuine Poppins ExtraBold."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / ".cache" / "wordmark-font-tools"))
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONT = HERE / "fonts" / "Poppins-ExtraBold.ttf"
K_SOURCE = ROOT / "branding" / "kollens-integrated-k" / "37-integrated-k-symbol.svg"
TRACKING = -0.04
HORIZONTAL_SCALE = 1.03
TEXT = "ollens"
WHITE = "#FFFFFF"
YELLOW = "#F9C932"


def n(value):
    return f"{value:.9f}".rstrip("0").rstrip(".") or "0"


def value_record(record):
    if record is None:
        return (0, 0, 0)
    return tuple(getattr(record, key, 0) or 0 for key in ("XPlacement", "YPlacement", "XAdvance"))


def pair_values(subtable, first, second):
    if first not in subtable.Coverage.glyphs:
        return None
    if subtable.Format == 1:
        pair_set = subtable.PairSet[subtable.Coverage.glyphs.index(first)]
        for record in pair_set.PairValueRecord:
            if record.SecondGlyph == second:
                return value_record(record.Value1), value_record(record.Value2)
    elif subtable.Format == 2:
        class1 = subtable.ClassDef1.classDefs.get(first, 0)
        class2 = subtable.ClassDef2.classDefs.get(second, 0)
        record = subtable.Class1Record[class1].Class2Record[class2]
        return value_record(record.Value1), value_record(record.Value2)
    return None


def kern_lookups(font):
    if "GPOS" not in font:
        return []
    table = font["GPOS"].table
    if not table.FeatureList or not table.LookupList:
        return []
    features = table.FeatureList.FeatureRecord
    feature_indices = None
    if table.ScriptList:
        scripts = {record.ScriptTag: record.Script for record in table.ScriptList.ScriptRecord}
        script = scripts.get("latn") or scripts.get("DFLT")
        if script and script.DefaultLangSys:
            lang = script.DefaultLangSys
            feature_indices = list(lang.FeatureIndex)
            if lang.ReqFeatureIndex != 0xFFFF:
                feature_indices.append(lang.ReqFeatureIndex)
    if feature_indices is None:
        feature_indices = range(len(features))
    indices = []
    for index in feature_indices:
        if features[index].FeatureTag == "kern":
            for lookup in features[index].Feature.LookupListIndex:
                if lookup not in indices:
                    indices.append(lookup)
    return [table.LookupList.Lookup[index] for index in indices]


def layout(font, glyphs):
    advances = [float(font["hmtx"].metrics[glyph][0]) for glyph in glyphs]
    offsets = [[0.0, 0.0] for _ in glyphs]
    lookups = kern_lookups(font)
    pair_records = []
    for index, (first, second) in enumerate(zip(glyphs, glyphs[1:])):
        adjustments = [0, 0, 0, 0, 0, 0]
        if lookups:
            for lookup in lookups:
                for subtable in lookup.SubTable:
                    kind = lookup.LookupType
                    if kind == 9:
                        kind = subtable.ExtensionLookupType
                        subtable = subtable.ExtSubTable
                    if kind != 2:
                        continue
                    pair = pair_values(subtable, first, second)
                    if pair is not None:
                        a, b = pair
                        for glyph_index, values in ((index, a), (index + 1, b)):
                            offsets[glyph_index][0] += values[0]
                            offsets[glyph_index][1] += values[1]
                            advances[glyph_index] += values[2]
                        adjustments = [a + b for a, b in zip(adjustments, a + b)]
                        break
        elif "kern" in font:
            amount = sum(subtable.kernTable.get((first, second), 0)
                         for subtable in font["kern"].kernTables
                         if hasattr(subtable, "kernTable") and getattr(subtable, "coverage", 1) & 1)
            advances[index] += amount
            adjustments[2] = amount
        pair_records.append({"pair": TEXT[index:index+2], "positioningFontUnits": adjustments})
    positions = []
    cursor = 0.0
    for index in range(len(glyphs)):
        positions.append((cursor + offsets[index][0], offsets[index][1]))
        cursor += advances[index]
        if index < len(glyphs) - 1:
            cursor += TRACKING * font["head"].unitsPerEm
    return positions, pair_records, "GPOS kern" if lookups else "font advances"


def main():
    font = TTFont(FONT)
    preferred_family = font["name"].getDebugName(16)
    preferred_style = font["name"].getDebugName(17)
    weight = font["OS/2"].usWeightClass
    assert preferred_family == "Poppins" and preferred_style == "ExtraBold" and weight == 800
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    glyph_names = [cmap[ord(character)] for character in TEXT]
    ascender_pen = BoundsPen(glyph_set)
    glyph_set[cmap[ord("l")]].draw(ascender_pen)
    l_bounds = ascender_pen.bounds
    assert l_bounds[1] == 0
    font_scale = 160 / l_bounds[3]
    positions, pair_records, kerning = layout(font, glyph_names)
    first_pen = BoundsPen(glyph_set)
    glyph_set[glyph_names[0]].draw(first_pen)
    base_x = 145 + 8 - (positions[0][0] + first_pen.bounds[0]) * font_scale
    text_bounds = BoundsPen(glyph_set)
    paths = []
    glyph_records = []
    for character, glyph, (x, y) in zip(TEXT, glyph_names, positions):
        transform = (font_scale, 0, 0, -font_scale, base_x + x * font_scale, 160 - y * font_scale)
        glyph_set[glyph].draw(TransformPen(text_bounds, transform))
        glyph_bounds = BoundsPen(glyph_set)
        glyph_set[glyph].draw(TransformPen(glyph_bounds, transform))
        path_pen = SVGPathPen(glyph_set, ntos=n)
        glyph_set[glyph].draw(TransformPen(path_pen, transform))
        paths.append(path_pen.getCommands())
        glyph_records.append({"letter": character, "glyph": glyph, "inkBounds": list(glyph_bounds.bounds)})
    assert abs(glyph_records[0]["inkBounds"][0] - 153) < 1e-8
    ymin = min(0, text_bounds.bounds[1])
    ymax = max(160, text_bounds.bounds[3])
    width_native = max(145, text_bounds.bounds[2])
    height_native = ymax - ymin
    export_scale = 42 / height_native
    export_width = width_native * export_scale * HORIZONTAL_SCALE
    k_path = ET.parse(K_SOURCE).getroot().find("{http://www.w3.org/2000/svg}path").attrib["d"]
    text_path = " ".join(paths)
    for suffix, color in (("white", WHITE), ("yellow", YELLOW)):
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{n(export_width)}" height="42" '
            f'viewBox="0 0 {n(export_width)} 42" role="img" aria-label="kollens">\n'
            '  <title>kollens</title>\n'
            '  <desc>Custom integrated K with original Poppins ExtraBold 800 lowercase ollens outlines, widened three percent to match the reference proportions.</desc>\n'
            f'  <g transform="translate(0 {n(-ymin * export_scale)}) scale({n(export_scale * HORIZONTAL_SCALE)} {n(export_scale)})">\n'
            f'    <path fill="{color}" d="{k_path}"/>\n'
            f'    <path fill="{WHITE}" d="{text_path}"/>\n'
            '  </g>\n</svg>\n'
        )
        (HERE / f"kollens-logo-{suffix}.svg").write_text(svg, encoding="utf-8")
        icon_scale_y = 108 / 160
        icon_scale_x = icon_scale_y * HORIZONTAL_SCALE
        icon_width = 145 * icon_scale_x
        icon_x = (128 - icon_width) / 2
        icon_svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" '
            f'role="img" aria-label="kollens {suffix} K icon">\n'
            f'  <title>kollens {suffix} K icon</title>\n'
            f'  <path fill="{color}" transform="translate({n(icon_x)} 10) scale({n(icon_scale_x)} {n(icon_scale_y)})" d="{k_path}"/>\n'
            '</svg>\n'
        )
        (HERE / f"kollens-icon-{suffix}.svg").write_text(icon_svg, encoding="utf-8")
    actual_gaps = [glyph_records[index + 1]["inkBounds"][0] - glyph_records[index]["inkBounds"][2]
                   for index in range(len(glyph_records) - 1)]
    for record in glyph_records:
        record["inkBounds"][0] *= HORIZONTAL_SCALE
        record["inkBounds"][2] *= HORIZONTAL_SCALE
    manifest = {
        "brand": "kollens", "letterCount": 7, "firstGlyph": "Custom integrated K", "fontText": TEXT,
        "typeface": preferred_family, "style": preferred_style, "weight": weight,
        "fontFile": "fonts/Poppins-ExtraBold.ttf", "fontSha256": hashlib.sha256(FONT.read_bytes()).hexdigest(),
        "fontSource": "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-ExtraBold.ttf",
        "licenseFile": "fonts/OFL.txt", "fontFamilyName": font["name"].getDebugName(1),
        "fontSubfamilyName": font["name"].getDebugName(2), "postscriptName": font["name"].getDebugName(6),
        "unitsPerEm": font["head"].unitsPerEm, "trackingEm": TRACKING,
        "kerning": kerning, "pairPositioning": pair_records, "originalFontGlyphOutlines": True, "fakeBold": False,
        "horizontalScale": HORIZONTAL_SCALE, "referenceInkAspect": 1357 / 276,
        "alignment": {"KInkBounds": [0,0,145 * HORIZONTAL_SCALE,160], "lAscenderFontUnits": l_bounds[3],
                      "fontScaleX": font_scale * HORIZONTAL_SCALE, "fontScaleY": font_scale,
                      "baselineNative":160, "lAscenderHeightNative":160, "KToOInkGapNative":8 * HORIZONTAL_SCALE,
                      "textInkGapsNative":[gap * HORIZONTAL_SCALE for gap in actual_gaps], "glyphs":glyph_records},
        "nativeInkBounds": [0,ymin,width_native * HORIZONTAL_SCALE,ymax], "nativeWidth":width_native * HORIZONTAL_SCALE,"nativeHeight":height_native,
        "exportScaleX":export_scale * HORIZONTAL_SCALE,"exportScaleY":export_scale,"logoWidth":float(n(export_width)),"logoHeight":42,
        "icon": {"width":128,"height":128,"inkBounds":[icon_x,10,128 - icon_x,118],"visibleHeight":108},
        "colors":{"white":WHITE,"yellow":YELLOW}, "transparent":True,
        "files":["kollens-logo-white.svg","kollens-logo-yellow.svg","kollens-icon-white.svg","kollens-icon-yellow.svg"],
        "construction":"Original native SVG K path plus genuine font glyph outlines, widened horizontally by three percent; no text elements, images, filters, or stroke expansion",
    }
    (HERE / "manifest.json").write_text(json.dumps(manifest,indent=2)+"\n", encoding="utf-8")
    print(json.dumps({"family":preferred_family,"style":preferred_style,"weight":weight,
                      "width":float(n(export_width)),"height":42,"horizontalScale":HORIZONTAL_SCALE,
                      "KToOInkGapNative":8 * HORIZONTAL_SCALE,
                      "textInkGapsNative":[gap * HORIZONTAL_SCALE for gap in actual_gaps]}))
    font.close()


if __name__ == "__main__":
    main()
