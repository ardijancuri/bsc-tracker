import sharp from 'sharp';
import fitCurve from '../../.cache/vector-tools/node_modules/fit-curve/lib/fit-curve.js';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const folder = path.dirname(fileURLToPath(import.meta.url));
const entries = JSON.parse(await readFile(path.join(folder, 'round-22-contours.json'), 'utf8'));
const header = await readFile(path.join(folder, '../../public/kollens-header-logo.svg'), 'utf8');
const wordmark = header.slice(header.indexOf('<svg x="53"'));
const housing = '<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg x="0" y="0" width="42" height="42" viewBox="0 0 128 128">';
const xy = point => point.map(n => n.toFixed(3)).join(' ');

// Fit smooth regions separately so angled K edges and counters stay defined.
function contourPath(closed) {
  const points = closed.slice(0, -1);
  const corners = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[(i + points.length - 1) % points.length];
    const v = points[i];
    const n = points[(i + 1) % points.length];
    const a = [v[0]-p[0],v[1]-p[1]], b = [n[0]-v[0],n[1]-v[1]];
    const cosine = (a[0]*b[0]+a[1]*b[1])/(Math.hypot(...a)*Math.hypot(...b));
    if (cosine < Math.cos(35*Math.PI/180)) corners.push(i);
  }
  if (!corners.length) corners.push(0);
  let output = 'M ' + xy(points[corners[0]]);
  for (let i = 0; i < corners.length; i++) {
    const start = corners[i];
    let end = corners[(i+1)%corners.length];
    if (end <= start) end += points.length;
    const region = [];
    for (let j = start; j <= end; j++) region.push(points[j%points.length]);
    if (region.length === 2) output += ' L ' + xy(region[1]);
    else {
      // Long straight runs need intermediate samples to prevent bowed fits.
      const dense = [region[0]];
      for (let j = 1; j < region.length; j++) {
        const p = region[j-1], n = region[j];
        const steps = Math.max(1,Math.ceil(Math.hypot(n[0]-p[0],n[1]-p[1])/.6));
        for (let k = 1; k <= steps; k++) dense.push([
          p[0]+(n[0]-p[0])*k/steps,p[1]+(n[1]-p[1])*k/steps
        ]);
      }
      output += fitCurve(dense,.09).map(c=>` C ${xy(c[1])} ${xy(c[2])} ${xy(c[3])}`).join('');
    }
  }
  return output + ' Z';
}

const composites = [];
for (const [i, {stem,title,contours}] of entries.entries()) {
  const inner = `<path fill="#f9c932" fill-rule="evenodd" d="${contours.map(contourPath).join(' ')}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-labelledby="title"><title id="title">Kollens ${title} icon</title>${inner}</svg>\n`;
  const lockup = housing + inner + '</svg>' + wordmark;
  await writeFile(path.join(folder,`${stem}.svg`),svg);
  await writeFile(path.join(folder,`${stem}-header.svg`),lockup);
  const preview = await sharp(Buffer.from(svg)).resize(256,256).png().toBuffer();
  await writeFile(path.join(folder,`${stem}.png`),preview);
  const x = i*400;
  composites.push({input:preview,left:x+72,top:36});
  const label = `<svg width="400" height="42"><text x="200" y="28" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="600" fill="#f3f5f6">${stem.slice(0,2)} · ${title}</text></svg>`;
  composites.push({input:Buffer.from(label),left:x,top:324});
  const small = await sharp(Buffer.from(lockup)).resize({height:30}).png().toBuffer();
  const {width} = await sharp(small).metadata();
  composites.push({input:small,left:x+Math.round((400-width)/2),top:384});
}
await sharp({create:{width:1200,height:460,channels:4,background:'#0b0e11'}})
  .composite(composites).png().toFile(path.join(folder,'comparison-round-22.png'));
console.log('Rendered native SVG concepts 70–72 in exact #F9C932.');
