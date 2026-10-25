import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KolTokenTrade } from '../shared/kolTokenTrades';
import type { JournalTrade } from '../shared/journal';
import { KolTokenTradeReceipt } from './KolTokenTradeReceipt';
import { JournalTradeValue } from './JournalTradeValue';
import { setLanguage } from './i18n';

const stableQuotes = [
  ['USDC', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'],
  ['USDT', '0x55d398326f99059ff775485246999027b3197955'],
] as const;
const trade = (quoteSymbol = 'USDC', quoteTokenAddress: string = stableQuotes[0][1]): KolTokenTrade => ({
  id: 'independent-token-trade', txHash: '0x' + 'a'.repeat(64), walletAddress: '0x' + '1'.repeat(40),
  tokenAddress: '0x' + '2'.repeat(40), kolName: null, kolAvatarUrl: null, kolTwitter: null,
  tokenSymbol: 'EXAMPLE', tokenName: 'Example', tokenLogoUrl: null, side: 'buy', tokenAmount: '1000',
  quoteSymbol, quoteTokenAddress, quoteAmount: '123.456789123456789123', amountUsd: '123.4',
  bnbEquivalentAmount: '0.15425', priceUsd: '0.1234', marketCapUsd: '123400', timestamp: '2026-10-24T00:00:00Z',
  source: 'node', blockNumber: '123', transactionIndex: 0, valuationStatus: 'valued',
  realizedProfitUsd: '0', cumulativeRealizedProfitUsd: '0',
});
const portfolioTrade = (value: KolTokenTrade): JournalTrade => ({ ...value, side: value.side === 'sell' ? 'sell' : 'buy', source: 'node' });
afterEach(() => setLanguage('en'));

describe('stable trade amounts across details and Portfolio', () => {
  it.each(stableQuotes)('shows %s buys and sells as dated BNB equivalents while visibly retaining the exact original settlement', (symbol, address) => {
    for (const side of ['buy', 'sell'] as const) {
      const value = Object.freeze({ ...trade(symbol, address), side });
      const before = JSON.stringify(value), html = renderToStaticMarkup(<KolTokenTradeReceipt trade={value} />);
      expect(html).toContain('≈0.154 BNB');
      expect(html).toContain(`123.456789123456789123 ${symbol}</small>`);
      expect(html).toContain(`Recorded ${symbol} trade amount: 123.456789123456789123`);
      expect(html).toContain(`BNB equivalent at trade time: 0.15425 BNB · Settled: 123.456789123456789123 ${symbol}`);
      expect(JSON.stringify(value)).toBe(before);
    }
  });
  it.each(stableQuotes)('carries the %s conversion into Portfolio without dropping its original amount or quote identity', (symbol, address) => {
    const value = portfolioTrade(trade(symbol, address)), html = renderToStaticMarkup(<JournalTradeValue trade={value} />);
    expect(html).toContain('≈0.154 BNB');
    expect(html).toContain(`Settled: 123.456789123456789123 ${symbol}`);
    expect(value.quoteTokenAddress).toBe(address);
  });
  it.each(stableQuotes)('keeps the original %s settlement visible when the historical BNB rate is unavailable', (symbol, address) => {
    const value = { ...trade(symbol, address), bnbEquivalentAmount: null };
    const html = renderToStaticMarkup(<KolTokenTradeReceipt trade={value} />);
    expect(html).toContain(`123.456789123456789123 ${symbol}</small>`);
    expect(html).toContain('$123.40');
    expect(html).not.toContain('≈');
    expect(renderToStaticMarkup(<JournalTradeValue trade={portfolioTrade(value)} />)).toContain(`123.457 ${symbol}`);
  });
  it('does not present an unverified USD amount or BNB equivalent as verified accounting', () => {
    const value = { ...trade(), valuationStatus: 'shared_quote' as const };
    const html = renderToStaticMarkup(<KolTokenTradeReceipt trade={value} />);
    expect(html).not.toContain('≈0.154 BNB');
    expect(html).not.toContain('$123.40');
    expect(html).toContain('Transaction spend could not be allocated to this token');
    expect(html).toContain('123.456789123456789123 USDC</small>');
  });
  it('does not show malformed or unverified quote identities as original settlements', () => {
    for (const change of [{ quoteTokenAddress: null }, { quoteAmount: 'NaN' }, { quoteSymbol: 'USDC\nmalicious' }]) {
      const html = renderToStaticMarkup(<KolTokenTradeReceipt trade={{ ...trade(), ...change }} />);
      expect(html).not.toContain('kol-trade-settlement');
      expect(html).not.toContain('≈0.154 BNB');
    }
  });
  it('translates the exact settlement tooltip without modifying the recorded numbers', () => {
    setLanguage('zh-CN');
    const html = renderToStaticMarkup(<KolTokenTradeReceipt trade={trade()} />);
    expect(html).toContain('已记录的 USDC 交易金额：123.456789123456789123');
    expect(html).toContain('实际结算：123.456789123456789123 USDC');
  });
});
