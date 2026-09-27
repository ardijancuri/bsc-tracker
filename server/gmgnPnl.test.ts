import { describe, expect, it } from 'vitest';
import { parseGmgnProfits } from './gmgnPnl.js';

const wallet = '0x1234567890123456789012345678901234567890';
const other = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

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
