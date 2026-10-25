import type {Rpc} from '../rpc.js';
import type {FreshPriceBlock} from './pricing.js';
import {freshInteger} from './capture.js';

export interface FreshHistoricalValuationContext{readonly kind:'verified_historical_block';readonly target:Readonly<FreshPriceBlock>}
export interface FreshValuationReadOptions{rpc:Rpc;block:FreshPriceBlock;historicalValuation?:FreshHistoricalValuationContext}
const verified=new WeakMap<FreshHistoricalValuationContext,{rpc:Rpc;block:Readonly<FreshPriceBlock>}>();
const valid=(b:FreshPriceBlock)=>b&&Number.isSafeInteger(b.number)&&b.number>=0&&/^0x[\da-f]{64}$/.test(b.hash)
  &&Number.isFinite(Date.parse(b.timestamp))&&new Date(b.timestamp).toISOString()===b.timestamp;
const same=(a:FreshPriceBlock,b:FreshPriceBlock)=>a.number===b.number&&a.hash===b.hash&&a.timestamp===b.timestamp;
/** Repair-only observation. The trusted caller must resolve the full canonical
 * header from retained PostgreSQL capture or the node, never token metadata.
 * Every subsequent state/code request remains pinned to that original hash. */
export async function createFreshHistoricalValuationOptions(rpc:Rpc,target:FreshPriceBlock,canonicalHeader?:(number:number)=>Promise<FreshPriceBlock|null>):Promise<FreshValuationReadOptions>{
  if(!valid(target)||Date.parse(target.timestamp)>Date.now()+5000)throw Error('historical_valuation_target_invalid');
  if(await rpc<string>('eth_chainId',[])!=='0x38')throw Error('historical_valuation_chain_invalid');
  const raw=await rpc<{number:string;hash:string;timestamp:string}|null>('eth_getBlockByNumber',['0x'+target.number.toString(16),false]);
  if(!raw)throw Error('historical_valuation_noncanonical');
  const observed={number:Number(freshInteger(raw.number)),hash:raw.hash,timestamp:new Date(Number(freshInteger(raw.timestamp))*1000).toISOString()};
  if(!valid(observed)||!same(observed,target))throw Error('historical_valuation_noncanonical');
  if(canonicalHeader){const header=await canonicalHeader(target.number);if(!header||!valid(header)||!same(header,target))throw Error('historical_valuation_noncanonical');}
  const block=Object.freeze({...target});
  const bound=(async<T>(method:string,params:unknown[]):Promise<T>=>{
    if(method==='eth_chainId'&&Array.isArray(params)&&params.length===0){const chain=await rpc<string>(method,params);if(chain!=='0x38')throw Error('historical_valuation_chain_invalid');return chain as T;}
    if(!['eth_call','eth_getCode'].includes(method)||!Array.isArray(params)||params.length!==2)throw Error('historical_valuation_request_invalid');
    const selector=params[1] as Record<string,unknown>|null;
    if(!selector||typeof selector!=='object'||Array.isArray(selector)||Object.keys(selector).length!==2
      ||selector.blockHash!==block.hash||selector.requireCanonical!==true)throw Error('historical_valuation_request_invalid');
    return rpc<T>(method,params);
  }) as Rpc;
  const historicalValuation=Object.freeze({kind:'verified_historical_block' as const,target:block});
  verified.set(historicalValuation,{rpc:bound,block});return{rpc:bound,block,historicalValuation};
}
/** A JSON flag or a context borrowed for another RPC/block cannot relax age. */
export function freshHistoricalValuation(options:FreshValuationReadOptions):boolean{
  const context=options.historicalValuation;if(context===undefined)return false;
  const binding=verified.get(context);
  if(!binding||binding.rpc!==options.rpc||!same(binding.block,options.block))throw Error('historical_valuation_context_invalid');
  return true;
}
