import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenChart } from '../shared/intelligence';
import { createTokenChartRequests, tokenChartHistoryRefreshDelay, tokenChartNeedsForeground, tokenChartRefreshDelay } from './tokenChartRequest';
const address = '0x' + 'a'.repeat(40);
const history: TokenChart = { address, period: '5m', source: 'geckoterminal', updatedAt: '2026-10-12T00:00:00Z',
  resolution: '5m', pending: false, stale: false, marketCapSupply: '1000000', supplyCheckedAt: '1970-01-01T00:00:00.000Z',
  candles: [{ time: 100, open: 1, high: 2, low: 1, close: 2, volume: 50 }], points: [{ timestamp: '1970-01-01T00:01:40Z', priceUsd: '2' }] };
const response = (chart: TokenChart) => new Response(JSON.stringify(chart), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.useRealTimers());
it('continues selected history recovery even when saved-page pagination is otherwise limited',()=>{
  const chart:TokenChart={...history,source:'imported',historyRecoveryPending:true,historyLoadStatus:'limited',fullHistory:true};
  expect(tokenChartRefreshDelay(chart,true)).toBe(1500);
  expect(tokenChartHistoryRefreshDelay(chart)).toBe(1500);
  expect(tokenChartRefreshDelay({...chart,historyRetryAfterMs:60000},true)).toBe(60000);
});

describe('browser chart requests', () => {
  it('bypasses HTTP redirect caches while keeping partial node history in its requested scope',async()=>{
    const partial:TokenChart={...history,source:'node',fullHistory:true,historyComplete:false,partialHistory:true};
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(response(partial));
    const charts=createTokenChartRequests({fetcher});
    const loaded=await charts.request(address,'5m','chart',false,true);
    expect(loaded).toMatchObject({fullHistory:true,historyComplete:false,partialHistory:true,candles:history.candles});
    expect(fetcher.mock.calls[0][1]).toMatchObject({cache:'no-store',headers:{Accept:'application/json'}});
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it('displays watchlist history synchronously when opening the equivalent full chart', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...history, period: '24h' }))
      .mockResolvedValueOnce(response({ ...history, candles: [], points: [], source: 'unavailable', pending: true, loadStatus: 'queued' }));
    const charts = createTokenChartRequests({ fetcher, now: () => 200_000 });
    await charts.request(address, '24h');
    const snapshot = charts.peek(address, '5m');
    expect(snapshot).toMatchObject({ period: '5m', resolution: '5m', candles: history.candles });
    expect(charts.peek(address, '5m')).toBe(snapshot);
    expect(await charts.request(address, '5m')).toMatchObject({ candles: history.candles, stale: true, pending: true });
    expect(fetcher.mock.calls[1][0]).toContain('interval=5m');
  });
  it('clips hourly history to a week without letting a weekly cache stand in for monthly history', async () => {
    const clock = 40 * 86400_000;
    const candles = [20, 39].map(day => ({ ...history.candles[0], time: day * 86400 }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ...history, period: '1h', resolution: '1h', candles }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '1h');
    expect(charts.peek(address, '7d')?.candles).toEqual([candles[1]]);
    expect(charts.peek(address, '30d')?.candles).toEqual(candles);
    const weekly = createTokenChartRequests({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({ ...history, period: '7d', resolution: '1h', candles: [candles[1]] })), now: () => clock });
    await weekly.request(address, '7d');
    expect(weekly.peek(address, '1h')).toBeNull();
  });
  it('keeps a confirmed no-history response visible instead of reviving equivalent cached data', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...history, period: '24h' }))
      .mockResolvedValueOnce(response({ ...history, candles: [], points: [], source: 'unavailable', loadStatus: 'no_history', retryAfterMs: 300_000 }));
    const charts = createTokenChartRequests({ fetcher, now: () => 200_000 });
    await charts.request(address, '24h');
    expect(charts.peek(address, '5m')?.candles).toHaveLength(1);
    await charts.request(address, '5m');
    expect(charts.peek(address, '5m')).toMatchObject({ candles: [], loadStatus: 'no_history' });
  });
  it('publishes completed preloads to mounted subscribers immediately and releases subscriptions', async () => {
    const charts = createTokenChartRequests({ fetcher: vi.fn<typeof fetch>().mockResolvedValueOnce(response(history))
      .mockResolvedValueOnce(response({ ...history, period: '1m', resolution: '1m' })) });
    const updated = vi.fn(), unrelated = vi.fn();
    const unsubscribe = charts.subscribe(address.toUpperCase(), updated);
    charts.subscribe('0x' + 'b'.repeat(40), unrelated);
    await charts.request(address, '5m');
    expect(updated).toHaveBeenCalledOnce(); expect(unrelated).not.toHaveBeenCalled();
    unsubscribe();
    await charts.request(address, '1m');
    expect(updated).toHaveBeenCalledOnce();
  });
  it('requests and restores minute history separately without borrowing five-minute bars', async () => {
    const clock = Date.parse('2026-10-12T12:00:00Z');
    const minute: TokenChart = { ...history, source:'node',period: '1m', resolution: '1m', updatedAt: new Date(clock).toISOString(), supplyCheckedAt: new Date(clock).toISOString(), candles: [{ ...history.candles[0], time: clock / 1000 - 60 }] };
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history)).mockResolvedValueOnce(response(minute));
    const charts = createTokenChartRequests({ fetcher, now: () => clock, storage });
    await charts.request(address, '5m');
    expect(charts.peek(address, '1m')).toBeNull();
    await charts.request(address, '1m');
    expect(fetcher.mock.calls[1][0]).toContain('interval=1m');
    const reloaded = createTokenChartRequests({ now: () => clock + 1000, storage });
    expect(reloaded.peek(address, '1m')).toMatchObject({ period: '1m', resolution: '1m', candles: minute.candles, stale: true });
  });
  it('checks selected loading charts sooner while retaining provider cooldowns', () => {
    expect(tokenChartRefreshDelay({ ...history, pending: true, loadStatus: 'queued', retryAfterMs: 3000 }, true)).toBe(1000);
    expect(tokenChartRefreshDelay({ ...history, pending: true, loadStatus: 'queued', retryAfterMs: 3000 }, false)).toBe(3000);
    expect(tokenChartRefreshDelay({ ...history, pending: false, loadStatus: 'rate_limited', retryAfterMs: 120_000 }, true)).toBe(120_000);
    expect(tokenChartRefreshDelay(history, true)).toBe(30_000);
  });
  it('pauses background work only while foreground history or supply can actively load', () => {
    expect(tokenChartNeedsForeground({ ...history, candles: [], pending: true, loadStatus: 'queued' }, 0)).toBe(true);
    expect(tokenChartNeedsForeground({ ...history, marketCapSupply: null, pending: true, supplyPending: true }, 0)).toBe(true);
    expect(tokenChartNeedsForeground({ ...history, pending: true, supplyPending: true }, 0)).toBe(false);
    for (const loadStatus of ['rate_limited', 'provider_error', 'no_history'] as const) {
      expect(tokenChartNeedsForeground({ ...history, candles: [], pending: true, supplyPending: true, loadStatus, retryAfterMs: 120_000 }, 0)).toBe(false);
    }
  });
  it('coalesces concurrent viewers of the same normalized token and timeframe', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { complete = resolve; }));
    const charts = createTokenChartRequests({ fetcher });
    const one = charts.request(address, '5m');
    const two = charts.request(address.toUpperCase(), '5m');
    expect(two).toBe(one); expect(fetcher).toHaveBeenCalledTimes(1);
    complete(response(history));
    expect(await one).toEqual(history);
  });
  it('promotes an in-flight speculative request when the main chart mounts without splitting its consumers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Promoted', 'AbortError')), { once: true });
    })).mockResolvedValueOnce(response(history));
    const charts = createTokenChartRequests({ fetcher });
    const preload = charts.request(address, '5m', 'prefetch');
    expect(charts.isForegroundLoading()).toBe(false);
    const mounted = charts.request(address.toUpperCase(), '5m', 'chart');
    expect(mounted).toBe(preload);
    expect(charts.isForegroundLoading()).toBe(true);
    expect(await mounted).toEqual(history);
    expect(await preload).toEqual(history);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      `/api/tokens/${address}/chart?interval=5m&priority=prefetch`,
      `/api/tokens/${address}/chart?interval=5m&priority=chart`,
    ]);
    expect(charts.isForegroundLoading()).toBe(false);
  });
  it('promotes a background queued response immediately rather than reusing its short waiting response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...history, candles: [], points: [], pending: true, loadStatus: 'queued', retryAfterMs: 3000 }))
      .mockResolvedValueOnce(response(history));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '5m', 'prefetch');
    expect(await charts.request(address, '5m', 'chart')).toEqual(history);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('refreshes completed background history once at foreground priority while continuing to display its cached candles', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history))
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '5m', 'prefetch');
    const cached = charts.peek(address, '5m');
    const main = charts.request(address, '5m', 'chart');
    expect(charts.peek(address, '5m')).toBe(cached);
    expect(fetcher.mock.calls[1][0]).toContain('priority=chart');
    const fresh = { ...history, candles: [{ ...history.candles[0], close: 3 }] };
    complete(response(fresh));
    expect(await main).toEqual(fresh);
    expect(await charts.request(address, '5m', 'chart')).toEqual(fresh);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('holds speculative loading until all mounted main-chart consumers have released their loading lease', () => {
    const charts = createTokenChartRequests();
    const changed = vi.fn();
    const unsubscribe = charts.subscribePriority(changed);
    const releasePage = charts.holdForeground(), releaseModal = charts.holdForeground();
    expect(charts.isForegroundLoading()).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    releasePage(); releasePage();
    expect(charts.isForegroundLoading()).toBe(true);
    releaseModal();
    expect(charts.isForegroundLoading()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe(); charts.holdForeground()();
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it('aborts a stalled request and releases the job so a later retry can succeed', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce((_url, options) => new Promise((_resolve,reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError')), { once: true });
    })).mockResolvedValueOnce(response(history));
    const charts = createTokenChartRequests({ fetcher, timeoutMs: 12000 });
    const failed = expect(charts.request(address, '5m')).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(12000); await failed;
    expect(await charts.request(address, '5m')).toEqual(history);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps actual cached prices visible during a provider cooldown without replacing its retry duration', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history)).mockResolvedValueOnce(response({ ...history,
      candles: [], points: [], source: 'unavailable', marketCapSupply: null, loadStatus: 'rate_limited', retryAfterMs: 120000 }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m'); clock = 15000;
    const cached = await charts.request(address, '5m');
    expect(cached).toMatchObject({ candles: history.candles, source: 'geckoterminal', stale: true, loadStatus: 'rate_limited', retryAfterMs: 120000, marketCapSupply: '1000000' });
  });
  it('does not refetch a cooling provider when another viewer opens the same chart', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ ...history, loadStatus: 'rate_limited', retryAfterMs: 120_000 }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m'); clock = 15_000;
    expect(await charts.request(address, '5m')).toMatchObject({ retryAfterMs: 105_000 });
    expect(fetcher).toHaveBeenCalledOnce();
    clock = 120_000; await charts.request(address, '5m');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps manual retries and foreground promotion inside a provider cooldown even when supply remains pending', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ ...history, pending: true, supplyPending: true, loadStatus: 'rate_limited', retryAfterMs: 120_000 }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m', 'sparkline');
    clock = 15_000;
    expect(await charts.request(address, '5m', 'chart', true)).toMatchObject({ retryAfterMs: 105_000 });
    expect(fetcher).toHaveBeenCalledOnce();
    clock = 120_000;
    await charts.request(address, '5m', 'chart', true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('allows a manual refresh without erasing valid cached history when its HTTP retry fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history)).mockResolvedValueOnce(new Response('', { status: 503 }));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '5m');
    const snapshot = charts.peek(address, '5m');
    await expect(charts.request(address, '5m', 'chart', true)).rejects.toThrow('503');
    expect(charts.peek(address, '5m')).toBe(snapshot);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('joins an active manual retry rather than letting another viewer reuse the pre-retry snapshot', async () => {
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history)).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '5m');
    const retry = charts.request(address, '5m', 'chart', true);
    expect(charts.request(address, '5m')).toBe(retry);
    const fresh = { ...history, candles: [{ ...history.candles[0], close: 3 }] };
    complete(response(fresh));
    expect(await retry).toEqual(fresh);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never caches another token’s response and keeps separate timeframes separate', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...history, address: '0x'+'b'.repeat(40) }))
      .mockResolvedValueOnce(response(history)).mockResolvedValueOnce(response({ ...history, period: '1h', resolution: '1h' }));
    const charts = createTokenChartRequests({ fetcher });
    await expect(charts.request(address, '5m')).rejects.toThrow('Invalid token chart response');
    expect(charts.peek(address, '5m')).toBeNull();
    await charts.request(address, '5m'); await charts.request(address, '1h');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(charts.peek(address, '1h')?.resolution).toBe('1h');
  });
  it('retains the volume denomination of cached CMC bars during an empty retry response', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...history, source: 'coinmarketcap', volumeCurrency: 'unknown' }))
      .mockResolvedValueOnce(response({ ...history, source: 'unavailable', candles: [], points: [], loadStatus: 'queued' }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m'); clock = 15000;
    expect(await charts.request(address, '5m')).toMatchObject({ source: 'coinmarketcap', candles: history.candles, volumeCurrency: 'unknown', stale: true });
  });
  it('rejects provider-era cache entries under the node-owned namespace', async () => {
    const clock = Date.parse('2026-10-12T12:00:00Z');
    const legacy: TokenChart = { ...history, source: 'gmgn', updatedAt: new Date(clock).toISOString(), supplyCheckedAt: new Date(clock).toISOString(), candles: [{ ...history.candles[0], time: clock / 1000 - 300 }] };
    const fresh: TokenChart = { ...legacy, volumeCurrency: 'usd', candles: [{ ...legacy.candles[0], volume: 1234 }] };
    const charts = createTokenChartRequests({ now: () => clock, storage: { getItem: () => JSON.stringify([legacy]), setItem: vi.fn() }, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(fresh)) });
    expect(charts.peek(address, '5m')).toBeNull();
    expect(await charts.request(address, '5m')).toMatchObject({ candles: fresh.candles, volumeCurrency: 'usd' });
  });
  it('does not label volume from an older GMGN API response as dollars without a denomination', async () => {
    const charts = createTokenChartRequests({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({ ...history, source: 'gmgn' })) });
    expect(await charts.request(address, '5m')).toMatchObject({ candles: history.candles, volumeCurrency: 'unknown' });
  });
  it('keeps verified supply when new candles arrive before their metadata, including across intervals', async () => {
    let clock = 0;
    const latest = [{ ...history.candles[0], close: 3 }];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history))
      .mockResolvedValueOnce(response({ ...history, period: '1h', resolution: '1h', candles: latest, marketCapSupply: null, supplyCheckedAt: null, supplyPending: true, pending: true, retryAfterMs: 3000 }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m'); clock = 15000;
    expect(await charts.request(address, '1h')).toMatchObject({ candles: latest, marketCapSupply: '1000000', supplyCheckedAt: history.supplyCheckedAt, pending: true, retryAfterMs: 3000 });
  });
  it('does not extend the validity of expired supply when fresh candles arrive', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(history))
      .mockResolvedValueOnce(response({ ...history, marketCapSupply: null, supplyCheckedAt: null, supplyPending: true, pending: true }));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '5m'); clock = 2 * 86400_000;
    expect(await charts.request(address, '5m')).toMatchObject({ marketCapSupply: null, supplyCheckedAt: null });
  });
  it('restores a verified chart synchronously on reload and refreshes its data in the background', async () => {
    const clock = Date.parse('2026-10-12T12:00:00Z');
    const current:TokenChart = { ...history,source:'node', updatedAt: new Date(clock).toISOString(), supplyCheckedAt: new Date(clock).toISOString(), candles: [{ ...history.candles[0], time: clock / 1000 - 300 }] };
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = createTokenChartRequests({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(current)), now: () => clock, storage });
    await first.request(address, '5m');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(current));
    const reloaded = createTokenChartRequests({ fetcher, now: () => clock + 1000, storage });
    expect(reloaded.peek(address, '5m')).toMatchObject({ candles: current.candles, marketCapSupply: '1000000', stale: true });
    expect(fetcher).not.toHaveBeenCalled();
    await reloaded.request(address, '5m'); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not restore secondary-pool candles saved under the previous market-selection policy',async()=>{
    const clock=Date.parse('2026-10-12T12:00:00Z'),current:TokenChart={...history,source:'node',updatedAt:new Date(clock).toISOString(),
      supplyCheckedAt:new Date(clock).toISOString(),candles:[{...history.candles[0],time:clock/1000-300}]};
    const previous={...current,candles:[{...current.candles[0],open:55,high:55,low:55,close:55}]};
    const values=new Map([['kollens:market-charts:node-v2',JSON.stringify([previous])]]);
    const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    const charts=createTokenChartRequests({now:()=>clock,storage,fetcher:vi.fn<typeof fetch>().mockResolvedValue(response(current))});
    expect(charts.peek(address,'5m')).toBeNull();
    expect((await charts.request(address,'5m')).candles).toEqual(current.candles);
    expect(createTokenChartRequests({now:()=>clock,storage}).peek(address,'5m')?.candles).toEqual(current.candles);
  });
  it.each(['node','imported','mixed'] as const)('restores %s history with original point times, scope and coverage flags',async source=>{
    const clock=Date.parse('2026-10-12T12:00:00Z'),observed=new Date(clock-45_000).toISOString(),asOf=new Date(clock-5000).toISOString();
    const current:TokenChart={...history,source,period:'1m',resolution:'1m',fullHistory:true,partialHistory:true,historyComplete:false,
      updatedAt:asOf,supplyCheckedAt:asOf,candles:[{...history.candles[0],time:clock/1000-60}],points:[{timestamp:observed,priceUsd:'2'}]};
    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    const first=createTokenChartRequests({now:()=>clock,storage,fetcher:vi.fn<typeof fetch>().mockResolvedValue(response(current))});
    expect((await first.request(address,'1m','chart',false,true)).points).toEqual(current.points);
    const restored=createTokenChartRequests({now:()=>clock+1000,storage});
    expect(restored.peek(address,'1m',true)).toMatchObject({source,points:current.points,updatedAt:asOf,supplyCheckedAt:asOf,
      fullHistory:true,partialHistory:true,historyComplete:false,stale:true});
    expect(restored.peek(address,'1m')).toBeNull();
  });
  it.each(['gmgn','geckoterminal','coinmarketcap'] as const)('does not restore legacy %s financial state',source=>{
    const clock=Date.parse('2026-10-12T12:00:00Z'),current={...history,source,updatedAt:new Date(clock).toISOString(),
      supplyCheckedAt:new Date(clock).toISOString(),candles:[{...history.candles[0],time:clock/1000-60}]};
    const charts=createTokenChartRequests({now:()=>clock,storage:{getItem:()=>JSON.stringify([current]),setItem:vi.fn()}});
    expect(charts.peek(address,'5m')).toBeNull();
  });
  it('ignores invalid or expired session history and keeps working if browser storage is blocked', async () => {
    const clock = Date.parse('2026-10-12T12:00:00Z');
    const expiredStorage = { getItem: () => JSON.stringify([{ ...history,source:'node',updatedAt:new Date(clock).toISOString(),candles:[{...history.candles[0],time:clock/1000-60}], supplyCheckedAt: new Date(clock - 2 * 86400_000).toISOString() }]), setItem: vi.fn() };
    const expired = createTokenChartRequests({ now: () => clock, storage: expiredStorage });
    expect(expired.peek(address, '5m')).toBeNull();
    const storage = { getItem: () => { throw new Error('Blocked'); }, setItem: () => { throw new Error('Blocked'); } };
    const charts = createTokenChartRequests({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(history)), storage });
    expect(await charts.request(address, '5m')).toEqual(history);
  });
});

describe('progressive full browser chart history', () => {
  const full = (overrides: Partial<TokenChart> = {}): TokenChart => ({ ...history, period: '1m', resolution: '1m', source: 'gmgn', volumeCurrency: 'usd', fullHistory: true,
    historyComplete: false, historyPending: false, candles: [{ ...history.candles[0], time: 1000 }], ...overrides });

  it('isolates full history from recent requests while showing existing recent candles immediately', async () => {
    let complete!: (value: Response) => void;
    const recent = { ...history, period: '1m' as const, resolution: '1m' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(recent)).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '1m');
    const snapshot = charts.peek(address, '1m', true);
    expect(snapshot).toMatchObject({ candles: recent.candles, fullHistory: true, historyComplete: false });
    expect(charts.peek(address, '1m', true)).toBe(snapshot);
    const mounted = charts.request(address, '1m', 'chart', false, true);
    expect(fetcher.mock.calls[1][0]).toContain('&history=full');
    const completeHistory = full({ candles: [...recent.candles, ...full().candles], historyComplete: true });
    complete(response(completeHistory));
    await mounted;
    expect(charts.peek(address, '1m', true)?.candles).toHaveLength(2);
    expect(charts.peek(address, '1m')).toEqual(recent);
  });

  it('coalesces the same older page, merges genuine bars in order, and keeps the latest tail', async () => {
    let complete!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(full())).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '1m', 'chart', false, true);
    const one = charts.requestOlder(address, '1m', 1000), two = charts.requestOlder(address.toUpperCase(), '1m', 1000);
    expect(two).toBe(one);
    const older = { ...history.candles[0], time: 100 }, repeated = { ...older, close: 1.5 };
    complete(response(full({ candles: [older, { ...older, time: 50 }, repeated, { ...older, time: 1000, close: 999 }], historyComplete: true, historyBefore: 50 })));
    const loaded = await one;
    expect(loaded.candles.map(c => [c.time, c.close])).toEqual([[50, 2], [100, 1.5], [1000, 2]]);
    expect(loaded).toMatchObject({ historyComplete: true, historyBefore: 50, pending: false, volumeCurrency: 'usd' });
    expect(fetcher.mock.calls[1][0]).toContain('priority=prefetch&history=full&before=1000');
    expect(charts.peek(address, '1m', true)).toBe(loaded);
  });

  it('marks an explicitly selected older page as foreground while background pagination remains prefetch', async () => {
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(full())).mockResolvedValue(response(full({historyComplete:true})));
    const charts=createTokenChartRequests({fetcher,now:()=>0});
    await charts.request(address,'1m','chart',false,true);
    await charts.requestOlder(address,'1m',1000,'chart');
    expect(fetcher.mock.calls[1][0]).toContain('priority=chart&history=full&before=1000');
    await charts.requestOlder(address,'1m',100);
    expect(fetcher.mock.calls[2][0]).toContain('priority=prefetch&history=full&before=100');
  });

  it('holds a recovering older page cursor and cooldown through independent latest refreshes',async()=>{
    let clock=0;
    const latest=full({source:'node',historyBefore:1000,historyPending:true});
    const recovering=full({source:'imported',candles:[{...history.candles[0],time:100}],historyBefore:100,
      historyRecoveryPending:true,historyRecoveryReason:'import_provider_cooldown',historyRetryAfterMs:60000,
      historyLoadStatus:'limited',historyComplete:false,partialHistory:true});
    const complete=full({source:'mixed',candles:[{...history.candles[0],time:100},{...history.candles[0],time:500}],
      historyBefore:100,historyComplete:true,partialHistory:false});
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(latest)).mockResolvedValueOnce(response(recovering))
      .mockResolvedValueOnce(response({...latest,candles:[{...history.candles[0],time:1060}]})).mockResolvedValueOnce(response(complete));
    const charts=createTokenChartRequests({fetcher,now:()=>clock});
    await charts.request(address,'1m','chart',false,true);
    const pending=await charts.requestOlder(address,'1m',1000,'chart');
    expect(pending).toMatchObject({historyBefore:1000,historyRecoveryPending:true,historyPending:true,historyLoadStatus:'queued',historyComplete:false});
    expect(pending.candles.map(c=>c.time)).toEqual([100,1000]);
    clock=15000;
    const fresh=await charts.request(address,'1m','chart',true,true);
    expect(fresh).toMatchObject({historyBefore:1000,historyRecoveryPending:true,historyRecoveryReason:'import_provider_cooldown'});
    expect(charts.historyDelay(address,'1m')).toBe(45000);
    expect(await charts.requestOlder(address,'1m',1000,'chart')).toMatchObject({historyBefore:1000,historyRetryAfterMs:45000});
    expect(fetcher).toHaveBeenCalledTimes(3);
    clock=60000;
    const repaired=await charts.requestOlder(address,'1m',1000,'chart');
    expect(fetcher.mock.calls[3][0]).toContain('&before=1000');
    expect(repaired).toMatchObject({historyBefore:100,historyRecoveryPending:false});
    expect(repaired.candles.map(c=>c.time)).toEqual([100,500,1000,1060]);
    expect(repaired.historyRecoveryReason).toBeUndefined();
  });

  it('retains a barless older recovery page until a completed empty retrieval ends it',async()=>{
    let clock=0;
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(full({source:'node',historyBefore:1000})))
      .mockResolvedValueOnce(response(full({source:'node',candles:[],historyRecoveryPending:true,historyRetryAfterMs:1500,historyLoadStatus:'limited'})))
      .mockResolvedValueOnce(response(full({source:'node',candles:[],historyComplete:false,historyLoadStatus:'limited'})));
    const charts=createTokenChartRequests({fetcher,now:()=>clock});
    await charts.request(address,'1m','chart',false,true);
    expect(await charts.requestOlder(address,'1m',1000,'chart')).toMatchObject({historyBefore:1000,historyRecoveryPending:true,historyLoadStatus:'queued'});
    expect(charts.historyDelay(address,'1m')).toBe(1500);
    clock=1500;
    const exhausted=await charts.requestOlder(address,'1m',1000,'chart');
    expect(exhausted).toMatchObject({historyRecoveryPending:false,historyLoadStatus:'limited',historyPending:false});
    expect(charts.historyDelay(address,'1m')).toBeNull();
    expect(exhausted.candles).toEqual(full().candles);
  });

  it('clears a repaired page without hiding a separately incomplete latest window or another older page',async()=>{
    const latest=full({source:'node',historyBefore:1000,historyPending:true,partialHistory:true});
    const older=(partial:boolean)=>full({source:'imported',candles:[{...history.candles[0],time:100}],historyBefore:100,
      historyComplete:true,partialHistory:partial});
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(latest)).mockResolvedValueOnce(response(older(false)))
      .mockResolvedValueOnce(response({...latest,partialHistory:false})).mockResolvedValueOnce(response(older(false)))
      .mockResolvedValueOnce(response(older(true))).mockResolvedValueOnce(response(older(false)));
    const charts=createTokenChartRequests({fetcher,now:()=>0});
    await charts.request(address,'1m','chart',false,true);
    expect(await charts.requestOlder(address,'1m',1000,'chart')).toMatchObject({partialHistory:true,historyComplete:false});
    await charts.request(address,'1m','chart',true,true);
    expect(await charts.requestOlder(address,'1m',1000,'chart')).toMatchObject({partialHistory:false,historyComplete:true});
    await charts.requestOlder(address,'1m',500,'chart');
    expect(await charts.requestOlder(address,'1m',1000,'chart')).toMatchObject({partialHistory:true,historyComplete:false});
  });

  it('restores the selected repair cursor and original cooldown without exposing local cache bookkeeping',async()=>{
    const began=Date.parse('2026-10-20T12:00:00Z');let clock=began;
    const before=began/1000-60,latest=full({source:'node',candles:[{...history.candles[0],time:before}],historyBefore:before,
      updatedAt:new Date(began).toISOString(),supplyCheckedAt:new Date(began).toISOString(),partialHistory:false});
    const recovering={...latest,candles:[{...history.candles[0],time:before-600}],historyBefore:before-600,partialHistory:true,
      historyRecoveryPending:true,historyRetryAfterMs:60000,historyLoadStatus:'limited' as const};
    const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    const first=createTokenChartRequests({storage,now:()=>clock,fetcher:vi.fn<typeof fetch>().mockResolvedValueOnce(response(latest)).mockResolvedValueOnce(response(recovering))});
    await first.request(address,'1m','chart',false,true);await first.requestOlder(address,'1m',before,'chart');
    clock=began+15000;
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(latest)).mockResolvedValueOnce(response({...recovering,
      historyRecoveryPending:false,historyRetryAfterMs:undefined,historyLoadStatus:undefined,historyComplete:true,partialHistory:false}));
    const restored=createTokenChartRequests({storage,now:()=>clock,fetcher});
    expect(restored.peek(address,'1m',true)).toMatchObject({historyBefore:before,historyRecoveryPending:true});
    expect(restored.peek(address,'1m',true)).not.toHaveProperty('localHistoryCache');
    expect(restored.historyDelay(address,'1m')).toBe(45000);
    await restored.request(address,'1m','chart',true,true);
    expect(await restored.requestOlder(address,'1m',before,'chart')).toMatchObject({historyBefore:before,historyRetryAfterMs:45000});
    expect(fetcher).toHaveBeenCalledOnce();
    clock=began+60000;
    expect(await restored.requestOlder(address,'1m',before,'chart')).toMatchObject({historyBefore:before-600,historyRecoveryPending:false,partialHistory:false,historyComplete:true});
    expect(fetcher.mock.calls[1][0]).toContain(`priority=chart&history=full&before=${before}`);
  });

  it('retains concurrent latest updates when an older delta arrives afterwards', async () => {
    let complete!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(full())).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
      .mockResolvedValueOnce(response(full({ candles: [{ ...history.candles[0], time: 1000, close: 3 }, { ...history.candles[0], time: 1060 }] })));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '1m', 'chart', false, true);
    const latestRevision = charts.latestRevision(address, '1m', true);
    const older = charts.requestOlder(address, '1m', 1000);
    await charts.request(address, '1m', 'chart', true, true);
    expect(charts.latestRevision(address, '1m', true)).not.toBe(latestRevision);
    const refreshedRevision = charts.latestRevision(address, '1m', true);
    complete(response(full({ candles: [{ ...history.candles[0], time: 100 }], historyComplete: true })));
    expect((await older).candles.map(c => [c.time, c.close])).toEqual([[100, 2], [1000, 3], [1060, 2]]);
    expect(charts.latestRevision(address, '1m', true)).toBe(refreshedRevision);
  });

  it('preserves historical rows across latest refreshes and does not let a page postpone latest freshness', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(full())).mockResolvedValueOnce(response(full({ candles: [{ ...history.candles[0], time: 100 }] })))
      .mockResolvedValueOnce(response(full({ candles: [{ ...history.candles[0], time: 1060 }] })));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '1m', 'chart', false, true);
    clock = 9000; await charts.requestOlder(address, '1m', 1000);
    clock = 11000;
    const latest = await charts.request(address, '1m', 'chart', false, true);
    expect(latest.candles.map(c => c.time)).toEqual([100, 1000, 1060]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reopens previously complete history when a fresh snapshot identifies an uncovered middle gap', async () => {
    const old = full({ candles: [{ ...history.candles[0], time: 100 }, { ...history.candles[0], time: 1000 }], historyComplete: true });
    const fresh = full({ candles: [{ ...history.candles[0], time: 2000 }], historyComplete: false, historyBefore: 2000 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(old)).mockResolvedValueOnce(response(fresh));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '1m', 'chart', false, true);
    const loaded = await charts.request(address, '1m', 'chart', true, true);
    expect(loaded).toMatchObject({ historyComplete: false, historyBefore: 2000 });
    expect(loaded.candles.map(c => c.time)).toEqual([100, 1000, 2000]);
    expect(charts.historyDelay(address, '1m')).toBe(1500);
  });

  it('preserves usable latest candles through a historical HTTP failure and respects the separate retry cooldown', async () => {
    let clock = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(full())).mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(response(full({ candles: [{ ...history.candles[0], time: 100 }], historyComplete: true })));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '1m', 'chart', false, true);
    const failed = await charts.requestOlder(address, '1m', 1000);
    expect(failed).toMatchObject({ candles: full().candles, historyLoadStatus: 'provider_error', historyRetryAfterMs: 3000, pending: false, stale: false });
    clock = 1000;
    expect(await charts.requestOlder(address, '1m', 1000)).toMatchObject({ historyRetryAfterMs: 2000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    clock = 3000;
    expect((await charts.requestOlder(address, '1m', 1000)).historyComplete).toBe(true);
  });

  it('keeps history rate-limit cooldown separate from foreground freshness checks', async () => {
    let clock = 0;
    const cooling = full({ candles: [], historyLoadStatus: 'rate_limited', historyRetryAfterMs: 120_000 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(full())).mockResolvedValueOnce(response(cooling));
    const charts = createTokenChartRequests({ fetcher, now: () => clock });
    await charts.request(address, '1m', 'chart', false, true);
    await charts.requestOlder(address, '1m', 1000);
    clock = 15000;
    expect(charts.historyDelay(address, '1m')).toBe(105_000);
    expect(await charts.requestOlder(address, '1m', 1000)).toMatchObject({ historyRetryAfterMs: 105_000 });
    expect(charts.peek(address, '1m', true)?.candles).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops backfill for confirmed complete or limited history and unsupported providers', () => {
    expect(tokenChartHistoryRefreshDelay(full())).toBe(1500);
    expect(tokenChartHistoryRefreshDelay(full({ historyComplete: true }))).toBeNull();
    expect(tokenChartHistoryRefreshDelay(full({ historyLoadStatus: 'limited' }))).toBeNull();
    expect(tokenChartHistoryRefreshDelay(full({ source: 'coinmarketcap' }))).toBeNull();
    expect(tokenChartHistoryRefreshDelay(history)).toBeNull();
    expect(tokenChartHistoryRefreshDelay(full({ historyLoadStatus: 'rate_limited', historyRetryAfterMs: 120_000 }))).toBe(120_000);
  });

  it('pages persisted node/imported history and preserves cursor progress across latest refreshes',async()=>{
    const latest=full({source:'node',historyBefore:1000,historyPending:true,historyComplete:false,partialHistory:true});
    const older=full({source:'imported',candles:[{...history.candles[0],time:100}],historyBefore:100,historyPending:false,historyLoadStatus:'limited',historyComplete:false,partialHistory:true});
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(latest)).mockResolvedValueOnce(response(older)).mockResolvedValueOnce(response(latest));
    const charts=createTokenChartRequests({fetcher,now:()=>0});
    await charts.request(address,'1m','chart',false,true);
    expect(charts.historyDelay(address,'1m')).toBe(1500);
    const merged=await charts.requestOlder(address,'1m',1000);
    expect(merged).toMatchObject({source:'mixed',historyBefore:100,historyComplete:false,historyLoadStatus:'limited',partialHistory:true});
    expect(merged.candles.map(c=>c.time)).toEqual([100,1000]);
    expect(charts.historyDelay(address,'1m')).toBeNull();
    const refreshed=await charts.request(address,'1m','chart',true,true);
    expect(refreshed).toMatchObject({source:'mixed',historyBefore:100,historyLoadStatus:'limited',historyPending:false});
    expect(charts.historyDelay(address,'1m')).toBeNull();
  });

  it('keeps mixed full-history volume unlabelled until every retained old bar is verified', async () => {
    const older = { ...history.candles[0], time: 100 }, latest = full().candles[0];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(full({ candles: [older, latest], volumeCurrency: 'unknown' })))
      .mockResolvedValueOnce(response(full({ candles: [latest] }))).mockResolvedValueOnce(response(full({ candles: [older, latest], historyComplete: true })));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '1m', 'chart', false, true);
    expect((await charts.request(address, '1m', 'chart', true, true)).volumeCurrency).toBe('unknown');
    expect((await charts.request(address, '1m', 'chart', true, true)).volumeCurrency).toBe('usd');
  });

  it('hides historical volume of unknown denomination and stops a page that cannot move backwards', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(full()))
      .mockResolvedValueOnce(response(full({ candles: [{ ...history.candles[0], time: 100 }], volumeCurrency: 'unknown' })))
      .mockResolvedValueOnce(response(full({ candles: [{ ...history.candles[0], time: 100 }], historyPending: true })));
    const charts = createTokenChartRequests({ fetcher, now: () => 0 });
    await charts.request(address, '1m', 'chart', false, true);
    expect((await charts.requestOlder(address, '1m', 1000)).volumeCurrency).toBe('unknown');
    const unchanged = await charts.requestOlder(address, '1m', 100);
    expect(unchanged).toMatchObject({ historyLoadStatus: 'limited', historyPending: false, historyComplete: false });
    expect(charts.historyDelay(address, '1m')).toBeNull();
    expect(unchanged.candles.map(c => c.time)).toEqual([100, 1000]);
  });

  it('persists a bounded full-history tail beyond one day without claiming truncated history is complete', async () => {
    const clock = Date.parse('2026-10-12T12:00:00Z');
    const candles = Array.from({ length: 2500 }, (_, index) => ({ ...history.candles[0], time: clock / 1000 - (2500 - index) * 60 }));
    const completeHistory = full({ source:'node',candles, historyComplete: true, updatedAt: new Date(clock).toISOString(), supplyCheckedAt: new Date(clock).toISOString() });
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = createTokenChartRequests({ now: () => clock, storage, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(completeHistory)) });
    await first.request(address, '1m', 'chart', false, true);
    expect(first.peek(address, '1m', true)?.candles).toHaveLength(2500);
    const restored = createTokenChartRequests({ now: () => clock + 1000, storage, fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(completeHistory)) });
    expect(restored.peek(address, '1m', true)).toMatchObject({ candles: candles.slice(-2000), historyComplete: false, historyPending: true });
    expect(restored.peek(address, '1m')).toBeNull();
    expect((await restored.request(address, '1m', 'chart', false, true)).candles).toHaveLength(2500);
  });
});
