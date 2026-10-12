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
  { id: '27-split-facet', number: 27, name: 'Split facet', summary: 'A clipped spine and two bold separated prism wings.' },
  { id: '28-diagonal-cut', number: 28, name: 'Diagonal cut', summary: 'A strong rising diagonal with two angular facets.' },
  { id: '29-folded-block', number: 29, name: 'Folded block', summary: 'Broad folded wings and a stable angular rail.' },
  { id: '30-offset-planes', number: 30, name: 'Offset planes', summary: 'Staggered solid planes with strong angular negative space.' },
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
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="720"><rect width="780" height="720" fill="${background}"/><svg x="190" y="64" width="400" height="400" viewBox="0 0 128 128">${inner}</svg><text x="390" y="555" text-anchor="middle" fill="#F3F5F6" font-family="Arial,sans-serif" font-size="26">${variant.number} · ${variant.name}</text></svg>`;
  tiles.push({ input: await sharp(Buffer.from(tile)).composite([{ input: small, left: Math.round((780 - smallWidth) / 2), top: 630 }]).png().toBuffer(), left: (index % 2) * 780, top: Math.floor(index / 2) * 720 });
}
await sharp({ create: { width: 1560, height: 1440, channels: 4, background } }).composite(tiles).png().toFile(path.join(folder, 'comparison.png'));
await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ brand: 'kollens', gold, background, method: 'Built-in ImageGen using three user-supplied style references, followed by exact native polygon reconstructions.', references: ['references/reference-1.webp', 'references/reference-2.png', 'references/reference-3.png'], variants }, null, 2) + '\n');
console.log('Rendered four bold geometric options, transparent PNGs, native wordmark lockups, small-size proofs, and comparison.png.');
