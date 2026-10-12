import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const folder = path.dirname(fileURLToPath(import.meta.url));
const gold = '#f9c932';
const xy = point => point.map(n => +n.toFixed(3)).join(' ');

// Circular fillets on straight polygon segments, including concave corners.
function roundedPolygon(vertices, radii = 3) {
  const corners = vertices.map((v, i) => {
    const p = vertices[(i + vertices.length - 1) % vertices.length];
    const n = vertices[(i + 1) % vertices.length];
    const incoming = [p[0] - v[0], p[1] - v[1]];
    const outgoing = [n[0] - v[0], n[1] - v[1]];
    const a = Math.hypot(...incoming), b = Math.hypot(...outgoing);
    const u = incoming.map(q => q / a), w = outgoing.map(q => q / b);
    const angle = Math.acos(Math.max(-1, Math.min(1, u[0] * w[0] + u[1] * w[1])));
    const requested = Array.isArray(radii) ? radii[i] : radii;
    const cut = Math.min(requested / Math.tan(angle / 2), a * .45, b * .45);
    const radius = cut * Math.tan(angle / 2);
    const start = v.map((q, k) => q + u[k] * cut);
    const end = v.map((q, k) => q + w[k] * cut);
    const turn = -u[0] * w[1] + u[1] * w[0];
    return { start, end, radius, sweep: turn > 0 ? 1 : 0 };
  });
  return corners.map((c, i) => `${i ? 'L' : 'M'} ${xy(c.start)} A ${+c.radius.toFixed(3)} ${+c.radius.toFixed(3)} 0 0 ${c.sweep} ${xy(c.end)}`).join(' ') + ' Z';
}

const ringK = roundedPolygon([
  [34, 20], [50, 20], [50, 47], [80, 27], [98, 27],
  [61, 64], [98, 101], [80, 101], [50, 81], [50, 108], [34, 108]
], 2.5);

const squareK = roundedPolygon([
  [16,16], [36,16], [36,54], [54,32], [54,16],
  [112,16], [112,50], [96,50], [96,32], [84,32], [52,64],
  [84,96], [96,96], [96,78], [112,78], [112,112], [16,112]
], [10,3,3,3,3,10,3,3,3,3,4,3,3,3,3,10,10]);
const squareCounter = roundedPolygon([[36,74],[60,96],[36,96]], 2.5);

const entries = [
  {
    stem: '67-open-optic-k', title: 'Open optic K',
    inner: `<path d="M 106.213 41.527 A 48 48 0 1 0 106.213 86.473" fill="none" stroke="${gold}" stroke-width="14" stroke-linecap="round"/><path d="${ringK}" fill="${gold}"/>`
  },
  {
    stem: '68-square-focus-k', title: 'Square focus K',
    inner: `<path d="${squareK} ${squareCounter}" fill="${gold}" fill-rule="evenodd"/>`
  },
  {
    stem: '69-shutter-k', title: 'Shutter K',
    inner: `<path fill="${gold}" d="M 21 18 H 35 Q 39 18 39 22 V 46 Q 39 49 42 47 L 73 20 Q 76 17 80 18 C 94 20 106 29 112 43 Q 114 46 111 48 L 76 61 Q 71 64 76 67 L 111 80 Q 114 82 112 85 C 106 99 94 108 80 110 Q 76 111 73 108 L 42 81 Q 39 79 39 82 V 106 Q 39 110 35 110 H 21 Q 17 110 17 106 V 22 Q 17 18 21 18 Z"/>`
  }
];

const header = await readFile(path.join(folder, '../../public/kollens-header-logo.svg'), 'utf8');
const wordmark = header.slice(header.indexOf('<svg x="53"'));
const housing = '<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg x="0" y="0" width="42" height="42" viewBox="0 0 128 128">';
const composites = [];
for (const [i, { stem, title, inner }] of entries.entries()) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-labelledby="title"><title id="title">Kollens ${title} icon</title>${inner}</svg>\n`;
  const lockup = housing + inner + '</svg>' + wordmark;
  await writeFile(path.join(folder, `${stem}.svg`), svg);
  await writeFile(path.join(folder, `${stem}-header.svg`), lockup);
  const preview = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
  await writeFile(path.join(folder, `${stem}.png`), preview);
  const x = i * 400;
  composites.push({ input: preview, left: x + 72, top: 36 });
  const label = `<svg width="400" height="42"><text x="200" y="28" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="600" fill="#f3f5f6">${stem.slice(0,2)} · ${title}</text></svg>`;
  composites.push({ input: Buffer.from(label), left: x, top: 324 });
  const mini = await sharp(Buffer.from(lockup)).resize({height:30}).png().toBuffer();
  const { width } = await sharp(mini).metadata();
  composites.push({ input: mini, left: x + Math.round((400-width)/2), top:384 });
}
await sharp({create:{width:1200,height:460,channels:4,background:'#0b0e11'}})
  .composite(composites).png().toFile(path.join(folder,'comparison-round-21.png'));
console.log('Created native SVG options 67–69 in exact #F9C932 without center circles.');
