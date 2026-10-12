import { createHash } from 'node:crypto';
import { pool } from './db.js';
import { MarketProviderDeferred, type GeckoPriority } from './geckoApi.js';

type Priority = GeckoPriority | (() => GeckoPriority);
type Query = (sql: string, values: unknown[]) => Promise<{ rows: { delay: number }[] }>;
const priorityOf = (priority: Priority) => typeof priority === 'function' ? priority() : priority;
// Free accounts allow five weighted units/second. Use two, without bursts,
// across token history, replay history, and the worker's wallet-profit calls.
const unitSpacingMs = 500;
const budgetKey = (apiKey: string) => `gmgn_api_budget:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;

export class GmgnHttpError extends Error {
  constructor(readonly status: number) { super(`GMGN request failed: HTTP ${status}`); }
}

/** Bound both queue residence and network work; cancelled queued jobs never dispatch. */
export function createGmgnQueue<T>() {
  type Entry = { priority: Priority; run: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; signal: AbortSignal; abort: () => void };
  const waiting: Entry[] = [];
  let active = false;
  const rank = { chart: 0, sparkline: 1, metadata: 2 };
  const dispatch = async () => {
    if (active || !waiting.length) return;
    active = true;
    waiting.sort((a, b) => rank[priorityOf(a.priority)] - rank[priorityOf(b.priority)]);
    const next = waiting.shift()!;
    try { if (next.signal.aborted) throw next.signal.reason; next.resolve(await next.run()); }
    catch (error) { next.reject(error); }
    finally { next.signal.removeEventListener('abort', next.abort); active = false; void dispatch(); }
  };
  return (priority: Priority, signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (waiting.length >= 32 || priorityOf(priority) === 'metadata' && (active || waiting.length)) return Promise.reject(new MarketProviderDeferred('busy', 1500));
    return new Promise((resolve, reject) => {
      const entry: Entry = { priority, signal, run, resolve, reject, abort: () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason);
      } };
      signal.addEventListener('abort', entry.abort, { once: true });
      waiting.push(entry); void dispatch();
    });
  };
}

export async function reserveGmgnSlot(apiKey: string, weight: 2 | 3, priority: GeckoPriority, query: Query = (sql, values) => pool.query(sql, values)) {
  const spacing = weight * unitSpacingMs;
  const result = await query(`WITH clock AS (
      SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms
    ), slot AS (
      INSERT INTO worker_state(key,value,updated_at)
      SELECT $1,jsonb_build_object('nextAt',ms+$2::bigint,'pausedUntil',0),now() FROM clock
      ON CONFLICT(key) DO UPDATE SET value=jsonb_set(worker_state.value,'{nextAt}',
        to_jsonb(greatest(COALESCE((worker_state.value->>'nextAt')::bigint,0),(SELECT ms FROM clock))+$2::bigint)),updated_at=now()
      WHERE COALESCE((worker_state.value->>'pausedUntil')::bigint,0)<=(SELECT ms FROM clock)
        AND COALESCE((worker_state.value->>'nextAt')::bigint,0)<=(SELECT ms FROM clock)+$3::bigint
      RETURNING (value->>'nextAt')::bigint AS next
    ) SELECT greatest(0,next-$2::bigint-ms)::integer AS delay FROM slot CROSS JOIN clock`,
  [budgetKey(apiKey), spacing, priority === 'metadata' ? 0 : 1500]);
  if (result.rows.length) return result.rows[0].delay;
  const pause = await query(`SELECT greatest(0,COALESCE((value->>'pausedUntil')::bigint,0)
    -floor(extract(epoch FROM clock_timestamp())*1000)::bigint)::integer AS delay
    FROM worker_state WHERE key=$1`, [budgetKey(apiKey)]);
  const delay = Number(pause.rows[0]?.delay) || 0;
  throw new MarketProviderDeferred(delay > 0 ? 'rate_limited' : 'busy', delay || spacing);
}

export function gmgnRetryMs(headers: Headers, body: any, now = Date.now()) {
  // Official reset values are Unix seconds. Accept milliseconds defensively.
  const resetValues = [headers.get('X-RateLimit-Reset'), body?.reset_at].map(value => {
    const number = value == null || value === '' ? NaN : Number(value);
    return number >= 1e12 ? number : number * 1000;
  });
  const retry = headers.get('Retry-After');
  const retryNumber = retry ? Number(retry) : NaN;
  const retryUntil = Number.isFinite(retryNumber) ? now + retryNumber * 1000 : retry ? Date.parse(retry) : NaN;
  const until = Math.max(...[...resetValues, retryUntil].filter(Number.isFinite));
  return Number.isFinite(until) && until > now ? Math.min(600_000, Math.max(1000, until - now)) : 60_000;
}

export interface GmgnRequestOptions {
  apiKey: string; weight?: 2 | 3; priority?: Priority; signal?: AbortSignal; timeoutMs?: number;
  method?: 'GET' | 'POST'; body?: unknown;
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

/** All callers use the same hashed-key DB row, including separate app/worker processes. */
export function createGmgnRequester({ query = (sql, values) => pool.query(sql, values), fetcher = fetch, now = Date.now }:
  { query?: Query; fetcher?: typeof fetch; now?: () => number } = {}) {
  const enqueue = createGmgnQueue<any>();
  return async (url: URL, options: GmgnRequestOptions): Promise<any> => {
    if (url.origin !== 'https://openapi.gmgn.ai' || url.username || url.password || !url.pathname.startsWith('/v1/')) throw new Error('Invalid GMGN API URL');
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error('GMGN API key is not configured');
    const priority = options.priority ?? 'chart';
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 20_000)]) : AbortSignal.timeout(options.timeoutMs ?? 20_000);
    return enqueue(priority, signal, async () => {
      const delay = await cancellable(reserveGmgnSlot(apiKey, options.weight ?? 2, priorityOf(priority), query), signal);
      if (delay) await cancellable(new Promise(resolve => setTimeout(resolve, delay)), signal);
      signal.throwIfAborted();
      const pause = await cancellable(query(`SELECT (value->>'pausedUntil')::bigint-floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS delay
        FROM worker_state WHERE key=$1 AND (value->>'pausedUntil')::bigint>floor(extract(epoch FROM clock_timestamp())*1000)::bigint`, [budgetKey(apiKey)]), signal);
      if (pause.rows.length) throw new MarketProviderDeferred('rate_limited', Number(pause.rows[0].delay));
      const response = await fetcher(url, { method: options.method ?? 'GET', headers: {
        Accept: 'application/json', 'X-APIKEY': apiKey, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      let body: any;
      try { body = await response.json(); } catch { /* HTTP error bodies are not necessarily JSON. */ }
      const rateLimited = response.status === 429 || Number(body?.code) === 429;
      const unauthorized = [401, 403].includes(response.status) || [401, 403].includes(Number(body?.code));
      if (rateLimited || unauthorized) {
        const retryAfterMs = rateLimited ? gmgnRetryMs(response.headers, body, now()) : 300_000;
        await query(`UPDATE worker_state SET value=jsonb_set(value,'{pausedUntil}',to_jsonb(
          greatest(COALESCE((value->>'pausedUntil')::bigint,0),floor(extract(epoch FROM clock_timestamp())*1000)::bigint+$2::bigint))),updated_at=now()
          WHERE key=$1`, [budgetKey(apiKey), retryAfterMs]);
        if (rateLimited) throw new MarketProviderDeferred('rate_limited', retryAfterMs);
        throw new GmgnHttpError(response.status === 200 ? Number(body.code) : response.status);
      }
      if (!response.ok) throw new GmgnHttpError(response.status);
      if (body?.code !== 0) throw new Error('GMGN returned an invalid API response');
      return body;
    });
  };
}
export const gmgnRequest = createGmgnRequester();
