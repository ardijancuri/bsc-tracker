import{createHash}from'node:crypto';
import{AbiCoder,Interface}from'ethers';
import{PCS_V3_FACTORY,WBNB}from'../launchpad.js';
import{v3MarketAbi}from'../nodeMarketProtocols.js';
import{transferTopic}from'../swap.js';
import{FreshRational}from'./accounting.js';
import{freshAddress,freshInteger,type FreshCapturedReceipt}from'./capture.js';
import{freshNativeStockQuoteChange,type FreshNativeStockQuoteChangePayment}from'./nativeQuoteChange.js';
import type{FreshPriceBlock}from'./pricing.js';
import type{FreshCallTrace}from'./trace.js';
import{validFreshCompleteCallTrace}from'./passiveIncoming.js';
import{freshHistoricalV3Pool}from'./historicalV3Quote.js';
import{FRESH_PCS_V3_DEPLOYER,FRESH_PCS_V3_INITCODE_HASH}from'./currentV3Quote.js';

const router='0x1de460f363af910f51726def188f9004276bf4bc',delegate='0xcaf89804ee9bd32b26ab982a6813375ed206a141',feeRecipient='0xe3ed4c49c9807367784ab0d0d087d8a6815e7427',usdt='0x55d398326f99059ff775485246999027b3197955',depositTopic='0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',zero='0x'+'0'.repeat(40);
const word=(v:string|bigint)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0'),success=(c:FreshCallTrace)=>c.output==='0x'+word(1n),topicAddress=(t:string|undefined)=>t&&/^0x0{24}[\da-f]{40}$/.test(t)?'0x'+t.slice(-40):null;
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x),sha=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');

interface FreshNativeStockAcquisitionCostBase{
 version:1;kind:'same_execution_native_stock_acquisition_cost';observation:'actual_acquired_cost';payment:FreshNativeStockQuoteChangePayment;
 wrappedNativeWei:string;nativeRouterDeductionWei:string;nativeRouterDeductionRecipient:string;
 nativePriceUsd:string;grossCostUsd:string;retainedQuoteCostUsd:string;amountUsd:string;grossCostQ:string;retainedQuoteCostQ:string;amountQ:string;
 nativeBridgeOrder?:'output_before_input_callback';
 depositLogIndex:number;wrappedPaymentLogIndex:number;traceSha256:string;
}
interface AcquisitionCalls{deduction:number[];deposit:number[];wrappedPayment:number[];quoteAcquisition:number[]}
export type FreshNativeStockAcquisitionCost=FreshNativeStockAcquisitionCostBase&({
 route?:never;stableBridgeRaw:string;stableLogIndices:number[];
 calls:AcquisitionCalls&{stableAcquisition:number[];stablePayment:number[]};
}|{
 route:'direct_wrapped_stock_v3';
 pool:{address:string;factory:typeof PCS_V3_FACTORY;deployer:typeof FRESH_PCS_V3_DEPLOYER;initcodeHash:typeof FRESH_PCS_V3_INITCODE_HASH;token0:string;token1:string;fee:number};
 calls:AcquisitionCalls&{swap:number[];callback:number[];callbackDelegate:number[];factory:number[];beforeWrappedBalance:number[];afterWrappedBalance:number[]};
 swapLogIndex:number;quoteAcquisitionLogIndex:number;
});
type AcquisitionNode={call:FreshCallTrace;path:number[];order:number};
const directAbi=new Interface(['function swap(address,bool,int256,uint160,bytes) returns(int256,int256)','function pancakeV3SwapCallback(int256,int256,bytes)']);
const childOf=(n:AcquisitionNode,parent:AcquisitionNode)=>n.path.length===parent.path.length+1&&parent.path.every((v,i)=>n.path[i]===v);

/** A direct stock acquisition has no stable bridge. Authenticate the immutable
 * PCS V3 CREATE2 pool and its complete output-before-input callback, including
 * the actual wrapped balance increase. Its swap price is never a USD mark. */
function directStockCost(entry:FreshCapturedReceipt,payment:FreshNativeStockQuoteChangePayment,nodes:AcquisitionNode[],moves:{asset:string;from:string;to:string;raw:bigint;index:number}[],deposit:AcquisitionNode,deduction:AcquisitionNode,wrapped:bigint,deducted:bigint,gross:bigint,depositIndex:number,nativePriceUsd:string):FreshNativeStockAcquisitionCost|null{
 const trace=entry.trace!;if(!validFreshCompleteCallTrace(entry,trace))return null;
 const quote=payment.quoteAddress,acquiredRaw=BigInt(payment.acquiredQuoteRaw),wrappedMoves=moves.filter(m=>m.asset===WBNB),acquired=moves.filter(m=>m.asset===quote&&m.to===router);
 if(wrappedMoves.length!==1||wrappedMoves[0].from!==router||wrappedMoves[0].raw!==wrapped||acquired.length!==1||acquired[0].from!==wrappedMoves[0].to||acquired[0].raw!==acquiredRaw
  ||moves.some(m=>![WBNB,quote,payment.tokenAddress].includes(m.asset)))return null;
 const pool=acquired[0].from,unique=(predicate:(n:AcquisitionNode)=>boolean)=>{const a=nodes.filter(predicate);return a.length===1?a[0]:null;};
 const swaps=nodes.filter(n=>n.call.type==='CALL'&&n.call.from===router&&n.call.to===pool&&n.call.input?.startsWith('0x128acb08'));if(swaps.length!==1)return null;const swap=swaps[0],decoded=directAbi.decodeFunctionData('swap',swap.call.input!),data=String(decoded[4]);
 if(directAbi.encodeFunctionData('swap',[...decoded])!==swap.call.input||String(decoded[0]).toLowerCase()!==router||BigInt(decoded[2])!==wrapped)return null;
 const route=AbiCoder.defaultAbiCoder().decode(['tuple(bytes path,address payer)'],data)[0],path=String(route.path);
 if(AbiCoder.defaultAbiCoder().encode(['tuple(bytes path,address payer)'],[route])!==data||String(route.payer).toLowerCase()!==router||!/^0x[\da-f]{86}$/.test(path)||'0x'+path.slice(2,42)!==WBNB||'0x'+path.slice(48)!==quote)return null;
 const fee=Number.parseInt(path.slice(42,48),16),[token0,token1]=[quote,WBNB].sort(),zeroForOne=WBNB===token0;
 if(freshHistoricalV3Pool(quote,WBNB,fee)!==pool||decoded[1]!==zeroForOne)return null;
 const limit=BigInt(decoded[3]);if(limit<=4295128739n||limit>=1461446703485210103287273052203988822378723970342n)return null;
 const amounts=token0===quote?[-acquiredRaw,wrapped]:[wrapped,-acquiredRaw];
 if(swap.call.output!==directAbi.encodeFunctionResult('swap',amounts))return null;
 const transfer=(asset:string,from:string,to:string,raw:bigint)=>unique(n=>n.call.type==='CALL'&&n.call.from===from&&n.call.to===asset&&n.call.input==='0xa9059cbb'+word(to)+word(raw)&&success(n.call));
 const wrappedPayment=transfer(WBNB,router,pool,wrapped),quoteAcquisition=transfer(quote,pool,router,acquiredRaw),callback=unique(n=>n.call.type==='CALL'&&n.call.from===pool&&n.call.to===router&&n.call.input===directAbi.encodeFunctionData('pancakeV3SwapCallback',[...amounts,data]));
 if(!wrappedPayment||!quoteAcquisition||!callback||!childOf(quoteAcquisition,swap)||!childOf(callback,swap))return null;
 const callbackDelegate=unique(n=>n.call.type==='DELEGATECALL'&&n.call.from===router&&n.call.to===delegate&&n.call.input===callback.call.input&&childOf(n,callback));
 if(!callbackDelegate||callback.call.calls?.length!==1||!childOf(wrappedPayment,callbackDelegate))return null;
 const factory=unique(n=>n.call.type==='STATICCALL'&&n.call.from===router&&n.call.to===pool&&n.call.input==='0xc45a0155'&&n.call.output==='0x'+word(PCS_V3_FACTORY)&&childOf(n,callbackDelegate));
 const balances=nodes.filter(n=>n.call.type==='STATICCALL'&&n.call.from===pool&&n.call.to===WBNB&&n.call.input==='0x70a08231'+word(pool)&&/^0x[\da-f]{64}$/.test(n.call.output??'')&&childOf(n,swap));
 if(!factory||balances.length!==2)return null;const [before,after]=balances;
 if(!(deposit.order<swap.order&&swap.order<quoteAcquisition.order&&quoteAcquisition.order<before.order&&before.order<callback.order&&callbackDelegate.order<factory.order&&factory.order<wrappedPayment.order&&wrappedPayment.order<after.order)
  ||BigInt(after.call.output!)!==BigInt(before.call.output!)+wrapped)return null;
 const swapLogs=entry.receipt.logs.filter(l=>l.address===pool&&l.topics[0]===v3MarketAbi.getEvent('Swap')!.topicHash);if(swapLogs.length!==1)return null;
 const log=swapLogs[0],parsed=v3MarketAbi.parseLog(log);if(!parsed)return null;const encoded=v3MarketAbi.encodeEventLog(parsed.fragment,parsed.args),swapIndex=Number(freshInteger(log.logIndex));
 if(encoded.data!==log.data||JSON.stringify(encoded.topics)!==JSON.stringify(log.topics)||String(parsed.args.sender).toLowerCase()!==router||String(parsed.args.recipient).toLowerCase()!==router||BigInt(parsed.args.amount0)!==amounts[0]||BigInt(parsed.args.amount1)!==amounts[1]
  ||!(depositIndex<acquired[0].index&&acquired[0].index<wrappedMoves[0].index&&wrappedMoves[0].index<swapIndex&&swapIndex<payment.quoteTransferLogIndices[1]))return null;
 const price=FreshRational.parse(nativePriceUsd);if(price.n<=0n)return null;const cost=new FreshRational(gross,10n**18n).mul(price),retained=cost.mul(new FreshRational(BigInt(payment.changeRaw),acquiredRaw)),spent=cost.sub(retained);if(spent.n<=0n)return null;
 return{version:1,kind:'same_execution_native_stock_acquisition_cost',observation:'actual_acquired_cost',route:'direct_wrapped_stock_v3',payment,wrappedNativeWei:wrapped.toString(),nativeRouterDeductionWei:deducted.toString(),nativeRouterDeductionRecipient:feeRecipient,
  pool:{address:pool,factory:PCS_V3_FACTORY,deployer:FRESH_PCS_V3_DEPLOYER,initcodeHash:FRESH_PCS_V3_INITCODE_HASH,token0,token1,fee},nativePriceUsd,grossCostUsd:cost.decimal(),retainedQuoteCostUsd:retained.decimal(),amountUsd:spent.decimal(),grossCostQ:cost.exact(),retainedQuoteCostQ:retained.exact(),amountQ:spent.exact(),
  calls:{deduction:deduction.path,deposit:deposit.path,wrappedPayment:wrappedPayment.path,quoteAcquisition:quoteAcquisition.path,swap:swap.path,callback:callback.path,callbackDelegate:callbackDelegate.path,factory:factory.path,beforeWrappedBalance:before.path,afterWrappedBalance:after.path},nativeBridgeOrder:'output_before_input_callback',depositLogIndex:depositIndex,wrappedPaymentLogIndex:wrappedMoves[0].index,swapLogIndex:swapIndex,quoteAcquisitionLogIndex:acquired[0].index,traceSha256:sha(trace)};
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
  const stableMoves=moves.filter(m=>m.asset===usdt);if(stableMoves.length===0)return directStockCost(entry,payment,nodes,moves,deposit,deduction,wrapped,deducted,gross,Number(freshInteger(depositLogs[0].logIndex)),nativePriceUsd);if(stableMoves.length!==2||stableMoves[0].to!==router||stableMoves[1].from!==router||stableMoves[0].raw<=0n||stableMoves[0].raw!==stableMoves[1].raw||stableMoves[0].index>=stableMoves[1].index)return null;
  const quote=payment.quoteAddress,acquired=moves.filter(m=>m.asset===quote&&m.to===router);if(acquired.length!==1||acquired[0].from!==stableMoves[1].to||acquired[0].raw!==BigInt(payment.acquiredQuoteRaw)||stableMoves[0].from!==wrappedMoves[0].to)return null;
  const unique=(predicate:(c:FreshCallTrace)=>boolean)=>{const a=nodes.filter(n=>predicate(n.call));return a.length===1?a[0]:null;};
  const transfer=(asset:string,from:string,to:string,raw:bigint)=>unique(c=>c.type==='CALL'&&c.from===from&&c.to===asset&&c.input==='0xa9059cbb'+word(to)+word(raw)&&success(c));
  const wrappedPayment=transfer(WBNB,router,wrappedMoves[0].to,wrapped),stableAcquisition=transfer(usdt,stableMoves[0].from,router,stableMoves[0].raw),stablePayment=transfer(usdt,router,stableMoves[1].to,stableMoves[1].raw),quoteAcquisition=transfer(quote,acquired[0].from,router,acquired[0].raw);if(!wrappedPayment||!stableAcquisition||!stablePayment||!quoteAcquisition)return null;
  // The native/stable bridge may pay input first (V2), or return stable output
  // before its input callback (V3). Both legs must finish before acquiring the
  // stock quote; the second V3 leg still returns stock before stable payment.
  const v3Bridge=stableAcquisition.order<wrappedPayment.order;if(v3Bridge&&!validFreshCompleteCallTrace(entry,trace))return null;
  if(!(deposit.order<Math.min(wrappedPayment.order,stableAcquisition.order)&&Math.max(wrappedPayment.order,stableAcquisition.order)<quoteAcquisition.order&&quoteAcquisition.order<stablePayment.order)
   ||!(stableMoves[0].index<acquired[0].index&&wrappedMoves[0].index<acquired[0].index&&acquired[0].index<stableMoves[1].index&&stableMoves[1].index<payment.quoteTransferLogIndices[1])
   ||(wrappedMoves[0].index<stableMoves[0].index)!==(wrappedPayment.order<stableAcquisition.order))return null;
  const price=FreshRational.parse(nativePriceUsd);if(price.n<=0n)return null;const cost=new FreshRational(gross,10n**18n).mul(price),retained=cost.mul(new FreshRational(BigInt(payment.changeRaw),BigInt(payment.acquiredQuoteRaw))),spent=cost.sub(retained);if(spent.n<=0n)return null;
  return{version:1,kind:'same_execution_native_stock_acquisition_cost',observation:'actual_acquired_cost',payment,wrappedNativeWei:wrapped.toString(),nativeRouterDeductionWei:deducted.toString(),nativeRouterDeductionRecipient:feeRecipient,stableBridgeRaw:stableMoves[0].raw.toString(),nativePriceUsd,grossCostUsd:cost.decimal(),retainedQuoteCostUsd:retained.decimal(),amountUsd:spent.decimal(),grossCostQ:cost.exact(),retainedQuoteCostQ:retained.exact(),amountQ:spent.exact(),calls:{deduction:deduction.path,deposit:deposit.path,wrappedPayment:wrappedPayment.path,stableAcquisition:stableAcquisition.path,stablePayment:stablePayment.path,quoteAcquisition:quoteAcquisition.path},...(v3Bridge?{nativeBridgeOrder:'output_before_input_callback' as const}:{}),depositLogIndex:Number(freshInteger(depositLogs[0].logIndex)),wrappedPaymentLogIndex:wrappedMoves[0].index,stableLogIndices:stableMoves.map(m=>m.index),traceSha256:sha(trace)};
 }catch{return null;}
}
