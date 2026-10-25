import {Interface} from 'ethers';
import {WBNB} from '../launchpad.js';
import {TRUSTED_QUOTE_FEEDS} from '../nodeMarketProtocols.js';
import {beforeExecutionTopic,userOperationTopic} from '../smartAccountTrades.js';
import {transferTopic} from '../swap.js';
import {freshInteger,type FreshCapturedReceipt,type FreshLog} from './capture.js';
import type {FreshExecution} from './decode.js';
import {freshNativeDelta,freshTraceMatchesTransaction,validateFreshTrace,type FreshCallTrace} from './trace.js';

// These are settlement adapters, not extra wallet identities. A deposit event
// alone never establishes the seller: the complete successful call must be
// inside that account's signed, EntryPoint-executed batch.
export const FRESH_RELAY_DEPOSITORY='0x4cd00e387622c35bddb9b4c962c136462338bc31';
export const FRESH_NATIVE_BRIDGE='0xa834e70303322d86e5dae95ee47e9c6a073d9812';
const nativeRouter='0x0005ea70fa6dbd2efd17697d2351301adb6318b2';
const entryPoint='0x4337084d9e255ff0702461cf8895ce9e3b5ff108';
const bridgeTopic='0xfe501452dda9020e758013c7a853ee26084957e0f6829b6f9b900741371c750b';
const withdrawalTopic='0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
const aa=new Interface(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)',
  'function executeBatch((address to,uint256 value,bytes data)[] calls)']);
const relay=new Interface(['event RelayErc20Deposit(address from,address token,uint256 amount,bytes32 id)',
  'function depositErc20(address depositor,address token,bytes32 id)','function depositErc20(address depositor,address token,uint256 amount,bytes32 id)']);
const erc20=new Interface(['function transferFrom(address from,address to,uint256 amount)','function allowance(address owner,address spender) view returns(uint256)']);
const depositTopic=relay.getEvent('RelayErc20Deposit')!.topicHash;
const lower=(v:string)=>v.toLowerCase();
const wordAddress=(v:string|undefined)=>v&&/^0{24}[\da-f]{40}$/.test(v)?'0x'+v.slice(24):null;
const words=(v:string)=>/^0x(?:[\da-f]{64})*$/.test(v)?v.slice(2).match(/.{64}/g)??[]:[];
function calls(root:FreshCallTrace){const out:FreshCallTrace[]=[];function walk(c:FreshCallTrace){if(c.error)return;out.push(c);c.calls?.forEach(walk);}walk(root);return out;}
function nativeCalls(root:FreshCallTrace){return calls(root).filter(c=>['CALL','CREATE','CREATE2','SELFDESTRUCT'].includes(c.type)&&c.from!==c.to&&freshInteger(c.value??'0x0')>0n);}
export function hasFreshSmartSellSettlement(logs:readonly FreshLog[]){return logs.some(l=>l.address===FRESH_RELAY_DEPOSITORY&&l.topics[0]===depositTopic||l.address===FRESH_NATIVE_BRIDGE&&l.topics[0]===bridgeTopic);}
export interface FreshSmartSellSettlement {kind:'relay_erc20_deposit'|'signed_native_bridge';quoteAddress:string;quoteRaw:bigint;recipient:string;reference:string;logIndex:number}

/** Narrow single-operation support. No bundler/validation/post-operation cash
 * flows, repeated operations, paymasters, mixed wallet assets or inferred fees.
 * The BSC sale ends at its explicitly authorized bridge payment; a destination
 * chain payout is a different activity and is not asserted by this adapter. */
export function freshSmartAccountSellSettlement(entry:FreshCapturedReceipt,execution:FreshExecution,token:string,targetRaw:bigint,rawTrace:FreshCallTrace):FreshSmartSellSettlement|null{
  try{
    const tx=entry.transaction,wallet=execution.wallet;
    if(execution.kind!=='user_operation'||execution.status!=='success'||!execution.operationHash||targetRaw>=0n||tx.to!==entryPoint||entry.receipt.status!=='0x1'
      ||freshInteger(tx.value)!==0n||!entry.wallets.includes(wallet)||!hasFreshSmartSellSettlement(execution.logs))return null;
    const trace=validateFreshTrace(rawTrace);
    if(!freshTraceMatchesTransaction(trace,tx)||trace.input!==tx.input)return null;
    const parsed=aa.parseTransaction({data:String(tx.input)});
    if(!parsed||parsed.name!=='handleOps'||aa.encodeFunctionData(parsed.fragment,parsed.args).toLowerCase()!==tx.input||parsed.args.ops.length!==1)return null;
    const op=parsed.args.ops[0];
    if(lower(op.sender)!==wallet||op.paymasterAndData!=='0x')return null;
    const markers=entry.receipt.logs.filter(l=>l.address===entryPoint&&l.topics[0]===userOperationTopic);
    const boundaries=entry.receipt.logs.filter(l=>l.address===entryPoint&&l.topics[0]===beforeExecutionTopic);
    if(markers.length!==1||markers[0].topics[1]!==execution.operationHash||boundaries.length!==1||execution.index!==1)return null;
    const start=entry.receipt.logs.indexOf(boundaries[0])+1,end=entry.receipt.logs.indexOf(markers[0]);
    if(start>end||JSON.stringify(entry.receipt.logs.slice(start,end))!==JSON.stringify(execution.logs))return null;
    let prev=-1;
    for(const l of entry.receipt.logs){const i=Number(freshInteger(l.logIndex));if(!Number.isSafeInteger(i)||i<=prev||l.removed||l.blockHash!==tx.blockHash||l.blockNumber!==tx.blockNumber||l.transactionHash!==tx.hash||l.transactionIndex!==tx.transactionIndex)return null;prev=i;}
    const batch=aa.parseTransaction({data:op.callData});
    if(!batch||batch.name!=='executeBatch'||aa.encodeFunctionData(batch.fragment,batch.args).toLowerCase()!==op.callData)return null;
    const executed=calls(trace).filter(c=>c.type==='CALL'&&c.from===entryPoint&&c.to===wallet&&c.input===op.callData);
    if(executed.length!==1||freshInteger(executed[0].value??'0x0')!==0n||freshNativeDelta(executed[0],wallet)!==0n)return null;
    const children=executed[0].calls??[],signed=batch.args.calls;
    if(children.length!==signed.length||children.some((c,i)=>c.error||c.type!=='CALL'||c.from!==wallet||c.to!==lower(signed[i].to)||c.input!==signed[i].data||freshInteger(c.value??'0x0')!==signed[i].value||signed[i].value!==0n))return null;
    // Every non-approval action must be this one sale. We do not allocate a
    // bridge credit between several actions or silently ignore other assets.
    const actions=children.filter(c=>c.to!==token||!c.input?.startsWith('0x095ea7b3'));
    if(actions.length!==1)return null;
    const route=actions[0];
    let net=0n;
    for(const l of execution.logs){if(l.topics[0]!==transferTopic)continue;const w=words(l.data),from=wordAddress(l.topics[1]?.slice(2)??''),to=wordAddress(l.topics[2]?.slice(2)??'');
      if(l.topics.length!==3||w.length!==1||!from||!to)return null;
      if(from!==wallet&&to!==wallet)continue;
      if(l.address!==token&&BigInt('0x'+w[0])!==0n)return null;
      if(l.address===token){if(to===wallet)net+=BigInt('0x'+w[0]);if(from===wallet)net-=BigInt('0x'+w[0]);}
    }
    if(net!==targetRaw)return null;
    const relayLogs=execution.logs.filter(l=>l.address===FRESH_RELAY_DEPOSITORY&&l.topics[0]===depositTopic);
    const bridges=execution.logs.filter(l=>l.address===FRESH_NATIVE_BRIDGE&&l.topics[0]===bridgeTopic);
    if(relayLogs.length===1&&bridges.length===0){
      if(nativeCalls(route).length)return null;
      const log=relayLogs[0],p=relay.parseLog(log);
      if(!p||log.topics.length!==1||relay.encodeEventLog(p.fragment,p.args).data!==log.data||lower(p.args.from)!==wallet||p.args.amount<=0n)return null;
      const quote=lower(p.args.token);if(quote===WBNB||!TRUSTED_QUOTE_FEEDS[quote])return null;
      const deposits=calls(route).filter(c=>c.type==='CALL'&&c.to===FRESH_RELAY_DEPOSITORY&&c.input&&['0x5a1ee3ac',relay.getFunction('depositErc20(address,address,uint256,bytes32)')!.selector].includes(c.input.slice(0,10)));
      if(deposits.length!==1)return null;
      const d=deposits[0],f=relay.parseTransaction({data:d.input!});
      if(!f||relay.encodeFunctionData(f.fragment,f.args).toLowerCase()!==d.input||lower(f.args.depositor)!==wallet||lower(f.args.token)!==quote||f.args.id!==p.args.id||f.args.amount!==undefined&&f.args.amount!==p.args.amount)return null;
      const movements=execution.logs.filter(l=>l.address===quote&&l.topics[0]===transferTopic&&wordAddress(l.topics[2]?.slice(2)??'')===FRESH_RELAY_DEPOSITORY);
      if(movements.length!==1||wordAddress(movements[0].topics[1].slice(2))!==d.from||BigInt(movements[0].data)!==p.args.amount||freshInteger(movements[0].logIndex)>=freshInteger(log.logIndex))return null;
      const transfer=calls(d).filter(c=>c.type==='CALL'&&c.from===FRESH_RELAY_DEPOSITORY&&c.to===quote&&c.input===erc20.encodeFunctionData('transferFrom',[d.from,FRESH_RELAY_DEPOSITORY,p.args.amount]).toLowerCase());
      if(transfer.length!==1||transfer[0].output!=='0x'&&BigInt(transfer[0].output??'0x0')!==1n)return null;
      return{kind:'relay_erc20_deposit',quoteAddress:quote,quoteRaw:p.args.amount,recipient:FRESH_RELAY_DEPOSITORY,reference:p.args.id,logIndex:Number(freshInteger(log.logIndex))};
    }
    if(bridges.length!==1||relayLogs.length||route.to!==nativeRouter||!route.input?.startsWith('0xea239ef1'))return null;
    const head=route.input.slice(10).match(/.{64}/g)??[];
    if(head.length<8||wordAddress(head[0])!==token||BigInt('0x'+head[1])!==-targetRaw||head[3]==='0'.repeat(64)||head[4]==='0'.repeat(64))return null;
    const log=bridges[0],body=words(log.data);
    if(log.topics.length!==3||wordAddress(log.topics[2].slice(2))!==wallet||body.length!==6||body[0]!==head[3]||body[1]!==head[4]||BigInt('0x'+body[2])!==0n||body[4]!==head[5])return null;
    const native=BigInt('0x'+body[3]);if(native<=0n)return null;
    const deposits=calls(route).filter(c=>c.type==='CALL'&&c.to===FRESH_NATIVE_BRIDGE);
    if(deposits.length!==1)return null;
    const deposit=deposits[0],args=words('0x'+(deposit.input??'').slice(10));
    if(deposit.from!==nativeRouter||freshInteger(deposit.value??'0x0')!==native||!deposit.input?.startsWith('0x70ba5d3c')||args.length!==6||wordAddress(args[0])!==wallet
      ||args[1]!==head[3]||args[2]!==head[4]||args[3]!==head[5]||args[4]!==head[6]||args[5]!==head[7])return null;
    const withdrawals=execution.logs.filter(l=>l.address===WBNB&&l.topics[0]===withdrawalTopic);
    if(withdrawals.length!==1||withdrawals[0].topics.length!==2||wordAddress(withdrawals[0].topics[1].slice(2))!==nativeRouter||words(withdrawals[0].data).length!==1)return null;
    const gross=BigInt(withdrawals[0].data),cash=nativeCalls(route);
    // Gross pool output = actual bridge payment + actual route expenses.
    // Neither self-CALLs nor DELEGATECALL value is an additional payment.
    const funding=cash.filter(c=>c.type==='CALL'&&c.from===WBNB&&c.to===nativeRouter&&freshInteger(c.value!)===gross);
    const spends=cash.filter(c=>c.type==='CALL'&&c.from===nativeRouter);
    if(funding.length!==1||cash.length!==funding.length+spends.length||!spends.includes(deposit)||spends.reduce((n,c)=>n+freshInteger(c.value!),0n)!==gross)return null;
    return{kind:'signed_native_bridge',quoteAddress:WBNB,quoteRaw:native,recipient:FRESH_NATIVE_BRIDGE,reference:log.topics[1],logIndex:Number(freshInteger(log.logIndex))};
  }catch{return null;}
}
