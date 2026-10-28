import{compactFreshAcquisitionCost}from'./acquisitionCost.js';
import{recoverFreshHistorical3XdCurvePrice,type FreshHistorical3XdCurvePrice}from'./historical3XdCurvePrice.js';
import{findFreshV2BridgeQuoteHints,recoverFreshHistoricalV2BridgePrice,type FreshHistoricalV2BridgePrice}from'./historicalV2BridgePrice.js';
import{recoverFreshRegisteredV3Price,type FreshRegisteredV3HistoricalPrice}from'./historicalRegisteredV3Price.js';
import{recoverFreshRegisteredV4Price,type FreshRegisteredV4HistoricalPrice}from'./historicalRegisteredV4Price.js';
import{recoverFreshRegisteredInfinityClPrice,type FreshRegisteredInfinityClHistoricalPrice}from'./historicalRegisteredInfinityClPrice.js';
import{validFreshInfinityClMarketIdentity}from'./infinityClMarket.js';
import{recoverFreshHistoricalGenericNativeQuote,recoverFreshHistoricalGenericCapturedPrice,type FreshHistoricalGenericNativeQuote,type FreshHistoricalGenericCapturedPrice}from'./historicalGenericQuote.js';
import{recoverFreshQuotePaymentV3,type FreshQuotePaymentV3Evidence}from'./quotePaymentV3.js';
import{freshNativeStockAcquisitionCost,type FreshNativeStockAcquisitionCost}from'./nativeStockAcquisitionCost.js';
import{freshNativeIntermediateAcquisitionCost,type FreshNativeIntermediateAcquisitionCost}from'./nativeIntermediateAcquisitionCost.js';
import{captureFreshParentPoolQuote,type FreshParentPoolCapture}from'./parentPoolCapture.js';
import{valueFreshParentFlapPurchase,type FreshHistoricalParentPoolQuoteEvidence}from'./historicalParentPoolQuote.js';
import type {Pool} from 'pg';
import type{FreshFinancialEvent,FreshAirdropBasis}from'../../shared/freshAccounting.js';
import type {Rpc} from '../rpc.js';
import {blockHex} from '../rpc.js';
import {TRUSTED_QUOTE_FEEDS} from '../nodeMarketProtocols.js';
import {MarketDecimal} from '../nodeMarketMath.js';
import {validateFreshBlock,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock,type FreshReceipt} from './capture.js';
import {freshTokenMetadata,freshQuoteUsd,type FreshPriceBlock,type FreshTokenMetadata} from './pricing.js';
import type {FreshStateReadEvidence} from './stateEvidence.js';
import {createFreshStateEvidenceRpc} from './stateEvidence.js';
import {recoverFreshHistoricalQuote,type FreshHistoricalQuoteEvidence} from './historicalQuote.js';
import {recoverFreshHistoricalPool,type FreshHistoricalPoolEvidence} from './historicalPool.js';
import {recoverFreshHistoricalCapturedPoolQuote,type FreshHistoricalCapturedPoolQuote} from './historicalCapturedPoolQuote.js';
import {freshStockwaveBridgeFee} from './bridgeFee.js';
import {WBNB} from '../launchpad.js';
import {historicalFreshStockwavePrice,validFreshStockwaveMarketIdentity,type FreshStockwaveHistoricalPrice} from './stockwaveMarket.js';
import {recoverFreshStockRawQuote,FRESH_STOCK_QUOTE_TOKEN,type FreshStockRawQuoteEvidence} from './stockQuote.js';
import {recoverFreshFlapQuote,type FreshFlapQuoteRecoveryEvidence} from './flapQuoteRecovery.js';
import {recoverFreshHistoricalFlapCurveQuote,type FreshHistoricalFlapCurveNativeQuote} from './historicalFlapCurveQuote.js';
import {freshDirectFlapPurchase,type FreshDirectFlapPurchase} from './directFlapPurchase.js';
import {recoverFreshHistoricalNativeQuote,type FreshHistoricalNativeQuoteEvidence} from './historicalNativeQuote.js';
import {recoverFreshHistoricalPoolNativeQuote,type FreshHistoricalPoolNativeQuote} from './historicalPoolQuote.js';
import {FRESH_BTCB_QUOTE} from './currentBtcQuote.js';
import {createFreshRecoveryBatch,type FreshRecoveryBatch} from './recoveryBatch.js';
import {createFreshTemplateMetadataRecovery} from './templateMetadataRecovery.js';
import{createFreshPinnedCloneMetadataRecovery}from'./pinnedCloneMetadataLoader.js';
import {createFreshImportedMetadataRecovery,freshImportedMetadataMatchesState} from './importedMetadata.js';
import {freshQuotePayment,type FreshQuotePayment} from './quotePayment.js';
import {freshNativeQuoteChange,valueFreshNativeQuoteChange,freshNativeStockQuoteChange,valueFreshNativeStockQuoteChange,type FreshNativeQuoteChangeValue,type FreshNativeStockQuoteChangeValue} from './nativeQuoteChange.js';
import {recoverFreshSignedBatchPurchase,type FreshSignedBatchPurchaseValue} from './signedBatchValuation.js';
import type {FreshCallTrace} from './trace.js';
import{freshVerifiedAirdropClaimCandidate,recoverFreshVerifiedAirdropBasis}from'./verifiedAirdropClaim.js';
import{recoverFreshRetainedPoolNativeQuote,type FreshRetainedPoolNativeQuote}from'./retainedPoolQuote.js';

export interface FreshDirectFlapPurchaseEvidence {
 version:1;kind:'historical_direct_flap_purchase';payment:FreshDirectFlapPurchase;
 conversion:FreshHistoricalNativeQuoteEvidence|FreshHistoricalPoolNativeQuote;nativePriceUsd:string;amountUsd:string;
}
export interface FreshQuotePaymentEvidence {
 version:1;kind:'historical_wallet_quote_settlement';payment:FreshQuotePayment;
 conversion:FreshHistoricalPoolNativeQuote;nativePriceUsd:string;amountUsd:string;
}

export interface FreshReceiptRecoveryEvidence {
 retainedNativeQuotes?:FreshRetainedPoolNativeQuote[];
 threeXdCurvePrices?:FreshHistorical3XdCurvePrice[];
 v2BridgePrices?:{proof:FreshHistoricalV2BridgePrice;nativePriceUsd:string;priceUsd:string}[];
 registeredV3Prices?:{proof:FreshRegisteredV3HistoricalPrice;nativePriceUsd:string;priceUsd:string}[];
 directNativePrices?:{tokenAddress:string;conversion:FreshHistoricalPoolNativeQuote;nativePriceUsd:string;priceUsd:string}[];
 registeredV4Prices?:FreshRegisteredV4HistoricalPrice[];
 registeredInfinityClPrices?:FreshRegisteredInfinityClHistoricalPrice[];
 genericQuotePayments?:{payment:FreshQuotePayment;conversion:FreshHistoricalGenericNativeQuote;nativePriceUsd:string;amountUsd:string}[];
 genericCapturedPrices?:FreshHistoricalGenericCapturedPrice[];
 nativeStockAcquisitionCosts?:FreshNativeStockAcquisitionCost[];
 nativeIntermediateAcquisitionCosts?:FreshNativeIntermediateAcquisitionCost[];
 parentPoolQuotes?:FreshHistoricalParentPoolQuoteEvidence[];
 parentPoolQuoteCaptures?:FreshParentPoolCapture[];
 version:1;target:FreshPriceBlock;metadata:Record<string,unknown>;quotes:FreshHistoricalQuoteEvidence[];pools:FreshHistoricalPoolEvidence[];
 stockwaveMarkets?:FreshStockwaveHistoricalPrice[];stockQuotes?:FreshStockRawQuoteEvidence[];
 flapQuotes?:FreshFlapQuoteRecoveryEvidence[];
 flapCurveQuotes?:FreshHistoricalFlapCurveNativeQuote[];
 capturedPoolQuotes?:FreshHistoricalCapturedPoolQuote[];
 directFlapPurchases?:FreshDirectFlapPurchaseEvidence[];
 quotePayments?:FreshQuotePaymentEvidence[];
 v3QuotePayments?:FreshQuotePaymentV3Evidence[];
 nativeQuoteChanges?:FreshNativeQuoteChangeValue[];
 nativeStockQuoteChanges?:FreshNativeStockQuoteChangeValue[];
 signedBatchPurchases?:FreshSignedBatchPurchaseValue[];
}
const targetOf=(b:any):FreshPriceBlock=>({number:Number(b.block_number),hash:b.block_hash,timestamp:new Date(b.occurred_at).toISOString()});
const stableQuoteProof=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
/** Ingestion/repair only. Ordinary API reads never instantiate this adapter.
 * Each derived observation retains its real source/anchor and is bounded by
 * the same 72-hour receipt lifetime. No current token row supplies old costs. */
export function createFreshReceiptRecovery(db:Pool,rpc:Rpc,entry:FreshCapturedReceipt,target:FreshPriceBlock,options:{state?:()=>FreshStateReadEvidence|undefined;batch?:FreshRecoveryBatch}={}){
 const approvedAcquisitionCosts=new Map<string,FreshNativeStockAcquisitionCost|FreshNativeIntermediateAcquisitionCost>();
 const acquisitionCost=(token:string,wallet:string)=>{const p=approvedAcquisitionCosts.get(token+':'+wallet);return p?compactFreshAcquisitionCost(p):null;};
 const prior=entry.recoveryEvidence;
 const validPrior=prior?.version===1&&stableQuoteProof(prior.target)===stableQuoteProof(target)&&Buffer.byteLength(JSON.stringify(prior))<=256*1024?prior:undefined;
 const evidence:FreshReceiptRecoveryEvidence={version:1,target:{...target},v3QuotePayments:validPrior&&Array.isArray(validPrior.v3QuotePayments)&&validPrior.v3QuotePayments.length<=4?[...validPrior.v3QuotePayments]:[],nativeStockAcquisitionCosts:validPrior&&Array.isArray(validPrior.nativeStockAcquisitionCosts)&&validPrior.nativeStockAcquisitionCosts.length<=4?[...validPrior.nativeStockAcquisitionCosts]:[],parentPoolQuoteCaptures:validPrior&&Array.isArray(validPrior.parentPoolQuoteCaptures)&&validPrior.parentPoolQuoteCaptures.length<=4?[...validPrior.parentPoolQuoteCaptures]:[],parentPoolQuotes:validPrior&&Array.isArray(validPrior.parentPoolQuotes)&&validPrior.parentPoolQuotes.length<=4?[...validPrior.parentPoolQuotes]:[],metadata:{},quotes:[],pools:[],stockwaveMarkets:[],stockQuotes:[],flapQuotes:[],flapCurveQuotes:[],capturedPoolQuotes:[],directFlapPurchases:[],quotePayments:[],nativeQuoteChanges:[],nativeStockQuoteChanges:[],signedBatchPurchases:[]};
 evidence.genericQuotePayments=validPrior&&Array.isArray(validPrior.genericQuotePayments)&&validPrior.genericQuotePayments.length<=4?[...validPrior.genericQuotePayments]:[];
 evidence.genericCapturedPrices=validPrior&&Array.isArray(validPrior.genericCapturedPrices)&&validPrior.genericCapturedPrices.length<=4?[...validPrior.genericCapturedPrices]:[];
 evidence.nativeIntermediateAcquisitionCosts=validPrior&&Array.isArray(validPrior.nativeIntermediateAcquisitionCosts)&&validPrior.nativeIntermediateAcquisitionCosts.length<=4?[...validPrior.nativeIntermediateAcquisitionCosts]:[];
 evidence.registeredV4Prices=[];
 evidence.registeredInfinityClPrices=[];
 evidence.directNativePrices=[];
 evidence.v2BridgePrices=[];
 evidence.registeredV3Prices=[];
 evidence.threeXdCurvePrices=[];
 evidence.retainedNativeQuotes=validPrior&&Array.isArray(validPrior.retainedNativeQuotes)&&validPrior.retainedNativeQuotes.length<=4?[...validPrior.retainedNativeQuotes]:[];
 type Source={entry:FreshCapturedReceipt;payload:Buffer;block:FreshPriceBlock};
 const batch=options.batch??createFreshRecoveryBatch(db,rpc);
 const hashCache=new Map<number,Promise<string|null>>(),sources=new Map<string,Promise<Source[]>>();
 let anchorWork:Promise<FreshPriceBlock>|undefined;
 const anchor=()=>anchorWork??=(async()=>{const row=(await db.query("SELECT b.* FROM fresh.checkpoints c JOIN fresh.recent_blocks b USING(block_number,block_hash) WHERE c.key='capture'")).rows[0];
  if(!row)throw Error('recovery_anchor_unavailable');const b=targetOf(row);if(b.number<target.number||Date.now()-Date.parse(b.timestamp)>30000)throw Error('recovery_anchor_stale');return b;})();
 const canonicalHash=(number:number)=>{let work=hashCache.get(number);if(!work){work=db.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[number]).then(r=>r.rows[0]?.block_hash??null);hashCache.set(number,work);}return work;};
 const imported=createFreshImportedMetadataRecovery({canonicalHash:async number=>(await db.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[number])).rows[0]?.block_hash??null});
 const templates=createFreshTemplateMetadataRecovery(db,rpc,batch,{target,entry,anchor,canonicalHash});
 const pinnedClones=createFreshPinnedCloneMetadataRecovery(db,rpc,batch,{target,entry,anchor,canonicalHash});
 const findSources=(token:string):Promise<Source[]>=>{let work=sources.get(token);if(!work){work=batch.sources(token,target);sources.set(token,work);}return work;};
 const metadataValues=new Map<string,FreshTokenMetadata>();
 const importedMetadata=async(token:string):Promise<FreshTokenMetadata|null>=>{
  const priorMetadata=validPrior?.metadata[token];
  const priorImported=priorMetadata&&typeof priorMetadata==='object'&&(priorMetadata as {kind?:unknown}).kind==='imported_pinned_token_metadata'?priorMetadata:undefined;
  const result=await imported.metadata(token,target,priorImported);if(!result)return null;
  // A separately retained exact-block read must agree. Missing optional raw
  // reads are not synthesized from the typed observation.
  const retained=options.state?.()??entry.stateEvidence;
  if(retained&&!freshImportedMetadataMatchesState(result.value,retained))return null;
  if(retained){try{
   const saved=createFreshStateEvidenceRpc(async()=>{throw Error('retained_identity_missing');},target,retained);
   const identity=await freshTokenMetadata(token,{rpc:saved.rpc,block:target,requireSupply:false});
   result.value={...result.value,name:identity.name,symbol:identity.symbol};
  }catch{/* Optional identity has no authority over this distinct scalar proof. */}}
  metadataValues.set(token,result.value);evidence.metadata[token]=result.proof;return result.value;
 };
 const metadata=async(token:string):Promise<FreshTokenMetadata|null>=>{
  if(metadataValues.has(token))return metadataValues.get(token)!;
  const retained=options.state?.()??entry.stateEvidence;
  if(retained){
   const saved=createFreshStateEvidenceRpc(async()=>{throw Error('retained_state_missing');},target,retained);
   try{const value=await freshTokenMetadata(token,{rpc:saved.rpc,block:target,requireSupply:false});
    metadataValues.set(token,value);evidence.metadata[token]={kind:'retained_target_metadata',blockNumber:target.number,blockHash:target.hash,decimals:value.decimals};return value;
   }catch{/* Only exact saved state can satisfy this path. */}
  }
  const fromImport=await importedMetadata(token);if(fromImport)return fromImport;
  // The two narrow production verifiers are loaded only after an actual
  // historical-state failure. Unknown code never inherits a guessed precision.
  const fact=(await db.query('SELECT * FROM fresh.launch_facts WHERE token_address=$1',[token])).rows[0];
  if(!fact||fact.status!=='eligible'||Number(fact.block_number)>target.number)return null;
  const factory=await import('./factoryLaunch.js');
  const fromFactory=factory.freshStockwaveMetadataFromFact(fact,target);
  if(fromFactory){metadataValues.set(token,fromFactory);evidence.metadata[token]={kind:'authenticated_factory_constant_precision',creationBlock:Number(fact.block_number),creationHash:fact.block_hash,initcodeHash:fact.proof.initcodeHash};return fromFactory;}
  const fromPinned=await pinnedClones.metadata(token,fact).catch(()=>null);if(fromPinned){metadataValues.set(token,fromPinned.value);evidence.metadata[token]=fromPinned.proof;return fromPinned.value;}
  // Reuse existing same-token raw proof before discovering another clone's
  // initializer. Valid retained metadata must not trigger additional log scans.
  const fromEarlier=await(async():Promise<FreshTokenMetadata|null>=>{
  if(fact.protocol!=='evm_creation'||fact.proof?.creation!=='top_level')return null;
  const earlier=await findSources(token);if(!earlier.length)return null;
  const creationBlock=await batch.memo(`creation-block:${fact.block_number}:${fact.block_hash}`,()=>rpc<FreshBlock>('eth_getBlockByNumber',[blockHex(fact.block_number),true]));validateFreshBlock(creationBlock,Number(fact.block_number));
  if(creationBlock.hash.toLowerCase()!==fact.block_hash||await canonicalHash(Number(fact.block_number))!==fact.block_hash)return null;
  const transaction=creationBlock.transactions.find(tx=>tx.hash.toLowerCase()===fact.tx_hash);if(!transaction)return null;
  const receipt=await batch.memo(`creation-receipt:${transaction.hash}:${fact.block_hash}`,()=>rpc<FreshReceipt>('eth_getTransactionReceipt',[transaction.hash]));validateFreshReceipt(receipt,transaction,creationBlock);
  const {recoverFreshImmutableDecimals,FRESH_INITIALIZED_DECIMALS_AUDIT}=await import('./metadataRecovery.js');
  const implementationAddress=FRESH_INITIALIZED_DECIMALS_AUDIT.implementationAddress;
  const current=await anchor();if(await canonicalHash(current.number)!==current.hash)return null;
  const code=await batch.memo(`immutable-implementation:${implementationAddress}:${current.hash}`,()=>rpc<string>('eth_getCode',[implementationAddress,{blockHash:current.hash,requireCanonical:true}]));
  const chainId=Number(BigInt(await batch.memo('chain-id',()=>rpc<string>('eth_chainId',[]))));
  for(const source of earlier){const recovered=recoverFreshImmutableDecimals({chainId,tokenAddress:token,target,creation:{transaction,receipt,block:creationBlock},source:{payload:source.payload,block:source.block},implementation:{address:implementationAddress,code,block:current}});
   if(!recovered)continue;const value:FreshTokenMetadata={address:token,name:null,symbol:null,decimals:recovered.decimals,supplyRaw:null,block:target};
   evidence.metadata[token]=recovered.proof;metadataValues.set(token,value);return value;}
  return null;
  })();
  if(fromEarlier)return fromEarlier;
  const fromTemplate=await templates.metadata(token,fact).catch(()=>null);
  if(fromTemplate){metadataValues.set(token,fromTemplate.value);evidence.metadata[token]=fromTemplate.proof;return fromTemplate.value;}
  return null;
 };
 const quoteValues=new Map<string,Promise<string|null>>();
 const priceUsd=(token:string):Promise<string|null>=>{let work=quoteValues.get(token);if(!work){work=(async()=>{
  if(TRUSTED_QUOTE_FEEDS[token]){
   if(!validPrior?.quotes.find(p=>p.tokenAddress===token)){const retained=options.state?.()??entry.stateEvidence;if(retained){try{const saved=createFreshStateEvidenceRpc(async()=>{throw Error('retained_feed_missing');},target,retained);return await freshQuoteUsd(token,{rpc:saved.rpc,block:target});}catch{/* Existing bracketed oracle recovery remains available. */}}}
   const old=validPrior?.quotes.find(p=>p.tokenAddress===token);let current=old?.anchor??await anchor();
   if(await canonicalHash(current.number)!==current.hash)throw Error('recovery_quote_noncanonical');
   const proof=await recoverFreshHistoricalQuote({rpc,tokenAddress:token,target,anchor:current,prior:old});evidence.quotes.push(proof);return proof.priceUsd;
  }
  const precision=await metadata(token);if(!precision)return null;
  const retainedFlap=validPrior?.genericCapturedPrices?.find(p=>p.tokenAddress===token
   &&p.conversion.kind==='historical_registered_quote_native_v3_bridge'&&p.conversion.capturedFlapAuthorization);
  // A saved scoped curve mark must revalidate its original block and both
  // historical conversion legs before reuse. Do not probe a different route
  // or replace this proof with current state when its source is invalid.
  // Older existing curve/pool proofs retain their established priority.
  if(retainedFlap&&!validPrior?.flapCurveQuotes?.some(p=>p.tokenAddress===token)
   &&!validPrior?.flapQuotes?.some(p=>p.tokenAddress===token)&&!validPrior?.capturedPoolQuotes?.some(p=>p.tokenAddress===token)){
   try{const source=options.state?.()??entry.stateEvidence;if(!source)return null;
    const proof=await recoverFreshHistoricalGenericCapturedPrice({rpc,tokenAddress:token,target,source,verifiedMetadata:precision,
     anchor:retainedFlap.conversion.quote.anchor,canonicalHash,prior:retainedFlap}),nativeUsd=await priceUsd(WBNB);
    if(nativeUsd===null)return null;const next=[...evidence.genericCapturedPrices!.filter(p=>p.tokenAddress!==token),proof];
    if(next.length>4||Buffer.byteLength(JSON.stringify({...evidence,genericCapturedPrices:next}))>256*1024)return null;
    evidence.genericCapturedPrices=next;return new MarketDecimal(BigInt(proof.rawNativeRatio.numerator)*10n**BigInt(precision.decimals),
     BigInt(proof.rawNativeRatio.denominator)*10n**18n).mul(MarketDecimal.parse(nativeUsd)).text();
   }catch{return null;}
  }
  const fact=(await db.query('SELECT * FROM fresh.launch_facts WHERE token_address=$1',[token])).rows[0];
  const retainedNative=validPrior?.retainedNativeQuotes?.find(p=>p.quoteAddress===token);
  if(retainedNative)try{
   const conversion=await recoverFreshRetainedPoolNativeQuote({rpc,quoteAddress:token,target,canonicalHash,source:options.state?.()??entry.stateEvidence,prior:retainedNative});
   const nativeUsd=await priceUsd(WBNB);if(nativeUsd!==null)return new MarketDecimal(BigInt(conversion.nativeRaw)*10n**BigInt(precision.decimals),BigInt(conversion.quoteRaw)*10n**18n).mul(MarketDecimal.parse(nativeUsd)).text();
  }catch{/* Foreign, empty or contradictory retained state cannot approve a mark. */}
  if(fact?.protocol==='flap'&&fact.status==='eligible'&&Number(fact.block_number)<=target.number){
   const source=options.state?.()??entry.stateEvidence;
   if(source){
    try{const old=validPrior?.flapCurveQuotes?.find(p=>p.tokenAddress===token);
     const proof=await recoverFreshHistoricalFlapCurveQuote({rpc,tokenAddress:token,verifiedMetadata:precision,source,target,
      anchor:old?.v3Conversion?.anchor??old?.conversion?.code.block??validPrior?.retainedNativeQuotes?.[0]?.target??await anchor(),canonicalHash,prior:old,retainedNativeQuotes:validPrior?.retainedNativeQuotes});
     const nativeUsd=await priceUsd(WBNB);if(nativeUsd===null)return null;
     const raw=proof.rawNativeRatio,priceNative=new MarketDecimal(BigInt(raw.numerator)*10n**BigInt(precision.decimals),BigInt(raw.denominator)*10n**18n);
     evidence.flapCurveQuotes!.push(proof);return priceNative.mul(MarketDecimal.parse(nativeUsd)).text();
    }catch{/* Another authenticated raw route may cover this exact captured curve. */}
    try{const old=validPrior?.flapQuotes?.find(p=>p.tokenAddress===token);
     const proof=await recoverFreshFlapQuote({rpc,tokenAddress:token,metadata:precision,source,target,anchor:old?.code.block??await anchor(),canonicalHash,prior:old});
     const nativeUsd=await priceUsd(WBNB);if(nativeUsd===null)return null;
     const raw=proof.rawNativeRatio,priceNative=new MarketDecimal(BigInt(raw.numerator)*10n**BigInt(precision.decimals),BigInt(raw.denominator)*10n**18n);
     evidence.flapQuotes!.push(proof);return priceNative.mul(MarketDecimal.parse(nativeUsd)).text();
    }catch{/* Unsupported or inconsistent curves never inherit an assumed quote peg. */}
   }
  }
  if(fact?.protocol==='stockwave'){
   const identity=fact.proof?.market;
   if(!validFreshStockwaveMarketIdentity(identity)||identity.tokenAddress!==token||identity.quoteAddress!==FRESH_STOCK_QUOTE_TOKEN)return null;
   const market=await historicalFreshStockwavePrice({rpc,identity,tokenDecimals:precision.decimals,target,canonicalHash,
    prior:validPrior?.stockwaveMarkets?.find(p=>p.identity.tokenAddress===token)});
   const conversion=await recoverFreshStockRawQuote({rpc,target,canonicalHash,prior:validPrior?.stockQuotes?.find(p=>p.quoteToken===identity.quoteAddress)});
   const nativeUsd=await priceUsd(WBNB);if(nativeUsd===null)return null;
   // NVDARaw cancels. Only independently proven token and WBNB precision is
   // used; no mutable stock-token decimals or current price supplies old cost.
   const raw=market.rawQuoteRatio;
   const nativePerToken=new MarketDecimal(BigInt(raw.numerator)*BigInt(conversion.nativeRaw)*10n**BigInt(precision.decimals),
    BigInt(raw.denominator)*BigInt(conversion.quoteRaw)*10n**18n);
   evidence.stockwaveMarkets!.push(market);evidence.stockQuotes!.push(conversion);
   evidence.metadata[token]={...(evidence.metadata[token] as Record<string,unknown>??{}),valuationBasis:'pool_state_with_recent_settled_reference',
    conversionObservedAt:conversion.source.timestamp,conversionAgeSeconds:(Date.parse(target.timestamp)-Date.parse(conversion.source.timestamp))/1000};
   return nativePerToken.mul(MarketDecimal.parse(nativeUsd)).text();
  }
  const captured=options.state?.()??entry.stateEvidence;
  // Exact-block native curve observations are captured urgently or imported
  // as a finite historical repair. They are re-authenticated here; a current
  // reserve or an unrelated nearby trade can never become an old mark.
  const curvePrior=validPrior?.threeXdCurvePrices?.find(p=>p.tokenAddress===token);
  if(curvePrior)try{
   const proof=await recoverFreshHistorical3XdCurvePrice({rpc,tokenAddress:token,poolAddress:curvePrior.poolAddress,target,verifiedMetadata:precision,canonicalHash,source:captured,prior:curvePrior});
   const next=[...evidence.threeXdCurvePrices!.filter(p=>p.tokenAddress!==token),proof];if(next.length<=4&&Buffer.byteLength(JSON.stringify({...evidence,threeXdCurvePrices:next}))<=256*1024){evidence.threeXdCurvePrices=next;const usd=await priceUsd(WBNB);if(usd!==null){const price=MarketDecimal.parse(proof.priceNative).mul(MarketDecimal.parse(usd)).text();if(MarketDecimal.parse(price).n>0n)return price;}}
  }catch{/* Unsupported, graduated, orphaned or conflicting native curves remain explicit. */}
  // Registered markets are independently authenticated during capture. Their
  // current price/status never supplies an earlier transfer's historical mark.
  if(fact?.status==='eligible')try{
   const context=(await db.query("SELECT s.block_number AS start_number,s.block_hash AS start_hash,c.block_number AS capture_number,c.revision FROM fresh.checkpoints s CROSS JOIN fresh.checkpoints c WHERE s.key='start' AND c.key='capture'")).rows[0];
   // The registry digest was issued from PostgreSQL JSON, preserving its
   // numeric/timestamp representation rather than the pg driver row types.
   const launch=(await db.query("SELECT to_jsonb(lf) AS fact FROM fresh.launch_facts lf WHERE token_address=$1 AND status='eligible'",[token])).rows[0]?.fact;
   const markets=(await db.query("SELECT identity FROM fresh.markets WHERE token_address=$1 AND protocol IN('uniswap_v4','infinity_cl') ORDER BY id LIMIT 8",[token])).rows;
   const candidates:{proof:FreshRegisteredV4HistoricalPrice|FreshRegisteredInfinityClHistoricalPrice;liquidity:MarketDecimal}[]=[];
   if(context&&launch)for(const row of markets){const identity=row.identity?.market??row.identity;if(row.identity?.canonicalIdentityInvalid===true)continue;try{
    const common={rpc,tokenAddress:token,target,verifiedMetadata:precision,identity,launchFact:launch,boundary:{number:Number(context.start_number),hash:context.start_hash},captureRevision:String(context.revision),captureNumber:Number(context.capture_number),canonicalHash};
    let proof:FreshRegisteredV4HistoricalPrice|FreshRegisteredInfinityClHistoricalPrice;
    if(validFreshInfinityClMarketIdentity(identity)){const old=validPrior?.registeredInfinityClPrices?.find(p=>p.tokenAddress===token&&p.identity.poolId===identity.poolId);proof=await recoverFreshRegisteredInfinityClPrice({...common,prior:old});}
    else{const old=validPrior?.registeredV4Prices?.find(p=>p.tokenAddress===token&&p.identity.poolId===identity?.poolId);proof=await recoverFreshRegisteredV4Price({...common,anchor:old?.conversion?.kind==='historical_raw_pool_trusted_v3'?old.conversion.anchor:old?.conversion?.quote.anchor??await anchor(),source:captured,prior:old});}
    candidates.push({proof,liquidity:MarketDecimal.parse(proof.quoteLiquidityNative)});
   }catch{/* Incomplete, future, orphaned or empty markets cannot approve a mark. */}}
   candidates.sort((a,b)=>b.liquidity.compare(a.liquidity));
   if(candidates.length){const proof=candidates[0].proof,nativeUsd=await priceUsd(WBNB);if(nativeUsd!==null){
    if(proof.kind==='historical_registered_infinity_cl_native_price'){const next=[...evidence.registeredInfinityClPrices!.filter(p=>p.tokenAddress!==token),proof];if(next.length<=4&&Buffer.byteLength(JSON.stringify({...evidence,registeredInfinityClPrices:next}))<=256*1024){evidence.registeredInfinityClPrices=next;const raw=proof.rawNativeRatio;return new MarketDecimal(BigInt(raw.numerator)*10n**BigInt(precision.decimals),BigInt(raw.denominator)*10n**18n).mul(MarketDecimal.parse(nativeUsd)).text();}}
    else{const next=[...evidence.registeredV4Prices!.filter(p=>p.tokenAddress!==token),proof];if(next.length<=4&&Buffer.byteLength(JSON.stringify({...evidence,registeredV4Prices:next}))<=256*1024){evidence.registeredV4Prices=next;return MarketDecimal.parse(proof.priceNative).mul(MarketDecimal.parse(nativeUsd)).text();}}
   }}
  }catch{/* Missing canonical registry context remains explicit. */}
  if(fact?.status==='eligible')try{
   const markets=(await db.query("SELECT id,protocol,identity FROM fresh.markets WHERE token_address=$1 AND protocol='pcs_v3' ORDER BY id LIMIT 4",[token])).rows;
   for(const market of markets){try{
    const old=validPrior?.registeredV3Prices?.find(p=>p.proof.tokenAddress===token&&p.proof.market.id===market.id),proof=await recoverFreshRegisteredV3Price({rpc,tokenAddress:token,target,verifiedMetadata:precision,market,anchor:old?.proof.conversion.anchor??await anchor(),canonicalHash,prior:old?.proof}),nativeUsd=await priceUsd(WBNB);if(nativeUsd===null)continue;
    const price=MarketDecimal.parse(proof.priceNative).mul(MarketDecimal.parse(nativeUsd)).text();if(MarketDecimal.parse(price).n<=0n)continue;
    const next=[...evidence.registeredV3Prices!.filter(p=>p.proof.tokenAddress!==token),{proof,nativePriceUsd:nativeUsd,priceUsd:price}];if(next.length>4||Buffer.byteLength(JSON.stringify({...evidence,registeredV3Prices:next}))>256*1024)continue;
    evidence.registeredV3Prices=next;return price;
   }catch{/* An orphaned, future, empty or unsupported registered pool cannot approve a mark. */}}
  }catch{/* Registry discovery is optional; canonical market proof remains mandatory. */}
  if(captured){try{
   const old=validPrior?.capturedPoolQuotes?.find(p=>p.tokenAddress===token);
   const proof=await recoverFreshHistoricalCapturedPoolQuote({rpc,tokenAddress:token,verifiedMetadata:precision,source:captured,target,
    anchor:old?.code.block??await anchor(),canonicalHash,prior:old,retainedNativeQuotes:validPrior?.retainedNativeQuotes});
   const nativeUsd=await priceUsd(WBNB);if(nativeUsd===null)return null;
   const raw=proof.rawNativeRatio,priceNative=new MarketDecimal(BigInt(raw.numerator)*10n**BigInt(precision.decimals),BigInt(raw.denominator)*10n**18n);
   evidence.capturedPoolQuotes!.push(proof);return priceNative.mul(MarketDecimal.parse(nativeUsd)).text();
  }catch{/* A complete earlier original pool observation may still cover the target. */}}
  if(captured){try{const old=validPrior?.genericCapturedPrices?.find(p=>p.tokenAddress===token),proof=await recoverFreshHistoricalGenericCapturedPrice({rpc,tokenAddress:token,target,source:captured,verifiedMetadata:precision,anchor:old?.conversion.quote.anchor??await anchor(),canonicalHash,prior:old}),nativeUsd=await priceUsd(WBNB);if(nativeUsd!==null){const next=[...evidence.genericCapturedPrices!.filter(p=>p.tokenAddress!==token),proof];if(next.length<=4&&Buffer.byteLength(JSON.stringify({...evidence,genericCapturedPrices:next}))<=256*1024){evidence.genericCapturedPrices=next;return new MarketDecimal(BigInt(proof.rawNativeRatio.numerator)*10n**BigInt(precision.decimals),BigInt(proof.rawNativeRatio.denominator)*10n**18n).mul(MarketDecimal.parse(nativeUsd)).text();}}}catch{/* New quote routes require complete dated bridge evidence. */}}
  const earlier=await findSources(token);
  for(const source of earlier){const seed=source.entry.stateEvidence;if(!seed||target.number-seed.blockNumber>4096)continue;
   try{const old=validPrior?.pools.find(p=>p.tokenAddress===token&&p.source.blockNumber===seed.blockNumber&&p.source.blockHash===seed.blockHash);
    const proof=await recoverFreshHistoricalPool({rpc,tokenAddress:token,tokenDecimals:precision.decimals,target,source:seed,canonicalHash,prior:old});
    const usd=await priceUsd(proof.quoteAddress);if(usd===null)return null;evidence.pools.push(proof);return MarketDecimal.parse(proof.priceQuote).mul(MarketDecimal.parse(usd)).text();
   }catch{/* Another earlier authentic seed may cover this pool. No current-price fallback. */}
  }
  // Exact eligible token/native PCS V2 markets need no captured state seed.
  // The existing immutable-pool verifier reads genuine canonical block-end
  // Sync evidence; independently recovered precision and dated BNB/USD give
  // a transfer mark, never a substitute for the transaction's settled cost.
  if(fact?.status==='eligible'&&fact.protocol==='evm_creation'&&Number(fact.block_number)<=target.number){try{
   const old=validPrior?.directNativePrices?.find(p=>p.tokenAddress===token);
   const conversion=await recoverFreshHistoricalPoolNativeQuote({rpc,quoteAddress:token,target,transactionIndex:0,observation:'block_end',anchor:old?.conversion.code.block??await anchor(),canonicalHash,prior:old?.conversion});
   const nativeUsd=await priceUsd(WBNB);if(nativeUsd===null)return null;
   const price=new MarketDecimal(BigInt(conversion.nativeRaw)*10n**BigInt(precision.decimals),BigInt(conversion.quoteRaw)*10n**18n).mul(MarketDecimal.parse(nativeUsd)).text();
   const proof={tokenAddress:token,conversion,nativePriceUsd:nativeUsd,priceUsd:price};
   if(old&&JSON.stringify(old)!==JSON.stringify(proof))return null;
   const next=[...evidence.directNativePrices!.filter(p=>p.tokenAddress!==token),proof];if(next.length>4||Buffer.byteLength(JSON.stringify({...evidence,directNativePrices:next}))>256*1024)return null;
   evidence.directNativePrices=next;return price;
  }catch{/* Missing, empty or contradictory canonical markets remain unknown. */}}
  if(fact?.status==='eligible'&&fact.protocol==='evm_creation'&&Number(fact.block_number)<=target.number)try{
   const previous=validPrior?.v2BridgePrices?.find(p=>p.proof.tokenAddress===token),hints=previous?[previous.proof.quoteAddress]:await findFreshV2BridgeQuoteHints(db,token,entry);
   const candidates:{proof:FreshHistoricalV2BridgePrice;nativeUsd:string;price:string;liquidity:MarketDecimal}[]=[];
   for(const quote of hints){try{const proof=await recoverFreshHistoricalV2BridgePrice({rpc,tokenAddress:token,quoteAddress:quote,target,anchor:previous?.proof.market.code.block??await anchor(),verifiedMetadata:precision,canonicalHash,prior:previous?.proof}),nativeUsd=await priceUsd(WBNB);if(nativeUsd===null)continue;
    const price=MarketDecimal.parse(proof.priceNative).mul(MarketDecimal.parse(nativeUsd)).text();if(MarketDecimal.parse(price).n<=0n)continue;
    const liquidity=new MarketDecimal(BigInt(proof.market.quoteRaw)*BigInt(proof.conversion.quoteRaw),BigInt(proof.conversion.baseRaw));candidates.push({proof,nativeUsd,price,liquidity});
   }catch{/* A quote hint never substitutes for genuine historical liquidity. */}}
   candidates.sort((a,b)=>b.liquidity.compare(a.liquidity));if(candidates.length){const selected=candidates[0],next=[...evidence.v2BridgePrices!.filter(p=>p.proof.tokenAddress!==token),{proof:selected.proof,nativePriceUsd:selected.nativeUsd,priceUsd:selected.price}];if(next.length<=4&&Buffer.byteLength(JSON.stringify({...evidence,v2BridgePrices:next}))<=256*1024){evidence.v2BridgePrices=next;return selected.price;}}
  }catch{/* Missing original routes or historical pool states remain explicit. */}
  return null;
 })().catch(()=>null);quoteValues.set(token,work);}return work;};
 const additionalNativeFeeWei=async(token:string):Promise<bigint|null>=>{
  if(entry.transaction.to?.toLowerCase()!==token||typeof entry.transaction.input!=='string'||!entry.transaction.input.toLowerCase().startsWith('0xc7c7f5b3'))return 0n;
  const fact=(await db.query('SELECT * FROM fresh.launch_facts WHERE token_address=$1',[token])).rows[0];
  if(fact?.protocol!=='stockwave')return 0n;
  const factory=await import('./factoryLaunch.js');if(!factory.freshStockwaveMetadataFromFact(fact,target))return null;
  const fee=freshStockwaveBridgeFee(entry,token);
  if(fee!==null)evidence.metadata[token]={...(evidence.metadata[token] as Record<string,unknown>??{}),bridgeNativeFee:{kind:'layerzero_receipt_worker_fees',nativeFeeWei:String(fee),transactionHash:entry.transaction.hash}};
  return fee;
 };
 const airdropBasis=async(event:FreshFinancialEvent,precision:FreshTokenMetadata,loadTrace:()=>Promise<FreshCallTrace|null>):Promise<FreshAirdropBasis|null>=>{
  if(event.kind!=='transfer_in'||!freshVerifiedAirdropClaimCandidate(entry)||event.blockNumber!==String(target.number)||event.blockHash!==target.hash||event.transactionHash!==entry.transaction.hash
   ||event.tokenAddress!==precision.address||precision.block.number!==target.number||precision.block.hash!==target.hash||await canonicalHash(target.number)!==target.hash)return null;
  const trace=entry.trace??await loadTrace();if(!trace)return null;
  // Membership and internal-transfer treatment belong to each accounting
  // scope. A shared positive claim proof never replaces its carried FIFO lots.
  const proofEntry:FreshCapturedReceipt={...entry,trace,...((options.state?.()??entry.stateEvidence)?{stateEvidence:options.state?.()??entry.stateEvidence}:{}),recoveryEvidence:evidence};
  return recoverFreshVerifiedAirdropBasis({entry:proofEntry,event,metadata:precision});
 };
 const directFlapPurchaseUsd=async(token:string,wallet:string,receivedRaw:bigint,nativePriceUsd:string|null,traceLoader?:()=>Promise<FreshCallTrace|null>):Promise<string|null>=>{
  const payment=freshDirectFlapPurchase(entry,target,token,wallet,receivedRaw);
  if(!payment||nativePriceUsd===null)return null;
  // Retain bounded same-envelope raw proofs across temporary processing failures.
  // They authorize nothing until the complete per-use validator succeeds.
  const parentProofs=evidence.parentPoolQuotes!.filter(value=>value&&typeof value==='object'&&value.version===1&&value.kind==='historical_raw_pool_native_v2_parent_state'&&value.quoteAddress===payment.quoteAddress&&value.transactionIndex===payment.transactionIndex&&value.target?.number===target.number&&value.target?.hash===target.hash);
  if(parentProofs.length){try{
   if(parentProofs.length!==1)return null;
   const header=(await db.query('SELECT parent_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1 AND block_hash=$2',[target.number,target.hash])).rows[0];
   if(!header||new Date(header.occurred_at).toISOString()!==target.timestamp)return null;
   const canonical=async(number:number)=>(await db.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[number])).rows[0]?.block_hash??null;
   const value=await valueFreshParentFlapPurchase(parentProofs[0],entry,{target:{...target,parentHash:header.parent_hash},transactionIndex:payment.transactionIndex,quoteAddress:payment.quoteAddress,canonicalHash:canonical},token,receivedRaw);
   if(MarketDecimal.parse(value.nativePriceUsd).compare(MarketDecimal.parse(nativePriceUsd))!==0)return null;
   return value.amountUsd;
  }catch{return null;}}
  try{
   const native=MarketDecimal.parse(nativePriceUsd);if(native.n<=0n)return null;
   const old=validPrior?.directFlapPurchases?.find(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet);
   const args={rpc,target,transactionIndex:payment.transactionIndex,anchor:old?.conversion.code.block??await anchor(),canonicalHash};
   const conversion=payment.quoteAddress===FRESH_BTCB_QUOTE&&old?.conversion.kind!=='historical_raw_pool_native_v2'
    ?await recoverFreshHistoricalNativeQuote({...args,prior:old?.conversion as FreshHistoricalNativeQuoteEvidence|undefined})
    :await recoverFreshHistoricalPoolNativeQuote({...args,quoteAddress:payment.quoteAddress,prior:old?.conversion as FreshHistoricalPoolNativeQuote|undefined});
   const amountUsd=new MarketDecimal(BigInt(payment.quoteRaw)*BigInt(conversion.nativeRaw),BigInt(conversion.quoteRaw)*10n**18n).mul(native).text();
   const proof:FreshDirectFlapPurchaseEvidence={version:1,kind:'historical_direct_flap_purchase',payment,conversion,nativePriceUsd,amountUsd};
   const stable=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
   if(old&&stable(old)!==stable(proof))return null;
   evidence.directFlapPurchases!.push(proof);return amountUsd;
  }catch(error){
   if(!(error instanceof Error)||error.message!=='flap_quote_sync_unavailable')return null;
   try{
    const headers=(await db.query('SELECT block_number,block_hash,parent_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=ANY($1::bigint[]) ORDER BY block_number',[[target.number-1,target.number]])).rows;
    if(headers.length!==2||headers[1].block_hash!==target.hash)return null;
    const asHeader=(row:any)=>({number:Number(row.block_number),hash:row.block_hash,parentHash:row.parent_hash,timestamp:new Date(row.occurred_at).toISOString()}),parent=asHeader(headers[0]),targetHeader=asHeader(headers[1]);
    const canonical=async(number:number)=>(await db.query('SELECT block_hash FROM fresh.recent_blocks WHERE block_number=$1',[number])).rows[0]?.block_hash??null;
    const priorCaptures=evidence.parentPoolQuoteCaptures!.filter(value=>value&&value.quoteAddress===payment.quoteAddress&&value.transactionHash===entry.transaction.hash);if(priorCaptures.length>1)return null;
    let capturedTrace:FreshCallTrace|null|undefined=entry.trace;const load=async()=>capturedTrace??(capturedTrace=await traceLoader?.()??null);
    const captured=await captureFreshParentPoolQuote({entry,target:targetHeader,parent,anchor:await anchor(),token,receivedRaw,rpc,canonicalHash:canonical,trace:load,prior:priorCaptures[0],nativePriceState:options.state?.()??entry.stateEvidence});
    if(captured.capture){const next=[...evidence.parentPoolQuoteCaptures!],index=next.indexOf(priorCaptures[0]);if(index<0){if(next.length>=4)return null;next.push(captured.capture);}else next[index]=captured.capture;if(Buffer.byteLength(JSON.stringify({...evidence,parentPoolQuoteCaptures:next}))>256*1024)return null;evidence.parentPoolQuoteCaptures=next;}
    if(!captured.proof)return null;
    const valued=await valueFreshParentFlapPurchase(captured.proof,{...entry,trace:capturedTrace},{target:targetHeader,transactionIndex:payment.transactionIndex,quoteAddress:payment.quoteAddress,canonicalHash:canonical},token,receivedRaw);
    if(MarketDecimal.parse(valued.nativePriceUsd).compare(MarketDecimal.parse(nativePriceUsd))!==0)return null;
    if(!evidence.parentPoolQuotes!.some(value=>value.quoteAddress===payment.quoteAddress&&value.transactionIndex===payment.transactionIndex)){const next=[...evidence.parentPoolQuotes!,captured.proof];if(next.length>4||Buffer.byteLength(JSON.stringify({...evidence,parentPoolQuotes:next}))>256*1024)return null;evidence.parentPoolQuotes=next;}
    return valued.amountUsd;
   }catch{return null;}
  }
 };
 const quotePaymentUsd=async(token:string,wallet:string,targetRaw:bigint,nativePriceUsd:string|null,retainedOnly=false):Promise<string|null>=>{
  const old=validPrior?.quotePayments?.find(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet);
  const oldV3=validPrior?.v3QuotePayments?.find(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet);
  const oldGeneric=validPrior?.genericQuotePayments?.find(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet);
  if(retainedOnly&&!old&&!oldV3&&!oldGeneric)return null;
  const payment=freshQuotePayment(entry,target,token,wallet,targetRaw);if(!payment||nativePriceUsd===null)return null;
  const v3=async()=>{const proof=await recoverFreshQuotePaymentV3({rpc,payment,target,anchor:oldV3?.conversion.anchor??await anchor(),canonicalHash,state:options.state?.()??entry.stateEvidence,prior:oldV3});
   if(!evidence.v3QuotePayments!.some(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet)){const next=[...evidence.v3QuotePayments!,proof];if(next.length>4||Buffer.byteLength(JSON.stringify({...evidence,v3QuotePayments:next}))>256*1024)return null;evidence.v3QuotePayments=next;}return proof.amountUsd;};
  if(oldV3){try{return await v3();}catch{return null;}}
  try{
   const native=MarketDecimal.parse(nativePriceUsd);if(native.n<=0n)return null;
   const conversion=await recoverFreshHistoricalPoolNativeQuote({rpc,quoteAddress:payment.quoteAddress,target,transactionIndex:payment.transactionIndex,
    anchor:old?.conversion.code.block??await anchor(),canonicalHash,prior:old?.conversion});
   const amountUsd=new MarketDecimal(BigInt(payment.quoteRaw)*BigInt(conversion.nativeRaw),BigInt(conversion.quoteRaw)*10n**18n).mul(native).text();
   const proof:FreshQuotePaymentEvidence={version:1,kind:'historical_wallet_quote_settlement',payment,conversion,nativePriceUsd,amountUsd};
   const stable=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
   if(old&&stable(old)!==stable(proof))return null;
   if(!evidence.quotePayments!.some(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet))evidence.quotePayments!.push(proof);
   return amountUsd;
  }catch{try{return await v3();}catch{try{const conversion=await recoverFreshHistoricalGenericNativeQuote({rpc,quoteAddress:payment.quoteAddress,target,transactionIndex:payment.transactionIndex,observation:'before_execution',anchor:oldGeneric?.conversion.quote.anchor??await anchor(),canonicalHash,prior:oldGeneric?.conversion}),ratio=conversion.rawNativeRatio,amountUsd=new MarketDecimal(BigInt(payment.quoteRaw)*BigInt(ratio.numerator),BigInt(ratio.denominator)*10n**18n).mul(MarketDecimal.parse(nativePriceUsd)).text(),proof={payment,conversion,nativePriceUsd,amountUsd};if(oldGeneric&&stableQuoteProof(oldGeneric)!==stableQuoteProof(proof))return null;const next=[...evidence.genericQuotePayments!.filter(p=>p.payment.tokenAddress!==token||p.payment.walletAddress!==wallet),proof];if(next.length>4||Buffer.byteLength(JSON.stringify({...evidence,genericQuotePayments:next}))>256*1024)return null;evidence.genericQuotePayments=next;return amountUsd;}catch{return null;}}}
 };
 const nativeQuoteChangeUsd=async(token:string,wallet:string,targetRaw:bigint,nativePriceUsd:string|null,retainedOnly=false):Promise<string|null>=>{
  const old=validPrior?.nativeQuoteChanges?.find(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet);
  const oldStock=validPrior?.nativeStockQuoteChanges?.find(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet);
  const oldIntermediate=validPrior?.nativeIntermediateAcquisitionCosts?.find(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet);
  if(retainedOnly&&!old&&!oldStock&&!oldIntermediate||nativePriceUsd===null)return null;
  const stockPayment=freshNativeStockQuoteChange(entry,target,token,wallet,targetRaw);
  if(stockPayment){try{
   // Previously verified market-reference accounting remains stable. New exact
   // acquisitions can instead carry their actual input cost into spent/retained
   // quote units, without asserting an independent market valuation.
   if(!oldStock){const cost=freshNativeStockAcquisitionCost(entry,target,token,wallet,targetRaw,nativePriceUsd);if(cost){const old=evidence.nativeStockAcquisitionCosts!.find(p=>p.payment.tokenAddress===token&&p.payment.walletAddress===wallet);if(old&&JSON.stringify(old)!==JSON.stringify(cost))return null;if(!old){if(evidence.nativeStockAcquisitionCosts!.length>=4)return null;evidence.nativeStockAcquisitionCosts!.push(cost);}approvedAcquisitionCosts.set(token+':'+wallet,cost);return cost.amountUsd;}
    // A registered settlement asset can use a different signed purchase leg.
    // Keep all existing stock/market proofs first, then prove actual cash and
    // quote conservation before attempting a new historical market conversion.
    if(!old&&!validPrior?.nativeStockAcquisitionCosts?.some(p=>p.payment.tokenAddress===token&&p.payment.walletAddress===wallet)){
     const cost=freshNativeIntermediateAcquisitionCost(entry,target,token,wallet,targetRaw,nativePriceUsd);
     if(cost){if(oldIntermediate&&stableQuoteProof(oldIntermediate)!==stableQuoteProof(cost))return null;const next=[...evidence.nativeIntermediateAcquisitionCosts!.filter(p=>p.payment.tokenAddress!==token||p.payment.walletAddress!==wallet),cost];if(next.length>4||Buffer.byteLength(JSON.stringify({...evidence,nativeIntermediateAcquisitionCosts:next}))>256*1024)return null;evidence.nativeIntermediateAcquisitionCosts=next;approvedAcquisitionCosts.set(token+':'+wallet,cost);return cost.amountUsd;}
     if(oldIntermediate)return null;
    }
   }
   if(old)return null;
   const conversion=await recoverFreshStockRawQuote({rpc,target,canonicalHash,prior:oldStock?.conversion});
   const proof=valueFreshNativeStockQuoteChange(stockPayment,conversion,nativePriceUsd);if(!proof)return null;
   const stable=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
   if(oldStock&&stable(oldStock)!==stable(proof))return null;
   if(!evidence.nativeStockQuoteChanges!.some(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet))evidence.nativeStockQuoteChanges!.push(proof);
   return proof.amountUsd;
  }catch{return null;}}
  if(oldStock)return null;
  // Actual acquired/used/returned quote units allocate the original input cost.
  // This proof grants no quote identity, independent price or airdrop basis.
  if(!old){const cost=freshNativeIntermediateAcquisitionCost(entry,target,token,wallet,targetRaw,nativePriceUsd);
   if(cost){if(oldIntermediate&&JSON.stringify(oldIntermediate)!==JSON.stringify(cost))return null;
    const next=[...evidence.nativeIntermediateAcquisitionCosts!.filter(p=>p.payment.tokenAddress!==token||p.payment.walletAddress!==wallet),cost];
    if(next.length>4||Buffer.byteLength(JSON.stringify({...evidence,nativeIntermediateAcquisitionCosts:next}))>256*1024)return null;
    evidence.nativeIntermediateAcquisitionCosts=next;approvedAcquisitionCosts.set(token+':'+wallet,cost);return cost.amountUsd;}
   if(oldIntermediate)return null;
  }
  const payment=freshNativeQuoteChange(entry,target,token,wallet,targetRaw);if(!payment)return null;
  try{
   const conversion=await recoverFreshHistoricalPoolNativeQuote({rpc,quoteAddress:payment.quoteAddress,target,transactionIndex:payment.transactionIndex,
    anchor:old?.conversion.code.block??await anchor(),canonicalHash,prior:old?.conversion});
   const proof=valueFreshNativeQuoteChange(payment,conversion,nativePriceUsd);if(!proof)return null;
   const stable=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
   if(old&&stable(old)!==stable(proof))return null;
   if(!evidence.nativeQuoteChanges!.some(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet))evidence.nativeQuoteChanges!.push(proof);
   return proof.amountUsd;
  }catch{return null;}
 };
 const signedBatchPurchaseUsd=async(token:string,wallet:string,targetRaw:bigint,nativePriceUsd:string|null,trace:FreshCallTrace):Promise<string|null>=>{
  if(nativePriceUsd===null)return null;
  try{
   const old=validPrior?.signedBatchPurchases?.find(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet);
   const proof=await recoverFreshSignedBatchPurchase({entry:{...entry,trace},target,token,wallet,targetRaw,nativePriceUsd,rpc,anchor,canonicalHash,prior:old,
    canonicalBlock:async number=>{const row=(await db.query('SELECT block_number,block_hash,occurred_at FROM fresh.recent_blocks WHERE block_number=$1',[number])).rows[0];return row?targetOf(row):null;}});
   if(!proof)return null;if(!evidence.signedBatchPurchases!.some(value=>value.payment.tokenAddress===token&&value.payment.walletAddress===wallet))evidence.signedBatchPurchases!.push(proof);
   return proof.amountUsd;
  }catch{return null;}
 };
 return{acquisitionCost,airdropBasis,metadata,importedMetadata,priceUsd,additionalNativeFeeWei,directFlapPurchaseUsd,quotePaymentUsd,nativeQuoteChangeUsd,signedBatchPurchaseUsd,snapshot:()=>evidence.retainedNativeQuotes!.length||evidence.threeXdCurvePrices!.length||evidence.v2BridgePrices!.length||evidence.registeredV3Prices!.length||evidence.directNativePrices!.length||evidence.registeredInfinityClPrices!.length||evidence.registeredV4Prices!.length||evidence.genericQuotePayments!.length||evidence.genericCapturedPrices!.length||evidence.v3QuotePayments!.length||evidence.nativeStockAcquisitionCosts!.length||evidence.nativeIntermediateAcquisitionCosts!.length||evidence.parentPoolQuoteCaptures!.length||evidence.parentPoolQuotes!.length||evidence.quotes.length||evidence.pools.length||evidence.stockwaveMarkets!.length||evidence.flapQuotes!.length||evidence.flapCurveQuotes!.length||evidence.capturedPoolQuotes!.length||evidence.directFlapPurchases!.length||evidence.quotePayments!.length||evidence.nativeQuoteChanges!.length||evidence.nativeStockQuoteChanges!.length||evidence.signedBatchPurchases!.length||Object.keys(evidence.metadata).length?evidence:undefined};
}
