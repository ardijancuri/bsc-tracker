import{describe,expect,it}from'vitest';
import{createFreshDecodeWorkBudget,createFreshDecodeServiceCycle,groupFreshDecodeRows}from'./decodeWorkBudget.js';

describe('bounded decoder normalization scheduling',()=>{
  it('reserves every fourth worker pass for due repairs while serving fresh work on the other three',()=>{const next=createFreshDecodeServiceCycle();expect(Array.from({length:12},()=>next().repairFirst)).toEqual([false,false,false,true,false,false,false,true,false,false,false,true]);});
  it('keeps service counters local to each worker with no clock or shared queue state',()=>{const first=createFreshDecodeServiceCycle(),second=createFreshDecodeServiceCycle();for(let i=0;i<3;i++)expect(first().repairFirst).toBe(false);expect(first().repairFirst).toBe(true);expect(second().repairFirst).toBe(false);expect(first().repairFirst).toBe(false);});
  it('keeps legacy callers unbounded when no budget was requested',()=>{
    let at=0;const next=createFreshDecodeWorkBudget({now:()=>at});
    for(const value of[0,3_000,60_000,86_400_000]){at=value;expect(next()).toBe(true);}
  });
  it('always permits one complete group after a slow selection/setup phase',()=>{
    let at=0;const next=createFreshDecodeWorkBudget({maxMs:3_000,now:()=>at});at=8_000;
    expect(next()).toBe(true);expect(next()).toBe(false);
  });
  it('yields at the deadline before another group, without resetting the elapsed budget',()=>{
    let at=10;const next=createFreshDecodeWorkBudget({maxMs:3_000,now:()=>at});expect(next()).toBe(true);
    at=2_000;expect(next()).toBe(true);at=3_009;expect(next()).toBe(true);at=3_010;expect(next()).toBe(false);at=3_011;expect(next()).toBe(false);
  });
  it('fails closed after the first group if an injected monotonic clock becomes invalid',()=>{
    for(const broken of[-1,Number.NaN,Infinity]){let at=0;const next=createFreshDecodeWorkBudget({maxMs:3_000,now:()=>at});expect(next()).toBe(true);at=broken;expect(next()).toBe(false);}
  });
  it.each([0,-1,0.5,30_001,Number.NaN,Infinity])('rejects invalid explicit work budgets (%s)',maxMs=>{
    expect(()=>createFreshDecodeWorkBudget({maxMs})).toThrow('decode_work_budget_invalid');
  });
  it('retains pending-first block-group priority, including separated selected members of that block',()=>{
    const pending={id:'new-pending',block_number:'300',block_hash:'head'},older={id:'old-repair',block_number:'100',block_hash:'older'},sameBlock={id:'same-block-repair',block_number:'300',block_hash:'head'};
    const groups=groupFreshDecodeRows([pending,older,sameBlock]);expect(groups).toEqual([[pending,sameBlock],[older]]);
    expect(groups[0][0]).toBe(pending);expect(groups[0][1]).toBe(sameBlock);
  });
  it('does not combine distinct block hashes or change receipt context',()=>{
    const a={block_number:'100',block_hash:'canonical',wallets:['a','b'],payload:Buffer.from('complete receipt')},b={...a,block_hash:'orphan'};
    expect(groupFreshDecodeRows([a,b])).toEqual([[a],[b]]);expect(groupFreshDecodeRows([])).toEqual([]);
  });
});
