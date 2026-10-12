import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const directory = path.dirname(fileURLToPath(import.meta.url));
const n = value => Number(value.toFixed(6));

const upperStemEnd = n(106 - Math.sqrt(46 ** 2 - 40 ** 2));
const focusUpperStem = `M12 10 H24 A28 28 0 0 1 52 38 V60 A46 46 0 0 0 12 ${upperStemEnd} Z`;
const focusLowerStem = 'M12 90 H22 A30 30 0 0 1 52 120 H40 A28 28 0 0 1 12 92 Z';
const focusWing = 'M58 60 V53 A45.816667 45.816667 0 0 0 88 10 H118 A60 60 0 0 1 58 60 Z';

const foldStem = 'M12 14 H30 A22 22 0 0 1 52 36 V61 H48 A36 36 0 0 1 12 25 Z';
const shoulderX = n(96 - 56 / Math.sqrt(5));
const shoulderY = n(42 - 28 / Math.sqrt(5));
const foldCapY = n(shoulderY + (shoulderX - 58) * 2);
// The outer 3-unit fillet is internally tangent to the 47-unit optical arc.
const filletX = 71 + Math.sqrt(44 ** 2 - 3 ** 2);
const filletJoinX = 71 + (filletX - 71) * 47 / 44;
const filletJoinY = 14 + 3 * 47 / 44;
const foldWing = `M58 61 V${foldCapY} L${shoulderX} ${shoulderY} A28 28 0 0 1 96 14 H${n(filletX)} A3 3 0 0 1 ${n(filletJoinX)} ${n(filletJoinY)} A47 47 0 0 1 71 61 Z`;

const variants = [
  {
    file: '31-arc-focus', title: 'Arc Focus',
    description: 'Four broad circular facets form an optical K with a taller curved left shoulder, a small lower facet, and two mirrored refracting wings. Six-unit central gaps keep the facets separate.',
    elements: `  <defs><path id="arc-focus-wing" d="${focusWing}"/></defs>\n  <path d="${focusUpperStem}"/>\n  <path d="${focusLowerStem}"/>\n  <use href="#arc-focus-wing"/>\n  <use href="#arc-focus-wing" transform="translate(0 126) scale(1 -1)"/>`,
  },
  {
    file: '32-curved-fold', title: 'Curved Fold',
    description: 'A mirrored segmented spine and two identical folding optical wings form a compact K. Shared circular radii, tangent shoulder curves, and six-unit central gaps create calm precision.',
    elements: `  <defs>\n    <path id="curved-fold-stem" d="${foldStem}"/>\n    <path id="curved-fold-wing" d="${foldWing}"/>\n  </defs>\n  <use href="#curved-fold-stem"/>\n  <use href="#curved-fold-stem" transform="translate(0 128) scale(1 -1)"/>\n  <use href="#curved-fold-wing"/>\n  <use href="#curved-fold-wing" transform="translate(0 128) scale(1 -1)"/>`,
  },
];

for (const v of variants) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="#F9C932">\n  <title>Kollens ${v.title}</title>\n  <desc>${v.description}</desc>\n${v.elements}\n</svg>\n`;
  await fs.writeFile(path.join(directory, `${v.file}.svg`), svg);
  await sharp(Buffer.from(svg),{density:600}).resize(768,768).flatten({background:'#101113'}).png().toFile(path.join(directory,`${v.file}-proof.png`));
  const small = await sharp(Buffer.from(svg)).resize(24,24).flatten({background:'#101113'}).png().toBuffer();
  await sharp(small).resize(240,240,{kernel:'nearest'}).png().toFile(path.join(directory,`${v.file}-small-proof.png`));
  const {data}=await sharp(Buffer.from(svg)).resize(128,128).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let minX=128,minY=128,maxX=-1,maxY=-1;
  for(let y=0;y<128;y++)for(let x=0;x<128;x++)if(data[(y*128+x)*4+3]>128){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y)}
  console.log(JSON.stringify({file:v.file,bounds:[minX,minY,maxX,maxY],cornerAlpha:data[3]}));
}
