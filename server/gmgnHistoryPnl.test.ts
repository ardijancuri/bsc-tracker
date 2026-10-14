import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity, KolTokenBalanceProof, KolTokenTrade } from '../shared/kolTokenTrades.js';
import { createGmgnHistoryPnl } from './gmgnHistoryPnl.js';
import { MarketProviderDeferred } from './geckoApi.js';

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
afterEach(() => vi.useRealTimers());

describe('GMGN history PNL on pruned nodes', () => {
  it('includes transfer-out gains and complete inferred fees without manufacturing canonical inventory', async () => {
    const { rows, activity } = scenario(), before = structuredClone(activity), { load, request, rpc } = loader(rows);
    const result = await load(activity);
    expect(result.status).toBe('ready'); expect(Number(result.realizedProfitUsd)).toBeCloseTo(73.4);
    expect(result.position).toMatchObject({ status: 'open', remainingTokenAmount: '4', remainingCostBasisUsd: '42.4',
      feeInclusiveCostUsd: '109', estimatedProfitUsd: null, cashFlow: { investedUsd: '100', soldUsd: '60', transferOutIncomeUsd: '80', feesUsd: '9' } });
    expect(result.coverage).toMatchObject({ verification: 'gmgn_history', transactionsComplete: true, balanceMatched: true, balanceProof: proof(),
      lastMovementAt: at(3) });
    expect(result.coverage.historyFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(activity).toEqual(before);
    const url = request.mock.calls[0][0] as URL;
    expect(url.searchParams.get('wallet_address')).toBe(wallet); expect(url.searchParams.get('token_address')).toBe(token);
    expect(url.searchParams.getAll('type')).toEqual(['buy', 'sell', 'transferIn', 'transferOut']); expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('dates the quote boundary from the latest transfer even when the last indexed swap is older', async () => {
    const { rows, activity } = scenario();
    const latestTransfer = row(4, 'transferOut', '1', '25');
    const result = await loader([latestTransfer, ...rows], '3').load(activity);
    expect(result.status).toBe('ready');
    expect(result.coverage.lastMovementAt).toBe(at(4));
    expect(result.coverage.lastMovementAt).not.toBe(result.coverage.balanceProof!.blockTimestamp);
  });

  it('recovers Ping Ping’s closed September cycle and separate October purchase using native gas FX', async () => {
    const data = [
      row(1, 'buy', '30456939.752634805', '748.9753054884231', { timestamp: 1790572693, gas_native: '0.0000572274', gas_usd: '0.0439792569', dex_usd: '13.264397111320859' }),
      row(2, 'sell', '30456939.752634805', '857.1525916654064', { timestamp: 1790572702, gas_native: '0.00005417148', gas_usd: '0.0416394498168', dex_usd: '12.808696547524585', buy_cost_usd: '769.968681856644' }),
      row(3, 'buy', '96242219.75387765', '355.3112936683406', { timestamp: 1792002241, gas_native: '0.00005034312', gas_usd: '0.0366845281128', dex_usd: '5.390256331659375' }),
    ].map(value => ({ ...value, quote_address: '0x' + '3'.repeat(40) }));
    const activity = selected(data.map((value, index) => trade(value, ['1', '1.085705900836064455', '0.5'][index])));
    activity.trades[0].tokenAmount = activity.trades[1].tokenAmount = '30456939.752634804480900768';
    activity.trades[2].tokenAmount = '96242219.753877656508080065';
    const { load } = loader([...data].reverse(), '96242219.753877656508080065');
    const result = await load(activity);
    expect(result.status).toBe('ready'); expect(Number(result.realizedProfitUsd)).toBeCloseTo(65.9530790299325, 8);
    expect(Number(result.position!.remainingCostBasisUsd)).toBeCloseTo(364.381684528113, 8);
    expect(Number(result.position!.feeInclusiveCostUsd)).toBeCloseTo(1155.58119716459, 8);
    expect(result.position!.cashFlow!.investedUsd).toBe('1104.28659915676');
    expect(result.position!.estimatedProfitUsd).toBeNull();
  });

  it('keeps the total cash flow but withholds incompatible provider/FIFO allocation until the cycle closes', async () => {
    const buy1 = row(1, 'buy', '100', '100', { gas_usd: '0' }), buy2 = row(2, 'buy', '100', '200', { gas_usd: '0' });
    const sell = row(3, 'sell', '100', '200', { gas_usd: '0', buy_cost_usd: '150' }), transfer = row(4, 'transferOut', '50', '100', { gas_usd: '0' });
    const activity = selected([trade(buy1, '100'), trade(buy2, '200'), trade(sell, '200')]);
    const result = await loader([buy1, buy2, sell, transfer], '50').load(activity);
    expect(result.status).toBe('ready'); expect(result.realizedProfitUsd).toBeNull(); expect(result.position!.remainingCostBasisUsd).toBeNull();
    expect(result.position!.cashFlow).toEqual({ investedUsd: '300', soldUsd: '200', transferOutIncomeUsd: '100', feesUsd: '0' });
    expect(result.position!.feeInclusiveCostUsd).toBe('300');
  });

  it('publishes a closed position with zero remaining value and numeric negative profit', async () => {
    const buy = row(1, 'buy', '10', '100'), sell = row(2, 'sell', '10', '50');
    const result = await loader([buy, sell], '0').load(selected([trade(buy, '105'), trade(sell, '49')]));
    expect(result.realizedProfitUsd).toBe('-58'); expect(result.position).toMatchObject({ status: 'closed', estimatedProfitUsd: '-58', unrealizedProfitUsd: '0' });
  });

  it.each(['canonical_receipt_mismatch', 'inventory_rpc_unavailable', 'scan_pending'])('does not override %s with provider history', async reason => {
    const { rows, activity } = scenario(); activity.inventory!.coverage.reason = reason;
    const { load, request, rpc } = loader(rows);
    expect((await load(activity)).status).toBe('unavailable'); expect(request).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it('does not use bounded/incomplete indexed history or an absent key', async () => {
    const { rows, activity } = scenario(); activity.coverage.complete = false;
    const { load, request } = loader(rows); expect((await load(activity)).status).toBe('unavailable'); expect(request).not.toHaveBeenCalled();
    activity.coverage.complete = true;
    expect((await loader(rows, '4', { apiKey: () => '' }).load(activity)).coverage.reason).toBe('provider_key_unavailable');
  });

  it.each(['wallet', 'token', 'chain', 'quantity', 'time', 'missingSwap', 'extraSwap', 'missingGas', 'missingDex', 'inconsistentDex', 'missingPriority', 'tip', 'duplicate', 'unvalued', 'unknownTransferIn', 'unknownOpening'] as const)
    ('rejects %s instead of inventing zero costs or partial profit', async variant => {
      const { rows, activity } = scenario();
      if (variant === 'wallet') rows[0].wallet = '0x' + '3'.repeat(40);
      if (variant === 'token') rows[0].token.address = '0x' + '3'.repeat(40);
      if (variant === 'chain') rows[0].chain = 'eth';
      if (variant === 'quantity') rows[0].token_amount = '3';
      if (variant === 'time') rows[0].timestamp += 3;
      if (variant === 'missingSwap') rows.pop();
      if (variant === 'extraSwap') rows.push(row(4, 'buy', '2', '10'));
      if (variant === 'missingGas') delete rows[0].gas_usd;
      if (variant === 'missingDex') delete rows[0].dex_usd;
      if (variant === 'inconsistentDex') rows[0].dex_usd = '500';
      if (variant === 'missingPriority') delete rows[0].priority_fee;
      if (variant === 'tip') rows[0].tip_fee = '1';
      if (variant === 'duplicate') rows.push(structuredClone(rows[0]));
      if (variant === 'unvalued') activity.trades[0].valuationStatus = 'shared_quote';
      if (variant === 'unknownTransferIn') rows.push(row(0, 'transferIn', '2', '0', { gas_usd: '0' }));
      if (variant === 'unknownOpening') rows[1].token_amount = '11';
      const result = await loader(rows).load(activity);
      expect(result.status).toBe('unavailable'); expect(result.realizedProfitUsd).toBeNull(); expect(result.position).toBeUndefined();
    });

  it.each(['mismatch', 'stale', 'future', 'wrongPair', 'wrongChain', 'blockGap', 'invalidHash'] as const)('rejects %s balance proof', async variant => {
    const { rows, activity } = scenario(), current = proof();
    if (variant === 'mismatch') current.balance = '5';
    if (variant === 'stale') current.checkedAt = new Date(time - 180_001).toISOString();
    if (variant === 'future') current.checkedAt = new Date(time + 1).toISOString();
    if (variant === 'wrongPair') current.walletAddress = '0x' + '3'.repeat(40);
    if (variant === 'wrongChain') current.chain = 'eth' as 'bsc';
    if (variant === 'blockGap') current.blockTimestamp = new Date(rows[0].timestamp * 1000 - 1).toISOString();
    if (variant === 'invalidHash') current.blockHash = 'missing';
    expect((await loader(rows, '4', { rpc: async () => current }).load(activity)).status).toBe('unavailable');
  });

  it('requires all pages and rejects looping or missing cursors', async () => {
    const { rows, activity } = scenario();
    const request = vi.fn().mockResolvedValueOnce({ activities: [rows[0]], next: 'page2' }).mockResolvedValueOnce({ activities: rows.slice(1), next: '' })
      .mockResolvedValueOnce({ activities: [rows[0]], next: 'page2' });
    expect((await loader([], '4', { request }).load(activity)).status).toBe('ready');
    expect(request.mock.calls[1][0].searchParams.get('cursor')).toBe('page2');
    for (const next of ['page2', undefined]) {
      const invalid = vi.fn().mockResolvedValueOnce({ activities: [rows[0]], next: 'page2' }).mockResolvedValueOnce({ activities: rows.slice(1), next });
      expect((await loader([], '4', { request: invalid }).load(activity)).coverage.reason).toBe('gmgn_history_cursor_invalid');
    }
  });

  it('resumes partial pages after the shared provider cooldown without early retry', async () => {
    const { rows, activity } = scenario(); let clock = time;
    const request = vi.fn().mockResolvedValueOnce({ activities: [rows[0]], next: 'page2' })
      .mockRejectedValueOnce(new MarketProviderDeferred('rate_limited', 12_000)).mockResolvedValueOnce({ activities: rows.slice(1), next: '' })
      .mockResolvedValueOnce({ activities: [rows[0]], next: 'page2' });
    const { load } = loader([], '4', { request, now: () => clock });
    expect(await load(activity)).toMatchObject({ status: 'pending', retryAfterMs: 12_000, coverage: { verification: 'gmgn_history', reason: 'provider_rate_limited' } });
    expect((await load(activity)).retryAfterMs).toBe(12_000); expect(request).toHaveBeenCalledTimes(2);
    clock += 12_000;
    expect((await load(activity)).status).toBe('ready'); expect(request.mock.calls[2][0].searchParams.get('cursor')).toBe('page2');
  });

  it.each([false, true])('refreshes the first page after a long scan and rejects changed head=%s', async changed => {
    const { rows, activity } = scenario(); let clock = time;
    const request = vi.fn().mockImplementationOnce(async () => { clock += 16_000; return { activities: [rows[0]], next: 'page2' }; })
      .mockImplementationOnce(async () => { clock += 16_000; return { activities: rows.slice(1), next: '' }; })
      .mockImplementationOnce(async () => ({ activities: [{ ...rows[0], ...(changed ? { cost_usd: '61' } : {}) }], next: 'page2' }));
    const { load } = loader([], '4', { request, now: () => clock, rpc: async () => ({ ...proof(), checkedAt: new Date(clock).toISOString(), blockTimestamp: new Date(clock - 3000).toISOString() }) });
    const result = await load(activity);
    expect(result.status).toBe(changed ? 'pending' : 'ready'); expect(request.mock.calls[2][0].searchParams.has('cursor')).toBe(false);
    if (changed) { expect(result.coverage.reason).toBe('gmgn_history_snapshot_changed'); expect(result.realizedProfitUsd).toBeNull(); }
    else expect(result.coverage.historyCheckedAt).toBe(new Date(clock).toISOString());
  });

  it('still checks the head after a cooldown interrupted its validation after the final page', async () => {
    const { rows, activity } = scenario(); let clock = time;
    const request = vi.fn().mockResolvedValueOnce({ activities: [rows[0]], next: 'page2' })
      .mockResolvedValueOnce({ activities: rows.slice(1), next: '' }).mockRejectedValueOnce(new MarketProviderDeferred('busy', 1000))
      .mockResolvedValueOnce({ activities: [rows[0]], next: 'page2' });
    const { load, rpc } = loader([], '4', { request, now: () => clock });
    expect((await load(activity)).status).toBe('pending'); expect(rpc).not.toHaveBeenCalled();
    clock += 1000; expect((await load(activity)).status).toBe('ready');
    expect(request).toHaveBeenCalledTimes(4); expect(request.mock.calls[3][0].searchParams.has('cursor')).toBe(false);
  });

  it.each([60_000, 300_001])('bounds unfinished history reuse after a %sms pause and always refreshes its head', async pause => {
    const { rows, activity } = scenario(); let clock = time;
    const request = vi.fn().mockResolvedValueOnce({ activities: [rows[0]], next: 'page2' })
      .mockRejectedValueOnce(new MarketProviderDeferred('rate_limited', 60_000));
    if (pause <= 300_000) request.mockResolvedValueOnce({ activities: rows.slice(1), next: '' }).mockResolvedValueOnce({ activities: [rows[0]], next: 'page2' });
    else request.mockResolvedValueOnce({ activities: rows, next: '' });
    const { load } = loader([], '4', { request, now: () => clock, rpc: async () => ({ ...proof(), checkedAt: new Date(clock).toISOString(), blockTimestamp: new Date(clock - 3000).toISOString() }) });
    expect((await load(activity)).status).toBe('pending'); clock += pause;
    const result = await load(activity); expect(result.status).toBe('ready');
    expect(request.mock.calls[2][0].searchParams.get('cursor')).toBe(pause <= 300_000 ? 'page2' : null);
    expect(result.coverage.historyCheckedAt).toBe(new Date(clock).toISOString());
    if (pause <= 300_000) expect(request.mock.calls[3][0].searchParams.has('cursor')).toBe(false);
  });

  it('coalesces work, limits final caching to 30 seconds and invalidates changed indexed quotes', async () => {
    const { rows, activity } = scenario(); let clock = time;
    const { load, request, rpc } = loader(rows, '4', { now: () => clock, rpc: async () => ({ ...proof(), checkedAt: new Date(clock).toISOString(), blockTimestamp: new Date(clock - 3000).toISOString() }) });
    const results = await Promise.all([load(activity), load(activity)]); expect(request).toHaveBeenCalledTimes(1);
    results[0].realizedProfitUsd = 'broken'; expect((await load(activity)).realizedProfitUsd).not.toBe('broken');
    clock += 30_001; expect((await load(activity)).status).toBe('ready'); expect(request).toHaveBeenCalledTimes(2);
    activity.trades[0].quoteAmount = '106'; expect((await load(activity)).status).toBe('ready'); expect(request).toHaveBeenCalledTimes(3);
    expect(rpc).not.toHaveBeenCalled(); // The explicit RPC override owns these checks.
  });

  it('bounds an unresponsive provider call and leaves no numeric result', async () => {
    const { activity } = scenario();
    const { load } = loader([], '4', { budgetMs: 10, request: () => new Promise(() => {}) });
    const result = await load(activity); expect(result).toMatchObject({ status: 'pending', realizedProfitUsd: null, coverage: { reason: 'provider_timeout' } });
  });
});
