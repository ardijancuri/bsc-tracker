import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import { MarketProviderDeferred } from './geckoApi.js';
import { GmgnHttpError, type GmgnRequestOptions } from './gmgnApi.js';
import { createTradeReplayGmgnLoader } from './tradeReplayGmgn.js';
import { buildTradeReplayGmgnAccounting } from './tradeReplayGmgnAccounting.js';

const wallet = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40), token = '0x' + '3'.repeat(40);
const tx = '0x' + '4'.repeat(64), blockHash = '0x' + '5'.repeat(64), native = '0x' + '0'.repeat(40);
const time = Date.parse('2026-10-14T05:00:00Z'), timestamp = time / 1000 - 30;
function activity(address = wallet): KolTokenActivity {
  return {
    kol: { address, name: null, avatarUrl: null, twitter: null, source: 'indexed', lastSeenAt: null },
    token: { address: token, symbol: null, name: null, logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: null },
    trades: [{ id: 'trade', txHash: tx, walletAddress: address, tokenAddress: token, kolName: null, kolAvatarUrl: null, kolTwitter: null,
      tokenSymbol: null, tokenName: null, tokenLogoUrl: null, side: 'buy', tokenAmount: '10', quoteSymbol: 'BNB', quoteTokenAddress: null,
      quoteAmount: '0.1', amountUsd: '100', priceUsd: '10', marketCapUsd: null, timestamp: new Date(timestamp * 1000).toISOString(), source: 'node',
      blockNumber: '100', transactionIndex: 0, valuationStatus: 'valued', realizedProfitUsd: null, cumulativeRealizedProfitUsd: '0' }],
    summary: { investedUsd: '100', soldUsd: '0', realizedProfitUsd: '0', avgBoughtPriceUsd: '10', avgSoldPriceUsd: null,
      avgBoughtMcapUsd: null, avgSoldMcapUsd: null, remainingTokenAmount: '10', remainingCostBasisUsd: '100',
      buyCount: 1, sellCount: 0, valuedBuyCount: 1, valuedSellCount: 0, excludedSellCount: 0, unpricedTradeCount: 0,
      firstTradeAt: new Date(timestamp * 1000).toISOString(), lastTradeAt: new Date(timestamp * 1000).toISOString(), status: 'open', profitBasis: 'observed_fifo' },
    inventory: { version: 1, events: [{ id: 'event', tradeId: 'trade', txHash: tx, kind: 'buy', timestamp: new Date(timestamp * 1000).toISOString(),
      blockNumber: '100', transactionIndex: 0, logIndex: null, tokenAmount: '10', remainingTokenAmount: '10', remainingCostBasisUsd: '100',
      cumulativeRealizedProfitUsd: '0', investedUsd: '100', soldUsd: '0' }], coverage: { complete: true, reconciled: true,
      fromBlock: '100', toBlock: '110', blockHash, checkedAt: new Date(time).toISOString(), balance: '10', status: 'verified' } },
    coverage: { source: 'indexed', indexedTradeCount: 1, returnedTradeCount: 1, complete: true, historyLimit: 2000, costsIncluded: false },
    generatedAt: new Date(time).toISOString(),
  };
}
const providerRow = (address = wallet) => ({ wallet: address, chain: 'bsc', tx_hash: tx, timestamp, event_type: 'buy', token: { address: token },
  token_amount: '10', quote_amount: '0.1', cost_usd: '100', buy_cost_usd: null, gas_usd: '1', dex_usd: '0', priority_fee: '0', tip_fee: '0',
  quote_token: { token_address: native, symbol: 'BNB' }, quote_address: native, price_usd: '10' });
const aggregate = (address = wallet) => ({ address, balance: 10, usd_value: 200, cost_cur: 101, history_bought_cost: 100, history_bought_fee: 1,
  history_sold_income: 0, history_sold_fee: 0, history_transfer_in_cost: 0, history_transfer_out_income: 0, history_transfer_out_fee: 0,
  history_transfer_in_amount: 0, history_transfer_out_amount: 0, current_buy_amount: 10, current_sell_amount: 0,
  buy_tx_count_cur: 1, sell_tx_count_cur: 0, transfer_in_count: 0, transfer_out_count: 0, last_block: 100, last_active_timestamp: timestamp,
  total_cost: 101, profit: 99, profit_change: 99 / 101, realized_profit: 0, unrealized_profit: 99 });

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'kollens-replay-gmgn-')); });
afterEach(async () => {
  vi.useRealTimers();
  const target = path.resolve(directory), root = path.resolve(os.tmpdir());
  if (path.dirname(target) !== root || !path.basename(target).startsWith('kollens-replay-gmgn-')) throw Error('Unexpected test cache location');
  await rm(target, { recursive: true, force: true });
});
function setup(handler?: (url: URL, options: GmgnRequestOptions) => Promise<any>, extra: Parameters<typeof createTradeReplayGmgnLoader>[0] = {}) {
  const request = vi.fn(handler ?? (async (url: URL) => ({ code: 0, data: url.pathname.endsWith('wallet_activity')
    ? { activities: [providerRow(url.searchParams.get('wallet_address')!)], next: null } : { list: [aggregate(wallet), aggregate(other)] } })));
  const load = createTradeReplayGmgnLoader({ directory, now: () => time, apiKey: () => 'private-test-key', request, ...extra });
  return { load, request };
}
const routes = (request: ReturnType<typeof setup>['request']) => request.mock.calls.map(([url]) => url.pathname);
const priorityOf = (options: GmgnRequestOptions) => typeof options.priority === 'function' ? options.priority() : options.priority;

describe('existing-key GMGN replay provider', () => {
  it('continues ranking search through misses after long cooldowns and refreshes the last successful ranking first after restart', async () => {
    let clock = time, stage = 0;
    const handler = async (url: URL) => {
      if (url.pathname.endsWith('wallet_activity')) return { data: { activities: [providerRow()], next: null } };
      const sort = url.searchParams.get('order_by');
      if (stage === 0 && sort === 'profit' || stage === 1 && sort === 'buy_volume_cur') throw new MarketProviderDeferred('rate_limited', 20_000);
      return { data: { list: sort === 'buy_volume_cur' ? [{ ...aggregate(), ...(stage === 3 ? { usd_value: 300, profit: 199, unrealized_profit: 199, profit_change: 199 / 101 } : {}) }] : [] } };
    };
    const { load, request } = setup(handler, { now: () => clock });
    await load(activity());
    clock += 20_000; stage = 1; const second = activity(); second.inventory!.coverage.checkedAt = new Date(clock).toISOString(); await load(second);
    clock += 20_000; stage = 2; const third = activity(); third.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    expect((await load(third)).final?.reportedProfitUsd).toBe('99');
    expect(request.mock.calls.filter(([url]) => url.pathname.endsWith('wallet_activity'))).toHaveLength(1);
    expect(request.mock.calls.filter(([url]) => url.pathname.endsWith('token_top_traders')).map(([url]) => url.searchParams.get('order_by')))
      .toEqual(['amount_percentage', 'profit', 'profit', 'buy_volume_cur', 'buy_volume_cur']);
    clock += 20_000; stage = 3; const fresh = activity(); fresh.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    const restarted = setup(handler, { now: () => clock }); const result = await restarted.load(fresh);
    expect(result.final?.reportedProfitUsd).toBe('199'); expect(result.final?.priceUsd).toBe('30');
    expect(restarted.request).toHaveBeenCalledOnce(); expect(restarted.request.mock.calls[0][0].searchParams.get('order_by')).toBe('buy_volume_cur');
  });
  it('refreshes absent ranking membership after three minutes and restarts ranking search on a canonical correction', async () => {
    let clock = time;
    const { load, request } = setup(async url => ({ data: url.pathname.endsWith('wallet_activity') ? { activities: [providerRow()], next: null } : { list: [] } }), { now: () => clock });
    await load(activity()); clock += 20_000;
    const same = activity(); same.inventory!.coverage.checkedAt = new Date(clock).toISOString(); await load(same);
    expect(request).toHaveBeenCalledTimes(4);
    const corrected = structuredClone(same); corrected.trades[0].amountUsd = '101'; await load(corrected);
    expect(request).toHaveBeenCalledTimes(8);
    clock += 180_001; corrected.inventory!.coverage.checkedAt = new Date(clock).toISOString(); await load(corrected);
    expect(request).toHaveBeenCalledTimes(12);
  });
  it('upgrades a coalesced profile history request to foreground replay priority without issuing duplicate provider calls', async () => {
    let finish!: (value: any) => void;
    const { load, request } = setup(async url => url.pathname.endsWith('wallet_activity') ? new Promise(resolve => { finish = resolve; }) : { data: { list: [aggregate()] } });
    const profile = load(activity(), { historicalRealized: true }); await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(priorityOf(request.mock.calls[0][1])).toBe('prefetch');
    const replay = load(activity()); expect(priorityOf(request.mock.calls[0][1])).toBe('chart');
    finish({ data: { activities: [providerRow()], next: null } });
    expect((await profile).status).toBe('ready'); expect((await replay).status).toBe('ready');
    expect(request).toHaveBeenCalledTimes(2); expect(priorityOf(request.mock.calls[1][1])).toBe('chart');
  });
  it('preserves native gas in public history and invalidates older sanitized history versions', async () => {
    const first = setup(async url => ({ data: url.pathname.endsWith('wallet_activity') ? { activities: [{ ...providerRow(), gas_native: '0.001' }], next: null } : { list: [aggregate()] } }));
    await first.load(activity());
    for (const name of (await readdir(directory)).filter(name => name.includes('activity-'))) {
      const file = path.join(directory, name), envelope = JSON.parse(await readFile(file, 'utf8'));
      expect(envelope.value.version).toBe(2); expect(envelope.value.rows[0].gas_native).toBe('0.001');
      envelope.value.version = 1; delete envelope.value.rows[0].gas_native;
      envelope.checksum = createHash('sha256').update(JSON.stringify(envelope.value)).digest('hex'); await writeFile(file, JSON.stringify(envelope));
    }
    const restarted = setup(); await restarted.load(activity());
    expect(restarted.request).toHaveBeenCalledOnce(); expect(routes(restarted.request)[0]).toContain('wallet_activity');
  });
  it('keeps a fully known open cash-flow total usable while a realized split and optional ranking are unavailable', async () => {
    const { load } = setup(async url => {
      if (url.pathname.endsWith('wallet_activity')) return { data: { activities: [providerRow()], next: null } };
      throw new MarketProviderDeferred('rate_limited', 20_000);
    }, { builder: (body, rows, options) => {
      const result = buildTradeReplayGmgnAccounting(body, rows, options);
      result.events[0].remainingCostBasisUsd = null; result.events[0].cumulativeRealizedProfitUsd = null;
      return result;
    } });
    const result = await load(activity());
    expect(result).toMatchObject({ status: 'estimated', final: null, coverage: { transactionsComplete: true, balanceMatched: true,
      exactFinal: false, reason: 'aggregate_provider_rate_limited' } });
    expect(result.events[0]).toMatchObject({ remainingTokenAmount: '10', remainingCostBasisUsd: null, cumulativeRealizedProfitUsd: null,
      investedUsd: '100', soldUsd: '0', transferOutIncomeUsd: '0', feesUsd: '1', feeInclusiveCostUsd: '101' });
  });
  it.each([-180_001, 1001])('does not dispatch provider requests with a stale or future canonical proof (%sms)', async skew => {
    const { load, request } = setup(), body = activity(); body.inventory!.coverage.checkedAt = new Date(time + skew).toISOString();
    const result = await load(body); expect(result.final).toBeNull(); expect(request).not.toHaveBeenCalled();
  });
  it.each(['inventory_rpc_unavailable', 'canonical_block_unavailable', 'canonical_receipt_unavailable', 'canonical_transaction_unavailable',
    'movement_scan_unavailable', 'confirmed_endpoint_stale', 'indexed_snapshot_changed', 'unindexed_swap_pending'])
    ('keeps a temporary %s inventory failure retryable and recovers automatically once proof returns', async reason => {
      const { load, request } = setup(), body = activity();
      body.inventory!.coverage = { ...body.inventory!.coverage, complete: false, reconciled: false, status: 'unavailable', reason };
      expect(await load(body)).toMatchObject({ status: 'pending', retryAfterMs: 1000, final: null, coverage: { exactFinal: false, reason } });
      expect(request).not.toHaveBeenCalled();
      expect((await load(activity())).status).toBe('ready'); expect(request).toHaveBeenCalledTimes(2);
      body.coverage.complete = false; expect((await load(body)).status).toBe('unavailable');
    });
  it('does not retry a permanent incomplete inventory diagnosis as though it were a temporary provider failure', async () => {
    const { load, request } = setup(), body = activity();
    body.inventory!.coverage = { ...body.inventory!.coverage, complete: false, reconciled: false, status: 'unavailable', reason: 'unknown_transfer_cost' };
    expect((await load(body)).status).toBe('unavailable'); expect(request).not.toHaveBeenCalled();
  });
  it.each(['balance', 'fromBlock', 'initialBalanceSource', 'amountUsd', 'priceUsd', 'tokenAmount', 'side', 'txHash', 'timestamp'] as const)
    ('invalidates reused history when canonical %s changes', async field => {
      const { load, request } = setup(); await load(activity()); const changed = activity();
      if (field === 'balance') changed.inventory!.coverage.balance = '11';
      else if (field === 'fromBlock') changed.inventory!.coverage.fromBlock = '99';
      else if (field === 'initialBalanceSource') changed.inventory!.coverage.initialBalanceSource = 'historical_call';
      else if (field === 'side') changed.trades[0].side = 'sell';
      else changed.trades[0][field] = field === 'timestamp' ? new Date(time - 10_000).toISOString() : field === 'txHash' ? '0x' + 'a'.repeat(64) : '11';
      await load(changed); expect(routes(request).filter(route => route.endsWith('wallet_activity'))).toHaveLength(2);
    });
  it('queries every movement kind and exact pair, weights history3/traders5 and reconciles a reported final', async () => {
    const { load, request } = setup(); const result = await load(activity());
    expect(result).toMatchObject({ status: 'ready', final: { reportedProfitUsd: '99', feeInclusiveCostUsd: '101', priceUsd: '20' },
      coverage: { transactionsComplete: true, balanceMatched: true, exactFinal: true } });
    const [history, traders] = request.mock.calls;
    expect(history[0].searchParams.get('wallet_address')).toBe(wallet); expect(history[0].searchParams.get('token_address')).toBe(token);
    expect(history[0].searchParams.get('limit')).toBe('50'); expect(history[0].searchParams.getAll('type')).toEqual(['buy', 'sell', 'transferIn', 'transferOut']);
    expect(history[0].searchParams.get('timestamp')).toBe(String(time / 1000));
    expect(history[0].searchParams.get('client_id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(history[1]).toMatchObject({ weight: 3, apiKey: 'private-test-key' }); expect(priorityOf(history[1])).toBe('chart');
    expect(traders[0].searchParams.get('address')).toBe(token); expect(traders[0].searchParams.get('order_by')).toBe('amount_percentage');
    expect(traders[0].searchParams.get('limit')).toBe('100'); expect(traders[0].searchParams.has('wallet_address')).toBe(false);
    expect(traders[0].searchParams.get('timestamp')).toBe(String(time / 1000));
    expect(traders[0].searchParams.get('client_id')).toMatch(/^[a-f0-9-]{36}$/);
    expect(traders[0].searchParams.get('client_id')).not.toBe(history[0].searchParams.get('client_id'));
    expect(traders[1]).toMatchObject({ weight: 5 }); expect(priorityOf(traders[1])).toBe('chart');
    expect(history[0].href).not.toContain('private-test-key'); expect(JSON.stringify(result)).not.toContain('private-test-key');
  });
  it('uses bounded documented KOL rankings for a missing wallet and never infers zero from absence', async () => {
    const { load, request } = setup(async url => ({ data: url.pathname.endsWith('wallet_activity') ? { activities: [providerRow()], next: null }
      : { list: url.searchParams.get('order_by') === 'buy_volume_cur' ? [aggregate()] : [] } }));
    expect((await load(activity())).status).toBe('ready');
    expect(request.mock.calls.slice(1).map(([url]) => [url.searchParams.get('order_by'), url.searchParams.get('tag')])).toEqual([
      ['amount_percentage', null], ['profit', 'renowned'], ['buy_volume_cur', 'renowned'],
    ]);
    const missing = setup(async url => ({ data: url.pathname.endsWith('wallet_activity') ? { activities: [providerRow()], next: null } : { list: [] } }), { directory: path.join(directory, 'missing') });
    const estimated = await missing.load(activity()); expect(estimated.status).toBe('estimated'); expect(estimated.final).toBeNull();
    expect(estimated.coverage.exactFinal).toBe(false); expect(estimated.events[0].investedUsd).toBe('100');
  });
  it.each(['buy_amount_cur', 'sell_amount_cur'] as const)('preserves supplied invalid %s through normalization without using a matching current cycle', async field => {
    for (const invalid of [null, '', 'not-a-number']) {
      const { load } = setup(async url => ({ data: url.pathname.endsWith('wallet_activity') ? { activities: [providerRow()], next: null }
        : { list: [{ ...aggregate(), [field]: invalid }] } }), { directory: path.join(directory, field + String(invalid)) });
      const result = await load(activity());
      expect(result.final).toBeNull(); expect(result.coverage.exactFinal).toBe(false);
      expect(result.coverage.reason).toBe('aggregate_snapshot_unreconciled');
    }
  });
  it('coalesces the same pair and token-wide lookups across different wallets', async () => {
    const { load, request } = setup(); const left = activity(), right = activity(other);
    const results = await Promise.all([load(left), load(structuredClone(left)), load(right)]);
    expect(results.map(result => result.status)).toEqual(['ready', 'ready', 'ready']);
    expect(routes(request).filter(route => route.endsWith('wallet_activity'))).toHaveLength(2);
    expect(routes(request).filter(route => route.endsWith('token_top_traders'))).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('returns verified fee-inclusive profile cash flows without optional rankings, while replay still loads a current aggregate', async () => {
    let clock = time; const { load, request } = setup(undefined, { now: () => clock });
    const initial = await load(activity(), { historicalRealized: true });
    expect(initial).toMatchObject({ status: 'estimated', final: null, coverage: { transactionsComplete: true, balanceMatched: true } });
    expect(initial.events[0]).toMatchObject({ feesUsd: '1', feeInclusiveCostUsd: '101' });
    clock += 20_000;
    expect((await load(activity(), { historicalRealized: true })).status).toBe('estimated');
    expect(routes(request).filter(route => route.endsWith('wallet_activity'))).toHaveLength(1);
    expect(routes(request).filter(route => route.endsWith('token_top_traders'))).toHaveLength(0);
    expect((await load(activity())).status).toBe('ready');
    expect(routes(request).filter(route => route.endsWith('wallet_activity'))).toHaveLength(1);
    expect(routes(request).filter(route => route.endsWith('token_top_traders'))).toHaveLength(1);
  });
  it.each(['movement', 'currency', 'expired'] as const)('refreshes profile historical data after %s changes', async variant => {
    let clock = time; const { load, request } = setup(undefined, { now: () => clock });
    await load(activity(), { historicalRealized: true }); clock += variant === 'expired' ? 7 * 24 * 60 * 60 * 1000 : 20_000;
    const changed = activity(); changed.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    if (variant === 'movement') changed.inventory!.events[0].tokenAmount = '11';
    if (variant === 'currency') changed.trades[0].quoteTokenAddress = token;
    await load(changed, { historicalRealized: true });
    expect(routes(request).filter(route => route.endsWith('wallet_activity'))).toHaveLength(2);
  });
  it('coalesces in-flight profile and replay work instead of duplicating history under the two-job limit', async () => {
    let clock = time, finish!: (value: any) => void;
    const { load, request } = setup(async url => {
      if (url.pathname.endsWith('wallet_activity')) return { data: { activities: [providerRow()], next: null } };
      if (clock === time) return { data: { list: [aggregate()] } };
      return new Promise(resolve => { finish = resolve; });
    }, { now: () => clock });
    await load(activity()); clock += 20_000;
    const replay = load(activity());
    await vi.waitFor(() => expect(routes(request).filter(route => route.endsWith('token_top_traders'))).toHaveLength(2));
    const profile = load(activity(), { historicalRealized: true });
    expect(routes(request).filter(route => route.endsWith('wallet_activity'))).toHaveLength(1);
    finish({ data: { list: [aggregate()] } });
    expect((await profile).status).toBe('ready'); expect((await replay).status).toBe('ready');
  });
  it('reuses fresh persisted public caches and strips extra upstream fields and credentials', async () => {
    const { load, request } = setup(async url => ({ data: url.pathname.endsWith('wallet_activity')
      ? { activities: [{ ...providerRow(), apiKey: 'upstream-secret', token: { address: token, name: 'untrusted-metadata' } }], next: null }
      : { list: [{ ...aggregate(), apiKey: 'upstream-secret' }] } }));
    await load(activity()); await load(activity()); expect(request).toHaveBeenCalledTimes(2);
    const second = setup(); expect((await second.load(activity())).status).toBe('ready'); expect(second.request).not.toHaveBeenCalled();
    const files = await readdir(directory); expect(files.length).toBe(4);
    const contents = (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')))).join('');
    expect(contents).not.toMatch(/private-test-key|upstream-secret|untrusted-metadata/); expect(contents).toContain('checksum');
  });
  it('expires current trader prices after fifteen seconds while reusing history with a new canonical proof', async () => {
    let clock = time; const { load, request } = setup(undefined, { now: () => clock });
    await load(activity()); clock += 14_000;
    const newer = activity(); newer.inventory!.coverage.toBlock = '120'; newer.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    expect((await load(newer)).inventoryBlockNumber).toBe('120'); expect(request).toHaveBeenCalledTimes(2);
    clock += 1001; await load(newer); expect(request).toHaveBeenCalledTimes(3);
  });
  it('retains canonical-matched completed historical values during a later cooldown without carrying an old exact final or price', async () => {
    let clock = time, paused = false;
    const { load, request } = setup(async url => {
      if (paused) throw new MarketProviderDeferred('rate_limited', 300_000);
      return { data: url.pathname.endsWith('wallet_activity') ? { activities: [providerRow()], next: null } : { list: [aggregate()] } };
    }, { now: () => clock });
    expect((await load(activity())).status).toBe('ready');
    clock += 16_000; paused = true;
    const refreshed = activity(); refreshed.inventory!.coverage.toBlock = '120'; refreshed.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    const result = await load(refreshed);
    expect(result).toMatchObject({ status: 'estimated', checkedAt: new Date(clock).toISOString(), inventoryBlockNumber: '120', final: null,
      coverage: { transactionsComplete: true, balanceMatched: true, exactFinal: false, reason: 'aggregate_provider_rate_limited' } });
    expect(result.events).toHaveLength(1); expect(result.events[0]).toMatchObject({ investedUsd: '100', feesUsd: '1', remainingCostBasisUsd: '101', feeInclusiveCostUsd: '101' });
    expect(result.retryAfterMs).toBe(300_000); expect(request).toHaveBeenCalledTimes(3);
    const restarted = setup(async () => { throw new MarketProviderDeferred('rate_limited', 300_000); }, { now: () => clock + 1000 });
    expect(await restarted.load(refreshed)).toMatchObject({ status: 'estimated', final: null, coverage: { exactFinal: false } });
    expect(restarted.request).toHaveBeenCalledOnce();
  });
  it('falls back to all five matched historical checkpoints rather than only the last fill during quota cooldown', async () => {
    let clock = time, paused = false;
    const payload = activity(), rows: ReturnType<typeof providerRow>[] = [];
    payload.trades = []; payload.inventory!.events = [];
    for (let index = 0; index < 5; index++) {
      const hash = '0x' + String(index + 1).padStart(64, '0'), at = timestamp + index;
      const row = { ...providerRow(), tx_hash: hash, timestamp: at };
      rows.push(row);
      const trade = { ...activity().trades[0], id: `trade-${index}`, txHash: hash, timestamp: new Date(at * 1000).toISOString(), blockNumber: String(100 + index) };
      payload.trades.push(trade);
      payload.inventory!.events.push({ ...activity().inventory!.events[0], id: `event-${index}`, tradeId: trade.id, txHash: hash,
        timestamp: trade.timestamp, blockNumber: trade.blockNumber, remainingTokenAmount: String((index + 1) * 10) });
    }
    payload.inventory!.coverage.balance = '50'; payload.summary.remainingTokenAmount = '50';
    const { load } = setup(async url => {
      if (paused) throw new MarketProviderDeferred('rate_limited', 60_000);
      return { data: url.pathname.endsWith('wallet_activity') ? { activities: rows, next: null } : { list: [] } };
    }, { now: () => clock });
    await load(payload); clock += 16_000; paused = true;
    payload.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    const result = await load(payload);
    expect(result).toMatchObject({ status: 'estimated', final: null, coverage: { transactionsComplete: true, balanceMatched: true, exactFinal: false } });
    expect(result.events).toHaveLength(5); expect(result.events.at(-1)).toMatchObject({ investedUsd: '500', feesUsd: '5', remainingCostBasisUsd: '505', feeInclusiveCostUsd: '505' });
  });
  it.each(['movement', 'quote', 'expired'])('refuses retained historical fallback after %s changes', async variant => {
    let clock = time, paused = false;
    const { load } = setup(async url => {
      if (paused) throw new MarketProviderDeferred('rate_limited', 60_000);
      return { data: url.pathname.endsWith('wallet_activity') ? { activities: [providerRow()], next: null } : { list: [aggregate()] } };
    }, { now: () => clock });
    await load(activity()); clock += variant === 'expired' ? 7 * 24 * 60 * 60 * 1000 : 16_000; paused = true;
    const changed = activity(); changed.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    if (variant === 'movement') changed.inventory!.events[0].tokenAmount = '11';
    if (variant === 'quote') changed.trades[0].quoteTokenAddress = other;
    const result = await load(changed);
    expect(result.status).toBe('pending'); expect(result.coverage.transactionsComplete).toBe(false); expect(result.coverage.exactFinal).toBe(false);
    expect(result.final).toBeNull();
  });
  it('reuses yesterday\'s complete history after restart for profile without any provider request or invented current price', async () => {
    const first = setup(); await first.load(activity());
    const clock = time + 24 * 60 * 60 * 1000, fresh = activity();
    fresh.inventory!.coverage.checkedAt = new Date(clock).toISOString(); fresh.inventory!.coverage.toBlock = '1000';
    const restarted = setup(async () => { throw new MarketProviderDeferred('rate_limited', 60_000); }, { now: () => clock });
    const result = await restarted.load(fresh, { historicalRealized: true });
    expect(result).toMatchObject({ status: 'estimated', inventoryBlockNumber: '1000', checkedAt: new Date(clock).toISOString(), final: null,
      coverage: { transactionsComplete: true, balanceMatched: true, exactFinal: false } });
    expect(result.events[0]).toMatchObject({ investedUsd: '100', feesUsd: '1', feeInclusiveCostUsd: '101' });
    expect(restarted.request).not.toHaveBeenCalled();
  });
  it.each(['rate_limit', 'http_error'] as const)('retains yesterday\'s history for replay during %s without retaining its exact final', async failure => {
    const first = setup(); await first.load(activity());
    const clock = time + 24 * 60 * 60 * 1000, fresh = activity(); fresh.inventory!.coverage.checkedAt = new Date(clock).toISOString();
    const restarted = setup(async () => { throw failure === 'rate_limit' ? new MarketProviderDeferred('rate_limited', 60_000) : new GmgnHttpError(503); }, { now: () => clock });
    const result = await restarted.load(fresh);
    expect(result).toMatchObject({ status: 'estimated', final: null, coverage: { transactionsComplete: true, balanceMatched: true, exactFinal: false } });
    expect(result.events[0].feeInclusiveCostUsd).toBe('101');
  });
  it('does not retain a historical estimate when fees were unknown or refreshed rows disagree with canonical coverage', async () => {
    let clock = time, paused = false;
    const { load } = setup(async url => {
      if (paused) throw new MarketProviderDeferred('busy', 1000);
      return { data: url.pathname.endsWith('wallet_activity') ? { activities: [{ ...providerRow(), gas_usd: null }], next: null } : { list: [] } };
    }, { now: () => clock });
    await load(activity()); clock += 16_000; paused = true;
    const result = await load(activity()); expect(result.status).toBe('estimated'); expect(result.final).toBeNull();
    expect(result.events[0].feesUsd).toBeNull(); expect(result.events[0].feeInclusiveCostUsd).toBeNull();
  });
  it('resumes successful pages after a deferral and includes the returned cursor instead of restarting', async () => {
    let stage = 0;
    const { load, request } = setup(async url => {
      if (url.pathname.endsWith('token_top_traders')) return { data: { list: [aggregate()] } };
      if (!url.searchParams.has('cursor')) return { data: { activities: [providerRow()], next: 'page-2' } };
      if (++stage === 1) throw new MarketProviderDeferred('rate_limited', 9000);
      return { data: { activities: [], next: null } };
    });
    const pending = await load(activity()); expect(pending).toMatchObject({ status: 'pending', retryAfterMs: 9000, coverage: { reason: 'provider_rate_limited', transactionsComplete: false } });
    const resumed = await load(activity()); expect(resumed.status).toBe('ready');
    expect(request.mock.calls.filter(([url]) => url.pathname.endsWith('wallet_activity')).map(([url]) => url.searchParams.get('cursor'))).toEqual([null, 'page-2', 'page-2']);
  });
  it('resumes partial pages across process restarts and safely deduplicates identical page overlap', async () => {
    const first = setup(async url => {
      if (url.searchParams.has('cursor')) throw new MarketProviderDeferred('busy', 1000);
      return { data: { activities: [providerRow()], next: 'second' } };
    });
    await first.load(activity());
    const second = setup(async url => ({ data: url.pathname.endsWith('wallet_activity') ? { activities: [providerRow()], next: null } : { list: [aggregate()] } }));
    expect((await second.load(activity())).status).toBe('ready');
    expect(second.request.mock.calls[0][0].searchParams.get('cursor')).toBe('second');
  });
  it('invalidates cached history if canonical movement quantities or quote currency change', async () => {
    const { load, request } = setup(); await load(activity());
    const changed = activity(); changed.trades[0].quoteTokenAddress = '0x' + 'a'.repeat(40);
    const result = await load(changed); expect(request.mock.calls.filter(([url]) => url.pathname.endsWith('wallet_activity'))).toHaveLength(2);
    expect(result.events[0].feesUsd).toBeNull();
  });
  it.each([
    ['cycle', { activities: [providerRow()], next: 'loop' }, { activities: [], next: 'loop' }, 'provider_cursor_invalid'],
    ['conflict', { activities: [providerRow()], next: 'second' }, { activities: [{ ...providerRow(), cost_usd: '101' }], next: null }, 'provider_activity_conflict'],
    ['wrong pair', { activities: [{ ...providerRow(), wallet: other }], next: null }, null, 'provider_response_invalid'],
    ['future', { activities: [{ ...providerRow(), timestamp: time / 1000 + 60 }], next: null }, null, 'provider_response_invalid'],
    ['wrong shape', { list: [providerRow()] }, null, 'provider_response_invalid'],
  ])('rejects %s provider history without publishing an exact final', async (_name, first, next, reason) => {
    let count = 0; const { load, request } = setup(async () => ({ data: ++count === 1 ? first : next }));
    expect(await load(activity())).toMatchObject({ status: 'unavailable', final: null, coverage: { exactFinal: false, reason } });
    expect(request.mock.calls.every(([url]) => url.pathname.endsWith('wallet_activity'))).toBe(true);
  });
  it('discards a mutated disk cache and malformed public records before using them', async () => {
    const first = setup(); await first.load(activity());
    const name = (await readdir(directory)).find(file => file.startsWith('activity-'))!;
    const target = path.join(directory, name), envelope = JSON.parse(await readFile(target, 'utf8'));
    envelope.value.rows = []; await writeFile(target, JSON.stringify(envelope));
    const next = setup(); expect((await next.load(activity())).status).toBe('ready');
    expect(next.request.mock.calls.some(([url]) => url.pathname.endsWith('wallet_activity'))).toBe(true);
    const forged = JSON.parse(await readFile(target, 'utf8')); forged.value.rows[0].token.address = other;
    forged.checksum = createHash('sha256').update(JSON.stringify(forged.value)).digest('hex'); await writeFile(target, JSON.stringify(forged));
    const again = setup(); expect((await again.load(activity())).status).toBe('ready'); expect(again.request).toHaveBeenCalledOnce();
  });
  it('keeps a foreground slot available while profile history is loading', async () => {
    vi.useFakeTimers(); let clock = time;
    const { load, request } = setup(async () => new Promise(() => {}), { now: () => clock, budgetMs: 1000 });
    const profile = load(activity(), { historicalRealized: true });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(priorityOf(request.mock.calls[0][1])).toBe('prefetch');
    expect(await load(activity(other), { historicalRealized: true })).toMatchObject({ status: 'pending', coverage: { reason: 'provider_busy' } });
    expect(request).toHaveBeenCalledOnce();
    const modal = load(activity(other), { historicalRealized: true, foreground: true });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(priorityOf(request.mock.calls[1][1])).toBe('chart');
    const joined = load(activity(), { historicalRealized: true, foreground: true });
    expect(priorityOf(request.mock.calls[0][1])).toBe('chart');
    expect(await load(activity('0x' + '6'.repeat(40)), { historicalRealized: true, foreground: true }))
      .toMatchObject({ status: 'pending', coverage: { reason: 'provider_busy' } });
    clock += 1000; await vi.advanceTimersByTimeAsync(1000);
    expect((await profile).status).toBe('pending');
    expect((await modal).status).toBe('pending');
    expect((await joined).status).toBe('pending');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('caps distinct jobs at2 and bounds stalled requests even when an injected requester ignores abort', async () => {
    vi.useFakeTimers(); let clock = time;
    const { load, request } = setup(async () => new Promise(() => {}), { now: () => clock, budgetMs: 100 });
    const a = load(activity()), b = load(activity(other));
    const third = activity('0x' + '6'.repeat(40)); expect(await load(third)).toMatchObject({ status: 'pending', coverage: { reason: 'provider_busy' } });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2)); clock += 100; await vi.advanceTimersByTimeAsync(100);
    expect(await a).toMatchObject({ status: 'pending', retryAfterMs: 1000, coverage: { reason: 'provider_timeout' } });
    expect((await b).status).toBe('pending');
  });
  it('keeps a later coalesced lookup pending when the owning pair hits its deadline first', async () => {
    vi.useFakeTimers(); let clock = time;
    const { load, request } = setup(async url => {
      if (url.pathname.endsWith('token_top_traders')) return new Promise(() => {});
      return { data: { activities: [providerRow(url.searchParams.get('wallet_address')!)], next: null } };
    }, { now: () => clock, budgetMs: 1000 });
    const first = load(activity());
    await vi.waitFor(() => expect(routes(request).filter(route => route.endsWith('token_top_traders'))).toHaveLength(1), { interval: 0 });
    clock += 500; await vi.advanceTimersByTimeAsync(500);
    const joined = load(activity(other));
    // Dispatching wallet_activity is earlier than saving its history and joining
    // the shared trader lookup. Wait for both cancellation boundaries (the
    // outer trader lookup and its coalesced wait) before advancing the owner’s
    // deadline. interval:0 lets real disk I/O finish without waitFor advancing
    // fake time on each poll under a busy, parallel test run.
    await vi.waitFor(() => {
      const options = request.mock.calls.find(([url]) => url.pathname.endsWith('wallet_activity') && url.searchParams.get('wallet_address') === other)?.[1];
      expect(options?.signal).toBeDefined();
      expect(getEventListeners(options!.signal!, 'abort')).toHaveLength(2);
    }, { interval: 0 });
    clock += 500; await vi.advanceTimersByTimeAsync(500);
    expect((await first).status).toBe('estimated'); expect(await joined).toMatchObject({ status: 'estimated', coverage: { reason: 'aggregate_provider_timeout', exactFinal: false } });
    expect(routes(request).filter(route => route.endsWith('token_top_traders'))).toHaveLength(1);
  });
  it.each(['deferred', 'http', 'invalid'])('keeps verified complete historical accounting usable when the optional aggregate is %s', async failure => {
    const { load } = setup(async url => {
      if (url.pathname.endsWith('wallet_activity')) return { data: { activities: [providerRow()], next: null } };
      if (failure === 'deferred') throw new MarketProviderDeferred('rate_limited', 60_000);
      if (failure === 'http') throw new GmgnHttpError(401);
      return { data: { list: null } };
    });
    const result = await load(activity());
    expect(result).toMatchObject({ status: 'estimated', final: null, coverage: { transactionsComplete: true, balanceMatched: true, exactFinal: false } });
    expect(result.events[0]).toMatchObject({ investedUsd: '100', feesUsd: '1', remainingCostBasisUsd: '101', cumulativeRealizedProfitUsd: '0' });
    expect(result.retryAfterMs).toBe(failure === 'deferred' ? 60_000 : undefined); expect(result.coverage.reason).toMatch(/^aggregate_/);
  });
  it('does not turn incomplete fee evidence into a usable estimate when an aggregate is deferred', async () => {
    const { load } = setup(async url => {
      if (url.pathname.endsWith('wallet_activity')) return { data: { activities: [{ ...providerRow(), gas_usd: null }], next: null } };
      throw new MarketProviderDeferred('busy', 1000);
    });
    expect(await load(activity())).toMatchObject({ status: 'pending', retryAfterMs: 1000, coverage: { reason: 'provider_busy', exactFinal: false } });
  });
  it('coalesces same-pair requests with changed canonical events and requires another bounded preparation', async () => {
    let finish!: (value: any) => void;
    const { load, request } = setup(async url => url.pathname.endsWith('wallet_activity') ? new Promise(resolve => { finish = resolve; }) : { data: { list: [aggregate()] } });
    const first = load(activity()); await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const changed = activity(); changed.inventory!.events[0].tokenAmount = '11';
    const joined = load(changed); finish({ data: { activities: [providerRow()], next: null } });
    expect((await first).status).toBe('ready');
    expect(await joined).toMatchObject({ status: 'pending', retryAfterMs: 1000, coverage: { reason: 'canonical_snapshot_changed', exactFinal: false } });
    expect(routes(request).filter(route => route.endsWith('wallet_activity'))).toHaveLength(1);
  });
  it('preserves shared cooldowns without exposing upstream error details', async () => {
    const { load } = setup(async () => { throw new MarketProviderDeferred('rate_limited', 300_000); });
    expect(await load(activity())).toMatchObject({ status: 'pending', retryAfterMs: 300_000, coverage: { reason: 'provider_rate_limited' } });
    const bad = setup(async () => { throw Error('private-test-key upstream-private-description'); });
    const result = await bad.load(activity()); expect(result.coverage.reason).toBe('provider_unavailable');
    expect(JSON.stringify(result)).not.toMatch(/private-test-key|upstream-private-description/);
    const denied = setup(async () => { throw new GmgnHttpError(401); }); expect((await denied.load(activity())).coverage.reason).toBe('provider_http_401');
  });
  it('does no provider work when key or canonical movement proof is unavailable', async () => {
    const missing = setup(undefined, { apiKey: () => '' }); expect((await missing.load(activity())).status).toBe('unavailable'); expect(missing.request).not.toHaveBeenCalled();
    const { load, request } = setup(); const pending = activity(); pending.inventory!.coverage.complete = false; pending.inventory!.coverage.status = 'pending';
    expect((await load(pending)).status).toBe('pending'); expect(request).not.toHaveBeenCalled();
    const truncated = activity(); truncated.coverage.complete = false; expect((await load(truncated)).status).toBe('unavailable'); expect(request).not.toHaveBeenCalled();
  });
});
