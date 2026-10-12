import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const folder = path.dirname(fileURLToPath(import.meta.url));
const fmt = value => Number(value.toFixed(9));
const point = value => value.map(fmt).join(' ');
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Construct circular fillets from exact tangent setbacks on each polygon edge.
function filletedPolygon(vertices, radii) {
  const corners = vertices.map((vertex, index) => {
    const previous = vertices[(index + vertices.length - 1) % vertices.length];
    const next = vertices[(index + 1) % vertices.length];
    const incoming = previous.map((value, axis) => (value - vertex[axis]) / distance(previous, vertex));
    const outgoing = next.map((value, axis) => (value - vertex[axis]) / distance(next, vertex));
    const angle = Math.acos(Math.max(-1, Math.min(1, incoming[0] * outgoing[0] + incoming[1] * outgoing[1])));
    const radius = radii[index];
    const setback = radius ? radius / Math.tan(angle / 2) : 0;
    return {
      entry: vertex.map((value, axis) => value + incoming[axis] * setback),
      exit: vertex.map((value, axis) => value + outgoing[axis] * setback),
      setback, radius,
    };
  });
  for (let index = 0; index < vertices.length; index += 1) {
    const next = (index + 1) % vertices.length;
    if (corners[index].setback + corners[next].setback >= distance(vertices[index], vertices[next])) {
      throw new Error(`Fillets overlap on polygon edge ${index}`);
    }
  }
  let result = `M${point(corners[0].exit)}`;
  for (let step = 1; step <= vertices.length; step += 1) {
    const corner = corners[step % vertices.length];
    result += `L${point(corner.entry)}`;
    if (corner.radius) result += `A${corner.radius} ${corner.radius} 0 0 1 ${point(corner.exit)}`;
  }
  return result + 'Z';
}

const spine = filletedPolygon([[16,16],[38,16],[50,28],[50,88],[26,112],[16,112]], [6,6,6,6,6,6]);
const wing = filletedPolygon([[56,46],[86,16],[112,16],[112,31],[82,61],[56,61]], [6,6,6,6,6,0]);
const softSplit = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Kollens soft split icon"><title>Kollens Soft Split</title><desc>Three original filled planes with exact six-unit circular corner fillets, forty-five-degree clipped edges, and six-unit separation. The wings are exact reflections across the horizontal centerline.</desc><defs><path id="kollens35-wing" d="${wing}"/></defs><g fill="#F9C932"><path d="${spine}"/><use href="#kollens35-wing"/><use href="#kollens35-wing" transform="translate(0 128) scale(1 -1)"/></g></svg>\n`;

const roundFacet = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Kollens round facet icon"><title>Kollens Round Facet</title><desc>Four solid optical facets combine twenty-two-and-a-half-unit semicircles with twenty-nine- and forty-five-unit circular quarter arcs. Circular shoulder joins are tangent; cut-plane ends remain crisp. Exact six-unit cuts separate every neighboring plane.</desc><defs><path id="kollens36-spine-facet" d="M38.5 16H52V61H38.5A22.5 22.5 0 0 1 38.5 16Z"/><path id="kollens36-wing-facet" d="M58 61V45A29 29 0 0 1 87 16H112A45 45 0 0 1 67 61H58Z"/></defs><g fill="#F9C932"><use href="#kollens36-spine-facet"/><use href="#kollens36-spine-facet" transform="translate(0 128) scale(1 -1)"/><use href="#kollens36-wing-facet"/><use href="#kollens36-wing-facet" transform="translate(0 128) scale(1 -1)"/></g></svg>\n`;

for (const [name, svg] of [['35-soft-split', softSplit], ['36-round-facet', roundFacet]]) {
  await writeFile(path.join(folder, `${name}.svg`), svg);
  await sharp(Buffer.from(svg), { density: 288 }).resize(768,768).flatten({ background:'#101113' }).png().toFile(path.join(folder, `${name}-proof.png`));
  const small = await sharp(Buffer.from(svg), { density: 288 }).resize(24,24).flatten({ background:'#101113' }).png().toBuffer();
  await sharp(small).resize(240,240,{ kernel:'nearest' }).png().toFile(path.join(folder, `${name}-small-proof.png`));
}
console.log('Final 35/36 analytic SVGs and large/24px proofs written.');
