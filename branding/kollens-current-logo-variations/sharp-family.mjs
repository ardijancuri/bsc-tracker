import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const directory = path.dirname(fileURLToPath(import.meta.url));
const variants = [
  {
    file: '11-flat-cut', title: 'Flat Cut',
    description: 'The current five curved bent shutter strokes with flat end caps and crisp mitered bends.',
    attributes: 'fill="none" stroke="#F9C932" stroke-width="16" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="3"',
    path: 'M64 17 A47 47 0 0 1 95.45 29.07 L81 52',
  },
  {
    file: '12-faceted-shutter', title: 'Faceted Shutter',
    description: 'The current five-blade shutter arrangement with a two-facet outer shoulder and sharp diagonal inner legs.',
    attributes: 'fill="none" stroke="#F9C932" stroke-width="16" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="3"',
    path: 'M64 17 L81 20 L95.45 29.07 L81 52',
  },
  {
    file: '13-pointed-shutter', title: 'Pointed Shutter',
    description: 'Five identical filled blades preserve the curved outer shoulder while the inner legs taper to a chiseled angular cut.',
    attributes: 'fill="#F9C932"',
    path: 'M64 9 A55 55 0 0 1 100.802183 23.126035 L105.16 29.5 L83.5 57 L75.5 51.5 L90.095532 35.016185 A39 39 0 0 0 64 25 Z',
  },
];

for (const v of variants) {
  const id = `${v.file}-blade`;
  const rotations = Array.from({ length: 5 }, (_, i) => `    <use href="#${id}" transform="rotate(${i * 72} 64 64)"/>`).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">\n  <title>Kollens ${v.title}</title>\n  <desc>${v.description} One blade repeats at exact 72-degree intervals.</desc>\n  <defs><path id="${id}" d="${v.path}"/></defs>\n  <g ${v.attributes}>\n${rotations}\n  </g>\n</svg>\n`;
  await fs.writeFile(path.join(directory, `${v.file}.svg`), svg);
  await sharp(Buffer.from(svg), { density: 600 }).resize(768, 768).flatten({ background: '#101113' }).png().toFile(path.join(directory, `${v.file}-proof.png`));
  const small = await sharp(Buffer.from(svg)).resize(24, 24).flatten({ background: '#101113' }).png().toBuffer();
  await sharp(small).resize(240, 240, { kernel: 'nearest' }).png().toFile(path.join(directory, `${v.file}-small-proof.png`));
  const { data } = await sharp(Buffer.from(svg)).resize(128, 128).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = 128, minY = 128, maxX = -1, maxY = -1;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    if (data[(y * 128 + x) * 4 + 3] > 128) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  }
  console.log(JSON.stringify({ file: v.file, bounds: [minX, minY, maxX, maxY], centerAlpha: data[(64 * 128 + 64) * 4 + 3], cornerAlpha: data[3] }));
}
