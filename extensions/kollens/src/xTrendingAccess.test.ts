import { afterEach, expect, it, vi } from 'vitest';
import type { MarketMomentumToken, TrendingToken } from '../../../shared/trendingTokens';
import { loadXTrendingTokens, selectXMarketMomentum } from './xTrendingAccess';

vi.mock('./platform', () => ({
  browserApi: {
    runtime: { id: 'kollens-extension' },
    tabs: { get: async () => ({ url: 'https://x.com/home' }) },
    permissions: { contains: async () => true },
    storage: { local: { get: async()=>({}) } },
  },
  config: { apiOrigin: 'https://kollens.com' },
}));

const token = (byte: string): MarketMomentumToken => ({
  address: '0x' + byte.repeat(20), name: 'Example', symbol: 'EX', priceChangePct: 34.5, volumeUsd: '4200',
  marketCapUsd: null, buyCount: 12, sellCount: 9,
});
const tracked = { address: token('aa').address, kolCount: 2, logoUrl: null } as TrendingToken;
const base = { window: '6h' as const, asOf: '2026-11-13T12:00:00Z', items: [tracked] };

afterEach(() => vi.unstubAllGlobals());

it('keeps exact-contract order while filtering tracked duplicates and malformed market rows', () => {
  const genuine = token('bb');
  expect(selectXMarketMomentum({
    ...base,
    marketMomentum: [token('aa'), genuine, { ...genuine, name: 'Duplicate pool' }, { ...token('cc'), priceChangePct: -2 }],
  })).toEqual([genuine]);
  expect(selectXMarketMomentum({ ...base, marketMomentum: [{ ...genuine, address: 'https://example.com' }] })).toEqual([]);
  expect(selectXMarketMomentum({ ...base, marketMomentum: [{ ...genuine, volumeUsd: 'NaN' }] })).toEqual([]);
  expect(selectXMarketMomentum({ ...base, marketMomentum: Array(5).fill(genuine) })).toEqual([]);
  expect(selectXMarketMomentum(base)).toEqual([]);
});

it('loads tracked activity by default and requests momentum separately with its thumbnail', async () => {
  vi.stubGlobal('__LOCAL_FIXTURE__', false);
  const marketMomentum = [{...token('bb'),logoUrl:'/api/token-image/'+token('bb').address+'?fallback=momentum'}];
  const fetch = vi.fn(async (url:string|URL) => {
    if(String(url).includes('/api/token-image/'))return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/webp'}});
    return new Response(JSON.stringify(String(url).endsWith('&view=market')?{...base,items:[],marketMomentum}:base));
  });
  vi.stubGlobal('fetch', fetch);
  const sender = { id: 'kollens-extension', frameId: 0, tab: { id: 1 }, url: 'https://x.com/home' } as chrome.runtime.MessageSender;
  const response = await Promise.all([loadXTrendingTokens('6h', sender), loadXTrendingTokens('6h', sender)]);
  expect(response).toEqual(Array(2).fill({ ...base, items: [{ ...tracked, thumbnail: null }], marketMomentum:[] }));
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    'https://kollens.com/api/extension/trending-tokens?window=6h',
    expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
  );
  expect((await loadXTrendingTokens('6h',sender,'market')).marketMomentum?.[0]).toMatchObject({thumbnail:'data:image/webp;base64,AQID'});
  expect(fetch).toHaveBeenCalledTimes(3);
});
