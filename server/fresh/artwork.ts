import { lookup } from 'node:dns';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import sharp from 'sharp';
import type { Pool } from 'pg';
import { normalizeLogoUrl } from '../tokenLogo.js';
import { imageMime, publicImageIp } from '../tokenImage.js';

const maxImageBytes=10*1024*1024,maxPageBytes=512*1024,maxPixels=16_000_000;
type Transport=(url:string,options:{signal:AbortSignal})=>Promise<Response>;
export interface FreshArtwork { data:Buffer;mime:'image/webp';url:string;source:'flap_contract_page'|'genius_contract_page'|'fourmeme_token_record'|'pancakeswap_market_record' }
export type FreshArtworkProvider='flap'|'genius'|'fourmeme'|'auto'|'pancakeswap';
export class FreshArtworkError extends Error { constructor(readonly reason:string){super(reason);} }
const fail=(reason:string):never=>{throw new FreshArtworkError(reason);};

/** Parse actual structured page records only. Metadata descriptions may contain
 * arbitrary escaped JSON; treating those strings as new records lets one token
 * impersonate another. Strings and a coin's nested user metadata are never walked. */
export function freshFlapArtworkFromHtml(html:string,address:string):string|null {
  if(Buffer.byteLength(html)>maxPageBytes)return null;
  const records:unknown[]=[],chunks:string[]=[];
  for(const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    const content=script[2].trim(),flight=content.match(/^self\.__next_f\.push\(([\s\S]*)\);?$/);
    if(flight){try{const value=JSON.parse(flight[1]);if(Array.isArray(value)&&value[0]===1&&typeof value[1]==='string')chunks.push(value[1]);}catch{/* No executable/partially escaped script can authorize artwork. */}}
    else if(/\btype\s*=\s*["']application\/json["']/i.test(script[1])){try{records.push(JSON.parse(content));}catch{/* Invalid application JSON is not a record. */}}
  }
  const joined=chunks.join('');
  for(const line of joined.split('\n')){const match=line.match(/^[0-9a-f]+:([\s\S]*)$/i);if(match&&/^[{[]/.test(match[1])){try{records.push(JSON.parse(match[1]));}catch{/* Module/text records cannot supply a coin. */}}}
  const candidates=new Set<string>();let visited=0;
  function walk(value:unknown,depth:number):void{
    if(depth>40||++visited>20_000||!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const item of value)walk(item,depth+1);return;}
    const object=value as Record<string,unknown>,coin=object.coin;
    if(coin&&typeof coin==='object'&&!Array.isArray(coin)){
      const record=coin as Record<string,unknown>;
      if(typeof record.address==='string'&&record.address.toLowerCase()===address){
        const metadata=record.metadata&&typeof record.metadata==='object'&&!Array.isArray(record.metadata)?record.metadata as Record<string,unknown>:{};
        const raw=typeof metadata.image==='string'?metadata.image:record.image;
        if(typeof raw==='string'){const image=normalizeLogoUrl(raw);if(image)candidates.add(image);}
      }
    }
    for(const[key,item]of Object.entries(object))if(!['coin','metadata','description','quoteToken'].includes(key))walk(item,depth+1);
  }
  for(const record of records)walk(record,0);
  return candidates.size===1?[...candidates][0]:null;
}

/** Canonical exact-contract page plus one real social-image tag. Escaped JSON
 * descriptions, token tickers and the site's default artwork are not identity. */
export function freshGeniusArtworkFromHtml(html:string,address:string):string|null{
  if(Buffer.byteLength(html)>maxPageBytes)return null;
  const attrs=(tag:string)=>Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1].toLowerCase(),m[2].replaceAll('&amp;','&')]));
  const canonical=[...html.matchAll(/<link\b[^>]*>/gi)].map(m=>attrs(m[0])).filter(a=>a.rel==='canonical').map(a=>a.href);
  if(canonical.length!==1)return null;
  try{const page=new URL(canonical[0]);if(page.origin!=='https://genius.fun'||page.pathname.toLowerCase()!=='/token/'+address||page.search||page.hash)return null;}catch{return null;}
  const images=new Set<string>();
  for(const m of html.matchAll(/<meta\b[^>]*>/gi)){const a=attrs(m[0]);if(a.property!=='og:image'||!a.content)continue;
    try{const image=new URL(a.content);if(image.origin!=='https://genius.fun'||image.pathname!=='/api/image'||image.username||image.password)continue;
      const src=image.searchParams.get('src');if(!src)continue;const normalized=normalizeLogoUrl(src);if(normalized&&freshArtworkUrl(normalized))images.add(normalized);
    }catch{/* Untrusted metadata cannot select an image. */}
  }return images.size===1?[...images][0]:null;
}

/** OpenFour and ordinary Four.Meme tokens share this first-party token record.
 * Read only the image beside an exact BSC contract, never a creator, template,
 * recommended token, ticker match or any of the provider's financial values. */
export function freshFourMemeArtworkFromJson(text:string,address:string):string|null{
  if(Buffer.byteLength(text)>maxPageBytes||!/^0x[0-9a-f]{40}$/.test(address))return null;
  try{
    const value=JSON.parse(text),record=value?.data;
    if(value?.code!==0||!record||Array.isArray(record)||typeof record.address!=='string'
      ||record.address.toLowerCase()!==address||record.networkCode!=='BSC'||typeof record.image!=='string')return null;
    const image=normalizeLogoUrl(record.image);return image&&freshArtworkUrl(image)?image:null;
  }catch{return null;}
}

/** Artwork enrichment only. Exact BSC/base-token identity is mandatory; quote
 * token icons, banners, names and all financial fields are ignored. Conflicting
 * images remain unavailable instead of selecting an arbitrary market's icon. */
export function freshPancakeArtworkFromJson(text:string,address:string):string|null{
  if(Buffer.byteLength(text)>maxPageBytes||!/^0x[0-9a-f]{40}$/.test(address))return null;
  try{
    const pairs=JSON.parse(text)?.pairs;if(!Array.isArray(pairs)||pairs.length>500)return null;
    const images=new Set<string>();
    for(const pair of pairs){
      if(pair?.chainId!=='bsc'||pair?.dexId!=='pancakeswap'||typeof pair.baseToken?.address!=='string'
        ||pair.baseToken.address.toLowerCase()!==address||!/^0x[0-9a-f]{40}$/i.test(pair.pairAddress??''))continue;
      if(typeof pair.info?.imageUrl!=='string')continue;
      const image=normalizeLogoUrl(pair.info.imageUrl);if(image&&freshArtworkUrl(image))images.add(image);
    }
    return images.size===1?[...images][0]:null;
  }catch{return null;}
}

/** The URL is untrusted even when it came from the correct launchpad page. */
export function freshArtworkUrl(value:string):string|null {
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!isIP(url.hostname)&&!url.hostname.startsWith('[')&&url.hostname.includes('.')&&url.href.length<=4096?url.href:null;}catch{return null;}
}
function publicAgent(){return new Agent({connect:{timeout:4000,lookup(hostname,options,callback){
  lookup(hostname,{all:true},(error,addresses)=>{if(error){callback(error,'',4);return;}
    const safe=addresses.filter(row=>publicImageIp(row.address));
    if(!safe.length){callback(new Error('artwork_private_host'),'',4);return;}
    if(options.all)callback(null,safe);else callback(null,safe[0].address,safe[0].family);
  });
}}});}
async function body(response:Response,limit:number):Promise<Buffer>{
  const declared=response.headers.get('content-length');
  if(!response.ok||!response.body||(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))){await response.body?.cancel();return fail('artwork_response_unavailable');}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();return fail('artwork_body_limit');}chunks.push(part.value);}
  return Buffer.concat(chunks);
}
async function request(url:string,limit:number,signal:AbortSignal,transport:Transport):Promise<Buffer>{
  // Redirects are deliberately not followed. The transport pins public DNS
  // addresses for every connection, closing both redirect and rebinding paths.
  if(!freshArtworkUrl(url))return fail('artwork_url_rejected');
  const response=await transport(url,{signal});return body(response,limit);
}

/** Some published token icons wrap ONE embedded PNG/JPEG/WebP in SVG. Extract
 * its raster bytes without ever handing XML to an SVG/image renderer. All other
 * SVG (including shapes, styles, entities and network references) is rejected. */
export function freshArtworkRaster(data:Buffer):Buffer|null {
  if(['image/png','image/jpeg','image/webp'].includes(imageMime(data)??''))return data;
  if(data.length>256*1024)return null;
  const text=data.toString('utf8').trim();
  const outer=text.match(/^<svg\s+([^<>]+)>\s*(?:<title(?:\s+id="[A-Za-z][\w-]{0,63}")?>[^<>&]{0,200}<\/title>\s*)?<image\s+([^<>]+)\/?>\s*<\/svg>$/);
  if(!outer)return null;
  const attributes=(value:string,allowed:Set<string>)=>{const out=new Map<string,string>();let end=0;
    for(const match of value.matchAll(/([\w:-]+)="([^"<>\r\n]*)"/g)){
      if(value.slice(end,match.index).trim()||!allowed.has(match[1])||out.has(match[1]))return null;
      out.set(match[1],match[2]);end=match.index!+match[0].length;
    }return value.slice(end).trim()?null:out;};
  const root=attributes(outer[1],new Set(['xmlns','width','height','viewBox','role','aria-labelledby']));
  const image=attributes(outer[2].replace(/\/$/,''),new Set(['width','height','href']));
  if(!root||!image||root.get('xmlns')!=='http://www.w3.org/2000/svg')return null;
  const embedded=image.get('href')?.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if(!embedded)return null;const raster=Buffer.from(embedded[2],'base64');
  return imageMime(raster)===`image/${embedded[1]}`?raster:null;
}
export async function normalizeFreshArtwork(data:Buffer):Promise<Buffer|null>{
  const raster=freshArtworkRaster(data);if(!raster||raster.length>maxImageBytes)return null;
  try {const image=sharp(raster,{limitInputPixels:maxPixels,failOn:'error',animated:false}),meta=await image.metadata();
    if(!meta.width||!meta.height||meta.width>4096||meta.height>4096||(meta.pages??1)>1)return null;
    const output=await image.rotate().resize(192,192,{fit:'inside',withoutEnlargement:true}).webp({quality:82,effort:3}).timeout({seconds:3}).toBuffer();
    return output.length<=128*1024&&imageMime(output)==='image/webp'?output:null;
  }catch{return null;}
}
/** Only artwork is read from the exact-contract launchpad page. Its prices,
 * names, supplies and other financial/identity fields are never consumed. */
export async function loadFreshArtwork(address:string,options:{signal?:AbortSignal;transport?:Transport;provider?:FreshArtworkProvider;marketFallback?:boolean}={}):Promise<FreshArtwork>{
  if(!/^0x[0-9a-f]{40}$/.test(address))return fail('artwork_address_invalid');
  if(options.marketFallback&&options.provider!=='pancakeswap'){
    // Reserve time for market artwork even if a launchpad or IPFS source stalls.
    // The entire operation remains below the existing 30-second job lease.
    const total=AbortSignal.timeout(20_000),signal=options.signal?AbortSignal.any([total,options.signal]):total;
    try{return await loadFreshArtwork(address,{...options,marketFallback:false,signal:AbortSignal.any([signal,AbortSignal.timeout(12_000)])});}
    catch{if(signal.aborted)return fail('artwork_deadline');}
    return loadFreshArtwork(address,{signal,transport:options.transport,provider:'pancakeswap'});
  }
  const timeout=AbortSignal.timeout(15_000),signal=options.signal?AbortSignal.any([timeout,options.signal]):timeout;
  const agent=options.transport?null:publicAgent();
  const transport:Transport=options.transport??(async(url,{signal})=>await undiciFetch(url,{signal,redirect:'manual',dispatcher:agent!,headers:{accept:'application/json,text/html,image/webp,image/png,image/jpeg'}}) as unknown as Response);
  const providers=options.provider==='auto'?['fourmeme','genius'] as const:[options.provider??'flap'];
  try {let image:string|null=null,source:FreshArtwork['source']='flap_contract_page';
    for(const provider of providers){
      try{
        const page=provider==='pancakeswap'?`https://api.dexscreener.com/latest/dex/tokens/${address}`:provider==='fourmeme'?`https://four.meme/meme-api/v1/private/token/get/v2?address=${address}`:provider==='genius'?`https://genius.fun/token/${address}`:`https://flap.sh/bnb/${address}`;
        const text=(await request(page,maxPageBytes,signal,transport)).toString('utf8');
        image=provider==='pancakeswap'?freshPancakeArtworkFromJson(text,address):provider==='fourmeme'?freshFourMemeArtworkFromJson(text,address):provider==='genius'?freshGeniusArtworkFromHtml(text,address):freshFlapArtworkFromHtml(text,address);
        if(image){source=provider==='pancakeswap'?'pancakeswap_market_record':provider==='fourmeme'?'fourmeme_token_record':provider==='genius'?'genius_contract_page':'flap_contract_page';break;}
      }catch(error){if(providers.length===1||signal.aborted)throw error;}
    }
    if(!image)return fail('artwork_not_published');
    const url=freshArtworkUrl(image);if(!url)return fail('artwork_url_rejected');
    const data=await normalizeFreshArtwork(await request(url,maxImageBytes,signal,transport));
    if(!data)return fail('artwork_image_rejected');return{data,mime:'image/webp',url,source};
  }catch(error){if(error instanceof FreshArtworkError)throw error;return fail(signal.aborted?'artwork_deadline':'artwork_unavailable');}
  finally{await agent?.close();}
}

const publicTraded=`EXISTS(SELECT 1 FROM fresh.financial_events e JOIN fresh.kols k ON k.wallet_address=e.wallet_address AND k.is_tracked
  WHERE e.token_address=t.address AND e.canonical AND e.kind IN('buy','sell'))`;

/** The complete-history decode checkpoint includes old repair gaps; it is not
 * the current work queue. Old unknown costs must not starve optional images. */
export function freshArtworkCaptureReady(state:{capture_ok?:string;decode_ok?:string;occurred_at?:string|Date;decode_checked_at?:string|Date;pending_current?:boolean}|undefined,now=Date.now()):boolean{
  if(!state||state.capture_ok!=='true'||state.decode_ok!=='true'||state.pending_current!==false)return false;
  const captureAge=now-new Date(state.occurred_at??'').getTime(),decodeAge=now-new Date(state.decode_checked_at??'').getTime();
  return captureAge>=-5000&&captureAge<=20_000&&decodeAge>=-5000&&decodeAge<=60_000;
}
/** Optional, separate worker stage. One small job per token; no financial loop
 * waits for artwork, and private-only wallet addresses never leave the server. */
export async function runFreshArtwork(db:Pool,options:{signal?:AbortSignal;limit?:number;loader?:typeof loadFreshArtwork}={}){
  const selected=(await db.query(`SELECT t.address,lf.protocol FROM fresh.tokens t JOIN fresh.launch_facts lf ON lf.token_address=t.address AND lf.status='eligible' LEFT JOIN fresh.jobs j ON j.kind='token_artwork' AND j.reference=t.address
    WHERE t.launch_status='eligible' AND t.logo_data IS NULL AND ${publicTraded}
      AND (j.id IS NULL OR (j.state='pending' AND j.due_at<=clock_timestamp()) OR (j.state='leased' AND j.lease_until<clock_timestamp()))
    ORDER BY t.last_trade_at DESC NULLS LAST,t.address LIMIT $1`,[Math.min(2,Math.max(1,options.limit??1))])).rows;
  let ready=0,failed=0;
  for(const row of selected){if(options.signal?.aborted)break;const lease=randomUUID();
    const owned=await db.query(`INSERT INTO fresh.jobs(id,kind,reference,state,lease_id,lease_until,attempts)
      VALUES('token_artwork:'||$1,'token_artwork',$1,'leased',$2,clock_timestamp()+interval '30 seconds',1)
      ON CONFLICT(kind,reference) DO UPDATE SET state='leased',lease_id=EXCLUDED.lease_id,lease_until=EXCLUDED.lease_until,attempts=fresh.jobs.attempts+1,updated_at=clock_timestamp()
      WHERE (fresh.jobs.state='pending' AND fresh.jobs.due_at<=clock_timestamp()) OR (fresh.jobs.state='leased' AND fresh.jobs.lease_until<clock_timestamp()) RETURNING id`,[row.address,lease]);
    if(!owned.rowCount)continue;
    try{const artwork=await(options.loader??loadFreshArtwork)(row.address,{signal:options.signal,provider:row.protocol==='flap'?'flap':row.protocol==='fourmeme'?'fourmeme':'auto',marketFallback:true});
      const saved=await db.query(`WITH saved AS (UPDATE fresh.tokens t SET logo_data=$2,logo_mime=$3,logo_url=$4 WHERE t.address=$1 AND t.logo_data IS NULL AND t.launch_status='eligible'
        AND EXISTS(SELECT 1 FROM fresh.launch_facts lf WHERE lf.token_address=t.address AND lf.status='eligible')
        AND ${publicTraded} AND EXISTS(SELECT 1 FROM fresh.jobs j WHERE j.kind='token_artwork' AND j.reference=$1 AND j.lease_id=$5 AND j.lease_until>clock_timestamp()) RETURNING t.address
        ), removed AS (DELETE FROM fresh.jobs WHERE kind='token_artwork' AND reference=$1 AND lease_id=$5 RETURNING id)
        SELECT (SELECT count(*)::int FROM saved) AS saved`,[row.address,artwork.data,artwork.mime,artwork.url,lease]);
      ready+=saved.rows[0]?.saved??0;
    }catch(error){failed++;const reason=options.signal?.aborted?'artwork_cancelled':error instanceof FreshArtworkError?error.reason:'artwork_unavailable';
      await db.query(`UPDATE fresh.jobs SET state='pending',lease_id=NULL,lease_until=NULL,last_error=$3,
        due_at=clock_timestamp()+CASE WHEN $4::boolean THEN interval '30 seconds' ELSE interval '1 hour' END,updated_at=clock_timestamp()
        WHERE kind='token_artwork' AND reference=$1 AND lease_id=$2`,[row.address,lease,reason,!!options.signal?.aborted]);}
  }return{ready,failed};
}
