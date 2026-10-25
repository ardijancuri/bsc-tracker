import {describe,it,expect,vi} from 'vitest';
import {Interface} from 'ethers';
import type {Rpc} from '../rpc.js';
import {PCS_V3_FACTORY} from '../launchpad.js';
import {v3MarketAbi} from '../nodeMarketProtocols.js';
import {FRESH_PCS_V3_DEPLOYER} from './currentV3Quote.js';
import {freshHistoricalV3Pool,recoverFreshHistoricalV3Quote,valueFreshHistoricalV3QuoteRaw} from './historicalV3Quote.js';
import {recoverFreshHistoricalQuote} from './historicalQuote.js';
const h=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),quote='0x'+'9'.repeat(40),settlement='0x55d398326f99059ff775485246999027b3197955';
const abi=new Interface(['function getPool(address,address,uint24)view returns(address)','function poolDeployer()view returns(address)',
  'function factory()view returns(address)','function token0()view returns(address)','function token1()view returns(address)','function fee()view returns(uint24)']);
const feedAbi=new Interface(['function decimals()view returns(uint8)','function description()view returns(string)',
  'function latestRoundData()view returns(uint80,int256,uint256,uint256,uint80)']);
function fixture(options:{quote?:string;fee?:number;chain?:string;badRegistry?:boolean;badDeployer?:boolean;badFactory?:boolean;badAsset?:boolean;badCode?:boolean;age?:number;targetTx?:number;swapTx?:number;badCanonical?:number;sqrt?:bigint;liquidity?:bigint;reversed?:boolean;removed?:boolean;dirty?:boolean;scrambled?:boolean}={}){
  const asset=options.quote??quote,fee=options.fee??2500,pool=freshHistoricalV3Pool(asset,settlement,fee),assets=[asset,settlement].sort();
  const anchor={number:1000,hash:h(1000),timestamp:new Date(Math.floor(Date.now()/1000)*1000).toISOString()},target={number:500,hash:h(500),timestamp:new Date(Date.parse(anchor.timestamp)-3600_000).toISOString()},age=options.age??1000;
  const source={number:age===0?500:499,hash:age===0?h(500):h(499),timestamp:new Date(Date.parse(target.timestamp)-age).toISOString()};
  const encoded=v3MarketAbi.encodeEventLog(v3MarketAbi.getEvent('Swap')!,['0x'+'1'.repeat(40),'0x'+'2'.repeat(40),1n,-1n,options.sqrt??2n*(1n<<96n),options.liquidity??100n,13863,0n,0n]);
  const log={address:pool,topics:encoded.topics,data:options.dirty?encoded.data+'00':encoded.data,blockNumber:'0x'+source.number.toString(16),blockHash:source.hash,
    transactionHash:h(1),transactionIndex:'0x'+(options.swapTx??1).toString(16),logIndex:'0x1',...(options.removed?{removed:true}:{})};
  const rpc=vi.fn(async(method:string,args:any[])=>{
    if(method==='eth_chainId')return options.chain??'0x38';
    if(method==='eth_getCode'){expect(args[1]).toEqual({blockHash:anchor.hash,requireCanonical:true});return args[0]===pool?(options.badCode?'0x60':'0x'+'60'.repeat(1025)):'0x6000';}
    if(method==='eth_getLogs'){expect(args[0].address).toBe(pool);return options.reversed?[log,{...log,logIndex:'0x0'}]:[log];}
    if(method==='eth_getBlockByNumber')return{number:'0x'+source.number.toString(16),hash:source.hash,timestamp:'0x'+(Date.parse(source.timestamp)/1000).toString(16)};
    expect(method).toBe('eth_call');expect(args[1]).toEqual({blockHash:anchor.hash,requireCanonical:true});
    const call=abi.parseTransaction(args[0])!,name=call.name;
    if(options.scrambled)await new Promise(resolve=>setTimeout(resolve,name==='getPool'?6:name==='factory'?3:0));
    if(name==='getPool')return abi.encodeFunctionResult(name,[options.badRegistry?asset:pool]);
    if(name==='poolDeployer')return abi.encodeFunctionResult(name,[options.badDeployer?asset:FRESH_PCS_V3_DEPLOYER]);
    if(name==='factory')return abi.encodeFunctionResult(name,[options.badFactory?asset:PCS_V3_FACTORY]);
    if(name==='token0'||name==='token1')return abi.encodeFunctionResult(name,[options.badAsset?asset:assets[name==='token0'?0:1]]);
    if(name==='fee')return abi.encodeFunctionResult(name,[fee]);throw Error('unexpected_current_price_or_precision_read');
  }) as unknown as Rpc&ReturnType<typeof vi.fn>;
  return{rpc,quoteAddress:asset,settlementAddress:settlement,fee,target,anchor,transactionIndex:options.targetTx??2,canonicalHash:async(n:number)=>n===options.badCanonical?h(999):h(n),source,pool};
}

import{recoverFreshQuotePaymentV3}from'./quotePaymentV3.js';
import{createFreshReceiptRecovery}from'./recovery.js';
const SPCXB='0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1';
async function paymentFixture(){const f=fixture({quote:SPCXB}),at=Math.floor(Date.parse(f.target.timestamp)/1000),id=(1n<<64n)|1n;
 const rpc=(async(method:string,args:any[])=>{if(method==='eth_call'&&args[0].to==='0xb97ad0e74fa7d920791e90258a6e2085088b4320'){const name=feedAbi.parseTransaction(args[0])!.name;return feedAbi.encodeFunctionResult(name,name==='decimals'?[8]:name==='description'?['USDT / USD']:[id,99900000,at-1,at-1,id]);}return f.rpc(method,args);})as Rpc;
 const payment:any={version:1,kind:'wallet_erc20_quote_settlement',side:'buy',transactionHash:h(22),blockNumber:f.target.number,blockHash:f.target.hash,transactionIndex:f.transactionIndex,walletAddress:'0x'+'a'.repeat(40),tokenAddress:'0x'+'b'.repeat(40),quoteAddress:SPCXB,tokenRaw:'2000000000000000000',quoteRaw:'1000000000000000000',outgoingQuoteRaw:'1000000000000000000',incomingQuoteRaw:'0',gasFeeWei:'1',quoteTransferLogIndices:[1],tokenTransferLogIndices:[2]};
 const state:any={version:1,blockNumber:f.target.number,blockHash:f.target.hash,calls:[{to:settlement,data:'0x313ce567',result:'0x'+(18).toString(16).padStart(64,'0')}]};const proof=await recoverFreshQuotePaymentV3({rpc,payment,target:f.target,anchor:f.anchor,canonicalHash:f.canonicalHash,state});return{f,payment,state,proof};}
it('composes genuine2s-style historicalSwap with strictdatedfeed and revalidates0RPC',async()=>{const x=await paymentFixture(),none=vi.fn(async()=>{throw Error('no_network')})as unknown as Rpc;expect(await recoverFreshQuotePaymentV3({rpc:none,payment:x.payment,target:x.f.target,anchor:x.f.anchor,canonicalHash:x.f.canonicalHash,state:x.state,prior:x.proof})).toEqual(x.proof);expect(x.proof.amountUsd).toBe('0.24975');expect(none).not.toHaveBeenCalled();});
for(const[name,change]of[
 ['foreigntarget',(x:any)=>x.f.target.hash=h(77)],['orphanSource',(x:any)=>x.f.canonicalHash=async(n:number)=>n===499?h(77):h(n)],['orphanConversionAnchor',(x:any)=>x.f.canonicalHash=async(n:number)=>n===1000?h(77):h(n)],['orphanDistinctFeedAnchor',(x:any)=>{x.proof.feed.anchor={...x.proof.feed.anchor,number:1001,hash:h(1001)};x.f.canonicalHash=async(n:number)=>n===1001?h(77):h(n);}],['staleSource',(x:any)=>x.proof.conversion.source.timestamp=new Date(Date.parse(x.f.target.timestamp)-120001).toISOString()],['futureSource',(x:any)=>x.proof.conversion.source.timestamp=new Date(Date.parse(x.f.target.timestamp)+1).toISOString()],['currentRatioSubstitution',(x:any)=>x.proof.conversion.ratio={numerator:'1',denominator:'1'}],['missingPrecision',(x:any)=>x.state.calls=[]],['forgedPrice',(x:any)=>x.proof.feed.priceUsd='1']
]as const)it('rejects '+name+' without financial approval',async()=>{const x=await paymentFixture();change(x);await expect(recoverFreshQuotePaymentV3({rpc:async()=>{throw Error('no_network')},payment:x.payment,target:x.f.target,anchor:x.f.anchor,canonicalHash:x.f.canonicalHash,state:x.state,prior:x.proof})).rejects.toThrow();});
it('keeps bounded same-target rawproof when nativefeed is temporarily unavailable',async()=>{const x=await paymentFixture(),entry:any={transaction:{hash:x.payment.transactionHash},recoveryEvidence:{version:1,target:x.f.target,metadata:{},quotes:[],pools:[],v3QuotePayments:[x.proof]}},db:any={query:async()=>({rows:[]})};const recovery=createFreshReceiptRecovery(db,async()=>{throw Error('no_rpc')},entry,x.f.target);expect(await recovery.quotePaymentUsd(x.payment.tokenAddress,x.payment.walletAddress,BigInt(x.payment.tokenRaw),null,true)).toBeNull();expect(recovery.snapshot()?.v3QuotePayments).toEqual([x.proof]);});
