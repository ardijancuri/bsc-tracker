import sharp from 'sharp';
import fitCurve from '../../.cache/vector-tools/node_modules/fit-curve/lib/fit-curve.js';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const file = name => new URL(name, import.meta.url);
const entries = [
  {stem: '82-refraction', title: 'Refraction', source: '82-refraction-generated.png'},
  {stem: '83-paired-view', title: 'Paired View', source: '83-paired-view-generated.png'},
  {stem: '84-cut-through', title: 'Cut Through', source: '84-cut-through-generated.png'},
  {stem: '85-vantage', title: 'Vantage', source: '85-vantage-generated.png'},
];
const header = await readFile(file('../../public/kollens-header-logo.svg'), 'utf8');
const wordmark = header.slice(header.indexOf('<svg x="53"'));
const xy = point => point.map(n => Number(n.toFixed(3))).join(' ');

function morph(mask, width, height, dilate) {
  const result = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    let value = dilate ? 0 : 1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const bit = mask[(y + dy) * width + x + dx];
      value = dilate ? Math.max(value, bit) : Math.min(value, bit);
    }
    result[y * width + x] = value;
  }
  return result;
}

function keepComponents(mask, width, height) {
  const seen = new Uint8Array(mask.length), components = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const pixels = [start]; seen[start] = 1;
    for (let index = 0; index < pixels.length; index++) {
      const pixel = pixels[index], x = pixel % width, y = Math.floor(pixel / width);
      for (const neighbor of [x > 0 ? pixel - 1 : -1, x < width - 1 ? pixel + 1 : -1, y > 0 ? pixel - width : -1, y < height - 1 ? pixel + width : -1]) {
        if (neighbor >= 0 && mask[neighbor] && !seen[neighbor]) {seen[neighbor] = 1; pixels.push(neighbor);}
      }
    }
    components.push(pixels);
  }
  const threshold = Math.max(120, Math.max(...components.map(component => component.length)) * 0.015);
  const kept = components.filter(component => component.length >= threshold);
  const clean = new Uint8Array(mask.length);
  for (const component of kept) for (const pixel of component) clean[pixel] = 1;
  return {mask: clean, components: kept.length};
}

function traceContours(mask, width, height) {
  const stride = width + 1, edges = new Map();
  const add = (ax, ay, bx, by) => {
    const key = ay * stride + ax, next = by * stride + bx;
    if (!edges.has(key)) edges.set(key, []);
    edges.get(key).push(next);
  };
  const solid = (x, y) => x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!solid(x, y)) continue;
    if (!solid(x, y - 1)) add(x, y, x + 1, y);
    if (!solid(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!solid(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!solid(x - 1, y)) add(x, y + 1, x, y);
  }
  const contours = [];
  while (edges.size) {
    const start = edges.keys().next().value, points = [];
    let current = start;
    do {
      points.push([current % stride, Math.floor(current / stride)]);
      const outgoing = edges.get(current);
      if (!outgoing?.length) throw new Error('Open contour in generated logo.');
      const next = outgoing.pop();
      if (!outgoing.length) edges.delete(current);
      current = next;
    } while (current !== start);
    const area = Math.abs(points.reduce((total, point, i) => {
      const next = points[(i + 1) % points.length];
      return total + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2);
    if (area > 24) contours.push(points);
  }
  return contours;
}

const composites = [], manifest = [];
for (let i = 0; i < entries.length; i++) {
  const entry = entries[i];
  const {data, info} = await sharp(await readFile(file(entry.source))).resize(640, 640).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  let mask = Uint8Array.from({length: info.width * info.height}, (_, pixel) => {
    const p = pixel * 4;
    return data[p + 3] >= 180 && data[p] >= 140 && data[p + 1] >= 90 && data[p + 2] <= 180 ? 1 : 0;
  });
  // Remove isolated raster residue and one-pixel nicks before curve fitting.
  mask = morph(morph(mask, info.width, info.height, false), info.width, info.height, true);
  const smoothMask = await sharp(Buffer.from(mask.map(value => value * 255)), {raw: {width: info.width, height: info.height, channels: 1}})
    .blur(2.5).threshold(128).toColourspace('b-w').raw().toBuffer();
  mask = Uint8Array.from(smoothMask, value => value ? 1 : 0);
  const cleaned = keepComponents(mask, info.width, info.height);
  const contours = traceContours(cleaned.mask, info.width, info.height);
  const all = contours.flat();
  const minX = Math.min(...all.map(p => p[0])), maxX = Math.max(...all.map(p => p[0]));
  const minY = Math.min(...all.map(p => p[1])), maxY = Math.max(...all.map(p => p[1]));
  const scale = 104 / Math.max(maxX - minX, maxY - minY);
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
  const paths = contours.map(contour => {
    const points = contour.map(p => [64 + (p[0] - centerX) * scale, 64 + (p[1] - centerY) * scale]);
    points.push(points[0]);
    const curves = fitCurve(points, 0.8);
    return `M ${xy(curves[0][0])}${curves.map(curve => ` C ${xy(curve[1])} ${xy(curve[2])} ${xy(curve[3])}`).join('')} Z`;
  });
  const inner = `<path fill="#f9c932" fill-rule="evenodd" d="${paths.join(' ')}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-labelledby="title"><title id="title">Kollens ${entry.title} icon</title>${inner}</svg>\n`;
  await writeFile(file(`${entry.stem}.svg`), svg);
  const png = await sharp(Buffer.from(svg)).resize(512, 512).png().toBuffer();
  await writeFile(file(`${entry.stem}.png`), png);
  const {data: rendered} = await sharp(png).raw().toBuffer({resolveWithObject: true});
  let opaque = 0, transparent = 0;
  for (let p = 0; p < rendered.length; p += 4) {
    if (!rendered[p + 3]) transparent++;
    if (rendered[p + 3] === 255) {
      opaque++;
      if (rendered[p] !== 249 || rendered[p + 1] !== 201 || rendered[p + 2] !== 50) throw new Error('Wrong brand color.');
    }
  }
  if (!opaque || !transparent) throw new Error('Missing visible icon or transparent background.');
  const lockup = `<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg x="0" y="0" width="42" height="42" viewBox="0 0 128 128">${inner}</svg>${wordmark}`;
  await writeFile(file(`${entry.stem}-header.svg`), lockup);
  const col = i % 2, row = Math.floor(i / 2), left = col * 600, top = row * 430;
  const large = await sharp(Buffer.from(svg)).resize(280, 280).png().toBuffer();
  const small = await sharp(Buffer.from(lockup)).resize({height: 34}).png().toBuffer();
  const {width: smallWidth} = await sharp(small).metadata();
  const label = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="60"><text x="300" y="32" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="600" fill="#f3f5f6">${i + 1} · ${entry.title}</text></svg>`;
  composites.push({input: large, left: left + 160, top: top + 20});
  composites.push({input: Buffer.from(label), left, top: top + 305});
  composites.push({input: small, left: left + Math.round((600 - smallWidth) / 2), top: top + 365});
  manifest.push({...entry, svg: `${entry.stem}.svg`, png: `${entry.stem}.png`, header: `${entry.stem}-header.svg`, components: cleaned.components, contours: contours.length, color: '#F9C932'});
  console.log(`${entry.stem}: ${cleaned.components} components, ${contours.length} contours; transparent SVG/PNG and exact gold verified.`);
}
await sharp({create: {width: 1200, height: 860, channels: 4, background: '#0b0e11'}})
  .composite(composites).png().toFile(fileURLToPath(file('comparison-round-27.png')));
await writeFile(file('round-27-manifest.json'), JSON.stringify(manifest, null, 2));
