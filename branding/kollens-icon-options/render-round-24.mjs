import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const folder = path.dirname(fileURLToPath(import.meta.url));
const gold = '#f9c932';
const xy = p => p.map(n=>+n.toFixed(4)).join(' ');

function roundedPolygon(vertices,radii) {
  const data = vertices.map((v,i)=>{
    const p=vertices[(i+vertices.length-1)%vertices.length];
    const n=vertices[(i+1)%vertices.length];
    const a=[p[0]-v[0],p[1]-v[1]], b=[n[0]-v[0],n[1]-v[1]];
    const al=Math.hypot(...a),bl=Math.hypot(...b);
    const u=a.map(x=>x/al),w=b.map(x=>x/bl);
    const angle=Math.acos(Math.max(-1,Math.min(1,u[0]*w[0]+u[1]*w[1])));
    return {v,u,w,angle,cut:Math.min(radii[i]/Math.tan(angle/2),al*.99,bl*.99)};
  });
  // Share available edge length rather than imposing a half-edge radius limit.
  for(let i=0;i<data.length;i++) {
    const j=(i+1)%data.length;
    const length=Math.hypot(vertices[j][0]-vertices[i][0],vertices[j][1]-vertices[i][1]);
    const total=data[i].cut+data[j].cut;
    if(total>length*.99) {
      const factor=length*.99/total;
      data[i].cut*=factor;data[j].cut*=factor;
    }
  }
  return data.map((c,i)=>{
    const start=c.v.map((x,k)=>x+c.u[k]*c.cut);
    const end=c.v.map((x,k)=>x+c.w[k]*c.cut);
    const radius=c.cut*Math.tan(c.angle/2);
    const sweep=(-c.u[0]*c.w[1]+c.u[1]*c.w[0])>0?1:0;
    return `${i?'L':'M'} ${xy(start)} A ${+radius.toFixed(4)} ${+radius.toFixed(4)} 0 0 ${sweep} ${xy(end)}`;
  }).join(' ')+' Z';
}

const width=16,half=8,gap=7;
const left=24,right=104,top=24,bottom=104;
const joint=left+width+gap;
const diagonalOffset=half*Math.SQRT2;
const innerRadius=5,outerRadius=width+innerRadius;

const leftFrame=roundedPolygon([
  [left-half,top-half],[left+half,top-half],
  [left+half,bottom-half],[54,bottom-half],
  [54+width,bottom+half],[left-half,bottom+half]
],[3,3,innerRadius,2,2,outerRadius]);

// Both lower diagonal edges run directly to one flat terminal cap.
const innerBottom=joint+diagonalOffset+(bottom+half-64);
const outerBottom=joint-diagonalOffset+(bottom+half-64);
const innerTop=joint+diagonalOffset+(64-top-half);
const outerTop=joint-diagonalOffset+(64-top-half);
const opticK=roundedPolygon([
  [48,top-half],[right+half,top-half],
  [right+half,89+half],[right-half,89-half],
  [right-half,top+half],[innerTop,top+half],
  [joint+diagonalOffset,64],[innerBottom,bottom+half],
  [outerBottom,bottom+half],[joint-diagonalOffset,64],
  [outerTop,top+half],[48,top+half]
],[3,outerRadius,2,2,innerRadius,1.5,3,2,3,half,3,3]);

const inner=`<g fill="${gold}"><path d="${leftFrame}"/><path d="${opticK}"/></g>`;
const stem='76-rounded-bold-square-aperture';
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-labelledby="title"><title id="title">Kollens refined bold square aperture icon</title>${inner}</svg>\n`;
await writeFile(path.join(folder,`${stem}.svg`),svg);
await sharp(Buffer.from(svg)).resize(256,256).png().toFile(path.join(folder,`${stem}.png`));

const header=await readFile(path.join(folder,'../../public/kollens-header-logo.svg'),'utf8');
const wordmark=header.slice(header.indexOf('<svg x="53"'));
const housing='<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg x="0" y="0" width="42" height="42" viewBox="0 0 128 128">';
const lockup=housing+inner+'</svg>'+wordmark;
await writeFile(path.join(folder,`${stem}-header.svg`),lockup);
const large=await sharp(Buffer.from(svg)).resize(300,300).png().toBuffer();
const small=await sharp(Buffer.from(lockup)).resize({height:36}).png().toBuffer();
const {width:smallWidth}=await sharp(small).metadata();
const label='<svg width="600" height="45"><text x="300" y="29" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="600" fill="#f3f5f6">76 · Refined bold</text></svg>';
await sharp({create:{width:600,height:460,channels:4,background:'#0b0e11'}})
  .composite([
    {input:large,left:150,top:10},
    {input:Buffer.from(label),left:0,top:319},
    {input:small,left:Math.round((600-smallWidth)/2),top:396}
  ]).png().toFile(path.join(folder,'comparison-round-24.png'));
console.log('Created option 76 with larger inner frame radii and a straight lower K arm.');
