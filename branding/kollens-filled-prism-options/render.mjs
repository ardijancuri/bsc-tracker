import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const background = '#101113';
const gold = '#F9C932';
const stripSvg = svg => svg.replace(/^\s*<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<(title|desc)>[\s\S]*?<\/\1>/g, '').trim();
const wordmark = stripSvg(await readFile(path.join(folder, '../../public/kollens-wordmark.svg'), 'utf8'));
const variants = [
  { id: '17-lens-prism', number: 17, name: 'Lens prism', relation: 'Lens · clarity', summary: 'A solid faceted prism with a diagonal lens-shaped opening.' },
  { id: '18-refracted-focus', number: 18, name: 'Refracted focus', relation: 'Light · signals', summary: 'A prism with clean refracted optical cuts.' },
  { id: '19-shared-lens', number: 19, name: 'Shared lens', relation: 'KOLs · connected lenses', summary: 'Two optical openings connected within a single prism body.' },
  { id: '20-aperture-crystal', number: 20, name: 'Aperture crystal', relation: 'Optics · aperture', summary: 'Three bold crystal facets around a clear optical aperture.' },
  { id: '21-focus-facets', number: 21, name: 'Focus facets', relation: 'Focus · discovery', summary: 'Four broad prism facets around a focused central window.' },
  { id: '22-orbit-prism', number: 22, name: 'Orbit prism', relation: 'Lens · tracking', summary: 'Two solid orbiting prism faces framing an optical opening.' },
];

function innerSvg(svg, prefix) {
  const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
  const attributes = ['fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit']
    .map(name => root.match(new RegExp(`\\b${name}="[^"]*"`))?.[0]).filter(Boolean);
  if (!attributes.some(attribute => attribute.startsWith('fill='))) attributes.unshift(`fill="${gold}"`);
  let inner = stripSvg(svg);
  const ids = [...inner.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  for (const id of ids) inner = inner.replaceAll(`id="${id}"`, `id="${prefix}-${id}"`).replaceAll(`href="#${id}"`, `href="#${prefix}-${id}"`).replaceAll(`url(#${id})`, `url(#${prefix}-${id})`);
  return `<g ${attributes.join(' ')}>${inner}</g>`;
}

await mkdir(folder, { recursive: true });
const tiles = [];
for (let index = 0; index < variants.length; index += 1) {
  const variant = variants[index];
  const svg = await readFile(path.join(folder, `${variant.id}.svg`), 'utf8');
  const inner = innerSvg(svg, variant.id);
  const lockup = `<svg xmlns="http://www.w3.org/2000/svg" width="215" height="42" viewBox="0 0 215 42" role="img" aria-label="kollens"><svg x="0" y="0" width="42" height="42" viewBox="0 0 128 128">${inner}</svg><svg x="55" y="2.3" width="160" height="37.391" viewBox="0 0 145.488 34">${wordmark}</svg></svg>\n`;
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="${background}"/><svg x="260" y="150" width="480" height="480" viewBox="0 0 128 128">${inner}</svg><svg x="250" y="681" width="500" height="116.848" viewBox="0 0 145.488 34">${wordmark}</svg></svg>`;
  await writeFile(path.join(folder, `${variant.id}-lockup.svg`), lockup);
  await sharp(Buffer.from(svg), { density: 576 }).resize(1024, 1024).png().toFile(path.join(folder, `${variant.id}-transparent.png`));
  await sharp(Buffer.from(preview)).png().toFile(path.join(folder, `${variant.id}-preview.png`));
  await sharp(Buffer.from(lockup), { density: 288 }).png().toFile(path.join(folder, `${variant.id}-lockup.png`));
  for (const size of [24, 32, 48]) await sharp(Buffer.from(svg), { density: 576 }).resize(size, size).png().toFile(path.join(folder, `${variant.id}-${size}px.png`));
  const small = await sharp(Buffer.from(lockup), { density: 288 }).resize({ height: 32 }).png().toBuffer();
  const smallWidth = (await sharp(small).metadata()).width;
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="680"><rect width="600" height="680" fill="${background}"/><svg x="132" y="54" width="336" height="336" viewBox="0 0 128 128">${inner}</svg><text x="300" y="466" text-anchor="middle" fill="#F3F5F6" font-family="Arial,sans-serif" font-size="24">${variant.number} · ${variant.name}</text><text x="300" y="506" text-anchor="middle" fill="#8F989E" font-family="Arial,sans-serif" font-size="17">${variant.relation}</text></svg>`;
  tiles.push({ input: await sharp(Buffer.from(tile)).composite([{ input: small, left: Math.round((600 - smallWidth) / 2), top: 581 }]).png().toBuffer(), left: (index % 3) * 600, top: Math.floor(index / 3) * 680 });
}
await sharp({ create: { width: 1800, height: 1360, channels: 4, background } }).composite(tiles).png().toFile(path.join(folder, 'comparison.png'));
await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ brand: 'kollens', gold, background, method: 'Six built-in ImageGen concept explorations, followed by precise native SVG reconstructions and deterministic wordmark lockups.', sourceFolder: 'sources/', variants }, null, 2) + '\n');
console.log('Rendered six filled-prism concepts, transparent PNGs, native wordmark lockups, small-size proofs, and comparison.png.');
