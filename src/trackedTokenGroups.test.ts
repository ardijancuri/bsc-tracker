import { describe, expect, it } from 'vitest';
import { groupTrackedTokens } from './trackedTokenGroups';

describe('tracked token market-cap buckets', () => {
  it('omits unavailable MCAP without treating it as a low cap or changing the source records', () => {
    const tokens = [null, '', 'not-priced', 'Infinity', '0', '-1'].map((marketCapUsd, index) => ({ address: String(index), marketCapUsd, recentTrades: [{ id: `trade-${index}` }] }));
    const grouped = groupTrackedTokens(tokens);
    expect(Object.keys(grouped)).toEqual(['low', 'mid', 'high']);
    expect(tokens).toHaveLength(6);
    expect(tokens[0].recentTrades).toEqual([{ id: 'trade-0' }]);
    expect(grouped.low).toEqual([]); expect(grouped.mid).toEqual([]); expect(grouped.high).toEqual([]);
  });
  it('preserves existing cap boundaries and moves a token once genuine valuation arrives', () => {
    const tokens = ['0.01', '99999.99', '100000', '999999.99', '1000000'].map(marketCapUsd => ({ marketCapUsd }));
    const grouped = groupTrackedTokens(tokens);
    expect(grouped.low).toEqual(tokens.slice(0, 2)); expect(grouped.mid).toEqual(tokens.slice(2, 4)); expect(grouped.high).toEqual(tokens.slice(4));
  });
  it('omits tokens without liquidity instead of placing them under pending valuations', () => {
    const noLiquidity = { address: 'bi', marketCapUsd: null, valuationStatus: 'no_liquidity', recentTrades: [{ id: 'sell' }] };
    const pending = { address: 'pending', marketCapUsd: null, valuationStatus: 'pending' };
    const unknown = { address: 'unknown', marketCapUsd: null };
    const grouped = groupTrackedTokens([noLiquidity, pending, unknown]);
    expect(Object.values(grouped).flat()).toEqual([]);
  });
  it('does not display a retained old cap when liquidity is absent, and restores its bucket after a fresh valuation', () => {
    const retained = { marketCapUsd: '125000', valuationStatus: 'no_liquidity' };
    expect(Object.values(groupTrackedTokens([retained])).flat()).toEqual([]);
    expect(groupTrackedTokens([retained]).mid).toEqual([]);
    const refreshed = { ...retained, valuationStatus: 'ready' };
    expect(groupTrackedTokens([refreshed]).mid).toEqual([refreshed]);
  });
});
