import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIntelligenceRoutes } from './intelligenceApi.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), chart: vi.fn(), start: vi.fn() }));
vi.mock('./db.js', () => ({ pool: { query: mocks.query } }));
vi.mock('./tokenChart.js', async importOriginal => ({ ...await importOriginal<typeof import('./tokenChart.js')>(), currentMarketChart: mocks.chart }));
vi.mock('./tokenSupply.js', () => ({ tokenSupplyRequests: { start: mocks.start } }));
const address = '0xdd806e436dda5588bf54061c11590c77ddc87777';
const metadata = { rawSupply: '1000000000000000000000000000', decimals: 18, supplyCheckedAt: '2026-10-12T12:00:00.000Z' };
const history = { address, period: '24h', candles: [{ time: 100, open: 1, high: 2, low: .5, close: 1.5, volume: 10 }], points: [], resolution: '5m', source: 'coinmarketcap' };
beforeEach(() => { mocks.query.mockResolvedValue({ rows: [metadata] }); mocks.chart.mockResolvedValue({ chart: history, pending: false }); });
afterEach(() => vi.resetAllMocks());

describe('chart supply loading', () => {
  it('keeps genuine candles and retries quickly while the supply read is pending', async () => {
    const snapshot = () => ({ supply: null, checkedAt: null, pending: true, retryAfterMs: 3000 });
    mocks.start.mockReturnValue({ snapshot, settle: async () => snapshot() });
    const app = Fastify(); registerIntelligenceRoutes(app);
    try {
      const response = await app.inject(`/api/tokens/${address}/chart?interval=5m`);
      expect(response.json()).toMatchObject({ candles: history.candles, marketCapSupply: null, supplyPending: true, pending: true, loadStatus: 'queued', retryAfterMs: 3000 });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(mocks.start).toHaveBeenCalledWith(address, metadata);
    } finally { await app.close(); }
  });
  it('uses a supply that finished during chart loading instead of serializing an earlier pending snapshot', async () => {
    let complete = false;
    const snapshot = () => complete ? { supply: '1000000000', checkedAt: metadata.supplyCheckedAt, pending: false }
      : { supply: null, checkedAt: null, pending: true, retryAfterMs: 3000 };
    mocks.start.mockReturnValue({ snapshot, settle: async () => snapshot() });
    mocks.chart.mockImplementation(async () => { complete = true; return { chart: history, pending: false }; });
    const app = Fastify(); registerIntelligenceRoutes(app);
    try {
      const response = await app.inject(`/api/tokens/${address}/chart?interval=5m`);
      expect(response.json()).toMatchObject({ marketCapSupply: '1000000000', supplyCheckedAt: metadata.supplyCheckedAt, supplyPending: false, pending: false });
      expect(response.json().loadStatus).toBeUndefined();
      expect(response.headers['cache-control']).toBe('public, max-age=15');
    } finally { await app.close(); }
  });
  it('keeps failed supply refreshes distinguishable from missing market history', async () => {
    const snapshot = () => ({ supply: null, checkedAt: null, pending: false, retryAfterMs: 30_000 });
    mocks.start.mockReturnValue({ snapshot, settle: async () => snapshot() });
    const app = Fastify(); registerIntelligenceRoutes(app);
    try {
      const response = await app.inject(`/api/tokens/${address}/chart?interval=5m`);
      expect(response.json()).toMatchObject({ candles: history.candles, source: 'coinmarketcap', marketCapSupply: null, supplyPending: false, loadStatus: 'provider_error', retryAfterMs: 30_000 });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });
});
