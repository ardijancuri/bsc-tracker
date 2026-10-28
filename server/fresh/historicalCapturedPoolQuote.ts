import{getCreate2Address,keccak256,solidityPackedKeccak256}from'ethers';import type{Rpc}from'../rpc.js';
import{PCS_V2_FACTORY,WBNB}from'../launchpad.js';import{poolMarketAbi,erc20MarketAbi}from'../nodeMarketProtocols.js';import{MarketDecimal}from'../nodeMarketMath.js';
import{freshAddress,freshHash}from'./capture.js';import{createFreshStateEvidenceRpc,type FreshStateReadEvidence}from'./stateEvidence.js';
import type{FreshPriceBlock,FreshTokenMetadata}from'./pricing.js';import{recoverFreshHistoricalPoolNativeQuote,type FreshHistoricalPoolNativeQuote}from'./historicalPoolQuote.js';
import{validateFreshPcsV2FactoryCode,FRESH_PCS_V2_FACTORY_RUNTIME_HASH,FRESH_PCS_V2_PAIR_INITCODE_HASH,FRESH_PCS_V2_PAIR_RUNTIME_HASH}from'./flapQuoteRecovery.js';
import{recoverFreshRetainedPoolNativeQuote,type FreshRetainedPoolNativeQuote}from'./retainedPoolQuote.js';
const stable=(v:unknown):string=>JSON.stringify(v,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const sameBlock=(a:FreshPriceBlock,b:FreshPriceBlock)=>a?.number===b?.number&&a?.hash===b?.hash&&a?.timestamp===b?.timestamp;
export interface FreshCapturedV2Pool {
 tokenAddress:string;quoteAddress:string;pool:string;token0:string;token1:string;tokenDecimals:number;
 precisionBasis:'retained_target_call'|'independently_verified_target_metadata';reserve0:string;reserve1:string;tokenRaw:string;quoteRaw:string;
}
/** Only actual target-block factory/assets/reserves reads identify a candidate.
 * Current factory lookups and current quote-token decimals cannot fill gaps.
 * Optional metadata is the caller's independently revalidated fixed precision
 * for this exact token/target; it is never loaded from a current token row. */
export function readFreshCapturedV2Pools(options:{tokenAddress:string;target:FreshPriceBlock;source:FreshStateReadEvidence;verifiedMetadata?:FreshTokenMetadata}):FreshCapturedV2Pool[]{
 const{source,target}=options,token=freshAddress(options.tokenAddress);if(!token||!freshHash(target.hash)||!Number.isSafeInteger(target.number))throw Error('captured_pool_identity_invalid');
 const state=createFreshStateEvidenceRpc((async()=>{throw Error('captured_pool_no_network');})as Rpc,target,source);if(state.rejectedPrior)throw Error('captured_pool_source_invalid');
 const saved=state.snapshot()?.calls??[],calls=new Map(saved.map(call=>[call.to+':'+call.data,call.result]));
 const read=(to:string,method:string,args:unknown[]=[])=>{
  const raw=calls.get(to+':'+poolMarketAbi.encodeFunctionData(method,args));if(raw===undefined)throw Error('captured_pool_source_incomplete');
  const value=poolMarketAbi.decodeFunctionResult(method,raw);if(poolMarketAbi.encodeFunctionResult(method,[...value])!==raw)throw Error('captured_pool_source_invalid');return value;
 };
 const precisionRaw=calls.get(token+':'+erc20MarketAbi.encodeFunctionData('decimals'));let tokenDecimals:number,precisionBasis:FreshCapturedV2Pool['precisionBasis']='retained_target_call';
 if(precisionRaw!==undefined){try{const decoded=erc20MarketAbi.decodeFunctionResult('decimals',precisionRaw);if(erc20MarketAbi.encodeFunctionResult('decimals',[...decoded])!==precisionRaw)throw Error();tokenDecimals=Number(decoded[0]);}catch{throw Error('captured_pool_precision_invalid');}}
 else{const metadata=options.verifiedMetadata;if(!metadata||metadata.address!==token||!sameBlock(metadata.block,target))throw Error('captured_pool_precision_unverified');tokenDecimals=metadata.decimals;precisionBasis='independently_verified_target_metadata';}
 if(!Number.isInteger(tokenDecimals)||tokenDecimals<0||tokenDecimals>255)throw Error('captured_pool_precision_invalid');
 const result:FreshCapturedV2Pool[]=[],seen=new Set<string>();
 for(const call of saved){if(result.length>=8)break;if(call.to!==PCS_V2_FACTORY||!call.data.startsWith(poolMarketAbi.getFunction('getPair')!.selector))continue;
  try{const args=poolMarketAbi.decodeFunctionData('getPair',call.data);if(poolMarketAbi.encodeFunctionData('getPair',[...args])!==call.data)continue;
   const assets=[String(args[0]).toLowerCase(),String(args[1]).toLowerCase()].sort();if(!assets.includes(token)||assets[0]===assets[1])continue;
   const quote=assets[0]===token?assets[1]:assets[0];if(!freshAddress(quote)||quote==='0x'+'0'.repeat(40))continue;
   const pool=String(read(PCS_V2_FACTORY,'getPair',[...args])[0]).toLowerCase(),expected=getCreate2Address(PCS_V2_FACTORY,solidityPackedKeccak256(['address','address'],assets),FRESH_PCS_V2_PAIR_INITCODE_HASH).toLowerCase();
   if(pool!==expected||seen.has(pool)||String(read(pool,'factory')[0]).toLowerCase()!==PCS_V2_FACTORY
    ||String(read(pool,'token0')[0]).toLowerCase()!==assets[0]||String(read(pool,'token1')[0]).toLowerCase()!==assets[1])continue;
   const reserves=read(pool,'getReserves'),r0=BigInt(reserves[0]),r1=BigInt(reserves[1]);if(r0<=0n||r1<=0n)continue;
   seen.add(pool);const tokenIs0=assets[0]===token;result.push({tokenAddress:token,quoteAddress:quote,pool,token0:assets[0],token1:assets[1],tokenDecimals,precisionBasis,
    reserve0:String(r0),reserve1:String(r1),tokenRaw:String(tokenIs0?r0:r1),quoteRaw:String(tokenIs0?r1:r0)});
  }catch{/* A partial or contradictory pool is not a candidate. */}
 }
 return result;
}
export interface FreshHistoricalCapturedPoolQuote {
 version:1;kind:'historical_captured_v2_native';tokenAddress:string;target:FreshPriceBlock;source:FreshStateReadEvidence;pool:FreshCapturedV2Pool;
 code:{chainId:56;block:FreshPriceBlock;factoryRuntimeHash:string;pairRuntimeHash:string};conversion:FreshHistoricalPoolNativeQuote|FreshRetainedPoolNativeQuote|null;
 rawNativeRatio:{numerator:string;denominator:string};priceNative:string;quoteLiquidityNative:string;
}
/** Complete target-block captured pool state + target-block-end event-sourced
 * quote conversion. This marks transfer value, never settled trade proceeds.
 * Exact immutable PCS V2 code authenticates the original deterministic pool.
 * All source records remain in the existing bounded receipt envelope. */
export async function recoverFreshHistoricalCapturedPoolQuote(options:{rpc:Rpc;tokenAddress:string;target:FreshPriceBlock;source:FreshStateReadEvidence;
 verifiedMetadata?:FreshTokenMetadata;anchor:FreshPriceBlock;canonicalHash:(number:number)=>Promise<string|null>;prior?:FreshHistoricalCapturedPoolQuote;retainedNativeQuotes?:readonly FreshRetainedPoolNativeQuote[]}):Promise<FreshHistoricalCapturedPoolQuote>{
 const{target,prior,rpc,canonicalHash,anchor}=options;
 if(!Number.isSafeInteger(target.number)||target.number<0||!Number.isFinite(Date.parse(target.timestamp))||!Number.isSafeInteger(anchor.number)||!freshHash(anchor.hash)||!Number.isFinite(Date.parse(anchor.timestamp))||await canonicalHash(target.number)!==target.hash)throw Error('captured_pool_noncanonical');
 const pools=readFreshCapturedV2Pools(options);if(!pools.length)throw Error('captured_pool_source_incomplete');
 if(prior&&(prior.version!==1||prior.kind!=='historical_captured_v2_native'||prior.tokenAddress!==options.tokenAddress||!sameBlock(prior.target,target)||stable(prior.source)!==stable(options.source)))throw Error('captured_pool_prior_invalid');
 const codeBlock=prior?.code?.block??anchor;
 if(!codeBlock||!Number.isSafeInteger(codeBlock.number)||!freshHash(codeBlock.hash)||!Number.isFinite(Date.parse(codeBlock.timestamp))||codeBlock.number<target.number||codeBlock.number>anchor.number
  ||Date.parse(codeBlock.timestamp)<Date.parse(target.timestamp)||await canonicalHash(codeBlock.number)!==codeBlock.hash)throw Error('captured_pool_noncanonical');
 const code:FreshHistoricalCapturedPoolQuote['code']={chainId:56,block:{...codeBlock},factoryRuntimeHash:FRESH_PCS_V2_FACTORY_RUNTIME_HASH,pairRuntimeHash:FRESH_PCS_V2_PAIR_RUNTIME_HASH};
 if(prior&&stable(prior.code)!==stable(code))throw Error('captured_pool_prior_invalid');
 if(!prior){const age=Date.now()-Date.parse(anchor.timestamp);if(age>30000||age< -5000)throw Error('captured_pool_anchor_stale');
  if(await rpc<string>('eth_chainId',[])!=='0x38')throw Error('captured_pool_chain_invalid');validateFreshPcsV2FactoryCode(await rpc<string>('eth_getCode',[PCS_V2_FACTORY,{blockHash:anchor.hash,requireCanonical:true}]));}
 const candidates:{proof:FreshHistoricalCapturedPoolQuote;liquidity:MarketDecimal}[]=[];
 for(const pool of pools){if(prior&&stable(pool)!==stable(prior.pool))continue;
  try{if(!prior){const runtime=await rpc<string>('eth_getCode',[pool.pool,{blockHash:anchor.hash,requireCanonical:true}]);if(typeof runtime!=='string'||!/^0x[\da-f]{29962}$/.test(runtime)||keccak256(runtime)!==FRESH_PCS_V2_PAIR_RUNTIME_HASH)continue;}
   const retained=prior?.conversion?.kind==='retained_target_pool_native_v2'?prior.conversion:!prior?options.retainedNativeQuotes?.find(p=>p.quoteAddress===pool.quoteAddress):undefined;
   const conversion=pool.quoteAddress===WBNB?null:retained?await recoverFreshRetainedPoolNativeQuote({rpc,quoteAddress:pool.quoteAddress,target,canonicalHash,source:options.source,prior:retained})
    :await recoverFreshHistoricalPoolNativeQuote({rpc,quoteAddress:pool.quoteAddress,target,transactionIndex:0,observation:'block_end',anchor,canonicalHash,prior:prior?.conversion as FreshHistoricalPoolNativeQuote|undefined});
   const num=BigInt(pool.quoteRaw)*(conversion?BigInt(conversion.nativeRaw):1n),den=BigInt(pool.tokenRaw)*(conversion?BigInt(conversion.quoteRaw):1n);
   const price=new MarketDecimal(num*10n**BigInt(pool.tokenDecimals),den*10n**18n),liquidity=new MarketDecimal(num,(conversion?BigInt(conversion.quoteRaw):1n)*10n**18n);
   const proof:FreshHistoricalCapturedPoolQuote={version:1,kind:'historical_captured_v2_native',tokenAddress:pool.tokenAddress,target:{...target},source:structuredClone(options.source),pool,code,conversion,
    rawNativeRatio:{numerator:String(num),denominator:String(den)},priceNative:price.text(),quoteLiquidityNative:liquidity.text()};
   if(prior&&stable(prior)!==stable(proof))throw Error('captured_pool_prior_invalid');candidates.push({proof,liquidity});
  }catch(error){if(prior)throw error;}
 }
 candidates.sort((a,b)=>b.liquidity.compare(a.liquidity));if(!candidates.length)throw Error(prior?'captured_pool_prior_invalid':'captured_pool_quote_unavailable');return candidates[0].proof;
}
