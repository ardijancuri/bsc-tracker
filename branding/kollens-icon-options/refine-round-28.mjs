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

const openBand = '<path d="M12 64 C44 21 75 20 96 40 V60 C67 32 46 46 22 76 Z"/>';
const openLens = openBand + `<g transform="rotate(180 64 64)">${openBand}</g>`;
const parallax = `<path fill-rule="evenodd" d="${roundedPolygon([[12,36],[36,12],[96,12],[96,36],[116,36],[116,92],[92,116],[32,116],[32,92],[12,92]],[20,20,8,0,12,20,20,8,0,12])} ${roundedPolygon([[40,65],[88,41],[88,63],[40,87]],[4,4,4,4])}"/>`;
const opticBridge = '<path fill-rule="evenodd" d="M22 48 C22 35 32 29 43 35 L80 53 Q84 56 84 50 V27 Q84 20 92 17 L101 13 Q106 10 106 17 V91 C106 104 95 110 84 104 L52 84 Q47 81 47 87 V104 Q47 111 40 113 L28 117 Q22 119 22 112 Z M47 51 Q47 46 52 48 L84 63 V89 Q84 94 79 91 L47 77 Z"/>';
// Keep the generated tile's main body; discard the unwanted detached wedge.
const focusTile = '<path d="M36 12 H92 C102 12 111 17 116 26 Q118 30 114 33 L66 58 Q56 64 66 70 L114 95 Q118 98 116 102 C111 111 102 116 92 116 H36 C22 116 12 106 12 92 V36 C12 22 22 12 36 12 Z"/>';
const entries = [
  {stem:'86-open-lens',title:'Open Lens',inner:openLens,source:'86-open-lens-generated.png',meaning:'Two open optical bands bring onchain activity into view.'},
  {stem:'87-parallax',title:'Parallax',inner:parallax,source:'87-parallax-generated.png',meaning:'Offset views align around one clear optical window.'},
  {stem:'88-optic-bridge',title:'Optic Bridge',inner:opticBridge,source:'88-optic-bridge-repaired.png',meaning:'A viewing bridge connects KOL wallets with their token activity.'},
  {stem:'89-focus-tile',title:'Focus Tile',inner:focusTile,source:'89-focus-tile-generated.png',meaning:'A compact optical tile opens a viewing cut onto the activity being tracked.'},
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
await sharp({create:{width:1200,height:860,channels:4,background:'#0b0e11'}}).composite(composites).png().toFile(fileURLToPath(file('comparison-round-28.png')));
await writeFile(file('round-28-manifest.json'),JSON.stringify(manifest,null,2));
let notes='# Kollens icon concepts — round 28\n\nFour native ImageGen directions, refined into clean SVG geometry. All exports use #F9C932 and transparent backgrounds. The dark comparison sheet is only for viewing.\n\n';
for(const entry of entries){
  notes+=`## ${entry.title}\n\n${entry.meaning}\n\n- [SVG](${entry.stem}.svg)\n- [Transparent PNG](${entry.stem}.png)\n- [Header preview](${entry.stem}-header.svg)\n- [Native source](${entry.source})\n- [Generation prompt](${entry.stem}-prompt.md)\n\n`;
}
notes+='Generation mode: built-in ImageGen. Vector refinement regularized edges, radii, spacing and exact color. Optic Bridge used a targeted second generation to stagger its forms. Focus Tile used two native attempts; its SVG finish retains the main tile body and removes the unwanted detached wedge.\n';
await writeFile(file('round-28-notes.md'),notes);
