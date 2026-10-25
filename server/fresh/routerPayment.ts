import type {FreshTransaction,FreshLog} from './capture.js';
import{freshGangBinanceNativeBuyCost}from'./gangBinancePayment.js';

// The same authenticated Flap/GMGN Swap receipt used by nativeSellProceeds.
// A native exact-input purchase must match the signed transaction value, the
// receipt's sender/recipient and the wallet's actual token increase. Neither
// arbitrary tx.value nor an inner pool's gross input is purchase-cost proof.
const routers=new Set(['0x1de460f363af910f51726def188f9004276bf4bc','0x3508dca95a64c9378cb07ef6f40553a50905372a','0xef312c613199ac91ee23743565e6a4e4e65fe2c0']);
const topic='0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a';
const zero='0x'+'0'.repeat(40);
const addr=(word:string|undefined)=>word&&/^0{24}[\da-f]{40}$/i.test(word)?'0x'+word.slice(-40).toLowerCase():null;
const gang='0x0c6302401aa5325c2e36f170f52c00b1d220b405',gangPair='0x0bd5ded695d61c2db15c703c345d57e039fd0b6d';
const wrappedNative='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',nativeRouter='0x1de460f363af910f51726def188f9004276bf4bc';
const feeTopic='0x205442d60b70af1203d43cab62352c3b69b94f091be32fe683198057282b5c92';
const depositTopic='0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const syncTopic='0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const poolSwapTopic='0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const wrapperRouter='0x01a21c857a3219991fba2b1a2824b1b758966b54',pcsRouter='0x10ed43c718714eb63d5aa57b78b54704e256024e';
const wrapperSwapTopic='0xb4ebd56706d27fa01a1b393765021ba216f704b12bb50a87bf257d3ba6cd7bdc';
const wrapperExpenseTopic='0xb948f731b5e342e038ab722853f67007c439a74137633184c1d0513b21bf5a64',wrapperExpenseRecipient='0xdefb37382e08d8a33abbc869a02e179cb28a0821';
const wordsOf=(data:string,count:number)=>new RegExp('^0x(?:[\\da-f]{64}){'+count+'}$','i').test(data)?data.slice(2).toLowerCase().match(/.{64}/g)!:null;

/** The pinned GANG/WBNB market has a native-funded exact-input route whose
 * Swap records WBNB as the route asset. Authenticate its complete receipt and
 * signed route: gross native = one explicit native expense + one WBNB deposit.
 * This is deliberately not a generic tx.value or ERC20-funded WBNB fallback. */
function wrappedNativeBuyCost(tx:FreshTransaction,wallet:string,token:string,receivedRaw:bigint,logs:FreshLog[],words:string[]):bigint|null{
 try{
  if(tx.to?.toLowerCase()!==nativeRouter||token!==gang||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.chainId!=='0x38'
    ||tx.authorizationList!==undefined||logs.length!==7||words.length!==16||addr(logs[6].topics[3]?.slice(2))!==zero
    ||typeof tx.input!=='string'||!/^0x4d819a2a(?:[\da-f]{64}){18}$/i.test(tx.input))return null;
  const input=tx.input.slice(10).toLowerCase().match(/.{64}/g)!,gross=BigInt(tx.value);
  const route=[0n,wrappedNative,gang,gangPair,2500n,50n,0n,320n,0n,0n,0n]
    .map(value=>typeof value==='bigint'?value.toString(16).padStart(64,'0'):value.slice(2).padStart(64,'0'));
  if(BigInt('0x'+input[0])!==160n||BigInt('0x'+input[1])!==0n||BigInt('0x'+input[2])!==gross
    ||BigInt('0x'+input[3])<=0n||BigInt('0x'+input[3])>receivedRaw||BigInt('0x'+input[4])<=0n
    ||BigInt('0x'+input[5])!==1n||BigInt('0x'+input[6])!==32n
    ||route.some((value,index)=>input[index+7]!==value||words[index+5]!==value))return null;
  if(!/^0x[\da-f]{64}$/i.test(tx.hash)||!/^0x[\da-f]{64}$/i.test(tx.blockHash)
    ||!/^0x[\da-f]+$/i.test(tx.blockNumber)||!/^0x[\da-f]+$/i.test(tx.transactionIndex))return null;
  let previous=-1n;
  for(const log of logs){
   if(log.removed||log.transactionHash?.toLowerCase()!==tx.hash.toLowerCase()||log.blockHash?.toLowerCase()!==tx.blockHash.toLowerCase()
     ||!/^0x[\da-f]+$/i.test(log.blockNumber)||BigInt(log.blockNumber)!==BigInt(tx.blockNumber)
     ||!/^0x[\da-f]+$/i.test(log.transactionIndex)||BigInt(log.transactionIndex)!==BigInt(tx.transactionIndex)
     ||!/^0x[\da-f]+$/i.test(log.logIndex)||BigInt(log.logIndex)<=previous)return null;
   previous=BigInt(log.logIndex);
  }
  const [fee,deposit,payment,delivery,sync,poolSwap,swap]=logs;
  const matches=(log:FreshLog,address:string,signature:string,addresses:string[])=>log.address.toLowerCase()===address
    &&log.topics.length===addresses.length+1&&log.topics[0]?.toLowerCase()===signature
    &&addresses.every((value,index)=>addr(log.topics[index+1]?.slice(2))===value);
  if(!matches(fee,nativeRouter,feeTopic,[zero,wallet])||!matches(deposit,wrappedNative,depositTopic,[nativeRouter])
    ||!matches(payment,wrappedNative,transferTopic,[nativeRouter,gangPair])||!matches(delivery,gang,transferTopic,[gangPair,wallet])
    ||!matches(sync,gangPair,syncTopic,[])||!matches(poolSwap,gangPair,poolSwapTopic,[nativeRouter,wallet])
    ||!matches(swap,nativeRouter,topic,[wallet,wallet,zero]))return null;
  const feeWords=wordsOf(fee.data,2),depositWords=wordsOf(deposit.data,1),paymentWords=wordsOf(payment.data,1),deliveryWords=wordsOf(delivery.data,1),
    syncWords=wordsOf(sync.data,2),poolWords=wordsOf(poolSwap.data,4);
  if(!feeWords||!depositWords||!paymentWords||!deliveryWords||!syncWords||!poolWords)return null;
  const nativeExpense=BigInt('0x'+feeWords[0]),deposited=BigInt('0x'+depositWords[0]);
  if(nativeExpense<=0n||deposited<=0n||nativeExpense+deposited!==gross||nativeExpense!==gross/100n
    ||BigInt('0x'+feeWords[1])<=0n||BigInt('0x'+feeWords[1])>BigInt('0x'+input[4])
    ||BigInt('0x'+paymentWords[0])!==deposited||BigInt('0x'+deliveryWords[0])!==receivedRaw
    ||BigInt('0x'+poolWords[0])!==0n||BigInt('0x'+poolWords[1])!==deposited
    ||BigInt('0x'+poolWords[2])!==receivedRaw||BigInt('0x'+poolWords[3])!==0n
    ||syncWords.some(value=>BigInt('0x'+value)<=0n))return null;
  return gross;
 }catch{return null;}
}

/** This router is already an authenticated net-payout source for sales. Its
 * native purchase separately records the signed fixed expense and the swap's
 * embedded expense. Retain their gross wallet charge once, never gas twice. */
function wrappedPcsBuyCost(tx:FreshTransaction,wallet:string,token:string,receivedRaw:bigint,logs:FreshLog[]):bigint|null{
 try{
  if(token!==gang||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.chainId!=='0x38'||tx.authorizationList!==undefined||logs.length!==7
    ||typeof tx.input!=='string'||!/^0x89f7f14f(?:[\da-f]{64}){13}$/i.test(tx.input))return null;
  const input=tx.input.slice(10).toLowerCase().match(/.{64}/g)!;
  if(addr(input[0])!==gang||BigInt('0x'+input[1])!==4n||BigInt('0x'+input[2])<=0n||BigInt('0x'+input[2])>receivedRaw
    ||BigInt('0x'+input[3])<=0n||BigInt('0x'+input[4])!==224n||addr(input[5])!==wrapperExpenseRecipient
    ||BigInt('0x'+input[6])!==300000000000000n||BigInt('0x'+input[7])!==160n||input[8]!==input[2]
    ||BigInt('0x'+input[9])!==64n||BigInt('0x'+input[10])!==2n||addr(input[11])!==wrappedNative||addr(input[12])!==gang)return null;
  if(!/^0x[\da-f]{64}$/i.test(tx.hash)||!/^0x[\da-f]{64}$/i.test(tx.blockHash)
    ||!/^0x[\da-f]+$/i.test(tx.blockNumber)||!/^0x[\da-f]+$/i.test(tx.transactionIndex))return null;
  let previous=-1n;
  for(const log of logs){
   if(log.removed||log.transactionHash?.toLowerCase()!==tx.hash.toLowerCase()||log.blockHash?.toLowerCase()!==tx.blockHash.toLowerCase()
     ||!/^0x[\da-f]+$/i.test(log.blockNumber)||BigInt(log.blockNumber)!==BigInt(tx.blockNumber)
     ||!/^0x[\da-f]+$/i.test(log.transactionIndex)||BigInt(log.transactionIndex)!==BigInt(tx.transactionIndex)
     ||!/^0x[\da-f]+$/i.test(log.logIndex)||BigInt(log.logIndex)<=previous)return null;
   previous=BigInt(log.logIndex);
  }
  const [expense,deposit,payment,delivery,sync,poolSwap,swap]=logs;
  const matches=(log:FreshLog,address:string,signature:string,addresses:string[])=>log.address.toLowerCase()===address
    &&log.topics.length===addresses.length+1&&log.topics[0]?.toLowerCase()===signature
    &&addresses.every((value,index)=>addr(log.topics[index+1]?.slice(2))===value);
  if(!matches(expense,wrapperRouter,wrapperExpenseTopic,[wallet,wrapperExpenseRecipient])||!matches(deposit,wrappedNative,depositTopic,[pcsRouter])
    ||!matches(payment,wrappedNative,transferTopic,[pcsRouter,gangPair])||!matches(delivery,gang,transferTopic,[gangPair,wallet])
    ||!matches(sync,gangPair,syncTopic,[])||!matches(poolSwap,gangPair,poolSwapTopic,[pcsRouter,wallet])
    ||!matches(swap,wrapperRouter,wrapperSwapTopic,[wallet]))return null;
  const expenseWords=wordsOf(expense.data,1),depositWords=wordsOf(deposit.data,1),paymentWords=wordsOf(payment.data,1),deliveryWords=wordsOf(delivery.data,1),
    syncWords=wordsOf(sync.data,2),poolWords=wordsOf(poolSwap.data,4),swapWords=wordsOf(swap.data,6);
  if(!expenseWords||!depositWords||!paymentWords||!deliveryWords||!syncWords||!poolWords||!swapWords
    ||addr(swapWords[0])!=='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'||addr(swapWords[1])!==gang)return null;
  const tradeInput=BigInt('0x'+swapWords[2]),embeddedExpense=BigInt('0x'+swapWords[4]),extraExpense=BigInt('0x'+expenseWords[0]),deposited=BigInt('0x'+depositWords[0]);
  if(tradeInput<=0n||extraExpense!==BigInt('0x'+input[6])||extraExpense+tradeInput!==BigInt(tx.value)
    ||embeddedExpense!==tradeInput/100n||embeddedExpense<=0n||deposited+embeddedExpense!==tradeInput
    ||BigInt('0x'+swapWords[3])!==receivedRaw||BigInt('0x'+swapWords[5])!==4n
    ||BigInt('0x'+paymentWords[0])!==deposited||BigInt('0x'+deliveryWords[0])!==receivedRaw
    ||BigInt('0x'+poolWords[0])!==0n||BigInt('0x'+poolWords[1])!==deposited
    ||BigInt('0x'+poolWords[2])!==receivedRaw||BigInt('0x'+poolWords[3])!==0n||syncWords.some(value=>BigInt('0x'+value)<=0n))return null;
  return tradeInput+extraExpense;
 }catch{return null;}
}
export function freshNativeBuyCost(tx:FreshTransaction,wallet:string,token:string,receivedRaw:bigint,logs:FreshLog[]):bigint|null {
  const router=tx.to?.toLowerCase();wallet=wallet.toLowerCase();token=token.toLowerCase();
  if(router==='0xb300000b72deaeb607a12d5f54773d1c19c7028d')return freshGangBinanceNativeBuyCost(tx,wallet,token,receivedRaw,logs);
  if(!router||!routers.has(router)&&router!==wrapperRouter||tx.from.toLowerCase()!==wallet||receivedRaw<=0n||!/^0x[\da-f]+$/i.test(tx.value)||BigInt(tx.value)<=0n)return null;
  if(router===wrapperRouter)return wrappedPcsBuyCost(tx,wallet,token,receivedRaw,logs);
  const swaps=logs.filter(l=>l.address.toLowerCase()===router&&l.topics[0]?.toLowerCase()===topic);
  if(swaps.length!==1)return null;
  const l=swaps[0];
  if(l.removed||l.topics.length!==4||addr(l.topics[1]?.slice(2))!==wallet||addr(l.topics[2]?.slice(2))!==wallet
    ||!/^0x(?:[\da-f]{64})+$/i.test(l.data)||l.data.length>2+64*1024)return null;
  const words=l.data.slice(2).match(/.{64}/g)!;
  if(words.length<16||BigInt('0x'+words[2])!==96n||BigInt('0x'+words[3])!==1n||BigInt('0x'+words[4])!==32n
    ||addr(words[7])!==token)return null;
  const spent=BigInt('0x'+words[0]),received=BigInt('0x'+words[1]);
  if(spent!==BigInt(tx.value)||received!==receivedRaw)return null;
  if(addr(words[6])===wrappedNative)return wrappedNativeBuyCost(tx,wallet,token,receivedRaw,logs,words);
  if(addr(words[6])!==zero)return null;
  return spent;
}
