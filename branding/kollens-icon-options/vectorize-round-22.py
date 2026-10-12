"""Convert the generated mark outlines into native vector-fitting contours."""
from pathlib import Path
import json
import shutil
import cv2
import numpy as np
from PIL import Image

folder=Path(__file__).resolve().parent
sources=json.loads((folder/'round-22-inputs.json').read_text(encoding='utf-8'))
(folder/'round-22-sources').mkdir(exist_ok=True)
entries=[]
for entry in sources:
    source=Path(entry['source'])
    shutil.copy2(source,folder/'round-22-sources'/f"{entry['stem']}.png")
    rgba=np.asarray(Image.open(source).convert('RGBA'))
    gold=(rgba[:,:,0]>130)&(rgba[:,:,1]>70)&(rgba[:,:,2]<rgba[:,:,1]*0.85)
    silhouette=((rgba[:,:,3]>=220)&gold).astype(np.uint8)*255
    silhouette=cv2.morphologyEx(silhouette,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(9,9)))
    # Preserve enclosed lens openings as subpaths, as well as disconnected strokes.
    contours,hierarchy=cv2.findContours(silhouette,cv2.RETR_TREE,cv2.CHAIN_APPROX_SIMPLE)
    selected=[c for c in contours if cv2.contourArea(c)>2500]
    if not selected:
        raise ValueError(f"No valid gold silhouette found: {source}")
    points=np.concatenate(selected)[:,0,:]
    minimum=points.min(axis=0)
    maximum=points.max(axis=0)
    center=(minimum+maximum)/2
    scale=98.0/float((maximum-minimum).max())
    parts=[]
    for contour in selected:
        points=cv2.approxPolyDP(contour,2.2,True)[:,0,:].astype(float)
        points=(points-center)*scale+64
        incoming=points-np.roll(points,1,axis=0)
        outgoing=np.roll(points,-1,axis=0)-points
        cosine=np.sum(incoming*outgoing,axis=1)/(np.linalg.norm(incoming,axis=1)*np.linalg.norm(outgoing,axis=1))
        points=np.roll(points,-int(np.argmin(cosine)),axis=0)
        parts.append(np.vstack([points,points[0]]).round(4).tolist())
    entries.append({'stem':entry['stem'],'title':entry['title'],'contours':parts})
    print(f"{entry['stem']}: {len(parts)} native outlines and counters")
(folder/'round-22-contours.json').write_text(json.dumps(entries),encoding='utf-8')
