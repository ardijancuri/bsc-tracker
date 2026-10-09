import { pool } from './db.js';

type Query = (sql: string, values: unknown[]) => Promise<{ rows: { delay: number }[] }>;
const spacingMs = 4000;
const budgetKey = 'gecko_api_budget';

// App charts and worker metadata share one IP and one public API allowance.
// The upsert row lock assigns distinct slots across processes. Optional metadata
// only runs when the queue is idle, leaving room for requested charts.
export async function reserveGeckoSlot(priority: 'chart' | 'metadata', query: Query = (sql, values) => pool.query(sql, values)) {
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
  [budgetKey, spacingMs, priority === 'chart' ? 45_000 : 0]);
  if (!result.rows.length) throw new Error('Market provider busy; retry shortly');
  return result.rows[0].delay;
}

export function providerRetryMs(value: string | null, now = Date.now()) {
  const seconds = Number(value);
  const delay = value && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : value ? Date.parse(value) - now : NaN;
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 600_000) : 60_000;
}

export async function geckoFetch(url: string | URL, { priority = 'metadata', timeoutMs = 12_000 }: {
  priority?: 'chart' | 'metadata'; timeoutMs?: number;
} = {}) {
  const delay = await reserveGeckoSlot(priority);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  // Another process may receive 429 while this request is queued.
  const pause = await pool.query(`SELECT 1 FROM worker_state WHERE key=$1
    AND (value->>'pausedUntil')::bigint>floor(extract(epoch FROM clock_timestamp())*1000)::bigint`, [budgetKey]);
  if (pause.rows.length) throw new Error('Market chart provider cooling down');
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 429) {
    await pool.query(`UPDATE worker_state SET value=jsonb_set(value,'{pausedUntil}',to_jsonb(
      greatest(COALESCE((value->>'pausedUntil')::bigint,0),floor(extract(epoch FROM clock_timestamp())*1000)::bigint+$2::bigint))),updated_at=now()
      WHERE key=$1`, [budgetKey, providerRetryMs(response.headers.get('retry-after'))]);
  }
  return response;
}
