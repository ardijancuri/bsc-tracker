import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const file = name => new URL(name, import.meta.url);
const original = await readFile(file('kollens-launch-post-20261012-v7-trade-lens.png'));
const {width, height} = await sharp(original).metadata();
const target = file('kollens-launch-post-20261012-v8.png');
const overlays = [];
const regions = [
  {source: {left: 50, top: 50, width: 500, height: 130}},
  {source: {left: 55, top: 275, width: 745, height: 165}},
  {source: {left: 65, top: 440, width: 910, height: 90}, scale: 0.85, left: 67, top: 443},
  {source: {left: 65, top: 530, width: 630, height: 85}, scale: 0.85, left: 67, top: 523},
  {source: {left: 65, top: 680, width: 725, height: 65}},
  {source: {left: 65, top: 810, width: 280, height: 70}},
];

for (const {source, scale = 1, left = source.left, top = source.top} of regions) {
  const pixels = await sharp(original).extract(source).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const edge = Math.min(x, y, source.width - 1 - x, source.height - 1 - y);
      pixels[(y * source.width + x) * 4 + 3] = Math.round(255 * Math.min(1, edge / 10));
    }
  }
  const input = await sharp(pixels, {raw: {width: source.width, height: source.height, channels: 4}})
    .resize(Math.round(source.width * scale), Math.round(source.height * scale))
    .png().toBuffer();
  overlays.push({input, left, top});
}

let generated;
try {
  generated = await readFile(file('kollens-launch-post-20261012-v8-generated-corrected.png'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  generated = await readFile(file('kollens-launch-post-20261012-v8-generated.png'));
}
await sharp(generated)
  .resize(width, height, {fit: 'fill'})
  .composite(overlays).png().toFile(fileURLToPath(target));

const finished = await readFile(target);
for (const overlay of overlays) {
  const meta = await sharp(overlay.input).metadata();
  const interior = {left: 16, top: 16, width: meta.width - 32, height: meta.height - 32};
  const expected = await sharp(overlay.input).extract(interior).removeAlpha().raw().toBuffer();
  const actual = await sharp(finished).extract({...interior, left: overlay.left + 16, top: overlay.top + 16}).removeAlpha().raw().toBuffer();
  if (!expected.equals(actual)) throw new Error('The native branding or subtitle export changed.');
}
console.log(`Saved ${width} × ${height} launch image; native logo and copy verified, subtitles reduced 15%.`);
