import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeReplayFixture } from './nodeReplay.fixture';
import { prepareNodeReplay } from './nodeReplay';
import { applyReplayMarketChart, prepareTradeReplayData, validReplayAccountingFinal } from './tradeReplayData';
import { replayMarketData } from './replayPreparationRequest';
import ReplayCanvas from './tradeReplayCanvas';

function canvas(texts?: string[]): HTMLCanvasElement {
  const context = new Proxy({}, { get: (_target, key) => key === 'measureText' ? (value: string) => ({ width: value.length * 12 })
    : key === 'fillText' ? (value: string) => texts?.push(value)
    : key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {} });
  return { getContext: () => context } as unknown as HTMLCanvasElement;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('node-owned replay contract and ending', () => {
  it('preserves the explicit captured-position scope in exported frames and frozen totals', async () => {
    const { activity, now, chartPoints } = nodeReplayFixture();
    Object.assign(activity.accountingSnapshot!, { historyBoundary: 'verified_zero_position', lifetimeComplete: false,
      lifetimeReason: 'historical_baseline_required' });
    const data = prepareTradeReplayData(activity, null, undefined, now)!;
    const prepared = applyReplayMarketChart(data, { address: activity.token.address, period: 'replay', source: 'node', resolution: '1m',
      points: chartPoints.map(point => ({ timestamp: point.timestamp, priceUsd: String(point.priceUsd) })), candles: [],
      marketCapSupply: '10000', pending: false, stale: false, updatedAt: activity.generatedAt,
      currentQuote: { timestamp: activity.generatedAt, priceUsd: '4' } }, now);
    const texts: string[] = [], renderer = new ReplayCanvas(canvas(texts)); await renderer.setData(prepared);
    renderer.render(1);
    expect(texts.some(text => text.includes('FINAL · NODE · TRACKED POSITION'))).toBe(true);
    expect(renderer.snapshot(1).totalPnl).toBeCloseTo(Number(activity.realizedAccounting!.position!.estimatedProfitUsd));
    expect(renderer.snapshot(1).totalRoi).toBeCloseTo(Number(activity.realizedAccounting!.position!.estimatedRoi));
  });
  it.each([false, true])('uses one frozen ending and moving fee-inclusive history, private=%s', async privateScope => {
    const { activity, context, now, chartPoints } = nodeReplayFixture(Date.now(), privateScope);
    const data = prepareTradeReplayData(activity, null, undefined, now, context)!;
    expect(data.replayAccounting?.source).toBe('node');
    const prepared = applyReplayMarketChart(data, { address: activity.token.address, period: 'replay', source: 'node',
      resolution: '1m', points: chartPoints.map(point => ({ timestamp: point.timestamp, priceUsd: String(point.priceUsd) })), candles: [],
      marketCapSupply: '10000', pending: false, stale: false, updatedAt: activity.generatedAt,
      currentQuote: { timestamp: activity.generatedAt, priceUsd: '4' } }, now);
    const renderer = new ReplayCanvas(canvas()); await renderer.setData(prepared);
    const early = renderer.snapshot(renderer.eventProgress(0)), ending = renderer.snapshot(1);
    expect(early.totalPnl).not.toBeNull(); expect(early.totalPnl).not.toBe(ending.totalPnl);
    expect(ending.totalPnl).toBeCloseTo(Number(activity.realizedAccounting!.position!.estimatedProfitUsd));
    expect(ending.totalRoi).toBeCloseTo(Number(activity.realizedAccounting!.position!.estimatedRoi));
    expect(ending.totalPnl).toBeCloseTo(186.5); expect(validReplayAccountingFinal(prepared, now)?.reportedRoi).toBeCloseTo(186.5 / 101);
    const withHistoricalSupply = applyReplayMarketChart(data, { address: activity.token.address, period: 'replay', source: 'node', resolution: '1m',
      points: chartPoints.map(point => ({ timestamp: point.timestamp, priceUsd: String(point.priceUsd), marketCapUsd: '12345' })), candles: [],
      marketCapSupply: '10000', pending: false, stale: false, updatedAt: activity.generatedAt }, now);
    expect(withHistoricalSupply.chart.points[0].marketCapUsd).toBe(12345);
    renderer.snapshot(.3); expect(renderer.snapshot(1)).toEqual(ending);
  });
  it.each(['wrong_pair', 'wrong_snapshot', 'wrong_proof', 'future', 'duplicate', 'expired', 'private_account'] as const)('rejects %s', variant => {
    const { activity, context, now } = nodeReplayFixture(Date.now(), variant === 'private_account');
    if (variant === 'wrong_pair') activity.replayAccounting!.walletAddress = activity.token.address;
    if (variant === 'wrong_snapshot') activity.accountingSnapshot!.source = 'mixed';
    if (variant === 'wrong_proof') activity.replayAccounting!.history!.balanceProof.blockHash = '0x' + '0'.repeat(64);
    if (variant === 'future') activity.replayAccounting!.history!.events[0].timestamp = new Date(now + 5000).toISOString();
    if (variant === 'duplicate') activity.replayAccounting!.history!.events[1].id = activity.replayAccounting!.history!.events[0].id;
    if (variant === 'expired') activity.accountingSnapshot!.asOf = new Date(now - 180001).toISOString();
    expect(prepareNodeReplay(activity, now, variant === 'private_account' ? { ...context!, accountId: 'other' } : context)).toBeUndefined();
  });
  it('keeps same-second movements atomic and includes transfers before the first swap', async () => {
    const { activity, now, chartPoints } = nodeReplayFixture();
    const events = activity.replayAccounting!.history!.events;
    events[0].kind = 'transfer_in'; delete events[0].tradeId;
    events[1].timestamp = events[2].timestamp; activity.trades = activity.trades.filter(trade => trade.side === 'sell');
    activity.trades[0].timestamp = events[1].timestamp;
    const data = prepareTradeReplayData(activity, null, undefined, now)!;
    const prepared = applyReplayMarketChart(data, { address: activity.token.address, period: 'replay', source: 'node', resolution: '1m',
      points: chartPoints.map(point => ({ timestamp: point.timestamp, priceUsd: String(point.priceUsd) })), candles: [],
      marketCapSupply: '10000', pending: false, stale: false, updatedAt: activity.generatedAt,
      currentQuote: { timestamp: activity.generatedAt, priceUsd: '4' } }, now);
    const renderer = new ReplayCanvas(canvas()); await renderer.setData(prepared);
    const movements = (renderer as unknown as { inventoryEvents: { q: number; timestamp: string }[] }).inventoryEvents;
    expect(movements[0].q).toBe(0); expect(movements[1].q).toBe(movements[2].q);
    expect(renderer.timeAt(0)).toBe(Date.parse(events[0].timestamp));
    expect(renderer.snapshot(1).totalPnl).toBeCloseTo(186.5);
  });
  it('uses only the single preparation endpoint and binds chart to snapshot/window', async () => {
    const fixture = nodeReplayFixture(), { activity, now, chartPoints } = fixture;
    vi.useFakeTimers(); vi.setSystemTime(now);
    const chart = { address: activity.token.address, period: 'replay', source: 'node', resolution: '1m', marketCapSupply: '10000',
      points: chartPoints.map(point => ({ timestamp: point.timestamp, priceUsd: String(point.priceUsd) })), candles: [], pending: false, stale: false,
      snapshotId: activity.accountingSnapshot!.snapshotId, windowId: 'e'.repeat(64), currentQuote: { timestamp: activity.generatedAt, priceUsd: '4' } };
    const fetcher = vi.fn().mockResolvedValue(Response.json({ version: 2, status: 'ready', activity, snapshotId: chart.snapshotId,
      window: { id: chart.windowId, from: chartPoints[0].timestamp, to: activity.generatedAt }, chart }));
    vi.stubGlobal('fetch', fetcher);
    const data = prepareTradeReplayData(activity, null, undefined, now)!;
    const result = await replayMarketData(data, new AbortController().signal);
    expect(result.preparationStatus).toBe('ready'); expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toContain(`/replay-preparation?snapshot=${activity.accountingSnapshot!.snapshotId}`);
    fetcher.mockResolvedValue(Response.json({ version: 2, status: 'ready', activity, snapshotId: 'a'.repeat(64), window: { id: chart.windowId, from: chartPoints[0].timestamp, to: activity.generatedAt }, chart }));
    await expect(replayMarketData(data, new AbortController().signal)).rejects.toThrow('snapshot');
  });
  it.each([false, true])('refreshes an expired frozen lease instead of polling it forever, private=%s', async privateScope => {
    const { activity, context, now } = nodeReplayFixture(Date.now(), privateScope);
    const data = prepareTradeReplayData(activity, null, undefined, now, context)!;
    vi.useFakeTimers(); vi.setSystemTime(now + 180_001);
    const fetcher = vi.fn().mockResolvedValue(Response.json({ version: 2, status: 'pending', reason: 'accounting_pending' }));
    vi.stubGlobal('fetch', fetcher);
    await replayMarketData(data, new AbortController().signal);
    expect(fetcher.mock.calls[0][0]).toMatch(/\/replay-preparation$/);
    expect(fetcher.mock.calls[0][0]).toContain(privateScope ? '/api/journal/' : '/api/kols/');
  });
  it('refreshes a revoked or corrected public media version without reusing its approval', async () => {
    const { activity, now } = nodeReplayFixture();
    vi.useFakeTimers(); vi.setSystemTime(now);
    const data = prepareTradeReplayData(activity, null, undefined, now)!;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    const result = await replayMarketData(data, new AbortController().signal);
    expect(result.preparationStatus).toBe('pending'); expect(result.data.accountingSnapshot).toBeUndefined();
    expect(result.data.replayAccounting?.final).toBeNull();
  });
  it('rebinds a corrected private media version through its account-authorized route', async () => {
    const { activity, context, now } = nodeReplayFixture(Date.now(), true);
    vi.useFakeTimers(); vi.setSystemTime(now);
    const data = prepareTradeReplayData(activity, null, undefined, now, context)!;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 410 })));
    const result = await replayMarketData(data, new AbortController().signal);
    expect(result.preparationStatus).toBe('pending'); expect(result.data.requestContext?.accountId).toBe(context!.accountId);
    expect(result.data.requestContext?.snapshotId).toBeUndefined(); expect(result.data.accountingSnapshot).toBeUndefined();
  });
  it.each([429,500,502,503,504])('keeps transient HTTP %s preparation failures retryable without granting export approval',async status=>{
    const {activity,now}=nodeReplayFixture();vi.useFakeTimers();vi.setSystemTime(now);
    const data=prepareTradeReplayData(activity,null,undefined,now)!;
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status})));
    const result=await replayMarketData(data,new AbortController().signal);
    expect(result.preparationStatus).toBe('pending');expect(result.retryAfterMs).toBe(2000);
    expect(result.data.replayAccounting?.final).toBeNull();
  });
  it.each(['fetch','body'] as const)('continues preparation after an eight-second %s deadline without granting export approval',async stage=>{
    const {activity,now}=nodeReplayFixture(),data=prepareTradeReplayData(activity,null,undefined,now)!;
    const failure=new DOMException('signal timed out','TimeoutError');
    const response=Response.json({});
    if(stage==='body')response.json=vi.fn().mockRejectedValue(failure);
    const fetcher=stage==='fetch'?vi.fn().mockRejectedValue(failure):vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch',fetcher);
    const result=await replayMarketData(data,new AbortController().signal);
    expect(result).toMatchObject({preparationStatus:'pending',blockingReason:'preparation_pending',retryAfterMs:2000});
    expect(result.notice).not.toContain('signal timed out');
    expect(result.data.replayAccounting).toMatchObject({status:'unavailable',final:null,
      coverage:{exactFinal:false,transactionsComplete:false,balanceMatched:false}});
    expect(data.replayAccounting?.final,'the original modal valuation is not mutated').not.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['fetch','body'] as const)('recognizes a browser AbortError caused by the internal %s deadline',async stage=>{
    const {activity,now}=nodeReplayFixture(),data=prepareTradeReplayData(activity,null,undefined,now)!;
    const deadline=new AbortController(),timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(deadline.signal);
    const fail=()=>{deadline.abort(new DOMException('signal timed out','TimeoutError'));return Promise.reject(new DOMException('The operation was aborted.','AbortError'));};
    const response=Response.json({});if(stage==='body')response.json=vi.fn(fail);
    vi.stubGlobal('fetch',stage==='fetch'?vi.fn(fail):vi.fn().mockResolvedValue(response));
    try {
      expect(await replayMarketData(data,new AbortController().signal)).toMatchObject({preparationStatus:'pending',blockingReason:'preparation_pending'});
      expect(timeout).toHaveBeenCalledExactlyOnceWith(8000);
    } finally {timeout.mockRestore();}
  });
  it.each(['fetch','body'] as const)('preserves caller cancellation during %s instead of restarting preparation',async stage=>{
    const {activity,now}=nodeReplayFixture(),data=prepareTradeReplayData(activity,null,undefined,now)!;
    const controller=new AbortController();
    const fail=()=>{controller.abort();return Promise.reject(new DOMException('signal timed out','TimeoutError'));};
    const response=Response.json({});if(stage==='body')response.json=vi.fn(fail);
    vi.stubGlobal('fetch',stage==='fetch'?vi.fn(fail):vi.fn().mockResolvedValue(response));
    await expect(replayMarketData(data,controller.signal)).rejects.toMatchObject({name:'AbortError',message:'Video export cancelled.'});
  });
  it('keeps a temporary fetch network failure retryable without approving a replay',async()=>{
    const {activity,now}=nodeReplayFixture(),data=prepareTradeReplayData(activity,null,undefined,now)!;
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await replayMarketData(data,new AbortController().signal)).toMatchObject({preparationStatus:'pending',blockingReason:'preparation_pending',
      data:{replayAccounting:{final:null}}});
  });
  it.each([new SyntaxError('Unexpected token'),new TypeError('Invalid JSON body')])('does not retry an invalid response body: %s',async failure=>{
    const {activity,now}=nodeReplayFixture(),data=prepareTradeReplayData(activity,null,undefined,now)!;
    const response=Response.json({});response.json=vi.fn().mockRejectedValue(failure);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response));
    await expect(replayMarketData(data,new AbortController().signal)).rejects.toBe(failure);
  });
  it('does not turn malformed preparation contracts into transport retries',async()=>{
    const {activity,now}=nodeReplayFixture(),data=prepareTradeReplayData(activity,null,undefined,now)!;
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({version:1,status:'ready'})));
    await expect(replayMarketData(data,new AbortController().signal)).rejects.toThrow('Invalid replay preparation response');
  });
});
