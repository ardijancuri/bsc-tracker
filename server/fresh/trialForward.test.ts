import{describe,it,expect,vi}from'vitest';
import{readFreshForwardTrialSnapshot,type FreshForwardSnapshotScope}from'./trialForward.js';
const now=Date.parse('2026-10-24T01:00:00.000Z'),hash='0x'+'a'.repeat(64);
const scope:FreshForwardSnapshotScope={version:1,policy:'forward_activity_v1',blockNumber:100,blockHash:hash,occurredAt:new Date(now-1000).toISOString(),activatedAt:new Date(now).toISOString(),captureRevision:'1'};
function fixture(options:{fail?:boolean;hash?:string}={}){
 const queries:string[]=[],release=vi.fn();
 const client={release,query:vi.fn(async(sql:string)=>{queries.push(sql);
  if(sql.startsWith('BEGIN')||sql==='COMMIT'||sql==='ROLLBACK')return{rows:[]};
  if(sql.startsWith('SELECT key,'))return{rows:[{key:'capture',block_number:'101',block_hash:hash},{key:'decode',block_number:'20'}]};
  if(sql.startsWith('SELECT block_hash,'))return{rows:[{block_hash:options.hash??hash,occurred_at:scope.occurredAt}]};
  if(options.fail)throw Error('inspection_failed');
  if(sql.includes('AS financial_events'))return{rows:[{public_buys:'1',public_sells:'1',tokens:'1',pending_evidence:'0',repair_evidence:'0'}]};
  if(sql.includes('dependencies AS'))return{rows:[{scope_id:'kol:x',token_address:'token',wallet_gap:true,decoding_pending:true}]};
  if(sql.includes('AS no_scope'))return{rows:[{no_scope:'1',missing:'2',noncanonical:'0'}]};
  if(sql.includes('AS global_decode_block'))return{rows:[{repair_evidence:'200',global_decode_block:'20'}]};
  throw Error('unexpected_sql');})};
 return{database:{connect:async()=>client}as any,queries,release};
}
describe('forward trial coherent read-only snapshot',()=>{
 it('holds all forward counts, affected projections and old dependencies in one repeatable read',async()=>{const f=fixture(),result=await readFreshForwardTrialSnapshot(f.database,scope,now);
  expect(f.queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');expect(f.queries.at(-1)).toBe('COMMIT');expect(f.release).toHaveBeenCalledOnce();
  expect(result.boundaryCanonical).toBe(true);expect(result.counts.forward_projection_missing).toBe('3');expect(result.counts.forward_dependency_pending).toBe('1');
  expect(result.historicalDiagnostics.repair_evidence).toBe('200');expect(result.checkpoints.find(x=>x.key==='decode')?.block_number).toBe('20');
  expect(result.forwardRepresentativeCounts).toEqual({public_buys:'1',public_sells:'1',tokens:'1'});
 });
 it('reports an orphaned fixed checkpoint and preserves diagnostics without inventing a new boundary',async()=>{const f=fixture({hash:'0x'+'b'.repeat(64)});expect((await readFreshForwardTrialSnapshot(f.database,scope,now)).boundaryCanonical).toBe(false);});
 it('rolls back and releases on an incomplete snapshot instead of returning partial healthy evidence',async()=>{const f=fixture({fail:true});await expect(readFreshForwardTrialSnapshot(f.database,scope,now)).rejects.toThrow('inspection_failed');expect(f.queries.at(-1)).toBe('ROLLBACK');expect(f.release).toHaveBeenCalledOnce();});
 it('rejects malformed or mutable-looking checkpoint inputs before opening any transaction',async()=>{const f=fixture();for(const change of[{blockNumber:-1},{blockHash:'latest'},{policy:'historical'},{captureRevision:'bad'},{occurredAt:'bad'}])await expect(readFreshForwardTrialSnapshot(f.database,{...scope,...change}as any,now)).rejects.toThrow('invalid_forward_trial_scope');expect(f.queries).toHaveLength(0);});
});
