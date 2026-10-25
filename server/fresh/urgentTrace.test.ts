import{describe,expect,it,vi}from'vitest';
import{Wallet,hashAuthorization}from'ethers';
import type{Pool}from'pg';
import type{Rpc}from'../rpc.js';
import{transferTopic}from'../swap.js';
import{poolMarketAbi}from'../nodeMarketProtocols.js';
import{decodeFreshEvidence,encodeFreshEvidence,type FreshCapturedReceipt}from'./capture.js';
import{createFreshUrgentTraceCapture,freshUrgentTraceTargets,mergeFreshUrgentTrace,persistFreshUrgentTrace}from'./urgentTrace.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`,word=(value:string)=>`0x${value.slice(2).padStart(64,'0')}`;
const wallet=address(1),router=address(2),token=address(7),blockHash=hash(1000),txHash=hash(900);
function fixture(time=new Date(),tx=txHash):FreshCapturedReceipt{
 const common={transactionHash:tx,transactionIndex:'0x0',blockNumber:'0x3e8',blockHash};
 const swap={...common,address:address(5),...poolMarketAbi.encodeEventLog('Swap',[router,100n,0n,0n,10n,wallet]),logIndex:'0x0'};
 return{transaction:{hash:tx,from:wallet,to:router,value:'0x64',type:'0x0',nonce:'0x1',gasPrice:'0x1',blockHash,blockNumber:'0x3e8',transactionIndex:'0x0'},
  receipt:{...common,status:'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x1',logs:[swap,{...common,address:token,topics:[transferTopic,word(router),word(wallet)],data:word('0xa'),logIndex:'0x1'}]},wallets:[wallet],observedAt:time.toISOString()};
}
const trace=(entry:FreshCapturedReceipt)=>({type:'CALL',from:entry.transaction.from,to:entry.transaction.to!,value:entry.transaction.value,
 calls:[{type:'CALL',from:entry.transaction.to!,to:entry.transaction.from,value:'0x1'}]});
function memory(entries:FreshCapturedReceipt[],at=new Date()){
 const rows=entries.map(entry=>({tx_hash:entry.transaction.hash,block_hash:blockHash,block_number:'1000',transaction_index:0,wallet_addresses:entry.wallets,payload:encodeFreshEvidence(entry),parent_hash:hash(999),occurred_at:new Date(at.getTime()-4000)}));
 const monitored:any={address:wallet,active:true,revision:'1',monitoring_from_block:91,monitoring_to_block:null};
 let canonical=blockHash;const calls:{sql:string;params:unknown[]}[]=[];
 const query=vi.fn(async(sql:string,params:unknown[]=[]):Promise<any>=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT c.block_number'))return{rows:[{block_number:'1000',value:{startBlock:90},occurred_at:at,capture_ok:'true'}]};
  if(sql.startsWith('SELECT e.tx_hash'))return{rows:rows.map(row=>({...row,payload:Buffer.from(row.payload)}))};
  if(sql.startsWith('SELECT token_address'))return{rows:[{token_address:token,block_number:99}]};
  if(sql.startsWith('SELECT address,revision'))return{rows:monitored.active?[monitored]:[]};
  if(sql.startsWith('SELECT block_hash'))return{rows:[{block_hash:canonical}]};
  if(sql.startsWith('SELECT active,revision'))return{rows:[monitored]};
  if(sql.startsWith('SELECT block_number FROM fresh.launch'))return{rows:[{block_number:99}]};
  if(sql.startsWith('SELECT payload,wallet'))return{rows:rows.filter(row=>row.tx_hash===params[0])};
  if(sql.startsWith('UPDATE fresh.recent_evidence')){rows.find(row=>row.tx_hash===params[0])!.payload=params[2]as Buffer;return{rowCount:1,rows:[]};}
  return{rows:[]};
 });
 return{rows,monitored,calls,query,orphan(){canonical=hash(9999);},db:{query,connect:async()=>({query,release(){}})}as unknown as Pool,rpc:vi.fn(async()=>`0x${(1000+6).toString(16)}`)as unknown as Rpc};
}
describe('independent urgent native trace capture',()=>{
 it('identifies genuine native buy candidates while excluding failed calls, plain transfers, missing flows and malformed swap payloads',()=>{
  const entry=fixture();expect(freshUrgentTraceTargets(entry)).toEqual([token]);
  for(const change of['failed','no_value','no_swap','bad_swap','no_target','already_traced','unwatched']as const){
   const e=structuredClone(entry);if(change==='failed')e.receipt.status='0x0';if(change==='no_value')e.transaction.value='0x0';if(change==='no_swap')e.receipt.logs.shift();
   if(change==='bad_swap')e.receipt.logs[0].data='0x';if(change==='no_target')e.receipt.logs.pop();if(change==='already_traced')e.trace=trace(e);if(change==='unwatched')e.wallets=[router];
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
 it('attempts only one receipt per pass and starts tracing before any write transaction',async()=>{
  const now=new Date(),entries=[fixture(now),fixture(now,hash(901))],m=memory(entries,now),load=vi.fn(async(entry:any)=>{
   expect(m.calls.some(call=>call.sql==='BEGIN')).toBe(false);return trace(entries.find(e=>e.transaction.hash===entry.hash)!);
  });
  const run=createFreshUrgentTraceCapture(m.db,m.rpc,load),result=await run({now});expect(result).toMatchObject({attempted:1,saved:1});expect(load).toHaveBeenCalledTimes(1);
  expect(m.rows.filter(row=>decodeFreshEvidence(row.payload).trace)).toHaveLength(1);expect(m.calls.some(call=>/financial_events|fresh.jobs|UPDATE fresh.checkpoints|decoder_status=/.test(call.sql))).toBe(false);
 });
 it('does not retry a failed trace when urgent metadata changes the same receipt payload',async()=>{
  const now=new Date(),entry=fixture(now),m=memory([entry],now),load=vi.fn(async()=>null),run=createFreshUrgentTraceCapture(m.db,m.rpc,load);
  expect(await run({now})).toMatchObject({attempted:1,unavailable:1});
  const latest=decodeFreshEvidence(m.rows[0].payload);latest.stateEvidence={version:1,blockNumber:1000,blockHash,calls:[{to:token,data:'0x313ce567',result:word('0x12')}]};m.rows[0].payload=encodeFreshEvidence(latest);
  expect(await run({now})).toMatchObject({attempted:0,saved:0});expect(load).toHaveBeenCalledTimes(1);expect(m.calls.some(call=>call.sql==='BEGIN')).toBe(false);
 });
 it('serializes concurrent passes, honors cancellation and settles work without detached traces',async()=>{
  const now=new Date(),entry=fixture(now),m=memory([entry],now);let release!:()=>void;
  const hold=new Promise<void>(resolve=>{release=resolve;}),load=vi.fn(async()=>{await hold;return trace(entry);}),run=createFreshUrgentTraceCapture(m.db,m.rpc,load),controller=new AbortController();
  const work=run({now,signal:controller.signal});await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(1));expect(await run({now})).toMatchObject({yielded:true});
  controller.abort();release();expect(await work).toMatchObject({saved:0,unavailable:1});expect(m.calls.some(call=>call.sql==='BEGIN')).toBe(false);
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
   expect(await run({now})).toMatchObject({attempted:0});expect(load).toHaveBeenCalledTimes(1);expect(m.calls.some(call=>call.sql==='BEGIN')).toBe(false);
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
