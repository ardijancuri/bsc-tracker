import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const fontkit = require('../../../.cache/launch-font-tools/node_modules/fontkit');
const file = name => new URL(name, import.meta.url);
const fonts = new Map([400,500,600,700,800].map(weight => [weight,fontkit.openSync(fileURLToPath(file(`shared/manrope-${weight}.woff`)))]));
const gold='#F9C932',white='#F4F5F6',muted='#949DA2',green='#39CB8F',red='#F1767A';
const source = await readFile(file('shared/cryptocharming-gm-source.png'));
// Preserve the supplied price chart, its B/S/T markers and both average-price lines.
const crop = {left:15,top:48,width:550,height:202};
const chart = await sharp(source).extract(crop).png().toBuffer();
await writeFile(file('shared/cryptocharming-gm-chart.png'),chart);

function text(value,x,y,size=28,weight=600,color=white,anchor='start') {
 const font=fonts.get(weight),run=font.layout(value),scale=size/font.unitsPerEm;
 if(run.glyphs.some(glyph=>glyph.id===0))throw new Error(`Missing glyph: ${value}`);
 const width=run.positions.reduce((sum,p)=>sum+p.xAdvance*scale,0);
 let cursor=anchor==='end'?x-width:anchor==='middle'?x-width/2:x;
 const paths=run.glyphs.map((glyph,i)=>{
  const p=run.positions[i],px=cursor+p.xOffset*scale,py=y-p.yOffset*scale;
  cursor+=p.xAdvance*scale;
  return `<path d="${glyph.path.toSVG()}" transform="translate(${px} ${py}) scale(${scale} ${-scale})"/>`;
 }).join('');
 return `<g fill="${color}"><title>${value.replaceAll('&','&amp;')}</title>${paths}</g>`;
}
async function picture(name,x,y,width,height=width,radius=0){
 const bytes=await readFile(file(name));
 const id=name.replace(/\W/g,'-');
 const mime=name.endsWith('.jpg')?'image/jpeg':'image/png';
 return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"/></clipPath></defs><image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})" href="data:${mime};base64,${bytes.toString('base64')}"/>`;
}
let svg='<rect width="1080" height="1350" rx="36" fill="#0B0F11"/>';
svg+='<rect x="3" y="3" width="1074" height="1344" rx="33" fill="none" stroke="'+gold+'" stroke-width="7"/>';
svg+=await picture('shared/cryptocharming-avatar.jpg',42,45,106,106,53);
svg+=text('CryptoCharming',174,102,51,800);
svg+=text('GM POSITION HISTORY',175,144,25,700,muted);
svg+=await picture('shared/gm.png',935,47,76,76,18);
svg+=text('GM',973,160,30,800,white,'middle');
svg+=text('GM price · 30d',44,214,30,600,muted);
svg+=`<image x="32" y="237" width="1016" height="373.15" href="data:image/png;base64,${chart.toString('base64')}"/>`;

svg+='<rect x="30" y="630" width="1020" height="528" rx="28" fill="#14191B" stroke="#343C40" stroke-width="2"/>';
svg+=text('GMGN-reported total profit',63,684,29,500,muted);
svg+=text('+$18.8K',63,783,89,800,green);
svg+=text('+91.05%',1008,780,43,800,green,'end');
svg+='<path d="M63 820H1008 M63 976H1008" stroke="#343C40" stroke-width="2"/>';
svg+=text('Bought',63,868,28,500,muted);
svg+=text('$13.8K',63,919,43,800,green);
svg+=text('12 buys · 3.7M GM',63,955,26,400,muted);
svg+=text('Sold',568,868,28,500,muted);
svg+=text('$27K',568,919,43,800,red);
svg+=text('17 sells · 5.5M GM',568,955,26,400,muted);
svg+=text('Transfers in',63,1021,27,500,muted);
svg+=text('5M GM',63,1074,41,800,white);
svg+=text('$5.98K · 1 transfer',63,1115,26,400,muted);
svg+=text('Holding duration',568,1021,27,500,muted);
svg+=text('13 days',568,1074,41,800,white);
svg+=text('Open position',568,1115,26,400,muted);
svg+=text('Source: supplied GMGN position snapshot',540,1191,25,500,muted,'middle');

svg+='<path d="M7 1221H1073V1314Q1073 1343 1044 1343H36Q7 1343 7 1314Z" fill="'+gold+'"/>';
const logo=await readFile(file('shared/logo.svg'),'utf8');
const logoBody=logo.replace(/^<svg[^>]*>/,'').replace(/<\/svg>\s*$/,'').replace(/#[0-9a-f]{6}/gi,'#0B0F11');
svg+=`<g transform="translate(48 1264) scale(${329/201.20397203})">${logoBody}</g>`;
svg+=text('kollens.com',1010,1310,30,600,'#0B0F11','end');
const card='<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">'+svg+'</svg>';
await writeFile(file('shared/cryptocharming-gm-card.svg'),card);
const output=await sharp(Buffer.from(card)).png().toBuffer();
await writeFile(file('shared/cryptocharming-gm-card.png'),output);
await writeFile(file('shared/cryptocharming-gm-source.json'),JSON.stringify({
 source:'User-supplied GMGN position screenshot received 13 October 2026',
 sourceFile:'cryptocharming-gm-source.png',sourceSha256:createHash('sha256').update(source).digest('hex'),
 wallet:'0xcc291dcd83bd9f2600cca4d65ae3b724eaf4f5a9',kol:'CryptoCharming',xHandle:'CryptoCharming',
 token:'GM',contract:'0x13920fe6467e9e3c852b8d365a036c995f0f7777',
 chart:{file:'cryptocharming-gm-chart.png',units:'USD token price',selectedRange:'30d',sourceCrop:crop,rendering:'Unchanged screenshot pixels; chart and buy/sell/transfer markers are not reconstructed.'},
 displayed:{profitLabel:'GMGN-reported total profit',totalProfitUsd:'+$18.8K',totalProfitPercent:'+91.05%',boughtUsd:'$13.8K',buyCount:12,boughtTokens:'3.7M GM',soldUsd:'$27K',sellCount:17,soldTokens:'5.5M GM',transfersIn:'5M GM',transferInUsd:'$5.98K',transferCount:1,holdingDuration:'13 days'},
 interpretation:'Rounded figures copied from the supplied GMGN screenshot. Total profit includes a transferred-in position and is not claimed as Kollens-computed realized P&L or a closed single trade.',
 cardFile:'cryptocharming-gm-card.png',cardSha256:createHash('sha256').update(output).digest('hex'),
 font:'Exact bundled app Manrope outlined glyphs',exportRoute:'Existing editable SVG template and deterministic source-preserving Sharp export; retained native ImageGen campaign background.'
},null,2));
console.log(JSON.stringify({card:'shared/cryptocharming-gm-card.png',source:'shared/cryptocharming-gm-source.json'}));
