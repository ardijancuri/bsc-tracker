import {Interface} from 'ethers';
import {describe,expect,it} from 'vitest';
import type {Pool} from 'pg';
import type {Rpc} from '../rpc.js';
import {FLAP_PORTAL,PCS_V2_FACTORY,flapInterface} from '../launchpad.js';
import {transferTopic} from '../swap.js';
import {createFreshReceiptRecovery} from './recovery.js';
import {freshPoolNativePair} from './currentPoolQuote.js';
import {factoryCode,pairCode} from './currentQuote.fixture.js';
import type {FreshCapturedReceipt,FreshLog} from './capture.js';

const quote='0x'+'9'.repeat(40),token='0x'+'7'.repeat(40),wallet='0x'+'1'.repeat(40);
const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),hex=(n:number)=>'0x'+n.toString(16);
const word=(v:string|bigint)=>typeof v==='string'?v.slice(2).padStart(64,'0'):v.toString(16).padStart(64,'0');
const abi=new Interface(['event TokenQuoteSet(address token,address quoteToken)','event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)','event Sync(uint112 reserve0,uint112 reserve1)']);
function fixture(){
 const wall=Math.floor(Date.now()/1000)*1000,target={number:10000,hash:hash(10000),timestamp:new Date(wall-60000).toISOString()},anchor={number:10100,hash:hash(10100),timestamp:new Date(wall-2000).toISOString()};
 const txHash=hash(90000),raw=123n*10n**18n,paid=5n*10n**6n;
 const log=(address:string,topics:string[],data:string,index:number):FreshLog=>({address,topics,data,logIndex:hex(index),transactionHash:txHash,transactionIndex:'0x2',blockNumber:hex(target.number),blockHash:target.hash});
 const event=(schema:Interface,name:string,args:unknown[],index:number)=>{const value=schema.encodeEventLog(name,args);return log(FLAP_PORTAL,value.topics,value.data,index);};
 const transfer=(address:string,from:string,to:string,quantity:bigint,index:number)=>log(address,[transferTopic,'0x'+word(from),'0x'+word(to)],'0x'+word(quantity),index);
 const entry:FreshCapturedReceipt={transaction:{hash:txHash,blockHash:target.hash,blockNumber:hex(target.number),transactionIndex:'0x2',from:wallet,to:FLAP_PORTAL,type:'0x2',value:'0x0'},
  receipt:{transactionHash:txHash,blockHash:target.hash,blockNumber:hex(target.number),transactionIndex:'0x2',status:'0x1',gasUsed:'0x186a0',effectiveGasPrice:'0x3b9aca00',logs:[
   event(flapInterface,'TokenCreated',[BigInt(Date.parse(target.timestamp)/1000),wallet,1,token,'Fixture','F','https://example.invalid'],1),
   event(abi,'TokenQuoteSet',[token,quote],2),transfer(quote,wallet,FLAP_PORTAL,paid,3),transfer(token,FLAP_PORTAL,wallet,raw,4),
   event(abi,'TokenBought',[BigInt(Date.parse(target.timestamp)/1000),token,wallet,raw,paid,paid/100n,1],5),]},wallets:[wallet],observedAt:target.timestamp};
 const pair=freshPoolNativePair(quote),sync:FreshLog={address:pair,...abi.encodeEventLog('Sync',[paid,100n*10n**18n]),blockNumber:hex(9999),blockHash:hash(9999),transactionHash:hash(90001),transactionIndex:'0x1',logIndex:'0x0'};
 const reads:string[]=[],logs=[sync];
 const rpc=(async(method:string,params:unknown[])=>{
  reads.push(method);if(method==='eth_chainId')return'0x38';
  if(method==='eth_getCode'){expect(params[1]).toEqual({blockHash:anchor.hash,requireCanonical:true});return params[0]===PCS_V2_FACTORY?factoryCode:params[0]===pair?pairCode:'0x';}
  if(method==='eth_getLogs')return logs;throw Error('unapproved_financial_rpc');
 })as Rpc;
 const db={query:async(sql:string,params:unknown[])=>{
  if(sql.includes("c.key='capture'"))return{rows:[{block_number:anchor.number,block_hash:anchor.hash,occurred_at:anchor.timestamp}]};
  if(sql.startsWith('SELECT block_hash FROM fresh.recent_blocks'))return{rows:[{block_hash:hash(Number(params[0]))}]};
  throw Error('unexpected_database_write_or_query');
 }}as unknown as Pool;
 return{db,rpc,entry,target,raw,reads,logs};
}

describe('custom direct Flap settlement recovery wiring',()=>{
 it('values actual gross paid raw units with canonical historical reserves and dated native USD, keeping the embedded fee inside that payment',async()=>{
  const f=fixture(),recovery=createFreshReceiptRecovery(f.db,f.rpc,f.entry,f.target);
  expect(await recovery.directFlapPurchaseUsd(token,wallet,f.raw,'600')).toBe('60000');
  const proof=recovery.snapshot()!.directFlapPurchases![0];
  expect(proof).toMatchObject({payment:{quoteAddress:quote,quoteRaw:'5000000',embeddedQuoteFeeRaw:'50000',gasFeeWei:'100000000000000'},conversion:{kind:'historical_raw_pool_native_v2',quoteAddress:quote},nativePriceUsd:'600',amountUsd:'60000'});
  expect(f.reads).not.toContain('eth_call');
 });
 it('replays its retained exact conversion after historical state pruning and rejects tampered settled quantities or valuation',async()=>{
  const f=fixture(),first=createFreshReceiptRecovery(f.db,f.rpc,f.entry,f.target);
  await first.directFlapPurchaseUsd(token,wallet,f.raw,'600');f.entry.recoveryEvidence=first.snapshot();
  const noRpc=(async()=>{throw Error('pruned_state_no_rpc');})as Rpc;
  expect(await createFreshReceiptRecovery(f.db,noRpc,f.entry,f.target).directFlapPurchaseUsd(token,wallet,f.raw,'600')).toBe('60000');
  const altered=structuredClone(f.entry);altered.recoveryEvidence!.directFlapPurchases![0].amountUsd='1';
  expect(await createFreshReceiptRecovery(f.db,noRpc,altered,f.target).directFlapPurchaseUsd(token,wallet,f.raw,'600')).toBeNull();
  expect(await createFreshReceiptRecovery(f.db,noRpc,f.entry,f.target).directFlapPurchaseUsd(token,wallet,f.raw,'601')).toBeNull();
 });
 it('leaves missing reserve history, unknown native value and wrapper fee semantics unavailable',async()=>{
  const f=fixture();f.logs.splice(0);
  expect(await createFreshReceiptRecovery(f.db,f.rpc,f.entry,f.target).directFlapPurchaseUsd(token,wallet,f.raw,'600')).toBeNull();
  expect(await createFreshReceiptRecovery(f.db,f.rpc,f.entry,f.target).directFlapPurchaseUsd(token,wallet,f.raw,null)).toBeNull();
  const g=fixture();g.entry.transaction.type='0x4';g.entry.transaction.to=wallet;g.entry.transaction.value='0x1';
  expect(await createFreshReceiptRecovery(g.db,g.rpc,g.entry,g.target).directFlapPurchaseUsd(token,wallet,g.raw,'600')).toBeNull();expect(g.reads).toHaveLength(0);
 });
});
