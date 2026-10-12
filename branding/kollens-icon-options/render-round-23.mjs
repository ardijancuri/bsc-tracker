import sharp from 'sharp';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const folder = path.dirname(fileURLToPath(import.meta.url));
const gold = '#f9c932';
const xy = p => p.map(v => +v.toFixed(4)).join(' ');

function roundedPolygon(vertices, radii) {
  const corners = vertices.map((v,i) => {
    const p = vertices[(i+vertices.length-1)%vertices.length];
    const n = vertices[(i+1)%vertices.length];
    const a = [p[0]-v[0],p[1]-v[1]], b = [n[0]-v[0],n[1]-v[1]];
    const al = Math.hypot(...a), bl = Math.hypot(...b);
    const u = a.map(x=>x/al), w = b.map(x=>x/bl);
    const angle = Math.acos(Math.max(-1,Math.min(1,u[0]*w[0]+u[1]*w[1])));
    const cut = Math.min(radii[i]/Math.tan(angle/2),al*.45,bl*.45);
    const radius = cut*Math.tan(angle/2);
    const start = v.map((x,k)=>x+u[k]*cut), end = v.map((x,k)=>x+w[k]*cut);
    return {start,end,radius,sweep:(-u[0]*w[1]+u[1]*w[0])>0?1:0};
  });
  return corners.map((c,i)=>`${i?'L':'M'} ${xy(c.start)} A ${+c.radius.toFixed(4)} ${+c.radius.toFixed(4)} 0 0 ${c.sweep} ${xy(c.end)}`).join(' ')+' Z';
}

function squareAperture(width, gap) {
  const half = width/2;
  const diagonalOffset = half*Math.SQRT2;
  const left = 24, right = 104, top = 24, bottom = 104;
  // The separation is measured from the left rail to the curved K joint.
  const joint = left+width+gap;
  const armEnd = joint+40;
  const innerTop = joint+diagonalOffset+40-half;
  const outerTop = joint-diagonalOffset+40-half;
  const innerBottom = armEnd+diagonalOffset-half;
  const outerBottom = armEnd-diagonalOffset+half;
  const frameRadius = width+3;

  const leftFrame = roundedPolygon([
    [left-half,top-half], [left+half,top-half],
    [left+half,bottom-half], [54,bottom-half],
    [54+width,bottom+half], [left-half,bottom+half]
  ],[3,3,3,2,2,frameRadius]);

  // Horizontal/vertical rails and diagonal K arms share one width.
  const opticK = roundedPolygon([
    [48,top-half], [right+half,top-half],
    [right+half,89+half], [right-half,89-half],
    [right-half,top+half], [innerTop,top+half],
    [joint+diagonalOffset,64], [innerBottom,bottom-half],
    [right-half,bottom-half], [right+half,bottom+half],
    [outerBottom,bottom+half], [joint-diagonalOffset,64],
    [outerTop,top+half], [48,top+half]
  ],[3,frameRadius,2,2,3,3,3,2,2,2,3,half,3,3]);
  return `<g fill="${gold}"><path d="${leftFrame}"/><path d="${opticK}"/></g>`;
}

const entries = [
  {stem:'73-balanced-square-aperture',title:'Balanced',width:14,gap:8},
  {stem:'74-light-square-aperture',title:'Light',width:12,gap:10},
  {stem:'75-bold-square-aperture',title:'Bold',width:16,gap:7}
];
const header = await readFile(path.join(folder,'../../public/kollens-header-logo.svg'),'utf8');
const wordmark = header.slice(header.indexOf('<svg x="53"'));
const housing = '<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg x="0" y="0" width="42" height="42" viewBox="0 0 128 128">';
const composites = [];
for (const [i,{stem,title,width,gap}] of entries.entries()) {
  const inner = squareAperture(width,gap);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-labelledby="title"><title id="title">Kollens ${title.toLowerCase()} square aperture icon with a separated left frame</title>${inner}</svg>\n`;
  const lockup = housing+inner+'</svg>'+wordmark;
  await writeFile(path.join(folder,`${stem}.svg`),svg);
  await writeFile(path.join(folder,`${stem}-header.svg`),lockup);
  const preview = await sharp(Buffer.from(svg)).resize(256,256).png().toBuffer();
  await writeFile(path.join(folder,`${stem}.png`),preview);
  const x = i*400;
  composites.push({input:preview,left:x+72,top:36});
  const label = `<svg width="400" height="60"><text x="200" y="27" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="600" fill="#f3f5f6">${stem.slice(0,2)} · ${title}</text><text x="200" y="52" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#8c969d">Matching line widths</text></svg>`;
  composites.push({input:Buffer.from(label),left:x,top:312});
  const mini = await sharp(Buffer.from(lockup)).resize({height:30}).png().toBuffer();
  const {width:miniWidth} = await sharp(mini).metadata();
  composites.push({input:mini,left:x+Math.round((400-miniWidth)/2),top:396});
}
await sharp({create:{width:1200,height:460,channels:4,background:'#0b0e11'}})
  .composite(composites).png().toFile(path.join(folder,'comparison-round-23.png'));
console.log('Created three equal-width SVG refinements of option 70 with a separated left frame.');
