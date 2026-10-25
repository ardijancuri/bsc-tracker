import {createHash}from'node:crypto';
import type{Pool}from'pg';
import{FRESH_EVIDENCE_TTL_MS,freshAddress,freshHash}from'./capture.js';
import{freshStockwaveMetadataFromFact}from'./factoryLaunch.js';
import{validFreshStockwaveMarketIdentity,type FreshStockwaveMarketIdentity}from'./stockwaveMarket.js';
import type{FreshPriceBlock}from'./pricing.js';
const canonical=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value)??'null':Array.isArray(value)?`[${value.map(canonical).join(',')}]`
 :`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
export const freshMarketLaunchDigest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
interface MarketInitializationAnchor{version:1;kind:'capture_committed_initialization';tokenAddress:string;poolId:string;initialNumber:number;initialHash:string;initialOccurredAt:string;
 launchDigest:string;boundary:{number:number;hash:string};captureRevision:string;confirmedThrough:{number:number;hash:string;occurredAt:string}}
export type FreshAnchoredMarketIdentity=FreshStockwaveMarketIdentity&{canonicalInitialization:MarketInitializationAnchor};
/** Called only after capture-locked canonical header/creation checks. The
 * marker is a compact identity anchor, never a quote or historical state read. */
export function anchorFreshMarketInitialization(identity:FreshStockwaveMarketIdentity,fact:unknown,context:{boundary:{number:number;hash:string};captureRevision:string;initialOccurredAt:string;confirmedThrough:{number:number;hash:string;occurredAt:string}}):FreshAnchoredMarketIdentity{
 const launch=fact as Record<string,unknown>;
 if(!validFreshStockwaveMarketIdentity(identity)||!launch||launch.token_address!==identity.tokenAddress||launch.status!=='eligible'||!Number.isSafeInteger(Number(launch.block_number))||Number(launch.block_number)>identity.initial.blockNumber
  ||!Number.isSafeInteger(context.boundary.number)||context.boundary.number<0||!freshHash(context.boundary.hash)
  ||identity.initial.blockNumber<=context.boundary.number||!Number.isSafeInteger(context.confirmedThrough.number)||context.confirmedThrough.number<identity.initial.blockNumber||!freshHash(context.confirmedThrough.hash)
  ||context.confirmedThrough.number===identity.initial.blockNumber&&context.confirmedThrough.hash!==identity.initial.blockHash
  ||!/^\d+$/.test(context.captureRevision)||!Number.isFinite(Date.parse(context.initialOccurredAt))||!Number.isFinite(Date.parse(context.confirmedThrough.occurredAt))||Date.parse(context.confirmedThrough.occurredAt)<Date.parse(context.initialOccurredAt))throw Error('market_initialization_anchor_invalid');
 return{...identity,canonicalInitialization:{version:1,kind:'capture_committed_initialization',tokenAddress:identity.tokenAddress,poolId:identity.poolId,
  initialNumber:identity.initial.blockNumber,initialHash:identity.initial.blockHash,initialOccurredAt:context.initialOccurredAt,launchDigest:freshMarketLaunchDigest(fact),
  boundary:context.boundary,captureRevision:context.captureRevision,confirmedThrough:context.confirmedThrough}};
}
export const freshMarketIdentityInvalid=(value:unknown)=>Boolean(value&&typeof value==='object'&&((value as Record<string,unknown>).canonicalIdentityInvalid===true
 ||((value as Record<string,unknown>).market as Record<string,unknown>|undefined)?.canonicalIdentityInvalid===true));

/** CURRENT valuation only. Historical metadata/settlement adapters deliberately
 * retain their stricter recent_blocks readers. Missing recent headers use only
 * exact, aged, server-stored identity anchors while live capture is healthy.
 * This performs no RPC and cannot answer arbitrary historical hashes. */
export function createFreshCurrentMarketCanonicalHash(database:Pick<Pool,'query'>,options:{token:string;block:FreshPriceBlock;recentHash?:(number:number)=>Promise<string|null>;now?:()=>number}){
 const now=options.now??Date.now,token=freshAddress(options.token),cache=new Map<number,Promise<string|null>>();
 let sources:Promise<{capture:any;fact:any;markets:any[]}>|undefined;
 return async(number:number):Promise<string|null>=>{
  if(!token||!Number.isSafeInteger(number)||number<0)return null;
  let result=cache.get(number);if(result)return result;
  result=(async()=>{
   const recent=options.recentHash?await options.recentHash(number):(await database.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[number])).rows[0]?.block_hash??null;
   if(recent)return freshHash(recent);
   const at=now(),blockTime=Date.parse(options.block.timestamp);
   if(!Number.isFinite(blockTime)||Math.abs(at-blockTime)>120_000||number>=options.block.number)return null;
   sources??=Promise.all([
    database.query(`SELECT c.block_number,c.block_hash,c.revision,c.value,b.occurred_at,h.value->>'ok' AS capture_ok,h.updated_at AS health_at
      FROM fresh.checkpoints c JOIN fresh.recent_blocks b ON b.block_number=c.block_number AND b.block_hash=c.block_hash
      JOIN fresh.checkpoints h ON h.key='health:capture' WHERE c.key='capture'`),
    database.query("SELECT to_jsonb(lf) AS fact FROM fresh.launch_facts lf WHERE token_address=$1 AND status='eligible'",[token]),
    database.query("SELECT identity FROM fresh.markets WHERE token_address=$1 AND protocol='uniswap_v4' ORDER BY id LIMIT 8",[token])
   ]).then(([capture,fact,markets])=>({capture:capture.rows[0],fact:fact.rows[0]?.fact,markets:markets.rows}));
   const{capture,fact,markets}=await sources;
   const boundary=capture?.value,capTime=Date.parse(capture?.occurred_at),healthTime=Date.parse(capture?.health_at);
   if(!capture||capture.capture_ok!=='true'||!Number.isFinite(capTime)||at-capTime>20_000||capTime>at+5_000||!Number.isFinite(healthTime)||at-healthTime>90_000||healthTime>at+5_000
    ||Math.abs(options.block.number-Number(capture.block_number))>32||!Number.isSafeInteger(Number(boundary?.startBlock))||!freshHash(boundary?.startHash)
    ||!/^\d+$/.test(String(capture.revision))||!fact||fact.token_address!==token||fact.status!=='eligible'||Number(fact.block_number)<=Number(boundary.startBlock)||Number(fact.block_number)>Number(capture.block_number))return null;
   const candidates=new Set<string>();
   // The factory fact is already a permanent authenticated CREATE2 creation;
   // its independently checked pool Initialize is in that exact transaction.
   const stock=fact.proof?.market;
   if(fact.protocol==='stockwave'&&Number(fact.block_number)===number&&at-Date.parse(fact.launched_at)>=FRESH_EVIDENCE_TTL_MS
    &&freshStockwaveMetadataFromFact(fact,options.block)&&validFreshStockwaveMarketIdentity(stock)&&stock.tokenAddress===token
    &&stock.initial.blockNumber===number&&stock.initial.blockHash===fact.block_hash&&stock.initial.transactionHash===fact.tx_hash&&stock.initial.logIndex<Number(fact.log_index))candidates.add(stock.initial.blockHash);
   for(const row of markets){
    if(freshMarketIdentityInvalid(row.identity))continue;
    const identity=row.identity?.market??row.identity,marker=identity?.canonicalInitialization as MarketInitializationAnchor|undefined;
    if(!validFreshStockwaveMarketIdentity(identity)||identity.tokenAddress!==token||identity.initial.blockNumber!==number||!marker||marker.version!==1||marker.kind!=='capture_committed_initialization'
     ||marker.tokenAddress!==token||marker.poolId!==identity.poolId||marker.initialNumber!==number||marker.initialHash!==identity.initial.blockHash
     ||marker.launchDigest!==freshMarketLaunchDigest(fact)||marker.boundary?.number!==Number(boundary.startBlock)||marker.boundary.hash!==boundary.startHash
     ||!/^\d+$/.test(marker.captureRevision)||BigInt(marker.captureRevision)>BigInt(capture.revision)||!Number.isFinite(Date.parse(marker.initialOccurredAt))
     ||at-Date.parse(marker.initialOccurredAt)<FRESH_EVIDENCE_TTL_MS||number<Number(fact.block_number))continue;
    const through=marker.confirmedThrough;
    if(!through||!Number.isSafeInteger(through.number)||through.number<number||through.number>Number(capture.block_number)||!freshHash(through.hash)
     ||!Number.isFinite(Date.parse(through.occurredAt))||Date.parse(through.occurredAt)<Date.parse(marker.initialOccurredAt)||Date.parse(through.occurredAt)>capTime)continue;
    const observed=(await database.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[through.number])).rows[0]?.block_hash;
    if(observed?observed!==through.hash:at-Date.parse(through.occurredAt)<FRESH_EVIDENCE_TTL_MS)continue;
    candidates.add(identity.initial.blockHash);
   }
   return candidates.size===1?[...candidates][0]:null;
  })();
  cache.set(number,result);return result;
 };
}
