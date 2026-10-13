import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const fontkit = require('../../../.cache/launch-font-tools/node_modules/fontkit');
const file = name => new URL(name, import.meta.url);
const source = name => new URL('../kollens-feature-series-20261012-v2/' + name, import.meta.url);
const fonts = new Map([400,500,600,700,800].map(weight => [weight,fontkit.openSync(fileURLToPath(source('shared/manrope-' + weight + '.woff')))]));
const snapshot = JSON.parse(await readFile(source('shared/snapshot.json'),'utf8'));
const logo = await readFile(source('shared/logo.svg'),'utf8');
const logoBody = logo.replace(/^<svg[^>]*>/,'').replace(/<\/svg>\s*$/,'');
const gold='#F9C932',white='#F4F5F6',muted='#949DA2',green='#39CB8F',red='#F1767A';
const escape = text => String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');

function label(value,x,y,size=20,weight=600,color=white,anchor='start',spacing=0) {
 const font=fonts.get(weight),run=font.layout(String(value)),scale=size/font.unitsPerEm;
 if(run.glyphs.some(glyph=>glyph.id===0))throw new Error('Missing font glyph: '+value);
 const width=run.positions.reduce((sum,position)=>sum+position.xAdvance*scale,0)+Math.max(0,run.glyphs.length-1)*spacing;
 let cursor=anchor==='end'?x-width:anchor==='middle'?x-width/2:x;
 const paths=run.glyphs.map((glyph,index)=>{
  const position=run.positions[index],px=cursor+position.xOffset*scale,py=y-position.yOffset*scale;
  cursor+=position.xAdvance*scale+spacing;
  return '<path d="'+glyph.path.toSVG()+'" transform="translate('+px+' '+py+') scale('+scale+' '+-scale+')"/>';
 }).join('');
 return {svg:'<g fill="'+color+'"><title>'+escape(value)+'</title>'+paths+'</g>',width};
}
const text=(...args)=>label(...args).svg;
const box=(x,y,width,height,radius=8,fill='#151B1D',stroke='#303A3D')=>'<rect x="'+x+'" y="'+y+'" width="'+width+'" height="'+height+'" rx="'+radius+'" fill="'+fill+'" stroke="'+stroke+'" stroke-width=".8"/>';
const cap=value=>Number(value)>=1e6?'$'+(Number(value)/1e6).toFixed(2)+'M':'$'+(Number(value)/1e3).toFixed(1)+'K';
const star=(x,y,size=14)=>'<path transform="translate('+x+' '+y+') scale('+size/24+')" d="m12 2 3.1 6.3 7 .9-5.1 4.9 1.2 6.9L12 17.7l-6.2 3.3 1.2-6.9-5.1-4.9 7-.9z" fill="'+gold+'"/>';
let imageCounter=0;
async function picture(name,x,y,width,height=width,radius=8) {
 const bytes=await readFile(source(name)),id='art-'+(++imageCounter);
 return '<defs><clipPath id="'+id+'"><rect x="'+x+'" y="'+y+'" width="'+width+'" height="'+height+'" rx="'+radius+'"/></clipPath></defs><image x="'+x+'" y="'+y+'" width="'+width+'" height="'+height+'" preserveAspectRatio="xMidYMid slice" clip-path="url(#'+id+')" href="data:image/png;base64,'+bytes.toString('base64')+'"/>';
}
function sparkline(token,x,y,width,height) {
 const points=token.chart.candles.map(candle=>[Number(candle.time),Number(candle.close)]).filter(point=>point[1]>0).sort((a,b)=>a[0]-b[0]);
 if(points.length<2)throw new Error('Missing real chart points');
 const min=Math.min(...points.map(point=>point[1])),max=Math.max(...points.map(point=>point[1])),start=points[0][0],end=points.at(-1)[0];
 const path=points.map(([time,value],index)=>(index?'L':'M')+(x+(time-start)/(end-start||1)*width).toFixed(2)+' '+(y+height-(value-min)/(max-min||1)*height).toFixed(2)).join(' ');
 const color=points.at(-1)[1]>=points[0][1]?green:red;
 return '<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>';
}
function featureIcon(kind,x,y) {
 const shapes=[
  '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  '<path d="m12 2 3.1 6.3 7 .9-5.1 4.9 1.2 6.9L12 17.7l-6.2 3.3 1.2-6.9-5.1-4.9 7-.9z"/>',
  '<path d="M3 3v18h18M6 15l5-5 4 3 6-8"/>',
  '<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/>',
  '<path d="M4 20V12h4v8M10 20V5h4v15M16 20V9h4v11"/>',
  '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m10 8 6 4-6 4z"/>'
 ];
 return '<g transform="translate('+x+' '+y+')" fill="none" stroke="'+gold+'" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">'+shapes[kind]+'</g>';
}

let svg='<g transform="translate(80 72) scale('+320/201.20397203+')">'+logoBody+'</g>';
svg+=text('KOLLENS V1 · FEATURE OVERVIEW',84,224,18,700,gold);
svg+=text('V1 is here.',80,335,88,800,'#FFFFFF','start',-3.1);
svg+=text('Follow KOL activity on BNB Chain.',84,390,26,500,'#ABB3B8','start',-.3);
const features=[
 {icon:0,title:'Live KOL trades',detail:'Buys & sells'},
 {icon:1,title:'Token watchlists',detail:'Save, sort & scan'},
 {icon:2,title:'Market-cap charts',detail:'Token details'},
 {icon:3,title:'KOL profiles',detail:'Wallet activity'},
 {icon:4,title:'24h tracked P&L',detail:'Leaderboard'},
 {icon:5,title:'Trade replays',detail:'Image & video export'}
];
for(const [index,feature] of features.entries()) {
 const x=index%2===0?85:390,y=458+Math.floor(index/2)*90;
 svg+=featureIcon(feature.icon,x,y-21);
 svg+=text(feature.title,x+39,y,22,600,white,'start',-.3);
 svg+=text(feature.detail,x+39,y+25,16,400,'#ABB3B8','start',-.2);
}
svg+=text('kollens.com',84,786,31,700,gold,'start',-.6);

svg+=text('Live KOL trades',789,181,20,700)+text('BNB CHAIN',1460,181,11,700,muted,'end',.6);
const feedRows=[snapshot.trades.find(row=>row.kolTwitter==='aa_AFeng'),snapshot.trades.find(row=>row.kolTwitter==='0xAA_Science')];
if(feedRows.some(row=>!row))throw new Error('Required real KOL rows missing');
for(const [index,row] of feedRows.entries()) {
 const y=[236,313][index],buy=row.side==='buy',color=buy?green:red;
 svg+=box(786,y-30,676,61,8,index?'#192022':'#151B1D');
 svg+=await picture(row.kolArt,801,y-19,37);
 svg+=text(row.renderKolName,851,y-3,20,800)+text('@'+row.kolTwitter,851,y+16,11,400,muted);
 svg+=await picture(row.art,1046,y-14,28);
 svg+=text(row.tokenSymbol,1084,y+5,18,700);
 svg+=box(1236,y-13,41,22,5,buy?'#13352C':'#352027','none')+text(buy?'BUY':'SELL',1256.5,y+2,10,800,color,'middle');
 const amount=Number(row.quoteAmount).toLocaleString('en-US',{maximumFractionDigits:3})+' BNB';
 svg+=text(amount,1444,y+1,20,700,color,'end');
 const timestamp=new Date(row.timestamp);
 svg+=text(timestamp.getUTCDate()+' Oct · '+timestamp.toISOString().slice(11,16)+' UTC',1444,y+18,10,400,muted,'end');
}
svg+=text('Recorded activity · 12 Oct 2026',1458,355,10,400,muted,'end');

svg+=text('Watchlist',791,442,20,700)+text('7D CHARTS',1219,442,10,600,muted,'end',.6);
for(const [index,token] of snapshot.tokens.entries()) {
 const y=[485,550,615][index];
 svg+=box(785,y-25,439,50,7,index%2?'#192022':'#151B1D');
 svg+=star(793,y-7,14)+await picture('shared/'+token.image+'.png',816,y-17,34,34,8);
 svg+=text(token.name,861,y-1,16,800)+text('BNB Chain',861,y+15,10,400,muted);
 svg+=sparkline(token,1025,y-12,70,24);
 svg+=text('MCAP',1209,y-9,9,500,muted,'end')+text(cap(token.market.token.marketCapUsd),1209,y+13,17,700,gold,'end',-.2);
}
svg+=text('Trade replays',1281,417,17,700);
svg+=await picture('shared/replay-frame.png',1281,431,200,250,10);

svg+=text('Profiles + leaderboard',826,716,16,700);
svg+=await picture(snapshot.profile.art,826,727,32,32,8);
svg+=text(snapshot.profile.kol.name,870,744,18,800);
const profit=Number(snapshot.profile.stats.realizedProfitUsd);
svg+=text((profit>=0?'+':'−')+cap(Math.abs(profit))+'*',1228,744,25,800,profit>=0?green:red,'end');
svg+=text('24h tracked P&L · '+snapshot.profile.stats.valuedSellCount+' matched / '+snapshot.profile.stats.excludedSellCount+' excluded',870,759,9.5,400,muted);
svg+=text('* Unmatched sales excluded',1030,790,10,400,muted,'middle');

const overlay='<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">'+svg+'</svg>';
await writeFile(file('overview.svg'),overlay);
const background=await sharp(await readFile(file('background.png'))).resize(1600,900,{fit:'cover'}).png().toBuffer();
const image=await sharp(background).composite([{input:Buffer.from(overlay)}]).png().toBuffer();
await writeFile(file('kollens-v1-overview.png'),image);

const opener="1/6 Kollens V1\n\nLive KOL trades, watchlists, token charts, KOL profiles, tracked 24h P&L rankings and shareable replays on BNB Chain.\n\nFeaturing Afeng, 0xAA, 0xLuck & clukz; BIBI, okt, WangChai, SAFU & GM.\n\nFeature tour below ↓\n\nhttps://kollens.com\n\n#BNBChain #KOLTracking";
const existing=JSON.parse(await readFile(source('posts.json'),'utf8'));
const heading=['Live KOL trades','Watchlists','Token details','KOL profiles & P&L','Trade replays'];
const replies=[{number:1,title:'Kollens V1 overview',image:'01-kollens-v1.png',caption:opener,sourceImage:'kollens-v1-overview.png'}];
for(const [index,post] of existing.entries()) replies.push({
 number:index+2,title:heading[index],image:String(index+2).padStart(2,'0')+'-'+post.slug.slice(3)+'.png',
 caption:(index+2)+'/6 '+heading[index]+'\n\n'+post.caption,
 sourceImage:'../kollens-feature-series-20261012-v2/'+post.slug+'/post.png'
});
let thread='# Kollens V1 — reply thread\n\nReply 1 goes directly beneath the existing launch post. Each subsequent reply goes beneath the previous reply so all six stay in one thread. Attach the matching image listed below.\n\n';
await mkdir(file('captions/'),{recursive:true});
for(const reply of replies) {
 reply.weightedCharacters=[...reply.caption.replace(/https?:\/\/\S+/g,'x'.repeat(23))].reduce((sum,character)=>sum+(character.codePointAt(0)>0x10ff?2:1),0);
 if(reply.weightedCharacters>280)throw new Error('Reply '+reply.number+' exceeds 280 characters');
 reply.captionFile='captions/'+String(reply.number).padStart(2,'0')+'-'+(reply.number===1?'v1-overview':existing[reply.number-2].slug.slice(3))+'.txt';
 await writeFile(file(reply.captionFile),reply.caption+'\n');
 thread+='## '+reply.number+'/6 — '+reply.title+'\n\nImage: `'+reply.image+'`\n\n'+reply.caption+'\n\n';
}
await writeFile(file('thread.json'),JSON.stringify({parent:'Existing Kollens launch post',postingMode:'Sequential replies to previous post',replies},null,2));
await writeFile(file('thread.md'),thread);
const manifest={width:1600,height:900,font:'Manrope (exact app WOFF glyph outlines)',logoSha256:createHash('sha256').update(logo).digest('hex'),overviewSha256:createHash('sha256').update(image).digest('hex'),generationRoute:'Retained native ImageGen plate; exact app logo, Manrope SVG text, original artwork and genuine app data composed with Sharp. Overview retains the actual clukz app replay; reply 6 uses the unchanged supplied Afeng/BIBI app replay.',dataSource:'../kollens-feature-series-20261012-v2/shared/snapshot.json',reply6Source:'../kollens-feature-series-20261012-v2/shared/afeng-bibi-source.json',snapshotAt:snapshot.retrievedAt,liveRowsSnapshotAt:snapshot.liveRowsRetrievedAt,replies:replies.map(reply=>({number:reply.number,title:reply.title,image:reply.image,caption:reply.captionFile,weightedCharacters:reply.weightedCharacters}))};
await writeFile(file('manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({overview:'kollens-v1-overview.png',replies:replies.map(reply=>({number:reply.number,characters:reply.weightedCharacters,image:reply.image}))}));
