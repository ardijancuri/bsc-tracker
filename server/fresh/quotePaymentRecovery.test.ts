import {Interface} from 'ethers';
import {describe,it,expect,vi} from 'vitest';
import type {Pool} from 'pg';
import type {Rpc} from '../rpc.js';
import {PCS_V2_FACTORY} from '../launchpad.js';
import {transferTopic} from '../swap.js';
import {createFreshReceiptRecovery} from './recovery.js';
import {freshPoolNativePair} from './currentPoolQuote.js';
import {factoryCode,pairCode} from './currentQuote.fixture.js';
import type {FreshCapturedReceipt,FreshLog} from './capture.js';
import {normalizeFreshReceipt,type FreshDecodeServices} from './decode.js';
import {WBNB} from '../launchpad.js';

const quote='0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',token='0x'+'7'.repeat(40),wallet='0x'+'1'.repeat(40),router='0x'+'3'.repeat(40);
const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),hex=(n:number)=>'0x'+n.toString(16);
const word=(value:string|bigint)=>typeof value==='string'?value.slice(2).padStart(64,'0'):value.toString(16).padStart(64,'0');
const abi=new Interface(['event Sync(uint112 reserve0,uint112 reserve1)','event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
function fixture(sell=false){
  const wall=Math.floor(Date.now()/1000)*1000,target={number:10000,hash:hash(10000),timestamp:new Date(wall-60000).toISOString()},anchor={number:10100,hash:hash(10100),timestamp:new Date(wall-2000).toISOString()};
  const txHash=hash(90000),raw=123n*10n**18n,paid=5n*10n**6n;
  const transfer=(asset:string,from:string,to:string,quantity:bigint,index:number):FreshLog=>({address:asset,topics:[transferTopic,'0x'+word(from),'0x'+word(to)],data:'0x'+word(quantity),
    logIndex:hex(index),transactionHash:txHash,transactionIndex:'0x2',blockNumber:hex(target.number),blockHash:target.hash});
  const entry:FreshCapturedReceipt={transaction:{hash:txHash,blockHash:target.hash,blockNumber:hex(target.number),transactionIndex:'0x2',from:wallet,to:router,type:'0x2',value:'0x0'},
    receipt:{transactionHash:txHash,blockHash:target.hash,blockNumber:hex(target.number),transactionIndex:'0x2',status:'0x1',gasUsed:'0x186a0',effectiveGasPrice:'0x3b9aca00',logs:sell?
      [transfer(token,wallet,router,raw,1),transfer(quote,router,wallet,paid,2)]:[transfer(quote,wallet,router,paid,1),transfer(token,router,wallet,raw,2)]},wallets:[wallet],observedAt:target.timestamp};
  const pair=freshPoolNativePair(quote),sync:FreshLog={address:pair,...abi.encodeEventLog('Sync',[paid,100n*10n**18n]),blockNumber:hex(9999),blockHash:hash(9999),transactionHash:hash(90001),transactionIndex:'0x1',logIndex:'0x0'};
  const reads:string[]=[],logs=[sync],canonical=new Map<number,string>();
  const rpc=(async(method:string,params:unknown[])=>{
    reads.push(method);if(method==='eth_chainId')return'0x38';
    if(method==='eth_getCode'){expect(params[1]).toEqual({blockHash:anchor.hash,requireCanonical:true});return params[0]===PCS_V2_FACTORY?factoryCode:params[0]===pair?pairCode:'0x';}
    if(method==='eth_getLogs')return logs;throw Error('unapproved_rpc');
  })as Rpc;
  const db={query:async(sql:string,params:unknown[])=>{
    if(sql.includes("c.key='capture'"))return{rows:[{block_number:anchor.number,block_hash:anchor.hash,occurred_at:anchor.timestamp}]};
    if(sql.startsWith('SELECT block_hash FROM fresh.recent_blocks'))return{rows:[{block_hash:canonical.get(Number(params[0]))??hash(Number(params[0]))}]};
    throw Error('unexpected_database_write_or_query');
  }}as unknown as Pool;
  return {db,rpc,entry,target,raw:sell?-raw:raw,reads,logs,canonical};
}

describe('settled ERC20 quote recovery wiring',()=>{
  it.each([false,true])('values signed trade settlement using raw reserves without a quote-decimals or current-state call (sell=%s)',async sell=>{
    const f=fixture(sell),recovery=createFreshReceiptRecovery(f.db,f.rpc,f.entry,f.target);
    expect(await recovery.quotePaymentUsd(token,wallet,f.raw,'600',true)).toBeNull();expect(f.reads).toEqual([]);
    expect(await recovery.quotePaymentUsd(token,wallet,f.raw,'600')).toBe('60000');
    expect(recovery.snapshot()!.quotePayments![0]).toMatchObject({payment:{side:sell?'sell':'buy',quoteAddress:quote,quoteRaw:'5000000',gasFeeWei:'100000000000000'},
      conversion:{kind:'historical_raw_pool_native_v2',observation:'before_execution',quoteAddress:quote},nativePriceUsd:'600',amountUsd:'60000'});
    expect(f.reads).not.toContain('eth_call');
  });
  it.each([false,true])('replays a retained payment and conversion without any node RPC (sell=%s)',async sell=>{
    const f=fixture(sell),first=createFreshReceiptRecovery(f.db,f.rpc,f.entry,f.target);
    await first.quotePaymentUsd(token,wallet,f.raw,'600');f.entry.recoveryEvidence=first.snapshot();
    const noRpc=(async()=>{throw Error('no_rpc_after_pruning');})as Rpc;
    expect(await createFreshReceiptRecovery(f.db,noRpc,f.entry,f.target).quotePaymentUsd(token,wallet,f.raw,'600',true)).toBe('60000');
    expect(await createFreshReceiptRecovery(f.db,noRpc,f.entry,f.target).quotePaymentUsd(token,wallet,f.raw,'601',true)).toBeNull();
  });
  it('coalesces repeated proof use into one retained payment identity',async()=>{
    const f=fixture(),first=createFreshReceiptRecovery(f.db,f.rpc,f.entry,f.target);await first.quotePaymentUsd(token,wallet,f.raw,'600');f.entry.recoveryEvidence=first.snapshot();
    const next=createFreshReceiptRecovery(f.db,(async()=>{throw Error('no_rpc_after_pruning');})as Rpc,f.entry,f.target);
    await next.quotePaymentUsd(token,wallet,f.raw,'600',true);await next.quotePaymentUsd(token,wallet,f.raw,'600');expect(next.snapshot()!.quotePayments).toHaveLength(1);
  });
  it('rejects altered retained accounting, payment, ratio, source and observation mode',async()=>{
    const f=fixture(),first=createFreshReceiptRecovery(f.db,f.rpc,f.entry,f.target);await first.quotePaymentUsd(token,wallet,f.raw,'600');f.entry.recoveryEvidence=first.snapshot();
    const noRpc=(async()=>{throw Error('no_rpc_after_pruning');})as Rpc;
    for(const change of[(p:any)=>p.amountUsd='1',(p:any)=>p.payment.quoteRaw='1',(p:any)=>p.conversion.nativeRaw='1',
      (p:any)=>p.conversion.observation='block_end',(p:any)=>p.payment.side='sell']){
      const changed=structuredClone(f.entry);change(changed.recoveryEvidence!.quotePayments![0]);
      expect(await createFreshReceiptRecovery(f.db,noRpc,changed,f.target).quotePaymentUsd(token,wallet,f.raw,'600',true)).toBeNull();
    }
    f.canonical.set(9999,hash(3));expect(await createFreshReceiptRecovery(f.db,noRpc,f.entry,f.target).quotePaymentUsd(token,wallet,f.raw,'600',true)).toBeNull();
  });
  it('leaves missing earlier liquidity, native conflicts, unsupported operations and missing dated USD unavailable',async()=>{
    const f=fixture();f.logs.splice(0);expect(await createFreshReceiptRecovery(f.db,f.rpc,f.entry,f.target).quotePaymentUsd(token,wallet,f.raw,'600')).toBeNull();
    const g=fixture();expect(await createFreshReceiptRecovery(g.db,g.rpc,g.entry,g.target).quotePaymentUsd(token,wallet,g.raw,null)).toBeNull();expect(g.reads).toEqual([]);
    for(const patch of[{type:'0x4'},{to:wallet},{authorizationList:[]},{value:'0x1'}]){const e=fixture();Object.assign(e.entry.transaction,patch);
      expect(await createFreshReceiptRecovery(e.db,e.rpc,e.entry,e.target).quotePaymentUsd(token,wallet,e.raw,'600')).toBeNull();expect(e.reads).toEqual([]);}
    const trace=fixture();trace.entry.trace={type:'CALL',from:wallet,to:router,value:'0x0',calls:[{type:'CALL',from:router,to:wallet,value:'0x1'}]};
    expect(await createFreshReceiptRecovery(trace.db,trace.rpc,trace.entry,trace.target).quotePaymentUsd(token,wallet,trace.raw,'600')).toBeNull();expect(trace.reads).toEqual([]);
  });
  it.each([false,true])('normalizes signed settlement without changing event/gas identity and keeps its retained route when metadata later appears (sell=%s)',async sell=>{
    const f=fixture(sell),swap=abi.encodeEventLog('Swap',[router,1n,0n,0n,1n,wallet]);
    f.entry.receipt.logs.push({...f.entry.receipt.logs[0],address:freshPoolNativePair(quote),...swap,logIndex:'0x3'});
    const recovery=createFreshReceiptRecovery(f.db,f.rpc,f.entry,f.target),callback=vi.fn(recovery.quotePaymentUsd),quoteMetadata=vi.fn(async()=>null);
    const metadata:FreshDecodeServices['metadata']=async address=>address===token?{address,name:'Fixture',symbol:'F',decimals:18,supplyRaw:null,block:f.target}:quoteMetadata();
    const services:FreshDecodeServices={metadata,eligible:async m=>m.address===token,knownLaunch:async address=>address===token,priceUsd:async address=>address===WBNB?'600':address===quote?'1':null,quotePaymentUsd:callback};
    const header={number:'0x2710',hash:f.target.hash,timestamp:hex(Math.floor(Date.parse(f.target.timestamp)/1000))};
    const before=await normalizeFreshReceipt(f.entry,header,{...services,quotePaymentUsd:undefined}),decoded=await normalizeFreshReceipt(f.entry,header,services);
    expect(before.reasons).toContain('trade_value_unavailable');expect(decoded.reasons).toEqual([]);expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]).toMatchObject({kind:sell?'sell':'buy',quantity:'123',amountUsd:'60000',feeUsd:'0.06'});
    expect(decoded.events[0].id).toBe(before.events[0].id);expect(decoded.events[0].feeKey).toBe(before.events[0].feeKey);expect(decoded.events[0].feeUsd).toBe(before.events[0].feeUsd);
    expect(callback.mock.calls.map(c=>[c[2],c[4]])).toEqual([[f.raw,true],[f.raw,undefined]]);
    f.entry.recoveryEvidence=recovery.snapshot();const retained=createFreshReceiptRecovery(f.db,(async()=>{throw Error('no_rpc_after_pruning');})as Rpc,f.entry,f.target),retainedCallback=vi.fn(retained.quotePaymentUsd);
    const newQuoteMetadata=vi.fn(async address=>({address,name:'Quote',symbol:'Q',decimals:0,supplyRaw:null,block:f.target}));
    const again=await normalizeFreshReceipt(f.entry,header,{...services,metadata:async address=>address===token?metadata(address):newQuoteMetadata(address),quotePaymentUsd:retainedCallback});
    expect(again.events[0].amountUsd).toBe('60000');expect(newQuoteMetadata).not.toHaveBeenCalled();expect(retainedCallback).toHaveBeenCalledOnce();expect(retainedCallback.mock.calls[0][4]).toBe(true);
    expect(retained.snapshot()!.quotePayments).toHaveLength(1);
  });
});
