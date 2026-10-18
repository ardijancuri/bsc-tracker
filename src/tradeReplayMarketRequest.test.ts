import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayMarketChart } from '../shared/replayChart';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import { applyReplayMarketChart, prepareTradeReplayData, type TradeReplayData } from './tradeReplayData';
import { accountingEstimateNotice, accountingExactNotice, accountingUnavailableNotice, currentPriceUnavailableNotice, currentQuoteEstimateNotice, inventoryUnavailableNotice, recordedPriceEstimateNotice, replayMarketData, replayUsesRecordedPrices } from './tradeReplayMarketRequest';

const token = '0x2222222222222222222222222222222222222222';
const now = Date.parse('2026-10-11T12:00:00Z');

function data(): TradeReplayData {
  return {
    kol: { address: '0x1111111111111111111111111111111111111111', name: 'Trader', avatarUrl: null, twitter: null },
    token: { address: token, symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: 9, marketCapUsd: 9000 },
    trades: [
      { id: 'buy', txHash: 'buy', timestamp: '2026-10-11T10:01:15Z', side: 'buy', tokenAmount: 1, amountUsd: 1, priceUsd: 1, marketCapUsd: 1000 },
      { id: 'sell', txHash: 'sell', timestamp: '2026-10-11T10:09:45Z', side: 'sell', tokenAmount: 1, amountUsd: 5, priceUsd: 5, marketCapUsd: 5000 },
    ],
    position: { status: 'unknown', tokenBalance: null, tradeFlowMatched: false, tradesComplete: true, checkedAt: null },
    chart: { points: [], marketCapSupply: 1000, resolution: '5m', source: 'Recorded fills' },
    source: { chart: 'Recorded fills', tradesComplete: true }, realizedAccounting: { available: true }, generatedAt: new Date(now).toISOString(),
  };
}

function chart(): ReplayMarketChart {
  return {
    address: token, period: 'replay', candles: [],
    points: [...Array.from({ length: 11 }, (_, minute) => ({ timestamp: new Date(Date.parse('2026-10-11T10:00:00Z') + minute * 60000).toISOString(), priceUsd: String(1 + minute) })),
      { timestamp: new Date(now - 60_000).toISOString(), priceUsd: '7' }],
    source: 'gmgn', resolution: '1m', marketCapSupply: '1000', pending: false, stale: false, updatedAt: new Date(now).toISOString(),
  };
}

function deferredChart(loadStatus?: 'queued' | 'rate_limited', retryAfterMs = 3000): ReplayMarketChart {
  return { ...chart(), source: 'unavailable', points: [], updatedAt: null, loadStatus, retryAfterMs };
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function stubMarketFetcher(fetcher: (url: string, options: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', (url: string, options: RequestInit) => url.endsWith('/activity?replay=true&pnl=true')
    ? Promise.resolve(response({}, 404)) : fetcher(url, options));
}

function inventoryActivity(open = true): KolTokenActivity {
  const original = data();
  const trades = original.trades.map((trade, index) => ({ ...trade, txHash: `0x${String(index + 1).repeat(64)}`,
    tokenAmount: String(trade.tokenAmount), amountUsd: String(trade.amountUsd), priceUsd: String(trade.priceUsd), marketCapUsd: String(trade.marketCapUsd),
    walletAddress: original.kol.address, tokenAddress: token, blockNumber: String(index + 1), transactionIndex: 0,
    kolName: 'Trader', kolAvatarUrl: null, kolTwitter: null, tokenSymbol: 'TEST', tokenName: 'Test', tokenLogoUrl: null,
    quoteSymbol: 'BNB', quoteAmount: null, valuationStatus: 'valued' as const, realizedProfitUsd: null, cumulativeRealizedProfitUsd: null, source: 'node' }));
  if (open) { trades[1].tokenAmount = '0.5'; trades[1].amountUsd = '2.5'; }
  return { kol: { ...original.kol, source: 'node', lastSeenAt: null },
    token: { ...original.token, priceUsd: '9', marketCapUsd: '9000', marketCapSupply: '1000' }, trades,
    summary: {} as KolTokenActivity['summary'], generatedAt: new Date(now).toISOString(),
    coverage: { source: 'indexed', indexedTradeCount: 2, returnedTradeCount: 2, complete: true, historyLimit: 2000, costsIncluded: false },
    inventory: { version: 1, coverage: { complete: true, reconciled: true, fromBlock: '1', toBlock: '2',
      blockHash: `0x${'f'.repeat(64)}`, checkedAt: new Date(now).toISOString(), balance: open ? '0.5' : '0', status: 'verified' }, events: [
      { id: 'buy', kind: 'buy', tradeId: 'buy', txHash: trades[0].txHash, timestamp: trades[0].timestamp, blockNumber: '1', transactionIndex: 0,
        logIndex: null, tokenAmount: '1', remainingTokenAmount: '1', remainingCostBasisUsd: '1', cumulativeRealizedProfitUsd: '0', investedUsd: '1', soldUsd: '0' },
      { id: 'sell', kind: 'sell', tradeId: 'sell', txHash: trades[1].txHash, timestamp: trades[1].timestamp, blockNumber: '2', transactionIndex: 0,
        logIndex: null, tokenAmount: open ? '0.5' : '1', remainingTokenAmount: open ? '0.5' : '0', remainingCostBasisUsd: open ? '0.5' : '0',
        cumulativeRealizedProfitUsd: open ? '2' : '4', investedUsd: '1', soldUsd: open ? '2.5' : '5' },
    ] } };
}

function gmgnActivity(): KolTokenActivity {
  const activity = inventoryActivity(), inventory = activity.inventory!;
  activity.replayAccounting = { version: 1, source: 'gmgn', policy: 'gmgn_total_profit_v1', walletAddress: activity.kol.address, tokenAddress: token,
    status: 'ready', checkedAt: new Date(now).toISOString(), inventoryBlockNumber: '2', inventoryBlockHash: inventory.coverage.blockHash,
    coverage: { transactionsComplete: true, balanceMatched: true, exactFinal: true }, events: inventory.events.map((event, index) => ({ ...event,
      remainingCostBasisUsd: index ? '0.55' : '1.1', cumulativeRealizedProfitUsd: index ? '1.85' : '0',
      feesUsd: index ? '0.2' : '0.1', feeInclusiveCostUsd: index ? '1.2' : '1.1', transferOutIncomeUsd: '0' })),
    final: { remainingTokenAmount: '0.5', remainingCostBasisUsd: '0.55', cumulativeRealizedProfitUsd: '1.85', investedUsd: '1', soldUsd: '2.5',
      transferOutIncomeUsd: '0', feesUsd: '0.2', feeInclusiveCostUsd: '1.2', reportedProfitUsd: '4.8', reportedRoi: '4', priceUsd: '7',
      timestamp: new Date(now - 1000).toISOString() } };
  return activity;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bounded replay historical-market preparation', () => {
  it('allows an independently verified final aggregate when historical quote currencies cannot prove prefix fees', async () => {
    const activity = gmgnActivity();
    activity.summary.realizedProfitUsd = null;
    activity.replayAccounting!.coverage.reason = 'quote_or_fee_unavailable';
    for (const event of activity.replayAccounting!.events) {
      event.remainingCostBasisUsd = null;
      event.cumulativeRealizedProfitUsd = null;
      event.feesUsd = null;
      event.feeInclusiveCostUsd = null;
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(
      url.endsWith('/activity?replay=true&pnl=true') ? activity : chart()))));
    const result = await replayMarketData(data(), new AbortController().signal);
    expect(result.preparationStatus).toBe('ready');
    expect(result.accountingNotice).toBe(accountingExactNotice);
    expect(result.data.replayAccounting?.final).toMatchObject({ reportedProfitUsd: 4.8, reportedRoi: 4, cumulativeRealizedProfitUsd: 1.85 });
    expect(result.data.replayAccounting?.events.every(event => event.feesUsd === null && event.cumulativeRealizedProfitUsd === null)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts complete GMGN cash-flow totals without requiring an unavailable realized and held-basis split', async () => {
    const activity = gmgnActivity();
    activity.replayAccounting!.status = 'estimated';
    activity.replayAccounting!.coverage.exactFinal = false;
    activity.replayAccounting!.final = null;
    for (const event of activity.replayAccounting!.events) {
      event.remainingCostBasisUsd = null;
      event.cumulativeRealizedProfitUsd = null;
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true') ? activity
      : { ...chart(), currentQuote: { timestamp: new Date(now).toISOString(), priceUsd: '7' } }))));
    const result = await replayMarketData(data(), new AbortController().signal);
    expect(result.preparationStatus).toBe('ready');
    expect(result.accountingNotice).toBe(accountingEstimateNotice);
    expect(result.data.replayAccounting!.events.at(-1)!.remainingCostBasisUsd).toBeNull();
  });

  it('opts an older DTO without inventory into GMGN accounting and freezes the validated final provider quote', async () => {
    const original = data(), activity = gmgnActivity(); activity.inventory!.events.at(-1)!.remainingCostBasisUsd = null;
    const fetcher = vi.fn().mockResolvedValueOnce(response(activity)).mockResolvedValue(response({ ...chart(), currentQuote: { timestamp: new Date(now).toISOString(), priceUsd: '12' } }));
    vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(original, new AbortController().signal);
    expect(fetcher.mock.calls[0][0]).toMatch(/activity\?replay=true&pnl=true$/); expect(fetcher.mock.calls[0][1].cache).toBe('no-store');
    expect(result.data.replayAccounting?.status).toBe('ready'); expect(result.data.currentQuote?.priceUsd).toBe(7);
    expect(result.data.replayAccounting?.final).toMatchObject({ reportedProfitUsd: 4.8, reportedRoi: 4, feeInclusiveCostUsd: 1.2 });
    expect(result.accountingNotice).toBe(accountingExactNotice); expect(result.inventoryNotice).toBeUndefined();
    expect(result.currentPriceNotice).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    expect(result.preparationStatus).toBe('ready');
  });

  it('retries a network failure and a gateway failure without replacing the newly verified GMGN result with the old fill snapshot', async () => {
    const original = data(), activity = gmgnActivity(); let activityCalls = 0;
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (!url.endsWith('/activity?replay=true&pnl=true')) return Promise.resolve(response(chart()));
      activityCalls++;
      return activityCalls === 1 ? Promise.reject(new TypeError('Network request failed'))
        : Promise.resolve(activityCalls === 2 ? response({}, 503) : response(activity));
    });
    vi.stubGlobal('fetch', fetcher);
    const pending = replayMarketData(original, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(999); expect(activityCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(2000); expect(activityCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(activityCalls).toBe(3); expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.preparationStatus).toBe('ready'); expect(result.data.replayAccounting?.final?.reportedProfitUsd).toBe(4.8);
    expect(result.data.currentQuote?.priceUsd).toBe(7); expect(vi.getTimerCount()).toBe(0);
  });

  it('never marks a fill-only curve exportable even when GMGN profit and a fresh endpoint are independently valid', async () => {
    for (const deferred of [false, true]) {
      const activity = gmgnActivity(), unavailable = deferredChart(deferred ? 'rate_limited' : undefined, 30_000);
      const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true') ? activity : unavailable)));
      vi.stubGlobal('fetch', fetcher);
      const result = await replayMarketData(data(), new AbortController().signal);
      expect(result.data.replayAccounting?.final?.reportedProfitUsd).toBe(4.8); expect(result.data.currentQuote?.priceUsd).toBe(7);
      expect(result.data.chart.source).toBe('Recorded fills'); expect(result.preparationStatus).toBe(deferred ? 'pending' : 'unavailable');
      expect(result.retryAfterMs).toBe(deferred ? 30_000 : undefined); expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('does not authorize transaction-based recorded observations until genuine market history replaces them', async () => {
    for (const genuine of [false, true]) {
      const original = data(), activity = gmgnActivity();
      original.source.chart = original.chart.source = 'Recorded observations';
      original.chart.points = chart().points.map(point => ({ timestamp: point.timestamp, priceUsd: Number(point.priceUsd), marketCapUsd: Number(point.priceUsd) * 1000 }));
      const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true') ? activity
        : genuine ? chart() : deferredChart())));
      vi.stubGlobal('fetch', fetcher);
      const result = await replayMarketData(original, new AbortController().signal);
      expect(result.preparationStatus).toBe(genuine ? 'ready' : 'unavailable');
      expect(result.data.chart.source).toBe(genuine ? 'GMGN historical samples' : 'Recorded observations');
      expect(result.data.replayAccounting?.final?.reportedProfitUsd).toBe(4.8); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('retains genuine sparse cached observations during cooldown and accepts their fresh provider endpoint without additional requests', async () => {
    const activity = gmgnActivity(), observed = { ...chart(), loadStatus: 'rate_limited' as const, retryAfterMs: 30_000, sparseHistory: true };
    observed.points = [observed.points[0], observed.points[5], observed.points[10], observed.points.at(-1)!];
    const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true') ? activity : observed)));
    vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(data(), new AbortController().signal);
    expect(result.preparationStatus).toBe('ready'); expect(result.data.chart.source).toBe('GMGN historical samples');
    expect(result.data.chart.sparseHistory).toBe(true); expect(result.data.currentQuote?.priceUsd).toBe(7);
    expect(result.notice).toBe('Market observations are sparse. Prices and P&L between observations are estimates.');
    expect(result.accountingNotice).toBe(accountingExactNotice);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['queued', 'rate_limited'] as const)('clears a %s background-refresh notice when cached observations already cover a verified closed replay', async loadStatus => {
    const activity = gmgnActivity(), closed = inventoryActivity(false);
    activity.trades = closed.trades; activity.inventory = closed.inventory;
    Object.assign(activity.replayAccounting!.events[1], { remainingTokenAmount: '0', remainingCostBasisUsd: '0',
      cumulativeRealizedProfitUsd: '3.8', soldUsd: '5' });
    Object.assign(activity.replayAccounting!.final!, { remainingTokenAmount: '0', remainingCostBasisUsd: '0',
      cumulativeRealizedProfitUsd: '3.8', soldUsd: '5', reportedProfitUsd: '3.8', reportedRoi: String(3.8 / 1.2) });
    const observed = { ...chart(), points: chart().points.slice(0, 11), loadStatus, retryAfterMs: 30_000 };
    const fetcher = vi.fn((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true') ? activity : observed)));
    vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(data(), new AbortController().signal);
    expect(fetcher.mock.calls[1][0]).toMatch(/replay-chart\?end=current$/);
    expect(result.preparationStatus).toBe('ready'); expect(result.data.position.status).toBe('closed');
    expect(result.notice).toBeNull(); expect(result.accountingNotice).toBe(accountingExactNotice);
    expect(result.data.chart.source).toBe('GMGN historical samples');
    expect(result.retryAfterMs).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['response', 'retained'] as const)('waits for post-trade observations when %s history ends a day before the current quote', async mode => {
    const activity = gmgnActivity(), oldHistory = chart();
    for (const trade of activity.trades) trade.timestamp = new Date(Date.parse(trade.timestamp) - 86_400_000).toISOString();
    for (const event of activity.inventory!.events) event.timestamp = new Date(Date.parse(event.timestamp) - 86_400_000).toISOString();
    for (const event of activity.replayAccounting!.events) event.timestamp = new Date(Date.parse(event.timestamp) - 86_400_000).toISOString();
    oldHistory.points = oldHistory.points.slice(0, 11).map(point => ({ ...point, timestamp: new Date(Date.parse(point.timestamp) - 86_400_000).toISOString() }));
    let original = prepareTradeReplayData(activity, null, null, now)!;
    if (mode === 'retained') original = applyReplayMarketChart(original, oldHistory, now);
    const fetcher = vi.fn((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true') ? activity
      : mode === 'retained' ? deferredChart() : oldHistory)));
    vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(original, new AbortController().signal);
    expect(result.preparationStatus).toBe('pending'); expect(result.retryAfterMs).toBeGreaterThanOrEqual(3000);
    expect(result.data.currentQuote?.priceUsd).toBe(7); expect(result.data.replayAccounting?.final?.reportedProfitUsd).toBe(4.8);
    expect(result.notice).toMatch(/still loading/); expect(result.data.chart.points.at(-1)?.timestamp).toBe(oldHistory.points.at(-1)?.timestamp);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ resolution: '1m', lag: 180_000 }, { resolution: '5m', lag: 600_000 }, { resolution: '1h', lag: 7_200_000 }])('allows normal $resolution observation spacing at an open quote', async ({ resolution, lag }) => {
    const activity = gmgnActivity(), observed = chart();
    observed.resolution = resolution;
    // Coarse bars belong to an older position whose final movement is already
    // covered by observations before the normal two-bar quote gap.
    if (resolution === '1h') {
      for (const trade of activity.trades) trade.timestamp = new Date(Date.parse(trade.timestamp) - 21_600_000).toISOString();
      for (const event of [...activity.inventory!.events, ...activity.replayAccounting!.events]) event.timestamp = new Date(Date.parse(event.timestamp) - 21_600_000).toISOString();
      observed.points = observed.points.slice(0, 11).map(point => ({ ...point, timestamp: new Date(Date.parse(point.timestamp) - 21_600_000).toISOString() }));
    }
    observed.points = observed.points.filter(point => Date.parse(point.timestamp) <= now - lag - 1000);
    observed.points.push({ timestamp: new Date(now - lag - 1000).toISOString(), priceUsd: '7' });
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true') ? activity : observed))));
    const result = await replayMarketData(data(), new AbortController().signal);
    expect(result.preparationStatus).toBe('ready');
  });

  it('requests a fresh current endpoint when an initially checked closed selection has since reopened', async () => {
    const original = data(); original.position.status = 'closed';
    const activity = gmgnActivity(); activity.replayAccounting!.status = 'estimated'; activity.replayAccounting!.coverage.exactFinal = false; activity.replayAccounting!.final = null;
    const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true') ? activity
      : url.endsWith('?end=current') ? { ...chart(), currentQuote: { timestamp: new Date(now).toISOString(), priceUsd: '12' } } : chart())));
    vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(original, new AbortController().signal);
    const chartUrls = fetcher.mock.calls.map(call => call[0]).filter(url => url.includes('/replay-chart'));
    expect(chartUrls[0]).toMatch(/replay-chart$/); expect(chartUrls[1]).toMatch(/replay-chart\?end=current$/);
    expect(result.preparationStatus).toBe('ready'); expect(result.data.position.status).toBe('open'); expect(result.data.currentQuote?.priceUsd).toBe(12);
  });

  it('paces explicitly pending GMGN accounting before accepting a disclosed provider-derived estimate', async () => {
    const pendingActivity = gmgnActivity(), estimated = structuredClone(pendingActivity);
    pendingActivity.replayAccounting!.status = 'pending'; pendingActivity.replayAccounting!.retryAfterMs = 3000;
    estimated.replayAccounting!.status = 'estimated'; estimated.replayAccounting!.coverage.exactFinal = false; estimated.replayAccounting!.final = null;
    let activityCalls = 0;
    const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true')
      ? activityCalls++ === 0 ? pendingActivity : estimated : chart())));
    vi.stubGlobal('fetch', fetcher);
    const pending = replayMarketData(data(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2999); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(fetcher).toHaveBeenCalledTimes(3); expect(result.data.replayAccounting?.status).toBe('estimated');
    expect(result.data.replayAccounting?.events[1].feeInclusiveCostUsd).toBe(1.2);
    expect(result.accountingNotice).toBe(accountingEstimateNotice); expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a temporarily busy reported aggregate instead of exporting a different estimate first', async () => {
    const reported = gmgnActivity(), estimate = structuredClone(reported);
    estimate.replayAccounting!.status = 'estimated'; estimate.replayAccounting!.final = null;
    estimate.replayAccounting!.coverage.exactFinal = false;
    estimate.replayAccounting!.coverage.reason = 'aggregate_provider_busy';
    estimate.replayAccounting!.retryAfterMs = 2500;
    let activityCalls = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true')
      ? activityCalls++ === 0 ? estimate : reported : chart()))));
    const pending = replayMarketData(data(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2499); expect(activityCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(activityCalls).toBe(2); expect(result.preparationStatus).toBe('ready');
    expect(result.data.replayAccounting?.final?.reportedProfitUsd).toBe(4.8);
    expect(result.accountingNotice).toBe(accountingExactNotice); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['aggregate_provider_rate_limited', 'historical_cache_provider_rate_limited'])('uses a complete reconciled estimate during %s without waiting for the optional exact aggregate', async reason => {
    const activity = gmgnActivity();
    activity.replayAccounting!.status = 'estimated'; activity.replayAccounting!.final = null;
    activity.replayAccounting!.coverage.exactFinal = false;
    activity.replayAccounting!.coverage.reason = reason;
    activity.replayAccounting!.retryAfterMs = 60_000;
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true') ? activity
      : { ...chart(), currentQuote: { timestamp: new Date(now).toISOString(), priceUsd: '7' } }))));
    const result = await replayMarketData(data(), new AbortController().signal);
    expect(result.preparationStatus).toBe('ready'); expect(result.retryAfterMs).toBeUndefined();
    expect(result.data.replayAccounting?.events.at(-1)?.feeInclusiveCostUsd).toBe(1.2);
    expect(result.accountingNotice).toBe(accountingEstimateNotice); expect(vi.getTimerCount()).toBe(0);
  });

  function markedActivity() {
    const activity=gmgnActivity();
    activity.realizedAccounting={version:1,source:'gmgn',policy:'gmgn_realized_profit_v1',walletAddress:activity.kol.address,tokenAddress:token,
      status:'ready',checkedAt:new Date(now).toISOString(),realizedProfitUsd:'1.85',coverage:{transactionsComplete:true,balanceMatched:true},
      position:{status:'open',remainingTokenAmount:'0.5',remainingCostBasisUsd:'0.55',feeInclusiveCostUsd:'1.2',
        cashFlow:{investedUsd:'1',soldUsd:'2.5',transferOutIncomeUsd:'0',feesUsd:'0.2'},estimatedProfitUsd:'4.8',estimatedRoi:'4',unrealizedProfitUsd:'2.95',
        priceUsd:'7',pricedAt:new Date(now-1000).toISOString(),valuationSource:'market'}};
    return activity;
  }

  it('reuses the matching modal mark while both providers cool down, without silently repricing the estimate', async()=>{
    const activity=markedActivity();
    Object.assign(activity.replayAccounting!,{status:'estimated',final:null,retryAfterMs:60_000});
    Object.assign(activity.replayAccounting!.coverage,{exactFinal:false,reason:'historical_cache_provider_rate_limited'});
    const fetcher=vi.fn((url:string)=>Promise.resolve(response(url.includes('/activity?')?activity
      :{...chart(),loadStatus:'rate_limited',retryAfterMs:60_000,currentQuote:{timestamp:new Date(now).toISOString(),priceUsd:'20'}})));
    vi.stubGlobal('fetch',fetcher);
    const result=await replayMarketData(data(),new AbortController().signal);
    expect(result.preparationStatus).toBe('ready');expect(result.data.currentQuote).toMatchObject({priceUsd:7,timestamp:activity.realizedAccounting!.position!.pricedAt,source:'position'});
    expect(result.accountingNotice).toBe(accountingEstimateNotice);expect(fetcher).toHaveBeenCalledTimes(2);expect(Date.now()).toBe(now);
  });

  it.each(['stale','future','wallet','token','quantity','coverage','source','cost','cashflow','expiredProof'] as const)('rejects a %s modal valuation',variant=>{
    const activity=markedActivity(),marked=activity.realizedAccounting!;
    if(variant==='stale')marked.position!.pricedAt=new Date(now-180_001).toISOString();
    if(variant==='future')marked.position!.pricedAt=new Date(now+1001).toISOString();
    if(variant==='wallet')marked.walletAddress=token;
    if(variant==='token')marked.tokenAddress=activity.kol.address;
    if(variant==='quantity')marked.position!.remainingTokenAmount='0.50000000000000001';
    if(variant==='coverage')marked.coverage.balanceMatched=false;
    if(variant==='source')marked.position!.valuationSource=null;
    if(variant==='cost')marked.position!.feeInclusiveCostUsd='1.3';
    if(variant==='cashflow')activity.replayAccounting!.events.at(-1)!.soldUsd='2.6';
    if(variant==='expiredProof')marked.checkedAt=new Date(now-180_001).toISOString();
    expect(prepareTradeReplayData(activity,null,null,now)!.currentQuote).toBeUndefined();
  });

  it('keeps missing ending fees or costs blocked during a provider cooldown',async()=>{
    const activity=markedActivity();
    Object.assign(activity.replayAccounting!,{status:'estimated',final:null,retryAfterMs:60_000});
    Object.assign(activity.replayAccounting!.coverage,{exactFinal:false,reason:'aggregate_provider_rate_limited'});
    activity.replayAccounting!.events.at(-1)!.feeInclusiveCostUsd=null;
    vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(response(url.includes('/activity?')?activity:chart()))));
    const result=await replayMarketData(data(),new AbortController().signal);
    expect(result.preparationStatus).toBe('pending');expect(result.retryAfterMs).toBe(60_000);expect(result.accountingNotice).toBe(accountingUnavailableNotice);
  });

  it('accepts genuine CoinMarketCap observations covering the complete replay window',async()=>{
    const activity=gmgnActivity();
    vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(response(url.includes('/activity?')?activity:{...chart(),source:'coinmarketcap'}))));
    const result=await replayMarketData(data(),new AbortController().signal);
    expect(result.preparationStatus).toBe('ready');expect(result.data.chart.source).toBe('CoinMarketCap historical samples');
  });

  it('identifies a missing price rather than missing costs when estimated cash flows are complete',async()=>{
    const activity=gmgnActivity();Object.assign(activity.replayAccounting!,{status:'estimated',final:null});activity.replayAccounting!.coverage.exactFinal=false;
    vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(response(url.includes('/activity?')?activity:deferredChart()))));
    const result=await replayMarketData(data(),new AbortController().signal);
    expect(result.blockingReason).toBe('stale_quote');expect(result.preparationStatus).toBe('unavailable');
  });

  it('does not let an optional aggregate cooldown delay independent chart recovery',async()=>{
    const activity=gmgnActivity();Object.assign(activity.replayAccounting!,{status:'estimated',final:null,retryAfterMs:120_000});
    Object.assign(activity.replayAccounting!.coverage,{exactFinal:false,reason:'aggregate_provider_rate_limited'});
    vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(response(url.includes('/activity?')?activity:deferredChart('rate_limited',30_000)))));
    const result=await replayMarketData(data(),new AbortController().signal);
    expect(result.preparationStatus).toBe('pending');expect(result.retryAfterMs).toBe(30_000);expect(result.blockingReason).toBe('stale_quote');
  });

  it('uses the recent one-minute segment freshness bound instead of a coarse historical interval',async()=>{
    const activity=gmgnActivity(),observed={...chart(),resolution:'1h',recentResolution:'1m' as const,recentSource:'gmgn' as const};
    observed.points=observed.points.filter(point=>Date.parse(point.timestamp)<=now-240_000);
    vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(response(url.includes('/activity?')?activity:observed))));
    const result=await replayMarketData(data(),new AbortController().signal);
    expect(result.preparationStatus).toBe('pending');expect(result.data.chart.recentResolution).toBe('1m');
  });

  it('reports unavailable ending profit for an estimated envelope with unknown fees while retaining known earlier snapshots', async () => {
    const activity = gmgnActivity();
    activity.replayAccounting!.status = 'estimated'; activity.replayAccounting!.coverage.exactFinal = false; activity.replayAccounting!.final = null;
    activity.replayAccounting!.events[1].feesUsd = activity.replayAccounting!.events[1].feeInclusiveCostUsd = null;
    const fetcher = vi.fn().mockResolvedValueOnce(response(activity)).mockResolvedValue(response(chart())); vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(data(), new AbortController().signal);
    expect(result.accountingNotice).toBe(accountingUnavailableNotice); expect(result.data.replayAccounting?.status).toBe('estimated');
    expect(result.data.replayAccounting?.events[0]).toMatchObject({ feesUsd: .1, feeInclusiveCostUsd: 1.1, remainingCostBasisUsd: 1.1 });
    expect(result.data.replayAccounting?.events[1].feeInclusiveCostUsd).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an explicit unavailable marker for missing or invalid GMGN accounting and does not shorten an excessive provider cooldown', async () => {
    for (const variant of ['missing', 'invalid', 'cooldown'] as const) {
      const activity = gmgnActivity();
      if (variant === 'missing') delete activity.replayAccounting;
      if (variant === 'invalid') activity.replayAccounting!.walletAddress = token;
      if (variant === 'cooldown') { activity.replayAccounting!.status = 'pending'; activity.replayAccounting!.retryAfterMs = 30_000; }
      const fetcher = vi.fn().mockResolvedValueOnce(response(activity)).mockResolvedValue(response(chart())); vi.stubGlobal('fetch', fetcher);
      const result = await replayMarketData(data(), new AbortController().signal);
      expect(result.data.replayAccounting?.status, variant).toBe(variant === 'cooldown' ? 'pending' : 'unavailable'); expect(result.data.replayAccounting?.final, variant).toBeNull();
      expect(result.accountingNotice, variant).toBe(variant === 'cooldown' ? undefined : accountingUnavailableNotice); expect(fetcher, variant).toHaveBeenCalledTimes(2);
      expect(Date.now(), variant).toBe(now); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('cancels a GMGN accounting cooldown before another activity request', async () => {
    const activity = gmgnActivity(); activity.replayAccounting!.status = 'pending'; activity.replayAccounting!.retryAfterMs = 3000;
    const fetcher = vi.fn().mockResolvedValue(response(activity)); vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController(), pending = replayMarketData(data(), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1000); controller.abort(); await rejected;
    await vi.advanceTimersByTimeAsync(30_000); expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not restart the full provider cooldown after waiting for concurrent historical work', async () => {
    const activity = gmgnActivity(); activity.replayAccounting!.status = 'pending'; activity.replayAccounting!.retryAfterMs = 30_000;
    const fetcher = vi.fn((url: string) => url.endsWith('/activity?replay=true&pnl=true') ? Promise.resolve(response(activity))
      : new Promise<Response>(resolve => setTimeout(() => resolve(response(chart())), 10_000)));
    vi.stubGlobal('fetch', fetcher);
    const pending = replayMarketData(data(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.preparationStatus).toBe('pending'); expect(result.retryAfterMs).toBe(20_000);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes the exact pair without caching and replaces stale trades and balances before requesting a current endpoint', async () => {
    const previous = inventoryActivity(false), latest = inventoryActivity(true);
    previous.inventory!.coverage.checkedAt = new Date(now - 180_001).toISOString();
    const original = prepareTradeReplayData(previous, null, null, now)!;
    const observed = { ...chart(), currentQuote: { timestamp: new Date(now).toISOString(), priceUsd: '12' } };
    const fetcher = vi.fn().mockResolvedValueOnce(response(latest)).mockResolvedValue(response(observed)); vi.stubGlobal('fetch', fetcher);
    const result = await replayMarketData(original, new AbortController().signal);
    expect(fetcher.mock.calls[0][0]).toBe(`/api/kols/${original.kol.address}/tokens/${token}/activity?replay=true&pnl=true`);
    expect(fetcher.mock.calls[0][1].cache).toBe('no-store');
    expect(fetcher.mock.calls[1][0]).toBe(`/api/kols/${original.kol.address}/tokens/${token}/replay-chart?end=current`);
    expect(result.data.trades[1].tokenAmount).toBe(.5); expect(result.data.position.tokenBalance).toBe(.5);
    expect(result.data.inventory?.events.at(-1)?.remainingCostBasisUsd).toBe(.5);
    expect(result.data.currentQuote?.priceUsd).toBe(12); expect(result.inventoryNotice).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not authorize swap-only estimates when an activity refresh fails, mismatches the pair, or omits inventory', async () => {
    for (const variant of ['failure', 'wrong-pair', 'missing-inventory'] as const) {
      const activity = inventoryActivity(), original = prepareTradeReplayData(activity, null, null, now)!;
      const body = structuredClone(activity);
      if (variant === 'wrong-pair') body.kol.address = token;
      if (variant === 'missing-inventory') delete body.inventory;
      const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(url.endsWith('/activity?replay=true&pnl=true')
        ? response(body, variant === 'failure' ? 502 : 200) : response(chart())));
      vi.stubGlobal('fetch', fetcher);
      const pending = replayMarketData(original, new AbortController().signal);
      if (variant === 'failure') await vi.advanceTimersByTimeAsync(3000);
      const result = await pending;
      expect(result.data.inventory, variant).toBeDefined(); expect(result.data.inventory?.coverage.reconciled, variant).toBe(false);
      expect(result.data.position.status, variant).toBe('unknown'); expect(result.inventoryNotice, variant).toBe(inventoryUnavailableNotice);
      expect(result.preparationStatus, variant).not.toBe('ready'); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('paces pending inventory refreshes and stops after three attempts without discarding the coverage gate', async () => {
    const activity = inventoryActivity(), original = prepareTradeReplayData(activity, null, null, now)!;
    activity.inventory!.coverage = { ...activity.inventory!.coverage, complete: false, reconciled: false, status: 'pending', reason: 'scan_pending' };
    const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/activity?replay=true&pnl=true') ? activity : chart())));
    vi.stubGlobal('fetch', fetcher);
    const pending = replayMarketData(original, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(999); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000); expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(fetcher).toHaveBeenCalledTimes(4); expect(result.inventoryNotice).toBe(inventoryUnavailableNotice);
    expect(result.data.inventory?.coverage.reason).toBe('scan_pending'); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds hung parallel activity and history requests inside the same 22-second session', async () => {
    const original = prepareTradeReplayData(inventoryActivity(), null, null, now)!;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetcher);
    const pending = replayMarketData(original, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15_000); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(7000);
    const result = await pending;
    expect(result.notice).toMatch(/timed out/); expect(result.inventoryNotice).toBe(inventoryUnavailableNotice);
    expect(result.preparationStatus).toBe('pending'); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    expect(result.data.inventory?.coverage.reconciled).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes a cold six-second pending scan then fourteen-second GMGN preparation while real history loads concurrently', async () => {
    const waiting = gmgnActivity(), ready = gmgnActivity(), original = data();
    waiting.inventory!.coverage = { ...waiting.inventory!.coverage, complete: false, reconciled: false, status: 'pending', reason: 'scan_pending' };
    waiting.replayAccounting!.status = 'pending';
    let activityCalls = 0;
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (!url.endsWith('/activity?replay=true&pnl=true')) return Promise.resolve(response(chart()));
      const first = activityCalls++ === 0;
      return new Promise<Response>(resolve => setTimeout(() => resolve(response(first ? waiting : ready)), first ? 6000 : 14_000));
    });
    vi.stubGlobal('fetch', fetcher);
    const pending = replayMarketData(original, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls[1][0]).toMatch(/replay-chart\?end=current$/);
    await vi.advanceTimersByTimeAsync(1000); expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8000); expect(fetcher.mock.calls[2][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(6000);
    const result = await pending;
    expect(fetcher).toHaveBeenCalledTimes(3); expect(result.preparationStatus).toBe('ready');
    expect(result.data.replayAccounting?.final?.reportedProfitUsd).toBe(4.8); expect(result.data.currentQuote?.priceUsd).toBe(7);
    expect(result.data.chart.source).toBe('GMGN historical samples'); expect(result.inventoryNotice).toBeUndefined();
    expect(Date.now() - now).toBe(21_000); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending inventory refresh and its concurrent history work before another attempt', async () => {
    const activity = inventoryActivity(), original = prepareTradeReplayData(activity, null, null, now)!;
    activity.inventory!.coverage.status = 'pending'; activity.inventory!.coverage.complete = activity.inventory!.coverage.reconciled = false;
    const fetcher = vi.fn().mockResolvedValue(response(activity)); vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController(), pending = replayMarketData(original, controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(500); controller.abort(); await rejection;
    await vi.advanceTimersByTimeAsync(30_000); expect(fetcher).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('reports unknown incoming basis and rejects inventory proof that expires during market retries', async () => {
    const activity = inventoryActivity(), original = prepareTradeReplayData(activity, null, null, now)!;
    activity.inventory!.events.at(-1)!.remainingCostBasisUsd = null;
    const fetcher = vi.fn().mockResolvedValueOnce(response(activity)).mockResolvedValue(response(chart())); vi.stubGlobal('fetch', fetcher);
    const unknownBasis = await replayMarketData(original, new AbortController().signal);
    expect(unknownBasis.data.position.status).toBe('open'); expect(unknownBasis.inventoryNotice).toBeUndefined();
    activity.inventory!.events.at(-1)!.remainingCostBasisUsd = '0.5';
    activity.inventory!.coverage.checkedAt = new Date(now - 179_000).toISOString();
    const retrying = vi.fn().mockResolvedValueOnce(response(activity)).mockResolvedValueOnce(response(deferredChart('queued', 3000))).mockResolvedValue(response(chart()));
    vi.stubGlobal('fetch', retrying);
    const pending = replayMarketData(original, new AbortController().signal); await vi.advanceTimersByTimeAsync(3000);
    const expired = await pending;
    expect(expired.data.inventory?.coverage.reconciled).toBe(false); expect(expired.data.position.status).toBe('unknown');
    expect(expired.inventoryNotice).toBe(inventoryUnavailableNotice); expect(vi.getTimerCount()).toBe(0);
  });

  it('waits through queued and rate-limited responses before applying genuine history without changing accounting', async () => {
    const original = data();
    const fetcher = vi.fn().mockResolvedValueOnce(response(deferredChart('queued', 3000)))
      .mockResolvedValueOnce(response(deferredChart('rate_limited', 2000))).mockResolvedValue(response(chart()));
    stubMarketFetcher(fetcher);
    const pending = replayMarketData(original, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(fetcher).toHaveBeenCalledTimes(3); expect(result.notice).toBeNull();
    expect(result.data.chart.resolution).toBe('1m'); expect(result.data.chart.points.at(-1)?.timestamp).toBe('2026-10-11T10:09:45.000Z');
    expect(result.data.trades).toBe(original.trades); expect(result.data.position).toBe(original.position);
    expect(result.data.realizedAccounting).toBe(original.realizedAccounting);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds repeated queue deferrals and uses at least a one-second delay', async () => {
    const original = data();
    const fetcher = vi.fn().mockResolvedValue(response(deferredChart('queued', 1)));
    stubMarketFetcher(fetcher);
    const pending = replayMarketData(original, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(4999); expect(fetcher).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ data: original, notice: 'Historical market data is still loading; the replay is using available data.' });
    expect(fetcher).toHaveBeenCalledTimes(6); expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a cooldown beyond the remaining session budget without shortening it or sending more requests', async () => {
    const original = data(), fetcher = vi.fn().mockResolvedValue(response(deferredChart('rate_limited', 30_000)));
    stubMarketFetcher(fetcher);
    const result = await replayMarketData(original, new AbortController().signal);
    expect(result).toMatchObject({ data: original, notice: 'Historical market data is rate limited; the replay is using available data.' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(Date.now()).toBe(now); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry permanently missing or partial history despite a retryAfterMs field', async () => {
    for (const body of [deferredChart(undefined, 1000), { ...chart(), partialHistory: true }]) {
      const original = data(), fetcher = vi.fn().mockResolvedValue(response(body));
      stubMarketFetcher(fetcher);
      const result = await replayMarketData(original, new AbortController().signal);
      expect(result.data).toMatchObject(original); expect(result.notice).toMatch(/unavailable/);
      expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('discloses recorded-price estimates only when the retained replay has fill-only or empty chart data', async () => {
    const fallback = data();
    stubMarketFetcher(vi.fn().mockResolvedValue(response(deferredChart())));
    const result = await replayMarketData(fallback, new AbortController().signal);
    expect(result.notice).toBe(recordedPriceEstimateNotice); expect(replayUsesRecordedPrices(result.data)).toBe(true);

    const genuine = data();
    genuine.source.chart = genuine.chart.source = 'Historical market samples';
    genuine.chart.points = [{ timestamp: '2026-10-11T10:01:15Z', priceUsd: 1, marketCapUsd: 1000 }];
    const retained = await replayMarketData(genuine, new AbortController().signal);
    expect(retained.data).toMatchObject(genuine); expect(replayUsesRecordedPrices(retained.data)).toBe(false);
    expect(retained.notice).toBe('Historical market data is unavailable for this replay.');
    genuine.chart.points = [];
    expect(replayUsesRecordedPrices(genuine)).toBe(true);
  });

  it('accepts sparse observations bracketing the trade window and discloses interpolated estimates', async () => {
    const original = data(), observed = chart();
    observed.points = [observed.points[0], observed.points[6], observed.points[10]];
    observed.sparseHistory = true;
    const fetcher = vi.fn().mockResolvedValue(response(observed)); stubMarketFetcher(fetcher);
    const result = await replayMarketData(original, new AbortController().signal);
    expect(result.data).not.toMatchObject(original); expect(result.data.trades).toBe(original.trades);
    expect(result.data.position).toBe(original.position); expect(result.data.realizedAccounting).toBe(original.realizedAccounting);
    expect(result.data.chart.source).toBe('GMGN historical samples'); expect(replayUsesRecordedPrices(result.data)).toBe(false);
    expect(result.notice).toBe('Market observations are sparse. Prices and P&L between observations are estimates.');
    expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('requests a current endpoint only for a checked or complete recorded open position', async () => {
    for (const variant of ['recorded-open', 'checked-open', 'checked-closed'] as const) {
      const original = data();
      if (variant !== 'checked-open') original.trades[1].tokenAmount = .5;
      if (variant === 'checked-open') original.position.status = 'open';
      if (variant === 'checked-closed') original.position.status = 'closed';
      const fetcher = vi.fn().mockResolvedValue(response(chart())); stubMarketFetcher(fetcher);
      await replayMarketData(original, new AbortController().signal);
      expect(fetcher.mock.calls[0][0].endsWith('?end=current')).toBe(variant !== 'checked-closed');
    }
  });

  it('keeps a quote-only endpoint and discloses interpolation from fills when market history is unavailable', async () => {
    const original = data(); original.trades[1].tokenAmount = .5;
    const unavailable = { ...deferredChart(), currentQuote: { timestamp: new Date(now).toISOString(), priceUsd: '12' } };
    const fetcher = vi.fn().mockResolvedValue(response(unavailable)); stubMarketFetcher(fetcher);
    const result = await replayMarketData(original, new AbortController().signal);
    expect(result.data.currentQuote).toEqual({ timestamp: new Date(now).toISOString(), priceUsd: 12, marketCapUsd: 12000 });
    expect(result.data.trades).toBe(original.trades); expect(result.data.chart.source).toBe('Recorded fills');
    expect(result.notice).toBe(currentQuoteEstimateNotice); expect(result.currentPriceNotice).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reports that current price is unavailable instead of treating later observations or an activity field as current', async () => {
    const original = data(); original.trades[1].tokenAmount = .5;
    const observed = chart(); observed.points.push({ timestamp: new Date(now - 60_000).toISOString(), priceUsd: '50' });
    stubMarketFetcher(vi.fn().mockResolvedValue(response(observed)));
    const result = await replayMarketData(original, new AbortController().signal);
    expect(result.data.chart.points.at(-1)?.priceUsd).toBe(50); expect(result.data.currentQuote).toBeUndefined();
    expect(result.data.token.priceUsd).toBe(9); expect(result.currentPriceNotice).toBe(currentPriceUnavailableNotice);
  });

  it('does not keep a current quote that expires while waiting on the shared retry budget', async () => {
    const original = data(); original.trades[1].tokenAmount = .5;
    const queued = { ...deferredChart('queued', 3000), currentQuote: { timestamp: new Date(now - 179_000).toISOString(), priceUsd: '12' } };
    const fetcher = vi.fn().mockResolvedValueOnce(response(queued)).mockResolvedValue(response(deferredChart()));
    stubMarketFetcher(fetcher);
    const pending = replayMarketData(original, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(result.data.currentQuote).toBeUndefined(); expect(result.currentPriceNotice).toBe(currentPriceUnavailableNotice);
    expect(result.notice).toBe(recordedPriceEstimateNotice); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('terminates bad-address and missing-pair HTTP responses and does not request malformed addresses', async () => {
    for (const status of [400, 404]) {
      const original = data(), fetcher = vi.fn().mockResolvedValue(response({ error: 'Unavailable' }, status));
      stubMarketFetcher(fetcher);
      expect((await replayMarketData(original, new AbortController().signal)).data).toMatchObject(original);
      expect(fetcher).toHaveBeenCalledOnce();
    }
    const invalid = data(); invalid.token.address = 'invalid';
    const fetcher = vi.fn(); stubMarketFetcher(fetcher);
    await expect(replayMarketData(invalid, new AbortController().signal)).rejects.toThrow('Invalid KOL or token address');
    expect(fetcher).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels retry waiting on modal close and never starts the deferred request', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(deferredChart('queued', 3000)));
    stubMarketFetcher(fetcher);
    const controller = new AbortController();
    const pending = replayMarketData(data(), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1000); controller.abort();
    await rejected; await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a hung fetch even if the fetch implementation ignores its abort signal', async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(() => {}));
    stubMarketFetcher(fetcher);
    const controller = new AbortController(), pending = replayMarketData(data(), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(); await rejected;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the entire preparation bounded to 22 seconds including a stalled JSON response', async () => {
    const original = data();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
    stubMarketFetcher(fetcher);
    const pending = replayMarketData(original, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(22_000);
    expect(await pending).toMatchObject({ data: original, notice: 'Historical market data timed out; the replay is using available data.' });
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('reports network, non-transient HTTP, and mismatched-response errors instead of silently burying them', async () => {
    for (const fetcher of [
      vi.fn().mockRejectedValue(new TypeError('Network error')),
      vi.fn().mockResolvedValue(response(chart(), 502)),
      vi.fn().mockResolvedValue(response({ ...deferredChart('queued'), address: data().kol.address })),
    ]) {
      const original = data(); stubMarketFetcher(fetcher);
      expect(await replayMarketData(original, new AbortController().signal)).toMatchObject({ data: original, notice: 'Historical market data could not be loaded; the replay is using available data.' });
      expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    }
  });
});
