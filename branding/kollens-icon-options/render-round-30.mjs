import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const file = name => new URL(name,import.meta.url);
const entries = [
  {stem:'94-k-shutter',title:'K Shutter',caption:'Optical blades form the K in KOL + Lens.',meaning:'The K is formed by optical blades: focus on KOL activity.'},
  {stem:'95-optic-fold',title:'Optic Fold',caption:'One optical ribbon combines trader and token views.',meaning:'A folded optical ribbon combines the trader and token views in one lens.'},
  {stem:'96-twin-focus',title:'Twin Focus',caption:'Two optical surfaces bring wallet and token into focus.',meaning:'Two optical surfaces bring the KOL wallet and token activity into the same focus.'},
  {stem:'97-signal-loop',title:'Signal Loop',caption:'A continuous path follows KOL activity over time.',meaning:'A continuous optical path represents following a KOL’s activity over time.'},
];
const official = await readFile(file('../../public/kollens-header-logo.svg'),'utf8');
const wordmark = official.slice(official.indexOf('<svg x="53"'));
const composites = [], manifest = [];
for(let i=0;i<entries.length;i++) {
  const entry=entries[i], svg=await readFile(file(`${entry.stem}.svg`),'utf8');
  const body=svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/)?.[1];
  if(!body)throw new Error(`${entry.stem}: invalid SVG root`);
  const png=await sharp(Buffer.from(svg)).resize(512,512).png().toBuffer();
  const {data,info}=await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let opaque=0,transparent=0;
  for(let j=0;j<data.length;j+=4) {
    if(data[j+3]===0) transparent++;
    if(data[j+3]===255){opaque++;if(data[j]!==249||data[j+1]!==201||data[j+2]!==50)throw new Error(`${entry.stem}: wrong brand color`);}
  }
  if(!opaque||!transparent||info.channels!==4)throw new Error(`${entry.stem}: missing icon or transparency`);
  for(let p=0;p<512;p++) {
    if(data[p*4+3] || data[((511*512)+p)*4+3] || data[(p*512)*4+3] || data[((p*512)+511)*4+3])throw new Error(`${entry.stem}: geometry touches export boundary`);
  }
  await writeFile(file(`${entry.stem}.png`),png);
  const lockup=`<svg xmlns="http://www.w3.org/2000/svg" width="183.939" height="42" viewBox="0 0 183.939 42"><svg x="0" y="0" width="42" height="42" viewBox="0 0 128 128" fill="#F9C932">${body}</svg>${wordmark}`;
  await writeFile(file(`${entry.stem}-header.svg`),lockup);
  const large=await sharp(Buffer.from(svg)).resize(280,280).png().toBuffer();
  const small=await sharp(Buffer.from(lockup)).resize({height:34}).png().toBuffer();
  const {width:smallWidth}=await sharp(small).metadata();
  const label=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="45"><text x="300" y="30" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" font-weight="600" fill="#f3f5f6">${i+1} · ${entry.title}</text></svg>`;
  const caption=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="45"><text x="300" y="25" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#adb6bd">${entry.caption}</text></svg>`;
  const left=(i%2)*600,top=Math.floor(i/2)*460;
  composites.push({input:large,left:left+160,top:top+20},{input:Buffer.from(label),left,top:top+310},{input:Buffer.from(caption),left,top:top+350},{input:small,left:left+Math.round((600-smallWidth)/2),top:top+405});
  manifest.push({...entry,svg:`${entry.stem}.svg`,png:`${entry.stem}.png`,header:`${entry.stem}-header.svg`,color:'#F9C932',generationMode:'built-in ImageGen with native SVG refinement'});
  console.log(`${entry.stem}: exact yellow, transparency and export padding verified`);
}
await sharp({create:{width:1200,height:920,channels:4,background:'#0b0e11'}}).composite(composites).png().toFile(fileURLToPath(file('comparison-round-30.png')));
await writeFile(file('round-30-manifest.json'),JSON.stringify(manifest,null,2));
let notes='# Kollens icon options — round 30\n\nBuilt-in ImageGen concepts, finished as clean native SVG geometry. Exact #F9C932 and transparent backgrounds verified. Comparison sheet includes a brief meaning and a small header preview for each option.\n\n';
for(const entry of entries)notes+=`## ${entry.title}\n\n${entry.meaning}\n\n- [SVG](${entry.stem}.svg)\n- [Transparent PNG](${entry.stem}.png)\n- [Header preview](${entry.stem}-header.svg)\n- [Generation prompt](${entry.stem}-prompt.md)\n\n`;
await writeFile(file('round-30-notes.md'),notes);
