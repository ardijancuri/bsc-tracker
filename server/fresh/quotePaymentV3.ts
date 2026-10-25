import{Interface}from'ethers';import type{Rpc}from'../rpc.js';import{FreshRational}from'./accounting.js';import type{FreshPriceBlock}from'./pricing.js';import type{FreshStateReadEvidence}from'./stateEvidence.js';import{createFreshStateEvidenceRpc}from'./stateEvidence.js';import{recoverFreshHistoricalV3Quote,type FreshHistoricalV3QuoteEvidence}from'./historicalV3Quote.js';import{recoverFreshHistoricalQuote,type FreshHistoricalQuoteEvidence}from'./historicalQuote.js';import type{FreshQuotePayment}from'./quotePayment.js';
const USDT='0x55d398326f99059ff775485246999027b3197955',SPCXB='0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1',abi=new Interface(['function decimals()view returns(uint8)']);
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x),equal=(a:unknown,b:unknown)=>stable(a)===stable(b);
export interface FreshQuotePaymentV3Evidence{version:1;kind:'historical_wallet_quote_settlement_v3';payment:FreshQuotePayment;conversion:FreshHistoricalV3QuoteEvidence;feed:FreshHistoricalQuoteEvidence;amountUsd:string;}
/** Existing strict pool/round validators authenticate historical prices;
 * current anchor state supplies immutable pool identity only. */
export async function recoverFreshQuotePaymentV3(options:{rpc:Rpc;payment:FreshQuotePayment;target:FreshPriceBlock;anchor:FreshPriceBlock;canonicalHash:(n:number)=>Promise<string|null>;state:FreshStateReadEvidence|undefined;prior?:FreshQuotePaymentV3Evidence}){
 const{payment,target,canonicalHash,prior}=options;if(payment.quoteAddress!==SPCXB)throw Error('v3_quote_payment_route_unsupported');
 if(prior&&(prior.version!==1||prior.kind!=='historical_wallet_quote_settlement_v3'||!equal(prior.payment,payment)))throw Error('v3_quote_payment_prior_invalid');
 const conversion=await recoverFreshHistoricalV3Quote({rpc:options.rpc,quoteAddress:SPCXB,settlementAddress:USDT,fee:2500,target,transactionIndex:payment.transactionIndex,anchor:options.anchor,canonicalHash,prior:prior?.conversion});
 const feed=prior?.feed??await recoverFreshHistoricalQuote({rpc:options.rpc,tokenAddress:USDT,target,anchor:options.anchor});
 // Feed and immutable identity anchors may differ. Both stay canonical.
 if(!equal(feed.target,target)||feed.anchor.number<target.number||Date.parse(feed.anchor.timestamp)<Date.parse(target.timestamp)||await canonicalHash(feed.anchor.number)!==feed.anchor.hash||await canonicalHash(target.number)!==target.hash)throw Error('v3_quote_payment_feed_noncanonical');
 const feedPrice=(await recoverFreshHistoricalQuote({rpc:options.rpc,tokenAddress:USDT,target,anchor:feed.anchor,prior:feed})).priceUsd;
 const unavailable=(async()=>{throw Error('v3_quote_payment_precision_missing');})as Rpc,state=createFreshStateEvidenceRpc(unavailable,{number:target.number,hash:target.hash},options.state);if(state.rejectedPrior)throw Error('v3_quote_payment_precision_invalid');
 const data=abi.encodeFunctionData('decimals'),raw=await state.rpc<string>('eth_call',[{to:USDT,data},{blockHash:target.hash,requireCanonical:true}]),d=abi.decodeFunctionResult('decimals',raw),decimals=Number(d[0]);if(!Number.isInteger(decimals)||decimals<0||decimals>36||abi.encodeFunctionResult('decimals',[decimals])!==raw)throw Error('v3_quote_payment_precision_invalid');
 const amount=new FreshRational(BigInt(payment.quoteRaw)*BigInt(conversion.ratio.numerator),BigInt(conversion.ratio.denominator)*10n**BigInt(decimals)).mul(FreshRational.parse(feedPrice)),result:FreshQuotePaymentV3Evidence={version:1,kind:'historical_wallet_quote_settlement_v3',payment,conversion,feed,amountUsd:amount.decimal()};
 if(prior&&!equal(prior,result))throw Error('v3_quote_payment_prior_invalid');return result;
}
