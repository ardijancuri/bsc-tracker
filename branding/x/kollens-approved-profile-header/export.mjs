import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const output = new URL('./', import.meta.url);
const root = new URL('../../../', import.meta.url);
await mkdir(output, { recursive: true });
const icon = await readFile(new URL('public/kollens-icon-yellow.svg', root), 'utf8');
const profileSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="#000000"/><g transform="translate(160 160) scale(5.5)">${icon.trim()}</g></svg>\n`;

const files = [
  ['kollens-x-profile-400.png', profileSvg, 400, 400],
  ['kollens-x-profile-1024.png', profileSvg, 1024, 1024],
];
const exports = [];
for (const [name, svg, width, height] of files) {
  const buffer = await sharp(Buffer.from(svg), { density: 144 })
    .resize(width, height)
    .removeAlpha()
    .png()
    .toBuffer();
  await writeFile(new URL(name, output), buffer);
  const metadata = await sharp(buffer).metadata();
  if (metadata.width !== width || metadata.height !== height || metadata.hasAlpha) {
    throw new Error(`Invalid export: ${name}`);
  }
  exports.push({ name, width, height, bytes: buffer.length });
}
await writeFile(new URL('kollens-x-profile.svg', output), profileSvg);
await writeFile(new URL('manifest.json', output), JSON.stringify({
  name: 'Kollens X profile',
  rendering: 'Native SVG rendering; original K path is preserved with uniform scaling.',
  background: '#000000',
  icon: '#F9C932',
  sources: [
    { path: 'public/kollens-icon-yellow.svg', sha256: createHash('sha256').update(icon).digest('hex') },
  ],
  platformReference: 'https://help.x.com/en/managing-your-account/how-to-customize-your-profile',
  safeZones: 'Profile K is centered inside the circular crop.',
  exports,
}, null, 2) + '\n');
console.log(JSON.stringify(exports));
