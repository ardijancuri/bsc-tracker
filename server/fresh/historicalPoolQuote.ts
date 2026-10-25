import {keccak256} from 'ethers';
import type {Rpc} from '../rpc.js';
import {PCS_V2_FACTORY,WBNB} from '../launchpad.js';
import {freshAddress,freshHash,type FreshLog} from './capture.js';
import type {FreshPriceBlock} from './pricing.js';
import {freshPoolNativePair} from './currentPoolQuote.js';
import {freshPcsV2SyncState,validateFreshPcsV2FactoryCode,FRESH_PCS_V2_FACTORY_RUNTIME_HASH,FRESH_PCS_V2_PAIR_INITCODE_HASH,FRESH_PCS_V2_PAIR_RUNTIME_HASH} from './flapQuoteRecovery.js';
const topic='0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const stable=(v:unknown):string=>JSON.stringify(v,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const block=(v:FreshPriceBlock)=>!!v&&Number.isSafeInteger(v.number)&&v.number>=0&&freshHash(v.hash)===v.hash&&Number.isFinite(Date.parse(v.timestamp))&&new Date(v.timestamp).toISOString()===v.timestamp;
export interface FreshHistoricalPoolNativeQuote {
 version:1;kind:'historical_raw_pool_native_v2';quoteAddress:string;target:FreshPriceBlock;transactionIndex:number;observation:'before_execution'|'block_end';
 fromBlock:number;toBlock:number;code:{chainId:56;block:FreshPriceBlock;factoryRuntimeHash:string;pairRuntimeHash:string;pairInitcodeHash:string};
 pool:{address:string;token0:string;token1:string;lastSync:FreshLog};nativeRaw:string;quoteRaw:string;
}

/** This is a raw quote-unit/native-wei conversion, not a token's price or a
 * transaction's settled cost. A caller must separately prove the paid/received
 * raw quantity, all fees, and dated BNB/USD. No historical quote decimals,
 * current reserves, same-transaction swap or stock peg enters this ratio.
 * The deterministic immutable PCS V2 template and canonical earlier Sync prove
 * the historical asset pair. Missing observations fail explicitly. */
export async function recoverFreshHistoricalPoolNativeQuote(options:{rpc:Rpc;quoteAddress:string;target:FreshPriceBlock;transactionIndex:number;
 anchor:FreshPriceBlock;canonicalHash:(number:number)=>Promise<string|null>;prior?:FreshHistoricalPoolNativeQuote;observation?:'before_execution'|'block_end'}):Promise<FreshHistoricalPoolNativeQuote>{
 const{rpc,target,anchor,transactionIndex,canonicalHash,prior}=options,quote=freshAddress(options.quoteAddress);
 const observation=options.observation??'before_execution';
 if(!quote||quote===WBNB||!block(target)||!block(anchor)||anchor.number<target.number||Date.parse(anchor.timestamp)<Date.parse(target.timestamp)
  ||Date.parse(target.timestamp)<1718863500000||!Number.isSafeInteger(transactionIndex)||transactionIndex<0||transactionIndex>=2**32
  ||!['before_execution','block_end'].includes(observation))throw Error('historical_pool_quote_identity_invalid');
 if(await canonicalHash(target.number)!==target.hash)throw Error('historical_pool_quote_noncanonical');
 const pair=freshPoolNativePair(quote),[token0,token1]=[quote,WBNB].sort(),toBlock=target.number;
 // Active quote pools can emit more than the work limit in 4,096 blocks.
 // Start with the smallest complete window; expand only when it contains no
 // preceding observation. Never discard malformed, excessive or orphan logs.
 const windows=[64,256,1024,4096].map(size=>Math.max(0,target.number-size+1));
 let fromBlock=prior?.fromBlock??windows[0];
 const codeBlock=prior?.code?.block??anchor;
 if(!block(codeBlock)||codeBlock.number<target.number||codeBlock.number>anchor.number||Date.parse(codeBlock.timestamp)<Date.parse(target.timestamp)
  ||await canonicalHash(codeBlock.number)!==codeBlock.hash)throw Error('historical_pool_quote_noncanonical');
 const code:FreshHistoricalPoolNativeQuote['code']={chainId:56,block:{...codeBlock},factoryRuntimeHash:FRESH_PCS_V2_FACTORY_RUNTIME_HASH,pairRuntimeHash:FRESH_PCS_V2_PAIR_RUNTIME_HASH,pairInitcodeHash:FRESH_PCS_V2_PAIR_INITCODE_HASH};
 if(prior){
  if(Buffer.byteLength(stable(prior))>16384||prior.version!==1||prior.kind!=='historical_raw_pool_native_v2'||prior.quoteAddress!==quote
   ||stable(prior.target)!==stable(target)||prior.transactionIndex!==transactionIndex||prior.observation!==observation||!windows.includes(prior.fromBlock)||prior.toBlock!==toBlock||stable(prior.code)!==stable(code)
   ||prior.pool?.address!==pair||prior.pool.token0!==token0||prior.pool.token1!==token1)throw Error('historical_pool_quote_prior_invalid');
 }else{
  const age=Date.now()-Date.parse(anchor.timestamp);if(age>30000||age< -5000)throw Error('historical_pool_quote_anchor_stale');
  if(await rpc<string>('eth_chainId',[])!=='0x38')throw Error('historical_pool_quote_chain_invalid');
  const at={blockHash:anchor.hash,requireCanonical:true},[factoryCode,pairCode]=await Promise.all([rpc<string>('eth_getCode',[PCS_V2_FACTORY,at]),rpc<string>('eth_getCode',[pair,at])]);
  validateFreshPcsV2FactoryCode(factoryCode);
  if(typeof pairCode!=='string'||!/^0x[\da-f]{29962}$/.test(pairCode)||keccak256(pairCode)!==FRESH_PCS_V2_PAIR_RUNTIME_HASH)throw Error('historical_pool_quote_code_invalid');
 }
 const route={pool:pair,token0,token1};
 let selected:ReturnType<typeof freshPcsV2SyncState>|undefined;
 for(const start of prior?[fromBlock]:[...new Set(windows)]){
 fromBlock=start;
 const logs=prior?[prior.pool.lastSync]:await rpc<FreshLog[]>('eth_getLogs',[{address:pair,fromBlock:'0x'+fromBlock.toString(16),toBlock:'0x'+toBlock.toString(16),topics:[topic]}]);
 // Full-result validation still checks every event's shape and order. A later
 // liquidity removal may leave that final state empty; positivity belongs to
 // the earlier state used for this execution, not an unrelated later Sync.
 try{freshPcsV2SyncState(logs,route,fromBlock,target);}catch(error){if(!(error instanceof Error)||!['flap_quote_pool_empty','flap_quote_sync_unavailable'].includes(error.message))throw error;}
 const checked=new Map<number,string|null>();for(const log of logs){const number=Number(BigInt(log.blockNumber));if(!checked.has(number))checked.set(number,await canonicalHash(number));if(checked.get(number)!==log.blockHash)throw Error('historical_pool_quote_noncanonical');}
 const preceding=observation==='block_end'?logs:logs.filter(log=>Number(BigInt(log.blockNumber))<target.number||Number(BigInt(log.transactionIndex))<transactionIndex);
 try{selected=freshPcsV2SyncState(preceding,route,fromBlock,target);break;}
 catch(error){if(prior||!(error instanceof Error)||error.message!=='flap_quote_sync_unavailable')throw error;}
 }
 if(!selected)throw Error('flap_quote_sync_unavailable');
 const state=selected,quoteIs0=token0===quote;
 const result:FreshHistoricalPoolNativeQuote={version:1,kind:'historical_raw_pool_native_v2',quoteAddress:quote,target:{...target},transactionIndex,observation,fromBlock,toBlock,code,
  pool:{address:pair,token0,token1,lastSync:structuredClone(state.last)},nativeRaw:String(quoteIs0?state.reserve1:state.reserve0),quoteRaw:String(quoteIs0?state.reserve0:state.reserve1)};
 if(prior&&stable(prior)!==stable(result))throw Error('historical_pool_quote_prior_invalid');return result;
}
