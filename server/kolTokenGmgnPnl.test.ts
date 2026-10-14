import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import type { TradeReplayAccounting } from '../shared/tradeReplayAccounting.js';
import { createKolTokenGmgnPnl, realizedAccountingFromReplay } from './kolTokenGmgnPnl.js';
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

describe('GMGN historical realized P&L adapter', () => {
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
