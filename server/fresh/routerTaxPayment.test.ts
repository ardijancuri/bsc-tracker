import{readFileSync}from'node:fs';
import{gunzipSync}from'node:zlib';
import{describe,expect,it,vi}from'vitest';
import type{Pool}from'pg';
import{decodeFreshEvidence,encodeFreshEvidence,type FreshCapturedReceipt}from'./capture.js';
import{freshNativeBuyCost,freshWrappedTaxNativeBuyCost}from'./routerPayment.js';
import{freshUrgentTraceTargets,persistFreshUrgentTrace}from'./urgentTrace.js';
const fixture=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/native-pcs-v2-tax-receipts.json.gz',import.meta.url))).toString())as{samples:{entry:FreshCapturedReceipt;wallet:string;token:string;targetRaw:string;expectedNativeWei:string}[]};
const check=(s:typeof fixture.samples[number])=>freshNativeBuyCost(s.entry.transaction,s.wallet,s.token,BigInt(s.targetRaw),s.entry.receipt.logs);
const word=(n:bigint)=>n.toString(16).padStart(64,'0');
const replace=(d:string,i:number,n:bigint)=>d.slice(0,2+i*64)+word(n)+d.slice(2+(i+1)*64);
describe('actual native-funded one-hop PCS V2 tax receipts',()=>{
 it('recovers all 58 complete original purchases without RPC or guessed price',()=>{
  expect(fixture.samples).toHaveLength(58);expect(new Set(fixture.samples.map(s=>s.token)).size).toBe(2);
  for(const s of fixture.samples){const original=JSON.stringify(s);expect(check(s),s.entry.transaction.hash).toBe(BigInt(s.expectedNativeWei));expect(freshWrappedTaxNativeBuyCost(s.entry.transaction,s.wallet,s.token,BigInt(s.targetRaw),s.entry.receipt.logs)).toBe(BigInt(s.expectedNativeWei));expect(JSON.stringify(s)).toBe(original);}
 });
 it('keeps these known receipt costs eligible for independent urgent native trace capture',()=>{
  for(const s of fixture.samples)expect(freshUrgentTraceTargets(s.entry),s.entry.transaction.hash).toContain(s.token);
 });
 it.each([0n,1n])('retains a late complete trace and queues normal correction only for a %s-wei refund contradiction',async refund=>{
  const s=structuredClone(fixture.samples[0]),entry=s.entry,first={version:1 as const,at:'2026-10-25T06:00:35.000Z',reasons:['original_reason']};entry.decodeDiagnostics={version:1,valuationReasons:['original_reason'],firstFailure:first};let saved=encodeFreshEvidence(entry);const calls:{sql:string;params:any[]}[]=[];
  const query=vi.fn(async(sql:string,params:any[]=[]):Promise<any>=>{calls.push({sql,params});if(sql.startsWith('SELECT block_hash'))return{rows:[{block_hash:entry.transaction.blockHash}]};if(sql.startsWith('SELECT active,revision'))return{rows:[{active:true,revision:'1',monitoring_from_block:1,monitoring_to_block:null}]};if(sql.startsWith('SELECT payload,wallet_addresses'))return{rows:[{payload:saved,wallet_addresses:entry.wallets,decoder_status:'done'}]};if(sql.startsWith('UPDATE fresh.recent_evidence SET payload='))saved=params[2];return{rows:[],rowCount:1};}),db={connect:async()=>({query,release(){}})}as unknown as Pool;
  const trace={type:'CALL',from:entry.transaction.from,to:entry.transaction.to!,value:entry.transaction.value,input:String(entry.transaction.input),output:'0x',calls:refund?[{type:'CALL',from:entry.transaction.to!,to:s.wallet,value:'0x1',input:'0x',output:'0x'}]:[]};
  expect(await persistFreshUrgentTrace(db,entry,trace,{walletRevision:'1',walletAddress:s.wallet,outgoingEvidenceOnly:true})).toBe(true);const next=decodeFreshEvidence(saved);expect(next.trace).toBeDefined();expect(next.decodeDiagnostics?.firstFailure).toEqual(first);expect(next.transaction).toEqual(entry.transaction);expect(next.receipt).toEqual(entry.receipt);expect(calls.some(c=>/financial_events|positions|UPDATE fresh.kols/.test(c.sql))).toBe(false);
  const repair=calls.filter(c=>c.sql.includes("SET decoder_status='repair'")),jobs=calls.filter(c=>c.sql.startsWith('INSERT INTO fresh.jobs'));expect(repair).toHaveLength(refund?1:0);expect(jobs).toHaveLength(refund?1:0);if(refund){expect(next.decodeDiagnostics?.valuationReasons).toContain('native_payout_mismatch');expect(jobs[0].sql).not.toMatch(/lease_id|progress\s*=/);expect(jobs[0].params[3]).toBe('native_payout_mismatch');}
 });
 const reject=(name:string,mutate:(s:typeof fixture.samples[number])=>void)=>it(name,()=>{const s=structuredClone(fixture.samples[0]);mutate(s);expect(check(s)).toBeNull();});
 reject('rejects a foreign PCS pool',s=>{s.entry.receipt.logs.at(-2)!.address='0x'+'1'.repeat(40);});
 reject('rejects a foreign auxiliary emitter',s=>{s.entry.receipt.logs[4].address='0x'+'1'.repeat(40);});
 reject('rejects unknown auxiliary event semantics',s=>{s.entry.receipt.logs[4].topics[0]='0x'+'1'.repeat(64);});
 reject('rejects a mismatched auxiliary token movement',s=>{s.entry.receipt.logs[4].data='0x'+word(1n);});
 reject('rejects an unreconciled token-tax amount',s=>{s.entry.receipt.logs[3].data='0x'+word(1n);s.entry.receipt.logs[4].data=s.entry.receipt.logs[3].data;});
 reject('rejects a different signed native input',s=>{s.entry.transaction.value='0x1';});
 reject('rejects inconsistent fee/deposit conservation',s=>{s.entry.receipt.logs[1].data='0x'+word(1n);});
 reject('rejects removed canonical evidence',s=>{s.entry.receipt.logs[3].removed=true;});
 reject('rejects duplicate log positions',s=>{s.entry.receipt.logs[4].logIndex=s.entry.receipt.logs[3].logIndex;});
 reject('rejects a foreign block identity',s=>{s.entry.receipt.logs[3].blockHash='0x'+'1'.repeat(64);});
 reject('rejects extra native/other log activity',s=>{s.entry.receipt.logs.push({...s.entry.receipt.logs[0],logIndex:'0xffff'});});
 reject('rejects additional signed routes',s=>{s.entry.transaction.input+='0'.repeat(64);});
 reject('rejects an altered signed route token',s=>{s.entry.transaction.input='0x4d819a2a'+replace('0x'+String(s.entry.transaction.input).slice(10),9,1n).slice(2);});
 reject('rejects delegated smart-account execution',s=>{s.entry.transaction.type='0x4';});
});
