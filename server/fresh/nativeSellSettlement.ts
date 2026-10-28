import {AbiCoder} from 'ethers';
import {WBNB} from '../launchpad.js';
import {beforeExecutionTopic,userOperationTopic} from '../smartAccountTrades.js';
import {transferTopic,nativeSellProceeds} from '../swap.js';
import {freshAddress,freshInteger,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock,type FreshLog} from './capture.js';
import {validFreshCompleteCallTrace} from './passiveIncoming.js';
import type {FreshPriceBlock} from './pricing.js';
import {freshNativeDelta,validateFreshTrace,type FreshCallTrace} from './trace.js';

const wrapper='0x01a21c857a3219991fba2b1a2824b1b758966b54',pcs='0x10ed43c718714eb63d5aa57b78b54704e256024e',fixedRecipient='0xdefb37382e08d8a33abbc869a02e179cb28a0821';
const bot='0x9689992f5b5c09447f15906d8d11214944488341',botFee='0xdec29d79e8cdf009d2fa33e0558cb5648481cac3';
const withdrawalTopic='0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65',wrapperSwapTopic='0xb4ebd56706d27fa01a1b393765021ba216f704b12bb50a87bf257d3ba6cd7bdc';
const wrapperExpenseTopic='0xb948f731b5e342e038ab722853f67007c439a74137633184c1d0513b21bf5a64',botSwapTopic='0xa615c02f8d2e4ed8939b003560300a25353b784438c2efaa9f20fb5303a4d6d8';
const nativeAddress='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',coder=AbiCoder.defaultAbiCoder();
const word=(v:string|bigint)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0');
const addr=(v:string|undefined)=>v&&/^0{24}[\da-f]{40}$/.test(v)?'0x'+v.slice(-40):null;
const words=(v:string,n:number)=>new RegExp('^0x(?:[\\da-f]{64}){'+n+'}$').test(v)?v.slice(2).match(/.{64}/g)!:null;
const matches=(l:FreshLog,address:string,topic:string,actors:string[])=>l.address===address&&l.topics.length===actors.length+1&&l.topics[0]===topic&&actors.every((a,i)=>addr(l.topics[i+1].slice(2))===a);
export interface FreshNativeSellSettlement {
 version:1;kind:'closed_router_native_sale';transactionHash:string;blockNumber:number;blockHash:string;walletAddress:string;tokenAddress:string;tokenRaw:string;
 grossWithdrawnWei:string;walletReceivedWei:string;signedUpfrontExpenseWei:string;routeExpenseWei:string;netNativeWei:string;
}

/** Two closed ordinary sale families distinguish pool output, actual wallet
 * receipt and a separately signed upfront expense. The complete trace must
 * account for every native transfer and the one sold wallet asset. Net cash
 * includes each route expense once; transaction gas remains the normal fee. */
export function freshNativeSellSettlement(entry:FreshCapturedReceipt,block:FreshPriceBlock,tokenAddress:string,walletAddress:string,targetRaw:bigint,rawTrace:FreshCallTrace):FreshNativeSellSettlement|null {
 try {
  const {transaction:tx,receipt}=entry,token=freshAddress(tokenAddress),wallet=freshAddress(walletAddress),router=tx.to;
  if(!token||token===WBNB||!wallet||tx.from!==wallet||!entry.wallets.includes(wallet)||targetRaw>=0n||![wrapper,bot].includes(router??'')
   ||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||tx.chainId!=='0x38'||receipt.status!=='0x1'
   ||tx.blockHash!==block.hash||Number(freshInteger(tx.blockNumber))!==block.number||!Number.isSafeInteger(block.number)||!Number.isFinite(Date.parse(block.timestamp))
   ||receipt.logs.length>512||receipt.logs.some(l=>[beforeExecutionTopic,userOperationTopic].includes(l.topics[0])))return null;
  validateFreshReceipt(receipt,tx,{number:tx.blockNumber,hash:block.hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)} as FreshBlock);
  const trace=validateFreshTrace(rawTrace);if(!validFreshCompleteCallTrace(entry,trace))return null;
  const sold=-targetRaw,upfront=freshInteger(tx.value),cash:FreshCallTrace[]=[],nodes:FreshCallTrace[]=[];
  function visit(c:FreshCallTrace,context?:string,parentValue=0n){
   if(c.error||!['CALL','STATICCALL','DELEGATECALL'].includes(c.type)||!c.to||context!==undefined&&c.from!==context
    ||c.type==='STATICCALL'&&freshInteger(c.value??'0x0')!==0n||c.type==='DELEGATECALL'&&freshInteger(c.value??'0x0')!==parentValue)throw Error('native_sale_call_context');
   if(context!==undefined&&c.from===wallet||context!==undefined&&c.to===wallet&&(c.type!=='CALL'||c.from!==router||c.input!=='0x'||c.calls?.length))throw Error('native_sale_wallet_action');
   nodes.push(c);if(c.type==='CALL'&&c.from!==c.to&&freshInteger(c.value??'0x0')>0n)cash.push(c);
   c.calls?.forEach(child=>visit(child,c.type==='DELEGATECALL'?c.from:c.to,freshInteger(c.value??'0x0')));
  }visit(trace);
  let moved=0n,walletMovements=0;
  for(const l of receipt.logs){if(l.topics[0]!==transferTopic)continue;const from=addr(l.topics[1]?.slice(2)),to=addr(l.topics[2]?.slice(2));if(from!==wallet&&to!==wallet)continue;
   if(l.topics.length!==3||!words(l.data,1)||!from||!to)return null;const amount=BigInt(l.data);if(amount===0n)continue;
   if(l.address!==token||from!==wallet||to!==router)return null;moved+=amount;walletMovements++;
  }
  const tokenPayment=nodes.filter(c=>c.type==='CALL'&&c.from===router&&c.to===token&&c.input==='0x23b872dd'+word(wallet)+word(router!)+word(sold)&&c.output==='0x'+word(1n));
  if(moved!==sold||walletMovements!==1||tokenPayment.length!==1)return null;
  const withdrawals=receipt.logs.filter(l=>l.address===WBNB&&l.topics[0]===withdrawalTopic);
  if(withdrawals.length!==1||!words(withdrawals[0].data,1))return null;
  const gross=BigInt(withdrawals[0].data),withdrawer=router===wrapper?pcs:bot;
  if(gross<=0n||!matches(withdrawals[0],WBNB,withdrawalTopic,[withdrawer]))return null;
  const unwrap=nodes.filter(c=>c.type==='CALL'&&c.from===withdrawer&&c.to===WBNB&&freshInteger(c.value??'0x0')===0n&&c.input==='0x2e1a7d4d'+word(gross));
  const funding=cash.filter(c=>c.from===WBNB&&c.to===withdrawer&&freshInteger(c.value!)===gross&&c.input==='0x');
  const payouts=cash.filter(c=>c.from===router&&c.to===wallet&&c.input==='0x');
  if(unwrap.length!==1||funding.length!==1||payouts.length!==1)return null;
  const paid=freshInteger(payouts[0].value!);let fee=0n;
  if(router===wrapper){
   if(typeof tx.input!=='string'||!/^0xa21413d8(?:[\da-f]{64}){13}$/.test(tx.input)||receipt.logs.length!==9)return null;
   const input=tx.input.slice(10).match(/.{64}/g)!;
   if(addr(input[0])!==token||BigInt('0x'+input[1])!==4n||BigInt('0x'+input[2])!==sold||BigInt('0x'+input[3])<=0n||BigInt('0x'+input[3])>paid
    ||BigInt('0x'+input[4])<BigInt(Math.floor(Date.parse(block.timestamp)/1000))||BigInt('0x'+input[5])!==256n||addr(input[6])!==fixedRecipient
    ||upfront!==300000000000000n||BigInt('0x'+input[7])!==upfront||BigInt('0x'+input[8])!==128n||BigInt('0x'+input[9])!==32n||BigInt('0x'+input[10])!==2n||addr(input[11])!==token||addr(input[12])!==WBNB)return null;
   const expense=receipt.logs.filter(l=>matches(l,wrapper,wrapperExpenseTopic,[wallet,fixedRecipient])),swaps=receipt.logs.filter(l=>matches(l,wrapper,wrapperSwapTopic,[wallet]));
   if(expense.length!==1||!words(expense[0].data,1)||BigInt(expense[0].data)!==upfront||swaps.length!==1)return null;
   const swap=words(swaps[0].data,6);if(!swap||addr(swap[0])!==token||addr(swap[1])!==nativeAddress||BigInt('0x'+swap[2])!==sold||BigInt('0x'+swap[3])!==paid||BigInt('0x'+swap[5])!==4n)return null;
   fee=BigInt('0x'+swap[4]);if(fee<=0n||fee!==gross/100n||paid+fee!==gross||nativeSellProceeds(wallet,sold,receipt.logs,wrapper,token)!==paid)return null;
   const expenseCalls=cash.filter(c=>c.from===wrapper&&c.to===fixedRecipient&&freshInteger(c.value!)===upfront&&c.input==='0x');
   const grossCalls=cash.filter(c=>c.from===pcs&&c.to===wrapper&&freshInteger(c.value!)===gross&&c.input==='0x');
   const routeFees=cash.filter(c=>c.from===wrapper&&c.to!==wallet&&c.to!==fixedRecipient&&freshInteger(c.value!)===fee&&c.input==='0x');
   if(cash.length!==6||cash[0]!==trace||expenseCalls.length!==1||grossCalls.length!==1||routeFees.length!==1)return null;
  }else{
   if(upfront!==0n||typeof tx.input!=='string'||!tx.input.startsWith('0x3e0f9c3c'))return null;
   const types=['bytes','bytes[]','uint256'],data='0x'+tx.input.slice(10),args=coder.decode(types,data);
   if(coder.encode(types,args)!==data||args[0]!=='0x1b0023'||args[1].length!==3||args[2]<BigInt(Math.floor(Date.parse(block.timestamp)/1000)))return null;
   const first=words(args[1][0],3);if(!first||addr(first[0])!==token||BigInt('0x'+first[1])!==sold||!addr(first[2]))return null;
   const swaps=receipt.logs.filter(l=>matches(l,bot,botSwapTopic,[]));if(swaps.length!==1)return null;
   const swap=words(swaps[0].data,2);if(!swap||BigInt('0x'+swap[0])!==sold||BigInt('0x'+swap[1])!==paid)return null;
   const incoming=receipt.logs.filter(l=>matches(l,WBNB,transferTopic,[addr(l.topics[1]?.slice(2))??'',bot]));
   if(incoming.length!==1||!words(incoming[0].data,1)||BigInt(incoming[0].data)!==gross)return null;
   const fees=cash.filter(c=>c.from===bot&&c.to===botFee&&c.input?.startsWith('0x98b1e06a'));
   if(fees.length!==1||cash.length!==3)return null;fee=freshInteger(fees[0].value!);
   if(fee<=0n||fee!==gross/100n||paid+fee!==gross)return null;
  }
  const net=paid-upfront;if(net<=0n||freshNativeDelta(trace,wallet)!==net)return null;
  return{version:1,kind:'closed_router_native_sale',transactionHash:tx.hash,blockNumber:block.number,blockHash:block.hash,walletAddress:wallet,tokenAddress:token,tokenRaw:String(sold),grossWithdrawnWei:String(gross),walletReceivedWei:String(paid),signedUpfrontExpenseWei:String(upfront),routeExpenseWei:String(fee),netNativeWei:String(net)};
 }catch{return null;}
}
