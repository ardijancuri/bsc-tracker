import {WBNB} from '../launchpad.js';
import {isFreshSettlementQuote} from './settlementQuote.js';
import {beforeExecutionTopic,userOperationTopic} from '../smartAccountTrades.js';
import {transferTopic} from '../swap.js';
import {FRESH_ENTRY_POINTS,freshAddress,freshHash,freshInteger,type FreshCapturedReceipt} from './capture.js';
import type {FreshPriceBlock} from './pricing.js';
import {freshNativeDelta,freshTraceMatchesTransaction,validateFreshTrace} from './trace.js';

export interface FreshQuotePayment {
  version:1;kind:'wallet_erc20_quote_settlement';side:'buy'|'sell';transactionHash:string;
  blockNumber:number;blockHash:string;transactionIndex:number;walletAddress:string;
  tokenAddress:string;quoteAddress:string;tokenRaw:string;quoteRaw:string;
  outgoingQuoteRaw:string;incomingQuoteRaw:string;gasFeeWei:string;
  quoteTransferLogIndices:number[];tokenTransferLogIndices:number[];
}
const topicAddress=(value:string|undefined)=>value&&/^0x0{24}[\da-f]{40}$/.test(value)?'0x'+value.slice(-40):null;
const zero='0x'+'0'.repeat(40);

/** Actual ERC20 wallet settlement, independent of a router's gross Swap event.
 * The caller must already establish one eligible trade target. This guard proves
 * one opposing explicitly supported quote settlement, including returned quote units, without
 * assuming that quote's decimals or a peg. A separately authenticated earlier
 * pool ratio and dated BNB/USD convert the raw payment. Gas remains separate.
 * Native-value, authorization/AA and mixed-asset operations are not covered. */
export function freshQuotePayment(entry:FreshCapturedReceipt,block:FreshPriceBlock,
  tokenAddress:string,walletAddress:string,targetRaw:bigint):FreshQuotePayment|null {
  try {
    const {transaction:tx,receipt}=entry,token=freshAddress(tokenAddress),wallet=freshAddress(walletAddress),router=freshAddress(tx.to);
    if(!token||!wallet||!router||router===wallet||FRESH_ENTRY_POINTS.includes(router)||tx.from!==wallet||!entry.wallets.includes(wallet)
      ||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||targetRaw===0n
      ||freshInteger(tx.value)!==0n||receipt.status!=='0x1'||!freshHash(tx.hash)||tx.blockHash!==block.hash||receipt.blockHash!==block.hash
      ||receipt.transactionHash!==tx.hash||Number(freshInteger(tx.blockNumber))!==block.number||receipt.blockNumber!==tx.blockNumber
      ||receipt.transactionIndex!==tx.transactionIndex||!Number.isSafeInteger(block.number)||block.number<0
      ||!Number.isFinite(Date.parse(block.timestamp))||!Array.isArray(receipt.logs)||receipt.logs.length>512)return null;
    const gas=freshInteger(receipt.gasUsed),gasPrice=freshInteger(receipt.effectiveGasPrice??tx.gasPrice);
    if(gas<=0n||gasPrice<=0n)return null;
    if(entry.trace!==undefined){
      const trace=validateFreshTrace(entry.trace);
      if(!freshTraceMatchesTransaction(trace,tx)||freshNativeDelta(trace,wallet)!==0n)return null;
    }
    const flows=new Map<string,{incoming:bigint;outgoing:bigint;indices:number[];sentTo:Set<string>;returnedFrom:Set<string>}>();
    let previous=-1;
    for(const log of receipt.logs){
      const index=Number(freshInteger(log.logIndex));
      if(log.removed||!freshAddress(log.address)||!Array.isArray(log.topics)||log.topics.length>4||!log.topics.every(freshHash)
        ||!/^0x(?:[\da-f]{2})*$/.test(log.data)||log.data.length>65538||log.blockHash!==block.hash||log.blockNumber!==tx.blockNumber
        ||log.transactionHash!==tx.hash||log.transactionIndex!==tx.transactionIndex||!Number.isSafeInteger(index)||index<=previous)return null;
      previous=index;
      if([beforeExecutionTopic,userOperationTopic].includes(log.topics[0]))return null;
      if(log.topics[0]!==transferTopic)continue;
      if(log.topics.length!==3||!/^0x[\da-f]{64}$/.test(log.data))return null;
      const from=topicAddress(log.topics[1]),to=topicAddress(log.topics[2]);
      if(!from||!to)return null;
      if(from!==wallet&&to!==wallet)continue;
      if(from===to)return null;
      const asset=log.address,amount=BigInt(log.data),flow=flows.get(asset)??{incoming:0n,outgoing:0n,indices:[],sentTo:new Set<string>(),returnedFrom:new Set<string>()};
      if(from===wallet){if(to===zero)return null;flow.outgoing+=amount;flow.sentTo.add(to);}
      if(to===wallet){if(from===zero)return null;flow.incoming+=amount;flow.returnedFrom.add(from);}
      flow.indices.push(index);flows.set(asset,flow);
    }
    const delivery=flows.get(token),buy=targetRaw>0n;
    if(!delivery||flows.size!==2||(buy?delivery.outgoing!==0n||delivery.incoming!==targetRaw:delivery.incoming!==0n||delivery.outgoing!==-targetRaw))return null;
    const opposing=[...flows].filter(([asset,flow])=>asset!==token&&asset!==WBNB&&isFreshSettlementQuote(asset)
      &&(buy?flow.outgoing>flow.incoming:flow.incoming>flow.outgoing));
    if(opposing.length!==1)return null;
    const [quoteAddress,payment]=opposing[0];
    // A returned payment comes from this route or a counterparty we paid;
    // unrelated mints/airdrops cannot silently reduce acquisition capital.
    if(buy){
      if([...payment.returnedFrom].some(address=>address!==router&&!payment.sentTo.has(address)))return null;
    }else{
      if([...payment.returnedFrom].some(address=>address!==router&&!delivery.sentTo.has(address))
        ||[...payment.sentTo].some(address=>address!==router&&!payment.returnedFrom.has(address)))return null;
    }
    return {version:1,kind:'wallet_erc20_quote_settlement',side:buy?'buy':'sell',transactionHash:tx.hash,blockNumber:block.number,blockHash:block.hash,
      transactionIndex:Number(freshInteger(tx.transactionIndex)),walletAddress:wallet,tokenAddress:token,quoteAddress,
      tokenRaw:String(buy?targetRaw:-targetRaw),quoteRaw:String(buy?payment.outgoing-payment.incoming:payment.incoming-payment.outgoing),outgoingQuoteRaw:String(payment.outgoing),
      incomingQuoteRaw:String(payment.incoming),gasFeeWei:String(gas*gasPrice),quoteTransferLogIndices:payment.indices,tokenTransferLogIndices:delivery.indices};
  } catch {return null;}
}
