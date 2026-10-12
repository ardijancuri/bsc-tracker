import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const folder = path.dirname(fileURLToPath(import.meta.url));
const entries = [
  ['57-focus-lens', '57 · Focus lens', 'Focus corners and an angular optical opening'],
  ['58-curved-k-lens', '58 · Curved K', 'A curved K forms the side of the lens'],
  ['59-diagonal-lens', '59 · Diagonal lens', 'Parallel strokes meet an optical center'],
  ['60-split-k-lens', '60 · Split K lens', 'A lens replaces the lower K arm'],
];
const header = await readFile(path.join(folder, '../../public/kollens-header-logo.svg'), 'utf8');
const wordmark = header.slice(header.indexOf('<svg x="53"'));
const iconHousing = '<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg width="42" height="42" viewBox="0 0 128 128" x="0" y="0">';
const composites = [];
for (let i = 0; i < entries.length; i++) {
  const [stem, title, description] = entries[i];
  const source = await readFile(path.join(folder, `${stem}.svg`), 'utf8');
  const inner = source.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title[^>]*>.*?<\/title>/, '');
  const lockup = iconHousing + inner + '</svg>' + wordmark;
  await writeFile(path.join(folder, `${stem}-header.svg`), lockup);
  const preview = await sharp(Buffer.from(source)).resize(250, 250).png().toBuffer();
  await writeFile(path.join(folder, `${stem}.png`), preview);
  const x = (i % 2) * 520;
  const y = Math.floor(i / 2) * 430;
  composites.push({ input: preview, left: x + 135, top: y + 24 });
  const label = `<svg width="520" height="72"><text x="260" y="28" text-anchor="middle" font-family="Arial, sans-serif" font-size="23" font-weight="600" fill="#f3f5f6">${title}</text><text x="260" y="58" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" fill="#8e979b">${description}</text></svg>`;
  composites.push({ input: Buffer.from(label), left: x, top: y + 280 });
  const actualHeader = await sharp(Buffer.from(lockup)).resize({ height: 30 }).png().toBuffer();
  const { width } = await sharp(actualHeader).metadata();
  composites.push({ input: actualHeader, left: x + Math.round((520 - width) / 2), top: y + 374 });
}
await sharp({ create: { width: 1040, height: 860, channels: 4, background: '#0b0e11' } })
  .composite(composites).png().toFile(path.join(folder, 'comparison-round-18.png'));
console.log('Created four reference-inspired native lens SVGs and header previews.');
