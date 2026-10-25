/** Scheduling only: a started receipt/block group always finishes. This clock
 * never replaces the canonical event time or the financial processing clock. */
export function createFreshDecodeWorkBudget(options:{maxMs?:number;now?:()=>number}={}){
  if(options.maxMs!==undefined&&(!Number.isSafeInteger(options.maxMs)||options.maxMs<1||options.maxMs>30_000))throw Error('decode_work_budget_invalid');
  const clock=options.now??(()=>performance.now()),started=clock();let startedGroups=0;
  return()=>{
    if(startedGroups&&options.maxMs!==undefined){const elapsed=clock()-started;if(!Number.isFinite(elapsed)||elapsed<0||elapsed>=options.maxMs)return false;}
    startedGroups++;return true;
  };
}

/** Selection's pending-first group priority is retained. Coalesce all selected
 * members of a block so the budget cannot split its existing atomic commit. */
export function groupFreshDecodeRows<Row extends{block_number:string|number;block_hash:string}>(rows:readonly Row[]):Row[][]{
  const groups=new Map<string,Row[]>();
  for(const row of rows){const key=`${row.block_number}:${row.block_hash}`,group=groups.get(key);if(group)group.push(row);else groups.set(key,[row]);}
  return[...groups.values()];
}
