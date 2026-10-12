import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const directory = path.dirname(fileURLToPath(import.meta.url));
const radians = degrees => degrees * Math.PI / 180;
const coordinate = n => Number(n.toFixed(6));
const point = (a, b, angle) => [64 + a * Math.cos(radians(angle)), 64 + b * Math.sin(radians(angle))];
const tangent = (a, b, angle, direction = 1) => [-a * Math.sin(radians(angle)) * direction, b * Math.cos(radians(angle)) * direction];
const offset = (p, t, amount) => [p[0] + t[0] * amount, p[1] + t[1] * amount];
const pair = p => p.map(coordinate).join(' ');

const options = [
  { file: '08-balanced-orbit', title: 'Balanced Orbit', a: 56, b: 56, r: 29, iStart: 10, iEnd: -150, oStart: -175, oEnd: -15, cap: .12, rotation: 45,
    description: 'A calm circular envelope and generous round opening with two broad swept crescents.' },
  { file: '09-swept-orbit', title: 'Swept Orbit', a: 66, b: 43, r: 28, iStart: 8, iEnd: -142, oStart: -174, oEnd: -10, cap: .12, rotation: 45,
    description: 'A directional diagonal oval with two broad curved crescents and a round optical opening.' },
  { file: '10-split-optic', title: 'Split Optic', a: 56, b: 56, r: 27, iStart: -10, iEnd: -170, oStart: -164, oEnd: -16, cap: .12, rotation: 0,
    description: 'Two quiet broad semicircular optic lobes separated by even horizontal optical cuts.' },
];

for (const o of options) {
  const innerStart = point(o.r, o.r, o.iStart);
  const innerEnd = point(o.r, o.r, o.iEnd);
  const outerStart = point(o.a, o.b, o.oStart);
  const outerEnd = point(o.a, o.b, o.oEnd);
  const leftA = offset(innerEnd, tangent(o.r, o.r, o.iEnd, -1), o.cap);
  const leftB = offset(outerStart, tangent(o.a, o.b, o.oStart), -o.cap);
  const rightA = offset(outerEnd, tangent(o.a, o.b, o.oEnd), o.cap);
  const rightB = offset(innerStart, tangent(o.r, o.r, o.iStart, -1), -o.cap);
  const d = `M ${pair(innerStart)} A ${o.r} ${o.r} 0 0 0 ${pair(innerEnd)} C ${pair(leftA)} ${pair(leftB)} ${pair(outerStart)} A ${o.a} ${o.b} 0 0 1 ${pair(outerEnd)} C ${pair(rightA)} ${pair(rightB)} ${pair(innerStart)} Z`;
  const id = `${o.file}-crescent`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="#F9C932">\n  <title>Kollens ${o.title}</title>\n  <desc>${o.description} One path is repeated by exactly 180 degrees.</desc>\n  <defs><path id="${id}" d="${d}"/></defs>\n  <g transform="rotate(${o.rotation} 64 64)">\n    <use href="#${id}"/>\n    <use href="#${id}" transform="rotate(180 64 64)"/>\n  </g>\n</svg>\n`;
  const svgPath = path.join(directory, `${o.file}.svg`);
  await fs.writeFile(svgPath, svg);
  await sharp(Buffer.from(svg), { density: 600 }).resize(768, 768).flatten({ background: '#101113' }).png().toFile(path.join(directory, `${o.file}-proof.png`));
  const small = await sharp(Buffer.from(svg)).resize(24, 24).flatten({ background: '#101113' }).png().toBuffer();
  await sharp(small).resize(240, 240, { kernel: 'nearest' }).png().toFile(path.join(directory, `${o.file}-small-proof.png`));
  const { data } = await sharp(Buffer.from(svg)).resize(128, 128).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = 128, minY = 128, maxX = -1, maxY = -1;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    if (data[(y * 128 + x) * 4 + 3] > 128) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  }
  console.log(JSON.stringify({ file: o.file, bounds: [minX, minY, maxX, maxY], centerAlpha: data[(64 * 128 + 64) * 4 + 3], cornerAlpha: data[3] }));
}
