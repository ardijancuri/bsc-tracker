import type{Pool}from'pg';
import type{FreshLot,FreshPosition}from'../../shared/freshAccounting.js';
import{FreshRational,hydrateFreshKnownLotCosts}from'./accounting.js';
const q=FreshRational.fromStored,zero=q('0');
export async function readFreshPositionEstimates(db:Pick<Pool,'query'>,scopeId:string,tokens:string[],lots:FreshLot[]){
  const results=(await db.query(`SELECT token_address,realized_q,estimated_realized_q FROM fresh.scope_event_results WHERE scope_id=$1 AND token_address=ANY($2::text[])`,[scopeId,tokens])).rows;
  const ids=[...new Set(lots.filter(l=>l.costQ===null||!l.feeKnown).map(l=>l.acquiredEventId))];
  const sources=ids.length?(await db.query(`SELECT e.*,r.scope_id AS charged_scope_id,r.token_address AS charged_token_address,r.fee_q AS charged_fee_q FROM fresh.financial_events e JOIN fresh.scope_event_results r ON r.event_id=e.id AND r.scope_id=$1 WHERE e.id=ANY($2::text[]) AND e.canonical`,[scopeId,ids])).rows:[];
  const hydrated=hydrateFreshKnownLotCosts(lots,sources),out=new Map<string,{realized:string;remaining:string}>();
  for(const token of tokens){const rows=results.filter(r=>r.token_address===token),owned=hydrated.filter(l=>l.tokenAddress===token);if(!rows.length||rows.some(r=>r.realized_q===null&&r.estimated_realized_q===null)||owned.some(l=>l.costQ===null&&l.knownCostQ==null))continue;
    out.set(token,{realized:rows.reduce((n,r)=>n.add(q(r.realized_q??r.estimated_realized_q)),zero).exact(),remaining:owned.reduce((n,l)=>n.add(q(l.costQ??l.knownCostQ!)),zero).exact()});}
  return out;
}
export function freshPositionEstimateValues(position:FreshPosition,stored:{realized:string;remaining:string},valueUsd:string|null){
  return{realizedProfitUsd:q(stored.realized).decimal(),knownRemainingCostUsd:q(stored.remaining).decimal(),knownCapitalUsd:q(position.capitalQ).decimal(),
    totalProfitUsd:valueUsd===null?null:q(stored.realized).add(FreshRational.parse(valueUsd)).sub(q(stored.remaining)).decimal()};
}
