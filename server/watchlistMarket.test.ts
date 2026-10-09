import { describe, expect, it } from 'vitest';
import { observedChange, watchlistMarket } from './watchlistMarket.js';

describe('watched token prices', () => {
  it('calculates both rising and falling prices without treating missing prices as zero', () => {
    expect(observedChange('1.5', '1')).toBe('50');
    expect(observedChange('0.75', '1')).toBe('-25');
    for (const previous of [null, undefined, '0', 'NaN', '-1']) expect(observedChange('1', previous)).toBeNull();
    expect(observedChange(null, '1')).toBeNull();
  });
  it('uses observed baseline prices and preserves market change when a baseline is missing', () => {
    const row = { kind: 'token' as const, address: '0x1', name: 'Example', priceUsd: '2', price1hAgo: '1', change24h: '12' };
    expect(watchlistMarket(row)).toMatchObject({ change1h: '100', change24h: '12' });
    expect(watchlistMarket({ ...row, price24hAgo: '4' }).change24h).toBe('-50');
    expect(watchlistMarket(row)).not.toHaveProperty('price1hAgo');
  });
  it('does not present daily changes as weekly or monthly changes', () => {
    const row = { kind: 'token' as const, address: '0x1', name: 'Example', priceUsd: '2', change24h: '12', pricePeriodAgo: null };
    expect(watchlistMarket(row, '24h').periodChange).toBe('12');
    expect(watchlistMarket(row, '7d').periodChange).toBeNull();
    expect(watchlistMarket({ ...row, pricePeriodAgo: '4' }, '30d').periodChange).toBe('-50');
    expect(watchlistMarket(row, '7d')).not.toHaveProperty('pricePeriodAgo');
  });
});
