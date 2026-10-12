import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(dir, '../..');
const background = '#101113';
const gold = '#F9C932';
const variants = [
  { stem: '33-wedge-chevron-bold', previous: '33-wedge-chevron', number: '03', name: 'Bolder wedge', detail: 'Broader triangle. Thicker, simpler chevron.' },
  { stem: '34-flow-chevron-even', previous: '34-flow-chevron', number: '04', name: 'Equal weight flow', detail: 'One consistent width through every fold.' },
];
const wordmark = await fs.readFile(path.join(repo, 'public/kollens-wordmark.svg'), 'utf8');
const body = svg => svg.replace(/^\s*<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const namespace = (svg, prefix) => svg
  .replace(/id="([^"]+)"/g, (_, id) => `id="${prefix}-${id}"`)
  .replace(/href="#([^"]+)"/g, (_, id) => `href="#${prefix}-${id}"`)
  .replace(/url\(#([^\)]+)\)/g, (_, id) => `url(#${prefix}-${id})`);
const place = (svg, x, y, size, prefix) => `<g transform="translate(${x} ${y}) scale(${size / 128})" fill="none">${namespace(body(svg), prefix)}</g>`;
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const text = (x, y, value, size = 20, color = '#F3F5F6', extra = '') => `<text x="${x}" y="${y}" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" ${extra}>${xml(value)}</text>`;
const wordmarkScale = 160 / 145.488;
const wordmarkY = 2.304;
// Visible outline bounds from the wordmark's native path transform.
const wordmarkInkLeft = -1.944 + 138 * 0.0213333;
const wordmarkInkTop = wordmarkY + (32.36 - 1470 * 0.0213333) * wordmarkScale;
const wordmarkInkBottom = wordmarkY + (32.36 + 30 * 0.0213333) * wordmarkScale;

const rendered = [];
for (const variant of variants) {
  const svg = await fs.readFile(path.join(dir, variant.stem + '.svg'), 'utf8');
  const previous = await fs.readFile(path.join(repo, 'branding/kollens-geometric-reference-round-2', variant.previous + '.svg'), 'utf8');
  const pngPath = path.join(dir, variant.stem + '-transparent.png');
  await sharp(Buffer.from(svg), { density: 576 }).resize(1024, 1024).png().toFile(pngPath);
  await sharp(Buffer.from(svg), { density: 576 }).resize(1024, 1024).flatten({ background }).png().toFile(path.join(dir, variant.stem + '-preview.png'));
  for (const size of [24, 32, 48]) {
    await sharp(Buffer.from(svg), { density: 576 }).resize(size, size).png().toFile(path.join(dir, `${variant.stem}-${size}px.png`));
  }
  let lockupWidth = 227;
  let wordmarkX = 55;
  let lockupIcon = place(svg, 0, 0, 42, variant.stem + '-lockup');
  let lockupSizing = { method: 'square icon viewport', iconViewportHeight: 42 };
  if (variant.number === '03') {
    // The wedge has a wide silhouette. Size its visible ink, not its square canvas.
    const iconScale = (wordmarkInkBottom - wordmarkInkTop) / 52;
    const iconLeft = 3;
    const iconInkWidth = 110 * iconScale;
    const inkGap = 13;
    wordmarkX = iconLeft + iconInkWidth + inkGap - wordmarkInkLeft * wordmarkScale;
    lockupWidth = wordmarkX + 160 + 3;
    lockupIcon = place(svg, iconLeft - 9 * iconScale, wordmarkInkTop - 38 * iconScale, 128 * iconScale, variant.stem + '-lockup');
    lockupSizing = { method: 'visible icon matches wordmark ink height', iconInkHeight: 52 * iconScale, wordmarkInkHeight: wordmarkInkBottom - wordmarkInkTop, iconInkWidth, inkGap, iconScale };
  }
  const lockup = `<svg xmlns="http://www.w3.org/2000/svg" width="${lockupWidth}" height="42" viewBox="0 0 ${lockupWidth} 42" fill="none">${lockupIcon}<g transform="translate(${wordmarkX} ${wordmarkY}) scale(${wordmarkScale})">${body(wordmark)}</g></svg>`;
  await fs.writeFile(path.join(dir, variant.stem + '-lockup.svg'), lockup + '\n');
  await sharp(Buffer.from(lockup), { density: 288 }).png().toFile(path.join(dir, variant.stem + '-lockup.png'));

  const raw = await sharp(pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = raw.info;
  const alphaAt = (x, y) => raw.data[(y * width + x) * channels + 3];
  assert.deepEqual([alphaAt(0, 0), alphaAt(width - 1, 0), alphaAt(0, height - 1), alphaAt(width - 1, height - 1)], [0, 0, 0, 0]);
  let solid = 0;
  for (let offset = 0; offset < raw.data.length; offset += channels) {
    if (raw.data[offset + 3] === 255) {
      assert.deepEqual(Array.from(raw.data.subarray(offset, offset + 3)), [249, 201, 50]);
      solid++;
    }
  }
  assert(solid > 0);
  rendered.push({ ...variant, svg, previous, lockup, lockupWidth, lockupSizing, validation: { dimensions: [width, height], transparentCorners: true, exactOpaqueGold: true, opaquePixels: solid } });
}

const sections = rendered.map((variant, i) => {
  const x = i * 800;
  return [
    text(x + 64, 169, `${variant.number} · ${variant.name}`, 28),
    text(x + 64, 204, variant.detail, 18, '#A5A9B0'),
    place(variant.svg, x + 180, 238, 440, `${variant.number}-main`),
    `<g transform="translate(${x + 400 - variant.lockupWidth * (350 / 227) / 2} 710) scale(${350 / 227})">${namespace(body(variant.lockup), variant.number + '-wordmark')}</g>`,
    `<line x1="${x + 64}" x2="${x + 736}" y1="824" y2="824" stroke="#292C31"/>`,
    text(x + 64, 866, 'PREVIOUS', 13, '#767D87', 'letter-spacing="2"'),
    place(variant.previous, x + 64, 886, 136, `${variant.number}-previous`),
    text(x + 274, 866, 'REFINED', 13, '#767D87', 'letter-spacing="2"'),
    place(variant.svg, x + 274, 886, 136, `${variant.number}-refined`),
    text(x + 497, 866, 'ICON SIZES', 13, '#767D87', 'letter-spacing="2"'),
    place(variant.svg, x + 497, 925, 24, `${variant.number}-24`),
    place(variant.svg, x + 548, 921, 32, `${variant.number}-32`),
    place(variant.svg, x + 608, 913, 48, `${variant.number}-48`),
    text(x + 498, 984, '24', 12, '#767D87'),
    text(x + 555, 984, '32', 12, '#767D87'),
    text(x + 625, 984, '48', 12, '#767D87'),
  ].join('\n');
}).join('\n');
const comparison = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1060" viewBox="0 0 1600 1060" fill="none">
  <rect width="1600" height="1060" fill="${background}"/>
  ${text(64, 71, 'kollens', 32)}
  ${text(1536, 67, 'CHEVRON REFINEMENTS', 14, '#A5A9B0', 'text-anchor="end" letter-spacing="3"')}
  <line x1="64" x2="1536" y1="112" y2="112" stroke="#292C31"/>
  <line x1="800" x2="800" y1="145" y2="1020" stroke="#292C31"/>
  ${sections}
</svg>`;
await fs.writeFile(path.join(dir, 'comparison.svg'), comparison + '\n');
await sharp(Buffer.from(comparison)).png().toFile(path.join(dir, 'comparison.png'));

const firstLockup = rendered[0];
const lockupProofScale = 3.5;
const lockupProof = `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="300" viewBox="0 0 1100 300" fill="none"><rect width="1100" height="300" fill="${background}"/><g transform="translate(${(1100 - firstLockup.lockupWidth * lockupProofScale) / 2} ${(300 - 42 * lockupProofScale) / 2}) scale(${lockupProofScale})">${body(firstLockup.lockup)}</g></svg>`;
await sharp(Buffer.from(lockupProof)).png().toFile(path.join(dir, '33-wedge-chevron-bold-lockup-sized-preview.png'));

const qa = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="176" viewBox="0 0 800 176" fill="none">
  <rect width="800" height="176" fill="${background}"/>
  ${rendered.map((variant, i) => text(24 + i * 400, 32, `${variant.number} · ${variant.name}`, 18) + [24, 32, 48].map((size, j) => place(variant.svg, 24 + i * 400 + j * 110, 84 - size / 2, size, `qa-${variant.number}-${size}`) + text(24 + i * 400 + j * 110, 142, `${size} px`, 12, '#A5A9B0')).join('')).join('')}
</svg>`;
await sharp(Buffer.from(qa)).png().toFile(path.join(dir, 'small-size-proof.png'));
await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
  brand: 'kollens', gold, method: 'Exact editable SVG geometry refinement',
  request: 'Option 3 bolder and more minimal, closer to the triangle-and-chevron reference, with its visible icon sized to the text height; option 4 has equal line weight throughout.',
  options: rendered.map(({ number, name, stem, previous, detail, lockupSizing, validation }) => ({ number, name, stem, previous, detail, lockupSizing, validation })),
  preview: 'comparison.png', iconSizes: [24, 32, 48],
}, null, 2) + '\n');
console.log(JSON.stringify({ comparison: 'comparison.png', exported: rendered.map(v => v.stem), validated: true }));
