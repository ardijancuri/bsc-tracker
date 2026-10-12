import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const folder = path.dirname(fileURLToPath(import.meta.url));
const entries = [
  { stem: '26-offset-optic', label: '26 · Original', description: 'Existing proportions' },
  { stem: '46-offset-balanced', label: '46 · Balanced', description: 'Equal gaps · 10 units', weight: 14 },
  { stem: '47-offset-airy', label: '47 · Airy', description: 'Equal gaps · 12 units', weight: 12 },
  { stem: '48-offset-bold', label: '48 · Bold', description: 'Equal gaps · 8 units', weight: 16 },
];
const point = (radius, degrees) => {
  const radians = degrees * Math.PI / 180;
  return `${(64 + radius * Math.cos(radians)).toFixed(3)} ${(64 + radius * Math.sin(radians)).toFixed(3)}`;
};
const arc = (radius, start, end) => `M ${point(radius, start)} A ${radius} ${radius} 0 1 0 ${point(radius, end)}`;
const header = await readFile(path.join(folder, '../../public/kollens-header-logo.svg'), 'utf8');
const wordmark = header.slice(header.indexOf('<svg x="53"'));
const iconHousing = '<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg width="42" height="42" viewBox="0 0 128 128" x="0" y="0">';
const composites = [];

for (let i = 0; i < entries.length; i++) {
  const { stem, label, description, weight } = entries[i];
  let source;
  if (weight) {
    source = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-labelledby="title">
  <title id="title">Kollens ${label.slice(5).toLowerCase()} offset optic icon</title>
  <g fill="none" stroke="#f9c932" stroke-width="${weight}" stroke-linecap="round" stroke-linejoin="round">
    <path d="${arc(48, -44, 17)}"/>
    <path d="${arc(24, 164, -94)}"/>
  </g>
  <circle cx="64" cy="64" r="${weight / 2}" fill="#f9c932"/>
</svg>
`;
    await writeFile(path.join(folder, `${stem}.svg`), source);
  } else {
    source = await readFile(path.join(folder, `${stem}.svg`), 'utf8');
  }
  const inner = source.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title[^>]*>.*?<\/title>/, '');
  await writeFile(path.join(folder, `${stem}-header.svg`), iconHousing + inner + '</svg>' + wordmark);
  const iconPreview = await sharp(Buffer.from(source)).resize(236, 236).png().toBuffer();
  if (weight) await writeFile(path.join(folder, `${stem}.png`), iconPreview);
  const x = (i % 2) * 520;
  const y = Math.floor(i / 2) * 430;
  composites.push({ input: iconPreview, left: x + 142, top: y + 30 });
  const caption = `<svg width="520" height="75"><text x="260" y="26" text-anchor="middle" font-family="Arial, sans-serif" font-size="23" font-weight="600" fill="#f3f5f6">${label}</text><text x="260" y="56" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" fill="#8e979b">${description}</text></svg>`;
  composites.push({ input: Buffer.from(caption), left: x, top: y + 278 });
  const lockup = await sharp(Buffer.from(iconHousing + inner + '</svg>' + wordmark)).resize({ height: 30 }).png().toBuffer();
  const { width } = await sharp(lockup).metadata();
  composites.push({ input: lockup, left: x + Math.round((520 - width) / 2), top: y + 373 });
}
await sharp({ create: { width: 1040, height: 860, channels: 4, background: '#0b0e11' } })
  .composite(composites).png().toFile(path.join(folder, 'comparison-round-13.png'));
console.log('Created three concentric Offset Optic variants with equal radial clearances.');
