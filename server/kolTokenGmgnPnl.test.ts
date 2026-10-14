import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import type { TokenChart } from '../shared/intelligence.js';
import type { TradeReplayAccounting } from '../shared/tradeReplayAccounting.js';
import { createKolTokenGmgnPnl, loadCurrentPositionQuote, realizedAccountingFromReplay } from './kolTokenGmgnPnl.js';
import { buildTradeReplayGmgnAccounting } from './tradeReplayGmgnAccounting.js';

const time = Date.parse('2026-10-14T06:00:00Z'), wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40), native = '0x' + '0'.repeat(40);
const hash = (id: number) => '0x' + id.toString(16).padStart(64, '0');
const at = new Date(time).toISOString();
function activity(): KolTokenActivity {
  const identities = [ ['buy', '10', '10'], ['transfer_out', '4', '6'], ['sell', '2', '4'] ] as const;
  const events = identities.map(([kind, amount, remaining], index) => ({ id: String(index), kind, txHash: hash(index + 1),
    ...(kind !== 'transfer_out' ? { tradeId: String(index) } : {}), timestamp: new Date(time - 100_000 + index * 1000).toISOString(),
    blockNumber: String(100 + index), transactionIndex: index, logIndex: kind === 'transfer_out' ? 0 : null,
    tokenAmount: amount, remainingTokenAmount: remaining, remainingCostBasisUsd: '0', cumulativeRealizedProfitUsd: null, investedUsd: '100', soldUsd: '60' }));
  return { kol: { address: wallet, name: null, avatarUrl: null, twitter: null, source: 'indexed', lastSeenAt: null },
    token: { address: token, symbol: null, name: null, logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: null },
    trades: events.filter(event => event.tradeId).map(event => ({ id: event.id, txHash: event.txHash, walletAddress: wallet, tokenAddress: token,
      kolName: null, kolAvatarUrl: null, kolTwitter: null, tokenSymbol: null, tokenName: null, tokenLogoUrl: null,
      side: event.kind as 'buy' | 'sell', tokenAmount: event.tokenAmount, quoteSymbol: 'BNB', quoteTokenAddress: null,
      quoteAmount: event.kind === 'buy' ? '105' : '59', amountUsd: event.kind === 'buy' ? '105' : '59', priceUsd: null, marketCapUsd: null,
      timestamp: event.timestamp, source: 'node', blockNumber: event.blockNumber, transactionIndex: event.transactionIndex,
      valuationStatus: 'valued', realizedProfitUsd: null, cumulativeRealizedProfitUsd: null })),
    summary: { investedUsd: '105', soldUsd: '59', realizedProfitUsd: null, avgBoughtPriceUsd: null, avgSoldPriceUsd: null,
      avgBoughtMcapUsd: null, avgSoldMcapUsd: null, remainingTokenAmount: '4', remainingCostBasisUsd: null,
      buyCount: 1, sellCount: 1, valuedBuyCount: 1, valuedSellCount: 0, excludedSellCount: 1, unpricedTradeCount: 0,
      firstTradeAt: events[0].timestamp, lastTradeAt: events[2].timestamp, status: 'open', profitBasis: 'observed_fifo' },
    inventory: { version: 1, events, coverage: { complete: true, reconciled: true, fromBlock: '100', toBlock: '110', blockHash: hash(110),
      checkedAt: at, balance: '4', status: 'verified', initialBalanceSource: 'historical_call', scannedThroughBlock: '110' } },
    coverage: { source: 'indexed', indexedTradeCount: 2, returnedTradeCount: 2, complete: true, historyLimit: 2000, costsIncluded: false }, generatedAt: at };
}
function accounting(selected = activity(), exact = false): TradeReplayAccounting {
  const rows = selected.inventory!.events.map((event, index) => ({ wallet, chain: 'bsc', tx_hash: event.txHash, token: { address: token },
    event_type: event.kind, timestamp: Date.parse(event.timestamp) / 1000, token_amount: event.tokenAmount,
    quote_amount: index === 0 ? '100' : index === 2 ? '60' : null, cost_usd: ['100', '80', '60'][index],
    quote_address: native, gas_usd: '1', dex_usd: '0', priority_fee: '0', tip_fee: '0', ...(index === 2 ? { buy_cost_usd: '21.2' } : {}) }));
  const aggregate = { address: wallet, balance: 4, usd_value: 40, cost_cur: 42.4, history_bought_cost: 100, history_bought_fee: 6,
    history_sold_income: 60, history_sold_fee: 2, history_transfer_in_cost: 0, history_transfer_out_income: 80, history_transfer_out_fee: 1,
    current_buy_amount: 10, current_sell_amount: 2, history_transfer_in_amount: 0, history_transfer_out_amount: 4,
    buy_tx_count_cur: 1, sell_tx_count_cur: 1, transfer_in_count: 0, transfer_out_count: 1, last_block: 102,
    last_active_timestamp: Date.parse(selected.inventory!.events[2].timestamp) / 1000, total_cost: 109, profit: 71, profit_change: 71 / 109,
    realized_profit: 73.4, unrealized_profit: -2.4 };
  return buildTradeReplayGmgnAccounting(selected, rows, { activitiesComplete: true, aggregateRow: exact ? aggregate : undefined, checkedAt: at, now: time });
}
let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'kol-gmgn-pnl-')); });
afterEach(async () => {
  vi.useRealTimers();
  const target = path.resolve(directory), root = path.resolve(os.tmpdir());
  if (path.dirname(target) !== root || !path.basename(target).startsWith('kol-gmgn-pnl-')) throw Error('Unexpected test cache location');
  await rm(target, { recursive: true, force: true });
});

describe('profile position quotes during chart refresh', () => {
  function chart(): TokenChart {
    return { address: token, period: '1m', source: 'gmgn', resolution: '1m', updatedAt: new Date(time - 45_000).toISOString(),
      pending: false, stale: true, points: [], candles: [{ time: time / 1000 - 60, open: 20, high: 20, low: 20, close: 20, volume: 1 }] };
  }
  it('uses a recently observed genuine price while the chart refresh is queued', async () => {
    const selected = chart(), loadChart = vi.fn(async () => ({ chart: selected, pending: true, loadStatus: 'queued' as const, retryAfterMs: 3000 }));
    expect(await loadCurrentPositionQuote(token, { loadChart, now: () => time })).toEqual({ quote: { priceUsd: '20', timestamp: selected.updatedAt } });
    expect(loadChart).toHaveBeenCalledExactlyOnceWith(token, '1m', 'prefetch', { maxAgeMs: 30_000 });
  });
  it('does not advance the observation date when a cached partial candle closes', async () => {
    const selected = chart(), loadChart = async () => ({ chart: selected, pending: true });
    const beforeClose = await loadCurrentPositionQuote(token, { loadChart, now: () => time - 20_000 });
    const afterClose = await loadCurrentPositionQuote(token, { loadChart, now: () => time + 20_000 });
    expect(beforeClose.quote?.timestamp).toBe(selected.updatedAt);
    expect(afterClose).toEqual(beforeClose);
  });
  it('uses the completed candle boundary when it predates chart retrieval', async () => {
    const selected = chart(); selected.updatedAt = at; selected.candles[0].time = time / 1000 - 120;
    const result = await loadCurrentPositionQuote(token, { loadChart: async () => ({ chart: selected, pending: false }), now: () => time });
    expect(result.quote?.timestamp).toBe(new Date(time - 60_000).toISOString());
  });
  it.each(['expired-chart', 'expired-candle', 'future-chart', 'future-candle', 'candle-after-observation', 'wrong-token', 'wrong-source', 'wrong-resolution', 'invalid-price', 'zero-price', 'invalid-date', 'empty'] as const)(
    'rejects %s without replacing its missing quote with refreshed timestamps', async variant => {
      const selected = chart();
      if (variant === 'expired-chart') selected.updatedAt = new Date(time - 180_001).toISOString();
      if (variant === 'expired-candle') selected.candles[0].time = time / 1000 - 300;
      if (variant === 'future-chart') selected.updatedAt = new Date(time + 1).toISOString();
      if (variant === 'future-candle') selected.candles[0].time = time / 1000 + 60;
      if (variant === 'candle-after-observation') selected.candles[0].time = time / 1000 - 30;
      if (variant === 'wrong-token') selected.address = wallet;
      if (variant === 'wrong-source') selected.source = 'recorded';
      if (variant === 'wrong-resolution') selected.resolution = '5m';
      if (variant === 'invalid-price') selected.candles[0].close = NaN;
      if (variant === 'zero-price') selected.candles[0].close = 0;
      if (variant === 'invalid-date') selected.updatedAt = 'invalid';
      if (variant === 'empty') selected.candles = [];
      const result = await loadCurrentPositionQuote(token, { loadChart: async () => ({ chart: selected, pending: true, loadStatus: 'rate_limited', retryAfterMs: 60_000 }), now: () => time });
      expect(result).toEqual({ reason: 'quote_rate_limited', retryAfterMs: 60_000 });
    });
});

describe('GMGN historical realized P&L adapter', () => {
  it('returns open estimated total and return with the exact aggregate mark, including transfers and fees', () => {
    const selected = activity(), result = realizedAccountingFromReplay(selected, accounting(selected, true), time);
    expect(result.position).toMatchObject({ status: 'open', remainingTokenAmount: '4', remainingCostBasisUsd: '42.4', feeInclusiveCostUsd: '109',
      estimatedProfitUsd: '71', priceUsd: '10', pricedAt: at, valuationSource: 'gmgn' });
    expect(Number(result.position!.unrealizedProfitUsd)).toBeCloseTo(-2.4, 12);
    expect(Number(result.position!.estimatedRoi)).toBeCloseTo(71 / 109, 12);
    expect(Number(result.realizedProfitUsd) + Number(result.position!.unrealizedProfitUsd)).toBe(71);
  });
  it('identifies a canonical closed position without requiring a current market quote', () => {
    const selected = activity(), value = accounting(selected, true);
    selected.inventory!.coverage.balance = '0'; selected.inventory!.events.at(-1)!.remainingTokenAmount = '0';
    Object.assign(value.final!, { remainingTokenAmount: '0', remainingCostBasisUsd: '0', cumulativeRealizedProfitUsd: '31', priceUsd: null });
    const result = realizedAccountingFromReplay(selected, value, time);
    expect(result).toMatchObject({ status: 'ready', realizedProfitUsd: '31', position: { status: 'closed', estimatedProfitUsd: '31', unrealizedProfitUsd: '0',
      priceUsd: null, pricedAt: null, valuationSource: null } });
    expect(Number(result.position!.estimatedRoi)).toBeCloseTo(31 / 109, 12);
  });
  it('keeps complete open-position cash flows when the realized/unrealized allocation is unavailable', async () => {
    const selected = activity(), value = accounting(selected);
    value.events.at(-1)!.remainingCostBasisUsd = null;
    value.events.at(-1)!.cumulativeRealizedProfitUsd = null;
    const load = vi.fn(async () => value), run = createKolTokenGmgnPnl({ load, directory, now: () => time,
      loadQuote: async () => ({ quote: { priceUsd: '20', timestamp: at } }) });
    const result = await run(selected);
    expect(result).toMatchObject({ status: 'ready', realizedProfitUsd: null, coverage: { reason: 'gmgn_activity_estimate' }, position: {
      status: 'open', estimatedProfitUsd: '111', unrealizedProfitUsd: null, remainingCostBasisUsd: null,
      feeInclusiveCostUsd: '109', cashFlow: { investedUsd: '100', soldUsd: '60', transferOutIncomeUsd: '80', feesUsd: '9' } } });
    expect(Number(result.position!.estimatedRoi)).toBeCloseTo(111 / 109, 12);
    expect((await run(selected)).position!.estimatedProfitUsd).toBe('111'); expect(load).toHaveBeenCalledOnce();
    const restarted = createKolTokenGmgnPnl({ load, directory, now: () => time, loadQuote: async () => ({ quote: { priceUsd: '30', timestamp: at } }) });
    expect((await restarted(selected)).position!.estimatedProfitUsd).toBe('151'); expect(load).toHaveBeenCalledOnce();
  });
  it.each(['missing-fees', 'missing-cost', 'invalid-basis'] as const)('does not infer an open total with %s even when a quote is available', async variant => {
    const selected = activity(), value = accounting(selected), last = value.events.at(-1)!;
    last.remainingCostBasisUsd = null; last.cumulativeRealizedProfitUsd = null;
    if (variant === 'missing-fees') last.feesUsd = null;
    if (variant === 'missing-cost') last.feeInclusiveCostUsd = null;
    if (variant === 'invalid-basis') last.remainingCostBasisUsd = '-1';
    const loadQuote = vi.fn(async () => ({ quote: { priceUsd: '20', timestamp: at } }));
    const result = await createKolTokenGmgnPnl({ load: async () => value, loadQuote, directory: null, now: () => time })(selected);
    expect(result).toMatchObject({ status: 'unavailable', realizedProfitUsd: null }); expect(result.position).toBeUndefined();
    expect(loadQuote).not.toHaveBeenCalled();
  });
  it('uses complete fee-accounted history including marked transfers without FIFO substitution or a current quote', () => {
    const selected = activity(), result = realizedAccountingFromReplay(selected, accounting(selected), time);
    expect(result).toMatchObject({ version: 1, source: 'gmgn', policy: 'gmgn_realized_profit_v1', status: 'ready', realizedProfitUsd: '73.4',
      coverage: { transactionsComplete: true, balanceMatched: true, reason: 'gmgn_activity_estimate' } });
    expect(selected.summary.realizedProfitUsd).toBeNull();
  });
  it('accepts a validated final when currency-mismatched historical fees cannot be estimated', () => {
    const selected = activity(), valid = accounting(selected, true);
    valid.events.forEach(event => { event.feesUsd = null; event.feeInclusiveCostUsd = null; event.cumulativeRealizedProfitUsd = null; });
    const result = realizedAccountingFromReplay(selected, valid, time);
    expect(result).toMatchObject({ status: 'ready', realizedProfitUsd: '73.4' });
    expect(result.coverage.reason).toBeUndefined();
  });
  it.each(['fees', 'partial', 'wrong-pair', 'wrong-block', 'unaligned', 'identity', 'hex', 'stale', 'future'] as const)(
    'withholds unknown or invalid %s totals rather than returning zero, proceeds or partial profit', variant => {
      const selected = activity(), value = accounting(selected);
      if (variant === 'fees') value.events.at(-1)!.feesUsd = null;
      if (variant === 'partial') value.coverage.transactionsComplete = false;
      if (variant === 'wrong-pair') value.walletAddress = token;
      if (variant === 'wrong-block') value.inventoryBlockHash = hash(999);
      if (variant === 'unaligned') value.events.pop();
      if (variant === 'identity') value.events.at(-1)!.cumulativeRealizedProfitUsd = '0';
      if (variant === 'hex') value.events.at(-1)!.feesUsd = '0x9';
      if (variant === 'stale') value.checkedAt = new Date(time - 180001).toISOString();
      if (variant === 'future') value.checkedAt = new Date(time + 1).toISOString();
      expect(realizedAccountingFromReplay(selected, value, time)).toMatchObject({ status: 'unavailable', realizedProfitUsd: null });
    });
  it('keeps a genuine verified zero distinct from missing money fields', () => {
    const selected = activity(), value = accounting(selected);
    Object.assign(value.events.at(-1)!, { soldUsd: '0', transferOutIncomeUsd: '66.6', cumulativeRealizedProfitUsd: '0' });
    expect(realizedAccountingFromReplay(selected, value, time).realizedProfitUsd).toBe('0');
    value.events.at(-1)!.cumulativeRealizedProfitUsd = null;
    expect(realizedAccountingFromReplay(selected, value, time).realizedProfitUsd).toBeNull();
  });
});

describe('bounded durable historical realized cache', () => {
  it('never replaces a reported total or its expiry with a subsequently supplied history estimate', async () => {
    let clock = time; const run = createKolTokenGmgnPnl({ directory, now: () => clock });
    const exact = accounting(activity(), true); exact.final!.remainingCostBasisUsd = '43.4'; exact.final!.cumulativeRealizedProfitUsd = '74.4';
    await run(activity(), exact);
    const file = path.join(directory, (await readdir(directory))[0]), stored = JSON.parse(await readFile(file, 'utf8'));
    clock += 1000;
    expect(await run(activity(), accounting())).toMatchObject({ realizedProfitUsd: '74.4' });
    expect((await run(activity())).coverage.reason).toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(stored);
  });
  it('expires a derived total after fifteen seconds so a provider lookup can upgrade it to reported accounting', async () => {
    let clock = time; const exact = accounting(activity(), true); exact.final!.remainingCostBasisUsd = '43.4'; exact.final!.cumulativeRealizedProfitUsd = '74.4';
    const load = vi.fn().mockResolvedValueOnce(accounting()).mockResolvedValue(exact);
    const run = createKolTokenGmgnPnl({ load, directory, now: () => clock });
    const first = await run(activity()); expect(first.realizedProfitUsd).toBe('73.4'); expect(first.retryAfterMs).toBeUndefined();
    clock += 14_999; expect((await run(activity())).realizedProfitUsd).toBe('73.4'); expect(load).toHaveBeenCalledOnce();
    clock += 1; expect((await run(activity())).realizedProfitUsd).toBe('74.4'); expect(load).toHaveBeenCalledTimes(2);
    expect((await run(activity())).coverage.reason).toBeUndefined();
  });
  it('decrements a derived aggregate cooldown instead of resetting it on every cached read', async () => {
    let clock = time; const deferred = accounting(); deferred.coverage.reason = 'aggregate_provider_busy'; deferred.retryAfterMs = 2500;
    const load = vi.fn().mockResolvedValueOnce(deferred).mockResolvedValue(accounting(activity(), true));
    const run = createKolTokenGmgnPnl({ load, directory: null, now: () => clock });
    expect(await run(activity())).toMatchObject({ status: 'ready', retryAfterMs: 2500, coverage: { reason: 'gmgn_activity_estimate' } });
    clock += 1000; expect((await run(activity())).retryAfterMs).toBe(1500); expect(load).toHaveBeenCalledOnce();
    clock += 1500; const ready = await run(activity()); expect(ready.coverage.reason).toBeUndefined(); expect(ready.retryAfterMs).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('lets a completed reported lookup upgrade an estimate supplied while that lookup was still running', async () => {
    let finish!: (value: TradeReplayAccounting) => void;
    const run = createKolTokenGmgnPnl({ load: async () => new Promise(resolve => { finish = resolve; }), directory, now: () => time });
    const loading = run(activity()); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect((await run(activity(), accounting())).coverage.reason).toBe('gmgn_activity_estimate');
    const exact = accounting(activity(), true); exact.final!.remainingCostBasisUsd = '43.4'; exact.final!.cumulativeRealizedProfitUsd = '74.4';
    finish(exact);
    expect(await loading).toMatchObject({ status: 'ready', realizedProfitUsd: '74.4' });
    expect((await run(activity())).coverage.reason).toBeUndefined();
    const restarted = createKolTokenGmgnPnl({ load: async () => { throw Error('Unexpected provider lookup'); }, directory, now: () => time });
    expect((await restarted(activity())).realizedProfitUsd).toBe('74.4');
  });
  it('marks cached verified basis with fresh prices without requesting the historical ledger again', async () => {
    let clock = time, price = '20'; const load = vi.fn(async (selected: KolTokenActivity) => {
      const value = accounting(selected, true); value.final!.priceUsd = null; return value;
    });
    const loadQuote = vi.fn(async () => ({ quote: { priceUsd: price, timestamp: new Date(clock).toISOString() } }));
    const run = createKolTokenGmgnPnl({ load, loadQuote, directory, now: () => clock });
    expect(await run(activity())).toMatchObject({ realizedProfitUsd: '73.4', position: { estimatedProfitUsd: '111', valuationSource: 'market' } });
    clock += 60_000; price = '30';
    const current = activity(); current.inventory!.coverage.checkedAt = new Date(clock).toISOString(); current.token.priceUsd = '999';
    expect(await run(current)).toMatchObject({ realizedProfitUsd: '73.4', position: { estimatedProfitUsd: '151', priceUsd: '30', pricedAt: new Date(clock).toISOString() } });
    expect(load).toHaveBeenCalledOnce(); expect(loadQuote).toHaveBeenCalledTimes(2);
    const restarted = createKolTokenGmgnPnl({ load, loadQuote, directory, now: () => clock });
    price = '5'; expect(Number((await restarted(current)).position!.estimatedProfitUsd)).toBeCloseTo(51, 12);
    expect(load).toHaveBeenCalledOnce();
  });
  it('uses a fresh aggregate quote without another market request, then expires it without renewing its date', async () => {
    let clock = time; const load = vi.fn(async (selected: KolTokenActivity) => accounting(selected, true));
    const loadQuote = vi.fn(async () => ({ reason: 'quote_rate_limited', retryAfterMs: 60_000 }));
    const run = createKolTokenGmgnPnl({ load, loadQuote, directory: null, now: () => clock });
    expect((await run(activity())).position!.estimatedProfitUsd).toBe('71'); expect(loadQuote).not.toHaveBeenCalled();
    clock += 180_001; const current = activity(); current.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    expect(await run(current)).toMatchObject({ status: 'ready', realizedProfitUsd: '73.4', position: { status: 'open', estimatedProfitUsd: null,
      priceUsd: null, pricedAt: null, reason: 'quote_rate_limited', retryAfterMs: 60_000 } });
    expect(load).toHaveBeenCalledOnce(); expect(loadQuote).toHaveBeenCalledOnce();
  });
  it('refreshes an aggregate mark after thirty seconds and only retains a dated recent mark during quote cooldown', async () => {
    let clock = time; const load = vi.fn(async (selected: KolTokenActivity) => accounting(selected, true));
    const loadQuote = vi.fn(async () => ({ reason: 'quote_rate_limited', retryAfterMs: 60_000 } as { reason?: string; retryAfterMs?: number; quote?: { priceUsd: string; timestamp: string } }));
    const run = createKolTokenGmgnPnl({ load, loadQuote, directory: null, now: () => clock });
    await run(activity()); clock += 60_000;
    const current = activity(); current.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    expect(await run(current)).toMatchObject({ position: { estimatedProfitUsd: '71', priceUsd: '10', pricedAt: at, reason: 'quote_rate_limited' } });
    expect(loadQuote).toHaveBeenCalledOnce();
    loadQuote.mockResolvedValue({ quote: { priceUsd: '20', timestamp: new Date(clock).toISOString() } });
    expect(await run(current)).toMatchObject({ position: { estimatedProfitUsd: '111', priceUsd: '20', pricedAt: new Date(clock).toISOString(), valuationSource: 'market' } });
    expect(load).toHaveBeenCalledOnce();
  });
  it('warms a replay ledger without loading a redundant market quote when position marking is not requested', async () => {
    const loadQuote = vi.fn(async () => ({ quote: { priceUsd: '20', timestamp: at } }));
    const run = createKolTokenGmgnPnl({ loadQuote, directory: null, now: () => time });
    expect(await run(activity(), accounting(), { markPosition: false })).toMatchObject({ status: 'ready', realizedProfitUsd: '73.4', position: { estimatedProfitUsd: null } });
    expect(loadQuote).not.toHaveBeenCalled();
    expect((await run(activity())).position!.estimatedProfitUsd).toBe('111'); expect(loadQuote).toHaveBeenCalledOnce();
  });
  it.each(['old', 'future', 'before-last-movement', 'invalid', 'zero'] as const)('does not mark a verified position with a %s quote', async variant => {
    const selected = activity(); const quote = { priceUsd: '20', timestamp: at };
    if (variant === 'old') quote.timestamp = new Date(time - 180_001).toISOString();
    if (variant === 'future') quote.timestamp = new Date(time + 1).toISOString();
    if (variant === 'before-last-movement') quote.timestamp = new Date(time - 99_000).toISOString();
    if (variant === 'invalid') quote.priceUsd = '0x100';
    if (variant === 'zero') quote.priceUsd = '0';
    const run = createKolTokenGmgnPnl({ load: async () => accounting(selected), loadQuote: async () => ({ quote }), directory: null, now: () => time });
    expect(await run(selected)).toMatchObject({ status: 'ready', realizedProfitUsd: '73.4', position: { estimatedProfitUsd: null, priceUsd: null } });
  });
  it('does not ask for a quote for unproven accounting or a closed position', async () => {
    const selected = activity(), value = accounting(selected, true), loadQuote = vi.fn(async () => ({ quote: { priceUsd: '20', timestamp: at } }));
    value.status = 'pending'; const run = createKolTokenGmgnPnl({ load: async () => value, loadQuote, directory: null, now: () => time });
    expect((await run(selected)).status).toBe('pending'); expect(loadQuote).not.toHaveBeenCalled();
    selected.inventory!.coverage.balance = '0'; selected.inventory!.events.at(-1)!.remainingTokenAmount = '0';
    value.status = 'ready'; Object.assign(value.final!, { remainingTokenAmount: '0', remainingCostBasisUsd: '0', cumulativeRealizedProfitUsd: '31', priceUsd: null });
    expect((await run(selected)).position!.estimatedProfitUsd).toBe('31'); expect(loadQuote).not.toHaveBeenCalled();
  });
  it('coalesces a quote for concurrent positions in the same token and bounds a stalled mark', async () => {
    let finish!: (value: { quote: { priceUsd: string; timestamp: string } }) => void;
    const loadQuote = vi.fn(() => new Promise<{ quote: { priceUsd: string; timestamp: string } }>(resolve => { finish = resolve; }));
    const load = async (selected: KolTokenActivity) => { const value = accounting(); value.walletAddress = selected.kol.address; return value; };
    const run = createKolTokenGmgnPnl({ load, loadQuote, directory: null, now: () => time });
    const second = activity(); second.kol.address = '0x' + '3'.repeat(40);
    const first = run(activity()), other = run(second);
    await vi.waitFor(() => expect(loadQuote).toHaveBeenCalledOnce()); finish({ quote: { priceUsd: '20', timestamp: at } });
    expect((await first).position!.estimatedProfitUsd).toBe('111'); expect((await other).position!.estimatedProfitUsd).toBe('111');
    vi.useFakeTimers(); const stalled = createKolTokenGmgnPnl({ load, loadQuote: async () => new Promise(() => {}), directory: null, now: () => time });
    const pending = stalled(activity()); await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toMatchObject({ status: 'ready', realizedProfitUsd: '73.4', position: { estimatedProfitUsd: null, retryAfterMs: 3000 } });
  });
  it('reuses unchanged verified historical profit across process restart and endpoint/quote refresh', async () => {
    let clock = time; const load = vi.fn(async (selected: KolTokenActivity) => accounting(selected, true));
    const first = createKolTokenGmgnPnl({ load, directory, now: () => clock });
    expect((await first(activity())).realizedProfitUsd).toBe('73.4');
    clock += 60_000; const changed = activity(); changed.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    changed.inventory!.coverage.toBlock = '120'; changed.inventory!.coverage.scannedThroughBlock = '120'; changed.inventory!.coverage.blockHash = hash(120);
    changed.token.priceUsd = '500';
    const afterRestart = createKolTokenGmgnPnl({ load, directory, now: () => clock });
    expect(await afterRestart(changed)).toMatchObject({ status: 'ready', realizedProfitUsd: '73.4', checkedAt: new Date(clock).toISOString() });
    expect(load).toHaveBeenCalledOnce();
  });
  it.each(['movement', 'amountUsd', 'quote', 'balance'] as const)('invalidates the cache when %s evidence changes', async variant => {
    const load = vi.fn(async (selected: KolTokenActivity) => accounting(selected));
    const run = createKolTokenGmgnPnl({ load, directory, now: () => time }); await run(activity());
    const changed = activity();
    if (variant === 'movement') changed.inventory!.events[1].txHash = hash(777);
    if (variant === 'amountUsd') changed.trades[0].amountUsd = '110';
    if (variant === 'quote') changed.trades[0].quoteTokenAddress = token;
    if (variant === 'balance') { changed.inventory!.coverage.balance = '5'; changed.inventory!.events.at(-1)!.remainingTokenAmount = '5'; }
    await run(changed); expect(load).toHaveBeenCalledTimes(2);
  });
  it.each(['pending', 'unreconciled', 'stale', 'future'] as const)('does not reuse historical profit with %s inventory', async variant => {
    const load = vi.fn(async (selected: KolTokenActivity) => accounting(selected));
    const run = createKolTokenGmgnPnl({ load, directory, now: () => time }); await run(activity());
    const changed = activity();
    if (variant === 'pending') { changed.inventory!.coverage.complete = false; changed.inventory!.coverage.status = 'pending'; }
    if (variant === 'unreconciled') changed.inventory!.coverage.reconciled = false;
    if (variant === 'stale') changed.inventory!.coverage.checkedAt = new Date(time - 180001).toISOString();
    if (variant === 'future') changed.inventory!.coverage.checkedAt = new Date(time + 1).toISOString();
    expect((await run(changed)).realizedProfitUsd).toBeNull(); expect(load).toHaveBeenCalledOnce();
  });
  it('coalesces an unchanged pair but isolates new canonical inputs while a previous request runs', async () => {
    let finish!: (value: TradeReplayAccounting) => void;
    const load = vi.fn((selected: KolTokenActivity) => load.mock.calls.length === 1 ? new Promise<TradeReplayAccounting>(resolve => { finish = resolve; }) : Promise.resolve(accounting(selected)));
    const run = createKolTokenGmgnPnl({ load, directory: null, now: () => time });
    const old = activity(), first = run(old), joined = run(activity());
    const changed = activity(); changed.trades[0].quoteAmount = '106'; const newer = run(changed);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    finish(accounting(old));
    expect((await first).realizedProfitUsd).toBe('73.4'); expect(await joined).toEqual(await first);
    // The extra $1 buy fee raises transferred-out FIFO basis by $0.4 while
    // GMGN's explicitly reported sale basis remains fixed at $21.2.
    expect((await newer).realizedProfitUsd).toBe('73'); expect(load).toHaveBeenCalledTimes(2);
    expect((await run(changed)).realizedProfitUsd).toBe('73');
  });
  it('honors pending cooldowns, retries after expiry, and bounds unknown provider work', async () => {
    let clock = time; const load = vi.fn(async (selected: KolTokenActivity) => {
      const value = accounting(selected); value.status = 'pending'; value.retryAfterMs = 60_000; value.coverage.reason = 'provider_rate_limited'; return value;
    });
    const run = createKolTokenGmgnPnl({ load, directory: null, now: () => clock });
    expect(await run(activity())).toMatchObject({ status: 'pending', retryAfterMs: 60_000, realizedProfitUsd: null });
    clock += 10_000; expect((await run(activity())).retryAfterMs).toBe(50_000); expect(load).toHaveBeenCalledOnce();
    clock += 50_000; await run(activity()); expect(load).toHaveBeenCalledTimes(2);
    vi.useFakeTimers(); const hung = createKolTokenGmgnPnl({ load: async () => new Promise(() => {}), directory: null, now: () => clock, budgetMs: 100 });
    const waiting = hung(activity()); await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toMatchObject({ status: 'pending', coverage: { reason: 'provider_timeout' }, realizedProfitUsd: null });
  });
  it('warms verified historical profit from a supplied replay snapshot during a provider cooldown without extra work', async () => {
    const load = vi.fn(async (selected: KolTokenActivity) => { const value = accounting(selected); value.status = 'pending';
      value.retryAfterMs = 60_000; value.coverage.reason = 'provider_rate_limited'; return value; });
    const run = createKolTokenGmgnPnl({ load, directory, now: () => time });
    expect((await run(activity())).status).toBe('pending');
    expect((await run(activity(), accounting(activity(), true))).realizedProfitUsd).toBe('73.4');
    expect((await run(activity())).realizedProfitUsd).toBe('73.4'); expect(load).toHaveBeenCalledOnce();
  });
  it('keeps a supplied verified replay result when an older concurrent provider job later fails', async () => {
    let finish!: (value: TradeReplayAccounting) => void;
    const load = vi.fn(async () => new Promise<TradeReplayAccounting>(resolve => { finish = resolve; }));
    const run = createKolTokenGmgnPnl({ load, directory, now: () => time }), earlier = run(activity());
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect((await run(activity(), accounting(activity(), true))).status).toBe('ready');
    const pending = accounting(); pending.status = 'pending'; pending.coverage.reason = 'provider_rate_limited'; finish(pending);
    expect((await earlier).status).toBe('ready'); expect((await run(activity())).realizedProfitUsd).toBe('73.4');
  });
  it('keeps newer reported profit and expiry when an older ready history estimate completes later', async () => {
    let clock = time, finish!: (value: TradeReplayAccounting) => void;
    const load = vi.fn(async () => new Promise<TradeReplayAccounting>(resolve => { finish = resolve; }));
    const run = createKolTokenGmgnPnl({ load, directory, now: () => clock }), earlier = run(activity());
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    clock += 1000;
    const reported = accounting(activity(), true); reported.checkedAt = new Date(clock).toISOString();
    // Both snapshots reconcile their own monetary identities, but only the
    // newer one carries GMGN's separately reported aggregate held basis.
    reported.final!.remainingCostBasisUsd = '43.4'; reported.final!.cumulativeRealizedProfitUsd = '74.4';
    expect((await run(activity(), reported)).realizedProfitUsd).toBe('74.4');
    const file = path.join(directory, (await readdir(directory))[0]), before = JSON.parse(await readFile(file, 'utf8'));
    clock += 1000; finish(accounting());
    expect(await earlier).toMatchObject({ status: 'ready', realizedProfitUsd: '74.4' });
    const latest = await run(activity()); expect(latest.realizedProfitUsd).toBe('74.4'); expect(latest.coverage.reason).toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(before);
    expect(load).toHaveBeenCalledOnce();
  });
  it('prefers newly warmed memory over an older disk snapshot captured before an awaited read completes', async () => {
    await createKolTokenGmgnPnl({ directory, now: () => time })(activity(), accounting(activity(), true));
    let clock = time, release!: () => void, entered!: () => void, first = true;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const load = vi.fn(async () => accounting());
    const run = createKolTokenGmgnPnl({ directory, load, now: () => clock, readCacheFile: async file => {
      const captured = await readFile(file, 'utf8');
      if (first) { first = false; entered(); await gate; }
      return captured;
    } });
    const older = run(activity()); await started; clock += 1000;
    const reported = accounting(activity(), true); reported.checkedAt = new Date(clock).toISOString();
    reported.final!.remainingCostBasisUsd = '43.4'; reported.final!.cumulativeRealizedProfitUsd = '74.4';
    expect((await run(activity(), reported)).realizedProfitUsd).toBe('74.4');
    release(); expect((await older).realizedProfitUsd).toBe('74.4');
    expect((await run(activity())).realizedProfitUsd).toBe('74.4'); expect(load).not.toHaveBeenCalled();
    const restarted = createKolTokenGmgnPnl({ directory, load, now: () => clock });
    expect((await restarted(activity())).realizedProfitUsd).toBe('74.4'); expect(load).not.toHaveBeenCalled();
  });
  it('serializes old disk publication before a newer reported result and returns the newest value after saving', async () => {
    let clock = time, release!: () => void, entered!: () => void, first = true;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const load = vi.fn(async () => accounting());
    const run = createKolTokenGmgnPnl({ directory, load, now: () => clock, publishCacheFile: async (from, to) => {
      if (first) { first = false; entered(); await gate; }
      await rename(from, to);
    } });
    const older = run(activity()); await started; clock += 1000;
    const reported = accounting(activity(), true); reported.checkedAt = new Date(clock).toISOString();
    reported.final!.remainingCostBasisUsd = '43.4'; reported.final!.cumulativeRealizedProfitUsd = '74.4';
    const newer = run(activity(), reported);
    // New publication waits behind the older rename, while the in-memory result
    // already belongs to the newer snapshot. Release before awaiting either save.
    expect((await run(activity())).realizedProfitUsd).toBe('74.4');
    clock += 1000; release();
    expect((await older).realizedProfitUsd).toBe('74.4'); expect((await newer).realizedProfitUsd).toBe('74.4');
    const file = path.join(directory, (await readdir(directory))[0]), stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored.value).toMatchObject({ observedAt: time + 1000, expiresAt: time + 601_000,
      value: { realizedProfitUsd: '74.4', coverage: { transactionsComplete: true, balanceMatched: true } } });
    expect(stored.value.value.coverage.reason).toBeUndefined();
    const restarted = createKolTokenGmgnPnl({ directory, load, now: () => clock });
    expect((await restarted(activity())).realizedProfitUsd).toBe('74.4'); expect(load).toHaveBeenCalledOnce();
  });
  it('expires terminal cooldowns without persisting unproven totals', async () => {
    let clock = time; const load = vi.fn(async (selected: KolTokenActivity) => { const value = accounting(selected); value.events.at(-1)!.feesUsd = null; return value; });
    const run = createKolTokenGmgnPnl({ load, directory, now: () => clock });
    expect((await run(activity())).status).toBe('unavailable'); await run(activity()); expect(load).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
    clock += 60_000; await run(activity()); expect(load).toHaveBeenCalledTimes(2);
  });
  it('expires a ready result after ten minutes even when fresh canonical history is unchanged', async () => {
    let clock = time;
    const load = vi.fn(async () => { const value = accounting(); value.checkedAt = new Date(clock).toISOString(); return value; });
    const run = createKolTokenGmgnPnl({ load, directory, now: () => clock });
    expect((await run(activity())).status).toBe('ready');
    clock += 600_000; const fresh = activity(); fresh.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    expect((await run(fresh)).status).toBe('ready'); expect(load).toHaveBeenCalledTimes(2);
  });
  it('bounds persisted and in-memory historical results to the configured count', async () => {
    const load = vi.fn(async (selected: KolTokenActivity) => { const value = accounting(); value.walletAddress = selected.kol.address; return value; });
    const run = createKolTokenGmgnPnl({ load, directory, now: () => time, maxEntries: 2 });
    for (const digit of ['1', '3', '4']) { const selected = activity(); selected.kol.address = '0x' + digit.repeat(40); await run(selected); }
    expect(await readdir(directory)).toHaveLength(2);
    await run(activity()); expect(load).toHaveBeenCalledTimes(4);
  });
  it.each(['checksum', 'pair', 'money', 'shape'] as const)('discards %s disk data even before a new provider lookup', async variant => {
    const load = vi.fn(async (selected: KolTokenActivity) => accounting(selected));
    await createKolTokenGmgnPnl({ load, directory, now: () => time })(activity());
    const file = path.join(directory, (await readdir(directory))[0]), stored = JSON.parse(await readFile(file, 'utf8'));
    if (variant === 'checksum') stored.value.value.realizedProfitUsd = '999';
    if (variant === 'pair') stored.value.value.tokenAddress = wallet;
    if (variant === 'money') stored.value.value.realizedProfitUsd = 'not-a-number';
    if (variant === 'shape') delete stored.value.value.coverage;
    if (variant !== 'checksum') stored.checksum = createHash('sha256').update(JSON.stringify(stored.value)).digest('hex');
    await writeFile(file, JSON.stringify(stored));
    expect((await createKolTokenGmgnPnl({ load, directory, now: () => time })(activity())).realizedProfitUsd).toBe('73.4');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
