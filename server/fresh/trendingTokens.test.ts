import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { MarketMomentumToken } from '../../shared/trendingTokens.js';
import { registerFreshTrendingTokens } from './trendingTokens.js';

const address = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const endpoint = '/api/extension/trending-tokens';
const market = (n: number): MarketMomentumToken => ({
  address: address(n), name: 'Meme token', symbol: 'MEME', marketCapUsd: null, volumeUsd: '1800',
  priceChangePct: 20, buyCount: 14, sellCount: 6,
});
const trackedRows = [{
  address: address(1), name: 'Tracked token', symbol: 'TRACKED', kols: [], kol_count: 2, buy_count: 2, sell_count: 0,
  display_volume_usd: '400', volume_incomplete: false,
}];

describe('Fresh X trending endpoint', () => {
  it('uses the independent momentum reader only when requested, with no duplicate contracts', async () => {
    const app = Fastify();
    const query = vi.fn(async () => ({ rows: trackedRows }));
    const read = vi.fn(async () => [market(1), market(2), market(2), market(3), market(4), market(5), market(6)]);
    registerFreshTrendingTokens(app, { query }, read);
    try {
      const tracked = await app.inject({ method: 'GET', url: endpoint + '?window=15m' });
      expect(tracked.statusCode).toBe(200);
      expect(tracked.headers['cache-control']).toBe('public, max-age=30');
      expect(tracked.json()).not.toHaveProperty('marketMomentum');
      expect(read).not.toHaveBeenCalled();

      const full = await app.inject({ method: 'GET', url: endpoint + '?window=15m&momentum=1' });
      expect(full.statusCode).toBe(200);
      expect(full.headers['cache-control']).toBe('no-store');
      expect(full.json()).toEqual({ ...tracked.json(), marketMomentum: [market(2), market(3), market(4), market(5)] });
      expect(read).toHaveBeenCalledExactlyOnceWith('15m');
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('keeps the tracked feed available when the optional provider throws', async () => {
    const app = Fastify();
    const read = vi.fn(() => { throw Error('provider unavailable'); });
    registerFreshTrendingTokens(app, { query: vi.fn(async () => ({ rows: trackedRows })) }, read);
    try {
      const failed = await app.inject({ method: 'GET', url: endpoint + '?momentum=1' });
      expect(failed.statusCode).toBe(200);
      expect(failed.json()).not.toHaveProperty('marketMomentum');
      expect(failed.json().items.map((item: { address: string }) => item.address)).toEqual([address(1)]);
      const invalid = await app.inject({ method: 'GET', url: endpoint + '?window=1d&momentum=1' });
      expect(invalid.statusCode).toBe(400);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
