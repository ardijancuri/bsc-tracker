import type{Pool}from'pg';

/** Realized trading gains are sales less original FIFO cost and charged fees.
 * Transfers retain inventory/cost history and never create realized income. */
export const FRESH_REALIZED_POLICY='sales_fifo_fees_v2' as const;
export const FRESH_REALIZED_POLICY_KEY='accounting:realized_policy' as const;
export function freshRealizedPolicyReady(value:unknown):boolean{
 const row=value as{version?:unknown;policy?:unknown;state?:unknown}|null;
 return row?.version===1&&row.policy===FRESH_REALIZED_POLICY&&row.state==='complete';
}
/** A new writer must not append its deltas to projections from another policy.
 * The release operator migrates existing results atomically before cutover. */
export async function assertFreshRealizedPolicyForWorker(db:Pick<Pool,'query'>){
 const value=(await db.query('SELECT value FROM fresh.checkpoints WHERE key=$1',[FRESH_REALIZED_POLICY_KEY])).rows[0]?.value;
 if(!freshRealizedPolicyReady(value))throw Error('fresh_realized_policy_migration_required');
}

/** Capture must survive a projection handoff: only financial/derived writers
 * wait. The one durable capture owner and urgent evidence keep their windows. */
export function createFreshRealizedPolicyGate(db:Pick<Pool,'query'>,now=Date.now){
 let ready=false,checked=-Infinity,pending:Promise<boolean>|undefined;
 return async(stage:string):Promise<boolean>=>{
  if(['capture','urgent_evidence','urgent_trace'].includes(stage)||ready)return true;
  if(pending)return pending;
  if(now()-checked<500)return false;
  checked=now();
  pending=(async()=>{const value=(await db.query('SELECT value FROM fresh.checkpoints WHERE key=$1',[FRESH_REALIZED_POLICY_KEY])).rows[0]?.value;ready=freshRealizedPolicyReady(value);return ready;})();
  try{return await pending;}finally{pending=undefined;}
 };
}
export const freshRealizedPolicyReadySql=()=>`COALESCE((SELECT (value->'version')='1'::jsonb AND value->>'policy'='${FRESH_REALIZED_POLICY}' AND value->>'state'='complete' FROM fresh.checkpoints WHERE key='${FRESH_REALIZED_POLICY_KEY}'),false)`;
