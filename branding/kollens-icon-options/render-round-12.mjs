import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const folder = path.dirname(fileURLToPath(import.meta.url));
const entries = [
  ['43-geometric-shutter', '43 · Geometric shutter'],
  ['44-open-k-optic', '44 · Open K optic'],
  ['45-focus-shutter', '45 · Focus shutter'],
];
const header = await readFile(path.join(folder, '../../public/kollens-header-logo.svg'), 'utf8');
const wordmark = header.slice(header.indexOf('<svg x="53"'));
const iconHousing = '<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg width="42" height="42" viewBox="0 0 128 128" x="0" y="0">';
const composites = [];
for (let i = 0; i < entries.length; i++) {
  const [stem, title] = entries[i];
  const source = await readFile(path.join(folder, `${stem}.svg`), 'utf8');
  const inner = source.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title[^>]*>.*?<\/title>/, '');
  const lockup = iconHousing + inner + '</svg>' + wordmark;
  await writeFile(path.join(folder, `${stem}-header.svg`), lockup);
  const preview = await sharp(Buffer.from(source)).resize(256, 256).png().toBuffer();
  await writeFile(path.join(folder, `${stem}.png`), preview);
  const x = i * 400;
  composites.push({ input: preview, left: x + 72, top: 36 });
  const label = `<svg width="400" height="42"><text x="200" y="28" text-anchor="middle" font-family="Arial, sans-serif" font-size="21" font-weight="600" fill="#f3f5f6">${title}</text></svg>`;
  composites.push({ input: Buffer.from(label), left: x, top: 324 });
  const actualHeader = await sharp(Buffer.from(lockup)).resize({ height: 30 }).png().toBuffer();
  const { width } = await sharp(actualHeader).metadata();
  composites.push({ input: actualHeader, left: x + Math.round((400 - width) / 2), top: 384 });
}
await sharp({ create: { width: 1200, height: 460, channels: 4, background: '#0b0e11' } })
  .composite(composites).png().toFile(path.join(folder, 'comparison-round-12.png'));
console.log('Rendered three clean lens icons and header previews.');
