import{createHash}from'node:crypto';import{keccak256}from'ethers';
import type{FreshPriceBlock,FreshTokenMetadata}from'./pricing.js';import type{FreshStateReadEvidence}from'./stateEvidence.js';
import{readFreshCapturedV2Pools,type FreshCapturedV2Pool}from'./historicalCapturedPoolQuote.js';
import{validateFreshPcsV2FactoryCode,FRESH_PCS_V2_PAIR_RUNTIME_HASH}from'./flapQuoteRecovery.js';
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const digest=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
export interface FreshCapturedV2QuoteAuthorizationSource{tokenAddress:string;source:FreshStateReadEvidence;verifiedMetadata:FreshTokenMetadata;pool:FreshCapturedV2Pool;code:{block:FreshPriceBlock;factoryCode:string;pairCode:string};}
export interface FreshCapturedV2QuoteAuthorization{version:1;kind:'authenticated_captured_v2_quote';tokenAddress:string;pool:string;quoteAddress:string;target:FreshPriceBlock;sourceSha256:string;codeBlock:FreshPriceBlock;factoryCodeSha256:string;pairCodeSha256:string;}
/** Authorization is derived from complete raw target pool facts and exact
 * official immutable code on EVERY use. A boolean or prior derived price can
 * never make an arbitrary asset a wallet settlement quote. This permission
 * applies only to the quote leg of this particular captured V2 transfer mark. */
export async function authenticateFreshCapturedV2Quote(options:{quoteAddress:string;target:FreshPriceBlock;anchor:FreshPriceBlock;canonicalHash:(n:number)=>Promise<string|null>;source?:FreshCapturedV2QuoteAuthorizationSource}):Promise<FreshCapturedV2QuoteAuthorization>{
 const s=options.source,b=s?.code?.block,t=options.target;
 if(!s||s.pool.quoteAddress!==options.quoteAddress||s.pool.tokenAddress!==s.tokenAddress||s.tokenAddress===options.quoteAddress
  ||!b||!Number.isSafeInteger(b.number)||b.number<t.number||b.number>options.anchor.number||!Number.isFinite(Date.parse(b.timestamp))||Date.parse(b.timestamp)<Date.parse(t.timestamp)
  ||await options.canonicalHash(t.number)!==t.hash||await options.canonicalHash(b.number)!==b.hash)throw Error('captured_v2_quote_authorization_invalid');
 const pools=readFreshCapturedV2Pools({tokenAddress:s.tokenAddress,target:t,source:s.source,verifiedMetadata:s.verifiedMetadata});
 if(!pools.some(p=>stable(p)===stable(s.pool)))throw Error('captured_v2_quote_authorization_invalid');
 validateFreshPcsV2FactoryCode(s.code.factoryCode);
 if(typeof s.code.pairCode!=='string'||!/^0x[\da-f]{29962}$/.test(s.code.pairCode)||keccak256(s.code.pairCode)!==FRESH_PCS_V2_PAIR_RUNTIME_HASH)throw Error('captured_v2_quote_authorization_invalid');
 return{version:1,kind:'authenticated_captured_v2_quote',tokenAddress:s.tokenAddress,pool:s.pool.pool,quoteAddress:options.quoteAddress,target:{...t},sourceSha256:digest(s.source),codeBlock:{...b},factoryCodeSha256:digest(s.code.factoryCode),pairCodeSha256:digest(s.code.pairCode)};
}
