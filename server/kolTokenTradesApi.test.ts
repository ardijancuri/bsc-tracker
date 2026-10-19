import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerKolTokenTradesRoutes } from './kolTokenTradesApi.js';
const mocks = vi.hoisted(() => ({ activity: vi.fn(), savedActivity: vi.fn(), summaries: vi.fn(), prepare: vi.fn(), resumeChartGaps: vi.fn() }));
vi.mock('./nodeAccounting.js', () => ({ nodeAccountingService: mocks }));
vi.mock('./nodeReplayPreparation.js', () => ({ nodeReplayPreparation: { prepare: mocks.prepare } }));
vi.mock('./nodeHistoricalImport.js', () => ({ nodeHistoricalImporter: { resumeChartGaps: mocks.resumeChartGaps } }));
const wallet = '0x' + 'a'.repeat(40), token = '0x' + 'b'.repeat(40);
afterEach(() => vi.resetAllMocks());
describe('database-backed KOL token activity adapter', () => {
  it('resumes genuine imported chart gaps only for the approved complete public snapshot window', async () => {
    const window = { from: '2026-10-15T00:00:00Z', to: '2026-10-19T00:00:00Z', id: 'b'.repeat(64) };
    mocks.activity.mockResolvedValue({ accountingSnapshot: { complete: true, snapshotId: 'a'.repeat(64) } });
    mocks.prepare.mockResolvedValue({ version: 2, status: 'pending', reason: 'chart_coverage', window });
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    try {
      const response = await app.inject(`/api/kols/${wallet}/tokens/${token}/replay-preparation`);
      expect(response.statusCode).toBe(200);
      expect(mocks.resumeChartGaps).toHaveBeenCalledExactlyOnceWith(wallet, token, window);
      mocks.resumeChartGaps.mockClear(); mocks.activity.mockResolvedValue({ accountingSnapshot: { complete: false } });
      await app.inject(`/api/kols/${wallet}/tokens/${token}/replay-preparation`);
      expect(mocks.resumeChartGaps).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('rejects evidence invalidated while its chart was being prepared', async () => {
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    mocks.activity.mockResolvedValue({ accountingSnapshot: { snapshotId: 'a'.repeat(64) } });
    mocks.prepare.mockResolvedValue({ version: 2, status: 'ready' }); mocks.savedActivity.mockResolvedValue(undefined);
    try {
      const result = await app.inject(`/api/kols/${wallet}/tokens/${token}/replay-preparation`);
      expect(result.statusCode).toBe(410); expect(mocks.savedActivity).toHaveBeenCalledWith({ wallet, token, foreground: true }, 'a'.repeat(64));
    } finally { await app.close(); }
  });
  it('joins the shared selected-trade snapshot without provider or inventory work', async () => {
    mocks.activity.mockResolvedValue({ generatedAt: '2026-10-19T00:00:00Z', realizedAccounting: { status: 'pending', retryAfterMs: 1500 } });
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    try {
      const result = await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?pnl=true&replay=true`);
      expect(result.statusCode).toBe(200); expect(result.headers['retry-after']).toBe('2');
      expect(mocks.activity).toHaveBeenCalledExactlyOnceWith({ wallet, token, foreground: true });
    } finally { await app.close(); }
  });
  it('uses background priority for profile refreshes', async () => {
    mocks.activity.mockResolvedValue({ generatedAt: '2026-10-19T00:00:00Z' });
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    try {
      await app.inject(`/api/kols/${wallet}/tokens/${token}/activity?pnl=true&profile=true`);
      expect(mocks.activity).toHaveBeenCalledWith({ wallet, token, foreground: false });
    } finally { await app.close(); }
  });
  it('returns a missing/excluded public pair as 404', async () => {
    const app = Fastify(); registerKolTokenTradesRoutes(app); mocks.activity.mockResolvedValue(undefined);
    try { expect((await app.inject(`/api/kols/${wallet}/tokens/${token}/activity`)).statusCode).toBe(404); }
    finally { await app.close(); }
  });
  it('loads the first six summaries in one bounded service call', async () => {
    const tokens = Array.from({ length: 6 }, (_, index) => '0x' + String(index + 1).repeat(40));
    const app = Fastify(); registerKolTokenTradesRoutes(app); mocks.summaries.mockResolvedValue({});
    try {
      const result = await app.inject(`/api/kols/${wallet}/token-summaries?tokens=${tokens.join(',')}`);
      expect(result.statusCode).toBe(200); expect(mocks.summaries).toHaveBeenCalledExactlyOnceWith(wallet, tokens);
      expect(mocks.activity).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('rejects malformed and excessive batches before calling shared services', async () => {
    const app = Fastify(); registerKolTokenTradesRoutes(app);
    try {
      for (const url of [`/api/kols/invalid/tokens/${token}/activity`, `/api/kols/${wallet}/token-summaries?tokens=no`,
        `/api/kols/${wallet}/token-summaries?tokens=${Array(25).fill(token).join(',')}`]) expect((await app.inject(url)).statusCode).toBe(400);
      expect(mocks.activity).not.toHaveBeenCalled(); expect(mocks.summaries).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
