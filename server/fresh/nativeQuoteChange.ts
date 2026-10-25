import{createHash}from'node:crypto';
import{FRESH_ENTRY_POINTS,freshAddress,freshInteger,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock}from'./capture.js';
import{validateFreshTrace,freshTraceMatchesTransaction,freshNativeDelta,type FreshCallTrace}from'./trace.js';
import{beforeExecutionTopic,userOperationTopic}from'../smartAccountTrades.js';
import{transferTopic}from'../swap.js';
import{FOUR_MANAGERS,FLAP_PORTAL}from'../launchpad.js';
import{fourMarketAbi,flapMarketAbi}from'../nodeMarketProtocols.js';
import{FRESH_BNCB_QUOTE}from'./currentBncbQuote.js';
import type{FreshPriceBlock}from'./pricing.js';
import type{FreshHistoricalPoolNativeQuote}from'./historicalPoolQuote.js';
import{FreshRational}from'./accounting.js';
import{FRESH_STOCK_QUOTE_TOKEN,type FreshStockRawQuoteEvidence}from'./stockQuote.js';

const routers=new Set(['0x1de460f363af910f51726def188f9004276bf4bc','0x3508dca95a64c9378cb07ef6f40553a50905372a','0xef312c613199ac91ee23743565e6a4e4e65fe2c0','0x9689992f5b5c09447f15906d8d11214944488341']);
const zero='0x'+'0'.repeat(40),unit=10n**18n;
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const topicAddress=(value:unknown)=>typeof value==='string'&&/^0x0{24}[\da-f]{40}$/.test(value)?'0x'+value.slice(-40):null;
const word=(value:string|bigint)=>typeof value==='bigint'?value.toString(16).padStart(64,'0'):value.slice(2).padStart(64,'0');
const success=(call:FreshCallTrace)=>call.output==='0x'+word(1n);
interface Transfer{from:string;to:string;raw:bigint;index:number}
export interface FreshNativeQuoteChangePayment{
 version:1;kind:'wallet_native_purchase_with_bncb_change';transactionHash:string;blockNumber:number;blockHash:string;transactionIndex:number;
 walletAddress:string;tokenAddress:string;tokenRaw:string;quoteAddress:string;acquiredQuoteRaw:string;spentQuoteRaw:string;changeRaw:string;nativeSpentWei:string;gasFeeWei:string;
 controller:string;tokenTransferLogIndices:number[];quoteTransferLogIndices:number[];traceSha256:string;
 calls:{acquisition:number[];beforePaymentBalance:number[];payment:number[];afterPaymentBalance:number[];change:number[]};
}
export interface FreshNativeQuoteChangeValue{
 version:1;kind:'historical_native_purchase_with_bncb_change';payment:FreshNativeQuoteChangePayment;conversion:FreshHistoricalPoolNativeQuote;
 nativePriceUsd:string;grossNativeUsd:string;changeUsd:string;amountUsd:string;grossNativeQ:string;changeQ:string;amountQ:string;
}
export interface FreshNativeStockQuoteChangePayment extends Omit<FreshNativeQuoteChangePayment,'kind'>{kind:'wallet_native_purchase_with_nvdab_change'}
export interface FreshNativeStockQuoteChangeValue extends Omit<FreshNativeQuoteChangeValue,'kind'|'payment'|'conversion'>{
 kind:'historical_native_purchase_with_nvdab_change';payment:FreshNativeStockQuoteChangePayment;conversion:FreshStockRawQuoteEvidence;
}

/** A native buy returning BNCB is not a native-only purchase. Prove the entire
 * route: actual quote acquisition, controller payment, remaining router balance
 * and exact returned change. No ignored dust, quote decimals, assumed peg,
 * same-transaction market price, authorization/self-call or AA fee inference. */
export function freshNativeQuoteChange(entry:FreshCapturedReceipt,block:FreshPriceBlock,tokenAddress:string,walletAddress:string,targetRaw:bigint):FreshNativeQuoteChangePayment|null{
 return readNativeQuoteChange(entry,block,tokenAddress,walletAddress,targetRaw,FRESH_BNCB_QUOTE,'wallet_native_purchase_with_bncb_change')as FreshNativeQuoteChangePayment|null;
}
export function freshNativeStockQuoteChange(entry:FreshCapturedReceipt,block:FreshPriceBlock,tokenAddress:string,walletAddress:string,targetRaw:bigint):FreshNativeStockQuoteChangePayment|null{
 return readNativeQuoteChange(entry,block,tokenAddress,walletAddress,targetRaw,FRESH_STOCK_QUOTE_TOKEN,'wallet_native_purchase_with_nvdab_change')as FreshNativeStockQuoteChangePayment|null;
}
function readNativeQuoteChange(entry:FreshCapturedReceipt,block:FreshPriceBlock,tokenAddress:string,walletAddress:string,targetRaw:bigint,quote:string,kind:FreshNativeQuoteChangePayment['kind']|FreshNativeStockQuoteChangePayment['kind']):FreshNativeQuoteChangePayment|FreshNativeStockQuoteChangePayment|null{
 try{
  const{transaction:tx,receipt}=entry,token=freshAddress(tokenAddress),wallet=freshAddress(walletAddress),router=freshAddress(tx.to);
  if(!token||!wallet||!router||!routers.has(router)||router===wallet||FRESH_ENTRY_POINTS.includes(router)||tx.from!==wallet||!entry.wallets.includes(wallet)
   ||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||targetRaw<=0n||freshInteger(tx.value)<=0n||receipt.status!=='0x1'
   ||tx.blockHash!==block.hash||Number(freshInteger(tx.blockNumber))!==block.number||!Array.isArray(receipt.logs)||receipt.logs.length>512||!entry.trace
   ||typeof tx.input!=='string'||!/^0x(?:[\da-f]{2})*$/.test(tx.input)||!Number.isFinite(Date.parse(block.timestamp)))return null;
  validateFreshReceipt(receipt,tx,{number:tx.blockNumber,hash:block.hash,parentHash:zero+'0'.repeat(24),timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16),transactions:[]}as FreshBlock);
  const trace=validateFreshTrace(entry.trace);
  if(!freshTraceMatchesTransaction(trace,tx)||trace.input!==tx.input)return null;
  const nativeDelta=freshNativeDelta(trace,wallet),gas=freshInteger(receipt.gasUsed)*freshInteger(receipt.effectiveGasPrice??tx.gasPrice);
  if(nativeDelta>=0n||-nativeDelta>freshInteger(tx.value)||gas<=0n)return null;
  const flows=new Map<string,{incoming:bigint;outgoing:bigint;transfers:Transfer[]}>(),quoteRouter:Transfer[]=[];
  for(const log of receipt.logs){
   if([beforeExecutionTopic,userOperationTopic].includes(log.topics[0]))return null;
   if(log.topics[0]!==transferTopic)continue;
   if(log.topics.length!==3||!/^0x[\da-f]{64}$/.test(log.data))return null;
   const from=topicAddress(log.topics[1]),to=topicAddress(log.topics[2]);if(!from||!to)return null;
   const movement={from,to,raw:BigInt(log.data),index:Number(freshInteger(log.logIndex))};
   if(log.address===quote&&(from===router||to===router))quoteRouter.push(movement);
   if(from!==wallet&&to!==wallet)continue;if(from===to)return null;
   const flow=flows.get(log.address)??{incoming:0n,outgoing:0n,transfers:[]};
   if(from===wallet)flow.outgoing+=movement.raw;if(to===wallet)flow.incoming+=movement.raw;
   flow.transfers.push(movement);flows.set(log.address,flow);
  }
  const target=flows.get(token),change=flows.get(quote);
  if(flows.size!==2||!target||target.outgoing!==0n||target.incoming!==targetRaw||!change||change.outgoing!==0n||change.incoming<=0n
   ||change.transfers.length!==1||change.transfers[0].from!==router||quoteRouter.length!==3)return null;
  const controllers=[...new Set(target.transfers.map(value=>value.from))];
  if(controllers.length!==1||![...FOUR_MANAGERS,FLAP_PORTAL].includes(controllers[0]))return null;
  const controller=controllers[0],acquired=quoteRouter.filter(value=>value.to===router&&value.from!==zero&&value.from!==wallet&&value.from!==router),
   paid=quoteRouter.filter(value=>value.from===router&&value.to===controller),returned=quoteRouter.filter(value=>value.from===router&&value.to===wallet);
  if(acquired.length!==1||paid.length!==1||returned.length!==1||acquired[0].raw!==paid[0].raw+returned[0].raw||paid[0].raw<=0n
   ||returned[0].raw!==change.incoming||acquired[0].index>=paid[0].index||paid[0].index>=Math.min(...target.transfers.map(value=>value.index))
   ||Math.max(...target.transfers.map(value=>value.index))>=returned[0].index)return null;
  const actions=receipt.logs.filter(log=>[...FOUR_MANAGERS,FLAP_PORTAL].includes(log.address)).flatMap(log=>{
   const abi=log.address===FLAP_PORTAL?flapMarketAbi:fourMarketAbi,names=log.address===FLAP_PORTAL?['TokenBought','TokenSold']:['TokenPurchase','TokenSale'];
   if(!names.some(name=>abi.getEvent(name)!.topicHash===log.topics[0]))return[];
   try{const event=abi.parseLog(log);if(!event)return[{invalid:true}];
    const encoded=abi.encodeEventLog(event.fragment,event.args);if(encoded.data!==log.data||stable(encoded.topics)!==stable(log.topics))return[{invalid:true}];
    return[{invalid:log.address!==controller||String(event.args.token).toLowerCase()!==token||!['TokenPurchase','TokenBought'].includes(event.name)||![wallet,router].includes(String(event.args.account??event.args.buyer).toLowerCase())||BigInt(event.args.amount)!==targetRaw}];
   }catch{return[{invalid:true}];}
  });
  if(actions.length!==1||actions[0].invalid)return null;
  const calls:{call:FreshCallTrace;path:number[];order:number}[]=[];
  const visit=(call:FreshCallTrace,path:number[],reverted:boolean)=>{
   if(!['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT'].includes(call.type)
    ||(!call.error||!['CREATE','CREATE2'].includes(call.type))&&!freshAddress(call.to))throw Error('native_change_trace_incomplete');
   const failed=reverted||Boolean(call.error);if(path.length&&call.from===wallet&&!failed)throw Error('native_change_wallet_code_unsupported');
   if(!failed)calls.push({call,path,order:calls.length});call.calls?.forEach((child,index)=>visit(child,[...path,index],failed));
  };visit(trace,[],false);
  const unique=(predicate:(call:FreshCallTrace)=>boolean)=>{const matches=calls.filter(value=>predicate(value.call));return matches.length===1?matches[0]:null;};
  const transferInput=(recipient:string,raw:bigint)=>'0xa9059cbb'+word(recipient)+word(raw),balanceInput='0x70a08231'+word(router);
  const acquisition=unique(call=>call.type==='CALL'&&call.from===acquired[0].from&&call.to===quote&&call.input===transferInput(router,acquired[0].raw)&&success(call));
  const before=unique(call=>call.type==='STATICCALL'&&call.from===router&&call.to===quote&&call.input===balanceInput&&call.output==='0x'+word(acquired[0].raw));
  const payment=unique(call=>call.type==='CALL'&&call.to===quote&&success(call)&&(
   call.from===controller&&call.input==='0x23b872dd'+word(router)+word(controller)+word(paid[0].raw)
   ||call.from===router&&call.input===transferInput(controller,paid[0].raw)));
  const after=unique(call=>call.type==='STATICCALL'&&call.from===router&&call.to===quote&&call.input===balanceInput&&call.output==='0x'+word(change.incoming));
  const refund=unique(call=>call.type==='CALL'&&call.from===router&&call.to===quote&&call.input===transferInput(wallet,change.incoming)&&success(call));
  if(!acquisition||!before||!payment||!after||!refund||!(acquisition.order<before.order&&before.order<payment.order&&payment.order<after.order&&after.order<refund.order))return null;
  return{version:1,kind,transactionHash:tx.hash,blockNumber:block.number,blockHash:block.hash,transactionIndex:Number(freshInteger(tx.transactionIndex)),
   walletAddress:wallet,tokenAddress:token,tokenRaw:String(targetRaw),quoteAddress:quote,acquiredQuoteRaw:String(acquired[0].raw),spentQuoteRaw:String(paid[0].raw),changeRaw:String(change.incoming),
   nativeSpentWei:String(-nativeDelta),gasFeeWei:String(gas),controller,tokenTransferLogIndices:target.transfers.map(value=>value.index),quoteTransferLogIndices:quoteRouter.map(value=>value.index),
   traceSha256:createHash('sha256').update(stable(trace)).digest('hex'),calls:{acquisition:acquisition.path,beforePaymentBalance:before.path,payment:payment.path,afterPaymentBalance:after.path,change:refund.path}};
 }catch{return null;}
}

/** NVDAB uses a genuine WOOFi settled reference strictly in an earlier block,
 * never a same-transaction swap, assumed stock peg or fabricated V2 pool. */
export function valueFreshNativeStockQuoteChange(payment:FreshNativeStockQuoteChangePayment,conversion:FreshStockRawQuoteEvidence,nativePriceUsd:string):FreshNativeStockQuoteChangeValue|null{
 try{
  if(payment.version!==1||payment.kind!=='wallet_native_purchase_with_nvdab_change'||payment.quoteAddress!==FRESH_STOCK_QUOTE_TOKEN
   ||conversion.version!==1||conversion.kind!=='woofi_settled_raw_quote'||conversion.quoteToken!==payment.quoteAddress
   ||conversion.target.number!==payment.blockNumber||conversion.target.hash!==payment.blockHash||conversion.source.number>=payment.blockNumber)return null;
  const age=Date.parse(conversion.target.timestamp)-Date.parse(conversion.source.timestamp);if(!Number.isFinite(age)||age<0||age>120000)return null;
  const raw=(value:string)=>{if(!/^[1-9]\d{0,77}$/.test(value))throw Error('native_change_quantity_invalid');return BigInt(value);};
  const price=FreshRational.parse(nativePriceUsd);if(price.n<=0n)return null;
  const gross=new FreshRational(raw(payment.nativeSpentWei),unit).mul(price),marked=new FreshRational(raw(payment.changeRaw)*raw(conversion.nativeRaw),raw(conversion.quoteRaw)*unit).mul(price),amount=gross.sub(marked);
  if(amount.n<=0n)return null;
  return{version:1,kind:'historical_native_purchase_with_nvdab_change',payment,conversion,nativePriceUsd,grossNativeUsd:gross.decimal(),changeUsd:marked.decimal(),amountUsd:amount.decimal(),grossNativeQ:gross.exact(),changeQ:marked.exact(),amountQ:amount.exact()};
 }catch{return null;}
}

/** The caller independently authenticates this existing pre-execution market
 * ratio. Subtract real change exactly before the normal 36-place USD boundary;
 * gas and embedded route fees are not charged again. */
export function valueFreshNativeQuoteChange(payment:FreshNativeQuoteChangePayment,conversion:FreshHistoricalPoolNativeQuote,nativePriceUsd:string):FreshNativeQuoteChangeValue|null{
 try{
  if(payment.version!==1||payment.kind!=='wallet_native_purchase_with_bncb_change'||payment.quoteAddress!==FRESH_BNCB_QUOTE||conversion.version!==1||conversion.kind!=='historical_raw_pool_native_v2'
   ||conversion.quoteAddress!==payment.quoteAddress||conversion.observation!=='before_execution'||conversion.target.number!==payment.blockNumber||conversion.target.hash!==payment.blockHash||conversion.transactionIndex!==payment.transactionIndex)return null;
  const raw=(value:string)=>{if(!/^[1-9]\d{0,77}$/.test(value))throw Error('native_change_quantity_invalid');return BigInt(value);};
  const price=FreshRational.parse(nativePriceUsd);if(price.n<=0n)return null;
  const gross=new FreshRational(raw(payment.nativeSpentWei),unit).mul(price),marked=new FreshRational(raw(payment.changeRaw)*raw(conversion.nativeRaw),raw(conversion.quoteRaw)*unit).mul(price),amount=gross.sub(marked);
  if(amount.n<=0n)return null;
  return{version:1,kind:'historical_native_purchase_with_bncb_change',payment,conversion,nativePriceUsd,grossNativeUsd:gross.decimal(),changeUsd:marked.decimal(),amountUsd:amount.decimal(),grossNativeQ:gross.exact(),changeQ:marked.exact(),amountQ:amount.exact()};
 }catch{return null;}
}
