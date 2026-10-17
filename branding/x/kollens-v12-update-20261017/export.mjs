import sharp from 'sharp';
import{readFile,writeFile,copyFile}from'node:fs/promises';import{fileURLToPath}from'node:url';import{createRequire}from'node:module';import{createHash}from'node:crypto';
const require=createRequire(import.meta.url),fontkit=require('../../../.cache/launch-font-tools/node_modules/fontkit');const file=n=>new URL(n,import.meta.url);
const fonts=new Map();for(const w of[400,600,700,800]){const name=`manrope-${w}.woff`;try{await readFile(file('shared/'+name));}catch{await copyFile(new URL('../kollens-feature-series-20261012-v2/shared/'+name,import.meta.url),file('shared/'+name));}fonts.set(w,fontkit.openSync(fileURLToPath(file('shared/'+name))));}
const gold='#F9C932',white='#F5F6F7',muted='#A5AFB5';
function text(str,x,y,size=22,weight=600,color=white,maxWidth=Infinity,anchor='start'){
 const f=fonts.get(weight),run=f.layout(str);if(run.glyphs.some(g=>g.id===0))throw Error('Missing glyph '+str);const advance=run.positions.reduce((n,p)=>n+p.xAdvance,0);size=Math.min(size,maxWidth*f.unitsPerEm/advance);const scale=size/f.unitsPerEm,width=advance*scale;let cursor=anchor==='end'?x-width:anchor==='middle'?x-width/2:x;
 const d=run.glyphs.map((g,i)=>{const p=run.positions[i],px=cursor+p.xOffset*scale;cursor+=p.xAdvance*scale;return`<path d="${g.path.toSVG()}" transform="translate(${px} ${y-p.yOffset*scale}) scale(${scale} ${-scale})"/>`;}).join('');return`<g fill="${color}"><title>${str.replaceAll('&','&amp;')}</title>${d}</g>`;
}
const line=(d,c=gold,w=2)=>`<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const box=(x,y,w,h,r=8,fill='#11181C',stroke='#384148')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
const star=(x,y,s=18)=>`<path transform="translate(${x} ${y}) scale(${s/24})" d="m12 2 3.1 6.3 7 .9-5.1 4.9 1.2 6.9L12 17.7l-6.2 3.3 1.2-6.9-5.1-4.9 7-.9z" fill="${gold}"/>`;
const logo=await readFile(file('shared/logo.svg'),'utf8');const body=logo.replace(/^<svg[^>]*>/,'').replace(/<\/svg>\s*$/,'');
let svg=`<g transform="translate(80 72) scale(${265/201.20397203})">${body}</g>`;
svg+=text('V1.2 UPDATE',84,230,24,800,gold,620);
svg+=text('Your watchlist.',80,335,80,800,white,650);
svg+=text('Everywhere.',80,416,80,800,white,650);
const features=['Telegram login','Favorites synced across devices','Token replay videos','More reliable KOL P&L','Faster chart & replay loading'];
features.forEach((s,i)=>{const y=500+i*45;svg+=`<rect x="84" y="${y-13}" width="7" height="7" rx="1" fill="${gold}"/>`+text(s,108,y,24,600,'#C4CCD1',625);});
svg+=text('kollens.com',84,816,31,700,gold);
// All feature titles sit within the background's right-hand panels.
svg+=text('Favorites, in sync',851,214,29,800,white,615);
svg+=box(851,239,217,39,8,'#1E262A','#4A545A');
svg+=`<path d="m867 257 22-8-5 20-6-6-4 3 1-7 10-7-13 6z" fill="${gold}"/>`;
svg+=text('Telegram login',901,265,17,700,white,151);
// Illustrative desktop and mobile, containing favorite categories rather than invented wallet figures.
svg+=box(853,304,309,127,10,'#0C1114','#657079');
svg+=line('M855 341H1160','#303A40',1)+text('Watchlist',872,329,17,700,white);
svg+=star(874,355,21)+text('Tokens',910,374,19,700,white)+text('Saved',1142,374,13,600,muted,70,'end');
svg+=star(874,391,21)+text('KOLs',910,410,19,700,white)+text('Saved',1142,410,13,600,muted,70,'end');
svg+=line('M994 433v15M965 449h60','#657079',3);
svg+=line('M1194 340h78m-9-8 9 8-9 8M1272 378h-78m9-8-9 8 9 8',gold,2.4)+text('SYNCED',1233,416,12,700,muted,90,'middle');
svg+=box(1310,276,107,175,18,'#0D1317','#76838B')+line('M1346 287h35','#69757D',3)+star(1345,309,36);
svg+=box(1323,361,81,28,5,'#1C252A','#28353C')+star(1331,369,12)+line('M1353 373h39','#737E85',2);
svg+=box(1323,398,81,28,5,'#1C252A','#28353C')+star(1331,406,12)+line('M1353 410h39','#737E85',2);
svg+=`<circle cx="1411" cy="439" r="17" fill="#14372D" stroke="#39CB8F"/>`+line('m1403 439 5 5 9-11','#39CB8F',2.5);
svg+=text('Tokens + KOLs. One saved watchlist.',851,473,17,600,muted,615);
// Real archived chart observations, used as a non-live feature illustration; no numeric claims.
const snapshot=JSON.parse(await readFile(file('sources/chart-snapshot.json'),'utf8'));
const token=snapshot.tokens.find(t=>t.name==='GM'),points=token.chart.candles.map(c=>[Number(c.time),Number(c.close)]).filter(p=>p[1]>0).sort((a,b)=>a[0]-b[0]);
const min=Math.min(...points.map(p=>p[1])),max=Math.max(...points.map(p=>p[1])),t0=points[0][0],t1=points.at(-1)[0];
const d=points.map(([t,v],i)=>`${i?'L':'M'}${(857+(t-t0)/(t1-t0)*438).toFixed(2)} ${(646-(v-min)/(max-min)*49).toFixed(2)}`).join(' ');
svg+=text('Token replay videos',851,573,27,800,white,550);
svg+=box(1381,550,75,29,7,'#20282D','#49545B')+text('MP4',1418.5,570,13,800,gold,58,'middle');
svg+=line(d,'#39CB8F',2.7);
svg+=`<circle cx="1417" cy="625" r="31" fill="#F9C932"/><path d="m1409 611 22 14-22 14z" fill="#10171B"/>`;
svg+=line('M857 674H1454','#455058',3)+line('M857 674H1202',gold,3)+`<circle cx="1202" cy="674" r="5" fill="${gold}"/>`;
svg+=text('Export & share',857,705,16,600,muted,500);
const overlay=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">${svg}</svg>`;
const bg=await sharp(await readFile(file('background.png'))).resize(1600,900,{fit:'fill'}).png().toBuffer();
const output=await sharp(bg).composite([{input:Buffer.from(overlay)}]).removeAlpha().png().toBuffer();
await writeFile(file('overlay.svg'),overlay);await writeFile(file('kollens-v12-update.png'),output);
await writeFile(file('kollens-v12-update.svg'),overlay.replace('viewBox="0 0 1600 900">',`viewBox="0 0 1600 900"><image width="1600" height="900" href="data:image/png;base64,${bg.toString('base64')}"/>`));
const hash=v=>createHash('sha256').update(v).digest('hex');
await writeFile(file('manifest.json'),JSON.stringify({width:1600,height:900,versionLabel:'V1.2',title:'V1.2 Update',features,featureListOnImage:true,font:'Exact app Manrope glyphs',brandGold:gold,logoSha256:hash(logo),imageSha256:hash(output),generationRoute:'Built-in ImageGen background; exact SVG and Sharp foreground',nativeBackground:'C:/Users/PC/.codex/generated_images/01a0deed-e93b-7573-9540-7d96188a7440/exec-ba810d63-9038-46e9-9352-376c2bee956a.png',visuals:'Illustrative synced desktop/mobile watchlists. GM historical closing observations from retained campaign snapshot illustrate token replay controls; no prices or performance claims. Not a screenshot of a logged-in user.',chartPoints:points.length,chartToken:token.name,noDatesOnImage:true,noBuySellPositions:true},null,2)+'\n');
console.log(fileURLToPath(file('kollens-v12-update.png')));
