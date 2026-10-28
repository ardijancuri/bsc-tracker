import{keccak256}from'ethers';
import type{Rpc}from'../rpc.js';
import{PCS_V2_FACTORY}from'../launchpad.js';
import{freshAddress,freshHash,type FreshLog}from'./capture.js';
import type{FreshPriceBlock}from'./pricing.js';
import{freshPoolQuotePair}from'./currentPoolQuote.js';
import{freshPcsV2SyncState,validateFreshPcsV2FactoryCode,FRESH_PCS_V2_FACTORY_RUNTIME_HASH,FRESH_PCS_V2_PAIR_INITCODE_HASH,FRESH_PCS_V2_PAIR_RUNTIME_HASH}from'./flapQuoteRecovery.js';
const syncTopic='0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const validBlock=(b:FreshPriceBlock)=>b&&Number.isSafeInteger(b.number)&&b.number>=0&&freshHash(b.hash)===b.hash&&Number.isFinite(Date.parse(b.timestamp))&&new Date(b.timestamp).toISOString()===b.timestamp;
export interface FreshHistoricalV2PairQuote{version:1;kind:'historical_raw_pair_v2';baseAddress:string;quoteAddress:string;target:FreshPriceBlock;observation:'block_end';fromBlock:number;toBlock:number;code:{chainId:56;block:FreshPriceBlock;factoryCode:string;pairCode:string;factoryRuntimeHash:string;pairRuntimeHash:string;pairInitcodeHash:string};pool:{address:string;token0:string;token1:string;lastSync:FreshLog};baseRaw:string;quoteRaw:string;}
/** Immutable official pair identity plus the last genuine canonical Sync at
 * the requested block end. Raw intermediate units cancel when ratios compose;
 * neither quote-token decimals nor a dollar peg is assumed. Current code only
 * authenticates the CREATE2 template, never supplies historical reserves. */
export async function recoverFreshHistoricalV2PairQuote(o:{rpc:Rpc;baseAddress:string;quoteAddress:string;target:FreshPriceBlock;anchor:FreshPriceBlock;canonicalHash:(n:number)=>Promise<string|null>;prior?:FreshHistoricalV2PairQuote}):Promise<FreshHistoricalV2PairQuote>{
 const{rpc,target,anchor,canonicalHash,prior}=o,base=freshAddress(o.baseAddress),quote=freshAddress(o.quoteAddress);
 if(!base||!quote||base===quote||!validBlock(target)||!validBlock(anchor)||anchor.number<target.number||Date.parse(anchor.timestamp)<Date.parse(target.timestamp))throw Error('historical_pair_identity_invalid');
 const pair=freshPoolQuotePair(base,quote),[token0,token1]=[base,quote].sort(),windows=[64,256,1024,4096].map(n=>Math.max(0,target.number-n+1)),codeBlock=prior?.code.block??anchor;
 if(!validBlock(codeBlock)||codeBlock.number<target.number||codeBlock.number>anchor.number||await canonicalHash(target.number)!==target.hash||await canonicalHash(codeBlock.number)!==codeBlock.hash)throw Error('historical_pair_noncanonical');
 if(prior&&(Buffer.byteLength(stable(prior))>128*1024||prior.version!==1||prior.kind!=='historical_raw_pair_v2'||prior.baseAddress!==base||prior.quoteAddress!==quote||stable(prior.target)!==stable(target)||prior.observation!=='block_end'||!windows.includes(prior.fromBlock)||prior.toBlock!==target.number||prior.pool.address!==pair||prior.pool.token0!==token0||prior.pool.token1!==token1||prior.code.chainId!==56||prior.code.factoryRuntimeHash!==FRESH_PCS_V2_FACTORY_RUNTIME_HASH||prior.code.pairRuntimeHash!==FRESH_PCS_V2_PAIR_RUNTIME_HASH||prior.code.pairInitcodeHash!==FRESH_PCS_V2_PAIR_INITCODE_HASH))throw Error('historical_pair_prior_invalid');
 if(!prior){const age=Date.now()-Date.parse(anchor.timestamp);if(age< -5000||age>30000)throw Error('historical_pair_anchor_stale');if(await rpc<string>('eth_chainId',[])!=='0x38')throw Error('historical_pair_chain_invalid');}
 const at={blockHash:codeBlock.hash,requireCanonical:true},factoryCode=prior?.code.factoryCode??await rpc<string>('eth_getCode',[PCS_V2_FACTORY,at]),pairCode=prior?.code.pairCode??await rpc<string>('eth_getCode',[pair,at]);
 validateFreshPcsV2FactoryCode(factoryCode);if(typeof pairCode!=='string'||!/^0x[\da-f]{29962}$/.test(pairCode)||keccak256(pairCode)!==FRESH_PCS_V2_PAIR_RUNTIME_HASH)throw Error('historical_pair_code_invalid');
 const route={pool:pair,token0,token1};let fromBlock=prior?.fromBlock??windows[0],selected:ReturnType<typeof freshPcsV2SyncState>|undefined;
 for(const start of prior?[fromBlock]:[...new Set(windows)]){fromBlock=start;const logs=prior?[prior.pool.lastSync]:await rpc<FreshLog[]>('eth_getLogs',[{address:pair,fromBlock:'0x'+start.toString(16),toBlock:'0x'+target.number.toString(16),topics:[syncTopic]}]);
  try{freshPcsV2SyncState(logs,route,start,target);}catch(e){if(!(e instanceof Error)||!['flap_quote_pool_empty','flap_quote_sync_unavailable'].includes(e.message))throw e;}
  const checked=new Map<number,string|null>();for(const log of logs){const n=Number(BigInt(log.blockNumber));if(!checked.has(n))checked.set(n,await canonicalHash(n));if(checked.get(n)!==log.blockHash)throw Error('historical_pair_noncanonical');}
  try{selected=freshPcsV2SyncState(logs,route,start,target);break;}catch(e){if(prior||!(e instanceof Error)||e.message!=='flap_quote_sync_unavailable')throw e;}
 }
 if(!selected)throw Error('historical_pair_sync_unavailable');
 const result:FreshHistoricalV2PairQuote={version:1,kind:'historical_raw_pair_v2',baseAddress:base,quoteAddress:quote,target:{...target},observation:'block_end',fromBlock,toBlock:target.number,code:{chainId:56,block:{...codeBlock},factoryCode,pairCode,factoryRuntimeHash:FRESH_PCS_V2_FACTORY_RUNTIME_HASH,pairRuntimeHash:FRESH_PCS_V2_PAIR_RUNTIME_HASH,pairInitcodeHash:FRESH_PCS_V2_PAIR_INITCODE_HASH},pool:{address:pair,token0,token1,lastSync:structuredClone(selected.last)},baseRaw:String(token0===base?selected.reserve0:selected.reserve1),quoteRaw:String(token0===quote?selected.reserve0:selected.reserve1)};
 if(prior&&stable(prior)!==stable(result))throw Error('historical_pair_prior_invalid');
 if(await canonicalHash(target.number)!==target.hash||await canonicalHash(codeBlock.number)!==codeBlock.hash||await canonicalHash(Number(BigInt(selected.last.blockNumber)))!==selected.last.blockHash)throw Error('historical_pair_noncanonical');
 return result;
}
