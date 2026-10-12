import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const file = name => new URL(name, import.meta.url);
const original = await readFile(file('kollens-launch-post-20261012-v4.png'));
const {width, height} = await sharp(original).metadata();

// Restore exact native branding and launch copy, with soft background edges.
const regions = [
  {left: 50, top: 50, width: 500, height: 130},
  {left: 55, top: 275, width: 745, height: 165},
  {left: 65, top: 440, width: 910, height: 90},
  {left: 65, top: 530, width: 630, height: 85},
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

const variants = process.argv.slice(2);
for (const variant of variants.length ? variants : ['prism', 'ribbon', 'contour']) {
  if (!['prism', 'ribbon', 'contour'].includes(variant)) throw new Error(`Unknown variant: ${variant}`);
  const prefix = `kollens-launch-post-20261012-v6-${variant}`;
  const target = file(`${prefix}.png`);
  await sharp(await readFile(file(`${prefix}-generated.png`)))
    .resize(width, height, {fit: 'fill'})
    .composite(overlays)
    .png()
    .toFile(fileURLToPath(target));

  const finished = await readFile(target);
  for (const region of regions) {
    const interior = {left: region.left + 10, top: region.top + 10, width: region.width - 20, height: region.height - 20};
    const before = await sharp(original).extract(interior).removeAlpha().raw().toBuffer();
    const after = await sharp(finished).extract(interior).removeAlpha().raw().toBuffer();
    if (!before.equals(after)) throw new Error(`The original logo or copy changed in ${variant}.`);
  }
  console.log(`Saved ${prefix}.png (${width} × ${height}); exact logo and copy verified.`);
}
