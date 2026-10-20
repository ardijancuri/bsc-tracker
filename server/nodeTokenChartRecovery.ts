import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { pool } from './db.js';
import { gmgnRequest } from './gmgnApi.js';
import { chartIntervals, historicalImportRetry, importHistoricalChartPage } from './nodeChartImport.js';
import { nodeMarketCoverageComplete,nodeMarketService } from './nodeMarket.js';
import { nonStockTokenSql } from './stockToken.js';
import { publicTokenEvidenceSql } from './nodeMarketReadSql.js';
import type { NodeMarketChart } from '../shared/nodeMarket.js';
import { TRUSTED_QUOTE_FEEDS } from './nodeMarketProtocols.js';

type Db = Pick<Pool, 'query'>;
export interface TokenChartRecoveryState { pending: boolean; retryAfterMs?: number; reason?: string; coolingDown?: boolean; exhausted?: boolean }
/** Fixed 1,000-candle segments coalesce repeated visitors and survive retries.
 * Callers bound registered history by durable capture/market checkpoints.
 * Unregistered markets additionally allow only completed, confirmed history
 * at least five minutes old; a request-time quote never defines coverage. */
export function historicalChartSegments(from: number, to: number, seconds: number) {
  const step = seconds * 1000, width = step * 1000, end = Math.floor(to / step) * step;
  if (!Object.values(chartIntervals).includes(seconds as never) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to <= from) throw new Error('import_chart_window_invalid');
  const result: { from: string; to: string }[] = [];
  for (let start = Math.floor(from / width) * width; start < end; start += width) {
    if (result.length >= 4) throw new Error('import_chart_window_too_large');
    result.push({ from: new Date(start).toISOString(), to: new Date(Math.min(start + width, end)).toISOString() });
  }
  return result;
}
/** Only absent coverage is recoverable work. A covered interval with no swaps
 * is legitimate inactivity, not a request to manufacture minute candles. */
export function uncoveredChartWindows(from:number,to:number,coverage:{from:string;to:string}[],options:{seconds:number;maxWindows?:number;maxSpanMs?:number;includePartialBuckets?:boolean}) {
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)return [];
  const step=options.seconds*1000,width=options.maxSpanMs??step*1000;
  const ranges=coverage.map(row=>({from:Math.max(from,Date.parse(row.from)),to:Math.min(to,Date.parse(row.to))}))
    .filter(row=>Number.isFinite(row.from)&&Number.isFinite(row.to)&&row.to>row.from).sort((a,b)=>a.from-b.from);
  const gaps:{from:number;to:number}[]=[];let cursor=from;
  for(const range of ranges){if(range.from>cursor+3000)gaps.push({from:cursor,to:range.from});cursor=Math.max(cursor,range.to);}
  if(cursor<to-3000)gaps.push({from:cursor,to});
  return gaps.filter(gap=>options.includePartialBuckets||gap.to-gap.from>=step).reverse().slice(0,options.maxWindows??2)
    .map(gap=>options.includePartialBuckets?{from:Math.floor(gap.from/step)*step,to:Math.ceil(gap.to/step)*step}:gap)
    .map(gap=>({from:Math.max(gap.from,gap.to-width),to:gap.to}));
}
const time = (value: string | Date) => value instanceof Date ? value.getTime() : Date.parse(value);
/** Missing historical precision can survive successful raw-log collection.
 * Provider recovery replaces only that unavailable projection, never its raw
 * canonical evidence or an ordinary pending current decoder. */
export function historicalFailureChartWindows(from:number,to:number,failures:{from:string;to:string}[],coverage:NodeMarketChart['coverage'],seconds:number,exactWindow=false) {
  const imported = coverage.filter(row=>row.source==='imported');
  const windows=failures.flatMap(failure=>uncoveredChartWindows(Math.max(from,Date.parse(failure.from)),Math.min(to,Date.parse(failure.to)),imported,
    {seconds,maxWindows:2,includePartialBuckets:exactWindow}));
  const unique=new Map(windows.sort((a,b)=>b.to-a.to).map(window=>[`${window.from}:${window.to}`,window]));
  return [...unique.values()].slice(0,2);
}
export function createTokenChartRecovery({ db = pool, market = nodeMarketService, request = gmgnRequest, now = Date.now }: {
  db?: Db; market?: Pick<typeof nodeMarketService, 'importObservations'|'requestHistoryWindow'>; request?: typeof gmgnRequest; now?: () => number;
} = {}) {
  const eligible = (token: string) => db.query(`SELECT 1 FROM tokens v WHERE v.address=$1 AND ${nonStockTokenSql()} AND ${publicTokenEvidenceSql()}`, [token]);
  async function enqueueWindow(token:string,from:number,to:number,seconds:number):Promise<TokenChartRecoveryState> {
    if(to<=from)return {pending:false};
    const windows=historicalChartSegments(from,to,seconds);
    if(!windows.length)return {pending:false};
    const rows=(await db.query(`INSERT INTO node_import_chart_jobs(token_address,resolution,from_at,to_at,cursor_at,expires_at)
      SELECT $1,$2,w.from_at,w.to_at,w.to_at,clock_timestamp()+interval '2 minutes'
      FROM jsonb_to_recordset($3::jsonb) w(from_at timestamptz,to_at timestamptz)
      ON CONFLICT(token_address,resolution,from_at,to_at) DO UPDATE SET selected_at=clock_timestamp(),expires_at=clock_timestamp()+interval '2 minutes'
      RETURNING completed_at,last_error,next_attempt_at`,[token,seconds,JSON.stringify(windows.map(window=>({from_at:window.from,to_at:window.to})))])).rows;
    const pending=rows.filter(row=>!row.completed_at),delayed=pending.filter(row=>row.last_error&&time(row.next_attempt_at)>now());
    return {pending:pending.length>0,exhausted:rows.length>0&&!pending.length,
      ...(delayed.length?{retryAfterMs:Math.max(1500,Math.min(600_000,Math.min(...delayed.map(row=>time(row.next_attempt_at)-now())))),
        reason:delayed[0].last_error,coolingDown:delayed.some(row=>/provider|cooldown|rate_limit/.test(row.last_error))}:pending.length?{retryAfterMs:1500}:{})};
  }
  async function requestWindow(token: string, options: { from: number; to: number; seconds: number; lastKnownTradeAt?: number;exactWindow?:boolean }): Promise<TokenChartRecoveryState> {
    if (!/^0x[0-9a-f]{40}$/.test(token)) throw new Error('invalid_market_address');
    if (!(await eligible(token)).rowCount) return { pending: false };
    const cutoff = (await db.query(`SELECT LEAST(GREATEST(b.timestamp,COALESCE((SELECT min(COALESCE(proof.timestamp,m.discovered_at)) FROM node_markets m
      LEFT JOIN node_evidence_blocks proof ON proof.block_number=m.authenticated_at_block AND proof.block_hash=m.authenticated_block_hash
      WHERE m.token_address=$1),CASE WHEN NOT EXISTS(SELECT 1 FROM node_markets WHERE token_address=$1)
        THEN $2::timestamptz-interval '5 minutes' ELSE b.timestamp END)),COALESCE((SELECT head.timestamp FROM worker_state state JOIN node_evidence_blocks head
        ON head.block_number=(state.value->>'blockNumber')::bigint AND head.block_hash=state.value->>'blockHash'
        WHERE state.key='node_collection'),b.timestamp)) AS timestamp,
        COALESCE((SELECT head.timestamp FROM worker_state state JOIN node_evidence_blocks head
          ON head.block_number=(state.value->>'blockNumber')::bigint AND head.block_hash=state.value->>'blockHash'
          WHERE state.key='node_collection'),b.timestamp) AS confirmed_to,
        NOT EXISTS(SELECT 1 FROM node_markets WHERE token_address=$1) AS unregistered
      FROM worker_state s JOIN node_evidence_blocks b ON b.block_number=(s.value->>'blockNumber')::bigint
      AND b.block_hash=s.value->>'blockHash' WHERE s.key='node_capture_boundary'`,[token,new Date(now())])).rows[0];
    if (!cutoff) return { pending: false, reason: 'historical_boundary_unavailable' };
    let to = Math.min(options.to, Date.parse(cutoff.timestamp), now()),from=options.from;
    // A dormant older token with no saved bars needs its actual historical
    // market window, not an empty request for the last day. Trade time chooses
    // a window only; all candles still come from genuine market observations.
    if(!options.exactWindow&&Number.isFinite(options.lastKnownTradeAt)&&options.lastKnownTradeAt!<from) {
      to=Math.min(to,options.lastKnownTradeAt!+6*3600_000);
      from=Math.max(1,to-(options.to-options.from));
    }
    if(options.exactWindow){const step=options.seconds*1000;
      const completedBefore=cutoff.unregistered?now()-5*60_000:now();
      from=Math.floor(from/step)*step;to=Math.min(Math.ceil(to/step)*step,Math.floor(Math.min(completedBefore,time(cutoff.confirmed_to))/step)*step);}
    if (to <= from) return { pending: false };
    return enqueueWindow(token,from,to,options.seconds);
  }
  async function requestChart(token:string,chart:NodeMarketChart,options:{lastKnownTradeAt?:number;exactWindow?:boolean}={}):Promise<TokenChartRecoveryState> {
    if(!/^0x[0-9a-f]{40}$/.test(token))throw new Error('invalid_market_address');
    if(!(await eligible(token)).rowCount)return {pending:false};
    const checkpoints=(await db.query(`SELECT s.key,b.timestamp,b.block_number::text FROM worker_state s JOIN node_evidence_blocks b
      ON b.block_number=(s.value->>'blockNumber')::bigint AND b.block_hash=s.value->>'blockHash'
      WHERE s.key IN('node_capture_boundary','node_collection')`)).rows;
    const cutoff=checkpoints.find(row=>row.key==='node_capture_boundary');
    if(!cutoff)return {pending:false,reason:'historical_boundary_unavailable'};
    // A token market first discovered after application capture began still
    // has an onboarding history gap. Ordinary node logs can outlive historical
    // state/precision proofs; the global wallet boundary cannot certify that
    // uncaptured earlier market. Imports remain confined to that bootstrap.
    const discovered=(await db.query(`SELECT count(*)::int AS markets,min(COALESCE(proof.timestamp,m.discovered_at)) AS timestamp FROM node_markets m
      LEFT JOIN node_evidence_blocks proof ON proof.block_number=m.authenticated_at_block AND proof.block_hash=m.authenticated_block_hash
      WHERE m.token_address=$1`,[token])).rows[0];
    const head=checkpoints.find(row=>row.key==='node_collection');
    // Global wallet collection does not establish market coverage for a token
    // whose market has never been registered. Its older uncovered chart is
    // still onboarding history. Leave the recent five minutes and registered
    // repair/unsupported markets to the ordinary node pipeline.
    const marketBoundary=discovered?.markets===0?now()-5*60_000:discovered?.timestamp?time(discovered.timestamp):0;
    const boundary=Math.min(now(),Date.parse(head?.timestamp??cutoff.timestamp),Math.max(Date.parse(cutoff.timestamp),marketBoundary)),
      from=Date.parse(chart.from),to=Math.min(Date.parse(chart.to),now());
    // Loaded full-history pages can have an internal hole days before the
    // default recent window. Recover that hole rather than repeatedly asking
    // for the already-completed newest provider page.
    const provider:TokenChartRecoveryState[]=[];
    if(!options.exactWindow&&!chart.bars.length&&Number.isFinite(options.lastKnownTradeAt)&&options.lastKnownTradeAt!<from)
      provider.push(await requestWindow(token,{from,to,seconds:chart.intervalSeconds,...options}));
    else for(const window of uncoveredChartWindows(from,Math.min(to,boundary),chart.coverage,{seconds:chart.intervalSeconds,maxWindows:2,includePartialBuckets:options.exactWindow}))
      provider.push(await requestWindow(token,{...window,seconds:chart.intervalSeconds,exactWindow:options.exactWindow}));
    const nodeTo=head?Math.min(to,Date.parse(head.timestamp)):Math.min(to,chart.bars.length?Date.parse(chart.bars.at(-1)!.timestamp)+chart.intervalSeconds*1000:boundary);
    const nodeFrom=Math.max(from,boundary);
    // Failed historical metadata jobs are explicit evidence that the original
    // block-specific projection was missed. Require both a prior historical
    // failure and missing exact proofs beyond the node's state window; age or
    // a temporary RPC failure alone must not turn new node work into imports.
    const failures=head?(await db.query(`SELECT from_at,to_at FROM node_market_history_jobs WHERE token_address=$1
        AND last_error='pruned_market_range' AND to_at>$2::timestamptz AND from_at<$3::timestamptz
      UNION ALL SELECT date_trunc('minute',min(l.timestamp)),date_trunc('minute',max(l.timestamp))+interval '1 minute'
        FROM node_markets m JOIN node_market_raw_logs l ON l.market_id=m.id
        JOIN node_evidence_blocks canonical ON canonical.block_number=l.block_number AND canonical.block_hash=l.block_hash AND canonical.timestamp=l.timestamp
        JOIN node_evidence_metadata_jobs job ON job.block_number=l.block_number AND job.block_hash=l.block_hash AND job.timestamp=l.timestamp
        WHERE m.token_address=$1 AND m.status<>'unsupported' AND l.decode_status IN('pending','missing_quote')
          AND l.timestamp BETWEEN $2::timestamptz AND $3::timestamptz AND l.timestamp<$5::timestamptz-interval '5 minutes'
          AND l.block_number<$4::bigint-128 AND job.attempts>0
          AND job.last_error IN('historical_token_metadata_unavailable','historical_feed_evidence_unavailable','historical_quote_evidence_unavailable')
          AND (m.token0=ANY(job.tokens) OR m.token1=ANY(job.tokens))
          AND (m.token0=ANY(job.tokens) AND NOT EXISTS(SELECT 1 FROM node_market_token_evidence p WHERE p.token_address=m.token0 AND p.block_hash=l.block_hash)
            OR m.token1=ANY(job.tokens) AND NOT EXISTS(SELECT 1 FROM node_market_token_evidence p WHERE p.token_address=m.token1 AND p.block_hash=l.block_hash)
            OR job.last_error IN('historical_feed_evidence_unavailable','historical_quote_evidence_unavailable')
              AND NOT EXISTS(SELECT 1 FROM node_market_feed_evidence f JOIN node_evidence_blocks b ON b.block_number=f.block_number AND b.block_hash=f.block_hash AND b.timestamp=f.timestamp
                WHERE f.quote_address=m.quote_address AND f.feed_address=($6::jsonb->m.quote_address->>'feed') AND f.feed_description=($6::jsonb->m.quote_address->>'description')
                  AND f.block_number<=l.block_number AND f.timestamp BETWEEN l.timestamp-interval '2 minutes' AND l.timestamp)
              AND NOT EXISTS(SELECT 1 FROM node_market_quote_evidence q JOIN node_evidence_blocks b ON b.block_number=q.block_number AND b.block_hash=q.block_hash AND b.timestamp=q.timestamp
                WHERE q.quote_address=m.quote_address AND q.schema_version=1 AND q.block_number<=l.block_number AND q.timestamp BETWEEN l.timestamp-interval '2 minutes' AND l.timestamp))
        HAVING count(*)>0`,[token,new Date(from),new Date(nodeTo),head.block_number,new Date(now()),JSON.stringify(TRUSTED_QUOTE_FEEDS)])).rows.map(row=>({from:new Date(row.from_at).toISOString(),to:new Date(row.to_at).toISOString()})):[];
    for(const window of historicalFailureChartWindows(from,nodeTo,failures,chart.coverage,chart.intervalSeconds,options.exactWindow)) {
      const step=chart.intervalSeconds*1000,ending=options.exactWindow?Math.min(window.to,Math.floor(Math.min(now(),time(head.timestamp))/step)*step):window.to;
      provider.push(await enqueueWindow(token,window.from,ending,chart.intervalSeconds));
    }
    const nodeWindows=uncoveredChartWindows(nodeFrom,nodeTo,[...chart.coverage,...failures],{seconds:chart.intervalSeconds,maxWindows:1,maxSpanMs:30*60_000});
    // Collection coverage and decoded OHLC are separate. Persisted undecoded
    // swaps need the same selected-window priority even when logs are captured.
    if(nodeTo>nodeFrom){
      // Exclude completed projections before selecting one row. Preserved raw
      // logs from an older imported interval must not hide a later node repair.
      const skipped=[...failures,...chart.coverage.filter(range=>range.source==='imported')];
      const pending=(await db.query(`SELECT l.timestamp AS first FROM node_market_raw_logs l JOIN node_markets m ON m.id=l.market_id
        WHERE m.token_address=$1 AND l.decode_status IN('pending','missing_quote')
          AND l.timestamp BETWEEN $2::timestamptz AND $3::timestamptz
          AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) covered(from_at timestamptz,to_at timestamptz)
            WHERE l.timestamp>=covered.from_at AND l.timestamp<covered.to_at)
        ORDER BY l.timestamp,l.block_number,l.transaction_index,l.log_index LIMIT 1`,
      [token,new Date(nodeFrom).toISOString(),new Date(nodeTo).toISOString(),JSON.stringify(skipped.map(range=>({from_at:range.from,to_at:range.to})))])).rows[0]?.first;
      if(pending){const start=Math.floor(Date.parse(pending)/(30*60_000))*30*60_000;
        nodeWindows.push({from:Math.max(nodeFrom,start),to:Math.min(nodeTo,start+30*60_000)});}
    }
    const distinct=new Map(nodeWindows.filter(window=>window.to>window.from).map(window=>[`${window.from}:${window.to}`,window]));
    for(const window of distinct.values())await market.requestHistoryWindow(token,new Date(window.from).toISOString(),new Date(window.to).toISOString(),{priority:10});
    const waiting=provider.filter(state=>state.pending),delayed=waiting.filter(state=>state.retryAfterMs);
    const retrievedEmpty=!chart.bars.length&&nodeMarketCoverageComplete(chart.from,chart.to,chart.coverage.filter(range=>range.source==='imported'));
    const retrievedAll=provider.length>0&&provider.every(state=>state.exhausted===true);
    return {pending:waiting.length>0||distinct.size>0,...((retrievedAll||retrievedEmpty)&&!waiting.length&&!distinct.size?{exhausted:true}:{}),...(waiting.some(state=>state.coolingDown)?{coolingDown:true}:{}),
      ...(delayed.length?{retryAfterMs:Math.min(...delayed.map(state=>state.retryAfterMs!)),reason:delayed.find(state=>state.reason)?.reason}
        :waiting.length||distinct.size?{retryAfterMs:1500}:{})};
  }
  async function tick() {
    const lag = (await db.query(`SELECT (value->>'headBlock')::bigint-(value->>'blockNumber')::bigint AS lag FROM worker_state WHERE key='node_collection'`)).rows[0]?.lag;
    if (lag != null && Number(lag) > 128) return { status: 'live_capture_priority' };
    const lease = randomUUID();
    const job = (await db.query(`UPDATE node_import_chart_jobs j SET lease_id=$1,lease_until=clock_timestamp()+interval '30 seconds',attempts=j.attempts+1
      WHERE (j.token_address,j.resolution,j.from_at,j.to_at) IN (SELECT q.token_address,q.resolution,q.from_at,q.to_at FROM node_import_chart_jobs q
        WHERE q.completed_at IS NULL AND q.expires_at>clock_timestamp() AND q.next_attempt_at<=clock_timestamp()
        AND (q.lease_until IS NULL OR q.lease_until<clock_timestamp()) ORDER BY q.selected_at DESC,q.to_at DESC
        LIMIT 1 FOR UPDATE OF q SKIP LOCKED) RETURNING j.*`, [lease])).rows[0];
    if (!job) return { status: 'idle' };
    const key = [job.token_address, job.resolution, job.from_at, job.to_at, lease], started = now();
    try {
      if (!(await eligible(job.token_address)).rowCount) {
        await db.query(`UPDATE node_import_chart_jobs SET expires_at=clock_timestamp(),lease_id=NULL,lease_until=NULL
          WHERE token_address=$1 AND resolution=$2 AND from_at=$3 AND to_at=$4 AND lease_id=$5`, key);
        return { status: 'skipped', reason: 'public_access_changed' };
      }
      const seconds = Number(job.resolution), step = seconds * 1000, from = Date.parse(job.from_at), cursor = Date.parse(job.cursor_at);
      const latest = Math.min(cursor - step, Math.floor(now() / step) * step - step), pageFrom = Math.max(from, latest - 999 * step);
      if (latest < pageFrom) throw new Error('import_chart_cursor_invalid');
      const page = await importHistoricalChartPage({ db, market, request, token: job.token_address, seconds, from: pageFrom, to: latest,
        importId: `token-chart:${seconds}:${from}:${Date.parse(job.to_at)}`, foreground: true, now: now() });
      const next = page.retrievalComplete ? pageFrom : page.coverageFrom;
      if (next == null || next >= cursor) throw new Error('import_chart_cursor_stalled');
      await db.query(`UPDATE node_import_chart_jobs SET cursor_at=$6,completed_at=CASE WHEN $6::timestamptz<=from_at THEN clock_timestamp() ELSE NULL END,
        next_attempt_at=clock_timestamp(),last_error=NULL,lease_id=NULL,lease_until=NULL
        WHERE token_address=$1 AND resolution=$2 AND from_at=$3 AND to_at=$4 AND lease_id=$5`, [...key, new Date(next)]);
      return { status: 'progress', cacheHit: page.cacheHit, bars: page.observations.length, durationMs: now() - started };
    } catch (error) {
      const retry = historicalImportRetry(error, job.attempts);
      await db.query(`UPDATE node_import_chart_jobs SET next_attempt_at=clock_timestamp()+$6*interval '1 millisecond',last_error=$7,lease_id=NULL,lease_until=NULL
        WHERE token_address=$1 AND resolution=$2 AND from_at=$3 AND to_at=$4 AND lease_id=$5`, [...key, retry.retryAfterMs, retry.reason]);
      return { status: 'retry', reason: retry.reason, retryAfterMs: retry.retryAfterMs, durationMs: now() - started };
    }
  }
  return { requestWindow, requestChart, tick };
}
export const tokenChartRecovery = createTokenChartRecovery();
