import sharp from 'sharp';
import { readFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const folder = path.dirname(fileURLToPath(import.meta.url));
const generatedFolder = 'C:/Users/PC/.codex/generated_images/01a0deed-e93b-7573-9540-7d96188a7440';
const generatedProfile = path.join(generatedFolder, 'exec-f6fae0a7-600a-4adc-b955-bbd876f3cb35.png');
const generatedHeader = path.join(generatedFolder, 'exec-4aefe7a1-f80d-4720-aa05-2b837e26ae44.png');
await copyFile(generatedProfile, path.join(folder, 'kollens-x-profile-balanced-20261012-generated.png'));
await copyFile(generatedHeader, path.join(folder, 'kollens-x-header-balanced-20261012-generated.png'));
const icon = await readFile(path.join(folder, '../kollens-icon-options/46-offset-balanced.svg'), 'utf8');
const black = (width, height) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/></svg>`);
const solidGold = async input => {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    data[i] = 249;
    data[i + 1] = 201;
    data[i + 2] = 50;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
};

// Preserve the generated profile's black canvas and replace the mark with native geometry.
const profileIcon = await solidGold(await sharp(Buffer.from(icon)).resize(860, 860).png().toBuffer());
await sharp(generatedProfile).resize(1254, 1254).flatten({ background: '#000' }).composite([
  { input: black(1004, 1004), left: 125, top: 125 },
  { input: profileIcon, left: 197, top: 197 },
]).removeAlpha().png().toFile(path.join(folder, 'kollens-x-profile-balanced-20261012.png'));

// Reuse the source typography exactly; the generated edit supplies the remaining black canvas.
const text = await sharp(path.join(folder, 'kollens-x-header-20261012-v6.png'))
  .extract({ left: 1232, top: 230, width: 648, height: 245 }).png().toBuffer();
const trimmed = await sharp(Buffer.from(icon)).resize(1024, 1024).trim().png().toBuffer();
const headerIcon = await solidGold(await sharp(trimmed).resize({ height: 210 }).png().toBuffer());
const iconMetadata = await sharp(headerIcon).metadata();
const iconX = Math.round(1111.5 - iconMetadata.width / 2);
const iconY = 233;
const inner = icon.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title[^>]*>.*?<\/title>/, '')
  .replaceAll('#f9c932', 'url(#wmTone)');
const watermark = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2172" height="724" viewBox="0 0 2172 724">
  <defs><linearGradient id="wmTone" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#131618"/><stop offset="1" stop-color="#0d0f11"/></linearGradient></defs>
  <svg x="-330" y="-157" width="1079" height="1079" viewBox="0 0 128 128">${inner}</svg>
</svg>`);
const headerBase = await sharp(generatedHeader).resize(2172, 724).flatten({ background: '#000' }).composite([
  { input: black(750, 724), left: 0, top: 0 },
  { input: black(265, 290), left: 980, top: 200 },
]).png().toBuffer();
const headerOutput = path.join(folder, 'kollens-x-header-balanced-20261012.png');
await sharp(headerBase).composite([
  { input: watermark, left: 0, top: 0 },
  { input: text, left: 1232, top: 230 },
  { input: headerIcon, left: iconX, top: iconY },
]).removeAlpha().png().toFile(headerOutput);
await sharp(headerOutput).resize(1500, 500).png().toFile(path.join(folder, 'kollens-x-header-balanced-20261012-1500.png'));

// Verify the preserved type and all fully covered icon pixels.
const sourceText = await sharp(text).removeAlpha().raw().toBuffer();
const finalText = await sharp(headerOutput).extract({ left: 1232, top: 230, width: 648, height: 245 }).raw().toBuffer();
if (!sourceText.equals(finalText)) throw new Error('Header text pixels differ from the approved v6 source.');
const { data, info } = await sharp(headerIcon).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let fullyCovered = 0;
for (let i = 0; i < data.length; i += info.channels) {
  if (data[i + 3] === 255) {
    fullyCovered++;
    if (data[i] !== 249 || data[i + 1] !== 201 || data[i + 2] !== 50) throw new Error('Icon gold differs from #F9C932.');
  }
}
console.log(JSON.stringify({ profile: '1254x1254', header: '2172x724', uploadHeader: '1500x500', typography: 'pixel-identical to v6', gold: '#F9C932', fullyCoveredIconPixels: fullyCovered, iconX, iconY }));
