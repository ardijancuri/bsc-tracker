import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { gmgnRequest, GmgnHttpError } from './gmgnApi.js';
import { MarketProviderDeferred } from './geckoApi.js';
import { journalDecimalMultiply } from './nodeAccountingLedger.js';
import { MarketDecimal } from './nodeMarketMath.js';
import type { NodeMarketImport } from '../shared/nodeMarket.js';

export const chartIntervals = { '1m': 60, '5m': 300, '1h': 3600, '4h': 14400, '1d': 86400 } as const;
export const chartImportHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function chartImportDecimal(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return typeof text === 'string' && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) ? journalDecimalMultiply(text, '1') : null;
}
export function historicalImportRetry(error: unknown, attempts: number) {
  const fallback = Math.min(600_000, 5000 * 2 ** Math.min(Math.max(0, attempts), 6));
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return { reason: 'import_provider_timeout', retryAfterMs: 15000 };
  const provider = error instanceof MarketProviderDeferred || error instanceof GmgnHttpError;
  const retryAfterMs = provider && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs! : fallback;
  const reason = error instanceof MarketProviderDeferred ? error.reason === 'busy' ? 'import_provider_busy' : 'import_provider_cooldown'
    : error instanceof GmgnHttpError ? [401, 403].includes(error.status) ? 'import_provider_auth_blocked' : 'import_provider_unavailable'
    : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'import_unavailable';
  return { reason, retryAfterMs: Math.min(600_000, Math.max(1000, Math.ceil(retryAfterMs))) };
}
export function normalizeImportedChart(response: unknown, from: number, to: number, intervalSeconds: number, now: number, options: { requestLimit?: number } = {}) {
  const envelope = response as any, body = envelope?.data ?? envelope;
  const raw = Array.isArray(body) ? body : body?.list ?? body?.candles;
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error('import_chart_response_invalid');
  const bars = new Map<number, NonNullable<NodeMarketImport['observations']>[number] & { open: string; high: string; low: string; close: string; volumeUsd: string | null; intervalSeconds: number }>();
  for (const candidate of raw) {
    const row = Array.isArray(candidate) ? { time: candidate[0], open: candidate[1], high: candidate[2], low: candidate[3], close: candidate[4], volume: candidate[5] } : candidate;
    const input = Number(row?.time ?? row?.timestamp), time = input >= 1e12 ? input : input * 1000;
    const open = chartImportDecimal(row?.open), high = chartImportDecimal(row?.high), low = chartImportDecimal(row?.low), close = chartImportDecimal(row?.close), volume = chartImportDecimal(row?.volume);
    if (!Number.isSafeInteger(time) || time < from || time > to) throw new Error('import_chart_timestamp_invalid');
    if (time + intervalSeconds * 1000 > now) continue;
    if (!open || !high || !low || !close || [open, high, low, close].includes('0')) throw new Error('import_chart_candle_invalid');
    const [o, h, l, c] = [open, high, low, close].map(MarketDecimal.parse);
    if (h.compare(o) < 0 || h.compare(c) < 0 || l.compare(o) > 0 || l.compare(c) > 0 || l.compare(h) > 0) throw new Error('import_chart_candle_invalid');
    const result = { timestamp: new Date(time).toISOString(), priceUsd: close, open, high, low, close, volumeUsd: volume, intervalSeconds };
    const prior = bars.get(time); if (prior && chartImportHash(prior) !== chartImportHash(result)) throw new Error('import_chart_conflict');
    bars.set(time, result);
  }
  const observations = [...bars.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const coverageFrom = observations[0] ? Date.parse(observations[0].timestamp) : null;
  const coverageTo = observations.at(-1) ? Date.parse(observations.at(-1)!.timestamp) + intervalSeconds * 1000 : null;
  const complete = coverageFrom !== null && coverageTo !== null && coverageFrom <= from && coverageTo >= Math.min(to, now - intervalSeconds * 1000);
  const retrievalComplete = options.requestLimit === 1000 && raw.length < 1000 && to + intervalSeconds * 1000 <= now;
  return { observations, coverageFrom, coverageTo, complete, retrievalComplete };
}

/** A single shared, persisted candle-page loader for wallet imports and token
 * recovery. Its callers never need wallet accounting to authorize market data. */
export async function importHistoricalChartPage(input: {
  db: Pick<Pool, 'query'>; market: { importObservations(input: NodeMarketImport): Promise<void> };
  token: string; seconds: number; from: number; to: number; importId: string; now: number;
  foreground?: boolean; request?: typeof gmgnRequest;
}) {
  const { db, token, seconds, from, to } = input;
  const resolution = Object.entries(chartIntervals).find(([, value]) => value === seconds)?.[0];
  if (!/^0x[0-9a-f]{40}$/.test(token) || !resolution || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || to + seconds * 1000 > input.now) throw new Error('import_chart_window_invalid');
  const stored = (await db.query(`SELECT payload,observed_at FROM node_import_chart_pages WHERE token_address=$1 AND resolution=$2 AND from_at=$3 AND to_at=$4
    AND payload->>'requestLimit'='1000' ORDER BY observed_at DESC LIMIT 1`, [token, seconds, new Date(from), new Date(to)])).rows[0];
  let response: any = stored?.payload, observedAt = stored ? new Date(stored.observed_at).toISOString() : new Date(input.now).toISOString();
  if (!response) {
    const url = new URL('https://openapi.gmgn.ai/v1/market/token_kline');
    for (const [key, value] of Object.entries({ chain: 'bsc', timestamp: String(Math.floor(input.now / 1000)), client_id: randomUUID(), address: token, resolution, from: String(from), to: String(to), limit: '1000' })) url.searchParams.set(key, value);
    response = await (input.request ?? gmgnRequest)(url, { workload: 'market', priority: input.foreground ? 'chart' : 'prefetch', foreground: !!input.foreground, weight: 2, timeoutMs: 8000 });
  }
  const normalized = normalizeImportedChart(response, from, to, seconds, input.now, { requestLimit: 1000 });
  const body = response.data ?? response, raw = Array.isArray(body) ? body : body.list ?? body.candles;
  const payload = { data: raw, requestLimit: 1000 };
  await db.query(`INSERT INTO node_import_chart_pages(token_address,resolution,from_at,to_at,payload_hash,payload,observed_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING`,
    [token, seconds, new Date(from), new Date(to), chartImportHash(payload), JSON.stringify(payload), observedAt]);
  if (normalized.observations.length || normalized.retrievalComplete) await input.market.importObservations({ token, importId: input.importId, observations: normalized.observations,
    from: new Date(normalized.retrievalComplete ? from : normalized.coverageFrom!).toISOString(),
    to: new Date(normalized.retrievalComplete ? to + seconds * 1000 : normalized.coverageTo!).toISOString(), complete: true, observedAt });
  return { ...normalized, cacheHit: !!stored };
}
