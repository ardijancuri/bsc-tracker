import {createHash} from 'node:crypto';
import {AbiCoder,Signature,Transaction,verifyAuthorization} from 'ethers';
import {FLAP_PORTAL,WBNB} from '../launchpad.js';
import {flapMarketAbi,v3MarketAbi} from '../nodeMarketProtocols.js';
import {beforeExecutionTopic,userOperationTopic} from '../smartAccountTrades.js';
import {transferTopic} from '../swap.js';
import {freshAddress,freshHash,freshInteger,validateFreshReceipt,type FreshBlock,type FreshCapturedReceipt} from './capture.js';
import type {FreshPriceBlock} from './pricing.js';
import {freshNativeDelta,freshTraceMatchesTransaction,validateFreshTrace,type FreshCallTrace} from './trace.js';

export const FRESH_SIGNED_BATCH_DELEGATE='0xba8b8e5d32d690586f00a8d962144843e31ee038';
const router='0x13f4ea83d0bd40e75c8222255bc855a974568dd4',zero='0x'+'0'.repeat(40),selector='0xb0da329a';
const batchType='tuple(address target,uint256 value,bytes data,bytes extra)[]',abi=AbiCoder.defaultAbiCoder();
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const sha=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
const word=(v:string|bigint)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0');
const topicAddress=(v:string|undefined)=>v&&/^0x0{24}[\da-f]{40}$/.test(v)?'0x'+v.slice(-40):null;
const success=(c:FreshCallTrace)=>c.output==='0x'+word(1n);
const signatureWord=(value:unknown)=>'0x'+freshInteger(value).toString(16).padStart(64,'0');
interface Movement{from:string;to:string;raw:bigint;index:number}
export interface FreshSignedBatchNativeBuyPayment {
  version:1;kind:'signed_batch_native_buy_with_quote_change';expensePolicy:'signed_batch_trade_expenses_v1';
  transactionHash:string;blockNumber:number;blockHash:string;transactionIndex:number;walletAddress:string;tokenAddress:string;tokenRaw:string;
  quoteAddress:string;quoteSourcePool:string;quoteSourcePoolLogIndex:number;quoteAcquiredRaw:string;quoteSpentRaw:string;quoteRemainingRaw:string;
  acquisitionNativeWei:string;extraNativeWei:string;totalWalletNativeWei:string;gasFeeWei:string;authDelegate:string;authorizationNonce:string;
  expensePayments:{path:number[];recipient:string;nativeWei:string}[];tokenTransferLogIndices:number[];quoteTransferLogIndices:number[];
  inputSha256:string;traceSha256:string;logsSha256:string;
  calls:{acquisition:number[];quoteAcquisition:number[];quotePayment:number[];tokenDelivery:number[]};
}

/** Proves actual raw settlement only. The signed self-call's outer value and
 * DELEGATECALL value fields are not additional cash payments. The user's
 * explicit expense policy covers the separate signed native payment; this
 * module does not claim it is a protocol fee or infer its amount/percentage.
 * Quote precision, historical conversion and valuation are separate proofs. */
export function freshSignedBatchNativeBuyPayment(entry:FreshCapturedReceipt,block:FreshPriceBlock,tokenAddress:string,walletAddress:string,targetRaw:bigint):FreshSignedBatchNativeBuyPayment|null {
  try {
    const {transaction:tx,receipt}=entry,token=freshAddress(tokenAddress),wallet=freshAddress(walletAddress),auths=tx.authorizationList as Record<string,unknown>[];
    if(!token||!wallet||token===wallet||token===WBNB||token===zero||tx.type!=='0x4'||tx.from!==wallet||tx.to!==wallet||!entry.wallets.includes(wallet)
      ||receipt.status!=='0x1'||targetRaw<=0n||!entry.trace||!Array.isArray(auths)||auths.length!==1||freshInteger(tx.chainId)!==56n
      ||!freshHash(tx.hash)||!freshHash(block.hash)||tx.blockHash!==block.hash||Number(freshInteger(tx.blockNumber))!==block.number
      ||!Number.isSafeInteger(block.number)||block.number<0||!Number.isFinite(Date.parse(block.timestamp))||!Array.isArray(receipt.logs)||receipt.logs.length>2048
      ||typeof tx.input!=='string'||!/^0xb0da329a(?:[\da-f]{2})+$/.test(tx.input)||tx.input.length>2+64*1024)return null;
    const nonce=freshInteger(tx.nonce),auth=auths[0],authNonce=freshInteger(auth.nonce),parity=Number(freshInteger(auth.yParity)),txParity=Number(freshInteger(tx.yParity));
    const authSignature=Signature.from({r:signatureWord(auth.r),s:signatureWord(auth.s),yParity:parity as 0|1}),signature=Signature.from({r:signatureWord(tx.r),s:signatureWord(tx.s),yParity:txParity as 0|1});
    if(nonce>BigInt(Number.MAX_SAFE_INTEGER)||freshInteger(auth.chainId)!==56n||authNonce!==nonce+1n||auth.address!==FRESH_SIGNED_BATCH_DELEGATE
      ||![0,1].includes(parity)||![0,1].includes(txParity)||freshInteger(tx.v)!==BigInt(txParity)
      ||verifyAuthorization({address:String(auth.address),chainId:56n,nonce:authNonce},authSignature).toLowerCase()!==wallet)return null;
    const signed=Transaction.from({type:4,chainId:56n,to:wallet,nonce:Number(nonce),gasLimit:freshInteger(tx.gas),
      maxFeePerGas:freshInteger(tx.maxFeePerGas),maxPriorityFeePerGas:freshInteger(tx.maxPriorityFeePerGas),value:freshInteger(tx.value),data:tx.input,
      accessList:tx.accessList as [],authorizationList:[{address:String(auth.address),chainId:56n,nonce:authNonce,signature:authSignature}],signature});
    if(signed.hash!==tx.hash||signed.from?.toLowerCase()!==wallet||!Array.isArray(tx.accessList)||tx.accessList.length!==0)return null;
    validateFreshReceipt(receipt,tx,{number:tx.blockNumber,hash:block.hash,parentHash:'0x'+'0'.repeat(64),timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16),transactions:[]}as FreshBlock);
    const gas=freshInteger(receipt.gasUsed),gasPrice=freshInteger(receipt.effectiveGasPrice??tx.gasPrice);
    if(gas<=0n||gas>freshInteger(tx.gas)||gasPrice<=0n||gasPrice>freshInteger(tx.maxFeePerGas))return null;
    const parsed=abi.decode([batchType],'0x'+tx.input.slice(10)),batch=parsed[0];
    if(batch.length!==4||selector+abi.encode([batchType],parsed).slice(2)!==tx.input||batch.some((c:any)=>c.extra!=='0x'))return null;
    const trace=validateFreshTrace(entry.trace),children=trace.calls??[];
    if(!freshTraceMatchesTransaction(trace,tx)||trace.input!==tx.input||children.length!==4||children.some((c,i)=>c.type!=='CALL'||c.error||c.from!==wallet
      ||c.to!==String(batch[i].target).toLowerCase()||c.input!==batch[i].data||freshInteger(c.value??'0x0')!==batch[i].value))return null;
    const [acquisition,approval,purchase,expense]=children,quote=freshAddress(approval.to),native=freshInteger(acquisition.value??'0x0'),extra=freshInteger(expense.value??'0x0');
    if(acquisition.to!==router||native<=0n||!acquisition.input?.startsWith('0xac9650d8')||!quote||[token,wallet,zero,WBNB,router,FLAP_PORTAL].includes(quote)
      ||freshInteger(approval.value??'0x0')!==0n||approval.input!=='0x095ea7b3'+word(FLAP_PORTAL)+'f'.repeat(64)||!success(approval)
      ||purchase.to!==FLAP_PORTAL||freshInteger(purchase.value??'0x0')!==0n||!purchase.input?.startsWith('0x8cb5772c')
      ||extra<=0n||!expense.to||[wallet,token,quote,zero,router,FLAP_PORTAL].includes(expense.to)||expense.input!=='0x'||expense.calls?.length
      ||native+extra!==freshInteger(tx.value))return null;
    const nodes:{call:FreshCallTrace;path:number[];order:number}[]=[];
    function visit(call:FreshCallTrace,path:number[],context?:string,parentValue=0n) {
      if(call.error||!['CALL','STATICCALL','DELEGATECALL','CREATE','CREATE2'].includes(call.type)||!freshAddress(call.to)
        ||context!==undefined&&call.from!==context||path.length&&call.from===wallet&&(path.length!==1||call.type!=='CALL')
        ||call.type==='STATICCALL'&&freshInteger(call.value??'0x0')!==0n
        ||call.type==='DELEGATECALL'&&freshInteger(call.value??'0x0')!==parentValue)throw Error('signed_batch_trace_unsupported');
      if(path.length&&['CALL','CREATE','CREATE2'].includes(call.type)&&call.from!==call.to&&freshInteger(call.value??'0x0')>0n
        &&(call.to===wallet||call.from===wallet&&!(path.length===1&&(path[0]===0||path[0]===3))))throw Error('signed_batch_refund_or_payment_ambiguous');
      nodes.push({call,path,order:nodes.length});
      call.calls?.forEach((child,index)=>visit(child,[...path,index],call.type==='DELEGATECALL'?call.from:call.to,freshInteger(call.value??'0x0')));
    }
    visit(trace,[]);
    if(freshNativeDelta(trace,wallet)!==-(native+extra))return null;
    const flows=new Map<string,Movement[]>();
    for(const log of receipt.logs) {
      if([beforeExecutionTopic,userOperationTopic].includes(log.topics[0]))return null;
      if(log.topics[0]!==transferTopic)continue;
      if(log.topics.length!==3||!/^0x[\da-f]{64}$/.test(log.data))return null;
      const from=topicAddress(log.topics[1]),to=topicAddress(log.topics[2]);if(!from||!to)return null;
      if(from!==wallet&&to!==wallet)continue;
      if(from===to||from===zero||to===zero||BigInt(log.data)<=0n)return null;
      const moves=flows.get(log.address)??[];moves.push({from,to,raw:BigInt(log.data),index:Number(freshInteger(log.logIndex))});flows.set(log.address,moves);
    }
    const target=flows.get(token),quoteMoves=flows.get(quote);
    if(flows.size!==2||target?.length!==1||target[0].from!==FLAP_PORTAL||target[0].to!==wallet||target[0].raw!==targetRaw||quoteMoves?.length!==2)return null;
    const [received,paid]=quoteMoves;
    if(received.to!==wallet||[wallet,zero,FLAP_PORTAL,router,token,quote].includes(received.from)||paid.from!==wallet||paid.to!==FLAP_PORTAL
      ||received.raw<=paid.raw||paid.raw<=0n||received.index>=paid.index||paid.index>=target[0].index)return null;
    const unique=(predicate:(c:FreshCallTrace)=>boolean,branch:number)=>{const found=nodes.filter(n=>n.path[0]===branch&&predicate(n.call));return found.length===1?found[0]:null;};
    const transfer=(to:string,raw:bigint)=>'0xa9059cbb'+word(to)+word(raw);
    const acquiredCall=unique(c=>c.type==='CALL'&&c.from===received.from&&c.to===quote&&c.input===transfer(wallet,received.raw)&&success(c),0);
    const paidCall=unique(c=>c.type==='CALL'&&c.from===FLAP_PORTAL&&c.to===quote&&c.input==='0x23b872dd'+word(wallet)+word(FLAP_PORTAL)+word(paid.raw)&&success(c),2);
    const deliveredCall=unique(c=>c.type==='CALL'&&c.from===FLAP_PORTAL&&c.to===token&&c.input===transfer(wallet,targetRaw)&&success(c),2);
    if(!acquiredCall||!paidCall||!deliveredCall||acquiredCall.order>=paidCall.order||paidCall.order>=deliveredCall.order)return null;
    const buys=receipt.logs.filter(l=>l.address===FLAP_PORTAL&&[flapMarketAbi.getEvent('TokenBought')!.topicHash,flapMarketAbi.getEvent('TokenSold')!.topicHash].includes(l.topics[0]));
    if(buys.length!==1)return null;
    const buy=flapMarketAbi.parseLog(buys[0]);if(!buy||buy.name!=='TokenBought'||String(buy.args.token).toLowerCase()!==token||String(buy.args.buyer).toLowerCase()!==wallet
      ||buy.args.amount!==targetRaw||buy.args.eth!==paid.raw||Number(buy.args.ts)*1000!==Date.parse(block.timestamp)||stable(flapMarketAbi.encodeEventLog(buy.fragment,buy.args))!==stable({data:buys[0].data,topics:buys[0].topics}))return null;
    const swaps=receipt.logs.filter(l=>l.address===received.from&&l.topics[0]===v3MarketAbi.getEvent('Swap')!.topicHash);
    if(swaps.length!==1)return null;
    const swap=v3MarketAbi.parseLog(swaps[0]);if(!swap||String(swap.args.sender).toLowerCase()!==router||String(swap.args.recipient).toLowerCase()!==wallet
      ||!((swap.args.amount0===-received.raw&&swap.args.amount1>0n)||(swap.args.amount1===-received.raw&&swap.args.amount0>0n))
      ||stable(v3MarketAbi.encodeEventLog(swap.fragment,swap.args))!==stable({data:swaps[0].data,topics:swaps[0].topics}))return null;
    return {version:1,kind:'signed_batch_native_buy_with_quote_change',expensePolicy:'signed_batch_trade_expenses_v1',transactionHash:tx.hash,blockNumber:block.number,blockHash:block.hash,
      transactionIndex:Number(freshInteger(tx.transactionIndex)),walletAddress:wallet,tokenAddress:token,tokenRaw:String(targetRaw),quoteAddress:quote,quoteSourcePool:received.from,
      quoteSourcePoolLogIndex:Number(freshInteger(swaps[0].logIndex)),quoteAcquiredRaw:String(received.raw),quoteSpentRaw:String(paid.raw),quoteRemainingRaw:String(received.raw-paid.raw),
      acquisitionNativeWei:String(native),extraNativeWei:String(extra),totalWalletNativeWei:String(native+extra),gasFeeWei:String(gas*gasPrice),authDelegate:String(auth.address),authorizationNonce:String(authNonce),
      expensePayments:[{path:[3],recipient:expense.to,nativeWei:String(extra)}],tokenTransferLogIndices:[target[0].index],quoteTransferLogIndices:quoteMoves.map(m=>m.index),
      inputSha256:sha(tx.input),traceSha256:sha(trace),logsSha256:sha(receipt.logs),calls:{acquisition:[0],quoteAcquisition:acquiredCall.path,quotePayment:paidCall.path,tokenDelivery:deliveredCall.path}};
  } catch {return null;}
}
