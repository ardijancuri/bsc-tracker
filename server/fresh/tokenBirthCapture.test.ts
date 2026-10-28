import{describe,expect,it,vi}from'vitest';
import type{Pool}from'pg';import type{Rpc}from'../rpc.js';
import{encodeFreshEvidence,decodeFreshEvidence,type FreshCapturedReceipt}from'./capture.js';
import{tokenBirthFixture,birthHash}from'./fixtures/tokenBirthFixture.js';
import{runFreshTokenBirthCapture,freshTokenBirthQueueSql,freshTokenBirthSelectionSql}from'./tokenBirthCapture.js';
const clone=<T>(x:T):T=>structuredClone(x);
function memory(options:{retained?:boolean;stale?:boolean;noJob?:boolean;revisionChanged?:boolean;factChanged?:boolean;leaseChanged?:boolean;lateLeaseLost?:boolean;bodyConflict?:boolean;selectionMissing?:boolean;lateSelectionMissing?:boolean}={}){
 const f=tokenBirthFixture(),now=new Date('2026-10-26T12:00:00Z'),initial={token_address:f.token,protocol:f.fact.protocol,block_number:'120',block_hash:f.fact.blockHash,tx_hash:f.fact.txHash,log_index:f.fact.logIndex,launched_at:new Date(f.timestamp),proof:clone(f.fact.proof),status:'eligible'};
 let row=clone(initial),payload:Buffer|undefined=options.retained?encodeFreshEvidence({...f.creation,wallets:[f.creation.transaction.from],observedAt:'2026-01-01T00:02:05Z',decodeDiagnostics:{version:1,valuationReasons:['retained_reason'],firstFailure:{version:1,at:'2026-01-01T00:02:05Z',reasons:['retained_reason']}}}as FreshCapturedReceipt):undefined;
 const firstPayload=payload&&Buffer.from(payload),job:any={id:'token_birth:'+f.token,reference:f.token,progress:{version:1,kind:'token_birth_capture_v1',blockNumber:120,blockHash:f.fact.blockHash,transactionHash:f.fact.txHash}};
 let before:{row:any;payload:Buffer|undefined}|undefined,lease:string|undefined,selectionChecks=0;
 const statements:{sql:string;params:any[]}[]=[],query=vi.fn(async(sql:string,params:any[]=[]):Promise<any>=>{
  statements.push({sql,params});if(sql.startsWith('SELECT c.revision'))return{rows:[{revision:'1',block_number:'130',occurred_at:new Date(now.getTime()-(options.stale?21000:1000))}]};
  if(sql===freshTokenBirthQueueSql)return{rows:[],rowCount:1};
  if(sql===freshTokenBirthSelectionSql){selectionChecks++;return{rows:[{selected:!options.selectionMissing&&!(options.lateSelectionMissing&&selectionChecks>1)}]};}
  if(sql.startsWith('UPDATE fresh.jobs SET lease_id=$2')){lease=params[1];return{rows:options.noJob?[]:[clone(job)]};}
  if(sql==='BEGIN'){before={row:clone(row),payload:payload&&Buffer.from(payload)};return{rows:[]};}
  if(sql==='ROLLBACK'){if(before){row=before.row;payload=before.payload;}return{rows:[]};}
  if(sql==='COMMIT')return{rows:[]};
  if(sql.startsWith('SELECT * FROM fresh.jobs'))return{rows:options.leaseChanged?[]:[clone(job)]};
  if(sql.startsWith("SELECT block_number::text,block_hash FROM fresh.checkpoints WHERE key='start'"))return{rows:[{block_number:'100',block_hash:f.start.hash}]};
  if(sql.startsWith('SELECT revision::text'))return{rows:[{revision:options.revisionChanged?'2':'1',block_number:'130'}]};
  if(sql.startsWith('SELECT block_hash,parent_hash'))return{rows:[{block_hash:f.fact.blockHash,parent_hash:f.creation.block.parentHash,occurred_at:new Date(f.timestamp)}]};
  if(sql.startsWith('SELECT * FROM fresh.launch_facts'))return{rows:[{...clone(row),...(sql.includes('FOR UPDATE')&&options.factChanged?{status:'excluded_non_token'}:{})}]};
  if(sql.startsWith('SELECT payload FROM fresh.recent_evidence')){if(sql.includes('FOR SHARE')&&options.bodyConflict){const changed=clone(f.creation);changed.transaction.value='0x1';return{rows:[{payload:encodeFreshEvidence({...changed,wallets:[],observedAt:now.toISOString()})}]};}return{rows:payload?[{payload}]:[]};}
  if(sql.startsWith('UPDATE fresh.launch_facts')){row.proof=JSON.parse(params[1]);return{rows:[],rowCount:1};}
  if(sql.startsWith('INSERT INTO fresh.recent_evidence')){payload=params[4];return{rows:[],rowCount:1};}
  if(sql.startsWith("UPDATE fresh.jobs SET state='done'"))return{rows:[],rowCount:options.lateLeaseLost?0:1};
  if(sql.startsWith('UPDATE fresh.jobs SET lease_id=NULL'))return{rows:[],rowCount:lease===params[1]?1:0};
  return{rows:[],rowCount:1};
 });
 const rpc=vi.fn(async(method:string,params:unknown[])=>{expect(statements.some(s=>s.sql==='BEGIN')).toBe(false);if(method==='eth_getBlockByNumber')return params[1]===true?clone(f.creation.block):{...clone(f.creation.block),transactions:[]};if(method==='eth_getTransactionReceipt')return clone(f.creation.receipt);throw Error('unexpected_financial_or_state_rpc');})as unknown as Rpc;
 return{f,now,query,rpc,statements,firstPayload,get row(){return row;},get payload(){return payload;},db:{query,connect:async()=>({query,release(){}})}as unknown as Pool};
}
describe('bounded selected-token birth evidence capture',()=>{
 it('restricts queue candidates to captured, selected or own-scope last24h positions and keeps one reference per token',()=>{
  expect(freshTokenBirthQueueSql).toContain('l.block_number<=$2');expect(freshTokenBirthQueueSql).toContain("interval '24 hours'");expect(freshTokenBirthQueueSql).toContain("selected.priority>=100");expect(freshTokenBirthQueueSql).toContain('s.active');expect(freshTokenBirthQueueSql).toContain('LIMIT 16');expect(freshTokenBirthQueueSql).toContain("WHERE fresh.jobs.state='cancelled'");
 });
 it('adds an authenticated certificate and one temporary canonical receipt without touching financial records',async()=>{
  const m=memory();expect(await runFreshTokenBirthCapture(m.db,m.rpc,{now:m.now})).toMatchObject({attempted:1,certified:1});
  expect(m.row.proof).toMatchObject({...m.f.fact.proof,tokenBirth:{kind:'authenticated_protocol_token_birth_v1',tokenAddress:m.f.token}});
  const entry=decodeFreshEvidence(m.payload!);expect(entry.receipt).toEqual(m.f.creation.receipt);expect(entry.wallets).toEqual([]);
  const insert=m.statements.find(s=>s.sql.startsWith('INSERT INTO fresh.recent_evidence'))!;expect(insert.params[6].getTime()-m.now.getTime()).toBe(72*3600_000);
  expect((m.rpc as any).mock.calls.map(([method]:string[])=>method)).toEqual(['eth_getBlockByNumber','eth_getTransactionReceipt','eth_getBlockByNumber']);
  expect(m.statements.some(s=>/UPDATE fresh.positions|INSERT INTO fresh.financial_events|UPDATE fresh.accounting_scopes|telegram|public\./.test(s.sql))).toBe(false);
  const done=m.statements.find(s=>s.sql.startsWith("UPDATE fresh.jobs SET state='done'"))!;expect(JSON.parse(done.params[2])).toEqual({stage:'certified',certificateSha256:expect.stringMatching(/^[a-f0-9]{64}$/)});
 });
 it('reuses and preserves an original receipt context, diagnostics and TTL without a duplicate receipt fetch/write',async()=>{
  const m=memory({retained:true});expect(await runFreshTokenBirthCapture(m.db,m.rpc,{now:m.now})).toMatchObject({certified:1});
  expect(m.payload).toEqual(m.firstPayload);expect((m.rpc as any).mock.calls.map(([method]:string[])=>method)).toEqual(['eth_getBlockByNumber','eth_getBlockByNumber']);expect(m.statements.some(s=>s.sql.startsWith('INSERT INTO fresh.recent_evidence')||s.sql.startsWith('UPDATE fresh.recent_evidence'))).toBe(false);
 });
 it('yields to stale capture or cancellation before any queue/write/RPC work',async()=>{
  const m=memory({stale:true});expect(await runFreshTokenBirthCapture(m.db,m.rpc,{now:m.now})).toMatchObject({yielded:true,attempted:0});expect(m.rpc).not.toHaveBeenCalled();expect(m.statements.some(s=>s.sql.startsWith('INSERT')||s.sql.startsWith('UPDATE'))).toBe(false);
  const cancelled=memory(),signal=AbortSignal.abort();expect(await runFreshTokenBirthCapture(cancelled.db,cancelled.rpc,{signal})).toMatchObject({yielded:true});expect(cancelled.query).not.toHaveBeenCalled();
 });
 it('does no node work when another worker owns all due leases',async()=>{const m=memory({noJob:true});expect(await runFreshTokenBirthCapture(m.db,m.rpc,{now:m.now})).toMatchObject({attempted:0});expect(m.rpc).not.toHaveBeenCalled();});
 it('cancels stale selection work before RPC and permits only bounded explicit selection leases',async()=>{
  const m=memory({selectionMissing:true});expect(await runFreshTokenBirthCapture(m.db,m.rpc,{now:m.now})).toMatchObject({certified:0,reason:'token_birth_not_selected'});expect(m.rpc).not.toHaveBeenCalled();expect(m.statements.some(s=>s.sql.includes("THEN 'cancelled'"))).toBe(true);
  expect(freshTokenBirthSelectionSql).toContain("interval '2 minutes'");expect(freshTokenBirthSelectionSql).toContain('selectedUntilMs');expect(freshTokenBirthQueueSql).toContain("prior.state<>'cancelled'");
 });
 it('rechecks selection before commit and rolls back a membership/selection expiry race',async()=>{const m=memory({lateSelectionMissing:true}),before=clone(m.row);expect(await runFreshTokenBirthCapture(m.db,m.rpc,{now:m.now})).toMatchObject({certified:0,reason:'token_birth_not_selected'});expect(m.row).toEqual(before);expect(m.payload).toBeUndefined();expect(m.statements.some(s=>s.sql==='COMMIT')).toBe(false);});
 it.each(['revisionChanged','factChanged','leaseChanged','lateLeaseLost','bodyConflict']as const)('retains original data after %s races',async race=>{
  const m=memory({[race]:true}),before=clone(m.row);expect(await runFreshTokenBirthCapture(m.db,m.rpc,{now:m.now})).toMatchObject({certified:0});expect(m.row).toEqual(before);expect(m.payload).toBeUndefined();expect(m.statements.some(s=>s.sql==='COMMIT')).toBe(false);
 });
 it('rejects orphaned header bookends without committing a certificate or body',async()=>{
  const m=memory(),base=(m.rpc as any).getMockImplementation();(m.rpc as any).mockImplementation(async(method:string,params:unknown[])=>{const result=await base(method,params);return method==='eth_getBlockByNumber'&&params[1]===false?{...result,hash:birthHash(999)}:result;});
  expect(await runFreshTokenBirthCapture(m.db,m.rpc,{now:m.now})).toMatchObject({certified:0,reason:'token_birth_creation_orphaned'});expect(m.row.proof.tokenBirth).toBeUndefined();expect(m.statements.some(s=>s.sql==='BEGIN')).toBe(false);
 });
 it('keeps unsupported creation semantics pending with a bounded retry instead of approving an event alone',async()=>{
  const m=memory();m.f.creation.receipt.logs[0].data=birthHash(0);expect(await runFreshTokenBirthCapture(m.db,m.rpc,{now:m.now})).toMatchObject({certified:0,reason:'token_birth_creation_unsupported'});expect(m.row.proof.tokenBirth).toBeUndefined();expect(m.statements.some(s=>s.sql.includes("interval '1 hour'"))).toBe(true);
 });
});
