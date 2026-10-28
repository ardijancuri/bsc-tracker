/** Display-only projection. Original amounts and FIFO basis remain nullable. */
export interface NodeCostEstimate {
  version: 1; policy: 'omit_unknown_costs_v1'; basis: 'recorded_facts';
  snapshotId: string; historyFingerprint: string; asOf: string; reasons: string[];
  realizedProfitUsd: string; totalProfitUsd: string | null;
  knownCapitalUsd: string; knownRemainingCostUsd: string;
  missingCostCount: number | null; missingProceedsCount: number | null; missingFeeCount: number | null;
}
export const nodeCostEstimateNote = 'Estimated · missing costs excluded. Known costs and fees are included; unknown amounts remain unavailable.';
export function validNodeCostEstimate(snapshot: {snapshotId:string;historyFingerprint:string;asOf:string;scope:string;source:string;estimate?:NodeCostEstimate}|null|undefined): NodeCostEstimate|null {
  const e=snapshot?.estimate, decimal=(v:unknown)=>typeof v==='string'&&v.length<=1024&&/^-?\d+(?:\.\d+)?$/.test(v)&&Number.isFinite(Number(v));
  if(!snapshot||snapshot.scope!=='public'||!['node','mixed'].includes(snapshot.source)||!e||e.version!==1||e.policy!=='omit_unknown_costs_v1'||e.basis!=='recorded_facts'
    ||!/^[a-f0-9]{64}$/.test(snapshot.snapshotId)||!/^[a-f0-9]{64}$/.test(snapshot.historyFingerprint)
    ||e.snapshotId!==snapshot.snapshotId||e.historyFingerprint!==snapshot.historyFingerprint||e.asOf!==snapshot.asOf
    ||!Number.isFinite(Date.parse(e.asOf))||!Array.isArray(e.reasons)||!e.reasons.length||e.reasons.some(r=>typeof r!=='string'||r.length>100)
    ||!decimal(e.realizedProfitUsd)||e.totalProfitUsd!==null&&!decimal(e.totalProfitUsd)||!decimal(e.knownCapitalUsd)||Number(e.knownCapitalUsd)<0
    ||!decimal(e.knownRemainingCostUsd)||Number(e.knownRemainingCostUsd)<0
    ||[e.missingCostCount,e.missingFeeCount,e.missingProceedsCount].some(v=>v!==null&&(!Number.isSafeInteger(v)||v<0)))return null;
  return e;
}
