import type{Rpc}from'../rpc.js';import{MarketDecimal}from'../nodeMarketMath.js';
import{assertFreshRegisteredMarketHistory,type FreshRegisteredMarketHistoryContext}from'./historicalRegisteredV4Price.js';
import{validFreshInfinityClMarketIdentity,historicalFreshInfinityClPrice,type FreshInfinityClMarketIdentity,type FreshInfinityClHistoricalPrice}from'./infinityClMarket.js';
import type{FreshPriceBlock}from'./pricing.js';
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
export interface FreshRegisteredInfinityClHistoricalPrice{version:1;kind:'historical_registered_infinity_cl_native_price';tokenAddress:string;target:FreshPriceBlock;identity:FreshInfinityClMarketIdentity;tokenDecimals:number;market:FreshInfinityClHistoricalPrice;rawNativeRatio:{numerator:string;denominator:string};priceNative:string;quoteLiquidityNative:string;}
/** Native/no-hook Infinity CL only. The original genuine settled sqrt and
 * complete subsequent liquidity-event window supply the dated transfer mark;
 * exact block USD conversion remains the common caller's responsibility. */
export async function recoverFreshRegisteredInfinityClPrice(o:FreshRegisteredMarketHistoryContext&{rpc:Rpc;prior?:FreshRegisteredInfinityClHistoricalPrice}):Promise<FreshRegisteredInfinityClHistoricalPrice>{
 const identity=await assertFreshRegisteredMarketHistory(o),p=o.prior;
 if(!validFreshInfinityClMarketIdentity(identity))throw Error('registered_infinity_cl_identity_invalid');
 if(p&&(p.version!==1||p.kind!=='historical_registered_infinity_cl_native_price'||p.tokenAddress!==o.tokenAddress||stable(p.target)!==stable(o.target)||stable(p.identity)!==stable(identity)||p.tokenDecimals!==o.verifiedMetadata.decimals||Buffer.byteLength(stable(p))>256*1024))throw Error('registered_infinity_cl_prior_invalid');
 const market=await historicalFreshInfinityClPrice({rpc:o.rpc,identity,tokenDecimals:o.verifiedMetadata.decimals,target:o.target,canonicalHash:o.canonicalHash,prior:p?.market}),raw=market.rawQuoteRatio;
 const price=new MarketDecimal(BigInt(raw.numerator)*10n**BigInt(o.verifiedMetadata.decimals),BigInt(raw.denominator)*10n**18n),depth=new MarketDecimal(BigInt(market.liquidityRaw)*(1n<<96n),BigInt(market.sqrtPriceX96)*10n**18n);
 if(price.n<=0n||depth.n<=0n)throw Error('registered_infinity_cl_price_invalid');
 const proof:FreshRegisteredInfinityClHistoricalPrice={version:1,kind:'historical_registered_infinity_cl_native_price',tokenAddress:o.tokenAddress,target:{...o.target},identity:structuredClone(identity),tokenDecimals:o.verifiedMetadata.decimals,market,rawNativeRatio:{...raw},priceNative:price.text(),quoteLiquidityNative:depth.text()};
 if(Buffer.byteLength(stable(proof))>256*1024||p&&stable(p)!==stable(proof))throw Error('registered_infinity_cl_prior_invalid');return proof;
}
