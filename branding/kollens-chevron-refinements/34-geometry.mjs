import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const outputDir = path.dirname(fileURLToPath(import.meta.url));
const width = 20;
const halfWidth = width / 2;
const centerRadius = 12;
const innerRadius = centerRadius - halfWidth;
const outerRadius = centerRadius + halfWidth;
const gold = '#F9C932';
const round = value => Number(value.toFixed(9));
const point = (x, y) => `${round(x)} ${round(y)}`;
const root2 = Math.SQRT2;
const top = 14;
const bottom = 114;

// A 135-degree fold connects the vertical stem to a 45-degree branch.
const leftX = 22;
const leftVertexY = 55;
const leftLineSum = leftX + leftVertexY;
const leftCenter = [leftX + centerRadius, leftVertexY - centerRadius * (root2 + 1)];
const leftInnerStart = [leftCenter[0] - innerRadius, leftCenter[1]];
const leftInnerEnd = [leftCenter[0] + innerRadius / root2, leftCenter[1] + innerRadius / root2];
const leftOuterStart = [leftCenter[0] - outerRadius, leftCenter[1]];
const leftOuterEnd = [leftCenter[0] + outerRadius / root2, leftCenter[1] + outerRadius / root2];
const leftInnerCapX = leftLineSum - halfWidth * root2 - top;
const leftOuterCapX = leftLineSum + halfWidth * root2 - top;
const leftPath = [
  `M ${point(leftX - halfWidth, top)}`,
  `H ${round(leftX + halfWidth)}`,
  `V ${round(leftInnerStart[1])}`,
  `A ${innerRadius} ${innerRadius} 0 0 0 ${point(...leftInnerEnd)}`,
  `L ${point(leftInnerCapX, top)}`,
  `H ${round(leftOuterCapX)}`,
  `L ${point(...leftOuterEnd)}`,
  `A ${outerRadius} ${outerRadius} 0 0 1 ${point(...leftOuterStart)}`,
  'Z',
].join(' ');

// A 90-degree fold has concentric inner and outer arcs, 20 units apart.
const rightVertex = [52, 64];
const rightLineSum = rightVertex[0] + rightVertex[1];
const rightCenter = [rightVertex[0] + centerRadius * root2, rightVertex[1]];
const rightInnerTop = [rightCenter[0] - innerRadius / root2, rightCenter[1] - innerRadius / root2];
const rightInnerBottom = [rightInnerTop[0], rightCenter[1] + innerRadius / root2];
const rightOuterTop = [rightCenter[0] - outerRadius / root2, rightCenter[1] - outerRadius / root2];
const rightOuterBottom = [rightOuterTop[0], rightCenter[1] + outerRadius / root2];
const rightOuterCapX = rightLineSum - halfWidth * root2 - top;
const rightInnerCapX = rightLineSum + halfWidth * root2 - top;
const rightPath = [
  `M ${point(rightOuterCapX, top)}`,
  `H ${round(rightInnerCapX)}`,
  `L ${point(...rightInnerTop)}`,
  `A ${innerRadius} ${innerRadius} 0 0 0 ${point(...rightInnerBottom)}`,
  `L ${point(rightInnerCapX, bottom)}`,
  `H ${round(rightOuterCapX)}`,
  `L ${point(...rightOuterBottom)}`,
  `A ${outerRadius} ${outerRadius} 0 0 1 ${point(...rightOuterTop)}`,
  'Z',
].join(' ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" fill="none" role="img" aria-label="Kollens equal weight flow chevron icon">
  <title>Kollens Equal Weight Flow Chevron</title>
  <desc>Three filled folded bands share a perpendicular width of twenty units. Every circular bend has concentric two-unit inner and twenty-two-unit outer radii. Mirrored left facets and horizontal terminal cuts preserve the original flow chevron construction.</desc>
  <defs><path id="flow34-even-left" d="${leftPath}"/></defs>
  <g fill="${gold}">
    <use href="#flow34-even-left"/>
    <use href="#flow34-even-left" transform="translate(0 128) scale(1 -1)"/>
    <path id="flow34-even-right" d="${rightPath}"/>
  </g>
</svg>
`;
const metadata = {
  name: '34 Equal Weight Flow Chevron', gold, transparent: true,
  viewBox: [0, 0, 128, 128],
  commonPerpendicularWidth: width,
  curveRadii: { center: centerRadius, inner: innerRadius, outer: outerRadius, radialBand: outerRadius - innerRadius },
  terminalCuts: { top, bottom, orientation: 'horizontal' },
  leftFold: {
    verticalStemWidth: width, diagonalBandWidth: width,
    vertex: [leftX, leftVertexY], center: leftCenter.map(round),
    turnDegrees: 135, horizontalMirrorAxis: 64,
    diagonalBoundarySums: [round(leftLineSum - halfWidth * root2), round(leftLineSum + halfWidth * root2)],
  },
  rightFold: {
    upperBandWidth: width, lowerBandWidth: width,
    vertex: rightVertex, center: rightCenter.map(round), turnDegrees: 90,
    diagonalBoundarySums: [round(rightLineSum - halfWidth * root2), round(rightLineSum + halfWidth * root2)],
  },
  minimumParallelGap: round((rightLineSum - leftLineSum) / root2 - width),
  bounds: [leftX - halfWidth, top, round(rightInnerCapX), bottom],
  construction: 'Filled SVG paths with exact parallel offsets and concentric circular arcs; no strokes, filters, or embedded raster',
  previous: {
    file: '../kollens-geometric-reference-round-2/34-flow-chevron.svg',
    leftVerticalWidth: 15,
    leftDiagonalWidth: round((67.798989873 - 46) / root2),
    rightDiagonalWidth: round(32 / root2),
    rightInnerRadius: 6, rightOuterRadius: 8,
  },
};

await fs.writeFile(path.join(outputDir, '34-flow-chevron-even.svg'), svg);
await fs.writeFile(path.join(outputDir, '34-geometry.json'), JSON.stringify(metadata, null, 2) + '\n');
await sharp(Buffer.from(svg), { density: 576 }).resize(1024, 1024).png().toFile(path.join(outputDir, '34-flow-chevron-even-transparent.png'));
await sharp(Buffer.from(svg), { density: 576 }).resize(1024, 1024).flatten({ background: '#101113' }).png().toFile(path.join(outputDir, '34-flow-chevron-even-proof.png'));
console.log(JSON.stringify({ svg: '34-flow-chevron-even.svg', commonWidth: width, arcWidth: outerRadius - innerRadius, minimumGap: metadata.minimumParallelGap }));
