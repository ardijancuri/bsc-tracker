import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const directory = path.dirname(fileURLToPath(import.meta.url));
const unit = vector => { const length = Math.hypot(...vector); return vector.map(n => n / length); };
const pair = p => p.map(n => Number(n.toFixed(6))).join(' ');

// Construct equal-radius circular fillets at every convex polygon corner.
function roundedPolygon(vertices, radius) {
  const corners = vertices.map((b, index) => {
    const a = vertices[(index + vertices.length - 1) % vertices.length];
    const c = vertices[(index + 1) % vertices.length];
    const incoming = unit([a[0] - b[0], a[1] - b[1]]);
    const outgoing = unit([c[0] - b[0], c[1] - b[1]]);
    const angle = Math.acos(incoming[0] * outgoing[0] + incoming[1] * outgoing[1]);
    const distance = radius / Math.tan(angle / 2);
    return { start: b.map((n, i) => n + incoming[i] * distance), end: b.map((n, i) => n + outgoing[i] * distance) };
  });
  return corners.map((corner, i) => `${i === 0 ? 'M' : 'L'} ${pair(corner.start)} A ${radius} ${radius} 0 0 1 ${pair(corner.end)}`).join(' ') + ' Z';
}

const lensBody = roundedPolygon([[64, 8], [103, 29], [118, 70], [63, 120], [10, 82], [10, 48]], 3);
const lensVoid = 'M41 94 A58 58 0 0 1 87 34 A58 58 0 0 1 41 94 Z';
const focusEnvelope = roundedPolygon([[64, 8], [116, 71], [64, 120], [12, 71]], 3);
// The incoming beam is a contour notch, so no filled subpath can leak outside the prism.
const focusBody = focusEnvelope.replace(/ Z$/, ' L14.476190 68 L55 68 L83 90 L89 82 L67 64 L90 53 L85 46 L56 60 L21.079365 60 Z');

const variants = [
  { file: '17-lens-prism', title: 'Lens Prism', description: 'A clipped six-facet prism surrounds one generous diagonal almond lens made from matched circular arcs.', body: lensBody, opening: lensVoid },
  { file: '18-refracted-focus', title: 'Refracted Focus', description: 'A compact kite prism has one incoming optical cut branching into two short refracted channels, with solid bridges around their tips.', body: focusBody, opening: '' },
];

for (const v of variants) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="#F9C932">\n  <title>Kollens ${v.title}</title>\n  <desc>${v.description}</desc>\n  <path fill-rule="evenodd" d="${v.body} ${v.opening}"/>\n</svg>\n`;
  await fs.writeFile(path.join(directory, `${v.file}.svg`), svg);
  await sharp(Buffer.from(svg), { density: 600 }).resize(768, 768).flatten({ background: '#101113' }).png().toFile(path.join(directory, `${v.file}-proof.png`));
  const small = await sharp(Buffer.from(svg)).resize(24, 24).flatten({ background: '#101113' }).png().toBuffer();
  await sharp(small).resize(240, 240, { kernel: 'nearest' }).png().toFile(path.join(directory, `${v.file}-small-proof.png`));
  const { data } = await sharp(Buffer.from(svg)).resize(128, 128).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = 128, minY = 128, maxX = -1, maxY = -1;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    if (data[(y * 128 + x) * 4 + 3] > 128) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  }
  console.log(JSON.stringify({ file: v.file, bounds: [minX, minY, maxX, maxY], cornerAlpha: data[3] }));
}
