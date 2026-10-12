import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const file = name => new URL(name, import.meta.url);
const original = await readFile(file('kollens-launch-post-20261012-v11.png'));
const {width, height} = await sharp(original).metadata();
const target = file('kollens-launch-post-20261012-v12.png');
const regions = [
  {left: 50, top: 50, width: 500, height: 130},
  {left: 55, top: 275, width: 745, height: 165},
  {left: 65, top: 440, width: 780, height: 85},
  {left: 65, top: 520, width: 550, height: 80},
  {left: 65, top: 680, width: 725, height: 65},
  {left: 65, top: 810, width: 280, height: 70},
];
const overlays = [];
const tokenOverlays = [];
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

// Use original token artwork in the illustrated slots, with only resize and
// ellipse clipping to match the lens perspective. ImageGen does not redraw it.
const tokenSlots = [
  {name: 'wangchai', left: 1083, top: 317, width: 68, height: 76},
  {name: 'funds-are-safu', left: 1080, top: 417, width: 70, height: 77},
  {name: 'green-morning', left: 1079, top: 519, width: 72, height: 80},
];
for (const slot of tokenSlots) {
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${slot.width}" height="${slot.height}"><ellipse cx="${slot.width / 2}" cy="${slot.height / 2}" rx="${slot.width / 2}" ry="${slot.height / 2}" fill="white"/></svg>`);
  const input = await sharp(await readFile(file(`references-v11/${slot.name}.png`)))
    .resize(slot.width, slot.height, {fit: 'fill'}).ensureAlpha()
    .composite([{input: mask, blend: 'dest-in'}]).png().toBuffer();
  const overlay = {input, left: slot.left, top: slot.top};
  tokenOverlays.push(overlay);
  overlays.push(overlay);
}

let generated;
try {
  generated = await readFile(file('kollens-launch-post-20261012-v12-generated-corrected.png'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  generated = await readFile(file('kollens-launch-post-20261012-v12-generated.png'));
}
await sharp(generated)
  .resize(width, height, {fit: 'fill'})
  .composite(overlays).png().toFile(fileURLToPath(target));

const finished = await readFile(target);
for (const region of regions) {
  const interior = {left: region.left + 16, top: region.top + 16, width: region.width - 32, height: region.height - 32};
  const before = await sharp(original).extract(interior).removeAlpha().raw().toBuffer();
  const after = await sharp(finished).extract(interior).removeAlpha().raw().toBuffer();
  if (!before.equals(after)) throw new Error('The existing branding or smaller copy changed.');
}
for (const overlay of tokenOverlays) {
  const meta = await sharp(overlay.input).metadata();
  const interior = {left: 16, top: 16, width: meta.width - 32, height: meta.height - 32};
  const expected = await sharp(overlay.input).extract(interior).removeAlpha().raw().toBuffer();
  const actual = await sharp(finished).extract({...interior, left: overlay.left + 16, top: overlay.top + 16}).removeAlpha().raw().toBuffer();
  if (!expected.equals(actual)) throw new Error('An original token image changed in the final composition.');
}
console.log(`Saved ${width} × ${height} circular glass lens image; native branding, typography and original token artwork verified.`);
