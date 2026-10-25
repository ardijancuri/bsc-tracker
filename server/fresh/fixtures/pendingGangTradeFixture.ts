import{Interface}from'ethers';
import{transferTopic}from'../../swap.js';
import{WBNB}from'../../launchpad.js';
import type{FreshCapturedReceipt}from'../capture.js';
import{FRESH_GANG_PAIR}from'../pendingTrades.js';
import{GANG_TOKEN_ADDRESS,type FreshTokenAdmission}from'../tracking.js';
export const pendingHash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
export const pendingAddress=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const word=(n:bigint)=>'0x'+n.toString(16).padStart(64,'0'),topic=(a:string)=>'0x'+a.slice(2).padStart(64,'0');
export function pendingGangFixture(side:'buy'|'sell'='buy'){
 const wallet=pendingAddress(1),router='0x9689992f5b5c09447f15906d8d11214944488341',number=1002,hash=pendingHash(number),txHash=pendingHash(9000),timestamp='2026-10-25T12:00:02.000Z',raw=10n**18n;
 const common={blockNumber:'0x'+number.toString(16),blockHash:hash,transactionHash:txHash,transactionIndex:'0x0'};
 const transfer={...common,address:GANG_TOKEN_ADDRESS,topics:[transferTopic,topic(side==='buy'?FRESH_GANG_PAIR:wallet),topic(side==='buy'?wallet:FRESH_GANG_PAIR)],data:word(raw),logIndex:'0x0'};
 const abi=new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
 const swap={...common,address:FRESH_GANG_PAIR,...abi.encodeEventLog('Swap',[router,side==='sell'?raw:0n,side==='buy'?1000n:0n,side==='buy'?raw:0n,side==='sell'?1000n:0n,side==='buy'?wallet:router]),logIndex:'0x1'};
 const entry:FreshCapturedReceipt={transaction:{hash:txHash,from:wallet,to:router,input:'0x1234',type:'0x2',chainId:'0x38',value:side==='buy'?'0x3e8':'0x0',gasPrice:'0x0',blockHash:hash,blockNumber:common.blockNumber,transactionIndex:'0x0'},
  receipt:{...common,status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x0',logs:[transfer,swap,...(side==='sell'?[{...common,address:WBNB,topics:['0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65',topic(router)],data:word(1000n),logIndex:'0x2'}]:[])]},wallets:[wallet],observedAt:timestamp};
 const admission:FreshTokenAdmission={kind:'preexisting',launchStatus:'preexisting',fromBlock:1001,admissionDigest:'a'.repeat(64),permission:{version:1,kind:'explicit_existing',chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,active:true,startBlock:1000,startHash:pendingHash(1000),startTime:'2026-10-25T12:00:00.000Z',fromBlock:1001,approvedAt:'2026-10-25T13:00:00.000Z',reason:'user_approved_gang_only'}};
 return{entry,block:{number,hash,timestamp},admission,wallet,router,raw};
}
