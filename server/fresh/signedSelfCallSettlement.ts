import{createHash}from'node:crypto';
import{AbiCoder,Interface,Signature,Transaction,verifyAuthorization}from'ethers';
import{WBNB}from'../launchpad.js';
import{transferTopic}from'../swap.js';
import{beforeExecutionTopic,userOperationTopic}from'../smartAccountTrades.js';
import{freshAddress,freshHash,freshInteger,validateFreshBlock,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock}from'./capture.js';
import{freshNativeDelta,freshTraceMatchesTransaction,validateFreshTrace,type FreshCallTrace}from'./trace.js';
import type{FreshPriceBlock}from'./pricing.js';

export const FRESH_SELF_CALL_DELEGATE='0x63c0c19a282a1b52b07dd5a65b58948a07dae32b';
export const FRESH_SELF_CALL_DELEGATE_CODE_SHA256='6e4c6247a63c1d8cfc647f21f0ca932fa3e7c03ddae1cbf590351eee39ede550';
const router='0x9689992f5b5c09447f15906d8d11214944488341',zero='0x'+'0'.repeat(40),mode='0x01'+'00'.repeat(31),abi=AbiCoder.defaultAbiCoder(),execute=new Interface(['function execute(bytes32 mode,bytes executionData) payable']),batchType='tuple(address target,uint256 value,bytes callData)[]';
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x),sha=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex'),byteSha=(v:string)=>createHash('sha256').update(Buffer.from(v.slice(2),'hex')).digest('hex'),word=(v:string|bigint)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0'),sigWord=(v:unknown)=>'0x'+freshInteger(v).toString(16).padStart(64,'0'),topicAddress=(v:string|undefined)=>v&&/^0x0{24}[\da-f]{40}$/.test(v)?'0x'+v.slice(-40):null,success=(c:FreshCallTrace)=>c.output==='0x'+word(1n);
export interface FreshSelfCallExecutionContext{
 version:1;kind:'signed_self_call_execution_context';status:'partial'|'complete';chainId:56;transactionHash:string;blockNumber:number;blockHash:string;
 /** Original full confirmed block proves no other authorization changes this
  * wallet before/after this transaction. It is temporary72-hour raw evidence. */
 block?:FreshBlock;
 codeReads:{address:string;blockHash:string;result:string}[];
}
export interface FreshSignedSelfCallSettlement{
 version:1;kind:'signed_self_call_native_settlement';transactionHash:string;blockNumber:number;blockHash:string;transactionIndex:number;walletAddress:string;tokenAddress:string;
 side:'buy'|'sell';tokenRaw:string;nativeAmountWei:string;signedNativeBudgetWei:string;nativeRefundWei:string;gasFeeWei:string;quoteAddress:typeof WBNB;quoteSymbol:'BNB';
 delegateAddress:typeof FRESH_SELF_CALL_DELEGATE;delegateCodeSha256:string;tokenTransferLogIndex:number;tokenCallPath:number[];inputSha256:string;traceSha256:string;logsSha256:string;contextSha256:string;
}

/** Only the signed public execute entry point is recognized. This is an
 * evidence-capture candidate; it grants no financial authorization by itself. */
export function freshSignedSelfCallBatch(entry:FreshCapturedReceipt){
 try{const tx=entry.transaction,wallet=freshAddress(tx.from);if(!wallet||tx.to!==wallet||!entry.wallets.includes(wallet)||tx.type!=='0x2'||tx.authorizationList!==undefined||freshInteger(tx.chainId)!==56n||freshInteger(tx.value)!==0n||entry.receipt.status!=='0x1'||!Array.isArray(tx.accessList)||tx.accessList.length||typeof tx.input!=='string'||tx.input.length>2+64*1024)return null;
  const nonce=freshInteger(tx.nonce),parity=Number(freshInteger(tx.yParity??tx.v));if(nonce>BigInt(Number.MAX_SAFE_INTEGER)||![0,1].includes(parity)||freshInteger(tx.v)!==BigInt(parity))return null;
  const signature=Signature.from({r:sigWord(tx.r),s:sigWord(tx.s),yParity:parity as 0|1}),signed=Transaction.from({type:2,chainId:56n,to:wallet,nonce:Number(nonce),gasLimit:freshInteger(tx.gas),maxFeePerGas:freshInteger(tx.maxFeePerGas),maxPriorityFeePerGas:freshInteger(tx.maxPriorityFeePerGas),value:0n,data:tx.input,accessList:[],signature});
  if(signed.hash!==tx.hash||signed.from?.toLowerCase()!==wallet)return null;
  const parsed=execute.parseTransaction({data:tx.input});if(!parsed||parsed.name!=='execute'||parsed.args.mode!==mode||execute.encodeFunctionData(parsed.fragment,parsed.args)!==tx.input)return null;
  const calls=abi.decode([batchType],parsed.args.executionData)[0];if(calls.length<1||calls.length>2||abi.encode([batchType],[calls])!==parsed.args.executionData)return null;
  return{wallet,calls:[...calls].map(c=>({target:String(c.target).toLowerCase(),value:BigInt(c.value),data:String(c.callData)}))};
 }catch{return null;}
}

export function validateFreshSelfCallBlock(entry:FreshCapturedReceipt,block:FreshPriceBlock,raw:FreshBlock){
 try{const batch=freshSignedSelfCallBatch(entry);if(!batch||!raw)return false;validateFreshBlock(raw,block.number);if(raw.hash!==block.hash||Number(freshInteger(raw.timestamp))*1000!==Date.parse(block.timestamp)||raw.transactions.length>2048)return false;const original=raw.transactions[Number(freshInteger(entry.transaction.transactionIndex))];if(!original||stable(original)!==stable(entry.transaction))return false;
  for(const tx of raw.transactions)for(const auth of tx.authorizationList as Record<string,unknown>[]??[]){const parity=Number(freshInteger(auth.yParity));if(![0,1].includes(parity))return false;const signature=Signature.from({r:sigWord(auth.r),s:sigWord(auth.s),yParity:parity as 0|1}),authority=verifyAuthorization({address:String(auth.address),chainId:freshInteger(auth.chainId),nonce:freshInteger(auth.nonce)},signature).toLowerCase();if(authority===batch.wallet)return false;}return true;
 }catch{return false;}
}
function validContextEnvelope(entry:FreshCapturedReceipt,block:FreshPriceBlock,context:FreshSelfCallExecutionContext){
 try{const batch=freshSignedSelfCallBatch(entry);if(!batch||!context||context.version!==1||context.kind!=='signed_self_call_execution_context'||!['partial','complete'].includes(context.status)||context.chainId!==56||context.transactionHash!==entry.transaction.hash||context.blockNumber!==block.number||context.blockHash!==block.hash||!freshHash(block.hash)||!Array.isArray(context.codeReads)||context.codeReads.length>2||Buffer.byteLength(JSON.stringify(context))>2*1024*1024)return false;
  if(!context.block||!validateFreshSelfCallBlock(entry,block,context.block))return false;const seen=new Set<string>();for(const code of context.codeReads){if(![batch.wallet,FRESH_SELF_CALL_DELEGATE].includes(code.address)||seen.has(code.address)||code.blockHash!==block.hash||typeof code.result!=='string'||!/^0x(?:[\da-f]{2})*$/i.test(code.result)||code.result.length>2+128*1024*2)return false;seen.add(code.address);}return true;
 }catch{return false;}
}
/** Raw partial observations are reusable, but never sufficient for settlement. */
export function validateFreshSelfCallCapture(entry:FreshCapturedReceipt,block:FreshPriceBlock,context:FreshSelfCallExecutionContext){return validContextEnvelope(entry,block,context)&&(context.status==='partial'||validateFreshSelfCallContext(entry,block,context));}
export function validateFreshSelfCallContext(entry:FreshCapturedReceipt,block:FreshPriceBlock,context:FreshSelfCallExecutionContext){
 if(!validContextEnvelope(entry,block,context)||context.status!=='complete'||context.codeReads.length!==2)return false;const wallet=entry.transaction.from,walletCode=context.codeReads.find(c=>c.address===wallet),implementation=context.codeReads.find(c=>c.address===FRESH_SELF_CALL_DELEGATE);return Boolean(walletCode&&implementation&&walletCode.result.toLowerCase()==='0xef0100'+FRESH_SELF_CALL_DELEGATE.slice(2)&&/^0x(?:[\da-f]{2})+$/i.test(implementation.result)&&byteSha(implementation.result)===FRESH_SELF_CALL_DELEGATE_CODE_SHA256);
}

/** A narrow exception to the ordinary self-call exclusion. Only this pinned
 * historical runtime, exact signed/default batch and complete settled trace
 * authorize one token's native payment. Outer value is never a cost. Gas is
 * returned separately and existing event identity/FIFO policy remain intact. */
export function freshSignedSelfCallSettlement(entry:FreshCapturedReceipt,block:FreshPriceBlock,tokenAddress:string,walletAddress:string,targetRaw:bigint,context:FreshSelfCallExecutionContext):FreshSignedSelfCallSettlement|null{
 try{const batch=freshSignedSelfCallBatch(entry),token=freshAddress(tokenAddress),wallet=freshAddress(walletAddress);if(!batch||batch.wallet!==wallet||!token||[wallet,zero,WBNB,router,FRESH_SELF_CALL_DELEGATE].includes(token)||targetRaw===0n||!entry.trace||!validateFreshSelfCallContext(entry,block,context))return null;
  const tx=entry.transaction,receipt=entry.receipt,positive=targetRaw>0n,raw=positive?targetRaw:-targetRaw;
  validateFreshReceipt(receipt,tx,context.block!);const gas=freshInteger(receipt.gasUsed),gasPrice=freshInteger(receipt.effectiveGasPrice??tx.gasPrice);if(gas<=0n||gas>freshInteger(tx.gas)||gasPrice<=0n||gasPrice>freshInteger(tx.maxFeePerGas))return null;
  const trace=validateFreshTrace(entry.trace),children=trace.calls??[];if(!freshTraceMatchesTransaction(trace,tx)||trace.input!==tx.input||children.length!==batch.calls.length||children.some((c,i)=>c.type!=='CALL'||c.error||c.from!==wallet||c.to!==batch.calls[i].target||c.input!==batch.calls[i].data||freshInteger(c.value??'0x0')!==batch.calls[i].value))return null;
  const routeIndex=children.length-1,route=children[routeIndex],budget=batch.calls.reduce((sum,c)=>sum+c.value,0n);if(route.to!==router||!route.input?.startsWith('0x3e0f9c3c'))return null;
  if(positive){if(children.length!==1||budget<=0n)return null;}else if(budget!==0n||children.length===2&&(children[0].to!==token||children[0].input!=='0x095ea7b3'+word(router)+word(raw)||!success(children[0])))return null;
  const walletMoves:{asset:string;from:string;to:string;raw:bigint;index:number}[]=[];
  for(const log of receipt.logs){if([beforeExecutionTopic,userOperationTopic].includes(log.topics[0]))return null;if(log.topics[0]!==transferTopic)continue;if(log.topics.length!==3||!/^0x[\da-f]{64}$/.test(log.data))return null;const from=topicAddress(log.topics[1]),to=topicAddress(log.topics[2]);if(!from||!to)return null;if(from===wallet||to===wallet){if(from===to||from===zero||to===zero||BigInt(log.data)<=0n)return null;walletMoves.push({asset:log.address,from,to,raw:BigInt(log.data),index:Number(freshInteger(log.logIndex))});}}
  // Retained WBNB is a separate real asset. The narrow native-only adapter
  // must fail closed instead of charging unspent wrapped change as token cost.
  if(walletMoves.length!==1||walletMoves[0].asset!==token)return null;const movement=walletMoves[0];if(movement.raw!==raw||(positive?movement.from!==router||movement.to!==wallet:movement.from!==wallet||movement.to!==router))return null;
  const nodes:{call:FreshCallTrace;path:number[]}[]=[];let refunds=0n;
  function visit(call:FreshCallTrace,path:number[],parentContext?:string,parentValue=0n){if(call.error||!['CALL','STATICCALL','DELEGATECALL'].includes(call.type)||!freshAddress(call.to)||parentContext!==undefined&&call.from!==parentContext||call.type==='STATICCALL'&&freshInteger(call.value??'0x0')!==0n||call.type==='DELEGATECALL'&&freshInteger(call.value??'0x0')!==parentValue)throw Error('self_call_trace_context_unsupported');
   if(path.length&&call.from===wallet&&(path.length!==1||call.type!=='CALL'))throw Error('self_call_unapproved_wallet_call');
   if(path.length&&call.to===wallet){if(call.type!=='CALL'||call.from!==router||path[0]!==routeIndex||call.input!=='0x'||call.calls?.length)throw Error('self_call_wallet_reentrancy_unsupported');refunds+=freshInteger(call.value??'0x0');}
   nodes.push({call,path});call.calls?.forEach((c,i)=>visit(c,[...path,i],call.type==='DELEGATECALL'?call.from:call.to,freshInteger(call.value??'0x0')));
  }visit(trace,[]);
  const transfer=positive?'0xa9059cbb'+word(wallet)+word(raw):'0x23b872dd'+word(wallet)+word(router)+word(raw),tokenCalls=nodes.filter(n=>n.path[0]===routeIndex&&n.call.type==='CALL'&&n.call.from===router&&n.call.to===token&&n.call.input===transfer&&success(n.call));if(tokenCalls.length!==1)return null;
  const delta=freshNativeDelta(trace,wallet),amount=positive?budget-refunds:refunds;if(amount<=0n||delta!==(positive?-amount:amount)||!positive&&budget!==0n)return null;
  return{version:1,kind:'signed_self_call_native_settlement',transactionHash:tx.hash,blockNumber:block.number,blockHash:block.hash,transactionIndex:Number(freshInteger(tx.transactionIndex)),walletAddress:wallet,tokenAddress:token,side:positive?'buy':'sell',tokenRaw:String(raw),nativeAmountWei:String(amount),signedNativeBudgetWei:String(budget),nativeRefundWei:String(refunds),gasFeeWei:String(gas*gasPrice),quoteAddress:WBNB,quoteSymbol:'BNB',delegateAddress:FRESH_SELF_CALL_DELEGATE,delegateCodeSha256:FRESH_SELF_CALL_DELEGATE_CODE_SHA256,tokenTransferLogIndex:movement.index,tokenCallPath:tokenCalls[0].path,inputSha256:sha(tx.input),traceSha256:sha(trace),logsSha256:sha(receipt.logs),contextSha256:sha(context)};
 }catch{return null;}
}
