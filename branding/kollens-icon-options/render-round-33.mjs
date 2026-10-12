import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const file=name=>new URL(name,import.meta.url);
const gold='#F9C932';
const circuit=`<path d="M23 85 V43 L48 18 H81 L106 43 V86 L81 111 H53 L40 98 V66 L60 46 H77" fill="none" stroke="${gold}" stroke-width="14" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="2"/>`;
const cohort=`<g fill="${gold}" transform="translate(0 3)"><path d="M64 14 L101 35 L64 56 L27 35 Z"/><path d="M20 45 L56 66 V108 L20 87 Z"/><path d="M72 66 L108 45 V87 L72 108 Z"/></g>`;
const splitSignal=`<defs><mask id="split-signal-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128"><rect width="128" height="128" fill="white"/><path d="M6 64 H41 L58 45 L76 83 L94 64 H122" fill="none" stroke="black" stroke-width="14" stroke-linecap="square" stroke-linejoin="miter"/></mask></defs><path d="M64 12 L116 64 L64 116 L12 64 Z" fill="${gold}" mask="url(#split-signal-gap)"/>`;
const crossTrack=`<defs><mask id="cross-track-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128"><rect width="128" height="128" fill="white"/><path d="M64 51 L77 64 L64 77 L51 64 Z" fill="black"/></mask></defs><g fill="${gold}" mask="url(#cross-track-gap)"><path d="M16 26 H44 L71 64 L44 102 H16 L42 64 Z"/><path d="M112 26 H84 L57 64 L84 102 H112 L86 64 Z"/></g>`;
const entries=[
  {stem:'106-trade-circuit',title:'Trade Circuit',inner:circuit,caption:'A sharp path traces a KOL wallet’s activity.',meaning:'An angular route represents tracing transactions through a tracked KOL wallet.'},
  {stem:'107-cohort',title:'Cohort',inner:cohort,caption:'Several KOLs form one shared view of a token.',meaning:'Three connected facets represent grouping KOL activity around the same token.'},
  {stem:'108-split-signal',title:'Split Signal',inner:splitSignal,caption:'A trade signal cuts through the market noise.',meaning:'The interrupted block represents spotting a new trade signal in the activity feed.'},
  {stem:'109-cross-track',title:'Cross Track',inner:crossTrack,caption:'Intersecting tracks reveal shared KOL activity.',meaning:'Intersecting paths represent comparing KOL wallets and finding shared token activity.'},
];
const official=await readFile(file('../../public/kollens-header-logo.svg'),'utf8');
const wordmark=official.slice(official.indexOf('<svg x="53"'));
const composites=[],manifest=[];
for(let i=0;i<entries.length;i++) {
  const e=entries[i];
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Kollens ${e.title}"><title>${e.title}</title><desc>${e.meaning}</desc>${e.inner}</svg>\n`;
  await writeFile(file(`${e.stem}.svg`),svg);
  const {data}=await sharp(Buffer.from(svg)).resize(512,512).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let opaque=0,transparent=0;
  for(let p=0;p<data.length;p+=4){
    if(data[p+3]){data[p]=249;data[p+1]=201;data[p+2]=50;}
    if(data[p+3]===0)transparent++;
    if(data[p+3]===255)opaque++;
  }
  if(!opaque||!transparent)throw new Error(`${e.title}: missing mark or transparency`);
  for(let p=0;p<512;p++)if(data[p*4+3]||data[(511*512+p)*4+3]||data[p*512*4+3]||data[(p*512+511)*4+3])throw new Error(`${e.title}: clipped geometry`);
  const png=await sharp(data,{raw:{width:512,height:512,channels:4}}).png().toBuffer();
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
  manifest.push({...e,inner:undefined,svg:`${e.stem}.svg`,png:`${e.stem}.png`,header:`${e.stem}-header.svg`,color:gold,medium:'Native SVG vector concepts',direction:'Angular and filled abstract KOL tracking marks'});
  console.log(`${e.stem}: exact yellow, alpha transparency and export padding verified`);
}
await sharp({create:{width:1200,height:920,channels:4,background:'#0b0e11'}}).composite(composites).png().toFile(fileURLToPath(file('comparison-round-33.png')));
await writeFile(file('round-33-manifest.json'),JSON.stringify(manifest,null,2));
let notes='# Kollens angular tracking icons — round 33\n\nFour editable SVG concepts using sharp edges, broad filled shapes, and #F9C932. Transparent PNGs and header previews are rendered from the SVGs.\n\n';
for(const e of entries)notes+=`## ${e.title}\n\n${e.meaning}\n\n- [SVG](${e.stem}.svg)\n- [Transparent PNG](${e.stem}.png)\n- [Header preview](${e.stem}-header.svg)\n\n`;
await writeFile(file('round-33-notes.md'),notes);
