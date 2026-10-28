import type{Pool}from'pg';
export const FRESH_REALIZED_ESTIMATE_POLICY='omit_unknown_costs_v1' as const;
export const FRESH_REALIZED_ESTIMATE_POLICY_KEY='accounting:realized_estimate_policy' as const;
export function freshRealizedEstimateReady(value:unknown):boolean{const v=value as{version?:unknown;policy?:unknown;state?:unknown}|null;return v?.version===1&&v.policy===FRESH_REALIZED_ESTIMATE_POLICY&&v.state==='complete';}
export const freshRealizedEstimateReadySql=()=>`COALESCE((SELECT value->'version'='1'::jsonb AND value->>'policy'='${FRESH_REALIZED_ESTIMATE_POLICY}' AND value->>'state'='complete' FROM fresh.checkpoints WHERE key='${FRESH_REALIZED_ESTIMATE_POLICY_KEY}'),false)`;
/** Projection handoff pauses derived writers, preserving the canonical capture
 * owner and both bounded urgent lanes. Readiness is published last by the
 * atomic operator; exact financial accounting uses its separate policy. */
export function createFreshRealizedEstimateGate(db:Pick<Pool,'query'>,now=Date.now){let ready=false,checked=-Infinity,pending:Promise<boolean>|undefined;return async(stage:string):Promise<boolean>=>{
 if(['capture','urgent_evidence','urgent_trace'].includes(stage)||ready)return true;if(pending)return pending;if(now()-checked<500)return false;checked=now();pending=(async()=>{const row=(await db.query('SELECT value FROM fresh.checkpoints WHERE key=$1',[FRESH_REALIZED_ESTIMATE_POLICY_KEY])).rows[0];ready=freshRealizedEstimateReady(row?.value);return ready;})();try{return await pending;}finally{pending=undefined;}
};}
