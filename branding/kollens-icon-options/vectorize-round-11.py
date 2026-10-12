"""Read generated alpha outlines and export contours for native vector fitting."""
from pathlib import Path
import json
import shutil
import cv2
import numpy as np
from PIL import Image

folder = Path(__file__).resolve().parent
source_root = Path('C:/Users/PC/.codex/generated_images/01a0deed-e93b-7573-9540-7d96188a7440')
sources = [
    ('40-wrap-optic', 'Wrap optic', 'exec-f4f911c3-24fa-420e-9423-1d7512da8448.png'),
    ('41-swept-iris', 'Swept iris', 'exec-8047e6c4-cc74-4350-a9e7-5e3c7fd833d7.png'),
    ('42-ribbon-k-optic', 'Ribbon K optic', 'exec-832a048f-8a54-4c54-b1fe-6127f4756d18.png'),
]
(folder / 'round-11-sources').mkdir(exist_ok=True)
entries = []
for stem, title, source_name in sources:
    source = source_root / source_name
    shutil.copy2(source, folder / 'round-11-sources' / f'{stem}.png')
    alpha = np.asarray(Image.open(source).convert('RGBA'))[:, :, 3]
    silhouette = (alpha >= 220).astype(np.uint8) * 255
    silhouette = cv2.morphologyEx(silhouette, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    contours, _ = cv2.findContours(silhouette, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted([c for c in contours if cv2.contourArea(c) > 2500], key=cv2.contourArea, reverse=True)
    all_points = np.concatenate(contours)[:, 0, :]
    minimum = all_points.min(axis=0)
    maximum = all_points.max(axis=0)
    center = (minimum + maximum) / 2
    scale = 98.0 / float((maximum - minimum).max())
    parts = []
    for contour in contours:
        points = cv2.approxPolyDP(contour, 2.2, True)[:, 0, :].astype(float)
        points = (points - center) * scale + 64
        incoming = points - np.roll(points, 1, axis=0)
        outgoing = np.roll(points, -1, axis=0) - points
        cosine = np.sum(incoming * outgoing, axis=1) / (np.linalg.norm(incoming, axis=1) * np.linalg.norm(outgoing, axis=1))
        points = np.roll(points, -int(np.argmin(cosine)), axis=0)
        parts.append(np.vstack([points, points[0]]).round(4).tolist())
    entries.append({'stem': stem, 'title': title, 'contours': parts})
    print(f'{stem}: {len(parts)} optical ribbons')
(folder / 'round-11-contours.json').write_text(json.dumps(entries), encoding='utf-8')
