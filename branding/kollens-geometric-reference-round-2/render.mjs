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
  { id: '31-arc-focus', number: 31, name: 'Arc focus', summary: 'Bold curved optical facets with clean K geometry.' },
  { id: '32-curved-fold', number: 32, name: 'Curved fold', summary: 'Matched curved folding wings and a compact split spine.' },
  { id: '33-wedge-chevron', number: 33, name: 'Wedge chevron', summary: 'A triangular wedge and a strong angular folded chevron.' },
  { id: '34-flow-chevron', number: 34, name: 'Flow chevron', summary: 'A softened chevron and two complementary side facets.' },
  { id: '35-soft-split', number: 35, name: 'Soft split', summary: 'Three broad split planes with rounded outer corners.' },
  { id: '36-round-facet', number: 36, name: 'Round facet', summary: 'Rounded optical shoulders and strong solid facets.' },
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
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="650"><rect width="600" height="650" fill="${background}"/><svg x="132" y="54" width="336" height="336" viewBox="0 0 128 128">${inner}</svg><text x="300" y="478" text-anchor="middle" fill="#F3F5F6" font-family="Arial,sans-serif" font-size="24">${variant.number} · ${variant.name}</text></svg>`;
  tiles.push({ input: await sharp(Buffer.from(tile)).composite([{ input: small, left: Math.round((600 - smallWidth) / 2), top: 554 }]).png().toBuffer(), left: (index % 3) * 600, top: Math.floor(index / 3) * 650 });
}
await sharp({ create: { width: 1800, height: 1300, channels: 4, background } }).composite(tiles).png().toFile(path.join(folder, 'comparison.png'));
await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ brand: 'kollens', gold, background, method: 'Built-in ImageGen using four user-supplied style references, followed by precise native geometry with controlled arcs, fillets, and cuts.', references: ['references/reference-1.png', 'references/reference-2.jpg', 'references/reference-3.jpg', 'references/reference-4.webp'], variants }, null, 2) + '\n');
console.log('Rendered six rounded and angular geometric options, transparent PNGs, native wordmark lockups, small-size proofs, and comparison.png.');
