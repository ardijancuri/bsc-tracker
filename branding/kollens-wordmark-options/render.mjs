import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const background = '#101113';
const white = '#F3F5F6';
const gold = '#F9C932';
const variants = [
  { id: '23-clean-manrope', number: 23, name: 'Clean', face: 'Manrope 700' },
  { id: '24-geometric-gothic', number: 24, name: 'Geometric', face: 'Century Gothic Bold' },
  { id: '25-airy-manrope', number: 25, name: 'Airy', face: 'Manrope 600' },
  { id: '26-compact-segoe', number: 26, name: 'Compact', face: 'Segoe UI Bold' },
];
const stripSvg = svg => svg.replace(/^\s*<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<(title|desc)>[\s\S]*?<\/\1>/g, '').trim();
await mkdir(folder, { recursive: true });
const tiles = [];
for (let index = 0; index < variants.length; index += 1) {
  const variant = variants[index];
  const svg = await readFile(path.join(folder, `${variant.id}.svg`), 'utf8');
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
  if (!viewBox) throw new Error(`Missing viewBox for ${variant.id}`);
  const [,, width, height] = viewBox.split(/\s+/).map(Number);
  const ratio = width / height;
  const largeHeight = Math.min(110, 650 / ratio);
  const largeWidth = largeHeight * ratio;
  const goldSvg = svg.replace(/#f3f5f6/gi, gold);
  const whiteInner = `<g fill="${white}">${stripSvg(svg)}</g>`;
  const goldInner = `<g fill="${gold}">${stripSvg(goldSvg)}</g>`;
  await writeFile(path.join(folder, `${variant.id}-gold.svg`), goldSvg);
  await sharp(Buffer.from(svg), { density: 288 }).resize({ width: 1600 }).png().toFile(path.join(folder, `${variant.id}-white-transparent.png`));
  await sharp(Buffer.from(goldSvg), { density: 288 }).resize({ width: 1600 }).png().toFile(path.join(folder, `${variant.id}-gold-transparent.png`));
  const smallHeight = 26;
  const smallWidth = ratio * smallHeight;
  const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="480"><rect width="1200" height="480" fill="${background}"/><svg x="${(1200 - ratio * 150) / 2}" y="165" width="${ratio * 150}" height="150" viewBox="${viewBox}">${whiteInner}</svg></svg>`;
  await sharp(Buffer.from(preview)).png().toFile(path.join(folder, `${variant.id}-preview.png`));
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="440"><rect width="900" height="440" fill="${background}"/><text x="450" y="58" text-anchor="middle" fill="#A2ABB2" font-family="Arial,sans-serif" font-size="21">${variant.number} · ${variant.name}</text><svg x="${(900 - largeWidth) / 2}" y="145" width="${largeWidth}" height="${largeHeight}" viewBox="${viewBox}">${whiteInner}</svg><text x="450" y="309" text-anchor="middle" fill="#79838C" font-family="Arial,sans-serif" font-size="18">${variant.face}</text><svg x="${(900 - smallWidth) / 2}" y="361" width="${smallWidth}" height="${smallHeight}" viewBox="${viewBox}">${goldInner}</svg></svg>`;
  tiles.push({ input: await sharp(Buffer.from(tile)).png().toBuffer(), left: (index % 2) * 900, top: Math.floor(index / 2) * 440 });
}
await sharp({ create: { width: 1800, height: 880, channels: 4, background } }).composite(tiles).png().toFile(path.join(folder, 'comparison.png'));
await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ brand: 'kollens', style: 'Typography only; original font glyphs, no icon or decorative letter changes.', background, white, gold, method: 'Real local font glyphs outlined as portable native SVG paths, with font kerning and deliberate tracking.', variants }, null, 2) + '\n');
console.log('Rendered four typography-only wordmarks with white and gold SVGs, transparent PNGs, and comparison.png.');
