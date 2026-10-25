import {createHash} from 'node:crypto';
import {freshInteger,freshHash,freshAddress,type FreshCapturedReceipt} from './capture.js';
import {freshTraceMatchesTransaction,validateFreshTrace,freshNativeDelta,type FreshCallTrace} from './trace.js';
import {FreshRational} from './accounting.js';
import {TRUSTED_QUOTE_FEEDS} from '../nodeMarketProtocols.js';
import {hasFreshPassivePrecision} from './passivePrecision.js';
import type {FreshDecodedReceipt} from './decode.js';
const stable=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const sha=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
const original=(entry:FreshCapturedReceipt)=>({transaction:entry.transaction,receipt:entry.receipt,wallets:entry.wallets,historicalWallets:entry.historicalWallets,observedAt:entry.observedAt});
export interface FreshCompleteTraceProof{version:1;kind:'authenticated_complete_call_trace';source:'private_ipc'|'operator_archive';transactionHash:string;blockNumber:number;blockHash:string;
 method:'debug_traceTransaction';tracer:'callTracer';onlyTopCall:false;withLog:false;traceSha256:string;originalContextSha256:string}
declare module './capture.js'{interface FreshCapturedReceipt{completeTraceProof?:FreshCompleteTraceProof}}
/** Trusted capture/import call sites only, after their before/after canonical
 * header and original-receipt validation. The actual request must have asked
 * for the entire tree; a top-call-only result cannot be upgraded afterward. */
export function certifyFreshCompleteCallTrace(entry:FreshCapturedReceipt,value:unknown,request:{method:string;params:unknown[]},source:FreshCompleteTraceProof['source']):FreshCompleteTraceProof{
 if(!['private_ipc','operator_archive'].includes(source)||request.method!=='debug_traceTransaction'||request.params.length!==2||request.params[0]!==entry.transaction.hash)throw Error('complete_trace_request_invalid');
 const options=request.params[1]as any;if(!options||options.tracer!=='callTracer'||options.tracerConfig?.onlyTopCall!==false||options.tracerConfig?.withLog!==false)throw Error('complete_trace_request_invalid');
 const trace=validateFreshTrace(value);if(typeof entry.transaction.input!=='string'||!/^0x(?:[\da-f]{2})*$/i.test(entry.transaction.input)||trace.input!==entry.transaction.input.toLowerCase()
  ||!freshTraceMatchesTransaction(trace,entry.transaction)||entry.transaction.hash!==entry.receipt.transactionHash
  ||entry.transaction.blockHash!==entry.receipt.blockHash||freshInteger(entry.transaction.blockNumber)!==freshInteger(entry.receipt.blockNumber)||!freshHash(entry.receipt.blockHash))throw Error('complete_trace_context_invalid');
 return{version:1,kind:'authenticated_complete_call_trace',source,transactionHash:entry.transaction.hash,blockNumber:Number(freshInteger(entry.receipt.blockNumber)),blockHash:entry.receipt.blockHash,
  method:'debug_traceTransaction',tracer:'callTracer',onlyTopCall:false,withLog:false,traceSha256:sha(trace),originalContextSha256:sha(original(entry))};
}
export function validFreshCompleteCallTrace(entry:FreshCapturedReceipt,trace:FreshCallTrace):boolean{
 try{const p=entry.completeTraceProof;return !!p&&p.version===1&&p.kind==='authenticated_complete_call_trace'&&['private_ipc','operator_archive'].includes(p.source)
  &&p.transactionHash===entry.transaction.hash&&p.blockHash===entry.receipt.blockHash&&p.blockNumber===Number(freshInteger(entry.receipt.blockNumber))
  &&p.method==='debug_traceTransaction'&&p.tracer==='callTracer'&&p.onlyTopCall===false&&p.withLog===false
  &&typeof entry.transaction.input==='string'&&/^0x(?:[\da-f]{2})*$/i.test(entry.transaction.input)&&trace.input===entry.transaction.input.toLowerCase()
  &&p.traceSha256===sha(trace)&&p.originalContextSha256===sha(original(entry))&&freshTraceMatchesTransaction(trace,entry.transaction);
 }catch{return false;}
}
const transfer='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',address=(value:unknown)=>typeof value==='string'&&/^0x0{24}[\da-f]{40}$/.test(value)?'0x'+value.slice(-40):null;
/** Pure alternate movement-completion proof. It never supplies a cost, fee,
 * value or profit. The existing same-book/no-trade SQL guard must also pass
 * under the normal financial lock before the receipt can finish. */
export function freshPassiveIncomingOnly(decoded:FreshDecodedReceipt,entry:FreshCapturedReceipt,quoteAddresses:readonly string[]=[]):boolean{
 try{if(entry.receipt.status!=='0x1'||entry.transaction.type==='0x4'||entry.transaction.authorizationList!==undefined||entry.launchRepair||decoded.syntheticTransferBatch
  ||!decoded.reasons.length||decoded.reasons.some(r=>r!=='incoming_transfer_cost_unknown')||!decoded.events.length||decoded.events.length>4096)return false;
 const trace=validateFreshTrace(decoded.trace??entry.trace);if(!validFreshCompleteCallTrace(entry,trace))return false;
 const wallets=[...new Set(decoded.events.map(e=>e.walletAddress))],quotes=new Set([...Object.keys(TRUSTED_QUOTE_FEEDS),...quoteAddresses]);
 if(wallets.length>256||wallets.some(w=>!freshAddress(w)||!entry.wallets.includes(w)||entry.transaction.from===w||entry.transaction.to===w))return false;
 if(decoded.events.some(e=>e.kind!=='transfer_in'||e.amountUsd!==null||e.feeUsd!=='0'||e.canonical===false||e.feeAttribution||e.logIndex===null))return false;
 let frames=0;const visit=(call:FreshCallTrace)=>{if(++frames>5000||wallets.includes(call.from)||call.to&&wallets.includes(call.to)||!['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT'].includes(call.type))throw Error('passive_recipient_participates');for(const child of call.calls??[])visit(child);};visit(trace);
 const metadata=new Map(decoded.tokens.map(t=>[t.address,t])),used=new Set<string>();
 for(const wallet of wallets){if(freshNativeDelta(trace,wallet)!==0n)return false;const logs=entry.receipt.logs.filter(l=>l.topics[0]===transfer&&l.topics.slice(1).some(t=>address(t)===wallet));if(!logs.length)return false;
 for(const log of logs){if(log.removed||log.topics.length!==3||address(log.topics[1])===wallet||address(log.topics[2])!==wallet||quotes.has(log.address)
   ||log.blockHash!==entry.receipt.blockHash||log.transactionHash!==entry.transaction.hash||!/^0x[\da-f]{64}$/.test(log.data)||BigInt(log.data)<=0n)return false;
 const events=decoded.events.filter(e=>e.walletAddress===wallet&&e.tokenAddress===log.address&&e.logIndex===Number(freshInteger(log.logIndex)));if(events.length!==1)return false;const event=events[0],token=metadata.get(log.address);
 if(!token||!hasFreshPassivePrecision(token,entry)||token.block.number!==Number(event.blockNumber)||token.block.hash!==event.blockHash||Date.parse(token.block.timestamp)!==Date.parse(event.occurredAt)
  ||event.counterparty!==address(log.topics[1])||event.blockHash!==entry.receipt.blockHash||event.transactionHash!==entry.transaction.hash||!event.transferKey||used.has(event.id))return false;
 if(FreshRational.parse(event.quantity).compare(new FreshRational(BigInt(log.data),10n**BigInt(token.decimals)))!==0)return false;used.add(event.id);}}
 return used.size===decoded.events.length;
 }catch{return false;}
}
