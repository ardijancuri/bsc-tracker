import {describe,expect,it,vi} from 'vitest';
import {Interface} from 'ethers';
import type {Pool} from 'pg';
import type {Rpc} from '../rpc.js';
import {WBNB} from '../launchpad.js';
import {transferTopic} from '../swap.js';
import {decodeFreshEvidence,encodeFreshEvidence,type FreshCapturedReceipt} from './capture.js';
import {createFreshUrgentEvidenceCapture,freshUrgentTokenTargets} from './urgentEvidence.js';
const wallet='0x'+'1'.repeat(40),router='0x'+'2'.repeat(40),token='0x'+'7'.repeat(40),hash='0x'+'a'.repeat(64),tx='0x'+'b'.repeat(64),abi=new Interface(['function decimals()view returns(uint8)','function totalSupply()view returns(uint256)']);
const word=(v:string)=>'0x'+v.slice(2).padStart(64,'0');
function entry(quote:string,time:Date):FreshCapturedReceipt{
 const log=(address:string,from:string,to:string,index:number)=>({address,topics:[transferTopic,word(from),word(to)],data:word('0x1'),logIndex:'0x'+index.toString(16),transactionHash:tx,transactionIndex:'0x0',blockNumber:'0x65',blockHash:hash});
 return{transaction:{hash:tx,from:wallet,to:router,value:'0x0',type:'0x0',gasPrice:'0x1',blockHash:hash,blockNumber:'0x65',transactionIndex:'0x0'},receipt:{transactionHash:tx,transactionIndex:'0x0',blockHash:hash,blockNumber:'0x65',status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[log(token,wallet,router,0),log(quote,router,wallet,1)]},wallets:[wallet],observedAt:time.toISOString()};
}
describe('urgent exact-block settlement quote precision',()=>{
 it.each([[WBNB,18],['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',6],['0x55d398326f99059ff775485246999027b3197955',8]] as const)('retains actual precision for %s even when supply and optional feeds fail',async(quote,decimals)=>{
  const now=new Date(),original=entry(quote,now);expect(freshUrgentTokenTargets(original)).toEqual([token,quote]);let payload=encodeFreshEvidence(original);const statements:string[]=[];
  const query=vi.fn(async(sql:string,args:any[]=[])=>{statements.push(sql);if(sql.startsWith('SELECT e.payload'))return{rows:[{payload,tx_hash:tx,block_hash:hash,block_number:'101',occurred_at:now}]};if(sql.startsWith('SELECT block_hash'))return{rows:[{block_hash:hash}]};if(sql.startsWith('SELECT payload'))return{rows:[{payload,wallet_addresses:[wallet]}]};if(sql.startsWith('UPDATE fresh.recent_evidence')){payload=args[2];return{rows:[],rowCount:1}}return{rows:[],rowCount:0}});
  const db={query,connect:async()=>({query,release(){}})} as unknown as Pool,requests:any[]=[];
  const rpc:Rpc=async<T>(method:string,params:unknown[])=>{requests.push([method,params]);expect(method).toBe('eth_call');expect(params[1]).toEqual({blockHash:hash,requireCanonical:true});const c=params[0] as {to:string;data:string};if(c.data===abi.encodeFunctionData('decimals')&&(c.to===quote||c.to===token))return abi.encodeFunctionResult('decimals',[c.to===quote?decimals:9]) as T;throw Error('fixture_unavailable_optional_state')};
  await createFreshUrgentEvidenceCapture(db,rpc)({now});const saved=decodeFreshEvidence(payload),precision=saved.stateEvidence?.calls.find(c=>c.to===quote&&c.data===abi.encodeFunctionData('decimals'));
  expect(precision?.result).toBe(abi.encodeFunctionResult('decimals',[decimals]));expect(saved.stateEvidence?.blockNumber).toBe(101);expect(saved.stateEvidence?.blockHash).toBe(hash);expect(saved.transaction).toEqual(original.transaction);expect(saved.receipt).toEqual(original.receipt);expect(requests.some(([,p])=>p[0].to===quote&&p[0].data===abi.encodeFunctionData('decimals'))).toBe(true);expect(statements.some(sql=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints/.test(sql))).toBe(false);
 });
});
