import { describe, expect, it } from 'vitest';
import { groupTrackedTokens } from './trackedTokenGroups';
import { translate } from './i18n';

describe('tracked token visibility while node valuations are pending', () => {
  it('retains every recorded token without treating unavailable MCAP as a low cap', () => {
    const tokens = [null, '', 'not-priced', 'Infinity', '0', '-1'].map((marketCapUsd, index) => ({ address: String(index), marketCapUsd, recentTrades: [{ id: `trade-${index}` }] }));
    const grouped = groupTrackedTokens(tokens);
    expect(grouped.unpriced).toEqual(tokens);
    expect(grouped.unpriced[0]).toBe(tokens[0]);
    expect(grouped.low).toEqual([]); expect(grouped.mid).toEqual([]); expect(grouped.high).toEqual([]);
  });
  it('preserves existing cap boundaries and moves a token once genuine valuation arrives', () => {
    const tokens = ['0.01', '99999.99', '100000', '999999.99', '1000000'].map(marketCapUsd => ({ marketCapUsd }));
    const grouped = groupTrackedTokens(tokens);
    expect(grouped.low).toEqual(tokens.slice(0, 2)); expect(grouped.mid).toEqual(tokens.slice(2, 4)); expect(grouped.high).toEqual(tokens.slice(4));
    expect(groupTrackedTokens([{ marketCapUsd: '125000' }]).unpriced).toEqual([]);
  });
  it('explains unavailable valuation in English and Chinese', () => {
    expect(translate('Awaiting valuation', 'en')).toBe('Awaiting valuation');
    expect(translate('Awaiting valuation', 'zh-CN')).toBe('等待估值');
    expect(translate('Recorded trades · market cap unavailable', 'zh-CN')).toBe('已记录交易 · 市值暂不可用');
  });
});
