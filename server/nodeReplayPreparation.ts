import { createHash } from 'node:crypto';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import type { ReplayPreparation, ReplayPreparationReason } from '../shared/replayPreparation.js';
import type { ReplayMarketChart } from '../shared/replayChart.js';
import type { TokenChart, ChartRange, WatchPricePoint } from '../shared/intelligence.js';
import type { NodeMarketChart, NodeMarketQuote } from '../shared/nodeMarket.js';
import { nodeMarketCoverageComplete, nodeMarketService } from './nodeMarket.js';
import { MarketDecimal } from './nodeMarketMath.js';

type Market = Pick<typeof nodeMarketService, 'chart' | 'quote'> & Partial<Pick<typeof nodeMarketService, 'requestHistoryWindow' | 'requestRefresh' | 'replaySamples'>>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const intervals = [60, 300, 3600, 14400, 86400];
const intervalName = (seconds: number) => seconds === 60 ? '1m' : seconds === 300 ? '5m' : seconds === 3600 ? '1h' : seconds === 14400 ? '4h' : '1d';
function marketPoint(time: number, priceUsd: string, supply: string | null, estimated: boolean): WatchPricePoint {
  return { timestamp: new Date(time).toISOString(), priceUsd,
    ...(supply && !estimated ? { marketCapUsd: MarketDecimal.parse(priceUsd).mul(MarketDecimal.parse(supply)).text() } : {}) };
}

/** Continuous imported retrieval may precede sampled node history. Raw node
 * coverage and genuinely observed prices are separate requirements. */
async function sampledReplaySuffix(market:Market,token:string,from:number,to:number,current:boolean,
  points:WatchPricePoint[],coverage:NodeMarketChart['coverage'],fineImportedPoints:WatchPricePoint[]) {
  if(!market.replaySamples)return null;
  let joined=from;
  for(const range of coverage.filter(range=>range.source==='imported').sort((left,right)=>Date.parse(left.from)-Date.parse(right.from))) {
    const start=Date.parse(range.from),end=Date.parse(range.to);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<joined)continue;
    if(start>joined)break;
    joined=Math.max(joined,end);
  }
  const imported=joined>from,join=Math.min(to,joined);
  const samples=await market.replaySamples(token,{from:new Date(join).toISOString(),to:new Date(to).toISOString(),limit:5000});
  if(samples.tokenAddress!==token||samples.truncated||Date.parse(samples.from)!==join||Date.parse(samples.to)!==to
    ||!nodeMarketCoverageComplete(new Date(join).toISOString(),new Date(to).toISOString(),samples.coverage.filter(range=>range.source==='node')))return null;
  const observed=new Map<number,WatchPricePoint>();
  const importedRanges=coverage.filter(range=>range.source==='imported');
  const coveredImported=(time:number)=>importedRanges.some(range=>Date.parse(range.from)<=time&&Date.parse(range.to)>=time);
  const coveredImportedInterval=(from:number,to:number)=>{
    let through=from;
    for(const range of [...importedRanges].sort((left,right)=>Date.parse(left.from)-Date.parse(right.from))) {
      const start=Date.parse(range.from),end=Date.parse(range.to);
      if(!Number.isFinite(start)||!Number.isFinite(end)||end<through)continue;
      // Provider retrieval boundaries are exact. Unlike adjacent BSC block
      // timestamps, they receive no 3-second join allowance.
      if(start>through)return false;
      through=Math.max(through,end);if(through>=to)return true;
    }
    return through>=to;
  };
  let importedInterior=false;
  for(const point of fineImportedPoints) {
    const time=Date.parse(point.timestamp);
    if(time>join&&time<=to&&coveredImported(time)){observed.set(time,point);importedInterior=true;}
  }
  for(const row of samples.observations) {
    const time=Date.parse(row.timestamp);
    if(!Number.isFinite(time)||time>to||time<join-180_000)return null;
    try {if(MarketDecimal.parse(row.priceUsd).n<=0n)return null;}catch{return null;}
    observed.set(time,marketPoint(time,row.priceUsd,row.supply,row.supplyEstimated));
  }
  const prefix=imported?points.filter(point=>Date.parse(point.timestamp)<=join):[];
  if(imported&&(!prefix.length||Date.parse(prefix[0].timestamp)>from))return null;
  const anchors=[...prefix.slice(-1),...[...observed.entries()].filter(([time])=>time<=join).map(([,point])=>point)]
    .sort((left,right)=>Date.parse(left.timestamp)-Date.parse(right.timestamp));
  const anchor=anchors.at(-1),anchorTime=Date.parse(anchor?.timestamp??'');
  if(!Number.isFinite(anchorTime)||anchorTime>join||join-anchorTime>180_000)return null;
  const suffix=[anchor!,...[...observed.entries()].filter(([time])=>time>anchorTime).sort(([left],[right])=>left-right).map(([,point])=>point)];
  let recoveredSparseInterval=false;
  for(let index=1;index<suffix.length;index++) {
    const left=Date.parse(suffix[index-1].timestamp),right=Date.parse(suffix[index].timestamp);
    if(right-left<=180_000)continue;
    if(!coveredImportedInterval(left,right))return null;
    // Genuine historical retrieval can prove a sparse interval even when it
    // contains no candles. Retain its actual endpoints; do not fill the gap.
    recoveredSparseInterval=true;
  }
  const end=Date.parse(suffix.at(-1)!.timestamp);
  if(end<(current?to-180_000:to))return null;
  const merged=new Map(prefix.map(point=>[Date.parse(point.timestamp),point]));
  for(const point of suffix)merged.set(Date.parse(point.timestamp),point);
  const ordered=[...merged.entries()].sort(([left],[right])=>left-right).map(([,point])=>point);
  if(ordered.length<2||Date.parse(ordered[0].timestamp)>from)return null;
  return {points:ordered,source:imported||importedInterior||recoveredSparseInterval?'mixed' as const:'node' as const,
    recentSource:importedInterior||recoveredSparseInterval?'mixed' as const:'node' as const};
}

/** Display adapters convert exact persisted prices only at the chart boundary. */
export function databaseChart(chart: NodeMarketChart, quote: NodeMarketQuote, period: ChartRange): TokenChart {
  const candles = chart.bars.map(bar => ({ time: Math.floor(Date.parse(bar.timestamp) / 1000), open: Number(bar.open),
    high: Number(bar.high), low: Number(bar.low), close: Number(bar.close), volume: Number(bar.volumeUsd ?? 0) }));
  const observations = new Map<number, WatchPricePoint>();
  for (const bar of chart.bars) {
    const first = Date.parse(bar.firstObservationAt ?? bar.timestamp);
    const last = bar.lastObservationAt ? Date.parse(bar.lastObservationAt) : bar.source === 'imported' ? first + bar.intervalSeconds * 1000 : first;
    observations.set(first, marketPoint(first, bar.open, bar.supply, bar.supplyEstimated));
    observations.set(last, marketPoint(last, bar.close, bar.supply, bar.supplyEstimated));
  }
  return { address: chart.tokenAddress, period, candles, points: [...observations.entries()].sort(([a], [b]) => a - b).map(([, point]) => point),
    source: chart.bars.length ? chart.source : 'unavailable', updatedAt: quote.timestamp ?? chart.bars.at(-1)?.timestamp ?? null,
    resolution: intervalName(chart.intervalSeconds), pending: false, stale: quote.stale,
    marketCapSupply: quote.supply, supplyCheckedAt: quote.timestamp, supplyPending: false, volumeCurrency: 'usd',
    marketCapEstimated: quote.supplyEstimated || chart.bars.some(bar => bar.supplyEstimated || !bar.supply),
    partialHistory: !chart.complete, historyComplete: chart.complete, fullHistory: chart.complete,
    ...(quote.priceUsd && quote.timestamp ? { currentQuote: { timestamp: quote.timestamp, priceUsd: quote.priceUsd } } : {}) };
}

/** Compatibility signature for the authorized Portfolio adapter; all reads are PostgreSQL. */
export async function loadNodeReplayMarketChart(token: string, first: number, last: number, current: boolean,
  supply: string | null, options: { market?: Market; now?: () => number; ending?: { timestamp: string; priceUsd: string } } = {}): Promise<ReplayMarketChart> {
  const market = options.market ?? nodeMarketService, now = options.now ?? Date.now;
  const quote = await market.quote(token), to = current ? Date.parse(options.ending?.timestamp ?? quote.timestamp ?? '') : last;
  if (!Number.isFinite(first) || !Number.isFinite(to) || to < last || to > now() + 1000) return {
    address: token, period: 'replay', candles: [], points: [], source: 'unavailable', resolution: '1m', pending: false, stale: true, updatedAt: null,
  };
  const intervalSeconds = intervals.find(interval => (to - first) / (interval * 1000) <= 1500) ?? 86400;
  let historical = await market.chart(token, { from: new Date(first).toISOString(), to: new Date(to).toISOString(), intervalSeconds, limit: 2000 });
  const tailFrom = Math.max(first, to - 6 * 3600_000);
  let recent = intervalSeconds > 60 ? await market.chart(token, { from: new Date(tailFrom).toISOString(), to: new Date(to).toISOString(), intervalSeconds: 60, limit: 400 }) : historical;
  // Completed candles cannot cover the fractional current minute. A genuine
  // frozen quote may bridge that short ending, provided all movements and
  // historical coverage precede it. The independent recent-price guard below
  // still rejects old bars; no candle or trading volume is manufactured.
  const completedMinute = Math.floor(to / 60_000) * 60_000;
  if (current && options.ending && (!historical.complete || !recent.complete) && completedMinute >= last && completedMinute >= first && completedMinute < to) {
    const completed = await market.chart(token, { from: new Date(first).toISOString(), to: new Date(completedMinute).toISOString(), intervalSeconds, limit: 2000 });
    const completedRecent = intervalSeconds > 60 ? await market.chart(token, { from: new Date(tailFrom).toISOString(), to: new Date(completedMinute).toISOString(), intervalSeconds: 60, limit: 400 }) : completed;
    if (completed.complete && completedRecent.complete) { historical = completed; recent = completedRecent; }
  }
  const points = new Map<number, WatchPricePoint>();
  const fineImportedPoints=new Map<number,WatchPricePoint>();
  for (const segment of [historical, ...(recent === historical ? [] : [recent])]) {
    const start = segment === recent && recent !== historical ? tailFrom : -Infinity;
    if (start !== -Infinity) for (const time of points.keys()) if (time >= start) points.delete(time);
    for (const bar of segment.bars) {
      const time = Date.parse(bar.firstObservationAt ?? bar.timestamp), end = bar.lastObservationAt ? Date.parse(bar.lastObservationAt) : Date.parse(bar.timestamp) + bar.intervalSeconds * 1000;
      if (time < start || time > to || end > now() || current && end > to) continue;
      points.set(time, marketPoint(time, bar.open, bar.supply, bar.supplyEstimated));
      points.set(end, marketPoint(end, bar.close, bar.supply, bar.supplyEstimated));
      if(segment.intervalSeconds===60&&bar.source==='imported') {
        fineImportedPoints.set(time,marketPoint(time,bar.open,bar.supply,bar.supplyEstimated));
        fineImportedPoints.set(end,marketPoint(end,bar.close,bar.supply,bar.supplyEstimated));
      }
    }
  }
  let ordered = [...points.entries()].sort(([a], [b]) => a - b).map(([, point]) => point);
  const incomplete=!historical.complete||current&&!recent.complete;
  const sampled=(incomplete||Date.parse(ordered.at(-1)?.timestamp??'')<(current?to-180_000:to)||ordered.length<2)
    ?await sampledReplaySuffix(market,token,first,to,current,ordered,[...historical.coverage,...recent.coverage],[...fineImportedPoints.values()]):null;
  if(sampled)ordered=sampled.points;
  return { ...databaseChart(historical, quote, '24h'), period: 'replay', source: sampled?.source??historical.source, points: ordered,
    partialHistory: !sampled&&incomplete, sparseHistory: !!sampled||historical.sparse||recent.sparse,
    ...(sampled?{historyComplete:true,fullHistory:true}:{}),
    marketCapSupply: supply, ...(intervalSeconds > 60||sampled ? { recentResolution: '1m', recentSource: sampled?.recentSource??recent.source } : {}),
    ...(current && options.ending ? { currentQuote: options.ending } : current && quote.priceUsd && quote.timestamp ? { currentQuote: { timestamp: quote.timestamp, priceUsd: quote.priceUsd } } : {}) };
}

export function createNodeReplayPreparation({ market = nodeMarketService, now = Date.now }: { market?: Market; now?: () => number } = {}) {
  const jobs = new Map<string, Promise<ReplayPreparation>>();
  async function build(activity: KolTokenActivity): Promise<ReplayPreparation> {
    const identity = activity.accountingSnapshot, accounting = activity.replayAccounting;
    const result: ReplayPreparation = { version: 2, status: 'pending', snapshotId: identity?.snapshotId ?? null, window: null,
      stages: { accounting: 'pending', chart: 'pending', valuation: 'pending' }, asOf: identity?.asOf ?? activity.generatedAt, activity };
    const fail = (reason: ReplayPreparationReason, pending: boolean): ReplayPreparation => ({ ...result,
      status: pending ? 'pending' : 'unavailable', reason, ...(pending ? { retryAfterMs: 2000 } : {}) });
    const reasons = [...(identity?.reasons ?? []), accounting?.coverage.reason ?? ''];
    if (!identity || !accounting) return fail('accounting_pending', true);
    if (!Number.isFinite(Date.parse(identity.asOf)) || now() - Date.parse(identity.asOf) > 180_000
      || !Number.isFinite(Date.parse(accounting.checkedAt)) || now() - Date.parse(accounting.checkedAt) > 180_000) return fail('accounting_pending', true);
    if (reasons.some(reason => /(?:mismatch|unreconciled|contradict|negative_balance)/.test(reason))) {
      result.stages.accounting = 'unavailable'; return fail('accounting_mismatch', false);
    }
    if (reasons.some(reason => /unsupported|decoder/.test(reason))) {
      result.stages.accounting = 'unavailable'; return fail('unsupported_decoder', false);
    }
    if (reasons.includes('native_trace_required')) return fail('accounting_pending', true);
    if (reasons.some(reason => /import_cooldown/.test(reason))) return { ...fail('provider_cooldown', true),
      retryAfterMs: accounting.retryAfterMs ?? activity.realizedAccounting?.retryAfterMs ?? 2000 };
    if (reasons.some(reason => /cost|fee|opening/.test(reason)) && !identity.complete) {
      result.stages.accounting = accounting.status === 'pending' ? 'pending' : 'unavailable'; return fail('unknown_costs', accounting.status === 'pending');
    }
    if (reasons.includes('quote_unavailable') && reasons.every(reason => !reason || reason === 'quote_unavailable')
      && accounting.coverage.transactionsComplete && accounting.coverage.balanceMatched) {
      await market.requestRefresh?.(activity.token.address, { priority: 10 });
      result.stages.accounting = 'ready'; result.stages.valuation = 'pending'; return fail('stale_quote', true);
    }
    if (accounting.status === 'pending') return fail('accounting_pending', true);
    if (!identity.complete || !accounting.coverage.transactionsComplete || !accounting.coverage.balanceMatched || !accounting.final) {
      result.stages.accounting = accounting.status === 'unavailable' ? 'unavailable' : 'pending';
      return fail(reasons.some(reason => /cost|fee|opening/.test(reason)) ? 'unknown_costs' : 'accounting_pending', accounting.status !== 'unavailable');
    }
    const events = accounting.history?.events ?? accounting.events;
    const times = events.map(event => Date.parse(event.timestamp)).filter(Number.isFinite);
    if (!times.length) return fail('accounting_pending', false);
    result.stages.accounting = 'ready';
    const open = activity.realizedAccounting?.position?.status === 'open';
    const from = Math.min(...times), last = Math.max(...times), final = accounting.final;
    const to = open ? Date.parse(final.timestamp) : last;
    if (!Number.isFinite(to) || to > now() + 1000) return fail('accounting_mismatch', false);
    if (open && to < last) {
      await market.requestRefresh?.(activity.token.address, { priority: 10 });
      result.stages.valuation = 'pending'; return fail('stale_quote', true);
    }
    result.window = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), id: hash([identity.snapshotId, from, to]) };
    const price = final.priceUsd;
    if (open && (!price || !Number.isFinite(Number(price)) || Number(price) <= 0 || now() - to > 180_000)) {
      await market.requestRefresh?.(activity.token.address, { priority: 10 });
      result.stages.valuation = 'pending'; return fail('stale_quote', true);
    }
    result.stages.valuation = 'ready';
    const chart = await loadNodeReplayMarketChart(activity.token.address, from, last, open, activity.token.marketCapSupply, {
      market, now, ...(open && price ? { ending: { timestamp: final.timestamp, priceUsd: price } } : {}) });
    const ordered = chart.points;
    const firstPoint = Date.parse(ordered[0]?.timestamp ?? ''), lastPoint = Date.parse(ordered.at(-1)?.timestamp ?? '');
    const coveredStart = Number.isFinite(firstPoint) && firstPoint <= from;
    // Closed histories need a real observation bracketing the final movement.
    // A minute of collection coverage cannot stand in for a missing price.
    const coveredEnd = Number.isFinite(lastPoint) && lastPoint >= (open ? to - 180_000 : to);
    if (chart.partialHistory || !coveredStart || !coveredEnd || ordered.length < 2) {
      // Repair the approved window itself. A closed position must not wait for
      // a generic recent-first backfill to traverse months of unrelated time.
      await market.requestHistoryWindow?.(activity.token.address, result.window.from, result.window.to, {
        snapshotId: identity.snapshotId, windowId: result.window.id, priority: 10,
      });
      result.stages.chart = 'pending'; return fail('chart_coverage', true);
    }
    // The frozen accounting mark wins over later independent quote refreshes.
    chart.marketCapSupply = activity.token.marketCapSupply;
    chart.updatedAt = final.timestamp;
    chart.stale = open && now() - Date.parse(final.timestamp) > 180_000;
    chart.snapshotId = identity.snapshotId;
    chart.windowId = result.window.id;
    result.stages.chart = 'ready';
    return { ...result, status: 'ready', chart };
  }
  return { prepare(activity: KolTokenActivity) {
    const key = hash([activity.kol.address, activity.token.address, activity.accountingSnapshot,
      (activity as KolTokenActivity & { journal?: unknown }).journal]);
    const existing = jobs.get(key); if (existing) return existing;
    const job = build(activity).finally(() => { if (jobs.get(key) === job) jobs.delete(key); }); jobs.set(key, job); return job;
  } };
}
export const nodeReplayPreparation = createNodeReplayPreparation();
