import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const folder = path.dirname(fileURLToPath(import.meta.url));
const entries = [
  ['25-soft-shutter', '25 · Soft shutter'],
  ['26-offset-optic', '26 · Offset optic'],
  ['27-folded-lens', '27 · Folded lens'],
  ['28-focus-orbit', '28 · Focus orbit'],
];
const header = await readFile(path.join(folder, '../../public/kollens-header-logo.svg'), 'utf8');
const wordmark = header.slice(header.indexOf('<svg x="53"'));
const composites = [];
for (let i = 0; i < entries.length; i++) {
  const [stem, title] = entries[i];
  const source = await readFile(path.join(folder, `${stem}.svg`), 'utf8');
  const inner = source.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const lockup = header.slice(0, header.indexOf('<g')) + inner + '</svg>' + wordmark;
  await writeFile(path.join(folder, `${stem}-header.svg`), lockup);
  const preview = await sharp(Buffer.from(source)).resize(256, 256).png().toBuffer();
  await writeFile(path.join(folder, `${stem}.png`), preview);
  const col = i % 2;
  const row = Math.floor(i / 2);
  const x = col * 520;
  const y = row * 420;
  composites.push({ input: preview, left: x + 132, top: y + 34 });
  const label = `<svg width="520" height="42"><text x="260" y="28" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="600" fill="#f3f5f6">${title}</text></svg>`;
  composites.push({ input: Buffer.from(label), left: x, top: y + 305 });
  const actualHeader = await sharp(Buffer.from(lockup)).resize({ height: 30 }).png().toBuffer();
  const { width } = await sharp(actualHeader).metadata();
  composites.push({ input: actualHeader, left: x + Math.round((520 - width) / 2), top: y + 360 });
}
await sharp({ create: { width: 1040, height: 840, channels: 4, background: '#0b0e11' } })
  .composite(composites).png().toFile(path.join(folder, 'comparison-round-7.png'));
console.log('Created four native SVG icons, header lockups and comparison-round-7.png.');
