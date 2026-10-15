import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity, KolTokenBalanceProof, KolTokenTrade } from '../shared/kolTokenTrades.js';
import { createGmgnHistoryPnl } from '../server/gmgnHistoryPnl.js';
import { applyReplayMarketChart, prepareTradeReplayData, replayAccountingTotal, replayInventoryIsFresh } from './tradeReplayData.js';
import { replayMarketData } from './tradeReplayMarketRequest.js';
import ReplayCanvas from './tradeReplayCanvas.js';
import type { ReplayMarketChart } from '../shared/replayChart.js';

const time = Date.parse('2026-10-15T00:00:00Z'), wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40), native = '0x' + '0'.repeat(40);
const hash = (value: number) => '0x' + String(value).padStart(64, '0');
const at = (seconds: number) => new Date(time - 100_000 + seconds * 1000).toISOString();
function row(id: number, kind: string, quantity: string, amount: string, extra: Record<string, unknown> = {}): any {
  return { wallet, chain: 'bsc', token: { address: token }, tx_hash: hash(id), event_type: kind, timestamp: Date.parse(at(id)) / 1000,
    token_amount: quantity, cost_usd: amount, quote_amount: amount, quote_address: native,
    gas_usd: '1', dex_usd: '0', priority_fee: '0', tip_fee: '0', ...extra };
}
function trade(provider: any, quoteAmount: string): KolTokenTrade {
  return { id: provider.tx_hash, txHash: provider.tx_hash, walletAddress: wallet, tokenAddress: token,
    side: provider.event_type, tokenAmount: provider.token_amount, timestamp: new Date(provider.timestamp * 1000).toISOString(),
    quoteSymbol: 'BNB', quoteTokenAddress: null, quoteAmount, amountUsd: quoteAmount, priceUsd: null, marketCapUsd: null,
    kolName: null, kolAvatarUrl: null, kolTwitter: null, tokenSymbol: null, tokenName: null, tokenLogoUrl: null,
    source: 'node', blockNumber: '100', transactionIndex: Number(provider.tx_hash.slice(-2)), valuationStatus: 'valued',
    realizedProfitUsd: null, cumulativeRealizedProfitUsd: null };
}
function selected(trades: KolTokenTrade[]): KolTokenActivity {
  return { kol: { address: wallet, name: null, avatarUrl: null, twitter: null, source: 'node', lastSeenAt: null },
    token: { address: token, symbol: null, name: null, logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: null }, trades,
    summary: { investedUsd: null, soldUsd: null, realizedProfitUsd: null, avgBoughtPriceUsd: null, avgSoldPriceUsd: null,
      avgBoughtMcapUsd: null, avgSoldMcapUsd: null, remainingTokenAmount: null, remainingCostBasisUsd: null, buyCount: 1, sellCount: 1,
      valuedBuyCount: 1, valuedSellCount: 1, excludedSellCount: 0, unpricedTradeCount: 0,
      firstTradeAt: trades.at(0)!.timestamp, lastTradeAt: trades.at(-1)!.timestamp, status: 'unknown', profitBasis: 'observed_fifo' },
    inventory: { version: 1, events: [], coverage: { status: 'unavailable', reason: 'inventory_history_unavailable', complete: false,
      reconciled: false, fromBlock: '100', toBlock: '200', blockHash: hash(200), checkedAt: null, balance: null } },
    coverage: { source: 'indexed', indexedTradeCount: trades.length, returnedTradeCount: trades.length, complete: true, historyLimit: 2000, costsIncluded: false },
    generatedAt: new Date(time).toISOString() };
}
function proof(balance = '4'): KolTokenBalanceProof {
  return { walletAddress: wallet, tokenAddress: token, chain: 'bsc', blockNumber: '200', blockHash: hash(200), balance,
    blockTimestamp: new Date(time - 3000).toISOString(), checkedAt: new Date(time).toISOString() };
}
function scenario() {
  const buy = row(1, 'buy', '10', '100'), transfer = row(2, 'transferOut', '4', '80'), sell = row(3, 'sell', '2', '60', { buy_cost_usd: '21.2' });
  return { rows: [sell, transfer, buy], activity: selected([trade(buy, '105'), trade(sell, '59')]) };
}
function loader(rows: any[], balance = '4', overrides: Partial<Parameters<typeof createGmgnHistoryPnl>[0]> = {}) {
  const request = vi.fn(async (_url: URL) => ({ data: { activities: rows, next: '' } })), rpc = vi.fn(async () => proof(balance));
  return { request, rpc, load: createGmgnHistoryPnl({ request, rpc, now: () => time, apiKey: () => 'test-key', ...overrides }) };
}
function testCanvas(): HTMLCanvasElement {
  const context = new Proxy<Record<string, unknown>>({}, { get: (target, key) => key in target ? target[String(key)]
    : key === 'measureText' ? (value: string) => ({ width: value.length * 20 })
    : key === 'createLinearGradient' ? () => ({ addColorStop: () => {} }) : () => undefined });
  return { getContext: () => context } as unknown as HTMLCanvasElement;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('GMGN history replay recovery', () => {
  const chart = (): ReplayMarketChart => ({ address: token, period: 'replay', candles: [], source: 'gmgn', resolution: '1m', marketCapSupply: '1000',
    pending: false, stale: false, updatedAt: new Date(time).toISOString(), currentQuote: { timestamp: new Date(time).toISOString(), priceUsd: '20' },
    points: [0, 1, 2, 3, 90].map(seconds => ({ timestamp: at(seconds), priceUsd: String(seconds === 1 ? 10 : 20) })) });

  it('shares profile work and prepares an export with changing per-frame profit including transfers and fees', async () => {
    vi.useFakeTimers(); vi.setSystemTime(time);
    const { rows, activity } = scenario(), { load, request, rpc } = loader(rows);
    const profile = await load(activity); activity.replayAccounting = await load.replay(activity, { foreground: true });
    expect(request).toHaveBeenCalledOnce(); expect(rpc).toHaveBeenCalledOnce(); expect(profile).not.toHaveProperty('replayHistory');
    expect(activity.inventory!.coverage.complete).toBe(false);
    expect(activity.replayAccounting.history!.events[1]).toMatchObject({ kind: 'transfer_out', blockNumber: null, transactionIndex: null, logIndex: null });
    const initial = prepareTradeReplayData(activity, null, null, time)!;
    expect(replayInventoryIsFresh(initial, time)).toBe(true); expect(initial.position.status).toBe('open');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/activity?') ? activity : chart() })));
    const prepared = await replayMarketData(initial, new AbortController().signal);
    expect(prepared.preparationStatus).toBe('ready'); expect(prepared.data.replayAccounting!.coverage.exactFinal).toBe(false);
    const renderer = new ReplayCanvas(testCanvas()); await renderer.setData(prepared.data);
    const early = renderer.snapshot(renderer.eventProgress(0)), ending = renderer.snapshot(1);
    expect(early.totalPnl).toBeCloseTo(10 * early.currentPrice - 106); expect(early.totalPnl).not.toBe(ending.totalPnl);
    expect(ending.totalPnl).toBeCloseTo(111);
    expect(ending.totalRoi).toBeCloseTo(111 / 109); expect(ending.holdings).toBe(4);
    expect(replayAccountingTotal(prepared.data.replayAccounting!.events[1], 20)).toBeCloseTo(93);
  });

  it.each([false, true])('keeps profit numeric when allocation is unknown; closed=%s', async closed => {
    const buy1 = row(1, 'buy', '100', '100', { gas_usd: '0' }), buy2 = row(2, 'buy', '100', '200', { gas_usd: '0' });
    const sell = row(3, 'sell', closed ? '200' : '100', '200', { gas_usd: '0', buy_cost_usd: '150' });
    const activity = selected([trade(buy1, '100'), trade(buy2, '200'), trade(sell, '200')]);
    activity.replayAccounting = await loader([buy1, buy2, sell], closed ? '0' : '100').load.replay(activity);
    const data = applyReplayMarketChart(prepareTradeReplayData(activity, null, null, time)!, chart(), time);
    expect(data.position.status).toBe(closed ? 'closed' : 'open');
    const renderer = new ReplayCanvas(testCanvas()); await renderer.setData(data);
    expect(renderer.snapshot(1).totalPnl).toBeCloseTo(closed ? -100 : 1900);
  });

  it('supports a buy-only position and withholds all replay evidence after a balance mismatch', async () => {
    const buy = row(1, 'buy', '10', '100'), activity = selected([trade(buy, '105')]);
    const load = loader([buy], '10').load;
    activity.replayAccounting = await load.replay(activity);
    const data = applyReplayMarketChart(prepareTradeReplayData(activity, null, null, time)!, chart(), time);
    const renderer = new ReplayCanvas(testCanvas()); await renderer.setData(data);
    expect(renderer.snapshot(1).totalPnl).toBeCloseTo(94);
    activity.replayAccounting = await loader([buy], '9').load.replay(activity);
    expect(activity.replayAccounting).toMatchObject({ status: 'unavailable', events: [], final: null, coverage: { balanceMatched: false } });
    expect(activity.replayAccounting.history).toBeUndefined();
    expect(prepareTradeReplayData(activity, null, null, time)!.position.status).toBe('unknown');
  });

  it('applies incoming holdings before the first sell without inventing transfer block positions', async () => {
    const a = row(1, 'transferIn', '10', '100', { gas_usd: '0' }), b = row(2, 'transferIn', '20', '200', { gas_usd: '0', timestamp: a.timestamp });
    const sell = row(3, 'sell', '15', '300', { gas_usd: '0', buy_cost_usd: '150' });
    const activity = selected([trade(sell, '300')]); activity.replayAccounting = await loader([sell, b, a], '15').load.replay(activity);
    const data = applyReplayMarketChart(prepareTradeReplayData(activity, null, null, time)!, chart(), time);
    expect(data.inventory!.coverage.verification).toBe('gmgn_history');
    const renderer = new ReplayCanvas(testCanvas()); await renderer.setData(data);
    expect(renderer.snapshot(1).totalPnl).toBeCloseTo(300);
  });

  it.each(['wrong-wallet', 'stale-proof', 'stale-history', 'balance', 'missing-event', 'quantity', 'fee', 'duplicate', 'contradiction', 'transfer-block', 'exact-final'])
    ('rejects unsafe provider-history replay evidence: %s', async mutation => {
      const { rows, activity } = scenario(); activity.replayAccounting = await loader(rows).load.replay(activity);
      const raw = activity.replayAccounting, history = raw.history!;
      if (mutation === 'wrong-wallet') history.balanceProof.walletAddress = token;
      if (mutation === 'stale-proof') history.balanceProof.checkedAt = new Date(time - 180_001).toISOString();
      if (mutation === 'stale-history') history.checkedAt = new Date(time - 180_001).toISOString();
      if (mutation === 'balance') history.balanceProof.balance = '5';
      if (mutation === 'missing-event') history.events.splice(1, 1);
      if (mutation === 'quantity') history.events[0].tokenAmount = '11';
      if (mutation === 'fee') history.events[1].feesUsd = '0';
      if (mutation === 'duplicate') history.events.push(history.events[2]);
      if (mutation === 'contradiction') activity.inventory!.coverage.reason = 'balance_mismatch';
      if (mutation === 'transfer-block') history.events[1].blockNumber = '101';
      if (mutation === 'exact-final') raw.coverage.exactFinal = true;
      const data = prepareTradeReplayData(activity, null, null, time)!;
      expect(replayInventoryIsFresh(data, time)).toBe(false); expect(data.replayAccounting!.status).toBe('unavailable');
    });
});
