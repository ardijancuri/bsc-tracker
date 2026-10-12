import sharp from 'sharp';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
await mkdir(folder, { recursive: true });
const sourcePath = path.join(folder, '../../kollens-current-logo-variations/11-flat-cut.svg');
const source = await readFile(sourcePath, 'utf8');
const icon = source.replace(/^\s*<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<(title|desc)>[\s\S]*?<\/\1>/g, '').trim();
const background = '#101113';
const gold = '#F9C932';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 400 400" role="img" aria-label="Kollens Flat Cut profile image"><title>Kollens X profile image</title><rect width="400" height="400" fill="${background}"/><svg x="40" y="40" width="320" height="320" viewBox="0 0 128 128">${icon}</svg></svg>\n`;
await writeFile(path.join(folder, 'kollens-x-profile-flat-cut.svg'), svg);

const files = [];
for (const size of [400, 1024]) {
  const name = `kollens-x-profile-flat-cut-${size}.png`;
  const output = path.join(folder, name);
  await sharp(Buffer.from(svg)).resize(size, size).removeAlpha().png({ compressionLevel: 9 }).toFile(output);
  const metadata = await sharp(output).metadata();
  const bytes = (await stat(output)).size;
  if (metadata.width !== size || metadata.height !== size || metadata.channels !== 3 || bytes >= 2_000_000) throw new Error(`Invalid profile export ${name}`);
  files.push({ file: name, width: size, height: size, bytes });
}

const upload = path.join(folder, 'kollens-x-profile-flat-cut-400.png');
const { data, info } = await sharp(upload).raw().toBuffer({ resolveWithObject: true });
let maxRadius = 0;
let solidGoldPixels = 0;
for (let y = 0; y < info.height; y += 1) {
  for (let x = 0; x < info.width; x += 1) {
    const i = (y * info.width + x) * info.channels;
    if (data[i] === 249 && data[i + 1] === 201 && data[i + 2] === 50) solidGoldPixels += 1;
    if (data[i] !== 16 || data[i + 1] !== 17 || data[i + 2] !== 19) maxRadius = Math.max(maxRadius, Math.hypot(x + 0.5 - 200, y + 0.5 - 200));
  }
}
if (solidGoldPixels === 0 || maxRadius >= 160) throw new Error('Profile mark color or circular-crop clearance is invalid.');

const circleMask = Buffer.from('<svg width="400" height="400"><circle cx="200" cy="200" r="200" fill="white"/></svg>');
const circle = await sharp(upload).ensureAlpha().composite([{ input: circleMask, blend: 'dest-in' }]).png().toBuffer();
const small48 = await sharp(circle).resize(48, 48).png().toBuffer();
const small128 = await sharp(circle).resize(128, 128).png().toBuffer();
await sharp({ create: { width: 720, height: 450, channels: 4, background: '#20242a' } }).composite([
  { input: circle, left: 24, top: 25 },
  { input: small128, left: 495, top: 93 },
  { input: small48, left: 535, top: 298 },
]).png().toFile(path.join(folder, 'circular-crop-check.png'));

await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({
  brand: 'kollens', source: '../../kollens-current-logo-variations/11-flat-cut.svg', sourceSha256: createHash('sha256').update(source).digest('hex'),
  background, gold, layout: { referenceCanvas: [400, 400], iconViewport: { x: 40, y: 40, width: 320, height: 320 }, wordmark: false },
  cropClearancePixels: Number((200 - maxRadius).toFixed(2)), solidGoldPixels, files,
  sizingReference: 'https://help.x.com/en/managing-your-account/common-issues-when-uploading-profile-photo',
  method: 'Exact native SVG compositing and PNG export; selected Flat Cut icon geometry preserved.',
}, null, 2) + '\n');
console.log(JSON.stringify({ files, circularCropClearancePx: Number((200 - maxRadius).toFixed(2)), solidGoldPixels }, null, 2));
