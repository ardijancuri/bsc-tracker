import{describe,it,expect,vi}from'vitest';
import{createFreshRealizedEstimateGate,freshRealizedEstimateReady,freshRealizedEstimateReadySql,FRESH_REALIZED_ESTIMATE_POLICY}from'./estimatedProjectionPolicy.js';
describe('separate estimate readiness',()=>{
 it('requires numeric version and explicit completed policy',()=>{
  const good={version:1,policy:FRESH_REALIZED_ESTIMATE_POLICY,state:'complete'};expect(freshRealizedEstimateReady(good)).toBe(true);
  for(const v of[null,{}, {...good,version:'1'},{...good,state:'running'},{...good,policy:'sales_fifo_fees_v2'}])expect(freshRealizedEstimateReady(v)).toBe(false);
  expect(freshRealizedEstimateReadySql()).toContain("value->'version'='1'::jsonb");
 });
 it('keeps collection live, coalesces polling and releases financial stages only after completion',async()=>{
  let at=0,value:unknown=null;const query=vi.fn(async()=>({rows:value?[{value}]:[]}));const gate=createFreshRealizedEstimateGate({query} as any,()=>at);
  for(const stage of['capture','urgent_evidence','urgent_trace'])expect(await gate(stage)).toBe(true);expect(query).not.toHaveBeenCalled();
  expect(await Promise.all([gate('decode'),gate('balance')])).toEqual([false,false]);expect(query).toHaveBeenCalledTimes(1);
  at=499;expect(await gate('maintenance')).toBe(false);expect(query).toHaveBeenCalledTimes(1);
  value={version:1,policy:FRESH_REALIZED_ESTIMATE_POLICY,state:'complete'};at=500;expect(await gate('decode')).toBe(true);expect(await gate('balance')).toBe(true);expect(query).toHaveBeenCalledTimes(2);
 });
});
