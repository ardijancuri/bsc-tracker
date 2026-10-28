import{describe,it,expect,vi}from'vitest';
import{FRESH_REALIZED_POLICY,FRESH_REALIZED_POLICY_KEY,freshRealizedPolicyReady,assertFreshRealizedPolicyForWorker,createFreshRealizedPolicyGate}from'./realizedPolicy.js';
describe('stored realized policy handoff',()=>{
 it.each([null,undefined,{}, {version:1,policy:'kollens_fifo_v1',state:'complete'},{version:1,policy:FRESH_REALIZED_POLICY,state:'migrating'},{version:2,policy:FRESH_REALIZED_POLICY,state:'complete'},{version:'1',policy:FRESH_REALIZED_POLICY,state:'complete'}])('rejects absent, stale or incomplete projection policy %j',value=>expect(freshRealizedPolicyReady(value)).toBe(false));
 it('accepts only the completed approved policy',()=>expect(freshRealizedPolicyReady({version:1,policy:FRESH_REALIZED_POLICY,state:'complete'})).toBe(true));
 it('refuses a writer before an atomic migration completes, without writing or scanning history',async()=>{
  const query=vi.fn(async()=>({rows:[{value:{version:1,policy:FRESH_REALIZED_POLICY,state:'migrating'}}]}));
  await expect(assertFreshRealizedPolicyForWorker({query}as any)).rejects.toThrow('fresh_realized_policy_migration_required');
  expect(query).toHaveBeenCalledExactlyOnceWith('SELECT value FROM fresh.checkpoints WHERE key=$1',[FRESH_REALIZED_POLICY_KEY]);
 });
 it('permits the new writer after the stored handoff',async()=>{
  const query=vi.fn(async()=>({rows:[{value:{version:1,policy:FRESH_REALIZED_POLICY,state:'complete'}}]}));
  await expect(assertFreshRealizedPolicyForWorker({query}as any)).resolves.toBeUndefined();expect(query).toHaveBeenCalledTimes(1);
 });
 it('keeps capture and urgent evidence running while every financial stage waits, then releases without restarting capture',async()=>{
  let time=1000,complete=false;const query=vi.fn(async()=>({rows:complete?[{value:{version:1,policy:FRESH_REALIZED_POLICY,state:'complete'}}]:[]})),gate=createFreshRealizedPolicyGate({query}as any,()=>time);
  for(const stage of['capture','urgent_evidence','urgent_trace'])expect(await gate(stage)).toBe(true);
  expect(query).not.toHaveBeenCalled();
  expect(await Promise.all(['decode','rolling_pnl','registration','prices','balances','maintenance','token_discovery'].map(gate))).toEqual(Array(7).fill(false));expect(query).toHaveBeenCalledTimes(1);
  complete=true;time+=499;expect(await gate('decode')).toBe(false);expect(query).toHaveBeenCalledTimes(1);
  time++;expect(await gate('decode')).toBe(true);expect(query).toHaveBeenCalledTimes(2);
  expect(await gate('rolling_pnl')).toBe(true);expect(await gate('capture')).toBe(true);expect(query).toHaveBeenCalledTimes(2);
 });
 it('does not authorize financial work after a failed policy read',async()=>{
  const query=vi.fn(async()=>{throw Error('database_unavailable');}),gate=createFreshRealizedPolicyGate({query}as any);
  await expect(gate('decode')).rejects.toThrow('database_unavailable');expect(await gate('capture')).toBe(true);expect(await gate('urgent_trace')).toBe(true);
 });
});
