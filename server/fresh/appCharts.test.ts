import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFreshApp } from './app.js';
import type { FreshServices } from './services.js';
import { createFreshReplay } from './replay.js';
import { FreshChartError, type FreshCharts } from './charts.js';
import type { ReplayMarketChart } from '../../shared/replayChart.js';
import positionFixture from '../fixtures/closed-replay-position.json' with { type: 'json' };
import marketFixture from '../fixtures/closed-replay-market.json' with { type: 'json' };
import type { KolTokenActivity } from '../../shared/kolTokenTrades.js';

const apps: Awaited<ReturnType<typeof createFreshApp>>['app'][] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture() {
  const input = { activity: structuredClone(positionFixture.activity) as KolTokenActivity,
    chartPoints: marketFixture.chart.bars.flatMap(bar => [{ timestamp: bar.timestamp, priceUsd: bar.open },
      { timestamp: new Date(Date.parse(bar.timestamp) + 60_000).toISOString(), priceUsd: bar.close }]) };
  const now = Date.now(), token = input.activity.token.address, wallet = input.activity.kol.address;
  let visible = true, approved = true;
  const row = { address: token, launched_at: new Date(now - 100 * 86400_000), total_supply_raw: '1000000000000000000000', decimals: 18,
    price_usd: '4', observed_at: new Date(now), launch_status: 'eligible', valuation_status: 'ready' };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('INSERT INTO fresh.jobs')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM fresh.tokens t LEFT JOIN fresh.launch_facts')) return { rows: visible ? [row] : [], rowCount: visible ? 1 : 0 };
    throw new Error('Unexpected read adapter query');
  });
  const chart = vi.fn(async (address: string, options: Parameters<FreshCharts['chart']>[1]) => ({ address, period: options.period ?? options.resolution ?? '1m',
    resolution: options.resolution ?? '1m', source: 'gmgn' as const, points: [], candles: [{ time: Math.floor(options.to / 60_000) * 60, open: 1, high: 2, low: 1, close: 2, volume: 10 }],
    pending: false, stale: false, updatedAt: new Date(now).toISOString(), historyComplete: true, fullHistory: true, marketCapSupply: options.quote?.supply }));
  const replayChart = vi.fn(async (): Promise<ReplayMarketChart> => ({ address: token, period: 'replay', resolution: '1m', source: 'gmgn',
    points: input.chartPoints.map(point => ({ timestamp: point.timestamp, priceUsd: String(point.priceUsd) })), candles: [], pending: false, stale: false,
    updatedAt: input.activity.generatedAt, marketCapSupply: '10000', currentQuote: { timestamp: input.activity.generatedAt, priceUsd: '4' } }));
  const charts = { chart, replayChart, diagnostics: async () => ({}) } as unknown as FreshCharts;
  const replay = createFreshReplay({ charts, secret: 'app-adapter-fixture-signing-secret-32-bytes', validateRevision: async () => approved });
  const reads = { activity: vi.fn(async (_wallet:string,_token:string,_scope:string,_replay:boolean) => structuredClone(input.activity)), leaderboard: vi.fn(async () => ({ items: [{ address: wallet, realizedProfitUsd: '37.6' }] })),
    summaries: vi.fn(async () => ({})), trades: vi.fn(async () => ({ items: [], nextCursor: null })), state: vi.fn(async () => ({})), boundary: vi.fn(async () => null), positionRows: vi.fn(async () => []) };
  const services = { charts, replay, reads, cache: {}, validateRevision: async () => approved } as unknown as FreshServices;
  const db = { query } as unknown as Pool;
  const { app } = await createFreshApp(db, { services }); await app.ready(); apps.push(app);
  return { app, charts, chart, replayChart, replay, reads, query, token, wallet, row, input, hide: () => { visible = false; }, revoke: () => { approved = false; } };
}

describe('fresh public chart and replay HTTP adapters', () => {
  it('keeps historical candles available without authorizing a retained no-liquidity quote', async () => {
    const {app,token,row,chart}=await fixture();row.valuation_status='no_liquidity';
    const response=await app.inject(`/api/tokens/${token}/chart?interval=1m`);
    expect(response.statusCode).toBe(200);expect(response.json().candles).toHaveLength(1);
    expect(chart.mock.calls[0][1].quote).toMatchObject({priceUsd:null,supply:'1000'});
    expect(row.price_usd).toBe('4');
  });
  it('rejects malformed identities, intervals and future cursors before provider work', async () => {
    const { app, token, chart } = await fixture();
    for (const url of ['/api/tokens/invalid/chart', `/api/tokens/${token}/chart?interval=1s`, `/api/tokens/${token}/chart?period=forever`, `/api/tokens/${token}/chart?workload=accounting`, `/api/tokens/${token}/chart?before=abc`, `/api/tokens/${token}/chart?before=${Math.floor(Date.now() / 1000) + 60}`]) expect((await app.inject(url)).statusCode).toBe(400);
    expect(chart).not.toHaveBeenCalled();
  });
  it('keeps private-only and unknown tokens off the public chart surface', async () => {
    const { app, token, hide, chart } = await fixture(); hide();
    expect((await app.inject(`/api/tokens/${token}/chart`)).statusCode).toBe(404); expect(chart).not.toHaveBeenCalled();
  });
  it.each([['24h', '5m',86400_000], ['7d', '1h',7*86400_000], ['30d', '4h',30*86400_000]])('preserves requested %s period independently of %s resolution', async (period, resolution,duration) => {
    const { app, token, chart } = await fixture();
    const response = await app.inject(`/api/tokens/${token}/chart?period=${period}`);
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ address: token, period, resolution });
    expect(chart.mock.calls[0][1]).toMatchObject({ period, resolution, workload: 'browse' });
    expect(chart.mock.calls[0][1].to-chart.mock.calls[0][1].from).toBe(duration);
  });
  it('routes selected token replays through the replay credential queue',async()=>{
    const {app,token,chart}=await fixture();await app.inject(`/api/tokens/${token}/chart?period=24h&priority=chart&workload=replay`);
    expect(chart.mock.calls[0][1]).toMatchObject({workload:'replay',foreground:true,period:'24h'});
  });
  it('clamps young-token requests to authenticated launch and uses verified token precision for supply', async () => {
    const { app, token, row, chart } = await fixture(); row.launched_at = new Date(Date.now() - 2 * 60_000);
    await app.inject(`/api/tokens/${token}/chart?interval=1m&priority=prefetch`);
    const options = chart.mock.calls[0][1]; expect(options.from).toBe(row.launched_at.getTime());
    expect(options).toMatchObject({ foreground: false, quote: { supply: '1000', priceUsd: '4', timestamp: row.observed_at.toISOString() } });
  });
  it('pages genuine old chart windows without claiming the latest 1000 bars are a lifetime chart', async () => {
    const { app, token, row, chart } = await fixture();
    const response = await app.inject(`/api/tokens/${token}/chart?interval=1m&history=full`), body = response.json();
    expect(body).toMatchObject({ fullHistory: true, historyComplete: false, historyPending: true });
    expect(body.historyBefore).toBe(Math.floor(chart.mock.calls[0][1].from / 1000));
    expect(chart.mock.calls[0][1].to-chart.mock.calls[0][1].from).toBe(1000*60_000);
    row.launched_at = new Date(Date.now() - 60_000);
    expect((await app.inject(`/api/tokens/${token}/chart?interval=1m&history=full`)).json()).toMatchObject({ fullHistory: true, historyComplete: true, historyPending: false });
  });
  it('returns provider cooldown as a dated clear chart state and preserves history response identity', async () => {
    const { app, token, chart } = await fixture(); chart.mockRejectedValue(new FreshChartError('provider_cooldown', 90_000));
    const response = await app.inject(`/api/tokens/${token}/chart?period=24h&history=full`);
    expect(response.statusCode).toBe(200); expect(response.headers['retry-after']).toBe('90');
    expect(response.json()).toMatchObject({ address: token, period: '24h', source: 'unavailable', loadStatus: 'rate_limited', pending: true, retryAfterMs: 90_000, fullHistory: true,
      historyLoadStatus:'rate_limited',historyRetryAfterMs:90_000,historyRecoveryPending:true });
  });
  it('pins selected details while keeping card/background accounting reads light',async()=>{
    const {app,token,wallet,reads,replay,input}=await fixture();const remember=vi.spyOn(replay,'remember');
    await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?pnl=true&profile=true`);
    expect(reads.activity.mock.calls[0][3]).toBe(false);expect(remember).not.toHaveBeenCalled();
    await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?pnl=true`);
    expect(reads.activity.mock.calls[1][3]).toBe(true);expect(remember).toHaveBeenCalledWith(input.activity,'public');
  });
  it('cancels a disconnected chart subscriber without leaving queued provider work',async()=>{
    const {app,token,chart}=await fixture();let signal!:AbortSignal;
    chart.mockImplementation((_token,options)=>{signal=options.signal!;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
    const url=await app.listen({host:'127.0.0.1',port:0}),controller=new AbortController();
    const request=fetch(url+`/api/tokens/${token}/chart`,{signal:controller.signal});const rejected=expect(request).rejects.toMatchObject({name:'AbortError'});
    await vi.waitFor(()=>expect(chart).toHaveBeenCalledOnce());controller.abort();await rejected;
    await vi.waitFor(()=>expect(signal.aborted).toBe(true));
  });
  it('joins matching selected replays across requests and returns one frozen signed object', async () => {
    const { app, wallet, token, replayChart, input } = await fixture();
    let finish!: (value: ReplayMarketChart) => void;
    replayChart.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const both = Promise.all([app.inject(`/api/kols/${wallet}/tokens/${token}/replay-preparation`), app.inject(`/api/kols/${wallet}/tokens/${token}/replay-preparation`)]);
    await vi.waitFor(() => expect(replayChart).toHaveBeenCalledOnce());
    finish({ address: token, period: 'replay', source: 'gmgn', resolution: '1m', candles: [], points: input.chartPoints.map(point => ({ timestamp: point.timestamp, priceUsd: String(point.priceUsd) })), pending: false, stale: false, updatedAt: input.activity.generatedAt });
    const [left, right] = await both; expect(left.statusCode).toBe(200); expect(right.json()).toEqual(left.json()); expect(left.json()).toMatchObject({ status: 'ready', manifest: expect.any(String) });
  });
  it('rejects corrected saved media without reading fresh history or allowing a chart export', async () => {
    const { app, wallet, token, replay, input, revoke, reads, replayChart } = await fixture();
    const saved = await replay.prepare(input.activity); revoke(); reads.activity.mockClear(); replayChart.mockClear();
    const response = await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?snapshot=${saved.snapshotId}`);
    expect(response.statusCode).toBe(410); expect(reads.activity).not.toHaveBeenCalled(); expect(replayChart).not.toHaveBeenCalled();
  });
  it('derives manifest audience on the server and refuses client-supplied scope overrides', async () => {
    const { app, replay, input } = await fixture(), prepared = await replay.prepare(input.activity);
    const response = await app.inject({ method: 'POST', url: '/api/replays/validate', payload: { manifest: prepared.manifest, scope: 'account:attacker' } });
    expect(response.statusCode).toBe(200); expect(response.json().valid).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/replays/validate', payload: { manifest: 'malformed' } })).statusCode).toBe(400);
  });
  it('keeps stored realized P&L available while GMGN charts are down', async () => {
    const { app, chart, token } = await fixture(); chart.mockRejectedValue(new FreshChartError('provider_cooldown', 60_000));
    await app.inject(`/api/tokens/${token}/chart`);
    expect((await app.inject('/api/leaderboard')).json().items[0].realizedProfitUsd).toBe('37.6');
  });
  it('serves canonical position proof identity rather than the last trade time',async()=>{
    const {app,token,wallet,query}=await fixture();
    query.mockResolvedValueOnce({rows:[{wallet_addresses:[wallet],token_address:token,quantity_q:'0',balance_quantity:'0',balance_status:'matched',balance_block:'100',balance_hash:'0x'+'a'.repeat(64),
      last_event_block:'99',capture_block:'999',last_event_at:'2026-01-01T00:00:00.000Z',balance_checked_at:'2026-01-01T00:01:00.000Z',wallet_gap:false,decoding_pending:false,registration_pending:false}] as never,rowCount:1});
    const response=await app.inject(`/api/tokens/${token}/positions`);
    expect(response.statusCode).toBe(200);expect(response.json().items[0]).toMatchObject({status:'Exited',confirmed:true,blockNumber:'100',coveredThroughBlock:'999',checkedAt:'2026-01-01T00:01:00.000Z'});
    expect(query.mock.calls[0][0]).toContain("s.id='kol:'||k.wallet_address");
  });
});
