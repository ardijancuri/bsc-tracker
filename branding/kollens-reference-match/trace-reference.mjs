import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'../..');
const requireTrace=createRequire(path.join(root,'.cache/reference-trace-tools/package.json'));
const {Potrace}=requireTrace('potrace');
const source='C:/Users/PC/AppData/Local/Temp/codex-clipboard-34604d7a-bcf2-4742-8ad8-3af1e265d21e.png';
const threshold=128;
const padding=4;
const {data,info}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
const width=info.width,height=info.height;
const foreground=new Uint8Array(width*height);
for(let p=0;p<foreground.length;p++){const i=p*4;foreground[p]=Math.min(data[i],data[i+1],data[i+2])>=threshold&&data[i+3]>=threshold?1:0;}

function components(mask,w,h){
  const labels=new Int32Array(mask.length),queue=new Int32Array(mask.length),records=[];
  let label=0;
  for(let p=0;p<mask.length;p++){
    if(!mask[p]||labels[p])continue;
    label++;let head=0,tail=1;queue[0]=p;labels[p]=label;
    let minX=w,minY=h,maxX=-1,maxY=-1;
    while(head<tail){
      const current=queue[head++],x=current%w,y=Math.floor(current/w);
      minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        if(!dx&&!dy)continue;
        const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=w||ny>=h)continue;
        const next=ny*w+nx;if(mask[next]&&!labels[next]){labels[next]=label;queue[tail++]=next;}
      }
    }
    records.push({label,area:tail,bounds:[minX,minY,maxX,maxY],width:maxX-minX+1,height:maxY-minY+1});
  }
  return{labels,records};
}

const segmented=components(foreground,width,height);
const glyphs=segmented.records.filter(r=>r.area>1000).sort((a,b)=>a.bounds[0]-b.bounds[0]);
if(glyphs.length!==7)throw new Error(`Expected 7 dominant glyphs, got ${glyphs.length}`);
const x0=Math.min(...glyphs.map(g=>g.bounds[0])),y0=Math.min(...glyphs.map(g=>g.bounds[1]));
const x1=Math.max(...glyphs.map(g=>g.bounds[2])),y1=Math.max(...glyphs.map(g=>g.bounds[3]));
const inkWidth=x1-x0+1,inkHeight=y1-y0+1,scale=42/inkHeight;
const sourceMask=Buffer.alloc(inkWidth*inkHeight);
const letters=Array.from('Kollens');

for(let index=0;index<glyphs.length;index++){
  const g=glyphs[index],w=g.width+padding*2,h=g.height+padding*2;
  const mask=Buffer.alloc(w*h);
  for(let y=0;y<g.height;y++)for(let x=0;x<g.width;x++){
    const sx=g.bounds[0]+x,sy=g.bounds[1]+y;
    if(segmented.labels[sy*width+sx]===g.label){mask[(y+padding)*w+x+padding]=255;sourceMask[(sy-y0)*inkWidth+sx-x0]=255;}
  }
  const input=await sharp(mask,{raw:{width:w,height:h,channels:1}}).png().toBuffer();
  const tracer=new Potrace({threshold:128,blackOnWhite:false,color:'#FFFFFF',turdSize:2,alphaMax:1,optCurve:true,optTolerance:.15});
  await new Promise((resolve,reject)=>tracer.loadImage(input,error=>error?reject(error):resolve()));
  const tag=tracer.getPathTag('#FFFFFF');
  const d=tag.match(/\bd="([^"]+)"/)[1];
  g.letter=letters[index];g.id=index===0?'glyph-k':`glyph-${index}-${g.letter}`;
  g.path=d;g.offset=[g.bounds[0]-x0-padding,g.bounds[1]-y0-padding];
  g.contours=(d.match(/\bM\s/g)||[]).length;
}

function fullSvg(kColor='#FFFFFF'){
  const paths=glyphs.map((g,i)=>`    <path id="${g.id}" fill="${i===0?kColor:'#FFFFFF'}" fill-rule="evenodd" transform="translate(${g.offset.join(' ')})" d="${g.path}"/>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${inkWidth*scale}" height="42" viewBox="0 0 ${inkWidth*scale} 42" role="img" aria-label="Kollens">\n  <title>Kollens reference-matched wordmark</title>\n  <desc>Seven native vector glyph components traced from the supplied clean reference, with original letter shapes, counters, and spacing.</desc>\n  <g transform="scale(${scale})">\n${paths}\n  </g>\n</svg>\n`;
}
const svg=fullSvg();
await fs.writeFile(path.join(directory,'prototype-white.svg'),svg);
await fs.writeFile(path.join(directory,'prototype-gold-accent.svg'),fullSvg('#F9C932'));
await fs.copyFile(source,path.join(directory,'reference.png'));
const k=glyphs[0],kScale=108/k.height,kX=(128-k.width*kScale)/2,kY=10;
for(const [name,color]of[['white','#FFFFFF'],['yellow','#F9C932']]){
  const icon=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Kollens K icon">\n  <path id="glyph-k" fill="${color}" fill-rule="evenodd" transform="translate(${kX} ${kY}) scale(${kScale}) translate(${-padding} ${-padding})" d="${k.path}"/>\n</svg>\n`;
  await fs.writeFile(path.join(directory,`prototype-k-${name}.svg`),icon);
}

const vector=await sharp(Buffer.from(svg),{density:500}).resize(inkWidth,inkHeight).ensureAlpha().raw().toBuffer();
const vectorMask=new Uint8Array(inkWidth*inkHeight);let intersection=0,union=0,difference=0;
for(let p=0;p<vectorMask.length;p++){vectorMask[p]=vector[p*4+3]>=128?1:0;const a=sourceMask[p]>0,b=vectorMask[p]>0;if(a&&b)intersection++;if(a||b)union++;if(a!==b)difference++;}
const vectorComponents=components(vectorMask,inkWidth,inkHeight).records.filter(g=>g.area>1000);
const sourceCrop=await sharp(source).extract({left:x0,top:y0,width:inkWidth,height:inkHeight}).png().toBuffer();
const vectorCrop=await sharp(Buffer.from(svg),{density:500}).resize(inkWidth,inkHeight).flatten({background:'#000000'}).png().toBuffer();
const comparison=await sharp({create:{width:inkWidth+80,height:inkHeight*2+100,channels:3,background:'#000000'}}).composite([{input:sourceCrop,left:40,top:20},{input:vectorCrop,left:40,top:inkHeight+60}]).png().toBuffer();
await fs.writeFile(path.join(directory,'source-vs-vector.png'),comparison);
await sharp(Buffer.from(svg),{density:500}).resize({height:220}).flatten({background:'#101113'}).png().toFile(path.join(directory,'prototype-white-proof.png'));
await sharp(Buffer.from(svg)).resize({height:24}).flatten({background:'#101113'}).png().toFile(path.join(directory,'prototype-white-24px-proof.png'));
const records=glyphs.map(({path,...g})=>g);
await fs.writeFile(path.join(directory,'refbounds.json'),JSON.stringify({source,sourceSize:[width,height],threshold,bounds:[x0,y0,x1,y1],inkSize:[inkWidth,inkHeight],nativeHeight:42,nativeWidth:inkWidth*scale,aspect:inkWidth/inkHeight,padding,potrace:{version:'2.1.8',alphaMax:1,optTolerance:.15,turdSize:2},glyphs:records,validation:{foregroundComponents:vectorComponents.length,intersectionOverUnion:intersection/union,pixelMismatchCount:difference,mismatchFraction:difference/union},files:['prototype-white.svg','prototype-gold-accent.svg','prototype-k-white.svg','prototype-k-yellow.svg']},null,2)+'\n');
console.log(JSON.stringify({inkSize:[inkWidth,inkHeight],nativeWidth:inkWidth*scale,glyphs:records,foregroundComponents:vectorComponents.length,intersectionOverUnion:intersection/union,mismatchFraction:difference/union}));
