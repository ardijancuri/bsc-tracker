import{createHash}from'node:crypto';
import type{FreshPriceBlock,FreshTokenMetadata}from'./pricing.js';
import type{FreshStateReadEvidence}from'./stateEvidence.js';
import{readFreshCapturedFlapCurve,type FreshCapturedFlapCurve}from'./historicalFlapCurveQuote.js';
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const digest=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
export interface FreshCapturedFlapQuoteAuthorizationSource{tokenAddress:string;source:FreshStateReadEvidence;verifiedMetadata:FreshTokenMetadata;curve:FreshCapturedFlapCurve;}
export interface FreshCapturedFlapQuoteAuthorization{version:1;kind:'authenticated_captured_flap_quote';tokenAddress:string;quoteAddress:string;target:FreshPriceBlock;sourceSha256:string;curveSha256:string;}
/** Exact original controller state identifies this curve's quote, without
 * admitting it as a wallet settlement asset or trusting its name/decimals.
 * Historical conversion must still independently authenticate both pools and
 * dated observations. Re-read the raw target evidence on every use. */
export async function authenticateFreshCapturedFlapQuote(options:{quoteAddress:string;target:FreshPriceBlock;canonicalHash:(n:number)=>Promise<string|null>;source?:FreshCapturedFlapQuoteAuthorizationSource}):Promise<FreshCapturedFlapQuoteAuthorization>{
 const s=options.source,t=options.target;
 if(!s||s.tokenAddress===options.quoteAddress||s.curve.tokenAddress!==s.tokenAddress||s.curve.quoteAddress!==options.quoteAddress
  ||s.verifiedMetadata.address!==s.tokenAddress||s.verifiedMetadata.decimals!==18||stable(s.verifiedMetadata.block)!==stable(t)
  ||await options.canonicalHash(t.number)!==t.hash)throw Error('captured_flap_quote_authorization_invalid');
 const actual=readFreshCapturedFlapCurve({tokenAddress:s.tokenAddress,target:t,source:s.source,verifiedMetadata:s.verifiedMetadata});
 if(stable(actual)!==stable(s.curve)||s.verifiedMetadata.supplyRaw!==null&&s.verifiedMetadata.supplyRaw!==actual.supplyRaw)throw Error('captured_flap_quote_authorization_invalid');
 return{version:1,kind:'authenticated_captured_flap_quote',tokenAddress:s.tokenAddress,quoteAddress:options.quoteAddress,target:{...t},sourceSha256:digest(s.source),curveSha256:digest(actual)};
}
