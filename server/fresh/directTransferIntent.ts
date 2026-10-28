import{Interface}from'ethers';
import{FLAP_PORTAL,FOUR_MANAGERS}from'../launchpad.js';
import{protocolMarketTopics}from'../nodeMarketProtocols.js';
import{transferTopic}from'../swap.js';
import{FRESH_ENTRY_POINTS,freshAddress,freshInteger,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock}from'./capture.js';
import type{FreshExecution}from'./decode.js';
import{validFreshCompleteCallTrace}from'./passiveIncoming.js';
import{freshNativeDelta,validateFreshTrace,type FreshCallTrace}from'./trace.js';
import{isFreshSettlementQuote}from'./settlementQuote.js';

const abi=new Interface(['function transfer(address to,uint256 amount)returns(bool)']);
const marketTopics=new Set(protocolMarketTopics),controllers=new Set<string>([...FOUR_MANAGERS,FLAP_PORTAL,...FRESH_ENTRY_POINTS,'0x10ed43c718714eb63d5aa57b78b54704e256024e','0x13f4ea83d0bd40e75c8222255bc855a974568dd4','0x1a44076050125825900e736c501f859c50fe728c']);
const topicAddress=(v:unknown)=>typeof v==='string'&&/^0x0{24}[a-f0-9]{40}$/.test(v)?'0x'+v.slice(-40):null;
export interface FreshDirectTransferIntent{
 kind:'direct_transfer_with_internal_inventory_swap';wallet:string;tokenAddress:string;recipient:string;requestedRaw:string;walletDebitRaw:string;principalLogIndex:number;
 walletQuoteMovements:{tokenAddress:string;from:string;to:string;rawQuantity:string;logIndex:number}[];
 inventoryTransferLogIndices:number[];internalMarketAddresses:string[];traceSha256:string;
}
function directTransferReceiptIntent(entry:FreshCapturedReceipt,execution:FreshExecution,token:string,targetRaw:bigint,marketAddresses:ReadonlySet<string>){
 const tx=entry.transaction,wallet=execution.wallet;
 if(execution.kind!=='transaction'||execution.status!=='success'||execution.index!==0||execution.operationHash!==null||tx.from!==wallet||tx.to!==token||!entry.wallets.includes(wallet)
  ||freshAddress(token)!==token||isFreshSettlementQuote(token)||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||tx.chainId!==undefined&&freshInteger(tx.chainId)!==56n||freshInteger(tx.value)!==0n
  ||entry.receipt.status!=='0x1'||execution.logs.length>512||JSON.stringify(execution.logs)!==JSON.stringify(entry.receipt.logs)
  ||typeof tx.input!=='string'||tx.input.length!==138||!tx.input.startsWith('0xa9059cbb'))return null;
 const decoded=abi.decodeFunctionData('transfer',tx.input),recipient=String(decoded[0]).toLowerCase(),requested=BigInt(decoded[1]);
 if(abi.encodeFunctionData('transfer',decoded).toLowerCase()!==tx.input||requested<=0n||targetRaw!==-requested||recipient===wallet||recipient===token||recipient==='0x'+'0'.repeat(40)||controllers.has(recipient)||marketAddresses.has(recipient))return null;
 validateFreshReceipt(entry.receipt,tx,{number:tx.blockNumber,hash:tx.blockHash,parentHash:tx.blockHash,timestamp:'0x0',transactions:[tx]});
 const markets=[...new Set(execution.logs.filter(l=>marketTopics.has(l.topics[0])).map(l=>l.address))];if(!markets.length||markets.includes(recipient))return null;
 let principal:number|null=null,walletDebit=0n;const inventory:number[]=[],funded=new Set([token]);
 for(const l of execution.logs){if(l.address!==token||l.topics[0]!==transferTopic)continue;if(l.topics.length!==3||!/^0x[a-f0-9]{64}$/.test(l.data))return null;const from=topicAddress(l.topics[1]),to=topicAddress(l.topics[2]);if(!from||!to)return null;const raw=BigInt(l.data);if(raw===0n)continue;
  const index=Number(freshInteger(l.logIndex));if(from===wallet){if(to!==recipient||raw!==requested||principal!==null)return null;principal=index;walletDebit+=raw;continue;}
  if(to===wallet||from===recipient||to===recipient||!funded.has(from))return null;funded.add(to);inventory.push(index);
 }
 if(principal===null||walletDebit!==requested||!inventory.length||!markets.some(m=>funded.has(m)))return null;
 return{wallet,recipient,requested,principal,walletDebit,inventory,markets};
}
/** Receipt-only ambiguity gate. This does not prove a transfer or approve any
 * financial value. Callers must wait for the complete trace before deciding
 * whether the internal inventory swap belongs to this wallet. */
export function freshDirectTransferIntentCandidate(entry:FreshCapturedReceipt,execution:FreshExecution,token:string,targetRaw:bigint,marketAddresses:ReadonlySet<string>=new Set()):boolean{
 try{return directTransferReceiptIntent(entry,execution,token,targetRaw,marketAddresses)!==null;}catch{return false;}
}
/** A signed direct transfer can trigger a token's own inventory sale. That
 * unrelated sale is not the wallet's sale. This proof supplies intent and raw
 * movements only: no USD value, transfer mark, fee, cost, or profit. Additional
 * authenticated pool/controller identities may be supplied by the caller. */
export function freshDirectTransferIntent(entry:FreshCapturedReceipt,execution:FreshExecution,block:Pick<FreshBlock,'number'|'hash'|'timestamp'>,token:string,targetRaw:bigint,rawTrace:FreshCallTrace,marketAddresses:ReadonlySet<string>=new Set()):FreshDirectTransferIntent|null{
 try{
  const tx=entry.transaction,context=directTransferReceiptIntent(entry,execution,token,targetRaw,marketAddresses);if(!context||tx.blockHash!==block.hash||freshInteger(tx.blockNumber)!==freshInteger(block.number))return null;
  const{wallet,recipient,requested}=context;
  validateFreshReceipt(entry.receipt,tx,{...block,parentHash:block.hash,transactions:[tx]});const trace=validateFreshTrace(rawTrace);
  if(!validFreshCompleteCallTrace(entry,trace)||trace.error||trace.output!=='0x'+'0'.repeat(63)+'1'||freshNativeDelta(trace,wallet)!==0n)return null;
  const calls:FreshCallTrace[]=[];const visit=(c:FreshCallTrace,root=false)=>{if(c.error)return;if(!['CALL','STATICCALL','DELEGATECALL'].includes(c.type)||!c.to||!root&&(c.from===wallet||c.from===recipient||c.to===recipient))throw Error('transfer_trace_context');calls.push(c);c.calls?.forEach(child=>visit(child));};visit(trace,true);
  const markets=[...new Set(execution.logs.filter(l=>marketTopics.has(l.topics[0])).map(l=>l.address))];if(!markets.length||markets.includes(recipient))return null;
  let principal:number|null=null,walletDebit=0n;const quote:FreshDirectTransferIntent['walletQuoteMovements']=[],inventory:number[]=[],funded=new Set([token]);
  for(const l of execution.logs){if(l.topics[0]!==transferTopic)continue;if(l.topics.length!==3||!/^0x[a-f0-9]{64}$/.test(l.data))return null;const from=topicAddress(l.topics[1]),to=topicAddress(l.topics[2]);if(!from||!to)return null;const raw=BigInt(l.data),index=Number(freshInteger(l.logIndex));if(raw===0n)continue;
   if(l.address===token){if(from===wallet){if(to!==recipient||raw!==requested||principal!==null)return null;principal=index;walletDebit+=raw;continue;}if(to===wallet||from===recipient||to===recipient||!funded.has(from))return null;funded.add(to);inventory.push(index);}
   else if(from===wallet||to===wallet){if(!isFreshSettlementQuote(l.address)||from===wallet||from!==token||to!==wallet||quote.length>=8)return null;
    const call=calls.some(c=>c.type==='CALL'&&c.from===token&&c.to===l.address&&c.input===abi.encodeFunctionData('transfer',[wallet,raw]).toLowerCase()&&(c.output==='0x'||c.output==='0x'+'0'.repeat(63)+'1'));if(!call)return null;
    quote.push({tokenAddress:l.address,from,to,rawQuantity:raw.toString(),logIndex:index});}
  }
  if(principal===null||walletDebit!==requested||!inventory.length||!markets.some(m=>funded.has(m)))return null;
  return{kind:'direct_transfer_with_internal_inventory_swap',wallet,tokenAddress:token,recipient,requestedRaw:requested.toString(),walletDebitRaw:walletDebit.toString(),principalLogIndex:principal,walletQuoteMovements:quote,inventoryTransferLogIndices:inventory,internalMarketAddresses:markets.sort(),traceSha256:entry.completeTraceProof!.traceSha256};
 }catch{return null;}
}
