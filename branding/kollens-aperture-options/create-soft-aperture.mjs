import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const center = 64;
const outerRadius = 54;
const innerRadius = 23;
const twist = 56 * Math.PI / 180;
const number = value => Number(value.toFixed(6));
const point = pair => pair.map(number).join(' ');
const polar = (radius, angle) => [center + radius * Math.cos(angle), center + radius * Math.sin(angle)];

function spiralSegments(startDegrees) {
  const theta = startDegrees * Math.PI / 180;
  const radialChange = innerRadius - outerRadius;
  const at = t => polar(outerRadius + radialChange * t * t, theta + twist * t);
  const derivative = t => {
    const radius = outerRadius + radialChange * t * t;
    const radialDerivative = 2 * radialChange * t;
    const angle = theta + twist * t;
    return [radialDerivative * Math.cos(angle) - radius * twist * Math.sin(angle), radialDerivative * Math.sin(angle) + radius * twist * Math.cos(angle)];
  };
  return [0, 0.5].map(t => {
    const end = t + 0.5;
    const p0 = at(t), p1 = at(end), d0 = derivative(t), d1 = derivative(end);
    return [p0, p0.map((v, i) => v + d0[i] / 6), p1.map((v, i) => v - d1[i] / 6), p1];
  });
}

const start = 210;
const end = 316;
const first = polar(outerRadius, start * Math.PI / 180);
const outerEnd = polar(outerRadius, end * Math.PI / 180);
const innerStart = polar(innerRadius, (start + 56) * Math.PI / 180);
const inward = spiralSegments(end).map(([, c0, c1, finish]) => `C ${point(c0)} ${point(c1)} ${point(finish)}`).join(' ');
const outward = spiralSegments(start).reverse().map(([finish, c0, c1]) => `C ${point(c1)} ${point(c0)} ${point(finish)}`).join(' ');
const blade = `M ${point(first)} A ${outerRadius} ${outerRadius} 0 0 1 ${point(outerEnd)} ${inward} A ${innerRadius} ${innerRadius} 0 0 0 ${point(innerStart)} ${outward} Z`;
const inner = `<g fill="#F9C932">${[0, 120, 240].map(angle => `<path d="${blade}" transform="rotate(${angle} 64 64)"/>`).join('')}</g>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Kollens soft aperture icon">${inner}</svg>\n`;
await writeFile(path.join(folder, '01-soft-aperture.svg'), svg);
const proof = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768" viewBox="0 0 128 128"><rect width="128" height="128" fill="#101113"/>${inner}</svg>`;
await sharp(Buffer.from(proof)).png().toFile(path.join(folder, '01-soft-aperture-proof.png'));
await writeFile(path.join(folder, '01-geometry.json'), JSON.stringify({ center: [64, 64], outerRadius, innerRadius, repeatedBlades: 3, rotationStep: 120, bladeAngle: end - start, angularClearance: 120 - (end - start), spiralTwistDegrees: 56, blade }, null, 2) + '\n');
console.log('Created a threefold symmetric soft aperture with exact circular outer and inner arcs.');
