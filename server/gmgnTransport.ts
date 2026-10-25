import { createHash, randomUUID } from 'node:crypto';
import { MarketProviderDeferred, marketPriorityRank, type GeckoPriority } from './providerPriority.js';

type Priority = GeckoPriority | (() => GeckoPriority);
type Foreground = boolean | (() => boolean);
export type GmgnWorkload = 'accounting' | 'market' | 'browse' | 'replay';
export function gmgnApiKey(workload: GmgnWorkload, env: NodeJS.ProcessEnv = process.env) {
  return (workload === 'replay' ? env.GMGN_REPLAY_API_KEY?.trim() || env.GMGN_ACCOUNTING_API_KEY?.trim() : workload === 'accounting' ? env.GMGN_ACCOUNTING_API_KEY?.trim() : '')
    || env.GMGN_CHART_API_KEY?.trim() || env.GMGN_API_KEY?.trim() || '';
}
const foregroundOf = (foreground: Foreground = false) => typeof foreground === 'function' ? foreground() : foreground;
type Pause = { delay: number; pauseStatus?: number | string | null; busyDelay?: number };
export type GmgnBudgetQuery = (sql: string, values: unknown[]) => Promise<{ rows: Pause[] }>;
const priorityOf = (priority: Priority) => typeof priority === 'function' ? priority() : priority;
// Free accounts allow five weighted units/second. Use two, without bursts,
// across token history, replay history, and the worker's wallet-profit calls.
const unitSpacingMs = 500;
const budgetKey = (apiKey: string) => `gmgn_api_budget:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;

export class GmgnHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs?: number) { super(`GMGN request failed: HTTP ${status}`); }
}

function pauseError(pause: Pause) {
  const status = Number(pause.pauseStatus), delay = Number(pause.delay);
  return status === 401 || status === 403
    ? new GmgnHttpError(status, delay) : new MarketProviderDeferred('rate_limited', delay);
}

/** Bound both queue residence and network work; cancelled queued jobs never dispatch. */
export function createGmgnQueue<T>() {
  type Entry = { priority: Priority; foreground: Foreground; run: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; signal: AbortSignal; abort: () => void };
  const waiting: Entry[] = [];
  let active = false;
  const dispatch = async () => {
    if (active || !waiting.length) return;
    active = true;
    waiting.sort((a, b) => Number(foregroundOf(b.foreground)) - Number(foregroundOf(a.foreground))
      || marketPriorityRank[priorityOf(a.priority)] - marketPriorityRank[priorityOf(b.priority)]);
    const next = waiting.shift()!;
    try { if (next.signal.aborted) throw next.signal.reason; next.resolve(await next.run()); }
    catch (error) { next.reject(error); }
    finally { next.signal.removeEventListener('abort', next.abort); active = false; void dispatch(); }
  };
  return (priority: Priority, signal: AbortSignal, run: () => Promise<T>, foreground: Foreground = false): Promise<T> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    const requestedPriority = priorityOf(priority);
    // Keep eight entries available for charts opened during a prefetch burst.
    if (waiting.length >= (foregroundOf(foreground) || requestedPriority === 'chart' ? 32 : 24)
      || !foregroundOf(foreground) && requestedPriority === 'metadata' && (active || waiting.length)) return Promise.reject(new MarketProviderDeferred('busy', 1500));
    return new Promise((resolve, reject) => {
      const entry: Entry = { priority, foreground, signal, run, resolve, reject, abort: () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) { waiting.splice(index, 1); reject(signal.reason); }
        // Active work owns the lane until its transport actually settles. The
        // subscriber is already cancelled; releasing early could create a new
        // same-key lane while the old HTTP connection is still terminating.
      } };
      signal.addEventListener('abort', entry.abort, { once: true });
      waiting.push(entry); void dispatch();
    });
  };
}

export type GmgnBudgetTable = 'worker_state' | 'fresh.checkpoints';
function checkedTable(table: GmgnBudgetTable) { if (!['worker_state', 'fresh.checkpoints'].includes(table)) throw new Error('Invalid GMGN budget table'); return table; }

export async function reserveGmgnSlot(apiKey: string, weight: 1 | 2 | 3 | 5, priority: GeckoPriority, query: GmgnBudgetQuery, stateTable: GmgnBudgetTable = 'worker_state', leaseId?: string) {
  const spacing = weight * unitSpacingMs;
  const lease = stateTable === 'fresh.checkpoints' && leaseId !== undefined;
  const result = await query(`WITH clock AS (
      SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms
    ), slot AS (
      INSERT INTO ${checkedTable(stateTable)} AS budget(key,value,updated_at)
      SELECT $1,jsonb_build_object('nextAt',ms+$2::bigint,'pausedUntil',0)${lease ? " || jsonb_build_object('activeUntil',ms+20000,'leaseId',$4::text)" : ''},now() FROM clock
      ON CONFLICT(key) DO UPDATE SET value=jsonb_set(budget.value,'{nextAt}',
        to_jsonb(greatest(COALESCE((budget.value->>'nextAt')::bigint,0),(SELECT ms FROM clock))+$2::bigint))${lease ? " || jsonb_build_object('activeUntil',(SELECT ms FROM clock)+20000,'leaseId',$4::text)" : ''},updated_at=now()
      WHERE COALESCE((budget.value->>'pausedUntil')::bigint,0)<=(SELECT ms FROM clock)
        AND COALESCE((budget.value->>'nextAt')::bigint,0)<=(SELECT ms FROM clock)+$3::bigint
        ${lease ? "AND COALESCE((budget.value->>'activeUntil')::bigint,0)<=(SELECT ms FROM clock)" : ''}
      RETURNING (value->>'nextAt')::bigint AS next
    ) SELECT greatest(0,next-$2::bigint-ms)::integer AS delay FROM slot CROSS JOIN clock`,
  [budgetKey(apiKey), spacing, priority === 'metadata' ? 0 : 1500, ...(lease ? [leaseId] : [])]);
  if (result.rows.length) return result.rows[0].delay;
  const pause = await query(`SELECT greatest(0,COALESCE((value->>'pausedUntil')::bigint,0)
      -floor(extract(epoch FROM clock_timestamp())*1000)::bigint)::integer AS delay, value->>'pauseStatus' AS "pauseStatus"
      ${lease ? ",greatest(0,COALESCE((value->>'activeUntil')::bigint,0)-floor(extract(epoch FROM clock_timestamp())*1000)::bigint)::integer AS \"busyDelay\"" : ''}
    FROM ${checkedTable(stateTable)} WHERE key=$1`, [budgetKey(apiKey)]);
  const delay = Number(pause.rows[0]?.delay) || 0;
  throw delay > 0 ? pauseError({ ...pause.rows[0], delay }) : new MarketProviderDeferred('busy', spacing);
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
  // GMGN's client leaves one second after reset. Unix-second rounding and
  // clock skew must not dispatch an early retry that extends the account ban.
  return Number.isFinite(until) && until >= now - 1000
    ? Math.min(600_000, Math.max(1000, until - now + 1000)) : 60_000;
}

export interface GmgnRequestOptions {
  apiKey?: string; workload?: GmgnWorkload; foreground?: Foreground;
  weight?: 1 | 2 | 3 | 5; priority?: Priority; signal?: AbortSignal; timeoutMs?: number;
  method?: 'GET' | 'POST'; body?: unknown;
}

export interface GmgnDiagnostic {
  event: 'request' | 'coalesced' | 'cache_hit' | 'complete'; workload: GmgnWorkload;
  priority?: GeckoPriority; foreground?: boolean; queueWaitMs?: number; upstreamMs?: number;
  outcome?: 'ok' | 'cancelled' | 'busy' | 'rate_limited' | 'auth' | 'unavailable'; retryAfterMs?: number;
}
const diagnosticTotals = { requests: 0, coalesced: 0, cacheHits: 0, completed: 0 };
export function gmgnDiagnostics() { return { ...diagnosticTotals }; }
function observeGmgn(event: GmgnDiagnostic) {
  if (event.event === 'request') diagnosticTotals.requests++;
  if (event.event === 'coalesced') diagnosticTotals.coalesced++;
  if (event.event === 'cache_hit') diagnosticTotals.cacheHits++;
  if (event.event === 'complete') diagnosticTotals.completed++;
  if (process.env.GMGN_REQUEST_DIAGNOSTICS === 'true') console.info(JSON.stringify({ gmgn: event }));
}
export function recordGmgnCacheHit(workload: GmgnWorkload) { observeGmgn({ event: 'cache_hit', workload }); }

const publicRoutes = new Set(['/v1/user/wallet_activity', '/v1/market/token_top_traders', '/v1/market/token_kline', '/v1/token/info']);
function publicRequestKey(url: URL, options: GmgnRequestOptions) {
  if ((options.method ?? 'GET') !== 'GET' || options.body !== undefined || !publicRoutes.has(url.pathname)) return null;
  const params = [...url.searchParams].filter(([key]) => key !== 'timestamp' && key !== 'client_id')
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  return createHash('sha256').update(JSON.stringify([url.pathname, params])).digest('hex');
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
export function createGmgnRequester({ query, stateTable = 'worker_state', fetcher = fetch, now = Date.now, observe = observeGmgn }:
  { query: GmgnBudgetQuery; stateTable?: GmgnBudgetTable; fetcher?: typeof fetch; now?: () => number; observe?: (event: GmgnDiagnostic) => void }) {
  type Client = { priority: Priority; foreground: Foreground; signal: AbortSignal; abort: () => void;
    resolve: (value: any) => void; reject: (error: unknown) => void };
  type Job = { controller: AbortController; clients: Set<Client> };
  const jobs = new Map<string, Job>();
  const queues = new Map<string, { enqueue: ReturnType<typeof createGmgnQueue<any>>; users: number }>();
  return async (url: URL, options: GmgnRequestOptions): Promise<any> => {
    if (url.origin !== 'https://openapi.gmgn.ai' || url.username || url.password || !url.pathname.startsWith('/v1/')) throw new Error('Invalid GMGN API URL');
    const workload = options.workload ?? (['/v1/user/wallet_activity', '/v1/market/token_top_traders', '/v1/user/wallet_profits'].includes(url.pathname) ? 'accounting' : 'market');
    const apiKey = (options.apiKey ?? gmgnApiKey(workload)).trim();
    if (!apiKey) throw new Error('GMGN API key is not configured');
    const clientSignal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 20_000)]) : AbortSignal.timeout(options.timeoutMs ?? 20_000);
    clientSignal.throwIfAborted();
    const requestKey = publicRequestKey(url, options);
    let job = requestKey ? jobs.get(requestKey) : undefined;
    const existing = !!job;
    if (!job) {
      job = { controller: new AbortController(), clients: new Set() };
      if (requestKey) jobs.set(requestKey, job);
    }
    const shared = job;
    const priority = () => [...shared.clients].map(client => priorityOf(client.priority))
      .sort((a, b) => marketPriorityRank[a] - marketPriorityRank[b])[0] ?? 'chart';
    const foreground = () => [...shared.clients].some(client => foregroundOf(client.foreground));
    const subscribed = new Promise<any>((resolve, reject) => {
      const client: Client = { priority: options.priority ?? 'chart', foreground: options.foreground ?? false, signal: clientSignal, resolve, reject,
        abort: () => {
          shared.clients.delete(client); clientSignal.removeEventListener('abort', client.abort); reject(clientSignal.reason);
          if (!shared.clients.size) {
            if (requestKey && jobs.get(requestKey) === shared) jobs.delete(requestKey);
            shared.controller.abort(clientSignal.reason);
          }
        } };
      shared.clients.add(client); clientSignal.addEventListener('abort', client.abort, { once: true });
    });
    if (existing) { observe({ event: 'coalesced', workload, priority: priority(), foreground: foreground() }); return subscribed; }
    const key = budgetKey(apiKey);
    let lane = queues.get(key);
    if (!lane) { lane = { enqueue: createGmgnQueue<any>(), users: 0 }; queues.set(key, lane); }
    const activeLane = lane; activeLane.users++;
    const signal = AbortSignal.any([shared.controller.signal, AbortSignal.timeout(20_000)]);
    const startedAt = now(); let networkAt: number | undefined;
    const leaseId = stateTable === 'fresh.checkpoints' ? randomUUID() : undefined;
    const run = activeLane.enqueue(priority, signal, async () => {
      let leased = false;
      try {
      const reservation = reserveGmgnSlot(apiKey, options.weight ?? 2, priorityOf(priority), query, stateTable, leaseId);
      // Await a fresh reservation even if the subscriber has gone away, so a
      // completed DB lease can always be released after its atomic insert.
      const delay = leaseId ? await reservation : await cancellable(reservation, signal);
      leased = !!leaseId;
      if (delay) await cancellable(new Promise(resolve => setTimeout(resolve, delay)), signal);
      signal.throwIfAborted();
      const pause = await cancellable(query(`SELECT (value->>'pausedUntil')::bigint-floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS delay,
        value->>'pauseStatus' AS "pauseStatus"
        FROM ${checkedTable(stateTable)} WHERE key=$1 AND (value->>'pausedUntil')::bigint>floor(extract(epoch FROM clock_timestamp())*1000)::bigint`, [budgetKey(apiKey)]), signal);
      if (pause.rows.length) throw pauseError(pause.rows[0]);
      // Exist-auth calls require a timestamp within five seconds and a unique
      // client ID. Prepare both after all queue/budget waits, including for the
      // unsigned wallet-profits POST, without changing the caller's URL/body.
      const authenticatedUrl = new URL(url.href);
      authenticatedUrl.searchParams.set('timestamp', String(Math.floor(now() / 1000)));
      authenticatedUrl.searchParams.set('client_id', randomUUID());
      networkAt = now(); observe({ event: 'request', workload, priority: priority(), foreground: foreground(), queueWaitMs: Math.max(0, networkAt - startedAt) });
      const response = await fetcher(authenticatedUrl, { method: options.method ?? 'GET', headers: {
        Accept: 'application/json', 'X-APIKEY': apiKey, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      let body: any;
      try { body = await response.json(); } catch { /* HTTP error bodies are not necessarily JSON. */ }
      const rateLimited = response.status === 429 || Number(body?.code) === 429;
      const unauthorized = [401, 403].includes(response.status) || [401, 403].includes(Number(body?.code));
      if (rateLimited || unauthorized) {
        const retryAfterMs = rateLimited ? gmgnRetryMs(response.headers, body, now()) : 300_000;
        const status = rateLimited ? 429 : [401, 403].includes(response.status) ? response.status : Number(body.code);
        await query(`UPDATE ${checkedTable(stateTable)} SET value=value || jsonb_build_object(
          'pausedUntil',greatest(COALESCE((value->>'pausedUntil')::bigint,0),floor(extract(epoch FROM clock_timestamp())*1000)::bigint+$2::bigint),
          'pauseStatus',CASE WHEN COALESCE((value->>'pausedUntil')::bigint,0)>floor(extract(epoch FROM clock_timestamp())*1000)::bigint+$2::bigint
            THEN value->'pauseStatus' ELSE to_jsonb($3::integer) END),updated_at=now()
          WHERE key=$1`, [budgetKey(apiKey), retryAfterMs, status]);
        if (rateLimited) throw new MarketProviderDeferred('rate_limited', retryAfterMs);
        throw new GmgnHttpError(status, retryAfterMs);
      }
      if (!response.ok) throw new GmgnHttpError(response.status);
      if (body?.code !== 0) throw new Error('GMGN returned an invalid API response');
      return body;
      } finally {
        if (leased) await query(`UPDATE ${checkedTable(stateTable)} SET value=value-'activeUntil'-'leaseId',updated_at=now()
          WHERE key=$1 AND value->>'leaseId'=$2`, [budgetKey(apiKey), leaseId]).catch(() => {});
      }
    }, foreground);
    const settle = (error: unknown, value?: unknown) => {
      if (requestKey && jobs.get(requestKey) === shared) jobs.delete(requestKey);
      for (const client of shared.clients) {
        client.signal.removeEventListener('abort', client.abort);
        if (error !== undefined) client.reject(error); else client.resolve(structuredClone(value));
      }
      shared.clients.clear();
      activeLane.users--; if (!activeLane.users && queues.get(key) === activeLane) queues.delete(key);
    };
    void run.then(value => {
      observe({ event: 'complete', workload, priority: priority(), foreground: foreground(), outcome: 'ok',
        queueWaitMs: Math.max(0, (networkAt ?? now()) - startedAt), upstreamMs: networkAt === undefined ? 0 : Math.max(0, now() - networkAt) });
      settle(undefined, value);
    }, error => {
      observe({ event: 'complete', workload, priority: priority(), foreground: foreground(),
        outcome: signal.aborted ? 'cancelled' : error instanceof MarketProviderDeferred ? error.reason
          : error instanceof GmgnHttpError && [401, 403].includes(error.status) ? 'auth' : 'unavailable',
        queueWaitMs: Math.max(0, (networkAt ?? now()) - startedAt), upstreamMs: networkAt === undefined ? 0 : Math.max(0, now() - networkAt),
        ...(error instanceof MarketProviderDeferred || error instanceof GmgnHttpError ? { retryAfterMs: error.retryAfterMs } : {}) });
      settle(error);
    });
    return subscribed;
  };
}

