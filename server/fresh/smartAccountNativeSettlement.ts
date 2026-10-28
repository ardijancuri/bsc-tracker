import {AbiCoder,Interface} from 'ethers';
import {WBNB} from '../launchpad.js';
import {beforeExecutionTopic,userOperationTopic} from '../smartAccountTrades.js';
import {transferTopic} from '../swap.js';
import {freshAddress,freshInteger,validateFreshReceipt,type FreshBlock,type FreshCapturedReceipt} from './capture.js';
import type {FreshExecution} from './decode.js';
import {validFreshCompleteCallTrace} from './passiveIncoming.js';
import type {FreshPriceBlock} from './pricing.js';
import {freshNativeDelta,validateFreshTrace,type FreshCallTrace} from './trace.js';

const entryPoint='0x0000000071727de22e5e9d8baf0edac6f37da032';
const zero='0x'+'0'.repeat(40),batchMode='0x01'+'00'.repeat(31);
const aa=new Interface(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)',
 'function execute(bytes32 mode,bytes executionCalldata)']);
const erc20=new Interface(['function approve(address spender,uint256 amount)']);
const coder=AbiCoder.defaultAbiCoder(),batchType='(address to,uint256 value,bytes data)[]';
const address=(topic:string|undefined)=>topic&&/^0x0{24}[\da-f]{40}$/.test(topic)?'0x'+topic.slice(-40):null;
const economic=new Set(['CALL','CREATE','CREATE2','SELFDESTRUCT']);
const supported=new Set(['CALL','STATICCALL','DELEGATECALL','CALLCODE','CREATE','CREATE2','SELFDESTRUCT']);
function calls(root:FreshCallTrace):FreshCallTrace[]{return root.error?[]:[root,...(root.calls??[]).flatMap(calls)];}

export interface FreshSmartAccountNativeSell {
 version:1;kind:'signed_smart_account_native_sell';transactionHash:string;blockNumber:number;blockHash:string;
 walletAddress:string;tokenAddress:string;tokenRaw:string;operationHash:string;nativeReceivedWei:string;operationFeeWei:string;
}

/** A successful, single unsponsored v0.7 operation signs one zero-value sale
 * and optional exact token approvals. Its complete call tree proves the actual
 * native wallet payout separately from the EntryPoint operation fee. Neither a
 * bundler's receipt gas nor an inner pool's gross output is sale proceeds. */
export function freshSmartAccountNativeSell(entry:FreshCapturedReceipt,execution:FreshExecution,block:FreshPriceBlock,tokenAddress:string,targetRaw:bigint,rawTrace:FreshCallTrace):FreshSmartAccountNativeSell|null {
 try {
  const {transaction:tx,receipt}=entry,wallet=freshAddress(execution.wallet),token=freshAddress(tokenAddress);
  if(!wallet||!token||token===WBNB||targetRaw>=0n||!entry.wallets.includes(wallet)||execution.kind!=='user_operation'||execution.status!=='success'
   ||execution.index!==1||!execution.operationHash||execution.router!==null||execution.nativeValue!==0n||execution.feeWei===null
   ||tx.to!==entryPoint||tx.from===wallet||freshInteger(tx.value)!==0n||!['0x0','0x1','0x2'].includes(String(tx.type))||tx.authorizationList!==undefined
   ||tx.chainId!=='0x38'||receipt.status!=='0x1'||tx.blockHash!==block.hash||Number(freshInteger(tx.blockNumber))!==block.number
   ||!Number.isSafeInteger(block.number)||!Number.isFinite(Date.parse(block.timestamp))||receipt.logs.length>512)return null;
  validateFreshReceipt(receipt,tx,{number:tx.blockNumber,hash:block.hash,timestamp:'0x'+Math.floor(Date.parse(block.timestamp)/1000).toString(16)} as FreshBlock);
  const trace=validateFreshTrace(rawTrace);if(!validFreshCompleteCallTrace(entry,trace))return null;
  const parsed=aa.parseTransaction({data:String(tx.input)});
  if(!parsed||parsed.name!=='handleOps'||aa.encodeFunctionData(parsed.fragment,parsed.args).toLowerCase()!==tx.input||parsed.args.ops.length!==1)return null;
  const op=parsed.args.ops[0];if(op.sender.toLowerCase()!==wallet||op.initCode!=='0x'||op.paymasterAndData!=='0x'||op.signature==='0x')return null;
  const markers=receipt.logs.filter(l=>l.topics[0]===userOperationTopic),boundaries=receipt.logs.filter(l=>l.address===entryPoint&&l.topics[0]===beforeExecutionTopic);
  if(markers.length!==1||boundaries.length!==1||boundaries[0].topics.length!==1||boundaries[0].data!=='0x')return null;
  const marker=markers[0];if(marker.address!==entryPoint||marker.topics.length!==4||marker.topics[1]!==execution.operationHash||address(marker.topics[2])!==wallet||address(marker.topics[3])!==zero||!/^0x(?:[\da-f]{64}){4}$/.test(marker.data))return null;
  const words=marker.data.slice(2).match(/.{64}/g)!;
  if(BigInt('0x'+words[0])!==op.nonce||BigInt('0x'+words[1])!==1n||BigInt('0x'+words[2])!==execution.feeWei)return null;
  const start=receipt.logs.indexOf(boundaries[0])+1,end=receipt.logs.indexOf(marker);
  if(start>end||JSON.stringify(receipt.logs.slice(start,end))!==JSON.stringify(execution.logs))return null;
  const batch=aa.parseTransaction({data:op.callData});if(!batch||batch.name!=='execute'||batch.args.mode!==batchMode||aa.encodeFunctionData(batch.fragment,batch.args).toLowerCase()!==op.callData)return null;
  const signed=coder.decode([batchType],batch.args.executionCalldata)[0];
  if(signed.length<1||signed.length>8||coder.encode([batchType],[signed]).toLowerCase()!==batch.args.executionCalldata)return null;
  const tree=calls(trace),executed=tree.filter(c=>!c.error&&c.type==='CALL'&&c.from===entryPoint&&c.to===wallet&&c.input===op.callData);
  if(executed.length!==1||freshInteger(executed[0].value??'0x0')!==0n)return null;
  const children=executed[0].calls??[];
  if(children.length!==signed.length||children.some((c,i)=>c.error||c.type!=='CALL'||c.from!==wallet||c.to!==signed[i].to.toLowerCase()||c.input!==signed[i].data||signed[i].value!==0n||freshInteger(c.value??'0x0')!==0n))return null;
  const approvals=children.filter(c=>c.to===token&&c.input?.startsWith('0x095ea7b3'));
  for(const approval of approvals){const p=erc20.parseTransaction({data:approval.input!});if(!p||erc20.encodeFunctionData(p.fragment,p.args).toLowerCase()!==approval.input||approval.output!=='0x'&&BigInt(approval.output??'0x0')!==1n)return null;}
  const actions=children.filter(c=>!approvals.includes(c));if(actions.length!==1||actions[0].to===wallet||actions[0].to===token||actions[0].to===entryPoint)return null;
  const route=actions[0],inside=new Set(calls(route));let native=0n;
  for(const c of tree){
   if(c.error)continue;
   if(!supported.has(c.type))return null;
   if(c.from===wallet&&economic.has(c.type)&&!children.includes(c)&&c.from!==c.to)return null;
   if(c.to===wallet&&c.from!==wallet&&freshInteger(c.value??'0x0')>0n){if(c.type!=='CALL'||!inside.has(c)||c.input!=='0x')return null;native+=freshInteger(c.value!);}
  }
  if(native<=0n||freshNativeDelta(trace,wallet)!==native||freshNativeDelta(executed[0],wallet)!==native)return null;
  let net=0n;
  for(const l of receipt.logs){if(l.topics[0]!==transferTopic)continue;const from=address(l.topics[1]),to=address(l.topics[2]);if(from!==wallet&&to!==wallet)continue;
   if(l.topics.length!==3||!from||!to||!/^0x[\da-f]{64}$/.test(l.data))return null;const raw=BigInt(l.data);if(raw===0n)continue;
   if(!execution.logs.includes(l)||l.address!==token||from!==wallet||to===wallet)return null;net-=raw;
  }
  if(net!==targetRaw)return null;
  return{version:1,kind:'signed_smart_account_native_sell',transactionHash:tx.hash,blockNumber:block.number,blockHash:block.hash,walletAddress:wallet,tokenAddress:token,tokenRaw:String(-targetRaw),operationHash:execution.operationHash,nativeReceivedWei:String(native),operationFeeWei:String(execution.feeWei)};
 }catch{return null;}
}
