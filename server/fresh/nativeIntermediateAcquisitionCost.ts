import{createHash}from'node:crypto';
import{Interface}from'ethers';
import{FOUR_MANAGERS,WBNB,PCS_V2_FACTORY}from'../launchpad.js';
import{fourMarketAbi}from'../nodeMarketProtocols.js';
import{beforeExecutionTopic,userOperationTopic}from'../smartAccountTrades.js';
import{transferTopic}from'../swap.js';
import{FreshRational}from'./accounting.js';
import{freshAddress,freshInteger,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock}from'./capture.js';
import{freshPoolNativePair}from'./currentPoolQuote.js';
import{validFreshCompleteCallTrace}from'./passiveIncoming.js';
import type{FreshPriceBlock}from'./pricing.js';
import{freshNativeDelta,validateFreshTrace,type FreshCallTrace}from'./trace.js';
import{freshNativeControllerAcquisitionCost}from'./nativeControllerAcquisitionCost.js';
import{freshNativeV3IntermediateAcquisitionCost}from'./nativeV3IntermediateAcquisitionCost.js';

const router='0x1de460f363af910f51726def188f9004276bf4bc',delegate='0xcaf89804ee9bd32b26ab982a6813375ed206a141',deductionRecipient='0xe3ed4c49c9807367784ab0d0d087d8a6815e7427',zero='0x'+'0'.repeat(40);
const depositTopic='0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',swapTopic='0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const routerSwapTopic='0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a',deductionTopic='0x205442d60b70af1203d43cab62352c3b69b94f091be32fe683198057282b5c92';
const word=(v:string|bigint)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0');
const address=(v:string|undefined)=>v&&/^0{24}[\da-f]{40}$/.test(v)?'0x'+v.slice(-40):null;
const words=(v:string,n:number)=>new RegExp('^0x(?:[\\da-f]{64}){'+n+'}$').test(v)?v.slice(2).match(/.{64}/g)!:null;
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const sha=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
const poolAbi=new Interface(['function swap(uint256 amount0Out,uint256 amount1Out,address to,bytes data)']);
type Node={call:FreshCallTrace;path:number[];order:number};
export interface FreshNativeIntermediateAcquisitionCost{
 version:1;kind:'same_execution_native_intermediate_acquisition_cost';observation:'actual_acquired_cost';route:'direct_wrapped_intermediate_v2'|'direct_wrapped_intermediate_v3'|'stable_v2_v3_controller';
 payment:{version:1;kind:'wallet_native_purchase_with_intermediate_change';transactionHash:string;blockNumber:number;blockHash:string;walletAddress:string;tokenAddress:string;tokenRaw:string;quoteAddress:string;acquiredQuoteRaw:string;spentQuoteRaw:string;changeRaw:string;nativeSpentWei:string;gasFeeWei:string;controller:string};
 poolAddress:string;wrappedNativeWei:string;nativeRouterDeductionWei:string;nativeRouterDeductionRecipient:string;nativePriceUsd:string;
 grossCostUsd:string;retainedQuoteCostUsd:string;amountUsd:string;grossCostQ:string;retainedQuoteCostQ:string;amountQ:string;
 traceSha256:string;contextSha256:string;proofSha256:string;
 calls:{deduction:number[];deposit:number[];wrappedPayment:number[];quoteAcquisition:number[];beforeAcquisitionBalance?:number[];beforePaymentBalance:number[];payment:number[];afterPaymentBalance:number[];change:number[];commissionPayment?:number[];stableAcquisition?:number[];stablePayment?:number[];stableSwap?:number[];quoteSwap?:number[];quoteCallback?:number[];quoteFactory?:number[]};
}

export function freshNativeIntermediateAcquisitionCost(entry:FreshCapturedReceipt,block:FreshPriceBlock,tokenAddress:string,walletAddress:string,targetRaw:bigint,nativePriceUsd:string):FreshNativeIntermediateAcquisitionCost|null{
 return directIntermediateCost(entry,block,tokenAddress,walletAddress,targetRaw,nativePriceUsd)??freshNativeControllerAcquisitionCost(entry,block,tokenAddress,walletAddress,targetRaw,nativePriceUsd)??freshNativeV3IntermediateAcquisitionCost(entry,block,tokenAddress,walletAddress,targetRaw,nativePriceUsd);
}

/** The quote's units cancel in an allocation of actual acquired cost. This is
 * not a market price or quote admission: only a signed two-leg native purchase,
 * an authenticated PCS V2 acquisition and one FourMeme purchase are supported.
 * Full original cash/token/balance conservation preserves real returned change
 * and excludes previously held router or wallet units without reading metadata. */
function directIntermediateCost(entry:FreshCapturedReceipt,block:FreshPriceBlock,tokenAddress:string,walletAddress:string,targetRaw:bigint,nativePriceUsd:string):FreshNativeIntermediateAcquisitionCost|null{
 try{
  const{transaction:tx,receipt}=entry,token=freshAddress(tokenAddress),wallet=freshAddress(walletAddress);
  if(!token||!wallet||targetRaw<=0n||tx.from!==wallet||tx.to!==router||!entry.wallets.includes(wallet)||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||tx.chainId!=='0x38'
   ||receipt.status!=='0x1'||typeof tx.input!=='string'||!/^0x4d819a2a(?:[\da-f]{64}){35}$/.test(tx.input)||!entry.trace||!Number.isSafeInteger(block.number)||!Number.isFinite(Date.parse(block.timestamp))
   ||Number(freshInteger(tx.blockNumber))!==block.number||tx.blockHash!==block.hash||receipt.logs.length>128||receipt.logs.some(l=>[beforeExecutionTopic,userOperationTopic].includes(l.topics[0])))return null;
  validateFreshReceipt(receipt,tx,{number:tx.blockNumber,hash:block.hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)}as FreshBlock);
  const trace=validateFreshTrace(entry.trace);if(!validFreshCompleteCallTrace(entry,trace))return null;
  const input=tx.input.slice(10).match(/.{64}/g)!,quote=address(input[10]),pool=address(input[11]),gross=freshInteger(tx.value);
  if(!quote||!pool||[token,wallet,router,WBNB,zero].includes(quote)||pool!==freshPoolNativePair(quote)||[wallet,router,WBNB,zero].includes(token)||gross<=0n||freshNativeDelta(trace,wallet)!==-gross)return null;
  const expected:Record<number,bigint|string>={0:160n,1:0n,2:gross,5:2n,6:64n,7:416n,8:0n,9:WBNB,10:quote,11:pool,12:2500n,13:50n,14:0n,15:320n,16:0n,17:0n,18:0n,19:5n,20:quote,21:token,22:token,23:0n,24:0n,25:0n,26:320n,27:0n,28:0n,29:160n,30:1n,31:0n,32:quote,33:100n,34:deductionRecipient};
  if(Object.entries(expected).some(([i,v])=>input[Number(i)]!==word(v))||BigInt('0x'+input[3])<=0n||BigInt('0x'+input[3])>targetRaw||BigInt('0x'+input[4])<BigInt(Math.floor(Date.parse(block.timestamp)/1000)))return null;
  const nodes:Node[]=[],cash:Node[]=[];
  function visit(c:FreshCallTrace,path:number[],context?:string,parentValue=0n){
   if(c.error||!['CALL','STATICCALL','DELEGATECALL'].includes(c.type)||!freshAddress(c.to)||context!==undefined&&c.from!==context||c.type==='STATICCALL'&&freshInteger(c.value??'0x0')!==0n||c.type==='DELEGATECALL'&&freshInteger(c.value??'0x0')!==parentValue)throw Error('intermediate_call_context');
   if(path.length&&(c.from===wallet||c.to===wallet))throw Error('intermediate_wallet_code');
   const n={call:c,path,order:nodes.length};nodes.push(n);if(c.type==='CALL'&&c.from!==c.to&&freshInteger(c.value??'0x0')>0n)cash.push(n);
   c.calls?.forEach((child,i)=>visit(child,[...path,i],c.type==='DELEGATECALL'?c.from:c.to,freshInteger(c.value??'0x0')));
  }visit(trace,[]);
  if(trace.calls?.length!==1||trace.calls[0].type!=='DELEGATECALL'||trace.calls[0].to!==delegate||trace.calls[0].input!==tx.input)return null;
  const unique=(p:(c:FreshCallTrace)=>boolean)=>{const a=nodes.filter(n=>p(n.call));return a.length===1?a[0]:null;};
  const deduction=cash.filter(n=>n.call.from===router&&n.call.to===deductionRecipient&&n.call.input==='0x'),deposit=cash.filter(n=>n.call.from===router&&n.call.to===WBNB&&n.call.input==='0xd0e30db0');
  if(cash.length!==3||cash[0].call!==trace||deduction.length!==1||deposit.length!==1)return null;
  const deducted=freshInteger(deduction[0].call.value!),wrapped=freshInteger(deposit[0].call.value!);
  if(deducted<=0n||deducted!==gross/100n||wrapped<=0n||wrapped+deducted!==gross)return null;
  const moves:{asset:string;from:string;to:string;raw:bigint;index:number}[]=[];
  for(const l of receipt.logs){if(l.topics[0]!==transferTopic)continue;if(l.topics.length!==3||!words(l.data,1))return null;const from=address(l.topics[1].slice(2)),to=address(l.topics[2].slice(2));if(!from||!to)return null;
   const raw=BigInt(l.data);if(raw===0n)continue;if(![WBNB,quote,token].includes(l.address)||from===to)return null;moves.push({asset:l.address,from,to,raw,index:Number(freshInteger(l.logIndex))});}
  const walletMoves=moves.filter(m=>m.from===wallet||m.to===wallet),delivery=walletMoves.filter(m=>m.asset===token&&m.to===wallet&&FOUR_MANAGERS.includes(m.from)),returned=walletMoves.filter(m=>m.asset===quote&&m.from===router&&m.to===wallet);
  if(walletMoves.length!==2||delivery.length!==1||delivery[0].raw!==targetRaw||returned.length!==1)return null;
  const controller=delivery[0].from,quoteMoves=moves.filter(m=>m.asset===quote&&(m.from===router||m.to===router)),acquired=quoteMoves.filter(m=>m.from===pool&&m.to===router),paid=quoteMoves.filter(m=>m.from===router&&m.to===controller);
  if(quoteMoves.length!==3||acquired.length!==1||paid.length!==1||acquired[0].raw!==paid[0].raw+returned[0].raw||!(acquired[0].index<paid[0].index&&paid[0].index<delivery[0].index&&delivery[0].index<returned[0].index))return null;
  const wrappedMoves=moves.filter(m=>m.asset===WBNB);if(wrappedMoves.length!==1||wrappedMoves[0].from!==router||wrappedMoves[0].to!==pool||wrappedMoves[0].raw!==wrapped||wrappedMoves[0].index>=acquired[0].index)return null;
  const transfer=(asset:string,from:string,to:string,raw:bigint)=>unique(c=>c.type==='CALL'&&c.from===from&&c.to===asset&&c.input==='0xa9059cbb'+word(to)+word(raw)&&c.output==='0x'+word(1n));
  const wrappedPayment=transfer(WBNB,router,pool,wrapped),quoteAcquisition=transfer(quote,pool,router,acquired[0].raw),change=transfer(quote,router,wallet,returned[0].raw),targetDelivery=transfer(token,controller,wallet,targetRaw);
  const payment=unique(c=>c.type==='CALL'&&c.from===controller&&c.to===quote&&c.input==='0x23b872dd'+word(router)+word(controller)+word(paid[0].raw)&&c.output==='0x'+word(1n));
  const beforePayment=nodes.filter(n=>n.call.type==='STATICCALL'&&n.call.from===router&&n.call.to===quote&&n.call.input==='0x70a08231'+word(router)&&n.call.output==='0x'+word(acquired[0].raw));
  const beforeAcquisition=unique(c=>c.type==='STATICCALL'&&c.from===router&&c.to===quote&&c.input==='0x70a08231'+word(router)&&c.output==='0x'+word(0n));
  const after=unique(c=>c.type==='STATICCALL'&&c.from===router&&c.to===quote&&c.input==='0x70a08231'+word(router)&&c.output==='0x'+word(returned[0].raw));
  if(!wrappedPayment||!quoteAcquisition||!change||!targetDelivery||!payment||!beforeAcquisition||!beforePayment.length||!after)return null;
  const before=beforePayment[beforePayment.length-1];
  if(!(deduction[0].order<deposit[0].order&&deposit[0].order<wrappedPayment.order&&wrappedPayment.order<beforeAcquisition.order&&beforeAcquisition.order<quoteAcquisition.order&&quoteAcquisition.order<before.order&&before.order<payment.order&&payment.order<targetDelivery.order&&targetDelivery.order<after.order&&after.order<change.order))return null;
  const swaps=nodes.filter(n=>n.call.type==='CALL'&&n.call.from===router&&n.call.to===pool&&n.call.input?.startsWith('0x022c0d9f'));
  if(swaps.length!==1)return null;const quote0=quote<WBNB,swapInput=poolAbi.encodeFunctionData('swap',[quote0?acquired[0].raw:0n,quote0?0n:acquired[0].raw,router,'0x']);
  if(swaps[0].call.input!==swapInput||!quoteAcquisition.path.slice(0,swaps[0].path.length).every((v,i)=>v===swaps[0].path[i])||quoteAcquisition.path.length!==swaps[0].path.length+1)return null;
  const factory=unique(c=>c.type==='STATICCALL'&&c.from===router&&c.to===pool&&c.input==='0xc45a0155'&&c.output==='0x'+word(PCS_V2_FACTORY));if(!factory)return null;
  const swapLogs=receipt.logs.filter(l=>l.address===pool&&l.topics[0]===swapTopic),deposits=receipt.logs.filter(l=>l.address===WBNB&&l.topics[0]===depositTopic),settled=receipt.logs.filter(l=>l.address===router&&l.topics[0]===routerSwapTopic),deductions=receipt.logs.filter(l=>l.address===router&&l.topics[0]===deductionTopic);
  if(swapLogs.length!==1||deposits.length!==1||settled.length!==1||deductions.length!==1)return null;
  const s=swapLogs[0],sw=words(s.data,4),d=deposits[0],end=settled[0],ew=words(end.data,33),f=deductions[0],fw=words(f.data,2);
  if(!sw||s.topics.length!==3||address(s.topics[1].slice(2))!==router||address(s.topics[2].slice(2))!==router||sw.some((v,i)=>BigInt('0x'+v)!==[quote0?0n:wrapped,quote0?wrapped:0n,quote0?acquired[0].raw:0n,quote0?0n:acquired[0].raw][i])
   ||d.topics.length!==2||address(d.topics[1].slice(2))!==router||!words(d.data,1)||BigInt(d.data)!==wrapped
   ||!ew||end.topics.length!==4||address(end.topics[1].slice(2))!==wallet||address(end.topics[2].slice(2))!==wallet||address(end.topics[3].slice(2))!==zero||BigInt('0x'+ew[0])!==gross||BigInt('0x'+ew[1])!==targetRaw||BigInt('0x'+ew[2])!==96n||ew.slice(3).join('')!==input.slice(5).join('')
   ||!fw||f.topics.length!==3||address(f.topics[1].slice(2))!==zero||address(f.topics[2].slice(2))!==wallet||BigInt('0x'+fw[0])!==deducted)return null;
  const actions=receipt.logs.filter(l=>FOUR_MANAGERS.includes(l.address)&&[fourMarketAbi.getEvent('TokenPurchase')!.topicHash,fourMarketAbi.getEvent('TokenSale')!.topicHash].includes(l.topics[0]));
  if(actions.length!==1||actions[0].address!==controller)return null;const action=fourMarketAbi.parseLog(actions[0]);if(!action||action.name!=='TokenPurchase'||String(action.args.token).toLowerCase()!==token||String(action.args.account).toLowerCase()!==wallet||BigInt(action.args.amount)!==targetRaw)return null;
  const encoded=fourMarketAbi.encodeEventLog(action.fragment,action.args);if(encoded.data!==actions[0].data||JSON.stringify(encoded.topics)!==JSON.stringify(actions[0].topics))return null;
  const gas=freshInteger(receipt.gasUsed)*freshInteger(receipt.effectiveGasPrice??tx.gasPrice),price=FreshRational.parse(nativePriceUsd);if(gas<=0n||price.n<=0n)return null;
  const cost=new FreshRational(gross,10n**18n).mul(price),retained=cost.mul(new FreshRational(returned[0].raw,acquired[0].raw)),spent=cost.sub(retained);if(spent.n<=0n)return null;
  const value:Omit<FreshNativeIntermediateAcquisitionCost,'proofSha256'>={version:1,kind:'same_execution_native_intermediate_acquisition_cost',observation:'actual_acquired_cost',route:'direct_wrapped_intermediate_v2',payment:{version:1,kind:'wallet_native_purchase_with_intermediate_change',transactionHash:tx.hash,blockNumber:block.number,blockHash:block.hash,walletAddress:wallet,tokenAddress:token,tokenRaw:String(targetRaw),quoteAddress:quote,acquiredQuoteRaw:String(acquired[0].raw),spentQuoteRaw:String(paid[0].raw),changeRaw:String(returned[0].raw),nativeSpentWei:String(gross),gasFeeWei:String(gas),controller},poolAddress:pool,wrappedNativeWei:String(wrapped),nativeRouterDeductionWei:String(deducted),nativeRouterDeductionRecipient:deductionRecipient,nativePriceUsd,grossCostUsd:cost.decimal(),retainedQuoteCostUsd:retained.decimal(),amountUsd:spent.decimal(),grossCostQ:cost.exact(),retainedQuoteCostQ:retained.exact(),amountQ:spent.exact(),traceSha256:sha(trace),contextSha256:sha({transaction:tx,receipt,wallets:entry.wallets,historicalWallets:entry.historicalWallets,observedAt:entry.observedAt}),calls:{deduction:deduction[0].path,deposit:deposit[0].path,wrappedPayment:wrappedPayment.path,quoteAcquisition:quoteAcquisition.path,beforeAcquisitionBalance:beforeAcquisition.path,beforePaymentBalance:before.path,payment:payment.path,afterPaymentBalance:after.path,change:change.path}};
  return{...value,proofSha256:sha(value)};
 }catch{return null;}
}
