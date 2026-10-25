import{createHash}from'node:crypto';import{open,stat}from'node:fs/promises';import{resolve}from'node:path';
import{MarketDecimal}from'../nodeMarketMath.js';import type{FreshPriceBlock,FreshTokenMetadata}from'./pricing.js';
import{createFreshStateEvidenceRpc}from'./stateEvidence.js';

export const FRESH_IMPORTED_METADATA_MAX_BYTES=4*1024*1024,FRESH_IMPORTED_METADATA_MAX_ROWS=2048;
const sourceName='node_market_token_evidence',uint256=(1n<<256n)-1n;
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const hash=(value:unknown):value is string=>typeof value==='string'&&/^0x[\da-f]{64}$/.test(value);
const address=(value:unknown):value is string=>typeof value==='string'&&/^0x[\da-f]{40}$/.test(value);
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[\da-f]{64}$/.test(value);
function wholeSecond(value:unknown):string|null{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?(?:Z|\+00:00)$/.test(value))return null;
 const time=Date.parse(value);if(!Number.isSafeInteger(time)||time%1000!==0)return null;
 const normalized=value.replace(/\+00:00$/,'Z').replace(/(?<!\.000)Z$/,'.000Z');
 return new Date(time).toISOString()===normalized?normalized:null;
}
function quantity(value:unknown):number|null{
 if(typeof value!=='string'||!/^0x(?:0|[1-9a-f][\da-f]*)$/.test(value)||value.length>18)return null;
 const number=Number(BigInt(value));return Number.isSafeInteger(number)?number:null;
}
export interface FreshImportedMetadataObservation{
 tokenAddress:string;blockNumber:number;blockHash:string;timestamp:string;decimals:number;totalSupplyRaw:string;supply:string;
 header:{number:string;hash:string;timestamp:string};
}
interface IndexedObservation{observation:FreshImportedMetadataObservation;rowSha256:string}
interface Artifact{exportSha256:string;exportedAt:string;rows:Map<string,IndexedObservation>}
export interface FreshImportedMetadataProof{
 version:1;kind:'imported_pinned_token_metadata';tokenAddress:string;target:FreshPriceBlock;decimals:number;supplyRaw:string;
 source:{version:1;chainId:56;table:typeof sourceName;readOnly:true;exportSha256:string;rowSha256:string;exportedAt:string};
 observation:FreshImportedMetadataObservation;
}
export interface FreshImportedMetadataIO{
 identity(file:string):Promise<{size:number;key:string}>;
 read(file:string,maxBytes:number):Promise<Buffer>;
}
export interface FreshImportedMetadataOptions{
 canonicalHash:(number:number)=>Promise<string|null>;
 /** Server configuration or explicit tests only; never request parameters. */
 file?:string|null;sha256?:string|null;environment?:Record<string,string|undefined>;io?:FreshImportedMetadataIO;
}
/** Check each original field independently: a missing precision sibling must
 * never conceal a contradictory retained supply (or a malformed response).
 * Nothing is decoded through or copied into a synthetic RPC response. */
export function freshImportedMetadataMatchesState(value:FreshTokenMetadata,prior:unknown):boolean{
 try{
  if(!address(value.address)||!Number.isInteger(value.decimals)||value.decimals<0||value.decimals>255||!wholeSecond(value.block?.timestamp))return false;
  const state=createFreshStateEvidenceRpc(async()=>{throw Error('imported_metadata_no_network');},value.block,prior);
  if(state.rejectedPrior)return false;
  for(const call of state.snapshot()?.calls??[]){
   if(call.to!==value.address||!['0x313ce567','0x18160ddd'].includes(call.data))continue;
   if(!/^0x[\da-f]{64}$/.test(call.result))return false;
   if(call.data==='0x313ce567'){if(BigInt(call.result)!==BigInt(value.decimals))return false;}
   else if(value.supplyRaw===null||!/^(?:0|[1-9]\d{0,77})$/.test(value.supplyRaw)||BigInt(value.supplyRaw)>uint256||BigInt(call.result)!==BigInt(value.supplyRaw))return false;
  }
  return true;
 }catch{return false;}
}
const defaultIO:FreshImportedMetadataIO={
 async identity(file){const s=await stat(file);if(!s.isFile())throw Error('imported_metadata_file_invalid');return{size:s.size,key:[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':')};},
 async read(file,maxBytes){const handle=await open(file,'r');try{
  const info=await handle.stat();if(!info.isFile()||info.size>maxBytes)throw Error('imported_metadata_size_invalid');
  const buffer=Buffer.alloc(Math.min(info.size+1,maxBytes+1));let length=0;
  while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
  if(length!==info.size||length>maxBytes)throw Error('imported_metadata_size_invalid');return buffer.subarray(0,length);
 }finally{await handle.close();}}
};
type Cached={key:string;work:Promise<Artifact>};let processCache:Cached|undefined;
function parseObservation(raw:unknown,exportedAt:string):IndexedObservation{
 if(!record(raw)||!address(raw.tokenAddress)||!Number.isSafeInteger(raw.blockNumber)||Number(raw.blockNumber)<0||!hash(raw.blockHash)
  ||!Number.isInteger(raw.decimals)||Number(raw.decimals)<0||Number(raw.decimals)>36||!record(raw.header))throw Error('imported_metadata_row_invalid');
 const timestamp=wholeSecond(raw.timestamp),header=raw.header;
 if(!timestamp||Date.parse(timestamp)>Date.parse(exportedAt)||quantity(header.number)!==raw.blockNumber||header.hash!==raw.blockHash
  ||quantity(header.timestamp)!==Date.parse(timestamp)/1000)throw Error('imported_metadata_header_invalid');
 if(typeof raw.totalSupplyRaw!=='string'||!/^(?:0|[1-9]\d{0,77})$/.test(raw.totalSupplyRaw)||BigInt(raw.totalSupplyRaw)>uint256
  ||typeof raw.supply!=='string'||raw.supply.length>256||!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw.supply)
  ||MarketDecimal.raw(BigInt(raw.totalSupplyRaw),Number(raw.decimals)).compare(MarketDecimal.parse(raw.supply))!==0)throw Error('imported_metadata_supply_invalid');
 return{rowSha256:digest(stable(raw)),observation:{tokenAddress:raw.tokenAddress,blockNumber:Number(raw.blockNumber),blockHash:raw.blockHash,timestamp,
  decimals:Number(raw.decimals),totalSupplyRaw:raw.totalSupplyRaw,supply:raw.supply,header:{number:header.number as string,hash:header.hash as string,timestamp:header.timestamp as string}}};
}
function parseArtifact(bytes:Buffer,expectedSha256:string):Artifact{
 if(!Buffer.isBuffer(bytes)||bytes.length>FRESH_IMPORTED_METADATA_MAX_BYTES||digest(bytes)!==expectedSha256)throw Error('imported_metadata_digest_invalid');
 const raw:unknown=JSON.parse(bytes.toString('utf8'));
 if(!record(raw)||raw.version!==1||raw.chainId!==56||raw.source!==sourceName||raw.readOnly!==true||typeof raw.exportedAt!=='string'
  ||!Number.isFinite(Date.parse(raw.exportedAt))||new Date(raw.exportedAt).toISOString()!==raw.exportedAt||!Array.isArray(raw.rows)||raw.rows.length>FRESH_IMPORTED_METADATA_MAX_ROWS)throw Error('imported_metadata_artifact_invalid');
 const rows=new Map<string,IndexedObservation>();
 for(const value of raw.rows){const row=parseObservation(value,raw.exportedAt),o=row.observation,key=[o.tokenAddress,o.blockNumber,o.blockHash].join(':'),old=rows.get(key);
  if(old&&old.rowSha256!==row.rowSha256)throw Error('imported_metadata_row_conflict');rows.set(key,row);}
 return{exportSha256:expectedSha256,exportedAt:raw.exportedAt,rows};
}

/** Only the pinned immutable artifact is cached. Its file identity/availability
 * is checked on every use, and independent canonicality is checked AFTER load.
 * No imported scalar becomes an eth_call response or current metadata row. */
export function createFreshImportedMetadataRecovery(options:FreshImportedMetadataOptions){
 const environment=options.environment??process.env,filename=options.file===undefined?environment.FRESH_RECOVERY_METADATA_FILE:options.file;
 const expected=options.sha256===undefined?environment.FRESH_RECOVERY_METADATA_SHA256:options.sha256;
 const file=typeof filename==='string'&&filename?resolve(filename):null,io=options.io??defaultIO;let localCache:Cached|undefined;
 async function artifact(){
  if(!file||!sha(expected))return null;
  const before=await io.identity(file);if(!Number.isSafeInteger(before.size)||before.size<1||before.size>FRESH_IMPORTED_METADATA_MAX_BYTES||typeof before.key!=='string'||before.key.length>1024)throw Error('imported_metadata_size_invalid');
  const key=[file,expected,before.key].join('\n');let cached=options.io?localCache:processCache;
  if(!cached||cached.key!==key){const work=(async()=>{const bytes=await io.read(file,FRESH_IMPORTED_METADATA_MAX_BYTES),loaded=parseArtifact(bytes,expected);
    const after=await io.identity(file);if(after.size!==before.size||after.key!==before.key||bytes.length!==before.size)throw Error('imported_metadata_file_changed');return loaded;})();
   cached={key,work};if(options.io)localCache=cached;else processCache=cached;
  }
  try{return await cached.work;}catch(error){if(options.io&&localCache===cached)localCache=undefined;else if(processCache===cached)processCache=undefined;throw error;}
 }
 return{async metadata(tokenAddress:string,target:FreshPriceBlock,prior?:unknown):Promise<{value:FreshTokenMetadata;proof:FreshImportedMetadataProof}|null>{
  try{
   const timestamp=wholeSecond(target?.timestamp);if(!address(tokenAddress)||!Number.isSafeInteger(target?.number)||target.number<0||!hash(target?.hash)||!timestamp)return null;
   const pinnedTarget={number:target.number,hash:target.hash,timestamp},loaded=await artifact();if(!loaded)return null;
   const row=loaded.rows.get([tokenAddress,pinnedTarget.number,pinnedTarget.hash].join(':'));if(!row||row.observation.timestamp!==timestamp)return null;
   if(await options.canonicalHash(pinnedTarget.number)!==pinnedTarget.hash)return null;
   const observation=structuredClone(row.observation),proof:FreshImportedMetadataProof={version:1,kind:'imported_pinned_token_metadata',tokenAddress,target:pinnedTarget,
    decimals:observation.decimals,supplyRaw:observation.totalSupplyRaw,source:{version:1,chainId:56,table:sourceName,readOnly:true,exportSha256:loaded.exportSha256,rowSha256:row.rowSha256,exportedAt:loaded.exportedAt},observation};
   if(prior!==undefined&&stable(prior)!==stable(proof))return null;
   return{value:{address:tokenAddress,name:null,symbol:null,decimals:observation.decimals,supplyRaw:observation.totalSupplyRaw,block:{...pinnedTarget}},proof};
  }catch{return null;}
 }};
}
