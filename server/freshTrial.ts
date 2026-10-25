import {mkdir,readFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {pool} from './db.js';
import {chainRpc} from './rpc.js';
import {freshRuntimeDigest} from './fresh/runtime.js';
import {freshStorageReport} from './fresh/storage.js';
import {FRESH_TRIAL_TARGET_SECONDS,FRESH_TRIAL_POLICY,FRESH_TRIAL_REPORT_VERSION,validateFreshTrialEvidence,type FreshTrialPosition} from './fresh/trialValidation.js';
import {FRESH_DECODER_VERSION} from './fresh/decode.js';
import {breakFreshTrialSampleContinuity,recordFreshTrialSample,freshTrialProgressSummary,FRESH_TRIAL_PROGRESS_POLICY,type FreshTrialProgress} from './fresh/trialProgress.js';
import {writeFreshTrialJson,withFreshTrialControlLock,assertFreshTrialMonitorStopped} from './fresh/trialProgressFiles.js';

const url=new URL(process.env.DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!=='5436'||!url.pathname.startsWith('/kollens_fresh_'))throw Error('Local fresh validation only');
const directory=path.resolve('.cache/fresh/trial');await mkdir(directory,{recursive:true});
const filename=path.join(directory,'state.json'),observations=path.join(directory,'observations.jsonl');
const sourceDigest=await freshRuntimeDigest();
const state=await withFreshTrialControlLock(directory,async()=>{
let prior:any;try{prior=JSON.parse(await readFile(filename,'utf8'));}catch{}
if(!prior?.progress||prior.version!==FRESH_TRIAL_REPORT_VERSION||prior.progressPolicy!==FRESH_TRIAL_PROGRESS_POLICY)throw Error('Use freshTrialReview to adopt audited history; legacy counters are never adopted automatically');
if(prior.monitorPid!==process.pid)assertFreshTrialMonitorStopped(prior.monitorPid);
const state=prior;
if(state.sourceDigest!==sourceDigest)throw Error('Trial source changed; record an affected-domain review with freshTrialReview, preserving earned time');
if(state.validationPolicy!==FRESH_TRIAL_POLICY||state.targetSeconds!==FRESH_TRIAL_TARGET_SECONDS)throw Error('Trial evidence policy changed; explicit review required');
const reviewedSegment=(state.progress as FreshTrialProgress).segments.find(segment=>segment.id===state.currentSegmentId);
if(!reviewedSegment||reviewedSegment.sourceDigest!==sourceDigest||reviewedSegment.startedAt!==Date.parse(state.segmentStartedAt))throw Error('Current runtime must match its immutable reviewed trial segment');
state.progress=breakFreshTrialSampleContinuity(state.progress as FreshTrialProgress,state.currentSegmentId);
state.monitorPid=process.pid;
state.complete=false;
await writeFreshTrialJson(filename,state);
return state;
});
let stopping=false;
let pendingSample:Promise<any>|null=null;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>stopping=true);
async function sample(at:number){
    const [head,checkpoints,storage,counts,rationalSize,positions,currentSourceDigest]=await Promise.all([
      chainRpc<string>('eth_blockNumber',[]),pool.query(`SELECT key,block_number::text,block_hash,value,updated_at FROM fresh.checkpoints`),
      freshStorageReport(pool),
      pool.query(`SELECT (SELECT count(*) FROM fresh.financial_events WHERE canonical)::text AS financial_events,
        (SELECT count(*) FROM fresh.financial_events e JOIN fresh.kols k ON k.wallet_address=e.wallet_address AND k.is_tracked WHERE e.canonical AND e.observed_live AND e.occurred_at>=$3 AND e.kind='buy')::text AS public_buys,
        (SELECT count(*) FROM fresh.financial_events e JOIN fresh.kols k ON k.wallet_address=e.wallet_address AND k.is_tracked WHERE e.canonical AND e.observed_live AND e.occurred_at>=$3 AND e.kind='sell')::text AS public_sells,
        (SELECT count(*) FROM fresh.positions)::text AS positions,(SELECT count(*) FROM fresh.recent_evidence)::text AS evidence,
        (SELECT count(*) FROM fresh.recent_evidence WHERE decoder_status<>'done')::text AS pending_evidence,
        (SELECT min(block_number) FROM fresh.recent_evidence WHERE decoder_status<>'done')::text AS first_pending_block,
        (SELECT extract(epoch FROM $1::timestamptz-min(created_at)) FROM fresh.recent_evidence WHERE decoder_status<>'done')::text AS oldest_pending_age_seconds,
        (SELECT count(*) FROM fresh.recent_evidence WHERE decoder_status='repair')::text AS repair_evidence,
        (SELECT count(*) FROM fresh.financial_events WHERE canonical AND kind IN('transfer_in','transfer_out') AND amount_usd IS NULL)::text AS unpriced_transfer_events,
        (SELECT count(*) FROM fresh.recent_evidence WHERE decoder_status='done' AND last_error IS NOT NULL)::text AS completed_evidence_warnings,
        (SELECT coalesce(jsonb_object_agg(reason,amount),'{}') FROM(SELECT coalesce(last_error,'unknown') reason,count(*)::int amount FROM fresh.recent_evidence WHERE decoder_status='repair' GROUP BY last_error) reasons) AS repair_reasons,
        (SELECT count(*) FROM fresh.recent_evidence WHERE decoder_status='done' AND decoder_version<$2)::text AS outdated_evidence,
        (SELECT count(*) FROM fresh.financial_events WHERE canonical AND decoder_version<$2)::text AS outdated_financial_events,
        (SELECT count(*) FROM fresh.wallets w WHERE w.decode_gap_from_block IS NOT NULL AND EXISTS(SELECT 1 FROM fresh.accounting_scopes s
          WHERE s.active AND w.address=ANY(s.wallet_addresses) AND w.decode_gap_from_block>=s.starts_block))::text AS durable_wallet_gaps,
        (SELECT count(*) FROM fresh.recent_blocks)::text AS headers,(SELECT count(*) FROM fresh.jobs)::text AS jobs,
        (SELECT count(*) FROM fresh.jobs WHERE kind='registration_capture')::text AS registration_jobs,
        (SELECT count(*) FROM fresh.launch_facts)::text AS launches,(SELECT count(*) FROM fresh.tokens)::text AS tokens`,[new Date(at),FRESH_DECODER_VERSION,new Date(state.segmentStartedAt)]),
      pool.query(`SELECT coalesce(max(greatest(length(today_realized_q),length(today_capital_q),length(today_volume_q),length(today_fee_only_q))),0)::int AS max_daily_rational_bytes FROM fresh.kols`),
      pool.query(`SELECT p.quantity_q,p.unknown_cost,p.balance_status,p.balance_quantity,p.balance_block::text,p.balance_hash,
          EXISTS(SELECT 1 FROM fresh.scope_event_results r JOIN fresh.financial_events f ON f.id=r.event_id AND f.canonical
            WHERE r.scope_id=p.scope_id AND r.token_address=p.token_address AND r.tokens_trade AND f.kind IN('buy','sell')) AS has_trades,
          e.block_number::text AS last_event_block,e.canonical AS last_event_canonical,
          p.balance_block<=c.block_number AND NOT EXISTS(SELECT 1 FROM fresh.recent_blocks b WHERE b.block_number=p.balance_block AND b.block_hash<>p.balance_hash)
            AND(EXISTS(SELECT 1 FROM fresh.recent_blocks b WHERE b.block_number=p.balance_block AND b.block_hash=p.balance_hash)
              OR p.balance_block<(SELECT min(block_number) FROM fresh.recent_blocks)) AS balance_canonical,
          t.price_usd,t.valuation_status,t.observed_at,t.observed_block::text,t.observed_hash,
          t.observed_block<=c.block_number AND NOT EXISTS(SELECT 1 FROM fresh.recent_blocks b WHERE b.block_number=t.observed_block AND b.block_hash<>t.observed_hash)
            AND(EXISTS(SELECT 1 FROM fresh.recent_blocks b WHERE b.block_number=t.observed_block AND b.block_hash=t.observed_hash)
              OR t.observed_block<(SELECT min(block_number) FROM fresh.recent_blocks)) AS quote_canonical
        FROM fresh.positions p JOIN fresh.accounting_scopes s ON s.id=p.scope_id AND s.active JOIN fresh.tokens t ON t.address=p.token_address AND t.launch_status='eligible'
        JOIN fresh.checkpoints c ON c.key='capture' LEFT JOIN fresh.financial_events e ON e.id=p.last_event_id`),
      freshRuntimeDigest()]);
    const byKey=Object.fromEntries(checkpoints.rows.map(row=>[row.key,row]));
    const validation=validateFreshTrialEvidence({now:at,confirmedHeadBlock:Number(BigInt(head)-6n),sourceDigest,currentSourceDigest,checkpoints:byKey,counts:counts.rows[0],positions:positions.rows as FreshTrialPosition[]});
    const problems=validation.problems;
    const latencies:Record<string,number>={};
    for(const endpoint of ['leaderboard','overview']){const start=performance.now();const response=await fetch(`http://127.0.0.1:${process.env.PORT??3302}/api/${endpoint}`,{signal:AbortSignal.timeout(5000)});await response.arrayBuffer();latencies[endpoint]=Math.round(performance.now()-start);if(!response.ok)problems.push(`${endpoint}_unavailable`);}
    return{at:new Date(at).toISOString(),lagBlocks:validation.captureLagBlocks,decodeLagBlocks:validation.decodeLagBlocks,
      counts:counts.rows[0],positionValidation:validation.positionValidation,latencies,storage,maxDailyRationalBytes:rationalSize.rows[0].max_daily_rational_bytes,problems};
}
while(!stopping&&!state.complete){
  const at=Date.now();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    if(pendingSample)throw Error('previous_trial_sample_pending');
    const work=sample(at);pendingSample=work;work.finally(()=>{if(pendingSample===work)pendingSample=null;}).catch(()=>{});
    const report=await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('trial_sample_deadline')),25_000);})]);
    const problems=report.problems;
    const captureValid=!problems.some((reason:string)=>['capture_lag','capture_unhealthy','trial_source_changed','stale_api_source','stale_worker_source'].includes(reason));
    const representative=Number(report.counts.public_buys)>=1&&Number(report.counts.public_sells)>=1&&Number(report.counts.tokens)>=1;
    state.progress=recordFreshTrialSample(state.progress,{segmentId:state.currentSegmentId,at,healthy:problems.length===0,collectionHealthy:captureValid,representative,problems});
    const summary=freshTrialProgressSummary(state.progress,{currentSegmentId:state.currentSegmentId,now:at,currentProblems:problems});
    state.samples++;state.failures+=problems.length||summary.regressionProblems.length?1:0;state.latest=report;
    Object.assign(state,{verifiedSeconds:summary.verifiedSeconds,collectionSeconds:summary.collectionSeconds,representative:summary.representative,
      durationComplete:summary.durationComplete,complete:summary.complete,regressionProblems:summary.regressionProblems});
    state.segmentSummary=summary.segments.map(({intervals,collectionIntervals,...segment})=>segment);
    state.acceptanceStatus=state.complete?'complete':problems.length||summary.regressionProblems.length?'blocked':'observing';
    await appendFile(observations,JSON.stringify({...report,sourceDigest,segmentId:state.currentSegmentId,regressionProblems:summary.regressionProblems})+'\n');
  }catch(error){state.progress=breakFreshTrialSampleContinuity(state.progress,state.currentSegmentId);state.failures++;state.acceptanceStatus='blocked';state.complete=false;state.latest={at:new Date(at).toISOString(),problems:[error instanceof Error?error.message.slice(0,120):'trial_unavailable']};}
  finally{clearTimeout(timer);}
  state.updatedAt=new Date().toISOString();await writeFreshTrialJson(filename,state);
  if(!state.complete&&!stopping)await new Promise(resolve=>setTimeout(resolve,60_000));
}
await pool.end();
