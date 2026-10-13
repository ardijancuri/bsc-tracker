import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ReplayMarketChart } from '../shared/replayChart.js';
import { pool } from './db.js';
import { geckoFetch } from './geckoApi.js';
import { gmgnRequest } from './gmgnApi.js';
import { parseCandles, selectChartPools } from './tokenChart.js';
import { nonStockTokenSql } from './stockToken.js';

const addressPattern = /^0x[0-9a-f]{40}$/;
const requestBudgetMs = 20_000;
const contextMs = 5 * 60_000;
type JsonRequest = (url: URL, signal: AbortSignal, headers?: Record<string, string>) => Promise<any>;
interface SampleBar { time: number; open: number; close: number }
class ReplayMarketHttpError extends Error {
  constructor(readonly status: number) { super(`Replay market request failed: ${status}`); }
}

function validNumber(value: unknown) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/** A queued public request may outlive the response budget, but cannot delay this modal indefinitely. */
function withinBudget<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Replay history cancelled', 'AbortError'));
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

async function requestGmgn(url: URL, signal: AbortSignal, headers?: Record<string, string>) {
  return gmgnRequest(url, { apiKey: headers?.['X-APIKEY'] ?? '', signal, priority: 'chart', weight: 2 });
}

const requestGecko: JsonRequest = async (url, signal) => {
  const response = await withinBudget(geckoFetch(url, { priority: 'chart', timeoutMs: 6000 }), signal);
  if (!response.ok) throw new ReplayMarketHttpError(response.status);
  return withinBudget(response.json(), signal);
};

/** Use only a contiguous run of observed bars that covers every selected trade. */
export function replayPointsFromBars(bars: SampleBar[], seconds: number, first: number, last: number, now: number): ReplayMarketChart['points'] | null {
  const byTime = new Map<number, SampleBar>();
  for (const bar of bars) {
    if (!Number.isInteger(bar.time) || bar.time < 0 || !validNumber(bar.open) || !validNumber(bar.close)
      || (bar.time + seconds) * 1000 > now) continue;
    byTime.set(bar.time, bar);
  }
  const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    if (end !== sorted.length - 1 && sorted[end + 1].time === sorted[end].time + seconds) continue;
    if (sorted[start].time * 1000 <= first && (sorted[end].time + seconds) * 1000 >= last) {
      const run = sorted.slice(start, end + 1);
      return [{ timestamp: new Date(run[0].time * 1000).toISOString(), priceUsd: String(run[0].open) },
        ...run.map(bar => ({ timestamp: new Date((bar.time + seconds) * 1000).toISOString(), priceUsd: String(bar.close) }))];
    }
    start = end + 1;
  }
  return null;
}

function gmgnBars(rows: unknown, from: number, to: number): SampleBar[] {
  if (!Array.isArray(rows)) return [];
  const bars: SampleBar[] = [];
  for (const row of rows.slice(0, 1000)) {
    const rawTime = validNumber(row?.time);
    const open = validNumber(row?.open), close = validNumber(row?.close);
    if (rawTime === null || open === null || close === null) continue;
    // OpenAPI currently returns milliseconds; older responses use seconds.
    const time = rawTime >= 1e12 ? rawTime / 1000 : rawTime;
    if (!Number.isInteger(time) || time * 1000 < from || time * 1000 > to) continue;
    bars.push({ time, open, close });
  }
  return bars;
}

export interface ReplayChartProviderOptions {
  gmgnKey?: string;
  gmgnRequest?: JsonRequest;
  geckoRequest?: JsonRequest;
  signal?: AbortSignal;
  now?: number;
}

/** Prefer authentic 30-second history, then public one-minute history. Never split coarse bars. */
export async function fetchTradeReplayChart(address: string, first: number, last: number, options: ReplayChartProviderOptions = {}): Promise<ReplayMarketChart | null> {
  const now = options.now ?? Date.now();
  if (!addressPattern.test(address) || !Number.isFinite(first) || first < 0 || !Number.isFinite(last) || last < first || last > now) {
    throw new Error('Invalid replay history range');
  }
  const signal = options.signal ?? AbortSignal.timeout(requestBudgetMs);
  const from = Math.max(0, first - contextMs), targetTo = Math.min(now, last + contextMs);
  const chart = (points: ReplayMarketChart['points'], source: ReplayMarketChart['source'], resolution: string, poolAddress?: string): ReplayMarketChart => ({
    address, period: 'replay', candles: [], points, source, resolution, poolAddress,
    updatedAt: new Date(now).toISOString(), pending: false, stale: false,
  });
  if (options.gmgnKey) {
    try {
      const bars = new Map<number, SampleBar>();
      let to = targetTo;
      for (let page = 0; page < 4 && to > from && !signal.aborted; page += 1) {
        const url = new URL('https://openapi.gmgn.ai/v1/market/token_kline');
        for (const [key, value] of Object.entries({ chain: 'bsc', address, resolution: '30s', from, to,
          timestamp: Math.floor(now / 1000), client_id: randomUUID() })) url.searchParams.set(key, String(value));
        const body = await withinBudget((options.gmgnRequest ?? requestGmgn)(url, signal, { 'X-APIKEY': options.gmgnKey }), signal);
        if (body?.code !== 0) throw new Error('Replay market provider rejected history');
        const rows = gmgnBars(Array.isArray(body?.data) ? body.data : body?.data?.list, from, to);
        if (!rows.length) break;
        for (const bar of rows) bars.set(bar.time, bar);
        const points = replayPointsFromBars([...bars.values()], 30, first, last, now);
        if (points) return chart(points, 'gmgn', '30s');
        const oldest = Math.min(...rows.map(bar => bar.time)) * 1000;
        if (oldest <= first || oldest - 1 >= to) break;
        to = oldest - 1;
      }
    } catch { /* A configured provider's unavailable history can use the public market source. */ }
  }
  if (signal.aborted) return null;
  const request = options.geckoRequest ?? requestGecko;
  try {
    const discovery = new URL(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${address}/pools`);
    const pools = selectChartPools(await withinBudget(request(discovery, signal), signal), address).slice(0, 2);
    for (const poolAddress of pools) {
      const bars = new Map<number, SampleBar>();
      let before = Math.ceil(targetTo / 1000);
      for (let page = 0; page < 2 && !signal.aborted; page += 1) {
        const url = new URL(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${poolAddress}/ohlcv/minute`);
        for (const [key, value] of Object.entries({ aggregate: '1', limit: '1000', currency: 'usd', token: address,
          before_timestamp: String(before), include_empty_intervals: 'true' })) url.searchParams.set(key, value);
        let body: any;
        try { body = await withinBudget(request(url, signal), signal); }
        catch (problem) {
          // Unsupported or removed pools may use the next verified pool;
          // timeouts and cooldowns must not trigger more upstream requests.
          if (problem instanceof ReplayMarketHttpError && [404, 422].includes(problem.status)) break;
          throw problem;
        }
        const rows = parseCandles(body?.data?.attributes?.ohlcv_list, Math.floor(from / 1000), Math.min(before, Math.floor(now / 1000) - 60));
        if (!rows.length) break;
        for (const bar of rows) bars.set(bar.time, bar);
        const points = replayPointsFromBars([...bars.values()], 60, first, last, now);
        if (points) return chart(points, 'geckoterminal', '1m', poolAddress);
        const oldest = Math.min(...rows.map(bar => bar.time));
        if (oldest * 1000 <= first || oldest - 1 >= before) break;
        before = oldest - 1;
      }
    }
  } catch { /* Keep provider gaps and cooldowns unavailable rather than inventing observations. */ }
  return null;
}

function unavailable(address: string, busy = false): ReplayMarketChart {
  return { address, period: 'replay', candles: [], points: [], source: 'unavailable', resolution: '30s',
    updatedAt: null, pending: false, stale: false, loadStatus: busy ? 'queued' : undefined, retryAfterMs: busy ? 3000 : 30_000 };
}

/** Historical windows are immutable; cache failures briefly and bound unique in-flight work. */
export function createReplayChartCache(loader: typeof fetchTradeReplayChart, now = Date.now) {
  const saved = new Map<string, { chart: ReplayMarketChart; until: number }>();
  const jobs = new Map<string, Promise<ReplayMarketChart>>();
  return async (address: string, first: number, last: number): Promise<ReplayMarketChart> => {
    const key = `${address}:${first}:${last}`;
    const cached = saved.get(key);
    if (cached && cached.until > now()) return cached.chart;
    const pending = jobs.get(key);
    if (pending) return pending;
    if (jobs.size >= 2) return unavailable(address, true);
    const job = (async () => {
      let chart: ReplayMarketChart;
      try { chart = await loader(address, first, last, { gmgnKey: process.env.GMGN_CHART_API_KEY?.trim() || process.env.GMGN_API_KEY?.trim(), signal: AbortSignal.timeout(requestBudgetMs) }) ?? unavailable(address); }
      catch { chart = unavailable(address); }
      if (saved.size >= 250) saved.delete(saved.keys().next().value!);
      saved.set(key, { chart, until: now() + (chart.points.length ? 3_600_000 : 30_000) });
      return chart;
    })().finally(() => jobs.delete(key));
    jobs.set(key, job);
    return job;
  };
}
const cachedReplayChart = createReplayChartCache(fetchTradeReplayChart);

export function registerTradeReplayChartRoutes(app: FastifyInstance) {
  app.get<{ Params: { address: string; token: string } }>('/api/kols/:address/tokens/:token/replay-chart', async (request, reply) => {
    const wallet = request.params.address.toLowerCase(), token = request.params.token.toLowerCase();
    if (!addressPattern.test(wallet) || !addressPattern.test(token)) return reply.code(400).send({ error: 'Invalid KOL or token address' });
    const result = await pool.query(`SELECT MIN(t.timestamp) AS first,MAX(t.timestamp) AS last,
      CASE WHEN v.total_supply_raw>0 AND v.decimals BETWEEN 0 AND 36 AND v.supply_checked_at>now()-interval '2 days'
        THEN (v.total_supply_raw/power(10::numeric,v.decimals))::text END AS supply
      FROM trades t JOIN kols k ON k.address=t.wallet_address JOIN tokens v ON v.address=t.token_address
      WHERE t.wallet_address=$1 AND t.token_address=$2 AND k.is_tracked AND t.block_number IS NOT NULL
        AND t.timestamp<=now() AND t.side IN ('buy','sell') AND ${nonStockTokenSql('t.token_address')}
      GROUP BY v.address`, [wallet, token]);
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: 'KOL token activity not found' });
    const chart = await cachedReplayChart(token, new Date(row.first).getTime(), new Date(row.last).getTime());
    return reply.header('Cache-Control', chart.points.length ? 'public, max-age=60' : 'no-store')
      .send({ ...chart, marketCapSupply: row.supply ?? null });
  });
}
