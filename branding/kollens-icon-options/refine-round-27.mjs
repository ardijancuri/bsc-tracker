// Production vector refinement of the four native ImageGen concepts.
// Preserve their silhouettes while regularizing straight edges, radii and spacing.
import sharp from 'sharp';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const file = name => new URL(name, import.meta.url);
const gold = '#f9c932';
const xy = p => p.map(n => +n.toFixed(4)).join(' ');

function roundedPolygon(vertices, radii) {
  const data = vertices.map((v,i) => {
    const p=vertices[(i+vertices.length-1)%vertices.length], n=vertices[(i+1)%vertices.length];
    const a=[p[0]-v[0],p[1]-v[1]], b=[n[0]-v[0],n[1]-v[1]];
    const al=Math.hypot(...a), bl=Math.hypot(...b), u=a.map(x=>x/al), w=b.map(x=>x/bl);
    const angle=Math.acos(Math.max(-1,Math.min(1,u[0]*w[0]+u[1]*w[1])));
    return {v,u,w,angle,cut:Math.min(radii[i]/Math.tan(angle/2),al*.99,bl*.99)};
  });
  for(let i=0;i<data.length;i++) {
    const j=(i+1)%data.length, length=Math.hypot(vertices[j][0]-vertices[i][0],vertices[j][1]-vertices[i][1]);
    const total=data[i].cut+data[j].cut;
    if(total>length*.99) {const factor=length*.99/total;data[i].cut*=factor;data[j].cut*=factor;}
  }
  return data.map((c,i)=>{
    const start=c.v.map((x,k)=>x+c.u[k]*c.cut), end=c.v.map((x,k)=>x+c.w[k]*c.cut);
    const radius=c.cut*Math.tan(c.angle/2), sweep=(-c.u[0]*c.w[1]+c.u[1]*c.w[0])>0?1:0;
    if(radius<.00001) return `${i?'L':'M'} ${xy(c.v)}`;
    return `${i?'L':'M'} ${xy(start)} A ${+radius.toFixed(4)} ${+radius.toFixed(4)} 0 0 ${sweep} ${xy(end)}`;
  }).join(' ')+' Z';
}
const p = (vertices,radii) => `<path d="${roundedPolygon(vertices,radii)}"/>`;

const refraction = p([[12,36],[44,18],[44,45],[25,64],[44,83],[44,111],[12,94]],[8,6,1,1.5,1,6,8])
  + p([[35,64],[81,16],[116,16],[98,47],[39,64],[98,81],[116,112],[81,112]],[0,5,7,7,0,7,7,5]);
const pairedHalf = p([[12,42],[60,14],[60,40],[43,40],[43,70],[78,70],[78,80],[60,80],[60,114],[12,86]],[12,8,6,6,6,5,5,6,8,12]);
const pairedView = pairedHalf + `<g transform="rotate(180 64 64)">${pairedHalf}</g>`;
const cutThrough = p([[12,36],[52,12],[52,43],[12,68]],[12,9,2,2])
  + p([[12,76],[86,26],[116,26],[86,62],[42,66],[42,90],[86,77],[116,114],[70,114],[12,94]],[12,9,9,8,4,4,8,9,10,10]);
const vantage = `<path d="M12 31 Q12 26 18 30 C38 43 51 42 64 58 C77 42 90 43 110 30 Q116 26 116 31 C116 48 110 54 91 65 C74 75 70 78 70 87 C87 85 104 74 112 53 Q114 50 114 56 V74 C114 87 95 92 69 106 Q64 109 59 106 C33 92 14 87 14 74 V56 Q14 50 16 53 C24 74 41 85 58 87 C58 78 54 75 37 65 C18 54 12 48 12 31 Z"/>`;
const entries = [
  {stem:'82-refraction',title:'Refraction',inner:refraction,source:'82-refraction-generated.png',meaning:'An optical K that splits the view into two refracted paths.'},
  {stem:'83-paired-view',title:'Paired View',inner:pairedView,source:'83-paired-view-generated.png',meaning:'Two interlocking views connect wallet activity with token movement.'},
  {stem:'84-cut-through',title:'Cut Through',inner:cutThrough,source:'84-cut-through-repaired.png',meaning:'A folded K opens a clear aperture through market noise.'},
  {stem:'85-vantage',title:'Vantage',inner:vantage,source:'85-vantage-generated.png',meaning:'An abstract observer mask represents watching onchain activity.'},
];
const header=await readFile(file('../../public/kollens-header-logo.svg'),'utf8');
const wordmark=header.slice(header.indexOf('<svg x="53"'));
const composites=[], manifest=[];
for(let i=0;i<entries.length;i++) {
  const entry=entries[i], inner=`<g fill="${gold}">${entry.inner}</g>`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-labelledby="title"><title id="title">Kollens ${entry.title} icon</title>${inner}</svg>\n`;
  await writeFile(file(`${entry.stem}.svg`),svg);
  const png=await sharp(Buffer.from(svg)).resize(512,512).png().toBuffer();
  await writeFile(file(`${entry.stem}.png`),png);
  const {data,info}=await sharp(png).raw().toBuffer({resolveWithObject:true});
  let opaque=0,transparent=0;
  for(let j=0;j<data.length;j+=4) {
    if(data[j+3]===0) transparent++;
    if(data[j+3]===255) {opaque++;if(data[j]!==249||data[j+1]!==201||data[j+2]!==50)throw new Error('Wrong brand color');}
  }
  if(info.channels!==4||!opaque||!transparent)throw new Error('Missing transparency or visible mark');
  const lockup=`<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg x="0" y="0" width="42" height="42" viewBox="0 0 128 128">${inner}</svg>${wordmark}`;
  await writeFile(file(`${entry.stem}-header.svg`),lockup);
  const large=await sharp(Buffer.from(svg)).resize(280,280).png().toBuffer();
  const small=await sharp(Buffer.from(lockup)).resize({height:34}).png().toBuffer();
  const {width:smallWidth}=await sharp(small).metadata();
  const label=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="60"><text x="300" y="32" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="600" fill="#f3f5f6">${i+1} · ${entry.title}</text></svg>`;
  const left=(i%2)*600, top=Math.floor(i/2)*430;
  composites.push({input:large,left:left+160,top:top+20},{input:Buffer.from(label),left,top:top+305},{input:small,left:left+Math.round((600-smallWidth)/2),top:top+365});
  manifest.push({stem:entry.stem,title:entry.title,meaning:entry.meaning,source:entry.source,svg:`${entry.stem}.svg`,png:`${entry.stem}.png`,header:`${entry.stem}-header.svg`,color:'#F9C932',generationMode:'built-in ImageGen',finish:'Native geometric vector refinement from the generated concept'});
  console.log(`${entry.stem}: exact yellow and transparent SVG/PNG verified`);
}
await sharp({create:{width:1200,height:860,channels:4,background:'#0b0e11'}}).composite(composites).png().toFile(fileURLToPath(file('comparison-round-27.png')));
await writeFile(file('round-27-manifest.json'),JSON.stringify(manifest,null,2));
let notes='# Kollens icon concepts — round 27\n\nFour native ImageGen directions, refined into clean SVG geometry. All exports use #F9C932 and transparent backgrounds. The dark comparison sheet is only for viewing.\n\n';
for(const entry of entries){
  notes+=`## ${entry.title}\n\n${entry.meaning}\n\n- [SVG](${entry.stem}.svg)\n- [Transparent PNG](${entry.stem}.png)\n- [Header preview](${entry.stem}-header.svg)\n- [Native source](${entry.source})\n- [Generation prompt](${entry.stem}-prompt.md)\n\n`;
}
notes+='Cut Through received one targeted ImageGen repair to widen the diagonal channel. [Repair prompt](84-cut-through-repair-prompt.md).\n\nGeneration mode: built-in ImageGen. Vector refinement regularized edges, radii, spacing and exact color; no runtime assets were replaced.\n';
await writeFile(file('round-27-notes.md'),notes);
