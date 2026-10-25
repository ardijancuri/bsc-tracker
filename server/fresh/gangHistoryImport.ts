import{createHash}from'node:crypto';
import{FreshRational,type FreshFinancialEvent}from'./accounting.js';
import{decodeFreshExecutions,normalizeFreshReceipt,type FreshDecodedReceipt}from'./decode.js';
import{validateFreshReceipt,freshInteger,type FreshCapturedReceipt,type FreshBlock}from'./capture.js';
import{createFreshStateEvidenceRpc}from'./stateEvidence.js';
import{freshQuoteUsd,freshTokenMetadata,type FreshPriceBlock,type FreshTokenMetadata}from'./pricing.js';
import{GANG_TOKEN_ADDRESS}from'./tracking.js';
import{WBNB}from'../launchpad.js';
import{transferTopic,hasRecognizedSwap}from'../swap.js';
import{recoverFreshHistoricalQuote,type FreshHistoricalQuoteEvidence}from'./historicalQuote.js';
import{validateFreshTrace,freshTraceMatchesTransaction}from'./trace.js';

export interface FreshGangHistoryActivity{walletAddress:string;pageSha256:string;observedAt:string;row:Record<string,unknown>}
export interface FreshGangHistoryProvenance{
 version:1;kind:'gmgn_historical_recovery_v1';pageSha256:string;rowSha256:string;observedAt:string;
 walletAddress:string;transactionHash:string;tokenAddress:typeof GANG_TOKEN_ADDRESS;
 fields:string[];preservedFields:string[];quantity:{raw:string;decimals:18;reported:string;quantizationUnit:string};
 derivedFx:null|{asset:string;priceUsd:string;costUsd:string;quoteAmount:string};
 providerTokenPriceUsd:string|null;oracleReferences:{asset:string;kind:'retained_block_oracle'|'historical_oracle_round';priceUsd:string;selectedRound?:string;anchor?:FreshPriceBlock}[];
 nodeFields:string[];
}
export interface FreshGangHistoryImportInput{entry:FreshCapturedReceipt;block:FreshPriceBlock;activities:readonly FreshGangHistoryActivity[];knownEvents?:readonly FreshFinancialEvent[];
 historicalQuotes?:readonly FreshHistoricalQuoteEvidence[];canonicalHeaders?:readonly FreshPriceBlock[]}
interface Matched{activity:FreshGangHistoryActivity;rowSha256:string;wallet:string;kind:FreshFinancialEvent['kind'];raw:bigint;reported:string;quantization:FreshRational;fx:{asset:string;priceUsd:string;costUsd:string;quoteAmount:string}|null;transferPrice:string|null}
const zero=new FreshRational(0n),address=/^0x[\da-f]{40}$/,hash=/^[\da-f]{64}$/;
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const digest=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
function decimal(value:unknown,positive=true){
 if(typeof value!=='string'||value.length>256||!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value))throw Error('gang_history_decimal_invalid');
 const q=FreshRational.parse(value);if(q.compare(zero)<0||positive&&q.compare(zero)===0)throw Error('gang_history_decimal_invalid');return q;
}
/** Provider decimal strings can be a rounded binary64 serialization. Bound
 * both its printed digit and one exact binary64 ULP; neither is used to round
 * the canonical Transfer integer, which is retained in every event. */
export function freshGangHistoryPrecision(raw:bigint,reported:string){
 if(raw<=0n)throw Error('gang_history_quantity_invalid');const value=decimal(reported);
 const match=/^\d+(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(reported)!;
 const scale=(match[1]?.length??0)-Number(match[2]??0);if(!Number.isSafeInteger(scale)||Math.abs(scale)>96)throw Error('gang_history_quantization_invalid');
 const digit=scale>=0?new FreshRational(1n,10n**BigInt(scale)):new FreshRational(10n**BigInt(-scale));
 // A shortened value such as "0.1" cannot admit every smaller quantity.
 // Coarse provider strings additionally require agreement within one part in
 // a trillion; this can reject imprecise data, never manufacture precision.
 const relative=value.div(new FreshRational(1_000_000_000_000n)),printed=digit.compare(relative)<0?digit:relative;
 let exponent=value.n.toString(2).length-value.d.toString(2).length;
 if(exponent>=0?value.n<value.d*(1n<<BigInt(exponent)):value.n*(1n<<BigInt(-exponent))<value.d)exponent--;
 const shift=exponent-52,ulp=shift>=0?new FreshRational(1n<<BigInt(shift)):new FreshRational(1n,1n<<BigInt(-shift));
 const unit=printed.add(ulp);
 const possible:number[]=[];for(let decimals=0;decimals<=255;decimals++){
  const delta=new FreshRational(raw,10n**BigInt(decimals)).sub(value);if(new FreshRational(delta.n<0n?-delta.n:delta.n,delta.d).compare(unit)<0)possible.push(decimals);
 }
 if(possible.length!==1||possible[0]!==18)throw Error('gang_history_precision_ambiguous');return{decimals:18 as const,quantizationUnit:unit.decimal(255)};
}
function rawFlow(entry:FreshCapturedReceipt,wallet:string){let raw=0n;for(const log of entry.receipt.logs){
 if(log.address!==GANG_TOKEN_ADDRESS||log.topics[0]!==transferTopic)continue;
 if(log.topics.length!==3||!/^0x[\da-f]{64}$/.test(log.data)||!log.topics.slice(1).every(value=>/^0x0{24}[\da-f]{40}$/.test(value)))throw Error('gang_history_transfer_invalid');
 const from='0x'+log.topics[1].slice(-40),to='0x'+log.topics[2].slice(-40);if(from!==to){if(from===wallet)raw-=BigInt(log.data);if(to===wallet)raw+=BigInt(log.data);}
 }return raw;}
function activityMatch(input:FreshGangHistoryImportInput,activity:FreshGangHistoryActivity):Matched|null{
 const{entry,block}=input,row=activity.row,wallet=activity.walletAddress,token=row.token as Record<string,unknown>|undefined;
 if(!address.test(wallet)||!hash.test(activity.pageSha256)||!Number.isFinite(Date.parse(activity.observedAt))||Date.parse(activity.observedAt)<Date.parse(block.timestamp))throw Error('gang_history_source_invalid');
 if(row.wallet!==wallet||row.chain!=='bsc'||row.tx_hash!==entry.transaction.hash||token?.address!==GANG_TOKEN_ADDRESS)return null;
 if(!entry.wallets.includes(wallet)||Number(row.timestamp)!==Math.floor(Date.parse(block.timestamp)/1000))throw Error('gang_history_identity_mismatch');
 const kind=row.event_type;if(!['buy','sell','transfer_in','transfer_out'].includes(String(kind)))return null;
 const raw=rawFlow(entry,wallet);if(raw===0n||(raw>0n)!==['buy','transfer_in'].includes(String(kind)))throw Error('gang_history_side_mismatch');
 const swap=hasRecognizedSwap(entry.receipt.logs);
 if(['buy','sell'].includes(String(kind))&&!swap||['transfer_in','transfer_out'].includes(String(kind))&&swap)throw Error('gang_history_event_type_mismatch');
 const reported=String(row.token_amount),precision=freshGangHistoryPrecision(raw<0n?-raw:raw,reported);
 let fx:Matched['fx']=null,transferPrice:string|null=null;
 if(['buy','sell'].includes(String(kind))){
  const quote=row.quote_token as Record<string,unknown>|undefined,quoteAddress=row.quote_address;
  if(typeof quoteAddress!=='string'||!address.test(quoteAddress)||quote?.token_address!==quoteAddress)throw Error('gang_history_quote_identity_invalid');
  const cost=decimal(row.cost_usd),amount=decimal(row.quote_amount);fx={asset:quoteAddress,priceUsd:cost.div(amount).decimal(),costUsd:row.cost_usd as string,quoteAmount:row.quote_amount as string};
 }else{
  const from=row.from_address,to=row.to_address;
  const exact=entry.receipt.logs.filter(log=>log.address===GANG_TOKEN_ADDRESS&&log.topics[0]===transferTopic&&'0x'+log.topics[1]?.slice(-40)===from&&'0x'+log.topics[2]?.slice(-40)===to);
  if(!address.test(String(from))||!address.test(String(to))||exact.length!==1||BigInt(exact[0].data)!==(raw<0n?-raw:raw))throw Error('gang_history_transfer_identity_mismatch');
  if(typeof row.price_usd==='string'&&row.price_usd!=='')transferPrice=decimal(row.price_usd).decimal();
 }
 return{activity,rowSha256:digest(row),wallet,kind:kind as Matched['kind'],raw,reported,quantization:FreshRational.parse(precision.quantizationUnit),fx,transferPrice};
}

/** Explicit one-time GANG recovery. Callers supply checksum-verified original
 * node capture and canonical headers, and must recheck both under their write
 * lock. No provider fetch, SQL, synthetic oracle tuple or P&L aggregate enters
 * this adapter; all events still come from the ordinary accounting normalizer. */
export async function reconcileFreshGangHistory(input:FreshGangHistoryImportInput):Promise<{decoded:FreshDecodedReceipt;provenanceByEventId:Record<string,FreshGangHistoryProvenance>;matches:number;missingWallets:string[]}>{
 const{entry,block}=input,tx=entry.transaction;
 if(input.activities.length>512||entry.wallets.length>256||!Number.isSafeInteger(block.number)||block.number<0||!Number.isFinite(Date.parse(block.timestamp))
  ||Number(freshInteger(tx.blockNumber))!==block.number||tx.blockHash!==block.hash||entry.receipt.status!=='0x1'||tx.chainId!=='0x38'
  ||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined)throw Error('gang_history_canonical_context_invalid');
 validateFreshReceipt(entry.receipt,tx,{number:tx.blockNumber,hash:block.hash,parentHash:'0x'+'0'.repeat(64),timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16),transactions:[]}as FreshBlock);
 if(entry.trace){const trace=validateFreshTrace(entry.trace);if(!freshTraceMatchesTransaction(trace,tx)||trace.input!==tx.input)throw Error('gang_history_trace_context_invalid');}
 if((input.historicalQuotes?.length??0)>8||(input.canonicalHeaders?.length??0)>16)throw Error('gang_history_oracle_bounds');
 const historicalQuotes=new Map<string,FreshHistoricalQuoteEvidence>();
 for(const proof of input.historicalQuotes??[]){
  if(stable(proof.target)!==stable(block))throw Error('gang_history_oracle_target_mismatch');
  const anchor=input.canonicalHeaders?.find(header=>header.number===proof.anchor.number);
  if(!anchor||stable(anchor)!==stable(proof.anchor))throw Error('gang_history_oracle_anchor_unverified');
  const verified=await recoverFreshHistoricalQuote({rpc:async()=>{throw Error('gang_history_oracle_read_missing');},tokenAddress:proof.tokenAddress,target:block,anchor,prior:proof});
  if(historicalQuotes.has(proof.tokenAddress))throw Error('gang_history_oracle_duplicate');historicalQuotes.set(proof.tokenAddress,verified);
 }
 const matched=new Map<string,Matched>();
 for(const activity of input.activities){const value=activityMatch(input,activity);if(!value)continue;const prior=matched.get(value.wallet);
  if(prior&&prior.rowSha256!==value.rowSha256)throw Error('gang_history_duplicate_activity_ambiguous');if(!prior)matched.set(value.wallet,value);
 }
 const missingWallets=entry.wallets.filter(wallet=>rawFlow(entry,wallet)!==0n&&!matched.has(wallet));
 if(!matched.size)throw Error('gang_history_activity_not_found');
 const executions=decodeFreshExecutions(entry);if(executions.some(execution=>matched.has(execution.wallet)&&(execution.kind==='user_operation'
  ||execution.kind==='transfer'&&['buy','sell'].includes(matched.get(execution.wallet)!.kind))))throw Error('gang_history_execution_unsupported');
 const activeEntry={...entry,wallets:entry.wallets.filter(wallet=>matched.has(wallet))};
 const saved=createFreshStateEvidenceRpc(async()=>{throw Error('gang_history_retained_state_unavailable');},block,entry.stateEvidence);
 const fxCandidates=[...matched.values()].filter(value=>value.fx?.asset===WBNB),payerFx=fxCandidates.find(value=>value.wallet===tx.from)?.fx??fxCandidates[0]?.fx??null;
 if(fxCandidates.some(value=>value.fx!.priceUsd!==payerFx?.priceUsd))throw Error('gang_history_native_rate_ambiguous');
 const nodeRateCache=new Map<string,Promise<string|null>>(),nodeMetadataCache=new Map<string,Promise<FreshTokenMetadata|null>>();
 const exactNodeRates=new Map<string,string>();
 const nodeRate=(token:string)=>{let work=nodeRateCache.get(token);if(!work){work=freshQuoteUsd(token,{rpc:saved.rpc,block}).then(value=>{exactNodeRates.set(token,value);return value;}).catch(()=>historicalQuotes.get(token)?.priceUsd??null);nodeRateCache.set(token,work);}return work;};
 const nodeMetadata=(token:string)=>{let work=nodeMetadataCache.get(token);if(!work){work=freshTokenMetadata(token,{rpc:saved.rpc,block,requireSupply:false}).catch(()=>null);nodeMetadataCache.set(token,work);}return work;};
 const metadata=async(token:string)=>{const original=await nodeMetadata(token);if(token!==GANG_TOKEN_ADDRESS)return original;
  if(original&&original.decimals!==18)throw Error('gang_history_node_precision_conflict');return original??{address:token,name:'Gang',symbol:'GANG',decimals:18,supplyRaw:null,block};};
 const priceUsd=async(token:string)=>{const original=await nodeRate(token);if(original!==null)return original;
  if(token===WBNB)return payerFx?.priceUsd??null;
  if(token===GANG_TOKEN_ADDRESS){const prices=[...matched.values()].filter(value=>value.transferPrice!==null).map(value=>value.transferPrice!);return prices.length&&prices.every(value=>value===prices[0])?prices[0]:null;}
  const rates=[...matched.values()].filter(value=>value.fx?.asset===token).map(value=>value.fx!.priceUsd);return rates.length&&rates.every(value=>value===rates[0])?rates[0]:null;};
 const capturedMetadata=await nodeMetadata(GANG_TOKEN_ADDRESS);if(capturedMetadata&&capturedMetadata.decimals!==18)throw Error('gang_history_node_precision_conflict');
 const decoded=await normalizeFreshReceipt(activeEntry,{number:tx.blockNumber,hash:block.hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)},
  {metadata,eligible:async token=>token.address===GANG_TOKEN_ADDRESS,knownLaunch:async token=>token===GANG_TOKEN_ADDRESS,priceUsd});await saved.settle();
 if(!decoded.events.length)throw Error('gang_history_normalized_event_missing');
 const provenanceByEventId:Record<string,FreshGangHistoryProvenance>={};
 for(let index=0;index<decoded.events.length;index++){
  let event=decoded.events[index];const source=matched.get(event.walletAddress);if(!source||event.tokenAddress!==GANG_TOKEN_ADDRESS||event.kind!==source.kind)throw Error('gang_history_normalized_event_mismatch');
  const expectedQuantity=new FreshRational(source.raw<0n?-source.raw:source.raw,10n**18n).decimal(255);
  if(event.quantity!==expectedQuantity)throw Error('gang_history_normalized_quantity_mismatch');
  if(['buy','sell'].includes(event.kind)&&(!event.quoteAddress||!event.quoteAmount||event.amountUsd===null))throw Error('gang_history_settlement_unavailable');
  const previous=input.knownEvents?.find(value=>value.id===event.id),preservedFields:string[]=[];
  if(previous){
   for(const key of['executionKey','walletAddress','tokenAddress','kind','quantity','blockNumber','blockHash','transactionHash','transactionIndex','executionIndex','logIndex','occurredAt']as const)
    if(previous[key]!==event[key])throw Error('gang_history_existing_fact_conflict');
   event={...event};for(const key of['amountUsd','feeUsd','quoteAddress','quoteSymbol','quoteAmount','acquisitionCost']as const)if(previous[key]!=null){Object.assign(event,{[key]:previous[key]});preservedFields.push(key);}
   decoded.events[index]=event;
  }
  const originalPrecision=await nodeMetadata(GANG_TOKEN_ADDRESS),rateAsset=event.quoteAddress??(source.transferPrice?GANG_TOKEN_ADDRESS:WBNB),originalRate=await nodeRate(rateAsset);
  const fields=[...(originalPrecision?[]:['quantity_decimals']),...(originalRate!==null||event.amountUsd===null||preservedFields.includes('amountUsd')?[]:['amount_usd']),
   ...((await nodeRate(WBNB))!==null||event.feeUsd===null||preservedFields.includes('feeUsd')?[]:['fee_usd'])];
  const oracleReferences:FreshGangHistoryProvenance['oracleReferences']=[];
  for(const asset of new Set([rateAsset,WBNB])){const nodePrice=await nodeRate(asset),historical=historicalQuotes.get(asset);if(nodePrice!==null){
   oracleReferences.push(exactNodeRates.has(asset)?{asset,kind:'retained_block_oracle',priceUsd:nodePrice}:{asset,kind:'historical_oracle_round',priceUsd:nodePrice,selectedRound:historical!.selectedRound,anchor:historical!.anchor});}}
  provenanceByEventId[event.id]={version:1,kind:'gmgn_historical_recovery_v1',pageSha256:source.activity.pageSha256,rowSha256:source.rowSha256,observedAt:source.activity.observedAt,
   walletAddress:event.walletAddress,transactionHash:tx.hash,tokenAddress:GANG_TOKEN_ADDRESS,fields,preservedFields,
   quantity:{raw:String(source.raw<0n?-source.raw:source.raw),decimals:18,reported:source.reported,quantizationUnit:source.quantization.decimal(255)},
   derivedFx:source.fx&&(originalRate===null||!oracleReferences.some(value=>value.asset===WBNB))?source.fx:null,providerTokenPriceUsd:source.transferPrice,oracleReferences,
   nodeFields:['transaction_identity','canonical_block','token_transfer_raw',...(['buy','sell'].includes(event.kind)?['settled_quote_raw']:['transfer_counterparty']),'gas_used','gas_price']};
 }
 return{decoded,provenanceByEventId,matches:matched.size,missingWallets};
}
