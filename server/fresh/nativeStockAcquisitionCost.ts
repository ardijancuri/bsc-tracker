import{createHash}from'node:crypto';
import{WBNB}from'../launchpad.js';
import{transferTopic}from'../swap.js';
import{FreshRational}from'./accounting.js';
import{freshAddress,freshInteger,type FreshCapturedReceipt}from'./capture.js';
import{freshNativeStockQuoteChange,type FreshNativeStockQuoteChangePayment}from'./nativeQuoteChange.js';
import{FRESH_STOCK_QUOTE_TOKEN}from'./stockQuote.js';
import type{FreshPriceBlock}from'./pricing.js';
import type{FreshCallTrace}from'./trace.js';

const router='0x1de460f363af910f51726def188f9004276bf4bc',delegate='0xcaf89804ee9bd32b26ab982a6813375ed206a141',feeRecipient='0xe3ed4c49c9807367784ab0d0d087d8a6815e7427',usdt='0x55d398326f99059ff775485246999027b3197955',depositTopic='0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',zero='0x'+'0'.repeat(40);
const word=(v:string|bigint)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0'),success=(c:FreshCallTrace)=>c.output==='0x'+word(1n),topicAddress=(t:string|undefined)=>t&&/^0x0{24}[\da-f]{40}$/.test(t)?'0x'+t.slice(-40):null;
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x),sha=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');

export interface FreshNativeStockAcquisitionCost{
 version:1;kind:'same_execution_native_stock_acquisition_cost';observation:'actual_acquired_cost';payment:FreshNativeStockQuoteChangePayment;
 wrappedNativeWei:string;nativeRouterDeductionWei:string;nativeRouterDeductionRecipient:string;stableBridgeRaw:string;
 nativePriceUsd:string;grossCostUsd:string;retainedQuoteCostUsd:string;amountUsd:string;grossCostQ:string;retainedQuoteCostQ:string;amountQ:string;
 calls:{deduction:number[];deposit:number[];wrappedPayment:number[];stableAcquisition:number[];stablePayment:number[];quoteAcquisition:number[]};
 depositLogIndex:number;wrappedPaymentLogIndex:number;stableLogIndices:number[];traceSha256:string;
}

/** This proof allocates an actual acquisition's input cost; it is not a market
 * price, oracle observation or a relaxed historical quote. Original gas stays
 * separate. The observed router deduction is retained as cash flow, without
 * claiming that its recipient or purpose is a verified protocol fee. */
export function freshNativeStockAcquisitionCost(entry:FreshCapturedReceipt,block:FreshPriceBlock,token:string,wallet:string,targetRaw:bigint,nativePriceUsd:string):FreshNativeStockAcquisitionCost|null{
 try{
  const payment=freshNativeStockQuoteChange(entry,block,token,wallet,targetRaw),tx=entry.transaction,trace=entry.trace;if(!payment||!trace||tx.to!==router||typeof tx.input!=='string'||!tx.input.startsWith('0x4d819a2a'))return null;
  const nodes:{call:FreshCallTrace;path:number[];order:number}[]=[];function walk(c:FreshCallTrace,path:number[]=[],failed=false){if(failed||c.error)return;if(!['CALL','STATICCALL','DELEGATECALL'].includes(c.type)||!freshAddress(c.to))throw Error('acquisition_trace_opaque');nodes.push({call:c,path,order:nodes.length});c.calls?.forEach((child,i)=>walk(child,[...path,i],false));}walk(trace);
  if(trace.calls?.length!==1||trace.calls[0].type!=='DELEGATECALL'||trace.calls[0].to!==delegate||trace.calls[0].input!==tx.input)return null;
  const positive=nodes.filter(n=>n.call.type==='CALL'&&n.call.from!==n.call.to&&freshInteger(n.call.value??'0x0')>0n),deposits=positive.filter(n=>n.call.from===router&&n.call.to===WBNB&&n.call.input==='0xd0e30db0'),deductions=positive.filter(n=>n.call.from===router&&n.call.to===feeRecipient&&n.call.input==='0x'&&!n.call.calls?.length);
  if(positive.length!==3||deposits.length!==1||deductions.length!==1||positive[0].call!==trace||trace.from!==wallet||trace.to!==router)return null;
  const deposit=deposits[0],deduction=deductions[0],wrapped=freshInteger(deposit.call.value),deducted=freshInteger(deduction.call.value),gross=BigInt(payment.nativeSpentWei);if(wrapped<=0n||deducted<=0n||gross!==wrapped+deducted||gross!==freshInteger(tx.value)||deduction.order>=deposit.order)return null;
  const moves=entry.receipt.logs.filter(l=>l.topics[0]===transferTopic).map(l=>{if(l.topics.length!==3||!/^0x[\da-f]{64}$/.test(l.data))throw Error('acquisition_transfer_invalid');const from=topicAddress(l.topics[1]),to=topicAddress(l.topics[2]);if(!from||!to||from===zero||to===zero)throw Error('acquisition_transfer_invalid');return{asset:l.address,from,to,raw:BigInt(l.data),index:Number(freshInteger(l.logIndex))};});
  const depositLogs=entry.receipt.logs.filter(l=>l.address===WBNB&&l.topics[0]===depositTopic);if(depositLogs.length!==1||depositLogs[0].topics.length!==2||topicAddress(depositLogs[0].topics[1])!==router||depositLogs[0].data!=='0x'+word(wrapped))return null;
  const wrappedMoves=moves.filter(m=>m.asset===WBNB&&m.from===router);if(wrappedMoves.length!==1||wrappedMoves[0].raw!==wrapped)return null;
  const stableMoves=moves.filter(m=>m.asset===usdt);if(stableMoves.length!==2||stableMoves[0].to!==router||stableMoves[1].from!==router||stableMoves[0].raw<=0n||stableMoves[0].raw!==stableMoves[1].raw||stableMoves[0].index>=stableMoves[1].index||wrappedMoves[0].index>=stableMoves[0].index)return null;
  const acquired=moves.filter(m=>m.asset===FRESH_STOCK_QUOTE_TOKEN&&m.to===router);if(acquired.length!==1||acquired[0].from!==stableMoves[1].to||acquired[0].raw!==BigInt(payment.acquiredQuoteRaw)||stableMoves[0].from!==wrappedMoves[0].to)return null;
  const unique=(predicate:(c:FreshCallTrace)=>boolean)=>{const a=nodes.filter(n=>predicate(n.call));return a.length===1?a[0]:null;};
  const transfer=(asset:string,from:string,to:string,raw:bigint)=>unique(c=>c.type==='CALL'&&c.from===from&&c.to===asset&&c.input==='0xa9059cbb'+word(to)+word(raw)&&success(c));
  const wrappedPayment=transfer(WBNB,router,wrappedMoves[0].to,wrapped),stableAcquisition=transfer(usdt,stableMoves[0].from,router,stableMoves[0].raw),stablePayment=transfer(usdt,router,stableMoves[1].to,stableMoves[1].raw),quoteAcquisition=transfer(FRESH_STOCK_QUOTE_TOKEN,acquired[0].from,router,acquired[0].raw);if(!wrappedPayment||!stableAcquisition||!stablePayment||!quoteAcquisition)return null;
  // V3 sends output before its callback pays the exact stable input. The
  // receipt and complete successful call tree must agree on that ordering.
  if(!(deposit.order<wrappedPayment.order&&wrappedPayment.order<stableAcquisition.order&&stableAcquisition.order<quoteAcquisition.order&&quoteAcquisition.order<stablePayment.order)||!(stableMoves[0].index<acquired[0].index&&acquired[0].index<stableMoves[1].index&&stableMoves[1].index<payment.quoteTransferLogIndices[1]))return null;
  const price=FreshRational.parse(nativePriceUsd);if(price.n<=0n)return null;const cost=new FreshRational(gross,10n**18n).mul(price),retained=cost.mul(new FreshRational(BigInt(payment.changeRaw),BigInt(payment.acquiredQuoteRaw))),spent=cost.sub(retained);if(spent.n<=0n)return null;
  return{version:1,kind:'same_execution_native_stock_acquisition_cost',observation:'actual_acquired_cost',payment,wrappedNativeWei:wrapped.toString(),nativeRouterDeductionWei:deducted.toString(),nativeRouterDeductionRecipient:feeRecipient,stableBridgeRaw:stableMoves[0].raw.toString(),nativePriceUsd,grossCostUsd:cost.decimal(),retainedQuoteCostUsd:retained.decimal(),amountUsd:spent.decimal(),grossCostQ:cost.exact(),retainedQuoteCostQ:retained.exact(),amountQ:spent.exact(),calls:{deduction:deduction.path,deposit:deposit.path,wrappedPayment:wrappedPayment.path,stableAcquisition:stableAcquisition.path,stablePayment:stablePayment.path,quoteAcquisition:quoteAcquisition.path},depositLogIndex:Number(freshInteger(depositLogs[0].logIndex)),wrappedPaymentLogIndex:wrappedMoves[0].index,stableLogIndices:stableMoves.map(m=>m.index),traceSha256:sha(trace)};
 }catch{return null;}
}
