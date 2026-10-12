import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const dir = path.dirname(fileURLToPath(import.meta.url));
const metadata = JSON.parse(await fs.readFile(path.join(dir, 'wordmark-geometry.json'), 'utf8'));
const background = '#101113';
const body = svg => svg.replace(/^\s*<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const options = [];

for (const record of metadata.options) {
  const svg = await fs.readFile(path.join(dir, record.file), 'utf8');
  assert.equal((svg.match(/data-letter="/g) ?? []).length, 7);
  assert.equal((svg.match(/data-letter="K"/g) ?? []).length, 1);
  const stem = record.file.replace('.svg', '');
  await sharp(Buffer.from(svg), { density: 288 }).resize({ width: 2400 }).png().toFile(path.join(dir, stem + '-transparent.png'));
  for (const height of [24, 32, 48]) {
    await sharp(Buffer.from(svg), { density: 288 }).resize({ height }).png().toFile(path.join(dir, `${stem}-${height}px.png`));
  }
  const visibleWidth = 1180;
  const scale = visibleWidth / record.width;
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="420" viewBox="0 0 1400 420" fill="none"><rect width="1400" height="420" fill="${background}"/><g transform="translate(${(1400 - visibleWidth) / 2} ${(420 - record.height * scale) / 2}) scale(${scale})">${body(svg)}</g></svg>`;
  await sharp(Buffer.from(preview)).png().toFile(path.join(dir, stem + '-preview.png'));
  options.push({ ...record, svg, stem });
}

const comparison = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="820" viewBox="0 0 1400 820" fill="none"><rect width="1400" height="820" fill="${background}"/>
  ${options.map((record, i) => {
    const y = i * 410;
    const scale = 1180 / record.width;
    return `<text x="80" y="${y + 60}" fill="#A5A9B0" font-family="Arial, sans-serif" font-size="16" letter-spacing="1.5">${i === 0 ? '01 · INTEGRATED K / WHITE' : '02 · INTEGRATED K / GOLD ACCENT'}</text><g transform="translate(110 ${y + 110}) scale(${scale})">${body(record.svg)}</g>`;
  }).join('\n')}
  <line x1="80" x2="1320" y1="410" y2="410" stroke="#292C31"/>
</svg>`;
await fs.writeFile(path.join(dir, 'comparison.svg'), comparison + '\n');
await sharp(Buffer.from(comparison)).png().toFile(path.join(dir, 'comparison.png'));

const smallProof = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="220" viewBox="0 0 960 220" fill="none"><rect width="960" height="220" fill="${background}"/>${options.map((record, i) => [24, 32, 48].map((height, j) => `<g transform="translate(${32 + i * 480} ${28 + j * 62}) scale(${height / record.height})">${body(record.svg)}</g>`).join('')).join('')}</svg>`;
await sharp(Buffer.from(smallProof)).png().toFile(path.join(dir, 'small-size-proof.png'));

await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
  brand: 'Kollens', approach: 'Custom K integrated as first letter, based on the supplied reference',
  sourceConcept: 'sources/37-integrated-k-generated-concept.png',
  sourceMethod: 'Built-in Codex ImageGen; final portable SVGs compose exact K geometry with outlined type',
  prompt: 'generation-prompt.txt',
  options: options.map(({ svg, ...record }) => record),
  comparison: 'comparison.png',
  validation: { spelling: 'Kollens', letters: 7, integratedKCount: 1, nativeTypeface: 'Manrope 800', KToOInkGap: 8, ascenderHeight: 160 },
}, null, 2) + '\n');
console.log(JSON.stringify({ exported: options.map(o => o.stem), preview: 'comparison.png', letters: 7 }));
