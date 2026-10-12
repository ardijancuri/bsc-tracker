import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('C:/Users/PC/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const directory = path.dirname(fileURLToPath(import.meta.url));
const n = value => Number(value.toFixed(9));
const outerRadius=54, center=64, sqrt3=Math.sqrt(3);
const halfWidth=outerRadius*sqrt3/2;
const hex=`M 64 10 L ${n(center+halfWidth)} 37 L ${n(center+halfWidth)} 91 L 64 118 L ${n(center-halfWidth)} 91 L ${n(center-halfWidth)} 37 Z`;

// Each optical window is the intersection of equal circles. The exact sagitta
// is 17 and half-height is 30; R=(30²+17²)/(2·17).
const windowRadius=(30*30+17*17)/(2*17);
const lens = x => `M ${x} 34 A ${n(windowRadius)} ${n(windowRadius)} 0 0 1 ${x} 94 A ${n(windowRadius)} ${n(windowRadius)} 0 0 1 ${x} 34 Z`;
const sharedLens=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">\n  <title>kollens Shared Lens</title>\n  <desc>A filled regular hexagonal prism with two mirrored circular lens windows.</desc>\n  <path id="19-shared-lens-body" fill="#F9C932" fill-rule="evenodd" d="${hex} ${lens(43)} ${lens(85)}"/>\n</svg>\n`;

// A regular hexagon R54 surrounds an equilateral triangle R27. Three straight
// radial cuts have exact width 6. One facet is copied at 120° and 240°.
const gap=6, halfGap=gap/2, apertureRadius=27;
const xOuter=center+halfWidth;
const xInner=center+apertureRadius*sqrt3/2;
const facet=`M ${center+halfGap} ${n(10+halfGap/sqrt3)} L ${n(xOuter)} 37 L ${n(xOuter)} ${n(91-gap/sqrt3)} L ${n(xInner-halfGap)} ${n(center+apertureRadius/2-halfGap*sqrt3)} L ${center+halfGap} ${n(center-apertureRadius+halfGap*sqrt3)} Z`;
const apertureCrystal=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">\n  <title>kollens Aperture Crystal</title>\n  <desc>Three equal solid optical facets in a regular hexagonal prism, with a clear equilateral triangular aperture and equal radial cuts.</desc>\n  <defs>\n    <path id="20-aperture-crystal-facet" d="${facet}"/>\n  </defs>\n  <g fill="#F9C932">\n    <use href="#20-aperture-crystal-facet"/>\n    <use href="#20-aperture-crystal-facet" transform="rotate(120 64 64)"/>\n    <use href="#20-aperture-crystal-facet" transform="rotate(240 64 64)"/>\n  </g>\n</svg>\n`;

for (const [file,svg] of [['19-shared-lens',sharedLens],['20-aperture-crystal',apertureCrystal]]) {
  await fs.writeFile(path.join(directory,`${file}.svg`),svg);
  await sharp(Buffer.from(svg)).resize(640,640).flatten({background:'#101113'}).png().toFile(path.join(directory,`${file}-proof.png`));
  const smallProof=await sharp(Buffer.from(svg)).resize(24,24).flatten({background:'#101113'}).png().toBuffer();
  await sharp(smallProof).resize(240,240,{kernel:'nearest'}).png().toFile(path.join(directory,`${file}-24px-proof.png`));
  const qa=[];
  for (const side of [128,24]) {
    const {data}=await sharp(Buffer.from(svg)).resize(side,side).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const seen=new Uint8Array(side*side), componentSizes=[];
    for(let i=0;i<side*side;i++) {
      if(seen[i]||data[i*4+3]<128)continue;
      const queue=[i];seen[i]=1;let count=0;
      while(queue.length){const p=queue.pop(),x=p%side,y=Math.floor(p/side);count++;for(const[dx,dy]of[[-1,0],[1,0],[0,-1],[0,1]]){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=side||ny>=side)continue;const q=ny*side+nx;if(!seen[q]&&data[q*4+3]>=128){seen[q]=1;queue.push(q);}}}
      componentSizes.push(count);
    }
    qa.push({side,solidComponents:componentSizes.length,componentSizes,cornerAlpha:data[3],centerAlpha:data[(Math.floor(side/2)*side+Math.floor(side/2))*4+3]});
  }
  console.log(JSON.stringify({file,qa}));
}
