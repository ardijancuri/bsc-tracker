import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const sharp=require('C:/Users/PC/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const directory=path.dirname(fileURLToPath(import.meta.url));
const n=value=>Number(value.toFixed(9));

const wedge=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">\n  <title>kollens Wedge Chevron</title>\n  <desc>Two equally weighted solid planes form a compact asymmetrical optical K, separated by a clear eight-unit gap.</desc>\n  <g fill="#F9C932">\n    <polygon id="33-left-wedge" points="10,96 56,32 56,96"/>\n    <polygon id="33-right-chevron" points="96,32 118,32 86,64 118,96 96,96 64,64"/>\n  </g>\n</svg>\n`;

// The left facet has one R14 circular shoulder, tangent to its 45° branch
// and vertical stem. Its lower counterpart is an exact reflection about y64.
const shoulderRadius=14;
const shoulderTangentX=28+shoulderRadius/Math.SQRT2;
const shoulderTangentY=34+shoulderRadius/Math.SQRT2;
const leftTipX=shoulderTangentX+shoulderTangentY-14;
const leftFacet=`M 14 14 H 29 V 31 L 46 14 H ${n(leftTipX)} L ${n(shoulderTangentX)} ${n(shoulderTangentY)} A 14 14 0 0 1 14 34 Z`;

// Circular central bends: R6 inside, R8 outside. Tangency is exact where
// both arcs join the straight 45° chevron branches. Flat tips stay bold.
const innerRadius=6,outerRadius=8;
const innerOffset=innerRadius/Math.SQRT2,outerOffset=outerRadius/Math.SQRT2;
const innerTangentX=64+innerOffset;
const outerTangentX=32+outerOffset;
const rightFold=`M 82 14 H 114 L ${n(innerTangentX)} ${n(64-innerOffset)} A 6 6 0 0 0 ${n(innerTangentX)} ${n(64+innerOffset)} L 114 114 H 82 L ${n(outerTangentX)} ${n(64+outerOffset)} A 8 8 0 0 1 ${n(outerTangentX)} ${n(64-outerOffset)} Z`;
const flow=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">\n  <title>kollens Flow Chevron</title>\n  <desc>Three complementary filled planes form a soft optical K, with exact circular fold transitions, forty-five-degree branches, and mirrored left facets.</desc>\n  <defs>\n    <path id="34-left-facet" d="${leftFacet}"/>\n  </defs>\n  <g fill="#F9C932">\n    <use href="#34-left-facet"/>\n    <use href="#34-left-facet" transform="translate(0 128) scale(1 -1)"/>\n    <path id="34-right-fold" d="${rightFold}"/>\n  </g>\n</svg>\n`;

for(const[file,svg]of[['33-wedge-chevron',wedge],['34-flow-chevron',flow]]){
  await fs.writeFile(path.join(directory,`${file}.svg`),svg);
  await sharp(Buffer.from(svg)).resize(640,640).flatten({background:'#101113'}).png().toFile(path.join(directory,`${file}-proof.png`));
  const smallProof=await sharp(Buffer.from(svg)).resize(24,24).flatten({background:'#101113'}).png().toBuffer();
  await sharp(smallProof).resize(240,240,{kernel:'nearest'}).png().toFile(path.join(directory,`${file}-24px-proof.png`));
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
  console.log(JSON.stringify({file,qa}));
}
console.log(JSON.stringify({wedgeMinimumGap:8,flowMinimumGap:(96-(shoulderTangentX+shoulderTangentY))/Math.SQRT2,flowRadii:{left:14,innerFold:6,outerFold:8}}));
