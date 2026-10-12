import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const gold = '#F9C932';
const background = '#101113';
const white = '#F3F5F6';
const n = value => Number(value.toFixed(6));
const wordmarkSource = await readFile(path.join(folder, '../../public/kollens-wordmark.svg'), 'utf8');
const wordmark = wordmarkSource.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

function linkedLenses({ id, distance, stroke, clearance, woven }) {
  const radius = 72;
  const offset = distance / (2 * Math.SQRT2);
  const first = [128 - offset, 128 + offset];
  const second = [128 + offset, 128 - offset];
  const crossingOffset = Math.sqrt(radius ** 2 - (distance / 2) ** 2) / Math.SQRT2;
  const northwest = [128 - crossingOffset, 128 - crossingOffset];
  const southeast = [128 + crossingOffset, 128 + crossingOffset];
  const circle = (center, attributes = '') => `<circle cx="${n(center[0])}" cy="${n(center[1])}" r="${radius}" ${attributes}/>`;
  const cut = (suffix, crossing, over) => `<clipPath id="${id}-${suffix}-clip"><circle cx="${n(crossing[0])}" cy="${n(crossing[1])}" r="36"/></clipPath><mask id="${id}-${suffix}-mask" x="0" y="0" width="256" height="256" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:luminance"><rect width="256" height="256" fill="white"/>${circle(over, `fill="none" stroke="black" stroke-width="${stroke + 2 * clearance}" clip-path="url(#${id}-${suffix}-clip)"`)}</mask>`;
  const definitions = woven ? `<defs>${cut('nw', northwest, first)}${cut('se', southeast, second)}</defs>` : '';
  const firstMask = woven ? `mask="url(#${id}-se-mask)"` : '';
  const secondMask = woven ? `mask="url(#${id}-nw-mask)"` : '';
  const inner = `${definitions}<g fill="none" stroke="${gold}" stroke-width="${stroke}">${circle(first, firstMask)}${circle(second, secondMask)}</g>`;
  return { inner, geometry: { radius, distance, stroke, clearance, woven, centers: [first, second], crossings: [northwest, southeast] } };
}

const variations = [
  { id: '01-continuous', name: 'Continuous', description: 'Two complete circular lenses with a closed almond-shaped center.', distance: 88, stroke: 24, clearance: 0, woven: false },
  { id: '02-interlocked', name: 'Interlocked', description: 'Equal circular lenses with two symmetrical over-and-under crossings.', distance: 88, stroke: 24, clearance: 4.5, woven: true },
  { id: '03-compact', name: 'Compact', description: 'Closer lenses with a bolder ring and slightly more open crossover clearance.', distance: 80, stroke: 26, clearance: 5, woven: true },
];

await mkdir(folder, { recursive: true });
const tiles = [];
const manifest = [];
for (let index = 0; index < variations.length; index += 1) {
  const option = variations[index];
  const { inner, geometry } = linkedLenses(option);
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="Kollens ${option.name.toLowerCase()} linked lenses">${inner}</svg>\n`;
  const lockup = `<svg xmlns="http://www.w3.org/2000/svg" width="432" height="84" viewBox="0 0 432 84" role="img" aria-label="kollens"><svg x="0" y="0" width="84" height="84" viewBox="0 0 256 256">${inner}</svg><svg x="110" y="4.6" width="320" height="74.8" viewBox="0 0 145.488 34">${wordmark}</svg></svg>\n`;
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000"><rect width="1000" height="1000" fill="${background}"/><svg x="260" y="150" width="480" height="480" viewBox="0 0 256 256">${inner}</svg><svg x="250" y="681" width="500" height="116.848" viewBox="0 0 145.488 34">${wordmark}</svg></svg>`;
  await writeFile(path.join(folder, `${option.id}.svg`), icon);
  await writeFile(path.join(folder, `${option.id}-lockup.svg`), lockup);
  await sharp(Buffer.from(icon), { density: 288 }).png().toFile(path.join(folder, `${option.id}-transparent.png`));
  await sharp(Buffer.from(preview)).png().toFile(path.join(folder, `${option.id}-preview.png`));
  await sharp(Buffer.from(lockup), { density: 144 }).png().toFile(path.join(folder, `${option.id}-lockup.png`));
  const smallSizes = [24, 32, 48];
  for (const size of smallSizes) await sharp(Buffer.from(icon), { density: 288 }).resize(size, size).png().toFile(path.join(folder, `${option.id}-${size}px.png`));
  const small = await sharp(Buffer.from(lockup), { density: 144 }).resize({ height: 32 }).png().toBuffer();
  const smallWidth = (await sharp(small).metadata()).width;
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="750"><rect width="600" height="750" fill="${background}"/><svg x="132" y="76" width="336" height="336" viewBox="0 0 256 256">${inner}</svg><svg x="124" y="450" width="352" height="82.261" viewBox="0 0 145.488 34">${wordmark}</svg><text x="300" y="601" text-anchor="middle" fill="${white}" font-family="Arial,sans-serif" font-size="22">${index + 1} · ${option.name}</text></svg>`;
  tiles.push({ input: await sharp(Buffer.from(tile)).composite([{ input: small, left: Math.round((600 - smallWidth) / 2), top: 672 }]).png().toBuffer(), left: index * 600, top: 0 });
  manifest.push({ ...option, geometry, icon: `${option.id}.svg`, lockup: `${option.id}-lockup.svg`, preview: `${option.id}-preview.png`, transparentPng: `${option.id}-transparent.png` });
}
await sharp({ create: { width: 1800, height: 750, channels: 4, background } }).composite(tiles).png().toFile(path.join(folder, 'comparison.png'));
await writeFile(path.join(folder, 'geometry.json'), JSON.stringify({ brand: 'kollens', gold, background, wordmarkSource: '../../public/kollens-wordmark.svg', variations: manifest }, null, 2) + '\n');
console.log('Exported three precise linked-lens SVGs, transparent PNGs, lockups, small-size previews, and comparison.png.');
