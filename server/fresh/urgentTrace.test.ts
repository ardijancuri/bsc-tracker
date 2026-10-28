import{describe,expect,it,vi}from'vitest';
import{Wallet,hashAuthorization}from'ethers';
import type{Pool}from'pg';
import type{Rpc}from'../rpc.js';
import{transferTopic}from'../swap.js';
import{poolMarketAbi}from'../nodeMarketProtocols.js';
import{decodeFreshEvidence,encodeFreshEvidence,type FreshCapturedReceipt}from'./capture.js';
import{createFreshUrgentTraceCapture,freshUrgentTraceTargets,freshUrgentOutgoingTraceCandidate,freshUrgentInboundDependencyTargets,mergeFreshUrgentTrace,persistFreshUrgentTrace,freshUrgentTraceAttempts}from'./urgentTrace.js';
import{validFreshCompleteCallTrace,certifyFreshCompleteCallTrace}from'./passiveIncoming.js';
import{GANG_TOKEN_ADDRESS,type FreshExistingTokenPermission}from'./tracking.js';
import{FRESH_XA_FREE_CLAIM}from'./verifiedAirdropClaim.js';
import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';
import{assertFreshDecodeEvidenceUnchanged,reconcileFreshDecodeEvidence,freshDecodedEvidencePayload}from'./decode.js';
import{createFreshStateEvidenceRpc}from'./stateEvidence.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,word=(value:string)=>`0x${value.slice(2).padStart(64,'0')}`;
const wallet=address(1),router=address(2),token=address(7),blockHash=hash(1000),txHash=hash(900);
it('prioritizes only positively verified custom-controller native buys without standard Swap logs',()=>{const samples=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/refunded-controller-native-receipts.json.gz',import.meta.url))).toString()).samples;for(const sample of samples){const entry=sample.entry as FreshCapturedReceipt;expect(freshUrgentTraceTargets(entry)).toEqual(sample.expectedNativeWei===null?[]:[sample.token]);}const altered=structuredClone(samples[0].entry);altered.receipt.logs.splice(17,1);expect(freshUrgentTraceTargets(altered)).toEqual([]);});
function fixture(time=new Date(),tx=txHash):FreshCapturedReceipt{
 const common={transactionHash:tx,transactionIndex:'0x0',blockNumber:'0x3e8',blockHash};
 const swap={...common,address:address(5),...poolMarketAbi.encodeEventLog('Swap',[router,100n,0n,0n,10n,wallet]),logIndex:'0x0'};
 return{transaction:{hash:tx,from:wallet,to:router,value:'0x64',type:'0x0',nonce:'0x1',gasPrice:'0x1',blockHash,blockNumber:'0x3e8',transactionIndex:'0x0'},
  receipt:{...common,status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[swap,{...common,address:token,topics:[transferTopic,word(router),word(wallet)],data:word('0xa'),logIndex:'0x1'}]},wallets:[wallet],observedAt:time.toISOString()};
}
const trace=(entry:FreshCapturedReceipt)=>({type:'CALL',from:entry.transaction.from,to:entry.transaction.to!,value:entry.transaction.value,...(typeof entry.transaction.input==='string'?{input:entry.transaction.input}:{}),
 calls:[{type:'CALL',from:entry.transaction.to!,to:entry.transaction.from,value:'0x1'}]});
function memory(entries:FreshCapturedReceipt[],at=new Date()){
 const rows=entries.map(entry=>({tx_hash:entry.transaction.hash,block_hash:blockHash,block_number:'1000',transaction_index:0,wallet_addresses:entry.wallets,payload:encodeFreshEvidence(entry),parent_hash:hash(999),occurred_at:new Date(at.getTime()-4000)}));
 const monitored:any={address:wallet,active:true,revision:'1',monitoring_from_block:91,monitoring_to_block:null};
 const admission:{fact:any;permission:FreshExistingTokenPermission|null}={fact:{token_address:token,block_number:99,status:'eligible'},permission:null};
 const start={block_number:'90',block_hash:hash(90),value:{startBlock:90,startHash:hash(90),startTime:'2026-10-25T00:00:00.000Z'}};
 let transactions=0,canonical=blockHash;const calls:{sql:string;params:unknown[]}[]=[];
 const query=vi.fn(async(sql:string,params:unknown[]=[]):Promise<any>=>{
  calls.push({sql,params});
  if(sql==='BEGIN'){transactions++;return{rows:[]};}if(sql==='COMMIT'||sql==='ROLLBACK'){transactions--;return{rows:[]};}
  if(sql.startsWith('SELECT c.block_number'))return{rows:[{block_number:'1000',value:{startBlock:90},occurred_at:at,capture_ok:'true'}]};
  if(sql.startsWith('SELECT e.tx_hash'))return{rows:rows.map(row=>({...row,payload:Buffer.from(row.payload)}))};
  if(sql.startsWith('SELECT token_address'))return{rows:[{token_address:token,block_number:99}]};
  if(sql.startsWith('SELECT block_number::text,block_hash,value'))return{rows:[start]};
  if(sql.startsWith('SELECT * FROM fresh.launch_facts'))return{rows:admission.fact?.token_address===params[0]?[admission.fact]:[]};
  if(sql.startsWith('SELECT value FROM fresh.checkpoints WHERE key=$1'))return{rows:admission.permission?[{value:admission.permission}]:[]};
  if(sql.startsWith('SELECT address,revision'))return{rows:monitored.active?[monitored]:[]};
  if(sql.startsWith('SELECT block_hash'))return{rows:[{block_hash:canonical}]};
  if(sql.startsWith('SELECT active,revision'))return{rows:[monitored]};
  if(sql.startsWith('SELECT block_number FROM fresh.launch'))return{rows:[{block_number:99}]};
  if(sql.startsWith('SELECT payload,wallet'))return{rows:rows.filter(row=>row.tx_hash===params[0])};
  if(sql.startsWith("UPDATE fresh.recent_evidence SET decoder_status='pending'")){(rows.find(row=>row.tx_hash===params[0])!as any).decoder_status='pending';return{rowCount:1,rows:[]};}
  if(sql.startsWith('UPDATE fresh.recent_evidence')){rows.find(row=>row.tx_hash===params[0])!.payload=params[2]as Buffer;return{rowCount:1,rows:[]};}
  return{rows:[]};
 });
 return{rows,monitored,admission,start,calls,query,transactionDepth:()=>transactions,orphan(){canonical=hash(9999);},db:{query,connect:async()=>({query,release(){}})}as unknown as Pool,rpc:vi.fn(async()=>`0x${(1000+6).toString(16)}`)as unknown as Rpc};
}
describe('independent urgent native trace capture',()=>{
 it('captures an exact zero-native reward claim even after fair-value decoding finished',async()=>{
  const now=new Date(),entry=fixture(now),a=FRESH_XA_FREE_CLAIM;entry.transaction.to=a.treasury;entry.transaction.value='0x0';entry.transaction.chainId='0x38';entry.transaction.input=a.selector+word('0x20').slice(2)+word('0x1').slice(2)+word('0x1').slice(2);
  entry.receipt.logs=[{...entry.receipt.logs[1],address:a.token,topics:[transferTopic,word(a.treasury),word(wallet)]}];
  const m=memory([entry],now);(m.rows[0]as any).decoder_status='done';const load=vi.fn(async()=>({type:'CALL',from:wallet,to:a.treasury,value:'0x0',input:String(entry.transaction.input)}));
  expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:1,saved:1});expect(load).toHaveBeenCalledTimes(1);
  expect(validFreshCompleteCallTrace(decodeFreshEvidence(m.rows[0].payload),decodeFreshEvidence(m.rows[0].payload).trace!)).toBe(true);
  expect(m.calls.some(c=>/financial_events/.test(c.sql))).toBe(false);expect((m.rows[0]as any).decoder_status).toBe('pending');expect(m.calls.filter(c=>c.sql.startsWith('INSERT INTO fresh.jobs')).length).toBe(1);
 });
 it('captures and requeues the supported paid creation after an earlier interpretation finished',async()=>{
  const now=new Date(),original=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/paid-creation-purchase.json.gz',import.meta.url))).toString()),entry=original.entry as FreshCapturedReceipt,full=entry.trace!;delete entry.trace;delete entry.completeTraceProof;delete entry.stateEvidence;delete entry.recoveryEvidence;entry.transaction.blockHash=blockHash;entry.transaction.blockNumber='0x3e8';entry.transaction.transactionIndex='0x0';entry.receipt.blockHash=blockHash;entry.receipt.blockNumber='0x3e8';entry.receipt.transactionIndex='0x0';entry.observedAt=now.toISOString();for(const l of entry.receipt.logs){l.blockHash=blockHash;l.blockNumber='0x3e8';l.transactionIndex='0x0';}
  const m=memory([entry],now);m.monitored.address=entry.transaction.from;(m.rows[0]as any).decoder_status='done';const load=vi.fn(async()=>full);
  expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:1,saved:1});expect((m.rows[0]as any).decoder_status).toBe('pending');expect(m.calls.filter(c=>c.sql.startsWith('INSERT INTO fresh.jobs')).length).toBe(1);expect(m.calls.some(c=>/financial_events/.test(c.sql))).toBe(false);
 });
 it('independently re-fetches an already stored uncertified tree and appends only its genuine complete certificate',async()=>{
  const now=new Date(),entry=fixture(now);entry.transaction.input='0x4d819a2a';entry.trace=trace(entry);entry.stateEvidence={version:1,blockNumber:1000,blockHash,calls:[{to:token,data:'0x313ce567',result:word('0x12')}]};
  entry.decodeDiagnostics={version:1,valuationReasons:['original_reason'],firstFailure:{version:1,at:now.toISOString(),reasons:['original_reason']}};
  expect(freshUrgentTraceTargets(entry)).toEqual([token]);expect(freshUrgentOutgoingTraceCandidate(entry)).toBe(true);
  const m=memory([entry],now),load=vi.fn(async()=>trace(entry)),before=JSON.stringify(entry);expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:1,saved:1});expect(load).toHaveBeenCalledTimes(1);
  const saved=decodeFreshEvidence(m.rows[0].payload);expect(validFreshCompleteCallTrace(saved,saved.trace!)).toBe(true);for(const k of Object.keys(entry))expect((saved as any)[k]).toEqual((entry as any)[k]);expect(JSON.stringify(entry)).toBe(before);
  expect(saved.completeTraceProof!.source).toBe('private_ipc');expect(freshUrgentOutgoingTraceCandidate(saved)).toBe(false);expect(m.calls.some(call=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints|decoder_status=/.test(call.sql))).toBe(false);
 });
 it('certifies an equal normal-decoder-first tree raced in during the actual urgent read while preserving its newer proofs',async()=>{
  const now=new Date(),selected=fixture(now);selected.transaction.input='0x4d819a2a';const m=memory([selected],now),latest=structuredClone(selected);latest.trace=trace(selected);latest.stateEvidence={version:1,blockNumber:1000,blockHash,calls:[{to:token,data:'0x313ce567',result:word('0x12')}]};
  const load=vi.fn(async()=>{latest.urgentTraceAttempts=decodeFreshEvidence(m.rows[0].payload).urgentTraceAttempts;m.rows[0].payload=encodeFreshEvidence(latest);return trace(selected);});expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:1,saved:1});const saved=decodeFreshEvidence(m.rows[0].payload);expect(saved.trace).toEqual(latest.trace);expect(saved.stateEvidence).toEqual(latest.stateEvidence);expect(validFreshCompleteCallTrace(saved,saved.trace!)).toBe(true);
 });
 it('re-fetches once after a new uncertified normal tree appears, but never repeats unchanged trace or metadata work',async()=>{
  const now=new Date(),entry=fixture(now);entry.transaction.input='0x4d819a2a';const m=memory([entry],now),load=vi.fn(async()=>load.mock.calls.length===1?null:trace(entry)),run=createFreshUrgentTraceCapture(m.db,m.rpc,load);
  expect(await run({now})).toMatchObject({attempted:1,unavailable:1});const updated=decodeFreshEvidence(m.rows[0].payload);updated.trace=trace(entry);m.rows[0].payload=encodeFreshEvidence(updated);expect(await run({now:new Date(now.getTime()+600)})).toMatchObject({attempted:1,saved:1});expect(await run({now})).toMatchObject({attempted:0});expect(load).toHaveBeenCalledTimes(2);
 });
 it('never replaces a different stored tree or an invalid prior certificate after independent read',async()=>{
  const now=new Date(),entry=fixture(now);entry.transaction.input='0x4d819a2a';entry.trace=trace(entry);const m=memory([entry],now),before=Buffer.from(m.rows[0].payload);
  await expect(createFreshUrgentTraceCapture(m.db,m.rpc,async()=>({...trace(entry),calls:[]}))({now})).rejects.toThrow('urgent_trace_conflict');expect({...decodeFreshEvidence(m.rows[0].payload),urgentTraceAttempts:undefined}).toEqual({...decodeFreshEvidence(before),urgentTraceAttempts:undefined});expect(freshUrgentTraceAttempts(decodeFreshEvidence(m.rows[0].payload))?.lastOutcome).toBe('rejected');
  const invalid=structuredClone(entry);invalid.completeTraceProof=certifyFreshCompleteCallTrace(invalid,invalid.trace,{method:'debug_traceTransaction',params:[invalid.transaction.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]},'private_ipc');invalid.completeTraceProof.traceSha256='0'.repeat(64);
  expect(()=>mergeFreshUrgentTrace(invalid,invalid,trace(invalid))).toThrow('urgent_trace_attestation_conflict');expect(invalid.completeTraceProof.traceSha256).toBe('0'.repeat(64));
 });
 it('keeps re-fetch certification subject to the same canonical reorg, registration and receipt-age gates',async()=>{
  for(const kind of['orphan','registration','old']as const){const now=new Date(),entry=fixture(now);entry.transaction.input='0x4d819a2a';entry.trace=trace(entry);const m=memory([entry],now),before=Buffer.from(m.rows[0].payload),load=vi.fn(async()=>{if(kind==='orphan')m.orphan();if(kind==='registration')m.monitored.active=false;return trace(entry);});
   if(kind==='old')m.rows[0].occurred_at=new Date(now.getTime()-13_000);const run=createFreshUrgentTraceCapture(m.db,m.rpc,load);if(kind==='registration')await expect(run({now})).rejects.toThrow('urgent_trace_wallet_changed');else expect(await run({now})).toMatchObject({saved:0});expect({...decodeFreshEvidence(m.rows[0].payload),urgentTraceAttempts:undefined}).toEqual({...decodeFreshEvidence(before),urgentTraceAttempts:undefined});expect(load).toHaveBeenCalledTimes(kind==='old'?0:1);}
 });
 it('retains outgoing evidence independently of token permission but rechecks monitored wallet ownership',async()=>{
  const now=new Date(),entry=fixture(now);entry.receipt.logs[1].address=GANG_TOKEN_ADDRESS;
  const m=memory([entry],now);m.admission.fact=null;
  m.admission.permission={version:1,kind:'explicit_existing',chainId:56,tokenAddress:GANG_TOKEN_ADDRESS,active:true,startBlock:90,startHash:hash(90),
   startTime:m.start.value.startTime,fromBlock:91,approvedAt:now.toISOString(),reason:'user_approved_gang_only'};
  const load=vi.fn(async()=>trace(entry));expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:1,saved:1});
  expect(load).toHaveBeenCalledTimes(1);expect(m.calls.some(call=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints|decoder_status=/.test(call.sql))).toBe(false);
  const revoked=memory([entry],now);revoked.admission.fact=null;revoked.admission.permission=m.admission.permission;
  const revoke=vi.fn(async()=>{revoked.monitored.active=false;return trace(entry);});
  await expect(createFreshUrgentTraceCapture(revoked.db,revoked.rpc,revoke)({now})).rejects.toThrow('urgent_trace_wallet_changed');
  expect(decodeFreshEvidence(revoked.rows[0].payload).trace).toBeUndefined();expect(revoked.transactionDepth()).toBe(0);
 });
 it('captures original evidence for unresolved or contradictory launch metadata without promoting financial eligibility',async()=>{
  const now=new Date(),entry=fixture(now),m=memory([entry],now),load=vi.fn(async()=>trace(entry));m.admission.fact=null;
  expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:1,saved:1});expect(load).toHaveBeenCalledTimes(1);
  expect(m.calls.some(call=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints|decoder_status=|SELECT \* FROM fresh.launch_facts/.test(call.sql))).toBe(false);
  const later=memory([entry],now);later.admission.fact.block_number=1001;
  // The live capture can already be ahead of a still recent receipt.
  const query=later.query.getMockImplementation()!;later.query.mockImplementation(async(sql:string,params:unknown[]=[])=>{
   const result=await query(sql,params);if(sql.startsWith('SELECT c.block_number'))result.rows[0].block_number='1001';return result;
  });(later.rpc as any).mockResolvedValue('0x3ef');
  expect(await createFreshUrgentTraceCapture(later.db,later.rpc,load)({now})).toMatchObject({attempted:1,saved:1});expect(load).toHaveBeenCalledTimes(2);
 });
 it.each(['0x095ea7b3','0x4d819a2a','0xa9059cbb'])('captures and immediately indexes a zero-native monitored %s execution before token admission',async selector=>{
  const now=new Date(),entry=fixture(now);entry.transaction.value='0x0';entry.transaction.input=selector;const m=memory([entry],now);m.admission.fact=null;
  expect(freshUrgentTraceTargets(entry)).toEqual([]);expect(freshUrgentOutgoingTraceCandidate(entry)).toBe(true);
  const load=vi.fn(async()=>trace(entry));expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:1,saved:1});
  const saved=decodeFreshEvidence(m.rows[0].payload);expect(validFreshCompleteCallTrace(saved,saved.trace!)).toBe(true);
  const update=m.calls.find(call=>call.sql.startsWith('UPDATE fresh.recent_evidence')&&call.sql.includes('position_dependency_addresses'))!;expect(update.sql).toContain('position_dependency_addresses');expect(update.params[3]).toEqual(expect.arrayContaining([wallet,router,token]));expect(update.params[4]).toMatch(/^[a-f0-9]{64}$/);
  expect(m.calls.some(call=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints|decoder_status=/.test(call.sql))).toBe(false);
 });
 it('rejects unmonitored, failed, unsigned-self, malformed and plain native-transfer fallback work',()=>{
  const e=fixture();e.transaction.value='0x0';e.transaction.input='0x095ea7b3';expect(freshUrgentOutgoingTraceCandidate(e)).toBe(true);
  for(const kind of['unwatched','failed','self','invalid','empty','no_to']as const){const next=structuredClone(e);if(kind==='unwatched')next.wallets=[router];if(kind==='failed')next.receipt.status='0x0';if(kind==='self')next.transaction.to=wallet;if(kind==='invalid')next.transaction.input='0xnothex';if(kind==='empty')next.transaction.input='0x';if(kind==='no_to')next.transaction.to=null;expect(freshUrgentOutgoingTraceCandidate(next)).toBe(false);}
 });
 it('retains a bounded proof-only tree for captured inbound synthetic activity, not other chain calls',async()=>{
  const now=new Date(),entry=fixture(now);entry.transaction.from=address(90);entry.transaction.value='0x0';entry.transaction.input='0x729ad39e';entry.receipt.logs.shift();
  expect(freshUrgentInboundDependencyTargets(entry)).toEqual([wallet]);const m=memory([entry],now);m.admission.fact=null;
  const result=await createFreshUrgentTraceCapture(m.db,m.rpc,async()=>trace(entry))({now});expect(result).toMatchObject({attempted:1,saved:1});
  const saved=decodeFreshEvidence(m.rows[0].payload);expect(validFreshCompleteCallTrace(saved,saved.trace!)).toBe(true);expect(m.calls.some(call=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints|decoder_status=/.test(call.sql))).toBe(false);
  const unrelated=structuredClone(entry);unrelated.wallets=[address(999)];expect(freshUrgentInboundDependencyTargets(unrelated)).toEqual([]);
  const malformed=structuredClone(entry);malformed.receipt.logs[0].data='0x';expect(freshUrgentInboundDependencyTargets(malformed)).toEqual([]);
 });
 it('gives a real native buy priority over already-captured inbound spam in the same bounded pass',async()=>{
  const now=new Date(),native=fixture(now),inbound=fixture(now,hash(902));inbound.transaction.from=address(90);inbound.transaction.value='0x0';inbound.transaction.input='0x729ad39e';inbound.receipt.logs.shift();
  const m=memory([inbound,native],now),load=vi.fn(async(tx:any)=>trace([native,inbound].find(e=>e.transaction.hash===tx.hash)!));expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:1,saved:1});expect(load.mock.calls[0][0].hash).toBe(native.transaction.hash);
 });
 it.each(['inbound','passive']as const)('retains original %s dependency evidence when ordinary decoding finishes first',async mode=>{
  const now=new Date(),entry=fixture(now);entry.transaction.from=address(90);entry.transaction.value='0x0';entry.transaction.input='0x1239ec8c';if(mode==='inbound')entry.receipt.logs.shift();
  entry.stateEvidence={version:1,blockNumber:1000,blockHash,calls:[{to:token,data:'0x313ce567',result:word('0x12')}]};
  entry.decodeDiagnostics={version:1,valuationReasons:['incoming_transfer_cost_unknown'],firstFailure:{version:1,at:now.toISOString(),reasons:['incoming_transfer_cost_unknown']}};
  const m=memory([entry],now);m.admission.fact=null;(m.rows[0]as any).decoder_status='done';const before=structuredClone(entry),load=vi.fn(async()=>trace(entry)),run=createFreshUrgentTraceCapture(m.db,m.rpc,load);
  expect(await run({now})).toMatchObject({attempted:1,saved:1});const saved=decodeFreshEvidence(m.rows[0].payload);
  expect(validFreshCompleteCallTrace(saved,saved.trace!)).toBe(true);for(const key of Object.keys(before))expect((saved as any)[key]).toEqual((before as any)[key]);
  expect((m.rows[0]as any).decoder_status).toBe('done');const update=m.calls.find(call=>call.sql.startsWith('UPDATE fresh.recent_evidence')&&call.sql.includes('position_dependency_addresses'))!;
  expect(update.params[3]).toEqual(expect.arrayContaining([router,token,entry.transaction.from]));expect(update.params[4]).toMatch(/^[a-f0-9]{64}$/);
  expect(m.calls.some(call=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints|decoder_status=|SELECT \* FROM fresh.launch_facts/.test(call.sql))).toBe(false);
  expect(m.calls.find(call=>call.sql.startsWith('SELECT e.tx_hash'))!.sql).toContain('LIMIT 16');expect(await run({now})).toMatchObject({attempted:0});expect(load).toHaveBeenCalledTimes(1);
 });
 it.each(['no_wallet','failed','plain','no_method','unrelated','outgoing']as const)('does not extend done trace capture to %s receipts',async kind=>{
  const now=new Date(),entry=fixture(now);entry.transaction.from=address(90);entry.transaction.value='0x0';entry.transaction.input='0x1239ec8c';
  if(kind==='no_wallet')entry.wallets=[];if(kind==='failed')entry.receipt.status='0x0';if(kind==='plain')entry.transaction.input='0x';if(kind==='no_method')delete entry.transaction.input;
  if(kind==='unrelated')entry.receipt.logs=[{...entry.receipt.logs[1],topics:[transferTopic,word(router),word(address(999))]}];if(kind==='outgoing')entry.transaction.from=wallet;
  const m=memory([entry],now);(m.rows[0]as any).decoder_status='done';const original=Buffer.from(m.rows[0].payload),load=vi.fn(async()=>trace(entry));
  expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:0,saved:0});expect(load).not.toHaveBeenCalled();expect(m.rows[0].payload).toEqual(original);expect(m.calls.some(call=>call.sql==='BEGIN')).toBe(false);
 });
 it.each(['outgoing','inbound']as const)('captures an already-retained %s constructor and indexes its complete dependency tree',async mode=>{
  const now=new Date(),entry=fixture(now);entry.transaction.to=null;entry.transaction.value='0x0';entry.transaction.input='0x60006000';entry.receipt.contractAddress=router;entry.receipt.logs.shift();if(mode==='inbound')entry.transaction.from=address(90);
  expect(freshUrgentOutgoingTraceCandidate(entry)).toBe(mode==='outgoing');expect(freshUrgentInboundDependencyTargets(entry)).toEqual(mode==='inbound'?[wallet]:[]);
  const full={type:'CREATE',from:entry.transaction.from,to:router,value:'0x0',input:String(entry.transaction.input),output:'0x6000'},m=memory([entry],now);
  expect(await createFreshUrgentTraceCapture(m.db,m.rpc,async()=>full)({now})).toMatchObject({attempted:1,saved:1});const saved=decodeFreshEvidence(m.rows[0].payload);
  expect(validFreshCompleteCallTrace(saved,saved.trace!)).toBe(true);expect(saved.receipt).toEqual(entry.receipt);const update=m.calls.find(c=>c.sql.startsWith('UPDATE fresh.recent_evidence')&&c.sql.includes('position_dependency_addresses'))!;expect(update.params[3]).toEqual(expect.arrayContaining([entry.transaction.from,router,token]));
  expect(m.calls.some(call=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints|decoder_status=/.test(call.sql))).toBe(false);
  expect(()=>mergeFreshUrgentTrace(entry,entry,{...full,to:address(999)})).toThrow('urgent_trace_transaction_mismatch');
 });
 it('rejects constructor fallback without a successful ordinary undelegated receipt, real initcode, created address or watched logs',()=>{
  const entry=fixture();entry.transaction.from=address(90);entry.transaction.to=null;entry.transaction.value='0x0';entry.transaction.input='0x60006000';entry.receipt.contractAddress=router;entry.receipt.logs.shift();
  for(const kind of['bad_address','missing_address','failed','delegated','authorization','empty','unwatched']as const){const e=structuredClone(entry);if(kind==='bad_address')e.receipt.contractAddress='0x123';if(kind==='missing_address')delete e.receipt.contractAddress;if(kind==='failed')e.receipt.status='0x0';if(kind==='delegated')e.transaction.type='0x4';if(kind==='authorization')e.transaction.authorizationList=[];if(kind==='empty')e.transaction.input='0x';if(kind==='unwatched')e.wallets=[address(999)];expect(freshUrgentInboundDependencyTargets(e)).toEqual([]);}
 });
 it('identifies genuine native buy candidates while excluding failed calls, plain transfers, missing flows and malformed swap payloads',()=>{
  const entry=fixture();expect(freshUrgentTraceTargets(entry)).toEqual([token]);
  for(const change of['failed','no_value','no_swap','bad_swap','no_target','already_traced','unwatched']as const){
   const e=structuredClone(entry);if(change==='failed')e.receipt.status='0x0';if(change==='no_value')e.transaction.value='0x0';if(change==='no_swap')e.receipt.logs.shift();
   if(change==='bad_swap')e.receipt.logs[0].data='0x';if(change==='no_target')e.receipt.logs.pop();if(change==='already_traced'){e.transaction.input='0x4d819a2a';e.trace=trace(e);e.completeTraceProof=certifyFreshCompleteCallTrace(e,e.trace,{method:'debug_traceTransaction',params:[e.transaction.hash,{tracer:'callTracer',tracerConfig:{onlyTopCall:false,withLog:false}}]},'private_ipc');}if(change==='unwatched')e.wallets=[router];
   expect(freshUrgentTraceTargets(e)).toEqual([]);
  }
 });
 it('allows exact self-authorized EIP-7702 swaps and rejects different accounts, chains or authorization nonces',()=>{
  const signer=new Wallet(`0x${'11'.repeat(32)}`),e=fixture(),from=signer.address.toLowerCase();e.transaction.from=from;e.transaction.to=from;e.transaction.type='0x4';e.wallets=[from];e.receipt.logs[1].topics[2]=word(from);
  const auth={address:router,chainId:56n,nonce:2n},signature=signer.signingKey.sign(hashAuthorization(auth));
  e.transaction.authorizationList=[{address:router,chainId:'0x38',nonce:'0x2',r:signature.r,s:signature.s,yParity:`0x${signature.yParity}`}];
  expect(freshUrgentTraceTargets(e)).toEqual([token]);
  for(const patch of[{chainId:'0x1'},{nonce:'0x3'},{address:token}]){const changed=structuredClone(e);Object.assign((changed.transaction.authorizationList as any[])[0],patch);expect(freshUrgentTraceTargets(changed)).toEqual([]);}
 });
 it('preserves concurrent state, recovery and first-failure diagnostics while validating the complete transaction trace',()=>{
  const original=fixture(),latest=structuredClone(original);latest.stateEvidence={version:1,blockNumber:1000,blockHash,calls:[{to:token,data:'0x313ce567',result:word('0x12')}]};
  (latest as any).recoveryEvidence={version:1,retained:'proof'};latest.decodeDiagnostics={version:1,valuationReasons:['trade_value_unavailable'],firstFailure:{version:1,at:latest.observedAt,reasons:['trade_value_unavailable']}};
  const merged=decodeFreshEvidence(mergeFreshUrgentTrace(original,latest,trace(original))!);expect(merged.trace).toEqual(trace(original));expect(merged.stateEvidence).toEqual(latest.stateEvidence);
  expect(merged.recoveryEvidence).toEqual(latest.recoveryEvidence);expect(merged.decodeDiagnostics).toEqual(latest.decodeDiagnostics);expect(merged.receipt).toEqual(original.receipt);
  expect(mergeFreshUrgentTrace(original,merged,trace(original))).toBeNull();
  expect(()=>mergeFreshUrgentTrace(original,merged,{...trace(original),calls:[]})).toThrow('urgent_trace_conflict');
  expect(()=>mergeFreshUrgentTrace(original,latest,{...trace(original),value:'0x65'})).toThrow('urgent_trace_transaction_mismatch');
  expect(()=>mergeFreshUrgentTrace(original,{...latest,wallets:[router]},trace(original))).toThrow('urgent_trace_context_changed');
 });
 it('attempts only one receipt per pass and loads only after its reservation transaction commits',async()=>{
  const now=new Date(),entries=[fixture(now),fixture(now,hash(901))],m=memory(entries,now),load=vi.fn(async(entry:any)=>{
   expect(m.transactionDepth()).toBe(0);expect(freshUrgentTraceAttempts(decodeFreshEvidence(m.rows.find(r=>r.tx_hash===entry.hash)!.payload))?.lastOutcome).toBe('started');return trace(entries.find(e=>e.transaction.hash===entry.hash)!);
  });
  const run=createFreshUrgentTraceCapture(m.db,m.rpc,load),result=await run({now});expect(result).toMatchObject({attempted:1,saved:1});expect(load).toHaveBeenCalledTimes(1);
  expect(m.rows.filter(row=>decodeFreshEvidence(row.payload).trace)).toHaveLength(1);expect(m.calls.some(call=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints|decoder_status=/.test(call.sql))).toBe(false);
 });
 it('retains the retry cooldown when urgent metadata changes the same receipt payload',async()=>{
  const now=new Date(),entry=fixture(now),m=memory([entry],now),load=vi.fn(async()=>null),run=createFreshUrgentTraceCapture(m.db,m.rpc,load);
  expect(await run({now})).toMatchObject({attempted:1,unavailable:1});
  const latest=decodeFreshEvidence(m.rows[0].payload);latest.stateEvidence={version:1,blockNumber:1000,blockHash,calls:[{to:token,data:'0x313ce567',result:word('0x12')}]};m.rows[0].payload=encodeFreshEvidence(latest);
  expect(await run({now})).toMatchObject({attempted:0,saved:0});expect(load).toHaveBeenCalledTimes(1);expect(m.transactionDepth()).toBe(0);
 });
 it('serializes concurrent passes, honors cancellation and settles work without detached traces',async()=>{
  const now=new Date(),entry=fixture(now),m=memory([entry],now);let release!:()=>void;
  const hold=new Promise<void>(resolve=>{release=resolve;}),load=vi.fn(async()=>{await hold;return trace(entry);}),run=createFreshUrgentTraceCapture(m.db,m.rpc,load),controller=new AbortController();
  const work=run({now,signal:controller.signal});await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));expect(await run({now})).toMatchObject({yielded:true});
  controller.abort();release();expect(await work).toMatchObject({saved:0,unavailable:1});expect(m.transactionDepth()).toBe(0);expect(freshUrgentTraceAttempts(decodeFreshEvidence(m.rows[0].payload))?.lastOutcome).toBe('aborted');
 });
 it('rechecks the twelve-second deadline after database work and never probes old repairs',async()=>{
  const now=new Date(),m=memory([fixture(now)],now),load=vi.fn(async()=>null);let elapsed=0;const clock=vi.spyOn(performance,'now').mockImplementation(()=>elapsed),query=m.query.getMockImplementation()!;
  m.query.mockImplementation(async(sql:string,params:unknown[]=[])=>{const result=await query(sql,params);if(sql.startsWith('SELECT address,revision'))elapsed=9000;return result;});
  try{expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:0});expect(load).not.toHaveBeenCalled();}finally{clock.mockRestore();}
 });
 it('expires the remaining age budget during loader verification and awaits cancellation before another pass',async()=>{
  const now=new Date(),entry=fixture(now),m=memory([entry],now);m.rows[0].occurred_at=new Date(now.getTime()-11_990);
  const clock=vi.spyOn(performance,'now').mockReturnValue(0);let settled=false;
  const load=vi.fn(async(_tx:unknown,signal?:AbortSignal)=>{await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));settled=true;return trace(entry);});
  try{const run=createFreshUrgentTraceCapture(m.db,m.rpc,load);expect(await run({now})).toMatchObject({attempted:1,saved:0,unavailable:1});expect(settled).toBe(true);
   expect(await run({now})).toMatchObject({attempted:0});expect(load).toHaveBeenCalledTimes(1);expect(m.transactionDepth()).toBe(0);
  }finally{clock.mockRestore();}
 });
 it('yields to stale or lagging capture and rejects registration/reorg changes without replacing receipt bytes',async()=>{
  const now=new Date(),entry=fixture(now),m=memory([entry],now),load=vi.fn(async()=>null);
  (m.rpc as any).mockResolvedValue(`0x${(1000+6+33).toString(16)}`);expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({yielded:true});expect(load).not.toHaveBeenCalled();
  m.orphan();expect(await persistFreshUrgentTrace(m.db,entry,trace(entry),{walletRevision:'1',token})).toBe(false);
  const n=memory([entry],now);n.monitored.revision='2';await expect(persistFreshUrgentTrace(n.db,entry,trace(entry),{walletRevision:'1',token})).rejects.toThrow('urgent_trace_wallet_changed');
  expect(n.calls.some(call=>call.sql.startsWith('UPDATE'))).toBe(false);
 });
});

describe('durable bounded urgent-trace retry',()=>{
 it('retries transient null exactly once after500ms and retains successful count/outcome',async()=>{
  const now=new Date(),e=fixture(now);e.transaction.input='0x4d819a2a';e.decodeDiagnostics={version:1,valuationReasons:['original_failure'],firstFailure:{version:1,at:now.toISOString(),reasons:['original_failure']}};const m=memory([e],now),clock=vi.spyOn(performance,'now').mockReturnValue(0),load=vi.fn(async()=>load.mock.calls.length===1?null:trace(e)),run=createFreshUrgentTraceCapture(m.db,m.rpc,load);
  try{expect(await run({now})).toMatchObject({attempted:1,unavailable:1});expect(freshUrgentTraceAttempts(decodeFreshEvidence(m.rows[0].payload))).toMatchObject({count:1,lastOutcome:'unavailable',startAgeMs:4000});
   expect(await run({now:new Date(now.getTime()+499)})).toMatchObject({attempted:0});expect(await run({now:new Date(now.getTime()+500)})).toMatchObject({attempted:1,saved:1});expect(load).toHaveBeenCalledTimes(2);
   const saved=decodeFreshEvidence(m.rows[0].payload);expect(saved.decodeDiagnostics).toEqual(e.decodeDiagnostics);expect(freshUrgentTraceAttempts(saved)).toMatchObject({count:2,lastOutcome:'saved',lastDurationMs:0});expect(validFreshCompleteCallTrace(saved,saved.trace!)).toBe(true);expect(await run({now:new Date(now.getTime()+1000)})).toMatchObject({attempted:0});
  }finally{clock.mockRestore();}
 });
 it('retains the two-request cap across restarted capture instances and additive evidence',async()=>{
  const now=new Date(),e=fixture(now),m=memory([e],now),load=vi.fn(async()=>null);expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:1});
  const updated=decodeFreshEvidence(m.rows[0].payload);updated.stateEvidence={version:1,blockNumber:1000,blockHash,calls:[]};updated.trace=trace(e);m.rows[0].payload=encodeFreshEvidence(updated);
  expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now:new Date(now.getTime()+600)})).toMatchObject({attempted:1,unavailable:1});expect(freshUrgentTraceAttempts(decodeFreshEvidence(m.rows[0].payload))).toMatchObject({count:2,lastOutcome:'unavailable'});
  expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now:new Date(now.getTime()+1200)})).toMatchObject({attempted:0});expect(load).toHaveBeenCalledTimes(2);
 });
 it('gives unattempted receipts precedence within the same priority while retaining native priority over inbound work',async()=>{
  const now=new Date(),a=fixture(now),b=fixture(now,hash(901)),inbound=fixture(now,hash(902));inbound.transaction.from=address(90);inbound.transaction.value='0x0';inbound.transaction.input='0x729ad39e';inbound.receipt.logs.shift();const m=memory([a,b,inbound],now),load=vi.fn(async(tx:any)=>tx.hash===a.transaction.hash?null:trace(b)),run=createFreshUrgentTraceCapture(m.db,m.rpc,load);
  await run({now});await run({now:new Date(now.getTime()+600)});await run({now:new Date(now.getTime()+1200)});expect(load.mock.calls.map(([tx])=>tx.hash)).toEqual([a.transaction.hash,b.transaction.hash,a.transaction.hash]);expect(freshUrgentTraceAttempts(decodeFreshEvidence(m.rows[2].payload))).toBeUndefined();
 });
 it.each(['trace_timeout','transport_error','invalid_trace'])('retries only the supported transient thrown outcome %s',async reason=>{
  const now=new Date(),e=fixture(now),m=memory([e],now),load=vi.fn(async()=>{throw Error(reason);}),run=createFreshUrgentTraceCapture(m.db,m.rpc,load);
  if(reason==='invalid_trace')await expect(run({now})).rejects.toThrow(reason);else expect(await run({now})).toMatchObject({unavailable:1});
  expect(freshUrgentTraceAttempts(decodeFreshEvidence(m.rows[0].payload))?.lastOutcome).toBe(reason==='invalid_trace'?'rejected':'transport_error');
  if(reason==='invalid_trace')expect(await run({now:new Date(now.getTime()+600)})).toMatchObject({attempted:0});else expect(await run({now:new Date(now.getTime()+600)})).toMatchObject({attempted:1,unavailable:1});expect(load).toHaveBeenCalledTimes(reason==='invalid_trace'?1:2);
 });
 it('does not retry mismatched or conflicting traces and preserves the complete original body',async()=>{
  const now=new Date(),e=fixture(now),m=memory([e],now),load=vi.fn(async()=>({...trace(e),value:'0x65'})),run=createFreshUrgentTraceCapture(m.db,m.rpc,load),before=decodeFreshEvidence(m.rows[0].payload);
  await expect(run({now})).rejects.toThrow('urgent_trace_transaction_mismatch');expect(await run({now:new Date(now.getTime()+600)})).toMatchObject({attempted:0});expect(load).toHaveBeenCalledTimes(1);const saved=decodeFreshEvidence(m.rows[0].payload);expect({...saved,urgentTraceAttempts:undefined}).toEqual({...before,urgentTraceAttempts:undefined});expect(saved.urgentTraceAttempts?.lastOutcome).toBe('rejected');
 });
 it('does not overlap another capture instance or reset an unresolved reservation after restart',async()=>{
  const now=new Date(),e=fixture(now),m=memory([e],now);let release!:()=>void;const hold=new Promise<void>(r=>{release=r;}),load=vi.fn(async()=>{await hold;return null;}),run=createFreshUrgentTraceCapture(m.db,m.rpc,load),work=run({now});await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));
  expect(decodeFreshEvidence(m.rows[0].payload).urgentTraceAttempts?.lastOutcome).toBe('started');expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now:new Date(now.getTime()+600)})).toMatchObject({attempted:0});release();await work;expect(load).toHaveBeenCalledTimes(1);
 });
 it('keeps cancelled work terminal even if another later caller has a fresh signal',async()=>{
  const now=new Date(),e=fixture(now),m=memory([e],now),controller=new AbortController(),load=vi.fn(async(_tx:unknown,signal?:AbortSignal)=>{controller.abort();expect(signal?.aborted).toBe(true);return null;}),run=createFreshUrgentTraceCapture(m.db,m.rpc,load);await run({now,signal:controller.signal});expect(decodeFreshEvidence(m.rows[0].payload).urgentTraceAttempts?.lastOutcome).toBe('aborted');expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now:new Date(now.getTime()+600)})).toMatchObject({attempted:0});expect(load).toHaveBeenCalledTimes(1);
 });
 it('rechecks the absolute deadline after reservation without starting an expired request',async()=>{
  const now=new Date(),e=fixture(now),m=memory([e],now),load=vi.fn(async()=>null);let elapsed=0;const clock=vi.spyOn(performance,'now').mockImplementation(()=>elapsed),query=m.query.getMockImplementation()!;m.query.mockImplementation(async(sql:string,p:unknown[]=[])=>{const r=await query(sql,p);if(sql.startsWith('UPDATE fresh.recent_evidence SET payload='))elapsed=9000;return r;});
  try{expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now})).toMatchObject({attempted:0,unavailable:1});expect(load).not.toHaveBeenCalled();expect(decodeFreshEvidence(m.rows[0].payload).urgentTraceAttempts?.lastOutcome).toBe('expired');expect(m.transactionDepth()).toBe(0);}finally{clock.mockRestore();}
 });
 it('rejects malformed, oversized, recontextualized or exhausted durable diagnostics without new work',async()=>{
  const now=new Date(),e=fixture(now),m=memory([e],now);await createFreshUrgentTraceCapture(m.db,m.rpc,async()=>null)({now});const original=decodeFreshEvidence(m.rows[0].payload);
  for(const mutate of[(d:any)=>{d.count=3;},(d:any)=>{d.contextSha256='0'.repeat(64);},(d:any)=>{d.extra='x'.repeat(2000);},(d:any)=>{d.lastDurationMs=-1;},(d:any)=>{d.lastOutcome='arbitrary';},(d:any)=>{d.count=2;}]){const changed=structuredClone(original);mutate(changed.urgentTraceAttempts);m.rows[0].payload=encodeFreshEvidence(changed);const before=Buffer.from(m.rows[0].payload),load=vi.fn(async()=>null);expect(await createFreshUrgentTraceCapture(m.db,m.rpc,load)({now:new Date(now.getTime()+600)})).toMatchObject({attempted:0});expect(load).not.toHaveBeenCalled();expect(m.rows[0].payload).toEqual(before);}
  expect(Buffer.byteLength(JSON.stringify(original.urgentTraceAttempts))).toBeLessThan(1024);
 });
 it('preserves durable diagnostics through fresh decoding and rejects stale normalizations',async()=>{
  const now=new Date(),e=fixture(now),m=memory([e],now),selected={payload:Buffer.from(m.rows[0].payload)};await createFreshUrgentTraceCapture(m.db,m.rpc,async()=>null)({now});const current={wallet_addresses:[wallet],payload:m.rows[0].payload},state=createFreshStateEvidenceRpc((async()=>{throw Error('no_rpc');})as Rpc,{number:1000,hash:blockHash});
  expect(()=>assertFreshDecodeEvidenceUnchanged(current,selected,[wallet])).toThrow('decode_evidence_changed');expect(()=>reconcileFreshDecodeEvidence(current,selected,e,state)).toThrow('decode_evidence_changed');
  const latest=decodeFreshEvidence(current.payload),payload=freshDecodedEvidencePayload(latest,state,undefined,undefined,{version:1,valuationReasons:['original_failure']})!;expect(decodeFreshEvidence(payload).urgentTraceAttempts).toEqual(latest.urgentTraceAttempts);expect(m.calls.some(c=>/financial_events|fresh.jobs|decoder_status=|expires_at=/.test(c.sql))).toBe(false);
 });
});
