import {keccak256} from 'ethers';
import type {Rpc} from '../rpc.js';
import {PCS_V2_FACTORY,WBNB} from '../launchpad.js';
import {poolMarketAbi} from '../nodeMarketProtocols.js';
import {freshAddress,freshHash} from './capture.js';
import {freshPoolNativePair} from './currentPoolQuote.js';
import {createFreshStateEvidenceRpc,type FreshStateReadEvidence} from './stateEvidence.js';
import type {FreshPriceBlock} from './pricing.js';
import {validateFreshPcsV2FactoryCode,FRESH_PCS_V2_FACTORY_RUNTIME_HASH,FRESH_PCS_V2_PAIR_INITCODE_HASH,FRESH_PCS_V2_PAIR_RUNTIME_HASH} from './flapQuoteRecovery.js';

const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
/** Actual original-block state, authenticated while that state is available.
 * This distinct proof is BLOCK END only. It cannot supply a before-execution
 * settlement ratio or masquerade as a Sync event that was never observed. */
export interface FreshRetainedPoolNativeQuote {
 version:1;kind:'retained_target_pool_native_v2';quoteAddress:string;target:FreshPriceBlock;observation:'block_end';
 source:FreshStateReadEvidence;
 code:{chainId:56;block:FreshPriceBlock;factoryRuntimeHash:string;pairRuntimeHash:string;pairInitcodeHash:string};
 pool:{address:string;token0:string;token1:string};nativeRaw:string;quoteRaw:string;
}

/** Only five exact raw calls enter this compact proof. The official factory,
 * deterministic pair, sorted assets and immutable pair runtime are all checked
 * at the SAME original hash. Replay needs no historical state, code or logs.
 * An optional larger receipt source must still contain each original response. */
export async function recoverFreshRetainedPoolNativeQuote(o:{rpc:Rpc;quoteAddress:string;target:FreshPriceBlock;
 canonicalHash:(n:number)=>Promise<string|null>;source?:FreshStateReadEvidence;prior?:FreshRetainedPoolNativeQuote}):Promise<FreshRetainedPoolNativeQuote>{
 const quote=freshAddress(o.quoteAddress),{target,prior}=o;
 if(!quote||quote===WBNB||!Number.isSafeInteger(target.number)||target.number<0||freshHash(target.hash)!==target.hash
  ||!Number.isFinite(Date.parse(target.timestamp))||new Date(target.timestamp).toISOString()!==target.timestamp
  ||Date.parse(target.timestamp)<1718863500000||await o.canonicalHash(target.number)!==target.hash)throw Error('retained_pool_quote_noncanonical');
 if(prior&&(prior.version!==1||prior.kind!=='retained_target_pool_native_v2'||prior.quoteAddress!==quote||prior.observation!=='block_end'
  ||stable(prior.target)!==stable(target)||Buffer.byteLength(stable(prior))>16384))throw Error('retained_pool_quote_prior_invalid');
 const pair=freshPoolNativePair(quote),[token0,token1]=[quote,WBNB].sort(),at={blockHash:target.hash,requireCanonical:true};
 const state=createFreshStateEvidenceRpc(prior?(async()=>{throw Error('retained_pool_quote_source_incomplete');})as Rpc:o.rpc,target,prior?.source);
 if(state.rejectedPrior)throw Error('retained_pool_quote_source_invalid');
 const read=async(to:string,method:string,args:unknown[]=[])=>{
  const raw=await state.rpc<string>('eth_call',[{to,data:poolMarketAbi.encodeFunctionData(method,args)},at]);
  try{const value=poolMarketAbi.decodeFunctionResult(method,raw);if(poolMarketAbi.encodeFunctionResult(method,[...value])!==raw)throw Error();return value;}
  catch{throw Error('retained_pool_quote_state_invalid');}
 };
 const registered=await read(PCS_V2_FACTORY,'getPair',[quote,WBNB]);
 if(String(registered[0]).toLowerCase()!==pair)throw Error('retained_pool_quote_pair_unavailable');
 const [factory,a0,a1,reserves]=await Promise.all([read(pair,'factory'),read(pair,'token0'),read(pair,'token1'),read(pair,'getReserves')]);
 if(String(factory[0]).toLowerCase()!==PCS_V2_FACTORY||String(a0[0]).toLowerCase()!==token0||String(a1[0]).toLowerCase()!==token1)throw Error('retained_pool_quote_identity_invalid');
 const r0=BigInt(reserves[0]),r1=BigInt(reserves[1]);if(r0<=0n||r1<=0n)throw Error('retained_pool_quote_empty');
 const source=state.snapshot()!;if(source.calls.length!==5)throw Error('retained_pool_quote_source_invalid');
 if(o.source){const receipt=createFreshStateEvidenceRpc((async()=>{throw Error('retained_pool_quote_no_network');})as Rpc,target,o.source);
  if(receipt.rejectedPrior||source.calls.some(call=>!receipt.snapshot()?.calls.some(c=>stable(c)===stable(call))))throw Error('retained_pool_quote_source_conflict');}
 const code:FreshRetainedPoolNativeQuote['code']={chainId:56,block:{...target},factoryRuntimeHash:FRESH_PCS_V2_FACTORY_RUNTIME_HASH,pairRuntimeHash:FRESH_PCS_V2_PAIR_RUNTIME_HASH,pairInitcodeHash:FRESH_PCS_V2_PAIR_INITCODE_HASH};
 if(!prior){
  if(await o.rpc<string>('eth_chainId',[])!=='0x38')throw Error('retained_pool_quote_chain_invalid');
  const [factoryCode,pairCode]=await Promise.all([o.rpc<string>('eth_getCode',[PCS_V2_FACTORY,at]),o.rpc<string>('eth_getCode',[pair,at])]);
  validateFreshPcsV2FactoryCode(factoryCode);
  if(typeof pairCode!=='string'||!/^0x[\da-f]{29962}$/.test(pairCode)||keccak256(pairCode)!==FRESH_PCS_V2_PAIR_RUNTIME_HASH)throw Error('retained_pool_quote_code_invalid');
 }
 const result:FreshRetainedPoolNativeQuote={version:1,kind:'retained_target_pool_native_v2',quoteAddress:quote,target:{...target},observation:'block_end',source,code,
  pool:{address:pair,token0,token1},nativeRaw:String(token0===quote?r1:r0),quoteRaw:String(token0===quote?r0:r1)};
 if(prior&&stable(prior)!==stable(result))throw Error('retained_pool_quote_prior_invalid');return result;
}
