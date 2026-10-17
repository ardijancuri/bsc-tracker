import { describe, expect, it } from 'vitest';
import { formatActivationMessage, formatCorrectionMessage, formatTelegramTradeMessage, type TelegramMessageTrade } from './telegramNotificationMessage.js';

const trade: TelegramMessageTrade = {
  id: '1', txHash: `0x${'12'.repeat(32)}`, walletAddress: `0x${'34'.repeat(20)}`, tokenAddress: `0x${'56'.repeat(20)}`,
  kolName: 'Afeng', tokenSymbol: 'BIBI', side: 'buy', tokenAmount: '12345.678901234', quoteAmount: '0.1234', quoteSymbol: 'BNB', amountUsd: '515.6798', timestamp: '2026-10-17T12:34:56Z',
};

describe('Telegram trade messages', () => {
  it('includes source amounts and UTC trade time without P&L or provider dependencies', () => {
    const result = formatTelegramTradeMessage([trade], 'en', 'https://kollens.com');
    expect(result.text).toContain('Afeng');
    expect(result.text).toContain('BUY BIBI · $515.67 · 0.1234 BNB · 12,345.678901 BIBI');
    expect(result.text).toContain('2026-10-17 12:34:56 UTC');
    expect(result.buttons.flat().map(button => button.url)).toEqual([
      `https://kollens.com/kol/${trade.walletAddress}`, `https://kollens.com/token/${trade.tokenAddress}`, `https://bscscan.com/tx/${trade.txHash}`,
    ]);
  });
  it('falls back to addresses and still generates messages with unknown prices', () => {
    const result = formatTelegramTradeMessage([{ ...trade, kolName: null, tokenSymbol: null, tokenAmount: null, quoteAmount: null, amountUsd: null }], 'en', 'https://kollens.com');
    expect(result.text).toContain('0x343434…343434');
    expect(result.text).toContain('BUY 0x565656…565656');
    expect(result.text).not.toContain('$');
  });
  it('retains mixed buys and sells separately instead of inventing a net trade', () => {
    const result = formatTelegramTradeMessage([trade, { ...trade, id: '2', side: 'sell' }], 'en', 'https://kollens.com');
    expect(result.text).toContain('1 buys · 1 sells');
    expect(result.text).toContain('BUY BIBI');
    expect(result.text).toContain('SELL BIBI');
    expect(result.buttons.flat().find(button => button.text === 'First trade · BscScan')?.url).toBe(`https://bscscan.com/tx/${trade.txHash}`);
  });
  it('localizes all user-facing fixed phrases for Chinese', () => {
    const result = formatTelegramTradeMessage([trade, { ...trade, side: 'sell' }], 'zh-CN', 'https://kollens.com');
    expect(result.text).toContain('买入 1 · 卖出 1');
    expect(result.text).toContain('买入 BIBI');
    expect(result.text).toContain('卖出 BIBI');
    expect(result.buttons[0][0].text).toBe('查看 KOL');
    expect(formatActivationMessage('zh-CN', 'https://kollens.com').text).toContain('/stop');
    expect(formatCorrectionMessage('zh-CN', 'https://kollens.com').text).toContain('链重组');
  });
  it('bounds huge bursts and links the complete KOL activity without dropping stored events', () => {
    const result = formatTelegramTradeMessage(Array.from({ length: 1000 }, (_, i) => ({ ...trade, id: String(i), kolName: 'A'.repeat(400), tokenSymbol: 'B'.repeat(400) })), 'en', 'https://kollens.com');
    expect(result.text.length).toBeLessThanOrEqual(3600);
    expect(result.text).toContain('more trades; view them on Kollens.');
    expect(result.buttons[0][0].url).toContain(`/kol/${trade.walletAddress}`);
  });
  it('removes control and bidirectional formatting characters from malicious metadata', () => {
    const result = formatTelegramTradeMessage([{ ...trade, kolName: 'Admin\n\u0000\u202eTEST', tokenSymbol: '<b>BIBI</b>\n\u0001\u2066BTC', quoteSymbol: '\u202eBNB' }], 'en', 'https://kollens.com');
    expect(result.text).toContain('Admin TEST');
    expect(result.text).toContain('<b>BIBI</b> BTC');
    expect(result.text).not.toMatch(/[\u0000\u0001\u202e\u2066]/);
  });
  it('does not produce unsafe button URLs or nonfinite and scientific-notation quantities', () => {
    const result = formatTelegramTradeMessage([{ ...trade, tokenAddress: 'https://evil.example', walletAddress: 'javascript:alert(1)', txHash: '//evil.example', amountUsd: 'Infinity', tokenAmount: '1e300', quoteAmount: 'NaN' }], 'en', 'javascript:evil');
    expect(result.text).not.toMatch(/Infinity|NaN|1e300/);
    expect(result.buttons).toEqual([[{ text: 'View KOL', url: 'https://kollens.com/watchlist' }]]);
  });
  it('formats very small decimal quantities without silently changing them to zero', () => {
    const result = formatTelegramTradeMessage([{ ...trade, amountUsd: '0.0000009', tokenAmount: '0.000000001', quoteAmount: '0.0000000001' }], 'en', 'https://kollens.com');
    expect(result.text).toContain('$<0.01');
    expect(result.text).toContain('<0.000001 BIBI');
  });
  it('makes activation and correction messages actionable', () => {
    expect(formatActivationMessage('en', 'http://127.0.0.1:5173').buttons[0][0].url).toBe('http://127.0.0.1:5173/watchlist?tab=kols');
    expect(formatCorrectionMessage('en', 'https://kollens.com').text).toContain('no longer on the confirmed chain');
    expect(formatTelegramTradeMessage([], 'en', 'https://kollens.com').text).toContain('No new trades');
  });
});
