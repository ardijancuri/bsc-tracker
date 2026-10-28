import {WBNB} from '../launchpad.js';
import {transferTopic} from '../swap.js';
import {FRESH_ENTRY_POINTS,freshAddress,freshInteger,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock} from './capture.js';
import {validFreshCompleteCallTrace} from './passiveIncoming.js';
import {freshNativeDelta,validateFreshTrace,type FreshCallTrace} from './trace.js';
import type {FreshPriceBlock,FreshTokenMetadata} from './pricing.js';

export interface FreshMixedNativeWrappedSell {
 version:1;kind:'wallet_native_and_wrapped_sell';transactionHash:string;blockNumber:number;blockHash:string;walletAddress:string;tokenAddress:string;
 tokenRaw:string;nativeReceivedWei:string;wrappedReceivedRaw:string;totalNativeEquivalentWei:string;gasFeeWei:string;
 wrappedTransferLogIndices:number[];nativeReceiptPaths:number[][];
}
const address=(topic:string|undefined)=>topic&&/^0x0{24}[\da-f]{40}$/.test(topic)?'0x'+topic.slice(-40):null;
const supportedCalls=new Set(['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT']);
const success='0x'+'0'.repeat(63)+'1';

/** One ordinary sell can settle partly in native BNB and partly in WBNB.
 * Count actual wallet receipts, not the route's gross Withdrawal or Swap.
 * The complete trace proves native transfers; real WBNB Transfer calls and
 * logs prove the separate wrapped balance. Gas stays outside both amounts.
 * Unverified precision, refunds, AA and other wallet assets remain unsupported.
 */
export function freshMixedNativeWrappedSell(entry:FreshCapturedReceipt,block:FreshPriceBlock,tokenAddress:string,walletAddress:string,targetRaw:bigint,
 verifiedWrapped:Pick<FreshTokenMetadata,'address'|'decimals'|'block'>):FreshMixedNativeWrappedSell|null {
 try {
  const {transaction:tx,receipt}=entry,token=freshAddress(tokenAddress),wallet=freshAddress(walletAddress);
  if(!token||token===WBNB||!wallet||targetRaw>=0n||tx.from!==wallet||!entry.wallets.includes(wallet)||!tx.to||tx.to===wallet||FRESH_ENTRY_POINTS.includes(tx.to)
   ||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||freshInteger(tx.value)!==0n||receipt.status!=='0x1'
   ||tx.blockHash!==block.hash||Number(freshInteger(tx.blockNumber))!==block.number||!Number.isSafeInteger(block.number)||!Number.isFinite(Date.parse(block.timestamp))
   ||verifiedWrapped.address!==WBNB||verifiedWrapped.decimals!==18||verifiedWrapped.block.number!==block.number||verifiedWrapped.block.hash!==block.hash
   ||Date.parse(verifiedWrapped.block.timestamp)!==Date.parse(block.timestamp)||receipt.logs.length>512)return null;
  validateFreshReceipt(receipt,tx,{number:tx.blockNumber,hash:block.hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)} as FreshBlock);
  const trace=validateFreshTrace(entry.trace);if(!validFreshCompleteCallTrace(entry,trace))return null;
  const flows=new Map<string,{incoming:bigint;outgoing:bigint;indices:number[]}>(),wrappedLogs=new Map<string,number>();
  for(const log of receipt.logs){
   if(log.topics[0]!==transferTopic)continue;
   if(log.topics.length!==3||!/^0x[\da-f]{64}$/.test(log.data))return null;
   const from=address(log.topics[1]),to=address(log.topics[2]);if(!from||!to)return null;if(from!==wallet&&to!==wallet)continue;
   const amount=BigInt(log.data);if(amount===0n)continue;if(from===to)return null;
   const flow=flows.get(log.address)??{incoming:0n,outgoing:0n,indices:[]};if(from===wallet)flow.outgoing+=amount;if(to===wallet)flow.incoming+=amount;flow.indices.push(Number(freshInteger(log.logIndex)));flows.set(log.address,flow);
   if(log.address===WBNB&&to===wallet){const key=from+':'+to+':'+amount;wrappedLogs.set(key,(wrappedLogs.get(key)??0)+1);}
  }
  const delivery=flows.get(token),wrapped=flows.get(WBNB);
  if(flows.size!==2||!delivery||delivery.incoming!==0n||delivery.outgoing!==-targetRaw||!wrapped||wrapped.outgoing!==0n||wrapped.incoming<=0n)return null;
  const wrappedCalls=new Map<string,number>(),nativeReceiptPaths:number[][]=[];let native=0n,valid=true,frames=0;
  function visit(call:FreshCallTrace,path:number[]){
   if(!valid||++frames>5000){valid=false;return;}if(call.error)return;
   if(!supportedCalls.has(call.type)||path.length>0&&call.from===wallet){valid=false;return;}
   if(call.to===wallet&&freshInteger(call.value??'0x0')>0n){if(call.type!=='CALL'){valid=false;return;}native+=freshInteger(call.value!);nativeReceiptPaths.push(path);}
   if(call.type==='CALL'&&call.to===WBNB&&call.input&&call.output===success&&freshInteger(call.value??'0x0')===0n){
    let sender:string|null=null,recipient:string|null=null,raw:bigint|null=null;
    if(/^0xa9059cbb[\da-f]{128}$/.test(call.input)){sender=call.from;recipient=address('0x'+call.input.slice(10,74));raw=BigInt('0x'+call.input.slice(74));}
    else if(/^0x23b872dd[\da-f]{192}$/.test(call.input)){sender=address('0x'+call.input.slice(10,74));recipient=address('0x'+call.input.slice(74,138));raw=BigInt('0x'+call.input.slice(138));}
    if(sender&&recipient===wallet&&raw!==null&&raw>0n){const key=sender+':'+recipient+':'+raw;wrappedCalls.set(key,(wrappedCalls.get(key)??0)+1);}
   }
   call.calls?.forEach((child,index)=>visit(child,[...path,index]));
  }
  visit(trace,[]);
  if(!valid||native<=0n||native!==freshNativeDelta(trace,wallet)||wrappedCalls.size!==wrappedLogs.size||[...wrappedLogs].some(([key,count])=>wrappedCalls.get(key)!==count))return null;
  const gas=freshInteger(receipt.gasUsed)*freshInteger(receipt.effectiveGasPrice??tx.gasPrice);if(gas<=0n)return null;
  return{version:1,kind:'wallet_native_and_wrapped_sell',transactionHash:tx.hash,blockNumber:block.number,blockHash:block.hash,walletAddress:wallet,tokenAddress:token,tokenRaw:String(-targetRaw),
   nativeReceivedWei:String(native),wrappedReceivedRaw:String(wrapped.incoming),totalNativeEquivalentWei:String(native+wrapped.incoming),gasFeeWei:String(gas),wrappedTransferLogIndices:wrapped.indices,nativeReceiptPaths};
 }catch{return null;}
}
