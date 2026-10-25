import{WBNB,FLAP_PORTAL}from'../launchpad.js';
import{flapMarketAbi}from'../nodeMarketProtocols.js';
import {Interface} from 'ethers';
import type {FreshExecution} from './decode.js';
import {FRESH_ENTRY_POINTS,freshAddress,freshInteger,validateFreshReceipt,type FreshCapturedReceipt,type FreshBlock} from './capture.js';
import {freshNativeDelta,freshTraceMatchesTransaction,validateFreshTrace,type FreshCallTrace} from './trace.js';
import {beforeExecutionTopic,userOperationTopic} from '../smartAccountTrades.js';
import {transferTopic} from '../swap.js';

const router='0x5994814f2c4040b863a0125a45de152a8c2a4dec';
const stable='0x55d398326f99059ff775485246999027b3197955';
const completed='0x1bb43f2da90e35f7b0cf38521ca95a49e68eb42fac49924930a5bd73cdf7576c';
const abi=new Interface(['function transfer(address to,uint256 amount)','function transferFrom(address from,address to,uint256 amount)']);
const addressWord=(v:string)=>/^0{24}[\da-f]{40}$/.test(v)?'0x'+v.slice(-40):null;
const word=(v:string|bigint)=>typeof v==='bigint'?v.toString(16).padStart(64,'0'):v.slice(2).padStart(64,'0');
const yes=(c:FreshCallTrace)=>c.output==='0x'+word(1n);
export const hasFreshTokenExchangeRoute=(entry:FreshCapturedReceipt)=>entry.transaction.to===router
  &&typeof entry.transaction.input==='string'&&entry.transaction.input.startsWith('0x0c307f76');
interface Movement{asset:string;from:string;to:string;raw:bigint;index:number}
export interface FreshTokenExchangeSettlement {
  kind:'ordinary_token_exchange_via_usdt'|'ordinary_token_exchange_via_wbnb';wallet:string;sellToken:string;sellRaw:bigint;buyToken:string;buyRaw:bigint;
  quoteAddress:string;quoteRaw:bigint;gasFeeWei:bigint;
}

/** A bounded single EOA exchange, not a wallet-wide mixed-asset allocation.
 * The signed route and final event bind the two wallet assets. A complete
 * successful call tree plus genuine USDT transfers prove the intermediate
 * amount was received and spent in full. This is actual settled consideration,
 * not a same-transaction market-price sample or an assumed dollar peg.
 * No fee allocation or dollar valuation is performed by this proof reader. */
export function freshTokenExchangeSettlement(entry:FreshCapturedReceipt,execution:FreshExecution,block:Pick<FreshBlock,'number'|'hash'|'timestamp'>,
  rawTrace:FreshCallTrace):FreshTokenExchangeSettlement|null {
  try{
    const tx=entry.transaction,wallet=execution.wallet;
    if(execution.kind!=='transaction'||execution.status!=='success'||tx.from!==wallet||tx.to!==router||FRESH_ENTRY_POINTS.includes(router)
      ||!entry.wallets.includes(wallet)||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined||freshInteger(tx.value)!==0n
      ||entry.receipt.status!=='0x1'||tx.blockHash!==block.hash||tx.blockNumber!==block.number||typeof tx.input!=='string'
      ||!tx.input.startsWith('0x0c307f76')||tx.input.length<10+8*64||tx.input.length>2+65536*2||execution.logs.length>512
      ||JSON.stringify(execution.logs)!==JSON.stringify(entry.receipt.logs))return null;
    validateFreshReceipt(entry.receipt,tx,{...block,parentHash:block.hash,transactions:[tx]});
    const head=tx.input.slice(10).match(/.{64}/g)!;
    const sell=addressWord(head[2]),buy=addressWord(head[3]),rawIn=BigInt('0x'+head[4]);
    if(addressWord(head[1])!==wallet||!sell||!buy||sell===buy||sell===stable||buy===stable||rawIn<=0n
      ||BigInt('0x'+head[6])<freshInteger(block.timestamp)||BigInt('0x'+head[7])!==256n)return null;
    const trace=validateFreshTrace(rawTrace);
    if(!freshTraceMatchesTransaction(trace,tx)||trace.input!==tx.input||freshNativeDelta(trace,wallet)!==0n)return null;
    const calls:FreshCallTrace[]=[];
    const visit=(c:FreshCallTrace,failed=false)=>{
      if(!['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT'].includes(c.type))throw Error('exchange_trace_opaque');
      // Reverted subtrees have no settled effects; never inspect their descendants.
      if(failed||c.error)return;
      if(c.type==='CREATE'||c.type==='CREATE2'||c.type==='SELFDESTRUCT'||!freshAddress(c.to))throw Error('exchange_trace_side_effect');
      freshInteger(c.value??'0x0'); // Internal unwrap/settlement value is covered by the complete zero wallet-native delta.
      if(c!==trace&&c.from===wallet)throw Error('exchange_wallet_code_unsupported');
      calls.push(c);c.calls?.forEach(child=>visit(child,false));
    };visit(trace);
    const moves:Movement[]=[],flows=new Map<string,{incoming:bigint;outgoing:bigint}>();
    for(const l of execution.logs){
      if([beforeExecutionTopic,userOperationTopic].includes(l.topics[0]))return null;
      if(l.topics[0]!==transferTopic)continue;
      if(l.topics.length!==3||!/^0x[\da-f]{64}$/.test(l.data))return null;
      const from=addressWord(l.topics[1].slice(2)),to=addressWord(l.topics[2].slice(2));if(!from||!to)return null;
      const m={asset:l.address,from,to,raw:BigInt(l.data),index:Number(freshInteger(l.logIndex))};moves.push(m);
      if(from!==wallet&&to!==wallet)continue;
      if(from===to)return null;
      const f=flows.get(m.asset)??{incoming:0n,outgoing:0n};if(from===wallet)f.outgoing+=m.raw;if(to===wallet)f.incoming+=m.raw;flows.set(m.asset,f);
    }
    const outgoing=flows.get(sell),incoming=flows.get(buy);
    if(flows.size!==2||!outgoing||!incoming||outgoing.incoming!==0n||outgoing.outgoing!==rawIn||incoming.outgoing!==0n||incoming.incoming<=0n)return null;
    const final=execution.logs.filter(l=>l.address===router&&l.topics[0]===completed);
    if(final.length!==1||final[0].topics.length!==1||final[0].data!=='0x'+[sell,buy,wallet,rawIn,incoming.incoming].map(word).join('')
      ||BigInt('0x'+head[5])>incoming.incoming||trace.output!=='0x'+word(incoming.incoming))return null;
    // Keep the already verified USDT path as first preference. When no
    // USDT movement exists, exact WBNB settlement is valued by the same dated
    // native quote service. Symbols and assumed dollar pegs never select it.
    const quote=moves.some(m=>m.asset===stable)?stable:WBNB;
    if(sell===quote||buy===quote)return null;
    const bridge=moves.filter(m=>m.asset===quote);
    // Prove a bounded linear all-USDT path through exactly one router arrival and departure.
    const bridgeNodes=bridge.length?[bridge[0].from,...bridge.map(m=>m.to)]:[];
    const arrived=bridge.filter(m=>m.to===router),departed=bridge.filter(m=>m.from===router);
    if(bridge.length<(quote===WBNB?2:3)||bridge.length>8||bridge[0].raw<=0n||bridge.some(m=>m.raw!==bridge[0].raw||m.from===wallet||m.to===wallet||m.from===m.to)
      ||bridge.some((m,i)=>i>0&&(bridge[i-1].to!==m.from||bridge[i-1].index>=m.index))
      ||new Set(bridgeNodes).size!==bridgeNodes.length||arrived.length!==1||departed.length!==1||arrived[0].index>=departed[0].index)return null;
    const unique=(predicate:(c:FreshCallTrace)=>boolean)=>{const a=calls.filter(predicate);return a.length===1?a[0]:null;};
    const bridgeCalls:FreshCallTrace[]=[];
    for(const m of bridge){const input=abi.encodeFunctionData('transfer',[m.to,m.raw]).toLowerCase();
      const transfer=unique(c=>c.type==='CALL'&&c.from===m.from&&c.to===quote&&c.input===input&&yes(c));
      const transferFrom=unique(c=>c.type==='CALL'&&c.from!==wallet&&c.to===quote&&c.input===abi.encodeFunctionData('transferFrom',[m.from,m.to,m.raw]).toLowerCase()&&yes(c));
      if((transfer?1:0)+(transferFrom?1:0)!==1)return null;
      bridgeCalls.push((transfer??transferFrom)!);
    }
    const stableTransferCalls=calls.filter(c=>c.type==='CALL'&&c.to===quote&&['0xa9059cbb','0x23b872dd'].includes(c.input?.slice(0,10)??'')&&yes(c));
    if(stableTransferCalls.length!==bridgeCalls.length||stableTransferCalls.some(c=>!bridgeCalls.includes(c)))return null;
    // The coordinator must not retain or inject any intermediate asset. An
    // unexplained quote refund, tax recipient or leftover cannot become cost.
    const coordinator=new Map<string,bigint>();for(const m of moves){if(m.from===router)coordinator.set(m.asset,(coordinator.get(m.asset)??0n)-m.raw);if(m.to===router)coordinator.set(m.asset,(coordinator.get(m.asset)??0n)+m.raw);}if([...coordinator.values()].some(v=>v!==0n))return null;
    if(quote===WBNB&&bridge.length===2){
      const terminal=bridge[1].to,amount=bridge[0].raw;
      const unwrap=unique(c=>c.type==='CALL'&&c.from===terminal&&c.to===WBNB&&c.input==='0x2e1a7d4d'+word(amount));
      const funding=unique(c=>c.type==='CALL'&&c.from===WBNB&&c.to===terminal&&freshInteger(c.value??'0x0')===amount&&c.input==='0x');
      const purchase=unique(c=>c.type==='CALL'&&c.from===terminal&&c.to===FLAP_PORTAL&&freshInteger(c.value??'0x0')===amount&&c.input?.startsWith('0xef7ec2e7')===true);
      const native=calls.filter(c=>c.type==='CALL'&&c.from!==c.to&&freshInteger(c.value??'0x0')>0n&&(c.from===terminal||c.to===terminal));
      const withdrawals=execution.logs.filter(l=>l.address===WBNB&&l.topics[0]==='0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65');
      const buys=execution.logs.filter(l=>l.address===FLAP_PORTAL&&l.topics[0]===flapMarketAbi.getEvent('TokenBought')!.topicHash);
      if(!unwrap||!funding||!purchase||calls.indexOf(unwrap)>=calls.indexOf(funding)||calls.indexOf(funding)>=calls.indexOf(purchase)||native.length!==2||!native.includes(funding)||!native.includes(purchase)||freshNativeDelta(trace,terminal)!==0n||withdrawals.length!==1||buys.length!==1)return null;
      const withdrawal=withdrawals[0],event=flapMarketAbi.parseLog(buys[0]);if(withdrawal.topics.length!==2||withdrawal.topics[1]!=='0x'+word(terminal)||withdrawal.data!=='0x'+word(amount)||Number(freshInteger(withdrawal.logIndex))<=bridge[1].index||!event||String(event.args.token).toLowerCase()!==buy||String(event.args.buyer).toLowerCase()!==terminal||event.args.amount!==incoming.incoming||event.args.eth!==amount)return null;
      const encoded=flapMarketAbi.encodeEventLog(event.fragment,event.args);if(encoded.data!==buys[0].data||JSON.stringify(encoded.topics)!==JSON.stringify(buys[0].topics))return null;
    }
    // Authenticate the complete gross token debit (including its own transfer
    // tax) and actual final wallet credit against executed ERC20 methods.
    const debit=unique(c=>c.type==='CALL'&&c.to===sell&&c.input?.startsWith('0x23b872dd')===true&&yes(c)&&(()=>{try{const f=abi.parseTransaction({data:c.input!});return f!=null&&abi.encodeFunctionData(f.fragment,f.args).toLowerCase()===c.input&&String(f.args[0]).toLowerCase()===wallet&&f.args[2]===rawIn;}catch{return false;}})());
    if(!debit)return null;
    const delivery=moves.filter(m=>m.asset===buy&&m.to===wallet);
    if(delivery.length!==1)return null;
    const credit=unique(c=>c.type==='CALL'&&c.from===delivery[0].from&&c.to===buy&&yes(c)&&(()=>{try{const parsed=abi.parseTransaction({data:c.input!});return parsed?.name==='transfer'&&abi.encodeFunctionData(parsed.fragment,parsed.args).toLowerCase()===c.input&&String(parsed.args[0]).toLowerCase()===wallet&&parsed.args[1]>=incoming.incoming;}catch{return false;}})());
    if(!credit)return null;
    const gross=BigInt(abi.parseTransaction({data:credit.input!})!.args[1]);
    const deliveryEffects=moves.filter(m=>m.asset===buy&&m.from===delivery[0].from&&m.index>bridge[bridge.length-1].index&&m.index<=delivery[0].index),tax=deliveryEffects.filter(m=>m.to!==wallet);
    if(deliveryEffects.filter(m=>m.to===wallet).length!==1||deliveryEffects.reduce((sum,m)=>sum+m.raw,0n)!==gross||tax.length>1||tax.some(m=>m.to!==buy||m.raw<=0n)||tax.reduce((sum,m)=>sum+m.raw,0n)!==gross-incoming.incoming)return null;
    if(!credit||moves.filter(m=>m.asset===sell&&m.from===wallet).some(m=>m.index>=bridge[0].index)||delivery[0].index<=bridge[bridge.length-1].index
      ||Number(freshInteger(final[0].logIndex))<=delivery[0].index)return null;
    const path=[debit,...bridgeCalls,credit].map(c=>calls.indexOf(c));
    if(path.some((v,i)=>i>0&&v<=path[i-1]))return null;
    const gas=freshInteger(entry.receipt.gasUsed)*freshInteger(entry.receipt.effectiveGasPrice??tx.gasPrice);
    if(gas<=0n||execution.feeWei!==gas)return null;
    return{kind:quote===stable?'ordinary_token_exchange_via_usdt':'ordinary_token_exchange_via_wbnb',wallet,sellToken:sell,sellRaw:rawIn,buyToken:buy,buyRaw:incoming.incoming,quoteAddress:quote,quoteRaw:bridge[0].raw,gasFeeWei:gas};
  }catch{return null;}
}
