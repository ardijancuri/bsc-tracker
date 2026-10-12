import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const folder = path.dirname(fileURLToPath(import.meta.url));
const entries = [
  ['49-rounded-square-optic', '49 · Rounded square', 'Matching rounded corners'],
  ['50-half-rounded-corner-optic', '50 · 50% corner', 'Bottom-left corner rounded to half the side'],
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
  const preview = await sharp(Buffer.from(source)).resize(280, 280).png().toBuffer();
  await writeFile(path.join(folder, `${stem}.png`), preview);
  const x = i * 520;
  composites.push({ input: preview, left: x + 120, top: 30 });
  const label = `<svg width="520" height="70"><text x="260" y="28" text-anchor="middle" font-family="Arial, sans-serif" font-size="23" font-weight="600" fill="#f3f5f6">${title}</text><text x="260" y="58" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" fill="#8e979b">${description}</text></svg>`;
  composites.push({ input: Buffer.from(label), left: x, top: 328 });
  const actualHeader = await sharp(Buffer.from(lockup)).resize({ height: 30 }).png().toBuffer();
  const { width } = await sharp(actualHeader).metadata();
  composites.push({ input: actualHeader, left: x + Math.round((520 - width) / 2), top: 420 });
}
await sharp({ create: { width: 1040, height: 495, channels: 4, background: '#0b0e11' } })
  .composite(composites).png().toFile(path.join(folder, 'comparison-round-14.png'));
console.log('Created two transparent square optic SVGs and header previews.');
