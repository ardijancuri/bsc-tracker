import type {Rpc} from '../rpc.js';
import {WBNB} from '../launchpad.js';
import {FreshRational} from './accounting.js';
import type {FreshPriceBlock} from './pricing.js';
import type {FreshCapturedReceipt} from './capture.js';
import type {FreshStateReadEvidence} from './stateEvidence.js';
import type {FreshHistoricalQuoteEvidence} from './historicalQuote.js';
import {recoverFreshHistoricalPoolNativeQuote,type FreshHistoricalPoolNativeQuote} from './historicalPoolQuote.js';
import {recoverFreshHistoricalV3Quote,valueFreshHistoricalV3QuoteRaw,type FreshHistoricalV3QuoteEvidence} from './historicalV3Quote.js';
import {freshSignedBatchNativeBuyPayment,type FreshSignedBatchNativeBuyPayment} from './signedBatchPayment.js';

const stable=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export type FreshSignedBatchConversion=
 |{kind:'v2_native';pool:FreshHistoricalPoolNativeQuote;source:FreshPriceBlock}
 |{kind:'v3_native';pool:FreshHistoricalV3QuoteEvidence}
 |{kind:'v3_trusted';pool:FreshHistoricalV3QuoteEvidence;precision:FreshStateReadEvidence;feed:FreshHistoricalQuoteEvidence};
export interface FreshSignedBatchPurchaseValue{
 version:1;kind:'historical_signed_batch_native_purchase';payment:FreshSignedBatchNativeBuyPayment;conversion:FreshSignedBatchConversion;
 nativePriceUsd:string;grossNativeUsd:string;changeUsd:string;amountUsd:string;expenseUsd:string;
 grossNativeQ:string;changeQ:string;amountQ:string;expenseQ:string;
}

/** The user's explicit batch-expense policy applies only after the signed
 * transaction, actual successful outflows and exact returned quote change have
 * been authenticated. A distinct native payment is an expense, not an inferred
 * launchpad fee. Gas remains the original receipt payment and is added once by
 * the normal accounting path. Historical change uses an earlier market mark. */
export async function recoverFreshSignedBatchPurchase(options:{entry:FreshCapturedReceipt;target:FreshPriceBlock;token:string;wallet:string;targetRaw:bigint;
 nativePriceUsd:string;rpc:Rpc;anchor:()=>Promise<FreshPriceBlock>;canonicalHash:(number:number)=>Promise<string|null>;
 canonicalBlock:(number:number)=>Promise<FreshPriceBlock|null>;prior?:FreshSignedBatchPurchaseValue;retainedConversion?:FreshSignedBatchConversion}):Promise<FreshSignedBatchPurchaseValue|null>{
 const {entry,target,token,wallet,targetRaw,nativePriceUsd,rpc,canonicalHash,canonicalBlock,prior}=options;
 const payment=freshSignedBatchNativeBuyPayment(entry,target,token,wallet,targetRaw);if(!payment)return null;
 const actualTarget=await canonicalBlock(target.number);if(stable(actualTarget)!==stable(target))throw Error('signed_batch_target_noncanonical');
 if(prior&&(prior.version!==1||prior.kind!=='historical_signed_batch_native_purchase'||stable(prior.payment)!==stable(payment)))throw Error('signed_batch_prior_invalid');
 const native=FreshRational.parse(nativePriceUsd);if(native.n<=0n)throw Error('signed_batch_native_price_invalid');
 let conversion:FreshSignedBatchConversion,change:FreshRational;
 const retained=prior?.conversion??options.retainedConversion;
 if(retained?.kind==='v3_native'||retained?.kind==='v3_trusted'){
  const old=retained,pool=await recoverFreshHistoricalV3Quote({rpc,quoteAddress:payment.quoteAddress,settlementAddress:old.pool.settlementAddress,fee:old.pool.fee,
   target,transactionIndex:payment.transactionIndex,anchor:old.pool.anchor,canonicalHash,prior:old.pool});
  if(stable(await canonicalBlock(pool.source.number))!==stable(pool.source)||stable(await canonicalBlock(pool.anchor.number))!==stable(pool.anchor))throw Error('signed_batch_conversion_noncanonical');
  if(old.kind==='v3_native'){
   if(pool.settlementAddress!==WBNB)throw Error('signed_batch_native_conversion_invalid');
   change=new FreshRational(BigInt(payment.quoteRemainingRaw)*BigInt(pool.ratio.numerator),BigInt(pool.ratio.denominator)*10n**18n).mul(native);
   conversion={kind:'v3_native',pool};
  }else{
   if(pool.settlementAddress===WBNB||await canonicalHash(old.feed.anchor.number)!==old.feed.anchor.hash||stable(await canonicalBlock(old.feed.anchor.number))!==stable(old.feed.anchor))throw Error('signed_batch_trusted_conversion_invalid');
   const valued=await valueFreshHistoricalV3QuoteRaw(payment.quoteRemainingRaw,pool,old.precision,old.feed);
   change=FreshRational.fromStored(valued.amountQ);conversion={kind:'v3_trusted',pool,precision:old.precision,feed:old.feed};
  }
 }else{
  const old=retained,pool=await recoverFreshHistoricalPoolNativeQuote({rpc,quoteAddress:payment.quoteAddress,target,transactionIndex:payment.transactionIndex,
   anchor:old?.kind==='v2_native'?old.pool.code.block:await options.anchor(),canonicalHash,prior:old?.kind==='v2_native'?old.pool:undefined});
  const source=await canonicalBlock(Number(BigInt(pool.pool.lastSync.blockNumber)));
  if(stable(await canonicalBlock(pool.code.block.number))!==stable(pool.code.block))throw Error('signed_batch_conversion_noncanonical');
  if(!source||source.hash!==pool.pool.lastSync.blockHash||await canonicalHash(source.number)!==source.hash)throw Error('signed_batch_conversion_noncanonical');
  const age=Date.parse(target.timestamp)-Date.parse(source.timestamp);
  if(!Number.isFinite(age)||age<0||age>120_000)throw Error('signed_batch_conversion_stale');
  conversion={kind:'v2_native',pool,source};
  change=new FreshRational(BigInt(payment.quoteRemainingRaw)*BigInt(pool.nativeRaw),BigInt(pool.quoteRaw)*10n**18n).mul(native);
 }
 const gross=new FreshRational(BigInt(payment.acquisitionNativeWei),10n**18n).mul(native),expense=new FreshRational(BigInt(payment.extraNativeWei),10n**18n).mul(native),amount=gross.sub(change);
 if(change.n<=0n||expense.n<=0n||amount.n<=0n||change.compare(gross)>=0)throw Error('signed_batch_value_invalid');
 const result:FreshSignedBatchPurchaseValue={version:1,kind:'historical_signed_batch_native_purchase',payment,conversion,nativePriceUsd,
  grossNativeUsd:gross.decimal(),changeUsd:change.decimal(),amountUsd:amount.decimal(),expenseUsd:expense.decimal(),
  grossNativeQ:gross.exact(),changeQ:change.exact(),amountQ:amount.exact(),expenseQ:expense.exact()};
 if(prior&&stable(prior)!==stable(result))throw Error('signed_batch_prior_invalid');return result;
}
