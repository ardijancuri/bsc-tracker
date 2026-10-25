import{Interface,ZeroAddress}from'ethers';import type{Rpc}from'../rpc.js';import{FLAP_PORTAL,WBNB,flapInterface}from'../launchpad.js';
import{freshAddress,freshHash}from'./capture.js';import{createFreshStateEvidenceRpc,type FreshStateReadEvidence}from'./stateEvidence.js';
import type{FreshPriceBlock,FreshTokenMetadata}from'./pricing.js';import{MarketDecimal}from'../nodeMarketMath.js';
import{recoverFreshHistoricalPoolNativeQuote,type FreshHistoricalPoolNativeQuote}from'./historicalPoolQuote.js';
const tokenAbi=new Interface(['function decimals()view returns(uint8)','function totalSupply()view returns(uint256)']),wad=10n**18n,supply=10n**27n;
const sameBlock=(a:FreshPriceBlock,b:FreshPriceBlock)=>a?.number===b?.number&&a?.hash===b?.hash&&a?.timestamp===b?.timestamp;
const stable=(v:unknown):string=>JSON.stringify(v,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export interface FreshCapturedFlapCurve {
 tokenAddress:string;quoteAddress:string;priceScaled18:string;precisionBasis:'retained_target_call'|'independently_verified_target_metadata';
 supplyRaw:string;normalizedReserve:string;rawReserve:string;reserveModelFactor:string;
 rawQuotePerToken:{numerator:string;denominator:string};
}
/** Pure validation of actual target-block controller state. If the raw token
 * precision call was unavailable, verifiedMetadata MUST come from the caller's
 * independently revalidated fixed-precision verifier for this token/target.
 * Serialized proofs and current token rows are never accepted as that verifier.
 * Supply always requires the original successful target-block raw response.
 * The curve's unique reserve normalization is not an ERC20 decimals claim. */
export function readFreshCapturedFlapCurve(options:{tokenAddress:string;target:FreshPriceBlock;source:FreshStateReadEvidence;verifiedMetadata?:FreshTokenMetadata}):FreshCapturedFlapCurve{
 const{target,source}=options,token=freshAddress(options.tokenAddress);
 if(!token||!Number.isSafeInteger(target.number)||!freshHash(target.hash)||!Number.isFinite(Date.parse(target.timestamp)))throw Error('captured_flap_identity_invalid');
 const state=createFreshStateEvidenceRpc((async()=>{throw Error('captured_flap_no_network');})as Rpc,target,source);
 if(state.rejectedPrior)throw Error('captured_flap_source_invalid');
 const calls=new Map((state.snapshot()?.calls??[]).map(call=>[call.to+':'+call.data,call.result]));
 const read=(to:string,abi:Interface,method:string,args:unknown[]=[])=>{
  const raw=calls.get(to+':'+abi.encodeFunctionData(method,args));if(raw===undefined)throw Error('captured_flap_source_incomplete');
  try{const decoded=abi.decodeFunctionResult(method,raw);if(abi.encodeFunctionResult(method,[...decoded])!==raw)throw Error();return decoded;}catch{throw Error('captured_flap_source_invalid');}
 };
 let precisionBasis:FreshCapturedFlapCurve['precisionBasis']='retained_target_call';
 const precision=calls.get(token+':'+tokenAbi.encodeFunctionData('decimals'));
 if(precision!==undefined){if(BigInt(read(token,tokenAbi,'decimals')[0])!==18n)throw Error('captured_flap_precision_invalid');}
 else{
  const metadata=options.verifiedMetadata;
  if(!metadata||metadata.address!==token||metadata.decimals!==18||!sameBlock(metadata.block,target))throw Error('captured_flap_precision_unverified');
  precisionBasis='independently_verified_target_metadata';
 }
 const actualSupply=BigInt(read(token,tokenAbi,'totalSupply')[0]);if(actualSupply!==supply)throw Error('captured_flap_supply_unsupported');
 const curve=read(FLAP_PORTAL,flapInterface,'getTokenV8Safe',[token])[0],rawQuote=String(curve.quoteTokenAddress).toLowerCase(),quote=rawQuote===ZeroAddress?WBNB:freshAddress(rawQuote);
 if(!quote||quote===token||BigInt(curve.status)!==1n||BigInt(curve.tokenVersion)!==6n||BigInt(curve.price)<=0n||BigInt(curve.reserve)<=0n
  ||BigInt(curve.r)<=0n||BigInt(curve.h)<=0n||BigInt(curve.k)<=0n||BigInt(curve.circulatingSupply)<0n||BigInt(curve.circulatingSupply)>actualSupply)throw Error('captured_flap_curve_unsupported');
 const denominator=actualSupply-BigInt(curve.circulatingSupply)+BigInt(curve.h),square=denominator*denominator/wad;
 if(square<=0n||BigInt(curve.k)*wad/square!==BigInt(curve.price))throw Error('captured_flap_curve_mismatch');
 const normalized=(BigInt(curve.k)*wad+denominator-1n)/denominator-BigInt(curve.r),reserve=BigInt(curve.reserve);
 if(normalized<=0n)throw Error('captured_flap_curve_mismatch');
 const matches:bigint[]=[];for(let power=0;power<=18;power++){const factor=10n**BigInt(power);if((normalized+factor-1n)/factor===reserve)matches.push(factor);}
 if(matches.length!==1)throw Error('captured_flap_normalization_ambiguous');
 return{tokenAddress:token,quoteAddress:quote,priceScaled18:String(curve.price),precisionBasis,supplyRaw:String(actualSupply),normalizedReserve:String(normalized),rawReserve:String(reserve),reserveModelFactor:String(matches[0]),
  rawQuotePerToken:{numerator:String(curve.price),denominator:String(wad*matches[0])}};
}
export interface FreshHistoricalFlapCurveNativeQuote {
 version:1;kind:'historical_captured_flap_curve_native';target:FreshPriceBlock;tokenAddress:string;source:FreshStateReadEvidence;curve:FreshCapturedFlapCurve;
 conversion:FreshHistoricalPoolNativeQuote|null;rawNativeRatio:{numerator:string;denominator:string};priceNative:string;
}
/** Transfer mark policy observes target block END for both curve and quote
 * reserves. This cannot be reused as the earlier settled purchase/sale amount. */
export async function recoverFreshHistoricalFlapCurveQuote(options:{rpc:Rpc;tokenAddress:string;target:FreshPriceBlock;source:FreshStateReadEvidence;
 verifiedMetadata?:FreshTokenMetadata;anchor:FreshPriceBlock;canonicalHash:(number:number)=>Promise<string|null>;prior?:FreshHistoricalFlapCurveNativeQuote}):Promise<FreshHistoricalFlapCurveNativeQuote>{
 const{target,source,prior}=options;if(await options.canonicalHash(target.number)!==target.hash)throw Error('captured_flap_noncanonical');
 const curve=readFreshCapturedFlapCurve(options);
 if(prior&&(prior.version!==1||prior.kind!=='historical_captured_flap_curve_native'||prior.tokenAddress!==curve.tokenAddress||stable(prior.target)!==stable(target)||stable(prior.source)!==stable(source)))throw Error('captured_flap_prior_invalid');
 const conversion=curve.quoteAddress===WBNB?null:await recoverFreshHistoricalPoolNativeQuote({rpc:options.rpc,quoteAddress:curve.quoteAddress,target,transactionIndex:0,
  observation:'block_end',anchor:options.anchor,canonicalHash:options.canonicalHash,prior:prior?.conversion??undefined});
 const numerator=BigInt(curve.rawQuotePerToken.numerator)*(conversion?BigInt(conversion.nativeRaw):1n),denominator=BigInt(curve.rawQuotePerToken.denominator)*(conversion?BigInt(conversion.quoteRaw):1n);
 const result:FreshHistoricalFlapCurveNativeQuote={version:1,kind:'historical_captured_flap_curve_native',tokenAddress:curve.tokenAddress,target:{...target},source:structuredClone(source),curve,conversion,
  rawNativeRatio:{numerator:String(numerator),denominator:String(denominator)},priceNative:new MarketDecimal(numerator,denominator).text()};
 if(prior&&stable(prior)!==stable(result))throw Error('captured_flap_prior_invalid');return result;
}
