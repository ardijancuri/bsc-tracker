import sharp from 'sharp';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const require=createRequire(import.meta.url);
const fontkit=require('../../../.cache/launch-font-tools/node_modules/fontkit');
const file=name=>new URL(name,import.meta.url);
const fonts=new Map([400,500,600,700,800].map(w=>[w,fontkit.openSync(fileURLToPath(file(`shared/manrope-${w}.woff`)))]));
const posts=JSON.parse(await readFile(file('posts.json'),'utf8'));
const snapshot=JSON.parse(await readFile(file('shared/snapshot.json'),'utf8'));
const logo=await readFile(file('shared/logo.svg'),'utf8');
const logoBody=logo.replace(/^<svg[^>]*>/,'').replace(/<\/svg>\s*$/,'');
const gold='#F9C932',white='#F4F5F6',muted='#949DA2',green='#39CB8F',red='#F1767A';
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
let cjkFont;
function label(value,x,y,size=20,weight=600,color=white,anchor='start',spacing=0){
 const font=/[\u3400-\u9fff]/u.test(String(value))?(cjkFont??=fontkit.openSync('C:/Windows/Fonts/msyh.ttc','MicrosoftYaHei')):fonts.get(weight);
 const run=font.layout(String(value)),scale=size/font.unitsPerEm;
 if(run.glyphs.some(glyph=>glyph.id===0))throw new Error(`Missing font glyph in: ${value}`);
 const width=run.positions.reduce((n,p)=>n+p.xAdvance*scale,0)+Math.max(0,run.glyphs.length-1)*spacing;
 let cursor=anchor==='end'?x-width:anchor==='middle'?x-width/2:x;
 const paths=run.glyphs.map((glyph,i)=>{const p=run.positions[i],px=cursor+p.xOffset*scale,py=y-p.yOffset*scale;cursor+=p.xAdvance*scale+spacing;return `<path d="${glyph.path.toSVG()}" transform="translate(${px} ${py}) scale(${scale} ${-scale})"/>`;}).join('');
 return {svg:`<g fill="${color}"><title>${escape(value)}</title>${paths}</g>`,width};
}
const text=(...args)=>label(...args).svg;
const star=(x,y,s=18)=>`<path transform="translate(${x} ${y}) scale(${s/24})" d="m12 2 3.1 6.3 7 .9-5.1 4.9 1.2 6.9L12 17.7l-6.2 3.3 1.2-6.9-5.1-4.9 7-.9z" fill="${gold}"/>`;
const box=(x,y,w,h,r=8,fill='#151A1D',stroke='#343C40')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width=".8"/>`;
const money=(v,decimals=2)=>'$'+Number(v).toLocaleString('en-US',{maximumFractionDigits:decimals,minimumFractionDigits:decimals});
const cap=v=>{const n=Number(v);return n>=1e6?'$'+(n/1e6).toFixed(2)+'M':n>=1e3?'$'+(n/1e3).toFixed(1)+'K':money(n);};
const short=a=>a.slice(0,7)+'…'+a.slice(-4);
let imageCounter=0;
async function picture(name,x,y,w,h=w,r=10){
 const bytes=await readFile(file(name));const id=`art-${++imageCounter}`;
 return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath></defs><image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})" href="data:image/png;base64,${bytes.toString('base64')}"/>`;
}
function points(token){const bars=token.chart.candles||[];return bars.map(b=>[Number(b.time),Number(b.close)]).filter(p=>Number.isFinite(p[0])&&p[1]>0).sort((a,b)=>a[0]-b[0]);}
function graph(data,x,y,w,h,fill=false,colorOverride){
 if(data.length<2)throw new Error('Chart needs genuine points');
 const min=Math.min(...data.map(p=>p[1])),max=Math.max(...data.map(p=>p[1])),t0=data[0][0],t1=data.at(-1)[0];
 const coords=data.map(([time,v])=>[x+(time-t0)/(t1-t0||1)*w,y+h-(v-min)/(max-min||1)*h]);
 const color=colorOverride||(data.at(-1)[1]>=data[0][1]?green:red);
 const path=coords.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ');
 return `${fill?`<path d="${path} L${x+w} ${y+h} L${x} ${y+h}Z" fill="${color}" opacity=".08"/>`:''}<path d="${path}" fill="none" stroke="${color}" stroke-width="${fill?2.5:2.1}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
function common(post,index){
 let svg=`<g transform="translate(80 72) scale(${320/201.20397203})">${logoBody}</g>`;
 svg+=text(`${String(index+1).padStart(2,'0')} / 05 · ${post.title.toUpperCase()}`,84,233,18,700,gold);
 for(const [i,line] of post.headline.entries())svg+=text(line,80,342+i*84,88,800,'#FFFFFF','start',-3.2);
 svg+=text(post.subtitle,84,502,32,600,white,'start',-.6);
 for(const [i,line] of post.body.entries())svg+=text(line,84,559+i*37,25,400,'#ABB3B8','start',-.3);
 svg+=text(post.features,84,684,20,500,'#C8CED1');
 svg+=text('kollens.com',84,786,31,700,gold,'start',-.6);
 return svg;
}
async function live(){
 let svg=text('Recent activity',950,195,20,700)+text('BNB CHAIN',1408,195,11,700,muted,'end',.7);
 for(const [index,trade] of snapshot.trades.entries()){
  const y=[266,376,487,597][index],buy=trade.side==='buy',color=buy?green:red;
  const quote=Number(trade.quoteAmount),amount=Number.isFinite(quote)?`${quote.toLocaleString('en-US',{maximumFractionDigits:3})} ${trade.quoteSymbol==='WBNB'?'BNB':trade.quoteSymbol}`:cap(trade.amountUsd);
  svg+=await picture(trade.kolArt||trade.art,951,y-23,46);
  svg+=text(trade.renderKolName||trade.kolName,1010,y-2,23,800);
  svg+=await picture(trade.art,1010,y+8,18,18,4);
  svg+=text(trade.tokenSymbol||trade.tokenName,1035,y+22,14,500,muted);
  svg+=box(1234,y-15,43,23,5,buy?'#13352C':'#352027','none')+text(buy?'BUY':'SELL',1255.5,y+1,10,800,color,'middle');
  svg+=text(amount,1408,y+1,20,700,color,'end');
  const date=new Date(trade.timestamp),time=`${date.getUTCDate()} Oct · ${date.toISOString().slice(11,16)} UTC`;
  svg+=text(time,1408,y+24,11,400,muted,'end');
 }
 svg+=text('Recorded on-chain trades · 11–12 Oct 2026',1180,698,12,400,muted,'middle');return svg;
}
async function watch(){
 let svg=text('Watchlist',843,255,23,700)+text('7D CHARTS',1390,255,12,600,muted,'end',.7);
 for(const [index,token] of snapshot.tokens.entries()){
  const y=[331,441,551][index];
  svg+=box(836,y-43,570,89,9,index%2?'#192022':'#151B1D','#303A3D');
  svg+=star(848,y-10,20)+await picture(`shared/${token.image}.png`,880,y-24,48,48,12);
  svg+=text(token.name,942,y+1,22,800)+text('BNB Chain',942,y+23,13,400,muted)+graph(points(token),1130,y-19,112,38);
  svg+=text('MCAP',1390,y-12,11,600,muted,'end',.4)+text(cap(token.market.token.marketCapUsd),1390,y+15,22,700,gold,'end',-.3);
 }
 svg+=text('24h',1040,648,14,600,muted,'middle')+text('1 week',1120,648,14,700,white,'middle')+text('1 month',1210,648,14,600,muted,'middle');
 svg+=`<path d="M1088 660h64" stroke="${gold}" stroke-width="2"/>`;return svg;
}
async function tokenDetail(){
 const token=snapshot.tokens.find(t=>t.name==='GM'),market=token.market.token;
 const data=points(token).map(([time,value])=>[time,value*Number(token.chart.marketCapSupply)]);
 let svg=await picture('shared/gm.png',960,270,42,42,10);
 svg+=text('GM',1014,295,27,800)+text('TOKEN DETAILS',1014,316,11,700,muted,'start',.5)+star(1329,274,19);
 svg+=text('Market cap',960,351,12,500,muted)+text(cap(market.marketCapUsd),960,379,25,800,gold);
 svg+=text('Tracked vol · 24h',1120,351,11,500,muted)+text(cap(market.volume24hUsd),1120,379,23,700,white);
 svg+=text('KOLs · 24h',1299,351,11,500,muted,'end')+text(market.kolCount24h,1299,379,23,700,white,'end');
 svg+=text('Market-cap history',960,414,12,600,muted);
 for(const y of [440,479,518])svg+=`<path d="M965 ${y}H1344" stroke="#353C40" stroke-width=".7" opacity=".55"/>`;
 svg+=graph(data,967,428,375,94,true);
 svg+=text('7d history · 1h candle closes',960,545,11,400,muted);
 const tabs=[['5m',1203],['1h',1240],['4h',1280],['1d',1320]];
 for(const [name,x]of tabs){if(name==='1h')svg+=box(x-15,557,31,23,4,'#242C31','#59666D');svg+=text(name,x,572,11,600,name==='1h'?white:muted,'middle');}
 return svg;
}
async function kolProfile(){
 const p=snapshot.profile,profit=Number(p.stats.realizedProfitUsd),color=profit>=0?green:red;
 let svg=await picture(p.art,924,293,60,60,17);
 svg+=text(p.kol.name,1001,321,31,800)+text(short(p.kol.address),1001,345,13,500,muted);
 svg+=star(1343,298,20);
 svg+=text('24h tracked realized P&L',924,386,14,500,muted);
 svg+=text((profit>=0?'+':'−')+cap(Math.abs(profit))+'*',924,426,38,800,color);
 svg+=text('Trades · 24h',1360,386,13,500,muted,'end')+text(p.tradeCount24h,1360,426,34,800,white,'end');
 svg+=text(`${p.stats.valuedSellCount} matched sales · ${p.stats.excludedSellCount} excluded`,924,454,12,400,muted);
 svg+=text(`${p.buyCount24h} buys · ${p.sellCount24h} sells`,1360,454,12,500,muted,'end');
 svg+=`<path d="M924 480H1360" stroke="#343C40" stroke-width=".7"/>`;
 svg+=text('Traded tokens',924,508,13,600,muted);
 const tokens=[p.tokens[0],p.tokens.find(t=>t.symbol==='SI')].filter(Boolean);
 for(const [i,t]of tokens.entries()){
  const x=924+i*141;svg+=box(x,523,127,43,7,'#192025','#333E43');
  if(t.profileArt)svg+=await picture(t.profileArt,x+7,530,29,29,7);
  svg+=text(t.symbol,x+45,551,16,700,white);
 }
 svg=`<g transform="translate(-50 -22)">${svg}</g>`;
 for(const [i,t]of tokens.entries()){
  const nodeY=[298,434][i];
  if(t.profileArt)svg+=await picture(t.profileArt,1450,nodeY+8,64,64,10);
  svg+=text(t.symbol,1482,nodeY+104,14,700,white,'middle');
 }
 svg+=text('* Unmatched sales are excluded from tracked P&L.',1097,645,12,400,muted,'middle');return svg;
}
async function replay(){
 let svg=await picture('shared/afeng-bibi-trade-replay.png',967,179,404,505,13);
 svg+=text('Afeng · BIBI · 12 Oct 2026',1170,778,14,500,muted,'middle');return svg;
}
const renderers=[live,watch,tokenDetail,kolProfile,replay];
const manifest={width:1600,height:900,revision:4,headlineBaselineStep:84,font:'Manrope (exact bundled WOFF glyph outlines); Microsoft YaHei fallback for actual Chinese token names',logoSha256:createHash('sha256').update(logo).digest('hex'),dataSnapshotAt:snapshot.retrievedAt,liveRowsSnapshotAt:snapshot.liveRowsRetrievedAt,liveKolHandles:snapshot.trades.map(trade=>trade.kolTwitter),generationRoute:'Retained built-in ImageGen campaign plates; exact SVG/Manrope/data and original artwork composition with Sharp. Replay example is the unchanged user-supplied Afeng/BIBI app replay image, fitted to the existing portrait frame.',replaySource:'shared/afeng-bibi-source.json',posts:[]};
let allCopy='# Kollens feature posts\n\n';
for(const [i,post]of posts.entries()){
 if(process.argv[2]&&post.slug!==process.argv[2])continue;
 const weighted=[...post.caption.replace(/https?:\/\/\S+/g,'x'.repeat(23))].reduce((sum,c)=>sum+(c.codePointAt(0)>0x10ff?2:1),0);
 if(weighted>280)throw new Error(`${post.slug}: caption too long (${weighted})`);
 await mkdir(file(post.slug+'/'),{recursive:true});
 imageCounter=0;
 const content=common(post,i)+await renderers[i]();
 const overlay=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">${content}</svg>`;
 await writeFile(file(`${post.slug}/overlay.svg`),overlay);
 const bg=await sharp(await readFile(file(`${post.slug}/background.png`))).resize(1600,900,{fit:'cover'}).png().toBuffer();
 const output=await sharp(bg).composite([{input:Buffer.from(overlay)}]).png().toBuffer();
 await writeFile(file(`${post.slug}/post.png`),output);
 await writeFile(file(`${post.slug}/post.txt`),post.caption+'\n');
 allCopy+=`## ${i+1}. ${post.title}\n\n${post.caption}\n\n`;
 manifest.posts.push({title:post.title,slug:post.slug,image:`${post.slug}/post.png`,caption:`${post.slug}/post.txt`,weightedCharacters:weighted,sha256:createHash('sha256').update(output).digest('hex'),nativePrompt:`${post.slug}/generation-prompt.md`});
}
await writeFile(file('posts.md'),allCopy);
await writeFile(file('manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest.posts.map(p=>({image:p.image,characters:p.weightedCharacters}))));
