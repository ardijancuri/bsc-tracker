import type {Pool} from 'pg';
import {runFreshTransferValuation} from './deferredTransferValuation.js';
import type {Rpc} from '../rpc.js';
import {runFreshCapture,expireFreshEvidence,readFreshCaptureState,findFreshCommonAncestor} from './capture.js';
import {runFreshDecode,rollbackFreshToAncestor} from './decode.js';
import {freshCurrentQuote,commitFreshCurrentQuote,freshQuoteUsd,freshQuoteFailureStatus} from './pricing.js';
import {rolloverFreshUtcDay} from './accounting.js';
import {refreshFreshRollingKolTotals} from './rolling.js';
import {WBNB} from '../launchpad.js';
import {refreshFreshBalances} from './balances.js';
import {rollbackTelegramNotifications} from '../telegramNotifications.js';
import {freshRuntimeDigest} from './runtime.js';
import {createFreshSshTrace} from './sshTrace.js';
import {runFreshRegistrationRepair} from './registration.js';
import {runFreshArtwork} from './artwork.js';
import {createFreshUrgentEvidenceCapture} from './urgentEvidence.js';
import {createFreshRecoveryBatch,type FreshRecoveryCaptureHealth} from './recoveryBatch.js';
import {runFreshV4MarketDiscovery,readFreshV4MarketIdentities} from './v4Discovery.js';
import{createFreshCurrentMarketCanonicalHash}from'./currentMarketAnchor.js';
import{createFreshUrgentTraceCapture}from'./urgentTrace.js';
import{createFreshIpcTrace}from'./ipcTrace.js';
import{readFreshQuoteRefreshStates,readFreshQuoteRefreshAnchor,observeFreshQuoteRefresh,commitFreshQuoteRefreshFailure}from'./quoteRefreshFailure.js';

const pause=(ms:number,signal:AbortSignal)=>new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,ms);signal.addEventListener('abort',finish,{once:true});if(signal.aborted)finish();});
const category=(error:unknown)=>error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[endpoint]').slice(0,140):'unavailable';
// Selected pages retain foreground priority. Recent tracker tokens and actual
// own-scope open trades share one freshness class: continuously due holdings
// must not starve a recently sold token out of the public tracker. Up to eight
// ordinary due retries retain a slot unless foreground work fills the batch.
// Ready quotes near their original expiry use that observation deadline, not
// the latest failed-attempt time. Unsupported work keeps fair attempt rotation.
export const freshQuoteWorkSql=`WITH work AS MATERIALIZED(SELECT t.address,to_jsonb(lf) AS launch_fact,
  COALESCE(j.priority,0) AS priority,COALESCE(j.updated_at,t.observed_at) AS attempted_at,
  CASE WHEN t.valuation_status='ready' AND t.observed_at<=$1::timestamptz-interval '75 seconds' THEN t.observed_at END AS ready_deadline,
  (COALESCE(t.last_trade_at>=$1::timestamptz-interval '8 hours',false) OR EXISTS(
    SELECT 1 FROM fresh.positions p JOIN fresh.accounting_scopes s ON s.id=p.scope_id AND s.active
    WHERE p.token_address=t.address AND p.quantity_q<>'0' AND EXISTS(
      SELECT 1 FROM fresh.scope_event_results r JOIN fresh.financial_events f ON f.id=r.event_id AND f.canonical
      WHERE r.scope_id=p.scope_id AND r.token_address=p.token_address AND r.tokens_trade AND f.kind IN('buy','sell')))) AS freshness_required
  FROM fresh.tokens t
  LEFT JOIN fresh.launch_facts lf ON lf.token_address=t.address AND lf.status='eligible'
  LEFT JOIN fresh.jobs j ON j.kind='quote' AND j.reference=t.address AND j.state='pending'
  WHERE t.launch_status='eligible' AND (j.id IS NOT NULL AND j.due_at<=$1 OR j.id IS NULL
    AND (t.observed_at IS NULL OR t.observed_at<$1::timestamptz-interval '30 seconds') AND (t.last_trade_at>=$1::timestamptz-interval '1 day'
      OR EXISTS(SELECT 1 FROM fresh.positions p JOIN fresh.accounting_scopes s ON s.id=p.scope_id WHERE s.active AND p.token_address=t.address AND p.quantity_q<>'0')))
 ),ranked AS(SELECT *,row_number() OVER(PARTITION BY priority>=100,freshness_required
    ORDER BY priority DESC,CASE WHEN freshness_required THEN ready_deadline END NULLS LAST,attempted_at NULLS FIRST,address) AS lane_rank FROM work),
  selected AS(SELECT * FROM ranked ORDER BY CASE WHEN priority>=100 THEN 0
    WHEN NOT freshness_required AND lane_rank<=8 THEN 1 WHEN freshness_required THEN 2 ELSE 3 END,
    priority DESC,CASE WHEN freshness_required THEN ready_deadline END NULLS LAST,attempted_at NULLS FIRST,address LIMIT 64)
  SELECT address,launch_fact FROM selected ORDER BY CASE WHEN priority>=100 THEN priority ELSE 0 END DESC,
    freshness_required DESC,priority DESC,CASE WHEN freshness_required THEN ready_deadline END NULLS LAST,attempted_at NULLS FIRST,address`;
/** Create the retry even for a first regular refresh failure. A pending future
 * job suppresses the regular stale-token path until due; foreground selection
 * may still promote it through the existing selected-token queue. */
export async function deferFreshQuoteRetry(db:Pick<Pool,'query'>,token:string,status:'quote_unavailable'|'no_liquidity'='quote_unavailable') {
  await db.query(`INSERT INTO fresh.jobs(id,kind,reference,attempts,due_at,last_error)
    VALUES('quote:'||$1,'quote',$1,1,clock_timestamp()+CASE WHEN $2='no_liquidity' THEN interval '60 seconds' ELSE interval '30 seconds' END,$2)
    ON CONFLICT(kind,reference) DO UPDATE SET state='pending',attempts=fresh.jobs.attempts+1,
      due_at=EXCLUDED.due_at,last_error=EXCLUDED.last_error,updated_at=clock_timestamp()`,[token,status]);
}
export async function runFreshWorker(db:Pool,rpc:Rpc,signal:AbortSignal) {
  if(!(await db.query(`SELECT 1 FROM fresh.checkpoints WHERE key='start'`)).rowCount)throw new Error('Initialize the empty local database with fresh:init before running capture.');
  const connection=await db.connect();
  const localSsh=process.env.FRESH_LOCAL_ONLY==='true'&&process.env.FRESH_TRACE_SSH==='1';
  const trace=localSsh?createFreshSshTrace():process.env.BSC_TRACE_IPC?createFreshIpcTrace():undefined;
  let captureHealth:FreshRecoveryCaptureHealth|undefined;
  const urgentEvidence=createFreshUrgentEvidenceCapture(db,rpc),recoveryBatch=createFreshRecoveryBatch(db,rpc,{captureHealth:()=>captureHealth});
  const urgentTrace=trace?createFreshUrgentTraceCapture(db,rpc,localSsh?createFreshSshTrace({maxQueued:0}):createFreshIpcTrace({maxQueued:0})):undefined;
  let lastQuoteAt=0;
  // One capture owner. API requests never start scanners or accounting workers.
  if(!(await connection.query('SELECT pg_try_advisory_lock(73621945) AS owned')).rows[0].owned){connection.release();throw new Error('fresh_worker_already_running');}
  if(process.env.FRESH_LOCAL_ONLY==='true')await db.query(`INSERT INTO fresh.checkpoints(key,value) VALUES('runtime:worker',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),sourceDigest:await freshRuntimeDigest()})]);
  async function loop(stage:string,delay:number,run:()=>Promise<unknown>){
    let lastReport=0,lastStatus='';
    while(!signal.aborted){const started=performance.now();try{const result=await run();if(Date.now()-lastReport>=30_000||lastStatus!=='ok'){await db.query(`INSERT INTO fresh.checkpoints(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`,[`health:${stage}`,JSON.stringify({ok:true,durationMs:Math.round(performance.now()-started),result})]);lastReport=Date.now();lastStatus='ok';}}
      catch(error){const reason=category(error);if(lastStatus!==reason||Date.now()-lastReport>=30_000){console.warn(JSON.stringify({event:'fresh_stage_failed',stage,reason}));await db.query(`INSERT INTO fresh.checkpoints(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()`,[`health:${stage}`,JSON.stringify({ok:false,reason,durationMs:Math.round(performance.now()-started)})]).catch(()=>{});lastStatus=reason;lastReport=Date.now();}}
      await pause(delay,signal);
    }
  }
  try{await Promise.all([
    loop('capture',100,async()=>{
      try{const result=await runFreshCapture(db,rpc,{limit:16,catchUpLimit:32});captureHealth=result;return result;}
      catch(error){captureHealth=undefined;if(!/parent|block_identity|reorg/.test(category(error)))throw error;
        const{checkpoint}=await readFreshCaptureState(db),ancestor=await findFreshCommonAncestor(db,rpc,checkpoint);if(!ancestor)throw new Error('reorg_beyond_repair_buffer');
        const client=await db.connect();try{await client.query('BEGIN');await rollbackTelegramNotifications(client,ancestor.blockNumber+1);const result=await rollbackFreshToAncestor(client,ancestor);await client.query('COMMIT');return{reorg:result};}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
    }),
    loop('urgent_evidence',500,()=>urgentEvidence({signal})),
    loop('urgent_trace',500,()=>urgentTrace?urgentTrace({signal}):Promise.resolve({disabled:true})),
    loop('decode',500,async()=>{const transferRevaluation=await runFreshTransferValuation(db);const result=await runFreshDecode(db,rpc,{limit:32,trace,recoveryBatch,maxNormalizeMs:3_000});if(result.receipts)await db.query("SELECT pg_notify('bscan_update','update')");
      // No relevant receipts is a complete empty block, rather than a stalled financial cursor.
      await db.query(`UPDATE fresh.checkpoints d SET block_number=c.block_number,block_hash=c.block_hash,updated_at=clock_timestamp() FROM fresh.checkpoints c WHERE d.key='decode' AND c.key='capture'
        AND d.block_number IS DISTINCT FROM c.block_number
        AND NOT EXISTS(SELECT 1 FROM fresh.recent_evidence e WHERE e.decoder_status<>'done' AND e.block_number<=c.block_number)`);return{...result,transferRevaluation,recoveryBatch:recoveryBatch.stats()};}),
    loop('prices',1000,async()=>{
      const now=new Date();
      const selected=(await db.query(freshQuoteWorkSql,[now])).rows;
      if(!selected.length&&Date.now()-lastQuoteAt<30_000)return{ready:0,failed:0};
      lastQuoteAt=Date.now();
      const marketIdentities=await readFreshV4MarketIdentities(db,selected.map(row=>row.address));
      const priorQuotes=await readFreshQuoteRefreshStates(db,selected.map(row=>row.address));
      let ready=0,failed=0;const unavailableReasons:Record<string,number>={};
      // Bounded concurrency, no price response is copied into every holder's position.
      for(let i=0;i<selected.length&&!signal.aborted;i+=4){const{block,captureRevision,canonicalHash}=await readFreshQuoteRefreshAnchor(db);
        await Promise.all(selected.slice(i,i+4).map(async row=>{const evidence=observeFreshQuoteRefresh(rpc,block);try{await commitFreshCurrentQuote(db,await freshCurrentQuote(row.address,{rpc:evidence.rpc,block,launchFact:row.launch_fact,
        canonicalHash:createFreshCurrentMarketCanonicalHash(db,{token:row.address,block,recentHash:canonicalHash}),marketIdentities:marketIdentities.get(row.address)}),{captureRevision});ready++;await db.query(`DELETE FROM fresh.jobs WHERE kind='quote' AND reference=$1`,[row.address]);}catch(error){failed++;const status=freshQuoteFailureStatus(error),reason=category(error);unavailableReasons[reason]=(unavailableReasons[reason]??0)+1;
          await commitFreshQuoteRefreshFailure(db,row.address,error,{captureRevision,block,prior:priorQuotes.get(row.address),evidence});await deferFreshQuoteRetry(db,row.address,status);}}));}
      const{block}=await readFreshQuoteRefreshAnchor(db);
      const bnbPriceUsd=await freshQuoteUsd(WBNB,{rpc,block}).catch(()=>null);
      await db.query(`INSERT INTO fresh.checkpoints(key,block_number,block_hash,value) VALUES('quote',$1,$2,$3::jsonb) ON CONFLICT(key) DO UPDATE SET block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,value=EXCLUDED.value,updated_at=clock_timestamp()`,[block.number,block.hash,JSON.stringify({bnbPriceUsd,observedAt:block.timestamp})]);
      return{ready,failed,unavailableReasons};}),
    loop('balances',5000,()=>refreshFreshBalances(db,rpc)),
    loop('rolling_pnl',1000,async()=>{const client=await db.connect();try{
      await client.query('BEGIN');const result=await refreshFreshRollingKolTotals(client,{limit:64});
      await client.query('COMMIT');if(result.updated)await db.query("SELECT pg_notify('bscan_update','update')");return result;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}),
    loop('registration',250,()=>runFreshRegistrationRepair(db,rpc,{limitBlocks:16})),
    loop('market_discovery',1000,()=>runFreshV4MarketDiscovery(db,rpc,{signal})),
    loop('artwork',5000,async()=>{
      // Optional media yields to capture/decoding. No image request or decoder
      // can hold a financial transaction or prevent the node loops progressing.
      const state=(await db.query(`SELECT c.block_number-d.block_number AS decode_lag,b.occurred_at,
        h.value->>'ok' AS capture_ok FROM fresh.checkpoints c JOIN fresh.checkpoints d ON d.key='decode'
        JOIN fresh.checkpoints h ON h.key='health:capture' JOIN fresh.recent_blocks b ON b.block_number=c.block_number AND b.block_hash=c.block_hash
        WHERE c.key='capture'`)).rows[0];
      if(!state||state.capture_ok!=='true'||Number(state.decode_lag)>32||Date.now()-new Date(state.occurred_at).getTime()>20_000)return{yielded:true};
      return runFreshArtwork(db,{signal,limit:1});
    }),
    loop('maintenance',30_000,async()=>{const client=await db.connect();try{await client.query('BEGIN');await rolloverFreshUtcDay(client);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      return expireFreshEvidence(db);}),
  ]);}finally{await connection.query('SELECT pg_advisory_unlock(73621945)');connection.release();}
}
