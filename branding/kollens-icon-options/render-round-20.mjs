import sharp from 'sharp';
import fitCurve from '../../.cache/vector-tools/node_modules/fit-curve/lib/fit-curve.js';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const folder = path.dirname(fileURLToPath(import.meta.url));
const entries = JSON.parse(await readFile(path.join(folder, 'round-20-contours.json'), 'utf8'));
const header = await readFile(path.join(folder, '../../public/kollens-header-logo.svg'), 'utf8');
const wordmark = header.slice(header.indexOf('<svg x="53"'));
const iconHousing = '<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg width="42" height="42" viewBox="0 0 128 128" x="0" y="0">';
const composites = [];
const xy = p => p.map(v => v.toFixed(3)).join(' ');
for (let i = 0; i < entries.length; i++) {
  const { stem, title, contours } = entries[i];
  // The user removed the circular counter at the K junction.
  const refinedContours = contours.filter((_, index) =>
    !(stem === '65-open-k-lens' && index === 2) &&
    !(stem === '66-focus-k-lens' && index === 3)
  );
  const compound = refinedContours.map(points => {
    const curves = fitCurve(points, 0.12);
    return 'M ' + xy(curves[0][0]) + curves.map(c => ` C ${xy(c[1])} ${xy(c[2])} ${xy(c[3])}`).join('') + ' Z';
  }).join(' ');
  const inner = `<path fill="#f9c932" fill-rule="evenodd" d="${compound}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-labelledby="title"><title id="title">Kollens ${title} icon</title>\n  ${inner}\n</svg>\n`;
  await writeFile(path.join(folder, `${stem}.svg`), svg);
  const lockup = iconHousing + inner + '</svg>' + wordmark;
  await writeFile(path.join(folder, `${stem}-header.svg`), lockup);
  const preview = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer();
  await writeFile(path.join(folder, `${stem}.png`), preview);
  const x = i * 400;
  composites.push({ input: preview, left: x + 72, top: 36 });
  const label = `<svg width="400" height="42"><text x="200" y="28" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="600" fill="#f3f5f6">${stem.slice(0, 2)} · ${title}</text></svg>`;
  composites.push({ input: Buffer.from(label), left: x, top: 324 });
  const actualHeader = await sharp(Buffer.from(lockup)).resize({ height: 30 }).png().toBuffer();
  const { width } = await sharp(actualHeader).metadata();
  composites.push({ input: actualHeader, left: x + Math.round((400 - width) / 2), top: 384 });
}
await sharp({ create: { width: 1200, height: 460, channels: 4, background: '#0b0e11' } })
  .composite(composites).png().toFile(path.join(folder, 'comparison-round-20.png'));
console.log('Created three native SVG concepts in exact #F9C932 without center circles.');
