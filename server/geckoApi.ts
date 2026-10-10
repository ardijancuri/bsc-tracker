import { pool } from './db.js';

type Query = (sql: string, values: unknown[]) => Promise<{ rows: { delay: number }[] }>;
// The current public API advertises approximately 10 calls/minute. Leave
// headroom instead of repeatedly putting the whole IP into a 429 cooldown.
const spacingMs = 6500;
const budgetKey = 'gecko_api_budget';
export type GeckoPriority = 'chart' | 'sparkline' | 'metadata';
type Priority = GeckoPriority | (() => GeckoPriority);
const priorityOf = (priority: Priority) => typeof priority === 'function' ? priority() : priority;

export class MarketProviderDeferred extends Error {
  constructor(public readonly reason: 'busy' | 'rate_limited', public readonly retryAfterMs: number) {
    super(reason === 'rate_limited' ? 'Market provider cooling down' : 'Market provider busy; retry shortly');
  }
}

// Reserve only the request being dispatched, not slots for an entire watchlist.
// A selected candle chart goes ahead of waiting sparklines between upstream calls.
export function createGeckoQueue<T>() {
  const waiting: { priority: Priority; run: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }[] = [];
  let active = false;
  const rank = { chart: 0, sparkline: 1, metadata: 2 };
  const dispatch = async () => {
    if (active || !waiting.length) return;
    active = true;
    waiting.sort((a, b) => rank[priorityOf(a.priority)] - rank[priorityOf(b.priority)]);
    const next = waiting.shift()!;
    try { next.resolve(await next.run()); } catch (error) { next.reject(error); }
    finally { active = false; void dispatch(); }
  };
  return (priority: Priority, run: () => Promise<T>): Promise<T> => {
    if (waiting.length >= 64 || priorityOf(priority) === 'metadata' && (active || waiting.length)) {
      return Promise.reject(new MarketProviderDeferred('busy', spacingMs));
    }
    return new Promise((resolve, reject) => {
      const next = { priority, run, resolve, reject };
      waiting.push(next);
      void dispatch();
    });
  };
}
const enqueue = createGeckoQueue<Response>();

// App charts and worker metadata share one IP and one public API allowance.
// The upsert row lock assigns distinct slots across processes. Optional metadata
// only runs when the queue is idle, leaving room for requested charts.
export async function reserveGeckoSlot(priority: GeckoPriority, query: Query = (sql, values) => pool.query(sql, values)) {
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
  [budgetKey, spacingMs, priority === 'metadata' ? 0 : spacingMs]);
  if (!result.rows.length) {
    const pause = await query(`SELECT greatest(0,COALESCE((value->>'pausedUntil')::bigint,0)
      -floor(extract(epoch FROM clock_timestamp())*1000)::bigint)::integer AS delay
      FROM worker_state WHERE key=$1`, [budgetKey]);
    const delay = pause.rows[0]?.delay || 0;
    throw new MarketProviderDeferred(delay > 0 ? 'rate_limited' : 'busy', delay || spacingMs);
  }
  return result.rows[0].delay;
}

export function providerRetryMs(value: string | null, now = Date.now()) {
  const seconds = Number(value);
  const delay = value && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : value ? Date.parse(value) - now : NaN;
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 600_000) : 60_000;
}

export async function geckoFetch(url: string | URL, { priority = 'metadata', timeoutMs = 12_000 }: {
  priority?: Priority; timeoutMs?: number;
} = {}) {
  return enqueue(priority, async () => {
    const delay = await reserveGeckoSlot(priorityOf(priority));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    // Another process may receive 429 while this request is queued.
    const pause = await pool.query(`SELECT (value->>'pausedUntil')::bigint-floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS delay FROM worker_state WHERE key=$1
      AND (value->>'pausedUntil')::bigint>floor(extract(epoch FROM clock_timestamp())*1000)::bigint`, [budgetKey]);
    if (pause.rows.length) throw new MarketProviderDeferred('rate_limited', Number(pause.rows[0].delay));
    const response = await fetch(url, { headers: { Accept: 'application/json;version=20230203' }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 429) {
      const retryAfterMs = providerRetryMs(response.headers.get('retry-after'));
      await pool.query(`UPDATE worker_state SET value=jsonb_set(value,'{pausedUntil}',to_jsonb(
        greatest(COALESCE((value->>'pausedUntil')::bigint,0),floor(extract(epoch FROM clock_timestamp())*1000)::bigint+$2::bigint))),updated_at=now()
        WHERE key=$1`, [budgetKey, retryAfterMs]);
      throw new MarketProviderDeferred('rate_limited', retryAfterMs);
    }
    return response;
  });
}
