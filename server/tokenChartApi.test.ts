import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerIntelligenceRoutes } from './intelligenceApi.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), currentMarketChart: vi.fn(), currentFullMarketChart: vi.fn() }));
vi.mock('./db.js', () => ({ pool: { query: mocks.query } }));
vi.mock('./tokenChart.js', async importOriginal => ({ ...await importOriginal<typeof import('./tokenChart.js')>(), currentMarketChart: mocks.currentMarketChart }));
vi.mock('./tokenFullHistory.js', () => ({ currentFullMarketChart: mocks.currentFullMarketChart }));
vi.mock('./tokenSupply.js', () => ({ tokenSupplyRequests: { start: (_address: string, metadata: { supply?: string | null }) => {
  const snapshot = () => ({ supply: metadata.supply ?? null, checkedAt: null, pending: false });
  return { snapshot, settle: async () => snapshot() };
} } }));
const address = '0xd75a0cc8614b7c8cac56f5af39d73491c2ea7777';
afterEach(() => vi.resetAllMocks());

describe('token chart API intervals', () => {
  it.each(['1m', '5m', '1h', '4h', '1d'])('serves %s with token supply and the requested interval even when the cache is shared', async interval => {
    const app = Fastify(); registerIntelligenceRoutes(app);
    mocks.query.mockResolvedValue({ rows: [{ supply: '1000000000' }] });
    mocks.currentMarketChart.mockResolvedValue({ chart: { address, period: '24h', candles: [{ time: 100, open: 1, high: 2, low: .5, close: 1.5, volume: 10 }], points: [], resolution: interval, source: 'geckoterminal' }, pending: false });
    try {
      const response = await app.inject(`/api/tokens/${address}/chart?interval=${interval}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ period: interval, resolution: interval, marketCapSupply: '1000000000' });
      expect(mocks.currentMarketChart).toHaveBeenCalledWith(address, interval);
    } finally { await app.close(); }
  });
  it.each(['1s', '30s', '2m', '../day'])('rejects unsupported %s without querying the database or provider', async interval => {
    const app = Fastify(); registerIntelligenceRoutes(app);
    try {
      expect((await app.inject(`/api/tokens/${address}/chart?interval=${interval}`)).statusCode).toBe(400);
      expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.currentMarketChart).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each(['chart', 'prefetch', 'sparkline'])('forwards explicit %s priority independently of the selected interval', async priority => {
    const app = Fastify(); registerIntelligenceRoutes(app);
    mocks.query.mockResolvedValue({ rows: [{ supply: '1000000000' }] });
    mocks.currentMarketChart.mockResolvedValue({ chart: null, pending: true });
    try {
      expect((await app.inject(`/api/tokens/${address}/chart?interval=1m&priority=${priority}`)).statusCode).toBe(200);
      expect(mocks.currentMarketChart).toHaveBeenCalledWith(address, '1m', priority);
    } finally { await app.close(); }
  });
  it('rejects an invalid request priority before querying the database or provider', async () => {
    const app = Fastify(); registerIntelligenceRoutes(app);
    try {
      expect((await app.inject(`/api/tokens/${address}/chart?interval=1m&priority=metadata`)).statusCode).toBe(400);
      expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.currentMarketChart).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('serves opt-in full minute history and passes the exclusive historical boundary without changing recent requests', async () => {
    const app = Fastify(); registerIntelligenceRoutes(app);
    mocks.query.mockResolvedValue({ rows: [{ supply: '1000000000' }] });
    mocks.currentFullMarketChart.mockResolvedValue({ chart: { address, period: '1m', resolution: '1m', source: 'gmgn',
      fullHistory: true, historyComplete: false, historyPending: true, historyBefore: 900, candles: [], points: [] }, pending: false });
    try {
      const response = await app.inject(`/api/tokens/${address}/chart?interval=1m&history=full&before=1000&priority=prefetch`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ fullHistory: true, historyBefore: 900, marketCapSupply: '1000000000' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(mocks.currentFullMarketChart).toHaveBeenCalledWith(address, '1m', 'prefetch', 1000);
      expect(mocks.currentMarketChart).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it.each(['period=24h&history=full', 'interval=1m&history=all', 'interval=1m&before=1000',
    'interval=1m&history=full&before=0', 'interval=1m&history=full&before=1.5', 'interval=1m&history=full&before=NaN'])('rejects invalid full history request %s before accessing data', async query => {
    const app = Fastify(); registerIntelligenceRoutes(app);
    try {
      expect((await app.inject(`/api/tokens/${address}/chart?${query}`)).statusCode).toBe(400);
      expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.currentFullMarketChart).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('does not return sparse trade prices as candles when interval data is pending', async () => {
    const app = Fastify(); registerIntelligenceRoutes(app);
    mocks.query.mockResolvedValue({ rows: [{ supply: null, price: '1' }] });
    mocks.currentMarketChart.mockResolvedValue({ chart: null, pending: true });
    try {
      const response = await app.inject(`/api/tokens/${address}/chart?interval=5m`);
      expect(response.json()).toMatchObject({ candles: [], points: [], pending: true, marketCapSupply: null, source: 'unavailable' });
      expect(mocks.query).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
  it('keeps provider cooldowns distinguishable from missing history and prevents caching a loading response', async () => {
    const app = Fastify(); registerIntelligenceRoutes(app);
    mocks.query.mockResolvedValue({ rows: [{ supply: '1000000000' }] });
    mocks.currentMarketChart.mockResolvedValue({ chart: null, pending: false, loadStatus: 'rate_limited', retryAfterMs: 120_000 });
    try {
      const response = await app.inject(`/api/tokens/${address}/chart?interval=5m`);
      expect(response.json()).toMatchObject({ candles: [], loadStatus: 'rate_limited', retryAfterMs: 120_000 });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
});
