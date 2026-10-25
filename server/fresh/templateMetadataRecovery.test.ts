import {readFileSync} from 'node:fs';import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {getCreate2Address,keccak256,toBeHex,zeroPadValue} from 'ethers';import type {Pool} from 'pg';import {describe,it,expect} from 'vitest';
import {flapInterface,FLAP_PORTAL} from '../launchpad.js';import {transferTopic} from '../swap.js';import type {Rpc} from '../rpc.js';
import {encodeFreshEvidence,type FreshCapturedReceipt,type FreshBlock,type FreshReceipt} from './capture.js';
import {createFreshRecoveryBatch} from './recoveryBatch.js';import {createFreshTemplateMetadataRecovery} from './templateMetadataRecovery.js';import {freshConstantCloneInitcode,FRESH_CONSTANT_PRECISION_AUDITS} from './constantMetadataRecovery.js';
const h=(n:number|bigint)=>zeroPadValue(toBeHex(n),32),a=(n:number)=>zeroPadValue(toBeHex(n),20),creator=a(1);
const header=(n:number)=>({number:n,hash:h(n),timestamp:new Date(Date.UTC(2026,0,1)+n*1000).toISOString()});
const code=gunzipSync(Buffer.from(JSON.parse(readFileSync(new URL('./fixtures/constant-precision-code.json',import.meta.url),'utf8')).flap,'base64')).toString();
function creation(n:number){
 const b=header(n),salt=h(n),token=getCreate2Address(FLAP_PORTAL,salt,keccak256(freshConstantCloneInitcode('flap'))).toLowerCase();
 const transaction={hash:h(1000+n),from:creator,to:FLAP_PORTAL,value:'0x0',gasPrice:'0x0',input:'0x12345678',blockNumber:toBeHex(n),blockHash:b.hash,transactionIndex:'0x0'};
 const launch=flapInterface.encodeEventLog(flapInterface.getEvent('TokenCreated')!,[Date.parse(b.timestamp)/1000,creator,n,token,'T','T','']);
 const logs=[{address:token,topics:[transferTopic,h(0),h(1)],data:h(1000)},{address:FLAP_PORTAL,topics:['0xd1e8818b2d9da34c6537d2aa8e66a200caa79c8f3126365e8fd5b29ee28a766d'],data:'0x'+[h(1),salt,h(BigInt(token)),h(6),h(0)].map(x=>x.slice(2)).join('')},{address:FLAP_PORTAL,...launch}]
  .map((log,index)=>({...log,blockNumber:transaction.blockNumber,blockHash:b.hash,transactionHash:transaction.hash,transactionIndex:'0x0',logIndex:toBeHex(index)}));
 const receipt:FreshReceipt={transactionHash:transaction.hash,blockNumber:transaction.blockNumber,blockHash:b.hash,transactionIndex:'0x0',status:'0x1',gasUsed:'0x1',logs};
 const block:FreshBlock={number:transaction.blockNumber,hash:b.hash,parentHash:h(n-1),timestamp:toBeHex(Date.parse(b.timestamp)/1000),transactions:[transaction]};
 return{token,transaction,receipt,block};
}
function fixture(){
 const source=creation(100),target=creation(120),sourceBlock=header(110),clock=Date.now();
 const entry:FreshCapturedReceipt={transaction:{hash:h(2000),from:creator,to:source.token,value:'0x0',blockNumber:toBeHex(110),blockHash:sourceBlock.hash,transactionIndex:'0x0'},receipt:{transactionHash:h(2000),blockNumber:toBeHex(110),blockHash:sourceBlock.hash,transactionIndex:'0x0',status:'0x1',gasUsed:'0x1',logs:[]},wallets:[creator],observedAt:sourceBlock.timestamp,
  stateEvidence:{version:1,blockNumber:110,blockHash:sourceBlock.hash,calls:[{to:source.token,data:'0x313ce567',result:h(18)}]}};
 const row={tx_hash:entry.transaction.hash,block_hash:sourceBlock.hash,block_number:110,transaction_index:0,payload:encodeFreshEvidence(entry),expires_at:clock+72*3600_000,occurred_at:sourceBlock.timestamp};
 const rows=[row];
 const hashes=new Map([100,110,120,130,140].map(n=>[n,h(n)]));let reloads=0,candidateQueries=0;
 const sourceFact={token_address:source.token,protocol:'flap',status:'eligible',block_number:100,block_hash:h(100),tx_hash:source.transaction.hash};
 const db={async query(sql:string,p:any[]=[]):Promise<any>{
  if(sql.includes("value->>'startBlock'"))return{rows:[{revision:1,start_block:0,block_number:140}]};
  if(sql.includes('JOIN fresh.tokens')){candidateQueries++;return{rows:sourceFact.status==='eligible'&&sourceFact.protocol==='flap'?[sourceFact]:[]};}
  if(sql.includes('FROM fresh.launch_facts WHERE token_address'))return{rows:p[0]===source.token?[sourceFact]:[]};
  if(sql.includes('b.occurred_at>=$2'))return{rows:[]};
  if(sql.includes('WITH candidates AS'))return{rows:rows.filter(r=>r.block_number>Number(p[1])&&r.expires_at>Number(p[0])&&hashes.get(r.block_number)===r.block_hash).map(r=>({...r,payload_bytes:r.payload.length}))};
  if(sql.includes('JOIN fresh.recent_blocks target')){reloads++;return{rows:rows.filter(r=>p[0].includes(r.tx_hash)&&p[1].includes(r.block_hash)&&hashes.get(r.block_number)===r.block_hash&&hashes.get(p[2])===p[3]&&r.expires_at>Number(p[5])).sort((a,b)=>b.block_number-a.block_number)};}
  throw Error('Unexpected SQL');
 }} as unknown as Pool;
 const rpc:Rpc=async<T>(method:string,p:any[]):Promise<T>=>{
  if(method==='eth_chainId')return '0x38' as T;
  if(method==='eth_getCode')return code as T;
  if(method==='eth_getBlockByNumber')return(Number(BigInt(p[0]))===100?source.block:target.block) as T;
  if(method==='eth_getTransactionReceipt')return(p[0]===source.transaction.hash?source.receipt:target.receipt) as T;
  throw Error('Unexpected RPC');
 };
 const batch=createFreshRecoveryBatch(db,rpc,{now:()=>clock}),loader=createFreshTemplateMetadataRecovery(db,rpc,batch,{target:header(130),entry,
  anchor:async()=>header(140),canonicalHash:async n=>hashes.get(n)??null});
 const fact={protocol:'flap',status:'eligible',block_number:120,block_hash:h(120),tx_hash:target.transaction.hash};
 return{loader,token:target.token,fact,row,rows,hashes,get reloads(){return reloads;},get candidateQueries(){return candidateQueries;},clock,db,rpc,entry,source,target,sourceFact};
}
async function retainedFixture(){
 const f=fixture(),original=await f.loader.metadata(f.token,f.fact);expect(original).not.toBeNull();
 const entry:FreshCapturedReceipt={...f.entry,recoveryEvidence:{version:1,target:header(130),metadata:{[f.token]:original!.proof},quotes:[],pools:[]}};
 const batch=createFreshRecoveryBatch(f.db,f.rpc,{now:()=>f.clock,maxRows:1});
 const loader=createFreshTemplateMetadataRecovery(f.db,f.rpc,batch,{target:header(130),entry,anchor:async()=>header(140),canonicalHash:async n=>f.hashes.get(n)??null});
 return{f,entry,batch,loader,proof:original!.proof as any};
}
describe('bounded template loader source authority',()=>{
 it('revalidates a retained source with both canonical constructors and exact code without warming a cold index',async()=>{
  const{f,batch,loader}=await retainedFixture(),candidates=f.candidateQueries;
  expect((await loader.metadata(f.token,f.fact))?.value.decimals).toBe(18);expect(batch.stats().scans).toBe(0);expect(f.candidateQueries).toBe(candidates);
 });
 it('uses serialized precision only as untrusted text and regenerates the raw/code-backed result',async()=>{
  const{f,entry,batch,loader,proof}=await retainedFixture();proof.decimals=6;proof.source.call.result=h(6);
  expect((await loader.metadata(f.token,f.fact))?.value.decimals).toBe(18);expect(batch.stats().scans).toBe(0);expect((entry.recoveryEvidence!.metadata[f.token]as any).decimals).toBe(6);
 });
 it('falls back to ordinary discovery for an envelope hash change without inheriting the old serialized proof',async()=>{
  const{f,loader,batch,proof}=await retainedFixture();f.entry.trace={type:'CALL',from:creator,to:f.source.token,value:'0x0'};f.row.payload=encodeFreshEvidence(f.entry);
  const value=await loader.metadata(f.token,f.fact);expect(value?.value.decimals).toBe(18);expect(batch.stats().scans).toBeGreaterThan(0);expect((value?.proof as any).source.payloadSha256).not.toBe(proof.source.payloadSha256);
 });
 it('never turns a modified raw precision call into an approved constant proof',async()=>{
  const{f,loader}=await retainedFixture();f.entry.stateEvidence!.calls[0].result=h(6);f.row.payload=encodeFreshEvidence(f.entry);
  expect(await loader.metadata(f.token,f.fact)).toBeNull();
 });
 it('tries independently verified ordinary sources after a checksum-matching retained hint fails the pure verifier',async()=>{
  const{f,entry,proof}=await retainedFixture(),valid=structuredClone(f.entry),at=header(115);
  valid.transaction={...valid.transaction,hash:h(2001),blockNumber:toBeHex(115),blockHash:at.hash};valid.receipt={...valid.receipt,transactionHash:h(2001),blockNumber:toBeHex(115),blockHash:at.hash};
  valid.observedAt=at.timestamp;valid.stateEvidence={...valid.stateEvidence!,blockNumber:115,blockHash:at.hash};
  f.rows.push({...f.row,tx_hash:h(2001),block_hash:at.hash,block_number:115,occurred_at:at.timestamp,payload:encodeFreshEvidence(valid)});f.hashes.set(115,at.hash);
  f.entry.stateEvidence!.calls[0].result=h(6);f.row.payload=encodeFreshEvidence(f.entry);proof.source.payloadSha256=createHash('sha256').update(f.row.payload).digest('hex');
  const batch=createFreshRecoveryBatch(f.db,f.rpc,{now:()=>f.clock}),loader=createFreshTemplateMetadataRecovery(f.db,f.rpc,batch,{target:header(130),entry,anchor:async()=>header(140),canonicalHash:async n=>f.hashes.get(n)??null});
  const result=await loader.metadata(f.token,f.fact);expect(result?.value.decimals).toBe(18);expect((result?.proof as any).source.block.number).toBe(115);expect(batch.stats().scans).toBeGreaterThan(0);
 });
 it('rechecks retained raw expiry/checksum and canonical source/creation headers without cached authority',async()=>{
  for(const mutation of[(f:ReturnType<typeof fixture>)=>{f.row.expires_at=f.clock-1;},(f:ReturnType<typeof fixture>)=>{f.row.payload=Buffer.from(f.row.payload);f.row.payload[4]^=1;},(f:ReturnType<typeof fixture>)=>{f.hashes.set(110,h(999));},(f:ReturnType<typeof fixture>)=>{f.hashes.set(100,h(999));},(f:ReturnType<typeof fixture>)=>{f.hashes.set(130,h(999));}]){
   const{f,loader}=await retainedFixture();mutation(f);expect(await loader.metadata(f.token,f.fact)).toBeNull();
  }
 });
 it('requires the actual source fact and original constructors rather than compact prior creation claims',async()=>{
  for(const mutation of[(f:ReturnType<typeof fixture>)=>{f.sourceFact.status='unverified';},(f:ReturnType<typeof fixture>)=>{f.sourceFact.protocol='fourmeme';},(f:ReturnType<typeof fixture>)=>{f.source.receipt.status='0x0';},(f:ReturnType<typeof fixture>)=>{f.source.transaction.input='0x1234';f.source.receipt.logs=f.source.receipt.logs.filter(log=>log.topics[0]!=='0xd1e8818b2d9da34c6537d2aa8e66a200caa79c8f3126365e8fd5b29ee28a766d');}]){
   const{f,loader}=await retainedFixture();mutation(f);expect(await loader.metadata(f.token,f.fact)).toBeNull();
  }
 });
 it('bounds malformed proof hints and falls back without treating their addresses or metadata as evidence',async()=>{
  for(const mutate of[(p:any)=>{p.source.payloadSha256='bad';},(p:any)=>{p.source.block.number=130;},(p:any)=>{p.auditId='foreign';},(p:any)=>{p.tokenAddress=a(999);},(p:any)=>{p.source.tokenAddress='x'.repeat(2048);},(p:any)=>{p.target=header(999);}]){
   const{f,loader,batch,proof}=await retainedFixture();mutate(proof);expect((await loader.metadata(f.token,f.fact))?.value.decimals).toBe(18);expect(batch.stats().scans).toBeGreaterThan(0);
  }
 });
 it('reloads original source payload on every target even while discovery remains memoized',async()=>{
  const f=fixture();expect((await f.loader.metadata(f.token,f.fact))?.value.decimals).toBe(18);const first=f.reloads;
  expect((await f.loader.metadata(f.token,f.fact))?.value.decimals).toBe(18);expect(f.reloads).toBeGreaterThan(first);
 });
 it('rejects a source that expires after the source-discovery memo was established',async()=>{
  const f=fixture();expect(await f.loader.metadata(f.token,f.fact)).not.toBeNull();f.row.expires_at=f.clock-1;expect(await f.loader.metadata(f.token,f.fact)).toBeNull();
 });
 it('rejects corrupted or replaced raw proof instead of reusing the old cached Buffer',async()=>{
  const f=fixture();expect(await f.loader.metadata(f.token,f.fact)).not.toBeNull();f.row.payload=Buffer.from(f.row.payload);f.row.payload[4]^=1;expect(await f.loader.metadata(f.token,f.fact)).toBeNull();
 });
 it('rejects changed source or creation canonical identity without requiring memo expiry',async()=>{
  const f=fixture();expect(await f.loader.metadata(f.token,f.fact)).not.toBeNull();f.hashes.set(110,h(999));expect(await f.loader.metadata(f.token,f.fact)).toBeNull();
  const g=fixture();expect(await g.loader.metadata(g.token,g.fact)).not.toBeNull();g.hashes.set(100,h(999));expect(await g.loader.metadata(g.token,g.fact)).toBeNull();
 });
});
