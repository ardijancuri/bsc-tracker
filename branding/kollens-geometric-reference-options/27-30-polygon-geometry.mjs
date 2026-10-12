import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const directory = path.dirname(fileURLToPath(import.meta.url));
const variants = [
  {
    file: '27-split-facet', title: 'Split Facet',
    description: 'A clipped spine and two broad opposing prism wings use 45-degree cuts, with equal 8-unit vertical and horizontal gaps.',
    polygons: [
      [[12,38],[40,10],[40,118],[12,118]],
      [[48,42],[80,10],[118,10],[118,20],[78,60],[48,60]],
      [[48,68],[78,68],[118,108],[118,118],[80,118],[48,86]],
    ],
  },
  {
    file: '30-offset-planes', title: 'Offset Planes',
    description: 'A broad rising diagonal slab sits between two clipped opposing facets. Parallel 45-degree boundaries form equal 11.314-unit gaps.',
    polygons: [
      [[12,12],[60,12],[24,48],[12,48]],
      [[12,76],[76,12],[112,12],[48,76]],
      [[60,80],[82,58],[118,94],[118,118],[98,118]],
    ],
  },
];

for (const v of variants) {
  const polygons = v.polygons.map(points => `  <polygon points="${points.map(p => p.join(',')).join(' ')}"/>`).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="#F9C932">\n  <title>Kollens ${v.title}</title>\n  <desc>${v.description}</desc>\n${polygons}\n</svg>\n`;
  await fs.writeFile(path.join(directory, `${v.file}.svg`), svg);
  await sharp(Buffer.from(svg), { density: 600 }).resize(768, 768).flatten({ background: '#101113' }).png().toFile(path.join(directory, `${v.file}-proof.png`));
  const small = await sharp(Buffer.from(svg)).resize(24,24).flatten({ background: '#101113' }).png().toBuffer();
  await sharp(small).resize(240,240,{ kernel:'nearest' }).png().toFile(path.join(directory,`${v.file}-small-proof.png`));
  const { data } = await sharp(Buffer.from(svg)).resize(128,128).ensureAlpha().raw().toBuffer({ resolveWithObject:true });
  let minX=128, minY=128, maxX=-1, maxY=-1;
  for(let y=0;y<128;y++)for(let x=0;x<128;x++)if(data[(y*128+x)*4+3]>128){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y)}
  console.log(JSON.stringify({file:v.file,bounds:[minX,minY,maxX,maxY],cornerAlpha:data[3]}));
}
