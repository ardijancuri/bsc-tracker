import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('C:/Users/PC/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const directory = path.dirname(fileURLToPath(import.meta.url));

const variants = [
  {file:'14-bold-shutter', title:'kollens Bold Shutter', description:'A compact fivefold shutter with broad circular shoulders, flat end cuts, and crisp beveled bends.',
   geometry:'M 64 19 A 45 45 0 0 1 94.110877 30.558484 L 83.5 51.8',
   attributes:'fill="none" stroke="#F9C932" stroke-width="18" stroke-linecap="butt" stroke-linejoin="bevel"'},
  {file:'15-open-shutter', title:'kollens Open Shutter', description:'A lighter fivefold shutter with an enlarged optical opening, controlled circular arcs, flat caps, and equal rotational spacing.',
   geometry:'M 64 17 A 47 47 0 0 1 92.936291 26.963495 L 86.9 49.7',
   attributes:'fill="none" stroke="#F9C932" stroke-width="13.5" stroke-linecap="butt" stroke-linejoin="bevel"'},
  {file:'16-angular-iris', title:'kollens Angular Iris', description:'Five identical faceted aperture blades with sharp end cuts and a pentagonal optical counter.',
   geometry:'M 64 10 L 85 15 L 103 30 L 87 54 L 74 46 L 85 29 L 64 26 Z',
   attributes:'fill="#F9C932"'},
];

await fs.mkdir(directory,{recursive:true});
for (const variant of variants) {
  const id = `${variant.file}-blade`;
  const copies = [0,72,144,216,288].map(angle=>`    <use href="#${id}"${angle ? ` transform="rotate(${angle} 64 64)"` : ''}/>`).join('\n');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">\n  <title>${variant.title}</title>\n  <desc>${variant.description}</desc>\n  <defs>\n    <path id="${id}" d="${variant.geometry}" ${variant.attributes}/>\n  </defs>\n  <g>\n${copies}\n  </g>\n</svg>\n`;
  await fs.writeFile(path.join(directory,`${variant.file}.svg`),svg);
  await sharp(Buffer.from(svg)).resize(640,640).flatten({background:'#101113'}).png().toFile(path.join(directory,`${variant.file}-proof.png`));
  const smallProof = await sharp(Buffer.from(svg)).resize(24,24).flatten({background:'#101113'}).png().toBuffer();
  await sharp(smallProof).resize(240,240,{kernel:'nearest'}).png().toFile(path.join(directory,`${variant.file}-24px-proof.png`));
  const outputs=[];
  for (const side of [128,24]) {
    const {data} = await sharp(Buffer.from(svg)).resize(side,side).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const seen = new Uint8Array(side*side), componentSizes=[];
    let xmin=side,ymin=side,xmax=-1,ymax=-1;
    for(let i=0;i<side*side;i++) {
      if(data[i*4+3]>=128){const x=i%side,y=Math.floor(i/side);xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}
      if(seen[i]||data[i*4+3]<128)continue;
      const queue=[i];seen[i]=1;let count=0;
      while(queue.length){const p=queue.pop(),x=p%side,y=Math.floor(p/side);count++;for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=side||ny>=side)continue;const q=ny*side+nx;if(!seen[q]&&data[q*4+3]>=128){seen[q]=1;queue.push(q);}}}
      componentSizes.push(count);
    }
    outputs.push({side,components:componentSizes.length,componentSizes,bounds:[xmin,ymin,xmax,ymax],cornerAlpha:data[3]});
  }
  console.log(JSON.stringify({file:variant.file,qa:outputs}));
}
