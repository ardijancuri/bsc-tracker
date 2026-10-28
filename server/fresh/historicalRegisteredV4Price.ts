import type {Rpc} from '../rpc.js';
import {WBNB} from '../launchpad.js';
import {MarketDecimal} from '../nodeMarketMath.js';
import type {FreshPriceBlock,FreshTokenMetadata} from './pricing.js';
import {freshHash} from './capture.js';
import {freshMarketIdentityInvalid,freshMarketLaunchDigest,validFreshSupportedMarketIdentity,type FreshSupportedMarketIdentity} from './currentMarketAnchor.js';
import {createFreshStateEvidenceRpc,type FreshStateReadEvidence} from './stateEvidence.js';
import {readFreshStockwaveMarket,validFreshStockwaveMarketIdentity,freshStockwaveStorageSlots,stockwavePoolManagerInterface,type FreshStockwaveMarketIdentity} from './stockwaveMarket.js';
import {recoverFreshHistoricalV3Quote,type FreshHistoricalV3QuoteEvidence} from './historicalV3Quote.js';
import {recoverFreshHistoricalGenericNativeQuote,type FreshHistoricalGenericNativeQuote} from './historicalGenericQuote.js';
const USDT='0x55d398326f99059ff775485246999027b3197955';
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const same=(a:unknown,b:unknown)=>stable(a)===stable(b);
export interface FreshRegisteredV4HistoricalPrice {
 version:1;kind:'historical_registered_v4_native_price';tokenAddress:string;target:FreshPriceBlock;identity:FreshStockwaveMarketIdentity;
 tokenDecimals:number;state:FreshStateReadEvidence;conversion:FreshHistoricalV3QuoteEvidence|FreshHistoricalGenericNativeQuote|null;
 rawNativeRatio:{numerator:string;denominator:string};priceNative:string;quoteLiquidityNative:string;
}
export type FreshRegisteredMarketHistoryContext={tokenAddress:string;target:FreshPriceBlock;verifiedMetadata:FreshTokenMetadata;identity:unknown;launchFact:any;
 boundary:{number:number;hash:string};captureRevision:string;captureNumber:number;canonicalHash:(n:number)=>Promise<string|null>};
type Options=FreshRegisteredMarketHistoryContext&{rpc:Rpc;
 boundary:{number:number;hash:string};captureRevision:string;captureNumber:number;anchor:FreshPriceBlock;canonicalHash:(n:number)=>Promise<string|null>;
 source?:FreshStateReadEvidence;prior?:FreshRegisteredV4HistoricalPrice};
/** Transfer marks only: authenticated initialization plus actual target-block
 * state. No launch sqrt, current valuation, token symbol or dollar peg is a
 * historical price. The short-lived receipt keeps the raw slot observation
 * and dated conversion so repairs can revalidate without another RPC. */
export async function recoverFreshRegisteredV4Price(o:Options):Promise<FreshRegisteredV4HistoricalPrice>{
 const m=await assertFreshRegisteredMarketHistory(o),t=o.target,p=o.prior;
 if(!validFreshStockwaveMarketIdentity(m))throw Error('registered_v4_identity_invalid');
 return recover(o,m,t,p);
}
/** Shared server-issued registry context for historical singleton managers.
 * Current-only aged identity anchors remain deliberately unavailable here. */
export async function assertFreshRegisteredMarketHistory(o:FreshRegisteredMarketHistoryContext):Promise<FreshSupportedMarketIdentity>{
 const m=o.identity as FreshSupportedMarketIdentity&{canonicalInitialization?:any},f=o.launchFact,t=o.target,marker=m?.canonicalInitialization;
 if(!validFreshSupportedMarketIdentity(m)||freshMarketIdentityInvalid(m)||m.tokenAddress!==o.tokenAddress||m.initial.blockNumber>t.number
  ||!f||f.status!=='eligible'||f.token_address!==o.tokenAddress||!Number.isSafeInteger(Number(f.block_number))||Number(f.block_number)>m.initial.blockNumber
  ||!freshHash(f.block_hash)||!Number.isFinite(Date.parse(f.launched_at))||Date.parse(f.launched_at)>Date.parse(t.timestamp)
  ||o.verifiedMetadata.address!==o.tokenAddress||!same(o.verifiedMetadata.block,t)||!Number.isInteger(o.verifiedMetadata.decimals)||o.verifiedMetadata.decimals<0||o.verifiedMetadata.decimals>255
  ||!marker||marker.version!==1||marker.kind!=='capture_committed_initialization'||marker.tokenAddress!==o.tokenAddress||marker.poolId!==m.poolId
  ||marker.initialNumber!==m.initial.blockNumber||marker.initialHash!==m.initial.blockHash||marker.launchDigest!==freshMarketLaunchDigest(f)
  ||!same(marker.boundary,o.boundary)||!/^\d+$/.test(o.captureRevision)||!/^\d+$/.test(marker.captureRevision)||BigInt(marker.captureRevision)>BigInt(o.captureRevision)
  ||m.initial.blockNumber<=o.boundary.number||!Number.isFinite(Date.parse(marker.initialOccurredAt))||Date.parse(marker.initialOccurredAt)>Date.parse(t.timestamp))throw Error('registered_v4_identity_invalid');
 const through=marker.confirmedThrough;
 if(!through||!Number.isSafeInteger(through.number)||through.number<m.initial.blockNumber||through.number>o.captureNumber||!freshHash(through.hash)
  ||!Number.isFinite(Date.parse(through.occurredAt))||Date.parse(through.occurredAt)<Date.parse(marker.initialOccurredAt)
  ||await o.canonicalHash(Number(f.block_number))!==f.block_hash||await o.canonicalHash(m.initial.blockNumber)!==m.initial.blockHash
  ||await o.canonicalHash(through.number)!==through.hash||await o.canonicalHash(t.number)!==t.hash)throw Error('registered_v4_noncanonical');
 return m;
}
async function recover(o:Options,m:FreshStockwaveMarketIdentity,t:FreshPriceBlock,p:FreshRegisteredV4HistoricalPrice|undefined):Promise<FreshRegisteredV4HistoricalPrice>{
 if(p&&(p.version!==1||p.kind!=='historical_registered_v4_native_price'||p.tokenAddress!==o.tokenAddress||!same(p.target,t)||!same(p.identity,m)
  ||p.tokenDecimals!==o.verifiedMetadata.decimals||Buffer.byteLength(stable(p))>256*1024))throw Error('registered_v4_prior_invalid');
 // Prior proofs are re-decoded, not accepted as precomputed prices. Any raw
 // observation retained separately for the same call must still agree.
 const state=createFreshStateEvidenceRpc(p?(async()=>{throw Error('registered_v4_prior_missing');})as Rpc:o.rpc,t,p?.state??o.source);
 if(state.rejectedPrior)throw Error('registered_v4_state_invalid');
 const market=await readFreshStockwaveMarket({rpc:state.rpc,identity:m,tokenDecimals:o.verifiedMetadata.decimals,block:t}),snapshot=state.snapshot();
 if(!snapshot)throw Error('registered_v4_state_invalid');
 const data=stockwavePoolManagerInterface.encodeFunctionData('extsload',[freshStockwaveStorageSlots(m.poolId)]),last=snapshot.calls.find(c=>c.to===m.manager&&c.data===data),source=o.source&&createFreshStateEvidenceRpc((async()=>{throw Error('registered_v4_source_missing');})as Rpc,t,o.source);
 if(source?.rejectedPrior)throw Error('registered_v4_state_invalid');
 if(last&&source){const found=source.snapshot()?.calls.find(c=>c.to===last.to&&c.data===last.data);if(found&&found.result!==last.result)throw Error('registered_v4_state_conflict');}
 const retained={...snapshot,calls:snapshot.calls.filter(c=>c.to===m.manager&&c.data===last?.data)};
 if(retained.calls.length!==1)throw Error('registered_v4_state_invalid');
 let conversion:FreshRegisteredV4HistoricalPrice['conversion']=null;
 const q=m.quoteAddress;
 if(q!==WBNB){
  if(q===USDT){const old=p?.conversion;if(old&&old.kind!=='historical_raw_pool_trusted_v3')throw Error('registered_v4_prior_invalid');
   const windows=old?[t.number-old.fromBlock]:[16,64,256];let error:unknown;
   for(const lookback of windows){if(![16,64,256].includes(lookback))throw Error('registered_v4_prior_invalid');try{conversion=await recoverFreshHistoricalV3Quote({rpc:o.rpc,quoteAddress:q,settlementAddress:WBNB,fee:100,target:t,transactionIndex:0,observation:'block_end',anchor:old?.anchor??o.anchor,canonicalHash:o.canonicalHash,prior:old??undefined,lookbackBlocks:lookback as 16|64|256});break;}catch(e){error=e;if(old||!(e instanceof Error)||!['historical_v3_swap_unavailable','historical_v3_preceding_swap_unavailable'].includes(e.message))throw e;}}
   if(!conversion)throw error;
  }else{const old=p?.conversion;if(old&&old.kind!=='historical_registered_quote_native_v3_bridge'&&old.kind!=='historical_registered_quote_native_v4_bridge')throw Error('registered_v4_prior_invalid');conversion=await recoverFreshHistoricalGenericNativeQuote({rpc:o.rpc,quoteAddress:q,target:t,transactionIndex:0,observation:'block_end',anchor:old?.quote.anchor??o.anchor,canonicalHash:o.canonicalHash,prior:old??undefined});}
 }
 const ratio=conversion?.kind==='historical_raw_pool_trusted_v3'?conversion.ratio:conversion?.rawNativeRatio??{numerator:'1',denominator:'1'},raw=market.rawQuoteRatio;
 const value=new MarketDecimal(BigInt(raw.numerator)*BigInt(ratio.numerator),BigInt(raw.denominator)*BigInt(ratio.denominator)),virtual=market.virtualQuoteLiquidityRaw;
 const price=value.mul(new MarketDecimal(10n**BigInt(o.verifiedMetadata.decimals),10n**18n)),liquidity=new MarketDecimal(BigInt(virtual.numerator)*BigInt(ratio.numerator),BigInt(virtual.denominator)*BigInt(ratio.denominator)*10n**18n);
 if(price.n<=0n||liquidity.n<=0n)throw Error('registered_v4_price_invalid');
 const proof:FreshRegisteredV4HistoricalPrice={version:1,kind:'historical_registered_v4_native_price',tokenAddress:o.tokenAddress,target:{...t},identity:structuredClone(m),tokenDecimals:o.verifiedMetadata.decimals,state:retained,conversion,rawNativeRatio:{numerator:String(value.n),denominator:String(value.d)},priceNative:price.text(),quoteLiquidityNative:liquidity.text()};
 if(Buffer.byteLength(stable(proof))>256*1024||p&&!same(p,proof))throw Error('registered_v4_prior_invalid');return proof;
}
