from pathlib import Path
import json, re, sys, xml.etree.ElementTree as ET

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parents[1]/'.cache'/'wordmark-font-tools'))
from fontTools.pens.boundsPen import BoundsPen
from fontTools.svgLib.path import parse_path

root=ET.parse(HERE/'prototype-white.svg').getroot()
glyphs=[]
for element in root.findall('.//{http://www.w3.org/2000/svg}path'):
    pen=BoundsPen(None)
    parse_path(element.attrib['d'],pen)
    numbers=[float(n) for n in re.findall(r'-?\d+(?:\.\d+)?',element.attrib['transform'])]
    x,y=numbers
    xmin,ymin,xmax,ymax=pen.bounds
    glyphs.append({'id':element.attrib['id'],'localBounds':[xmin,ymin,xmax,ymax],
                   'offset':[x,y],'bounds':[xmin+x,ymin+y,xmax+x,ymax+y]})
bounds=[min(g['bounds'][0]for g in glyphs),min(g['bounds'][1]for g in glyphs),
        max(g['bounds'][2]for g in glyphs),max(g['bounds'][3]for g in glyphs)]
data={'bounds':bounds,'glyphs':glyphs}
(HERE/'vector-bounds.json').write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'bounds':bounds},separators=(',',':')))
