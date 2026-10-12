import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const file=name=>new URL(name,import.meta.url);
const gold='#F9C932';
const stroke=(paths,width=16)=>`<g fill="none" stroke="${gold}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${paths.map(d=>`<path d="${d}"/>`).join('')}</g>`;
const trail=`<g transform="rotate(-90 64 64)">${stroke(['M22 24 H75 C91 24 104 36 104 52 C104 66 93 78 78 78 H50 C34 78 24 89 24 104 H79'])}</g>`;
const convergingArm='<path d="M21 24 H34 Q39 24 42 29 L57 53 Q61 60 53 60 H40 Q35 60 32 55 L17 31 Q13 24 21 24 Z"/>';
const confluence=`<g fill="${gold}">${convergingArm}<g transform="translate(128 0) scale(-1 1)">${convergingArm}</g><rect x="52" y="77" width="24" height="37" rx="6"/></g>`;
const stream=`<g transform="translate(0 -3)">${stroke(['M16 32 H36 C50 32 50 46 64 46 H112','M16 60 H36 C50 60 50 74 64 74 H112','M16 88 H36 C50 88 50 102 64 102 H112'],12)}</g>`;
const routeA='M18 28 H58 Q80 28 80 50 V72 Q80 90 62 90 H40';
const routeB='M110 100 H70 Q48 100 48 78 V56 Q48 38 66 38 H76';
const pair=`<defs><mask id="paired-track-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128"><rect width="128" height="128" fill="white"/><path d="${routeA}" fill="none" stroke="black" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/></mask></defs>${stroke([routeA])}<g mask="url(#paired-track-gap)">${stroke([routeB])}</g>`;
const entries=[
  {stem:'102-trade-trail',title:'Trade Trail',inner:trail,caption:'Follow a KOL through a sequence of trades.',meaning:'A continuous path represents following a KOL through their trading history.'},
  {stem:'103-confluence',title:'Confluence',inner:confluence,caption:'Several KOL routes meet around one token.',meaning:'Three routes converge, representing several KOLs trading the same token.'},
  {stem:'104-activity-stream',title:'Activity Stream',inner:stream,caption:'Live wallet activity flows into one feed.',meaning:'Repeated flowing lines represent the live stream of tracked wallet activity.'},
  {stem:'105-paired-tracks',title:'Paired Tracks',inner:pair,caption:'Compare the activity of tracked KOL wallets.',meaning:'Two paired paths represent comparing activity across KOL wallets.'},
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
  manifest.push({...e,inner:undefined,svg:`${e.stem}.svg`,png:`${e.stem}.png`,header:`${e.stem}-header.svg`,color:gold,medium:'Native SVG vector concepts',direction:'Abstract symbols tied to KOL tracking'});
  console.log(`${e.stem}: exact yellow, transparent background and padding verified`);
}
await sharp({create:{width:1200,height:920,channels:4,background:'#0b0e11'}}).composite(composites).png().toFile(fileURLToPath(file('comparison-round-32.png')));
await writeFile(file('round-32-manifest.json'),JSON.stringify(manifest,null,2));
let notes='# Kollens abstract tracking icons — round 32\n\nDirection: abstract symbols tied to KOL tracking. Four editable SVG marks, rendered as transparent PNGs, all in #F9C932.\n\n';
for(const e of entries)notes+=`## ${e.title}\n\n${e.meaning}\n\n- [SVG](${e.stem}.svg)\n- [Transparent PNG](${e.stem}.png)\n- [Header preview](${e.stem}-header.svg)\n\n`;
await writeFile(file('round-32-notes.md'),notes);
