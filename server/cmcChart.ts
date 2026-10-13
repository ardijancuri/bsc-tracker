import { pool } from './db.js';
import { MarketProviderDeferred, marketPriorityRank, type GeckoPriority } from './geckoApi.js';
import type { ChartRange, MarketCandle, TokenChart } from '../shared/intelligence.js';

type Priority = GeckoPriority | (() => GeckoPriority);
type Query = (sql: string, values: unknown[]) => Promise<{ rows: { delay: number }[] }>;
export type CmcJsonRequest = (url: URL, signal: AbortSignal) => Promise<any>;
const priorityOf = (value: Priority) => typeof value === 'function' ? value() : value;
const spacingMs = 6500;
const budgetKey = 'coinmarketcap_public_api_budget';
const endpoint = 'https://pro-api.coinmarketcap.com/public-api/v1/k-line/candles';
const addressRe = /^0x[0-9a-f]{40}$/;
function validResponse(body: any): boolean {
  const code = body?.status?.error_code;
  return code != null && code !== '' && typeof code !== 'boolean' && Number(code) === 0 && Array.isArray(body?.data);
}
const windows = {
  '1m': { seconds: 86_400, step: 60, interval: '1min', resolution: '1m', limit: 1000 },
  '24h': { seconds: 86_400, step: 300, interval: '5min', resolution: '5m', limit: 288 },
  '5m': { seconds: 86_400, step: 300, interval: '5min', resolution: '5m', limit: 288 },
  '7d': { seconds: 604_800, step: 3600, interval: '1h', resolution: '1h', limit: 168 },
  '30d': { seconds: 2_592_000, step: 3600, interval: '1h', resolution: '1h', limit: 720 },
  '1h': { seconds: 2_592_000, step: 3600, interval: '1h', resolution: '1h', limit: 720 },
  '4h': { seconds: 7_776_000, step: 14_400, interval: '4h', resolution: '4h', limit: 540 },
  '1d': { seconds: 15_552_000, step: 86_400, interval: '1d', resolution: '1d', limit: 180 },
} as const;

export class CmcHttpError extends Error {
  constructor(readonly status: number) { super(`CoinMarketCap chart request failed: HTTP ${status}`); }
}

// CMC uses [open, high, low, close, volume, timestamp, traders], unlike Gecko.
// Live public responses currently use milliseconds; the reference specifies seconds.
export function parseCmcCandles(rows: unknown, since: number, until: number, step: number): MarketCandle[] {
  if (!Array.isArray(rows)) return [];
  const candles = new Map<number, MarketCandle>();
  for (const row of rows.slice(0, 1000)) {
    if (!Array.isArray(row) || row.length < 6 || row.slice(0, 6).some(v => v == null || v === '' || typeof v === 'boolean')) continue;
    const [open, high, low, close, volume, rawTime] = row.slice(0, 6).map(Number);
    const time = rawTime >= 1e12 ? rawTime / 1000 : rawTime;
    if (![time, open, high, low, close, volume].every(Number.isFinite) || !Number.isInteger(time) || time % step !== 0 ||
      time < since || time > until || Math.min(open, high, low, close) <= 0 || volume < 0 ||
      low > Math.min(open, close) || high < Math.max(open, close)) continue;
    candles.set(time, { time, open, high, low, close, volume });
  }
  return [...candles.values()].sort((a, b) => a.time - b.time);
}

/** Latest history is keyless. Explicit from/to history requires a paid plan. */
export async function fetchCmcMarketCandles(address: string, period: ChartRange,
  request: CmcJsonRequest = (url, signal) => cmcRequest(url, { signal }), now = Date.now(),
  signal = AbortSignal.timeout(20_000), options: { limitCap?: number } = {}): Promise<TokenChart | null> {
  if (!addressRe.test(address)) throw new Error('Invalid chart address');
  const settings = windows[period];
  if (!settings || !Number.isFinite(now)) throw new Error('Invalid chart range');
  const configured = options.limitCap ?? Number(process.env.CMC_CHART_MAX_CANDLES || 1000);
  const cap = Number.isFinite(configured) ? Math.min(1000, Math.max(1, Math.floor(configured))) : 1000;
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries({ platform: 'bsc', address, interval: settings.interval, unit: 'usd', pm: 'p', limit: Math.min(settings.limit, cap) })) {
    url.searchParams.set(key, String(value));
  }
  signal.throwIfAborted();
  const body = await request(url, signal);
  if (!validResponse(body)) throw new Error('CoinMarketCap returned an invalid chart response');
  const until = Math.floor(now / 1000), since = Math.max(0, until - settings.seconds);
  const candles = parseCmcCandles(body.data, since, until, settings.step);
  if (!candles.length) return null;
  return { address, period, candles, points: candles.map(c => ({ timestamp: new Date(c.time * 1000).toISOString(), priceUsd: String(c.close) })),
    source: 'coinmarketcap', updatedAt: new Date(now).toISOString(), resolution: settings.resolution,
    volumeCurrency: 'unknown', pending: false, stale: false,
    partialHistory: candles.length < settings.limit || candles[0].time > since + settings.step };
}

/** One atomic reservation coordinates every app/worker process using this public IP. */
export async function reserveCmcSlot(priority: GeckoPriority, query: Query = (sql, values) => pool.query(sql, values)) {
  const result = await query(`WITH clock AS (
      SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms
    ), slot AS (
      INSERT INTO worker_state(key,value,updated_at)
      SELECT $1,jsonb_build_object('nextAt',ms+$2::bigint,'pausedUntil',0,'failures',0),now() FROM clock
      ON CONFLICT(key) DO UPDATE SET value=jsonb_set(worker_state.value,'{nextAt}',
        to_jsonb(greatest(COALESCE((worker_state.value->>'nextAt')::bigint,0),(SELECT ms FROM clock))+$2::bigint)),updated_at=now()
      WHERE COALESCE((worker_state.value->>'pausedUntil')::bigint,0)<=(SELECT ms FROM clock)
        AND COALESCE((worker_state.value->>'nextAt')::bigint,0)<=(SELECT ms FROM clock)+$3::bigint
      RETURNING (value->>'nextAt')::bigint AS next
    ) SELECT greatest(0,next-$2::bigint-ms)::integer AS delay FROM slot CROSS JOIN clock`,
  [budgetKey, spacingMs, priority === 'chart' ? spacingMs : 0]);
  if (result.rows.length) return Number(result.rows[0].delay);
  const pause = await query(`SELECT greatest(0,COALESCE((value->>'pausedUntil')::bigint,0)
    -floor(extract(epoch FROM clock_timestamp())*1000)::bigint)::integer AS delay FROM worker_state WHERE key=$1`, [budgetKey]);
  const delay = Number(pause.rows[0]?.delay) || 0;
  throw new MarketProviderDeferred(delay > 0 ? 'rate_limited' : 'busy', delay || spacingMs);
}

export function cmcRetryMs(headers: Headers, body: any, now = Date.now()) {
  const retryValues = [headers.get('retry-after'), body?.status?.retry_after, body?.retry_after].map(value => {
    if (value == null || value === '' || typeof value === 'boolean') return NaN;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number * 1000 : Date.parse(String(value)) - now;
  });
  const resetValues = [headers.get('x-ratelimit-reset'), body?.status?.reset_at, body?.reset_at].map(value => {
    if (value == null || value === '' || typeof value === 'boolean') return NaN;
    const number = Number(value);
    return Number.isFinite(number) ? (number >= 1e12 ? number : number * 1000) - now : NaN;
  });
  return Math.min(600_000, Math.max(60_000, ...[...retryValues, ...resetValues].filter(Number.isFinite)));
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

export function createCmcQueue<T>() {
  type Entry = { priority: Priority; signal: AbortSignal; run: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; abort: () => void };
  const waiting: Entry[] = [];
  let active = false;
  const dispatch = async () => {
    if (active || !waiting.length) return;
    active = true;
    waiting.sort((a, b) => marketPriorityRank[priorityOf(a.priority)] - marketPriorityRank[priorityOf(b.priority)]);
    const next = waiting.shift()!;
    try { next.signal.throwIfAborted(); next.resolve(await next.run()); }
    catch (error) { next.reject(error); }
    finally { next.signal.removeEventListener('abort', next.abort); active = false; void dispatch(); }
  };
  return (priority: Priority, signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    const requestedPriority = priorityOf(priority);
    // Background jobs cannot consume the four entries reserved for main charts.
    if (waiting.length >= (requestedPriority === 'chart' ? 24 : 20) || requestedPriority === 'sparkline' && waiting.filter(e => priorityOf(e.priority) === 'sparkline').length >= 8 ||
      requestedPriority === 'metadata' && (active || waiting.length)) return Promise.reject(new MarketProviderDeferred('busy', spacingMs));
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

/** Public CMC has no published fixed allowance: pace conservatively, coalesce and back off. */
export function createCmcRequester({ query = (sql, values) => pool.query(sql, values), fetcher = fetch, now = Date.now }:
  { query?: Query; fetcher?: typeof fetch; now?: () => number } = {}) {
  const enqueue = createCmcQueue<any>();
  type Job = { promise: Promise<any>; controller: AbortController; consumers: Map<symbol, Priority> };
  const jobs = new Map<string, Job>();
  let pausedUntil = 0;
  return async (url: URL, options: { priority?: Priority; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<any> => {
    if (`${url.origin}${url.pathname}` !== endpoint || url.username || url.password || url.searchParams.has('from') || url.searchParams.has('to')) throw new Error('Invalid CoinMarketCap chart URL');
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 20_000)]) : AbortSignal.timeout(options.timeoutMs ?? 20_000);
    signal.throwIfAborted();
    if (pausedUntil > now()) throw new MarketProviderDeferred('rate_limited', pausedUntil - now());
    const token = Symbol(), priority = options.priority ?? 'chart';
    let job = jobs.get(url.href);
    if (!job) {
      let createdJob: Job;
      const controller = new AbortController(), consumers = new Map<symbol, Priority>([[token, priority]]);
      const jobSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      const currentPriority = (): GeckoPriority => {
        const values = [...consumers.values()].map(priorityOf);
        return values.sort((a, b) => marketPriorityRank[a] - marketPriorityRank[b])[0] ?? 'metadata';
      };
      const promise = enqueue(currentPriority, jobSignal, async () => {
        if (pausedUntil > now()) throw new MarketProviderDeferred('rate_limited', pausedUntil - now());
        const delay = await cancellable(reserveCmcSlot(currentPriority(), query), jobSignal);
        if (delay) await cancellable(new Promise(resolve => setTimeout(resolve, delay)), jobSignal);
        jobSignal.throwIfAborted();
        const pause = await cancellable(query(`SELECT (value->>'pausedUntil')::bigint-floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS delay
          FROM worker_state WHERE key=$1 AND (value->>'pausedUntil')::bigint>floor(extract(epoch FROM clock_timestamp())*1000)::bigint`, [budgetKey]), jobSignal);
        if (pause.rows.length) {
          pausedUntil = now() + Number(pause.rows[0].delay);
          throw new MarketProviderDeferred('rate_limited', Number(pause.rows[0].delay));
        }
        const coolDown = async (delay: number, base: number) => {
          const result = await query(`UPDATE worker_state SET value=value || jsonb_build_object(
              'failures',least(6,COALESCE((value->>'failures')::integer,0)+1),
              'pausedUntil',greatest(COALESCE((value->>'pausedUntil')::bigint,0),
                floor(extract(epoch FROM clock_timestamp())*1000)::bigint+greatest($2::bigint,
                  least(600000::bigint,($3::numeric*power(2,least(5,COALESCE((value->>'failures')::integer,0))))::bigint)))),updated_at=now()
            WHERE key=$1 RETURNING greatest(0,(value->>'pausedUntil')::bigint-floor(extract(epoch FROM clock_timestamp())*1000)::bigint)::integer AS delay`,
          [budgetKey, delay, base]);
          const retry = Math.max(delay, Number(result.rows[0]?.delay) || delay);
          pausedUntil = Math.max(pausedUntil, now() + retry);
          return retry;
        };
        let response: Response;
        try { response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.any([jobSignal, AbortSignal.timeout(8000)]) }); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          await coolDown(60_000, 60_000);
          throw error;
        }
        jobSignal.throwIfAborted();
        let body: any;
        try { body = await response.json(); } catch { /* Error responses may be HTML. */ }
        const code = Number(body?.status?.error_code);
        if (response.status === 429 || [429, 1008, 1009, 1010, 1011, 1022].includes(code)) {
          const retry = await coolDown(cmcRetryMs(response.headers, body, now()), 60_000);
          throw new MarketProviderDeferred('rate_limited', retry);
        }
        if ([401, 403].includes(response.status) || [401, 403, 1001, 1002, 1006].includes(code)) {
          await coolDown(300_000, 300_000);
          throw new CmcHttpError(response.ok ? 403 : response.status);
        }
        if (response.status >= 500) { await coolDown(60_000, 60_000); throw new CmcHttpError(response.status); }
        if (!response.ok) throw new CmcHttpError(response.status);
        if (!validResponse(body)) {
          await coolDown(60_000, 60_000);
          throw new Error('CoinMarketCap returned an invalid chart response');
        }
        await query(`UPDATE worker_state SET value=value || jsonb_build_object('failures',0),updated_at=now()
          WHERE key=$1 AND COALESCE((value->>'pausedUntil')::bigint,0)<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint`, [budgetKey]);
        return body;
      }).finally(() => { if (jobs.get(url.href) === createdJob) jobs.delete(url.href); });
      createdJob = { promise, controller, consumers }; job = createdJob; jobs.set(url.href, job);
    } else job.consumers.set(token, priority);
    try { return await cancellable(job.promise, signal); }
    finally {
      job.consumers.delete(token);
      if (!job.consumers.size) {
        if (jobs.get(url.href) === job) jobs.delete(url.href);
        job.controller.abort(new Error('Chart request no longer needed'));
      }
    }
  };
}

export const cmcRequest = createCmcRequester();
