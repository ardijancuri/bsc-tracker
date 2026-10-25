import {describe,it,expect} from 'vitest';
import {prepareFreshTrialReview,type FreshTrialReviewManifest} from './trialReview.js';
import {recordFreshTrialSample} from './trialProgress.js';
import{FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE,FRESH_TRIAL_FINANCIAL_BASELINE_SHA256}from'./trialRuntimeBinding.js';
const start=Date.parse('2026-10-22T22:00:00.000Z'),now=start+1_000_000;
const oldDigest='a'.repeat(64),newDigest='b'.repeat(64),thirdDigest='c'.repeat(64);
const oldId=oldDigest+'@'+new Date(start).toISOString();
function legacy(){return{version:3,validationPolicy:'traded_positions_v1',targetSeconds:28800,startedAt:new Date(start).toISOString(),sourceDigest:oldDigest,verifiedSeconds:60,samples:3,failures:1,complete:false};}
function history(){return{startedAt:start,totalSeconds:60,segments:[{id:oldId,sourceDigest:oldDigest,startedAt:start,
  intervals:[[start,start+60_000] as [number,number]],representativeAt:start+60_000,evidence:['immutable-observations:sha256:a']} ]};}
function manifest(digest=newDigest):FreshTrialReviewManifest{return{version:1,id:'policy-adoption',sourceDigest:digest,reason:'User approved retaining verified healthy intervals',
  changedDomains:['trial_monitor'],checks:[{domain:'trial_monitor',status:'passed',evidence:['monitor-tests.json']}],evidence:['history-audit.json'],historyAudit:'history-audit.json'};}
function adopt(){return prepareFreshTrialReview({prior:legacy(),manifest:manifest(),sourceDigest:newDigest,now,history:history()});}
describe('reviewed cumulative trial transitions',()=>{
  it('adopts reconstructed intervals and keeps representative evidence across changed builds',()=>{
    const input=legacy(),before=structuredClone(input),result=adopt();
    expect(input).toEqual(before);expect(result.state.version).toBe(4);expect(result.afterVerifiedSeconds).toBe(60);
    expect(result.state.progress.segments).toHaveLength(2);expect(result.state.representative).toBe(true);
    expect(result.state.complete).toBe(false);expect(result.state.acceptanceStatus).toBe('awaiting_observation');
    expect(result.state.startedAt).toBe(new Date(start).toISOString());expect(result.state.segmentStartedAt).toBe(new Date(now).toISOString());
  });
  it('refuses unverified counters, source or policy changes rather than resetting them',()=>{
    expect(()=>prepareFreshTrialReview({prior:legacy(),manifest:manifest(),sourceDigest:newDigest,now})).toThrow('archived observations');
    expect(()=>prepareFreshTrialReview({prior:{...legacy(),verifiedSeconds:120},manifest:manifest(),sourceDigest:newDigest,now,history:history()})).toThrow('differs');
    expect(()=>prepareFreshTrialReview({prior:legacy(),manifest:manifest(),sourceDigest:thirdDigest,now,history:history()})).toThrow('fingerprint');
    expect(()=>prepareFreshTrialReview({prior:{...legacy(),targetSeconds:86400},manifest:manifest(),sourceDigest:newDigest,now,history:history()})).toThrow('policy');
  });
  it('a later small fix preserves all previous healthy time and requires only declared affected checks',()=>{
    const adopted=adopt().state;
    adopted.progress=recordFreshTrialSample(adopted.progress,{segmentId:adopted.currentSegmentId,at:now+60_000,healthy:true,collectionHealthy:true,representative:false});
    adopted.progress=recordFreshTrialSample(adopted.progress,{segmentId:adopted.currentSegmentId,at:now+120_000,healthy:true,collectionHealthy:true,representative:false});
    adopted.verifiedSeconds=120;
    const nextManifest=manifest(thirdDigest);delete nextManifest.historyAudit;nextManifest.id='small-replay-fix';
    nextManifest.changedDomains=['replay'];nextManifest.checks=[{domain:'replay',status:'passed',evidence:['replay-regression.json']}];
    const next=prepareFreshTrialReview({prior:adopted,manifest:nextManifest,sourceDigest:thirdDigest,now:now+180_000});
    expect(next.afterVerifiedSeconds).toBe(120);expect(next.state.progress.segments).toHaveLength(3);expect(next.state.regressionProblems).toEqual([]);
    expect(next.state.progress.segments.at(-1)!.reviews[0].changedDomains).toEqual(['replay']);
  });
  it('pending/failed retests retain credit but cannot approve the changed part',()=>{
    for(const status of ['pending','failed'] as const){const nextManifest=manifest(thirdDigest);delete nextManifest.historyAudit;
      nextManifest.id='pending-fix';nextManifest.checks=[{domain:'trial_monitor',status,evidence:[]}];
      const result=prepareFreshTrialReview({prior:adopt().state,manifest:nextManifest,sourceDigest:thirdDigest,now:now+1000});
      expect(result.afterVerifiedSeconds).toBe(60);expect(result.state.complete).toBe(false);expect(result.state.regressionProblems.join()).toContain(status);
    }
  });
  it('same-build restart preserves its identity and breaks observation continuity',()=>{
    const prior=adopt().state;prior.progress=recordFreshTrialSample(prior.progress,{segmentId:prior.currentSegmentId,at:now+1000,healthy:true,collectionHealthy:true,representative:false});
    const nextManifest=manifest();delete nextManifest.historyAudit;nextManifest.id='same-build-reviewed-restart';
    const next=prepareFreshTrialReview({prior,manifest:nextManifest,sourceDigest:newDigest,now:now+2000});
    expect(next.segmentId).toBe(prior.currentSegmentId);expect(next.state.segmentStartedAt).toBe(prior.segmentStartedAt);
    expect(next.state.progress.segments.at(-1)!.lastSample).toBe(null);expect(next.afterVerifiedSeconds).toBe(60);
  });
  it('rejects a repeated retrospective import and a tampered cumulative counter',()=>{
    const prior=adopt().state;
    expect(()=>prepareFreshTrialReview({prior,manifest:manifest(),sourceDigest:newDigest,now:now+2000,history:history()})).toThrow('already adopted');
    const nextManifest=manifest();delete nextManifest.historyAudit;nextManifest.id='later';
    expect(()=>prepareFreshTrialReview({prior:{...prior,verifiedSeconds:120},manifest:nextManifest,sourceDigest:newDigest,now:now+2000})).toThrow('reconcile');
  });
  it('explicit forward adoption preserves the exact69minute20second credit and original accounting policy',()=>{
    const saved=history();saved.totalSeconds=4160.051;saved.segments[0].intervals=[[start,start+4160051]];saved.segments[0].representativeAt=start+60_000;
    const longNow=start+5000000,old={...legacy(),verifiedSeconds:4160.051},adopted=prepareFreshTrialReview({prior:old,manifest:manifest(),sourceDigest:newDigest,now:longNow,history:saved}).state;
    const nextManifest=manifest(thirdDigest);delete nextManifest.historyAudit;nextManifest.id='explicit-forward-policy';
    nextManifest.forwardScope={version:1,policy:'forward_activity_v1',blockNumber:129500000,blockHash:'0x'+'1'.repeat(64),occurredAt:new Date(longNow).toISOString(),activatedAt:new Date(longNow+1000).toISOString(),captureRevision:'17'};
    nextManifest.financialRuntimeBinding={version:1,baselinePath:'.cache/fresh/private/forward-validation-20261024/before-source.json',sha256:FRESH_TRIAL_FINANCIAL_BASELINE_SHA256,runtimeSourceDigest:FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE};
    const before=structuredClone(adopted.progress),next=prepareFreshTrialReview({prior:adopted,manifest:nextManifest,sourceDigest:thirdDigest,now:longNow+2000});
    expect(next.beforeVerifiedSeconds).toBe(4160.051);expect(next.afterVerifiedSeconds).toBe(4160.051);expect(next.state.validationPolicy).toBe('traded_positions_v1');expect(next.state.version).toBe(4);
    expect(next.state.validationScopePolicy).toBe('forward_activity_v1');expect(next.state.forwardScope).toEqual(nextManifest.forwardScope);expect(next.state.financialRuntimeBinding).toEqual(nextManifest.financialRuntimeBinding);
    expect(next.state.progress.segments.slice(0,before.segments.length)).toEqual(before.segments);expect(next.state.complete).toBe(false);
    // Later small monitor fixes carry the exact checkpoint and runtime proof.
    const laterManifest=manifest('d'.repeat(64));delete laterManifest.historyAudit;laterManifest.id='small-forward-monitor-fix';
    const later=prepareFreshTrialReview({prior:next.state,manifest:laterManifest,sourceDigest:laterManifest.sourceDigest,now:longNow+3000});expect(later.afterVerifiedSeconds).toBe(4160.051);expect(later.state.forwardScope).toEqual(next.state.forwardScope);expect(later.state.financialRuntimeBinding).toEqual(next.state.financialRuntimeBinding);
    for(const change of[{forwardScope:{...next.state.forwardScope,blockNumber:129500001}},{forwardScope:{...next.state.forwardScope,blockHash:'0x'+'2'.repeat(64)}},{forwardScope:null},{financialRuntimeBinding:null},{validationScopePolicy:'global'}]){
      expect(()=>prepareFreshTrialReview({prior:next.state,manifest:{...laterManifest,...change}as any,sourceDigest:laterManifest.sourceDigest,now:longNow+3000})).toThrow();
    }
  });
  it('rejects silent/legacy forward adoption and invalid checkpoint or financial source bindings',()=>{
    const next=manifest();next.forwardScope={version:1,policy:'forward_activity_v1',blockNumber:1,blockHash:'0x'+'1'.repeat(64),occurredAt:new Date(now-1000).toISOString(),activatedAt:new Date(now).toISOString(),captureRevision:'1'};
    expect(()=>prepareFreshTrialReview({prior:legacy(),manifest:next,sourceDigest:newDigest,now,history:history()})).toThrow('explicit');
    const prior=adopt().state,forward={...next};delete forward.historyAudit;
    expect(()=>prepareFreshTrialReview({prior,manifest:forward,sourceDigest:newDigest,now:now+1})).toThrow('explicit');
    forward.financialRuntimeBinding={version:1,baselinePath:'baseline.json',sha256:FRESH_TRIAL_FINANCIAL_BASELINE_SHA256,runtimeSourceDigest:'b'.repeat(64)};
    expect(()=>prepareFreshTrialReview({prior,manifest:forward,sourceDigest:newDigest,now:now+1})).toThrow('runtime');
    forward.financialRuntimeBinding.runtimeSourceDigest=FRESH_TRIAL_FINANCIAL_RUNTIME_SOURCE;forward.forwardScope={...forward.forwardScope!,captureRevision:'01'};
    expect(()=>prepareFreshTrialReview({prior,manifest:forward,sourceDigest:newDigest,now:now+1})).toThrow('checkpoint');
    const silent={...prior,forwardScope:next.forwardScope};const plain=manifest();delete plain.historyAudit;
    expect(()=>prepareFreshTrialReview({prior:silent,manifest:plain,sourceDigest:newDigest,now:now+1})).toThrow('Unreviewed');
  });
});
