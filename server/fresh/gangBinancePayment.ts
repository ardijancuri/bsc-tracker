import type{FreshTransaction,FreshLog}from'./capture.js';
const gang='0x0c6302401aa5325c2e36f170f52c00b1d220b405',pair='0x0bd5ded695d61c2db15c703c345d57e039fd0b6d',bnb='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const router='0xb300000b72deaeb607a12d5f54773d1c19c7028d',executor='0x3d90f66b534dd8482b181e24655a9e8265316be9',poolExecutor='0x8086c0d903ed072cd7362b79b314347c57a3c77d';
const feeTopic='0xf228de527fc1b9843baac03b9a04565473a263375950e63435d4138464386f46',outputTopic='0xe5b9f85c5caca875a8b78e5b2d88de86d7793cbff3d81ea4ecbec4c2b9ad7beb';
const depositTopic='0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const swapTopic='0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',syncTopic='0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const zero='0x'+'0'.repeat(40),native='0x'+'e'.repeat(40),outerFlags='b000000000000000000000320000000000000000000000000000000000000000';
const packedPool='800000000000000000002710'+pair.slice(2);
const address=(word:string|undefined)=>word&&/^0{24}[\da-f]{40}$/.test(word)?'0x'+word.slice(-40):null;
const word=(value:string|bigint)=>typeof value==='bigint'?value.toString(16).padStart(64,'0'):value.slice(2).padStart(64,'0');
const words=(data:string,count:number)=>new RegExp('^0x(?:[\\da-f]{64}){'+count+'}$','i').test(data)?data.slice(2).toLowerCase().match(/.{64}/g)!:null;
/** One authenticated native exact-input Binance route to the pinned GANG
 * market. The already supported fee/output emitters, signed one-pool route,
 * actual deposit and final delivery must all agree. No tx.value fallback. */
export function freshGangBinanceNativeBuyCost(tx:FreshTransaction,wallet:string,token:string,receivedRaw:bigint,logs:FreshLog[]):bigint|null{
 try{
  if(tx.to?.toLowerCase()!==router||tx.from.toLowerCase()!==wallet||token!==gang||receivedRaw<=0n||tx.chainId!=='0x38'
    ||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||logs.length!==8
    ||typeof tx.input!=='string'||!/^0x810c705b(?:[\da-f]{64}){46}$/i.test(tx.input)||!/^0x[\da-f]+$/i.test(tx.value))return null;
  const input=tx.input.toLowerCase(),outer=input.slice(10).match(/.{64}/g)!,gross=BigInt(tx.value),feeRecipient=address(outer[0]);
  if(!feeRecipient||feeRecipient===zero||address(outer[1])!==executor||outer[2]!==outerFlags||BigInt('0x'+outer[3])!==gross||gross<=0n
    ||address(outer[4])!==gang||BigInt('0x'+outer[5])<=0n||BigInt('0x'+outer[5])>receivedRaw||BigInt('0x'+outer[6])!==224n||BigInt('0x'+outer[7])!==1188n)return null;
  const nested=input.slice(10+8*64,10+8*64+1188*2);
  if(!nested.startsWith('47ee97ff')||!/^0*$/.test(input.slice(10+8*64+1188*2)))return null;
  const route=words('0x'+nested.slice(8),37);if(!route)return null;
  const net=BigInt('0x'+route[8]),minimum=BigInt('0x'+outer[5]);
  const expected:(string|bigint|null)[]=[null,0n,0n,0n,null,0n,native,gang,net,minimum,null,448n,512n,1088n,1n,net,1n,32n,1n,32n,160n,224n,288n,352n,bnb,1n,poolExecutor,1n,pair,1n,null,1n,32n,0n,0n,0n,0n];
  if(expected.some((value,index)=>value!==null&&route[index]!==word(value))||BigInt('0x'+route[0])<=0n||BigInt('0x'+route[4])<=0n
    ||BigInt('0x'+route[4])>receivedRaw||BigInt('0x'+route[10])<=0n||route[30]!==packedPool||net<=0n)return null;
  if(!/^0x[\da-f]{64}$/i.test(tx.hash)||!/^0x[\da-f]{64}$/i.test(tx.blockHash)||!/^0x[\da-f]+$/i.test(tx.blockNumber)||!/^0x[\da-f]+$/i.test(tx.transactionIndex))return null;
  let previous=-1n;for(const log of logs){
   if(log.removed||log.transactionHash?.toLowerCase()!==tx.hash.toLowerCase()||log.blockHash?.toLowerCase()!==tx.blockHash.toLowerCase()
    ||!/^0x[\da-f]+$/i.test(log.blockNumber)||BigInt(log.blockNumber)!==BigInt(tx.blockNumber)||!/^0x[\da-f]+$/i.test(log.transactionIndex)
    ||BigInt(log.transactionIndex)!==BigInt(tx.transactionIndex)||!/^0x[\da-f]+$/i.test(log.logIndex)||BigInt(log.logIndex)<=previous)return null;previous=BigInt(log.logIndex);
  }
  const matches=(log:FreshLog,emitter:string,signature:string,addresses:string[])=>log.address.toLowerCase()===emitter&&log.topics.length===addresses.length+1
    &&log.topics[0]?.toLowerCase()===signature&&addresses.every((value,index)=>address(log.topics[index+1]?.slice(2))===value);
  const[fee,deposit,payment,poolDelivery,sync,poolSwap,output,delivery]=logs;
  if(!matches(fee,router,feeTopic,[zero])||!matches(deposit,bnb,depositTopic,[executor])||!matches(payment,bnb,transferTopic,[executor,pair])
    ||!matches(poolDelivery,gang,transferTopic,[pair,router])||!matches(sync,pair,syncTopic,[])||!matches(poolSwap,pair,swapTopic,[poolExecutor,router])
    ||!matches(output,executor,outputTopic,[])||!matches(delivery,gang,transferTopic,[router,wallet]))return null;
  const feeWords=words(fee.data,2),depositWords=words(deposit.data,1),paymentWords=words(payment.data,1),poolDeliveryWords=words(poolDelivery.data,1),syncWords=words(sync.data,2),
    poolWords=words(poolSwap.data,4),outputWords=words(output.data,6),deliveryWords=words(delivery.data,1);
  if(!feeWords||!depositWords||!paymentWords||!poolDeliveryWords||!syncWords||!poolWords||!outputWords||!deliveryWords)return null;
  const expense=BigInt('0x'+feeWords[1]);
  if(address(feeWords[0])!==feeRecipient||expense<=0n||expense!==gross/200n||expense+net!==gross
    ||BigInt('0x'+depositWords[0])!==net||BigInt('0x'+paymentWords[0])!==net||BigInt('0x'+poolDeliveryWords[0])!==receivedRaw||BigInt('0x'+deliveryWords[0])!==receivedRaw
    ||BigInt('0x'+poolWords[0])!==0n||BigInt('0x'+poolWords[1])!==net||BigInt('0x'+poolWords[2])!==receivedRaw||BigInt('0x'+poolWords[3])!==0n
    ||outputWords[0]!==route[0]||address(outputWords[1])!==native||address(outputWords[2])!==gang||address(outputWords[3])!==wallet
    ||BigInt('0x'+outputWords[4])!==net||BigInt('0x'+outputWords[5])!==receivedRaw||syncWords.some(value=>BigInt('0x'+value)<=0n))return null;
  return gross;
 }catch{return null;}
}
