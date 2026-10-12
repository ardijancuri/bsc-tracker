import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const directory=path.dirname(fileURLToPath(import.meta.url));
const prototype=await fs.readFile(path.join(directory,'prototype-white.svg'),'utf8');
const ref=JSON.parse(await fs.readFile(path.join(directory,'refbounds.json'),'utf8'));
const vector=JSON.parse(await fs.readFile(path.join(directory,'vector-bounds.json'),'utf8'));
const [xmin,ymin,xmax,ymax]=vector.bounds;
const uniformScale=42/(ymax-ymin),wordmarkWidth=(xmax-xmin)*uniformScale;
const glyphs=vector.glyphs.map(g=>({...g,path:prototype.match(new RegExp(`<path id="${g.id}"[^>]* d="([^"]+)"`))[1]}));
const number=n=>Number(n.toFixed(9));

for(const [suffix,color]of[['white','#FFFFFF'],['yellow','#F9C932']]){
  const paths=glyphs.map((g,i)=>`    <path id="${g.id}" fill="${i===0?color:'#FFFFFF'}" fill-rule="evenodd" transform="translate(${g.offset.join(' ')})" d="${g.path}"/>`).join('\n');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${number(wordmarkWidth)}" height="42" viewBox="0 0 ${number(wordmarkWidth)} 42" role="img" aria-label="Kollens">\n  <title>Kollens reference-matched wordmark</title>\n  <desc>Seven separately identifiable native vector glyphs faithfully preserve the supplied reference's K, lowercase letter shapes, counters and spacing. No font dependency.</desc>\n  <g transform="scale(${number(uniformScale)}) translate(${number(-xmin)} ${number(-ymin)})">\n${paths}\n  </g>\n</svg>\n`;
  await fs.writeFile(path.join(directory,`kollens-logo-${suffix}.svg`),svg);
  await sharp(Buffer.from(svg),{density:500}).resize({height:240}).png().toFile(path.join(directory,`kollens-logo-${suffix}.png`));
  for(const h of[18,20,22,24])await sharp(Buffer.from(svg),{density:200}).resize({height:h}).flatten({background:'#101113'}).png().toFile(path.join(directory,`kollens-logo-${suffix}-${h}px-proof.png`));
  const k=glyphs[0],b=k.localBounds,s=108/(b[3]-b[1]),kx=(128-(b[2]-b[0])*s)/2;
  const icon=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Kollens ${suffix} K icon">\n  <title>Kollens ${suffix} K icon</title>\n  <path id="glyph-k" fill="${color}" fill-rule="evenodd" transform="translate(${number(kx)} 10) scale(${number(s)}) translate(${number(-b[0])} ${number(-b[1])})" d="${k.path}"/>\n</svg>\n`;
  await fs.writeFile(path.join(directory,`kollens-icon-${suffix}.svg`),icon);
  await sharp(Buffer.from(icon),{density:400}).resize(512,512).png().toFile(path.join(directory,`kollens-icon-${suffix}.png`));
}

const finalWhite=await fs.readFile(path.join(directory,'kollens-logo-white.svg'));
const [w,h]=ref.inkSize;
const sourceCrop=await sharp(path.join(directory,'reference.png')).extract({left:ref.bounds[0],top:ref.bounds[1],width:w,height:h}).png().toBuffer();
const finalCrop=await sharp(finalWhite,{density:500}).resize(w,h).flatten({background:'#000000'}).png().toBuffer();
const sourcePixels=await sharp(sourceCrop).ensureAlpha().raw().toBuffer();
const finalPixels=await sharp(finalWhite,{density:500}).resize(w,h).ensureAlpha().raw().toBuffer();
let finalIntersection=0,finalUnion=0,finalDifference=0;
for(let p=0;p<w*h;p++){
  const i=p*4,a=Math.min(sourcePixels[i],sourcePixels[i+1],sourcePixels[i+2])>=ref.threshold,b=finalPixels[i+3]>=ref.threshold;
  if(a&&b)finalIntersection++;if(a||b)finalUnion++;if(a!==b)finalDifference++;
}
await sharp({create:{width:w+80,height:h*2+100,channels:3,background:'#000000'}}).composite([{input:sourceCrop,left:40,top:20},{input:finalCrop,left:40,top:h+60}]).png().toFile(path.join(directory,'source-vs-vector-final.png'));
const composite=[];
for(const[suffix,top]of[['white',30],['yellow',260]]){
  const svg=await fs.readFile(path.join(directory,`kollens-logo-${suffix}.svg`));
  composite.push({input:await sharp(svg,{density:500}).resize({height:120}).png().toBuffer(),left:30,top});
  composite.push({input:await sharp(svg).resize({height:22}).png().toBuffer(),left:30,top:top+160});
  composite.push({input:await sharp(await fs.readFile(path.join(directory,`kollens-icon-${suffix}.svg`))).png().toBuffer(),left:790,top});
}
await sharp({create:{width:1000,height:470,channels:4,background:'#101113'}}).composite(composite).png().toFile(path.join(directory,'comparison.png'));
const sourceBytes=await fs.readFile(path.join(directory,'reference.png'));
const manifest={brand:'Kollens',letterCount:7,reference:'reference.png',sourceOriginal:ref.source,sourceSha256:createHash('sha256').update(sourceBytes).digest('hex'),method:'Connected-component isolation followed by Potrace 2.1.8 vectorization of each supplied-reference glyph; native paths, no font approximation or raster embedding',threshold:ref.threshold,sourceInkBounds:ref.bounds,sourceInkSize:ref.inkSize,sourceAspect:ref.aspect,vectorInkBounds:vector.bounds,exportWidth:number(wordmarkWidth),exportHeight:42,horizontalStretch:1,uniformNormalizationScale:uniformScale,glyphs:ref.glyphs.map((g,i)=>({...g,actualVectorBounds:vector.glyphs[i].bounds})),validation:{...ref.validation,finalIntersectionOverUnion:finalIntersection/finalUnion,finalPixelMismatchCount:finalDifference,finalMismatchFraction:finalDifference/finalUnion},icon:{width:128,height:128,actualInkHeight:108,center:[64,64]},colors:{white:'#FFFFFF',yellow:'#F9C932',yellowLogo:'Yellow K; white ollens'},files:['kollens-logo-white.svg','kollens-logo-yellow.svg','kollens-icon-white.svg','kollens-icon-yellow.svg'],comparison:'comparison.png',sourceFidelityProof:'source-vs-vector-final.png'};
await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({exportSize:[number(wordmarkWidth),42],sourceInkSize:ref.inkSize,horizontalStretch:1,iconInkHeight:108,finalSourceIoU:finalIntersection/finalUnion,files:manifest.files}));
