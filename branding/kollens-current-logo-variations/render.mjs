import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const background = '#101113';
const gold = '#F9C932';
const stripSvg = svg => svg.replace(/^\s*<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<(title|desc)>[\s\S]*?<\/\1>/g, '').trim();
const wordmark = stripSvg(await readFile(path.join(folder, '../../public/kollens-wordmark.svg'), 'utf8'));
const variants = [
  { id: '11-flat-cut', number: 11, name: 'Flat cut', summary: 'The current five-blade geometry with flat ends and crisp mitred bends.' },
  { id: '12-faceted-shutter', number: 12, name: 'Faceted shutter', summary: 'Angular outer edges and straight, clean optical cuts.' },
  { id: '13-pointed-shutter', number: 13, name: 'Pointed shutter', summary: 'Curved shoulders paired with sharper chiseled blade tips.' },
  { id: '14-bold-shutter', number: 14, name: 'Bold shutter', summary: 'Broader compact blades with sharp cuts and a stronger silhouette.' },
  { id: '15-open-shutter', number: 15, name: 'Open shutter', summary: 'More open optics and lighter, precisely cut blades.' },
  { id: '16-angular-iris', number: 16, name: 'Angular iris', summary: 'Five faceted blades arranged around an angular optical opening.' },
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
const sourceIcon = await readFile(path.join(folder, '../../public/kollens-icon.svg'), 'utf8');
const sourceHeader = await readFile(path.join(folder, '../../public/kollens-header-logo.svg'), 'utf8');
await writeFile(path.join(folder, 'source-current.svg'), sourceIcon);
await writeFile(path.join(folder, 'source-current-header.svg'), sourceHeader);
await sharp(Buffer.from(sourceIcon), { density: 576 }).resize(1024, 1024).png().toFile(path.join(folder, 'source-current-transparent.png'));

const headerViewBox = sourceHeader.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 183.939 42';
const headerWidth = Number(headerViewBox.split(/\s+/)[2]);
const headerHeight = Number(headerViewBox.split(/\s+/)[3]);
const baselineWidth = 440;
const baselineHeight = baselineWidth * headerHeight / headerWidth;
const banner = `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="240"><rect width="1800" height="240" fill="${background}"/><text x="900" y="47" text-anchor="middle" fill="#A8ADB5" font-family="Arial,sans-serif" font-size="22">Current app logo</text><svg x="${(1800 - baselineWidth) / 2}" y="92" width="${baselineWidth}" height="${baselineHeight}" viewBox="${headerViewBox}">${stripSvg(sourceHeader)}</svg></svg>`;
const tiles = [{ input: await sharp(Buffer.from(banner)).png().toBuffer(), left: 0, top: 0 }];

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
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="620"><rect width="600" height="620" fill="${background}"/><svg x="132" y="38" width="336" height="336" viewBox="0 0 128 128">${inner}</svg><text x="300" y="451" text-anchor="middle" fill="#F3F5F6" font-family="Arial,sans-serif" font-size="24">${variant.number} · ${variant.name}</text></svg>`;
  tiles.push({ input: await sharp(Buffer.from(tile)).composite([{ input: small, left: Math.round((600 - smallWidth) / 2), top: 526 }]).png().toBuffer(), left: (index % 3) * 600, top: 240 + Math.floor(index / 3) * 620 });
}
await sharp({ create: { width: 1800, height: 1480, channels: 4, background } }).composite(tiles).png().toFile(path.join(folder, 'comparison.png'));
await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ brand: 'kollens', gold, background, method: 'Native SVG variations of the current app logo. Fivefold shutter structure retained; sharp edges and geometric cuts explored.', sourceIcon: '../../public/kollens-icon.svg', sourceHeader: '../../public/kollens-header-logo.svg', sourceSnapshots: ['source-current.svg', 'source-current-header.svg'], variants }, null, 2) + '\n');
console.log('Rendered the current app logo plus six native SVG refinements, transparent PNGs, lockups, and comparison.png.');
