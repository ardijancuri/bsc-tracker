import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('C:/Users/PC/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const directory=path.dirname(fileURLToPath(import.meta.url));
const n=value=>Number(value.toFixed(9));

// All principal slopes are ±45°. The slab lies between x+y=93 and x+y=138.
// Both negative-space cuts have exact perpendicular width 7.5.
const gap=7.5, normalOffset=gap*Math.SQRT2;
const upperFacetLimit=93-normalOffset;
const lowerFacetLimit=138+normalOffset;
const upperFacet=`14,14 ${n(upperFacetLimit-14)},14 14,${n(upperFacetLimit-14)}`;
const diagonalSlab='14,79 79,14 114,14 114,24 24,114 14,114';
const lowerFacet=`${n(lowerFacetLimit-114)},114 ${n(lowerFacetLimit/2)},${n(lowerFacetLimit/2)} 114,114`;
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">\n  <title>kollens Diagonal Cut</title>\n  <desc>Three bold polygon planes, with an exact 45-degree rising slab and two equal perpendicular negative-space cuts.</desc>\n  <g fill="#F9C932">\n    <polygon id="28-upper-facet" points="${upperFacet}"/>\n    <polygon id="28-diagonal-slab" points="${diagonalSlab}"/>\n    <polygon id="28-lower-facet" points="${lowerFacet}"/>\n  </g>\n</svg>\n`;
await fs.writeFile(path.join(directory,'28-diagonal-cut.svg'),svg);
await sharp(Buffer.from(svg)).resize(640,640).flatten({background:'#101113'}).png().toFile(path.join(directory,'28-diagonal-cut-proof.png'));
const smallProof=await sharp(Buffer.from(svg)).resize(24,24).flatten({background:'#101113'}).png().toBuffer();
await sharp(smallProof).resize(240,240,{kernel:'nearest'}).png().toFile(path.join(directory,'28-diagonal-cut-24px-proof.png'));
const qa=[];
for(const side of[128,24]){
  const{data}=await sharp(Buffer.from(svg)).resize(side,side).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const seen=new Uint8Array(side*side),componentSizes=[];
  for(let i=0;i<side*side;i++){
    if(seen[i]||data[i*4+3]<128)continue;
    const queue=[i];seen[i]=1;let count=0;
    while(queue.length){const p=queue.pop(),x=p%side,y=Math.floor(p/side);count++;for(const[dx,dy]of[[-1,0],[1,0],[0,-1],[0,1]]){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=side||ny>=side)continue;const q=ny*side+nx;if(!seen[q]&&data[q*4+3]>=128){seen[q]=1;queue.push(q);}}}
    componentSizes.push(count);
  }
  qa.push({side,separatePlanes:componentSizes.length,componentSizes,cornerAlpha:data[3]});
}
console.log(JSON.stringify({file:'28-diagonal-cut.svg',bounds:[14,14,114,114],perpendicularGaps:[gap,gap],slabWidth:45/Math.SQRT2,qa}));
