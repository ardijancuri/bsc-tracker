import { expect, it } from 'vitest';
import { selectTokenMarkets } from './tokenMarkets.js';
it('uses the watched base token from its most liquid pool, including actual zero change', () => {
  const markets = selectTokenMarkets([
    { baseToken: { address: '0xABC' }, marketCap: 500, liquidity: { usd: 10 }, priceChange: { h24: 5 } },
    { baseToken: { address: '0xabc' }, marketCap: 600, liquidity: { usd: 20 }, priceChange: { h24: 0 } },
    { baseToken: { address: '0xother' }, marketCap: 999, liquidity: { usd: 100 } },
  ], ['0xabc']);
  expect([...markets.entries()]).toEqual([['0xabc', { cap: 600, liquidity: 20, change24h: 0 }]]);
});
it('keeps missing or invalid percentage changes unknown and rejects invalid market caps', () => {
  const markets = selectTokenMarkets([
    { baseToken: { address: 'one' }, marketCap: 100 },
    { baseToken: { address: 'two' }, marketCap: 100, priceChange: { h24: -101 } },
    { baseToken: { address: 'bad' }, marketCap: Infinity },
  ], ['one', 'two', 'bad']);
  expect(markets.get('one')?.change24h).toBeNull();
  expect(markets.get('two')?.change24h).toBeNull();
  expect(markets.has('bad')).toBe(false);
});
