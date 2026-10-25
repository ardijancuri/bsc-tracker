import {FRESH_FORWARD_TRIAL_POLICY,FRESH_TRIAL_POLICY,FRESH_TRIAL_REPORT_VERSION,FRESH_TRIAL_TARGET_SECONDS,type FreshForwardTrialScope} from './trialValidation.js';
import {FRESH_TRIAL_DOMAINS,FRESH_TRIAL_PROGRESS_POLICY,breakFreshTrialSampleContinuity,createFreshTrialProgress,
  freshTrialProgressSummary,importReviewedFreshTrialCredit,reviewFreshTrialSegment,type FreshTrialProgress,type FreshTrialReview} from './trialProgress.js';
import type {readReviewedFreshTrialHistory} from './trialHistory.js';
import{FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE,FRESH_TRIAL_FINANCIAL_BASELINE_SHA256,type FreshTrialFinancialRuntimeBinding}from'./trialRuntimeBinding.js';

export interface FreshTrialReviewManifest {
  version:1; id:string; sourceDigest:string; reason:string; evidence:string[];
  changedDomains:FreshTrialReview['changedDomains']; checks:FreshTrialReview['checks']; historyAudit?:string;
  forwardScope?:FreshForwardTrialScope;financialRuntimeBinding?:FreshTrialFinancialRuntimeBinding;
  validationScopePolicy?:typeof FRESH_FORWARD_TRIAL_POLICY;
}
type ReviewedHistory=Awaited<ReturnType<typeof readReviewedFreshTrialHistory>>;
const fingerprint=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
function requireForwardScope(scope:FreshForwardTrialScope,now:number){
 const fields=['version','policy','blockNumber','blockHash','occurredAt','activatedAt','captureRevision'];
 if(!scope||Object.keys(scope).length!==fields.length||Object.keys(scope).some(key=>!fields.includes(key))||scope.version!==1||scope.policy!==FRESH_FORWARD_TRIAL_POLICY
  ||!Number.isSafeInteger(scope.blockNumber)||scope.blockNumber<0||!/^0x[a-f0-9]{64}$/.test(scope.blockHash??'')
  ||typeof scope.captureRevision!=='string'||!/^(?:0|[1-9][0-9]{0,18})$/.test(scope.captureRevision)||BigInt(scope.captureRevision)>9223372036854775807n
  ||typeof scope.occurredAt!=='string'||typeof scope.activatedAt!=='string'||!Number.isFinite(Date.parse(scope.occurredAt))||!Number.isFinite(Date.parse(scope.activatedAt))
  ||Date.parse(scope.occurredAt)>Date.parse(scope.activatedAt)||Date.parse(scope.activatedAt)>now)throw Error('Invalid forward validation checkpoint');
}
function requireRuntimeBinding(binding:FreshTrialFinancialRuntimeBinding){
 if(!binding||binding.version!==1||typeof binding.baselinePath!=='string'||!binding.baselinePath.trim()||binding.baselinePath.length>2048||binding.sha256!==FRESH_TRIAL_FINANCIAL_BASELINE_SHA256
  ||binding.runtimeSourceDigest!==FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE)throw Error('Invalid forward financial runtime binding');
}
/** The caller independently checks canonical headers and the pinned source
 * artifact. This pure transition refuses implicit or mutable window changes. */
function reviewScope(prior:any,manifest:FreshTrialReviewManifest,now:number){
 const active=prior.validationScopePolicy===FRESH_FORWARD_TRIAL_POLICY;
 if(Object.prototype.hasOwnProperty.call(manifest,'validationScopePolicy')&&manifest.validationScopePolicy!==FRESH_FORWARD_TRIAL_POLICY)throw Error('Forward validation cannot return to an implicit global scope');
 if(prior.validationScopePolicy!==undefined&&!active)throw Error('Unsupported validation scope policy');
 if(active){requireForwardScope(prior.forwardScope,now);requireRuntimeBinding(prior.financialRuntimeBinding);
  if(Object.prototype.hasOwnProperty.call(manifest,'forwardScope')&&fingerprint(manifest.forwardScope)!==fingerprint(prior.forwardScope))throw Error('Forward validation checkpoint is immutable');
  if(Object.prototype.hasOwnProperty.call(manifest,'financialRuntimeBinding')&&fingerprint(manifest.financialRuntimeBinding)!==fingerprint(prior.financialRuntimeBinding))throw Error('Forward financial runtime binding is immutable');
  return{changed:false,forwardScope:structuredClone(prior.forwardScope)as FreshForwardTrialScope,financialRuntimeBinding:structuredClone(prior.financialRuntimeBinding)as FreshTrialFinancialRuntimeBinding};
 }
 if(prior.forwardScope!==undefined||prior.financialRuntimeBinding!==undefined)throw Error('Unreviewed forward validation state');
 if(manifest.forwardScope===undefined&&manifest.financialRuntimeBinding===undefined){if(manifest.validationScopePolicy!==undefined)throw Error('Forward validation requires an explicit checkpoint');return{changed:false};}
 if(prior.version!==FRESH_TRIAL_REPORT_VERSION||!prior.progress||!manifest.forwardScope||!manifest.financialRuntimeBinding)throw Error('Forward validation requires explicit reviewed scope and runtime proof');
 requireForwardScope(manifest.forwardScope,now);requireRuntimeBinding(manifest.financialRuntimeBinding);
 if(!manifest.changedDomains.includes('trial_monitor'))throw Error('Forward validation requires a monitor policy review');
 return{changed:true,forwardScope:structuredClone(manifest.forwardScope),financialRuntimeBinding:structuredClone(manifest.financialRuntimeBinding)};
}

/** Pure review transition. The CLI verifies referenced files and archives the old
 * report first. A changed build adds a segment; it never clears earned credit. */
export function prepareFreshTrialReview(input:{prior:any;manifest:FreshTrialReviewManifest;sourceDigest:string;now:number;history?:ReviewedHistory}) {
  const {prior,manifest,sourceDigest,now,history}=input;
  if(manifest.version!==1||!manifest.id||manifest.sourceDigest!==sourceDigest)throw Error('Review must name the current source fingerprint');
  if(prior.validationPolicy!==FRESH_TRIAL_POLICY||prior.targetSeconds!==FRESH_TRIAL_TARGET_SECONDS)throw Error('Unreviewed trial evidence policy');
  const scope=reviewScope(prior,manifest,now);
  let progress:FreshTrialProgress;
  let beforeVerifiedSeconds:number;
  if(prior.version===3&&!prior.progress){
    if(!history||!manifest.historyAudit)throw Error('Legacy credit requires independently verified archived observations');
    const old=history.segments.find(segment=>segment.sourceDigest===prior.sourceDigest&&segment.startedAt===Date.parse(prior.startedAt));
    const oldSeconds=old?.intervals.reduce((sum,[start,end])=>sum+(end-start)/1000,0);
    if(oldSeconds===undefined||Math.abs(oldSeconds-Number(prior.verifiedSeconds))>0.001)throw Error('Active legacy credit differs from the reviewed archive');
    progress=createFreshTrialProgress({campaignId:'kollens_fresh_20261022_24h:129180844',startedAt:history.startedAt});
    beforeVerifiedSeconds=Number(prior.verifiedSeconds);
    for(const segment of history.segments){
      const review={id:`${manifest.id}:historical:${segment.id}`,reviewedAt:now,
        reason:'Retrospective adoption of reconstructed healthy intervals under explicit cumulative-time approval',evidence:segment.evidence};
      progress=reviewFreshTrialSegment(progress,{...segment,review:{...review,changedDomains:[...FRESH_TRIAL_DOMAINS],
        checks:FRESH_TRIAL_DOMAINS.map(domain=>({domain,status:'passed' as const,evidence:segment.evidence}))}});
      // Collection-only time is deliberately not inferred from legacy counters.
      // Every imported healthy interval also proves collection was healthy.
      progress=importReviewedFreshTrialCredit(progress,{segmentId:segment.id,intervals:segment.intervals,collectionIntervals:segment.intervals,
        representativeAt:segment.representativeAt,review});
    }
    const imported=freshTrialProgressSummary(progress,{currentSegmentId:history.segments.at(-1)!.id,now});
    if(Math.abs(imported.verifiedSeconds-history.totalSeconds)>0.001)throw Error('Imported trial credit does not reconcile');
  }else{
    if(prior.version!==FRESH_TRIAL_REPORT_VERSION||prior.progressPolicy!==FRESH_TRIAL_PROGRESS_POLICY||!prior.progress)throw Error('Unsupported trial report; no automatic reset is permitted');
    if(history||manifest.historyAudit)throw Error('History is already adopted; do not import it again');
    progress=structuredClone(prior.progress);
    beforeVerifiedSeconds=freshTrialProgressSummary(progress,{currentSegmentId:prior.currentSegmentId,now}).verifiedSeconds;
    if(Math.abs(beforeVerifiedSeconds-Number(prior.verifiedSeconds))>0.001)throw Error('Stored cumulative trial credit does not reconcile');
  }
  const sameSource=prior.version===4&&prior.sourceDigest===sourceDigest&&!scope.changed;
  const startedAt=sameSource?Date.parse(prior.segmentStartedAt):now;
  const segmentId=sameSource?prior.currentSegmentId:`${sourceDigest}@${new Date(startedAt).toISOString()}`;
  progress=reviewFreshTrialSegment(progress,{id:segmentId,sourceDigest,startedAt,review:{id:manifest.id,reviewedAt:now,
    reason:manifest.reason,evidence:manifest.evidence,changedDomains:manifest.changedDomains,checks:manifest.checks}});
  progress=breakFreshTrialSampleContinuity(progress,segmentId);
  const summary=freshTrialProgressSummary(progress,{currentSegmentId:segmentId,now});
  const state={...prior,version:FRESH_TRIAL_REPORT_VERSION,validationPolicy:FRESH_TRIAL_POLICY,progressPolicy:FRESH_TRIAL_PROGRESS_POLICY,
    ...(scope.forwardScope?{validationScopePolicy:FRESH_FORWARD_TRIAL_POLICY,forwardScope:scope.forwardScope,financialRuntimeBinding:scope.financialRuntimeBinding}:{}),
    targetSeconds:FRESH_TRIAL_TARGET_SECONDS,startedAt:new Date(progress.startedAt).toISOString(),segmentStartedAt:new Date(startedAt).toISOString(),
    currentSegmentId:segmentId,sourceDigest,progress,verifiedSeconds:summary.verifiedSeconds,collectionSeconds:summary.collectionSeconds,
    representative:summary.representative,durationComplete:summary.durationComplete,complete:false,acceptanceStatus:'awaiting_observation',
    regressionProblems:summary.regressionProblems,monitorPid:null,lastReviewId:manifest.id,updatedAt:new Date(now).toISOString(),
    segmentSummary:summary.segments.map(({intervals,collectionIntervals,...segment})=>segment)};
  return{state,beforeVerifiedSeconds,afterVerifiedSeconds:summary.verifiedSeconds,sourceDigest,segmentId};
}
