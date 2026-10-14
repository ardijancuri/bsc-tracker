import { describe, expect, it } from 'vitest';
import { legacyGmgnProfitKey, parseGmgnProfits } from './gmgnPnl.js';

const wallet = '0x1234567890123456789012345678901234567890';
const other = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

describe('legacy GMGN snapshot opt-in', () => {
  it('keeps the worker from consuming the shared app key unless legacy snapshots are explicitly enabled', () => {
    for (const setting of [undefined, '', 'false', '0']) {
      expect(legacyGmgnProfitKey({ GMGN_API_KEY: 'private-test-key', GMGN_LEGACY_PROFIT_SNAPSHOTS: setting })).toBeUndefined();
    }
    expect(legacyGmgnProfitKey({ GMGN_API_KEY: ' private-test-key ', GMGN_LEGACY_PROFIT_SNAPSHOTS: 'true' })).toBe('private-test-key');
    expect(legacyGmgnProfitKey({ GMGN_CHART_API_KEY: 'chart-key', GMGN_LEGACY_PROFIT_SNAPSHOTS: 'true' })).toBeUndefined();
    expect(legacyGmgnProfitKey({ GMGN_API_KEY: ' ', GMGN_LEGACY_PROFIT_SNAPSHOTS: 'true' })).toBeUndefined();
  });
});

describe('GMGN profit parsing', () => {
  it('preserves explicit zero and marks missing wallets as unavailable', () => {
    expect(parseGmgnProfits({ list: [{ wallet_address: wallet.toUpperCase().replace('0X', '0x'), realized_profit: '0', unrealized_profit: '-3.25' }] }, [wallet, other], '7d')).toEqual([
      { walletAddress: wallet, period: '7d', realizedProfitUsd: '0', unrealizedProfitUsd: '-3.25' },
      { walletAddress: other, period: '7d', realizedProfitUsd: null, unrealizedProfitUsd: null },
    ]);
  });

  it('rejects malformed profit values instead of ranking them as zero', () => {
    expect(() => parseGmgnProfits({ list: [{ wallet_address: wallet, realized_profit: 'unknown' }] }, [wallet], '1d')).toThrow();
    expect(() => parseGmgnProfits({}, [wallet], '1d')).toThrow();
  });
});
