import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const file=name=>new URL(name,import.meta.url);
const gold='#F9C932';
const point=(r,a,cx=64,cy=64)=>[cx+r*Math.cos(a*Math.PI/180),cy+r*Math.sin(a*Math.PI/180)].map(n=>+n.toFixed(4)).join(' ');
const arc=(r,start,end,cx=64,cy=64)=>`M${point(r,start,cx,cy)} A${r} ${r} 0 ${end-start>180?1:0} 1 ${point(r,end,cx,cy)}`;
const line=(paths,width=14)=>`<g fill="none" stroke="${gold}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${paths.map(d=>`<path d="${d}"/>`).join('')}</g>`;
const sweep=line([arc(46,-35,235),arc(24.5,38,278,61,67)]);
const refraction=line(['M54 18 C17 36 17 92 54 110','M74 18 C111 36 111 92 74 110','M50 76 L78 51']);
const triadPath='M52 20 C78 14 101 35 103 57 C104 69 100 80 90 86 L76 68';
const triad=`<g fill="none" stroke="${gold}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"><path d="${triadPath}"/><path d="${triadPath}" transform="rotate(120 64 64)"/><path d="${triadPath}" transform="rotate(240 64 64)"/></g>`;
const windowLens=line(['M54 16 H35 Q16 16 16 35 V54','M74 112 H93 Q112 112 112 93 V74','M76 36 C96 52 94 78 73 90','M52 92 C32 76 34 50 55 38'],13);
const entries=[
  {stem:'98-sweep-lens',title:'Sweep Lens',inner:sweep,caption:'Scanning arcs follow KOL activity as it changes.',meaning:'Two scanning arcs represent continuously observing KOL wallet activity.'},
  {stem:'99-refracted-view',title:'Refracted View',inner:refraction,caption:'A signal passes through two optical surfaces.',meaning:'Two lens surfaces bring the signals in wallet trades into focus.'},
  {stem:'100-triad-lens',title:'Triad Lens',inner:triad,caption:'Wallets, trades and tokens share one focal point.',meaning:'Three optical segments represent wallets, trades and tokens meeting in one view.'},
  {stem:'101-focus-window',title:'Focus Window',inner:windowLens,caption:'A focused window onto the traders you follow.',meaning:'A focus frame and lens curves represent looking closely at tracked KOLs.'},
];
const official=await readFile(file('../../public/kollens-header-logo.svg'),'utf8');
const wordmark=official.slice(official.indexOf('<svg x="53"'));
const composites=[],manifest=[];
for(let i=0;i<entries.length;i++) {
  const e=entries[i];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Kollens ${e.title}"><title>${e.title}</title><desc>${e.meaning}</desc>${e.inner}</svg>\n`;
  await writeFile(file(`${e.stem}.svg`),svg);
  const {data}=await sharp(Buffer.from(svg)).resize(512,512).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  // Keep one exact ink color; overlapping stroke antialiasing may round an RGB byte.
  for(let j=0;j<data.length;j+=4)if(data[j+3]){data[j]=249;data[j+1]=201;data[j+2]=50;}
  const png=await sharp(data,{raw:{width:512,height:512,channels:4}}).png().toBuffer();
  let opaque=0,transparent=0;
  for(let j=0;j<data.length;j+=4){
    if(data[j+3]===0)transparent++;
    if(data[j+3]===255){opaque++;if(data[j]!==249||data[j+1]!==201||data[j+2]!==50)throw new Error(`${e.title}: incorrect gold`);}
  }
  if(!opaque||!transparent)throw new Error(`${e.title}: no icon or transparency`);
  for(let p=0;p<512;p++)if(data[p*4+3]||data[(511*512+p)*4+3]||data[p*512*4+3]||data[(p*512+511)*4+3])throw new Error(`${e.title}: touches export boundary`);
  await writeFile(file(`${e.stem}.png`),png);
  const lockup=`<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg x="0" y="0" width="42" height="42" viewBox="0 0 128 128">${e.inner}</svg>${wordmark}`;
  await writeFile(file(`${e.stem}-header.svg`),lockup);
  const large=await sharp(Buffer.from(svg)).resize(280,280).png().toBuffer();
  const small=await sharp(Buffer.from(lockup)).resize({height:34}).png().toBuffer();
  const {width:smallWidth}=await sharp(small).metadata();
  const label=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="45"><text x="300" y="30" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="600" fill="#f3f5f6">${i+1} · ${e.title}</text></svg>`;
  const caption=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="45"><text x="300" y="25" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#adb6bd">${e.caption}</text></svg>`;
  const left=(i%2)*600,top=Math.floor(i/2)*460;
  composites.push({input:large,left:left+160,top:top+20},{input:Buffer.from(label),left,top:top+310},{input:Buffer.from(caption),left,top:top+350},{input:small,left:left+Math.round((600-smallWidth)/2),top:top+405});
  manifest.push({...e,inner:undefined,svg:`${e.stem}.svg`,png:`${e.stem}.png`,header:`${e.stem}-header.svg`,color:gold,medium:'Native SVG vector concepts'});
  console.log(`${e.stem}: exact yellow, alpha transparency and padding verified`);
}
await sharp({create:{width:1200,height:920,channels:4,background:'#0b0e11'}}).composite(composites).png().toFile(fileURLToPath(file('comparison-round-31.png')));
await writeFile(file('round-31-manifest.json'),JSON.stringify(manifest,null,2));
let notes='# Kollens icon options — round 31\n\nFour editable SVG concepts in a lighter optical stroke style. All use #F9C932 and transparent backgrounds. Drawn directly as vector artwork; PNGs are rendered from the SVGs.\n\n';
for(const e of entries)notes+=`## ${e.title}\n\n${e.meaning}\n\n- [SVG](${e.stem}.svg)\n- [Transparent PNG](${e.stem}.png)\n- [Header preview](${e.stem}-header.svg)\n\n`;
await writeFile(file('round-31-notes.md'),notes);
