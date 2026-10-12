import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('C:/Users/PC/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');

const directory = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const variants = [
  {
    file: '05-rounded-iris', title: 'kollens Rounded Iris',
    description: 'A calm fourfold aperture with a larger rounded opening and gently rounded blade ends.',
    blade: 'M 8 55 V 40 C 8 22.326888 22.326888 8 40 8 H 54 C 74 8 86 23 81 44 C 80.5 46.1 78.4 46.6 77 45.1 C 74.2 42.1 71 41 67 41 H 64 C 40 41 15 32 11 54 C 10.690909 55.7 8 56.7 8 55 Z',
    transform: '',
  },
  {
    file: '06-diamond-iris', title: 'kollens Diamond Iris',
    description: 'A compact diamond aperture with fuller circular shoulders and bolder blades, formed from four exact quarter-turn copies.',
    blade: 'M 10 55 V 46 C 10 26.117749 26.117749 10 46 10 H 53 C 72 10 84 25 80 45 C 79.5 47.5 77.4 48.1 75.8 46.2 C 73.4 43.35 71 43 67 43 H 64 C 42 43 18 33 13 54 C 12.595238 55.7 10 56.7 10 55 Z',
    transform: 'translate(64 64) rotate(45) scale(0.9) translate(-64 -64)',
  },
  {
    file: '07-open-iris', title: 'kollens Open Iris',
    description: 'A spacious square aperture with an enlarged central opening and broad, evenly spaced flowing blades.',
    blade: 'M 8 53 V 40 C 8 22.326888 22.326888 8 40 8 H 52 C 70 8 82 23 79 42 C 78.68 44.026667 76.6 44.8 75.1 43 C 72.1 39.4 69 38 64 38 H 61 C 40 38 15 31 10.8 52 C 10.46 53.7 8 54.7 8 53 Z',
    transform: '',
  },
];

await fs.mkdir(directory, {recursive: true});
for (const variant of variants) {
  const id = `${variant.file}-blade`;
  const transform = variant.transform ? ` transform="${variant.transform}"` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">\n  <title>${variant.title}</title>\n  <desc>${variant.description}</desc>\n  <defs>\n    <path id="${id}" d="${variant.blade}"/>\n  </defs>\n  <g fill="#F9C932"${transform}>\n    <use href="#${id}"/>\n    <use href="#${id}" transform="rotate(90 64 64)"/>\n    <use href="#${id}" transform="rotate(180 64 64)"/>\n    <use href="#${id}" transform="rotate(270 64 64)"/>\n  </g>\n</svg>\n`;
  await fs.writeFile(path.join(directory, `${variant.file}.svg`), svg);
  await sharp(Buffer.from(svg)).resize(640, 640).flatten({background: '#101113'}).png().toFile(path.join(directory, `${variant.file}-proof.png`));
  const {data} = await sharp(Buffer.from(svg)).resize(24, 24).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  const seen = new Uint8Array(24 * 24), componentSizes = [];
  for (let i = 0; i < 24 * 24; i++) {
    if (seen[i] || data[i * 4 + 3] < 128) continue;
    const queue = [i]; seen[i] = 1; let count = 0;
    while (queue.length) {
      const p = queue.pop(), x = p % 24, y = Math.floor(p / 24); count++;
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= 24 || ny >= 24) continue;
        const q = ny * 24 + nx;
        if (!seen[q] && data[q * 4 + 3] >= 128) {seen[q] = 1; queue.push(q);}
      }
    }
    componentSizes.push(count);
  }
  console.log(JSON.stringify({file: `${variant.file}.svg`, componentsAt24: componentSizes.length, componentSizes, transparentCorner: data[3] === 0}));
}
