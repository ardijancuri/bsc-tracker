import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const background = '#101113';
const stripSvg = svg => svg.replace(/^\s*<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<(title|desc)>[\s\S]*?<\/\1>/g, '').trim();
const wordmark = stripSvg(await readFile(path.join(folder, '../../public/kollens-wordmark.svg'), 'utf8'));
const variants = [
  { id: '01-soft-aperture', name: 'Soft aperture', summary: 'Three repeated swept blades around a circular optical opening.' },
  { id: '02-focus-iris', name: 'Focus iris', summary: 'Four repeated curved blades with a softly square silhouette.' },
  { id: '03-optical-prism', name: 'Optical prism', summary: 'A rounded diamond containing a diagonal almond-shaped opening.' },
  { id: '04-orbit-lens', name: 'Orbit lens', summary: 'Two repeated curved lobes around a clear optical opening.' },
];
const tiles = [];
for (let index = 0; index < variants.length; index += 1) {
  const variant = variants[index];
  const svg = await readFile(path.join(folder, `${variant.id}.svg`), 'utf8');
  const inner = `<g fill="#F9C932">${stripSvg(svg)}</g>`;
  const lockup = `<svg xmlns="http://www.w3.org/2000/svg" width="215" height="42" viewBox="0 0 215 42" role="img" aria-label="kollens"><svg x="0" y="0" width="42" height="42" viewBox="0 0 128 128">${inner}</svg><svg x="55" y="2.3" width="160" height="37.391" viewBox="0 0 145.488 34">${wordmark}</svg></svg>\n`;
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="${background}"/><svg x="260" y="150" width="480" height="480" viewBox="0 0 128 128">${inner}</svg><svg x="250" y="681" width="500" height="116.848" viewBox="0 0 145.488 34">${wordmark}</svg></svg>`;
  await writeFile(path.join(folder, `${variant.id}-lockup.svg`), lockup);
  await sharp(Buffer.from(svg), { density: 576 }).png().toFile(path.join(folder, `${variant.id}-transparent.png`));
  await sharp(Buffer.from(preview)).png().toFile(path.join(folder, `${variant.id}-preview.png`));
  await sharp(Buffer.from(lockup), { density: 288 }).png().toFile(path.join(folder, `${variant.id}-lockup.png`));
  for (const size of [24, 32, 48]) await sharp(Buffer.from(svg), { density: 576 }).resize(size, size).png().toFile(path.join(folder, `${variant.id}-${size}px.png`));
  const small = await sharp(Buffer.from(lockup), { density: 288 }).resize({ height: 32 }).png().toBuffer();
  const smallWidth = (await sharp(small).metadata()).width;
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="750"><rect width="780" height="750" fill="${background}"/><svg x="190" y="64" width="400" height="400" viewBox="0 0 128 128">${inner}</svg><text x="390" y="555" text-anchor="middle" fill="#F3F5F6" font-family="Arial,sans-serif" font-size="27">${index + 1} · ${variant.name}</text></svg>`;
  const tilePng = await sharp(Buffer.from(tile)).composite([{ input: small, left: Math.round((780 - smallWidth) / 2), top: 632 }]).png().toBuffer();
  tiles.push({ input: tilePng, left: (index % 2) * 780, top: Math.floor(index / 2) * 750 });
}
await sharp({ create: { width: 1560, height: 1500, channels: 4, background } }).composite(tiles).png().toFile(path.join(folder, 'comparison.png'));
await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ brand: 'kollens', color: '#F9C932', background, production: 'Built-in ImageGen concept explorations followed by clean native SVG reconstructions.', variants }, null, 2) + '\n');
console.log('Rendered four exact-gold native icons, transparent PNGs, wordmark lockups, small-size proofs, and comparison.png.');
