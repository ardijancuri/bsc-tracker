import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const file = name => new URL(name, import.meta.url);
const original = await readFile(file('kollens-launch-post-20261012-v8.png'));
const {width, height} = await sharp(original).metadata();
const target = file('kollens-launch-post-20261012-v9.png');
const regions = [
  {left: 50, top: 50, width: 500, height: 130},
  {left: 55, top: 275, width: 745, height: 165},
  {left: 65, top: 440, width: 780, height: 85},
  {left: 65, top: 520, width: 550, height: 80},
  {left: 65, top: 680, width: 725, height: 65},
  {left: 65, top: 810, width: 280, height: 70},
];
const overlays = [];
for (const region of regions) {
  const pixels = await sharp(original).extract(region).ensureAlpha().raw().toBuffer();
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const edge = Math.min(x, y, region.width - 1 - x, region.height - 1 - y);
      pixels[(y * region.width + x) * 4 + 3] = Math.round(255 * Math.min(1, edge / 10));
    }
  }
  const input = await sharp(pixels, {raw: {width: region.width, height: region.height, channels: 4}}).png().toBuffer();
  overlays.push({input, left: region.left, top: region.top});
}

await sharp(await readFile(file('kollens-launch-post-20261012-v9-generated.png')))
  .resize(width, height, {fit: 'fill'})
  .composite(overlays).png().toFile(fileURLToPath(target));

const finished = await readFile(target);
for (const region of regions) {
  const interior = {left: region.left + 16, top: region.top + 16, width: region.width - 32, height: region.height - 32};
  const before = await sharp(original).extract(interior).removeAlpha().raw().toBuffer();
  const after = await sharp(finished).extract(interior).removeAlpha().raw().toBuffer();
  if (!before.equals(after)) throw new Error('The existing branding or smaller copy changed.');
}
console.log(`Saved ${width} × ${height} matte lens image; existing branding and typography verified.`);
