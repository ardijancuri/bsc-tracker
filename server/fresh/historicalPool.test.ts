import {describe,it,expect} from 'vitest';
import {Interface} from 'ethers';
import type {Rpc} from '../rpc.js';
import {PCS_V2_FACTORY,WBNB} from '../launchpad.js';
import type {FreshStateReadEvidence} from './stateEvidence.js';
import type {FreshLog} from './capture.js';
import {recoverFreshHistoricalPool} from './historicalPool.js';
const abi=new Interface(['function decimals() view returns(uint8)','function factory() view returns(address)',
 'function token0() view returns(address)','function token1() view returns(address)','function getPair(address,address) view returns(address)',
 'function getReserves() view returns(uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)','event Sync(uint112 reserve0,uint112 reserve1)']);
const h=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),token='0x'+'1'.repeat(40),pool='0x'+'2'.repeat(40);
const target={number:102,hash:h(102),timestamp:'2026-10-22T18:50:00Z'};
function seed():FreshStateReadEvidence{
 const c=(to:string,method:string,args:unknown[],result:unknown[])=>({to,data:abi.encodeFunctionData(method,args),result:abi.encodeFunctionResult(method,result)});
 return{version:1,blockNumber:100,blockHash:h(100),calls:[c(PCS_V2_FACTORY,'getPair',[token,WBNB],[pool]),c(pool,'factory',[],[PCS_V2_FACTORY]),
  c(pool,'token0',[],[token]),c(pool,'token1',[],[WBNB]),c(WBNB,'decimals',[],[18]),c(token,'decimals',[],[9]),c(pool,'getReserves',[],[1000n*10n**9n,10n**18n,1])]};
}
const sync=(n=101)=>{const encoded=abi.encodeEventLog(abi.getEvent('Sync')!,[1000n*10n**9n,2n*10n**18n]);return{address:pool,...encoded,blockNumber:'0x'+n.toString(16),blockHash:h(n),transactionHash:h(1000+n),transactionIndex:'0x0',logIndex:'0x2'} as FreshLog;};
const rpc=(logs:FreshLog[])=>(async(method:string,params:any[])=>{expect(method).toBe('eth_getLogs');expect(params[0].fromBlock).toBe('0x65');expect(params[0].toBlock).toBe('0x66');return logs;}) as Rpc;
const canonicalHash=async(n:number)=>h(n);
const options=()=>({rpc:rpc([sync()]),source:seed(),target,tokenAddress:token,tokenDecimals:9,canonicalHash});
describe('historical pool repair from genuine prior state and Sync logs',()=>{
 it('uses all-market Sync observations instead of a KOL-only transaction curve',async()=>{const p=await recoverFreshHistoricalPool(options());expect(p.priceQuote).toBe('0.002');expect(p.lastSync?.blockNumber).toBe('0x65');});
 it('retains earlier reserves only when the complete queried range has no changes',async()=>{const p=await recoverFreshHistoricalPool({...options(),rpc:rpc([])});expect(p.priceQuote).toBe('0.001');expect(p.lastSync).toBeNull();});
 it('revalidates saved proof without rescanning the range',async()=>{const p=await recoverFreshHistoricalPool(options());const none=(async()=>{throw Error('must_not_read')}) as Rpc;expect((await recoverFreshHistoricalPool({...options(),rpc:none,prior:p})).priceQuote).toBe(p.priceQuote);});
 it('rejects later observations, missing historical calls and foreign/mutable pool identities',async()=>{const a=options();a.source.blockNumber=103;await expect(recoverFreshHistoricalPool(a)).rejects.toThrow();const b=options();b.source.calls=b.source.calls.filter(c=>c.to!==PCS_V2_FACTORY);await expect(recoverFreshHistoricalPool(b)).rejects.toThrow('source_incomplete');
 const c=options();c.source.calls.find(x=>x.to===pool&&x.data===abi.encodeFunctionData('factory'))!.result=abi.encodeFunctionResult('factory',[token]);await expect(recoverFreshHistoricalPool(c)).rejects.toThrow('unverified');});
 it('rejects reorged headers and mismatched quantity precision',async()=>{await expect(recoverFreshHistoricalPool({...options(),canonicalHash:async()=>h(999)})).rejects.toThrow('noncanonical');await expect(recoverFreshHistoricalPool({...options(),tokenDecimals:18})).rejects.toThrow('precision_invalid');});
 it('rejects missing/removed/duplicate/reordered log identities',async()=>{for(const logs of [[{...sync(),removed:true}],[{...sync(),blockHash:h(999)}],[sync(),sync()],[sync(102),sync(101)]])await expect(recoverFreshHistoricalPool({...options(),rpc:rpc(logs)})).rejects.toThrow();});
 it('bounds work and does not accept modified retained price or target',async()=>{await expect(recoverFreshHistoricalPool({...options(),target:{...target,number:5000}})).rejects.toThrow('identity_invalid');const p=await recoverFreshHistoricalPool(options());await expect(recoverFreshHistoricalPool({...options(),prior:{...p,priceQuote:'100'}})).rejects.toThrow('prior_invalid');});
});
