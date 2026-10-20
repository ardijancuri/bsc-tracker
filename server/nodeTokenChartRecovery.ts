import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { pool } from './db.js';
import { gmgnRequest } from './gmgnApi.js';
import { chartIntervals, historicalImportRetry, importHistoricalChartPage } from './nodeChartImport.js';
import { nodeMarketService } from './nodeMarket.js';
import { nonStockTokenSql } from './stockToken.js';
import { publicTokenEvidenceSql } from './nodeMarketReadSql.js';

type Db = Pick<Pool, 'query'>;
export interface TokenChartRecoveryState { pending: boolean; retryAfterMs?: number; reason?: string; coolingDown?: boolean }
/** Fixed 1,000-candle segments coalesce repeated visitors and survive retries.
 * The cutoff is the durable migration boundary, never a request-time quote. */
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
export function createTokenChartRecovery({ db = pool, market = nodeMarketService, request = gmgnRequest, now = Date.now }: {
  db?: Db; market?: Pick<typeof nodeMarketService, 'importObservations'>; request?: typeof gmgnRequest; now?: () => number;
} = {}) {
  const eligible = (token: string) => db.query(`SELECT 1 FROM tokens v WHERE v.address=$1 AND ${nonStockTokenSql()} AND ${publicTokenEvidenceSql()}`, [token]);
  async function requestWindow(token: string, options: { from: number; to: number; seconds: number; lastKnownTradeAt?: number }): Promise<TokenChartRecoveryState> {
    if (!/^0x[0-9a-f]{40}$/.test(token)) throw new Error('invalid_market_address');
    if (!(await eligible(token)).rowCount) return { pending: false };
    const cutoff = (await db.query(`SELECT b.timestamp FROM worker_state s JOIN node_evidence_blocks b
      ON b.block_number=(s.value->>'blockNumber')::bigint AND b.block_hash=s.value->>'blockHash' WHERE s.key='node_capture_boundary'`)).rows[0];
    if (!cutoff) return { pending: false, reason: 'historical_boundary_unavailable' };
    let to = Math.min(options.to, Date.parse(cutoff.timestamp), now()),from=options.from;
    // A dormant older token with no saved bars needs its actual historical
    // market window, not an empty request for the last day. Trade time chooses
    // a window only; all candles still come from genuine market observations.
    if(Number.isFinite(options.lastKnownTradeAt)&&options.lastKnownTradeAt!<from) {
      to=Math.min(to,options.lastKnownTradeAt!+6*3600_000);
      from=Math.max(1,to-(options.to-options.from));
    }
    if (to <= from) return { pending: false };
    const windows = historicalChartSegments(from, to, options.seconds);
    if (!windows.length) return { pending: false };
    const rows = (await db.query(`INSERT INTO node_import_chart_jobs(token_address,resolution,from_at,to_at,cursor_at,expires_at)
      SELECT $1,$2,w.from_at,w.to_at,w.to_at,clock_timestamp()+interval '2 minutes'
      FROM jsonb_to_recordset($3::jsonb) w(from_at timestamptz,to_at timestamptz)
      ON CONFLICT(token_address,resolution,from_at,to_at) DO UPDATE SET selected_at=clock_timestamp(),expires_at=clock_timestamp()+interval '2 minutes'
      RETURNING completed_at,last_error,next_attempt_at`, [token, options.seconds, JSON.stringify(windows.map(w => ({ from_at: w.from, to_at: w.to })))])).rows;
    const pending = rows.filter(row => !row.completed_at);
    const delayed = pending.filter(row => row.last_error && Date.parse(row.next_attempt_at) > now());
    const coolingDown = delayed.some(row => /provider|cooldown|rate_limit/.test(row.last_error));
    return { pending: pending.length > 0, ...(delayed.length ? { retryAfterMs: Math.max(1500, Math.min(600_000, Math.min(...delayed.map(row => Date.parse(row.next_attempt_at) - now())))),
      reason: delayed[0].last_error, coolingDown } : pending.length ? { retryAfterMs: 1500 } : {}) };
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
  return { requestWindow, tick };
}
export const tokenChartRecovery = createTokenChartRecovery();
