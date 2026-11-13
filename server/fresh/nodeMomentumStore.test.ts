import { describe, expect, it, vi } from 'vitest';
import { WBNB } from '../launchpad.js';
import type { Pool } from 'pg';
import { trendingWindows, type TrendingWindow } from '../../shared/trendingTokens.js';
import { createNodeMomentumStore, nodeMomentumCheckpoint, persistNodeMomentumSnapshot, readNodeMomentumSnapshot,
  type NodeMomentumSwap } from './nodeMomentumStore.js';

const minute = 60_000;
const now = Date.parse('2026-11-13T12:00:00.000Z');
const key = (n: number, length: number) => '0x' + n.toString(16).padStart(length, '0');
const address = (n: number) => key(n, 40);
const hash = (n: number) => key(n, 64);
const jacket = '0xb82535e74b03ffe4910efea1c759b6bbbf0a7777';

function swap(at: number, index: number, options: Partial<NodeMomentumSwap> = {}): NodeMomentumSwap {
  return {
    poolAddress: address(1), tokenAddress: jacket, quoteAddress: address(50), name: 'Just a jacket', symbol: 'Jacket',
    blockNumber: index + 1, blockHash: hash(index + 1), transactionHash: hash(index + 100), transactionIndex: 0, logIndex: 0,
    at, side: 'buy', volumeUsd: 100, priceUsd: 1, ...options,
  };
}

function series(window: TrendingWindow, options: { pool?: number; token?: string; price?: number; volume?: number; txs?: number } = {}) {
  const duration = trendingWindows[window] * minute;
  const from = now - duration;
  const earlyAt = from + 15_000;
  const lateAt = now - 40_000;
  const count = options.txs ?? 50;
  const defaults = { poolAddress: address(options.pool ?? 1), tokenAddress: options.token ?? jacket,
    volumeUsd: options.volume ?? 1_000 };
  const early = Array.from({ length: count }, (_, i) => swap(earlyAt, i, defaults));
  const late = Array.from({ length: count }, (_, i) => swap(lateAt, i + count, {
    ...defaults, priceUsd: options.price ?? 2, side: i < 2 ? 'sell' : 'buy', marketCapUsd: 42_000,
  }));
  return [...early, ...late];
}

function appendSeries(store: ReturnType<typeof createNodeMomentumStore>, swaps: NodeMomentumSwap[], coveredPools?: string[]) {
  const ordered = [...swaps].sort((a, b) => a.at - b.at)
    .map((entry, i) => ({ ...entry, blockNumber: i + 1, blockHash: hash(i + 1), transactionHash: hash(i + 5_000) }));
  store.appendRange({ fromBlock: 1, parentHash: hash(0), blockNumber: ordered.length + 1, blockHash: hash(ordered.length + 1),
    observedAt: now + 20_000, swaps: ordered, coveredPools });
}

describe('node momentum store', () => {
  it.each(Object.keys(trendingWindows) as TrendingWindow[])('ranks the %s window only after actual covered history', window => {
    const start = now - trendingWindows[window] * minute;
    const entries = series(window);
    const store = createNodeMomentumStore({ coverageStartMs: start - 1 });
    appendSeries(store, entries, [address(1)]);
    expect(store.snapshot()?.windows[window]).toEqual([{
      address: jacket, name: 'Just a jacket', symbol: 'Jacket', volumeUsd: '100000', marketCapUsd: '42000',
      priceChangePct: 100, buyCount: 98, sellCount: 2,
    }]);
    const lateStart = createNodeMomentumStore({ coverageStartMs: start });
    appendSeries(lateStart, entries, [address(1)]);
    expect(lateStart.snapshot()?.windows).not.toHaveProperty(window);
  });

  it('uses one pool per contract and ignores falling, sparse, or too-small activity', () => {
    const store = createNodeMomentumStore({ coverageStartMs: now - 60 * minute - 1 });
    appendSeries(store, [
      ...series('1h', { pool: 1, price: 1.6, volume: 10_000 }),
      ...series('1h', { pool: 2, price: 30 }),
      ...series('1h', { pool: 3, token: address(30), price: 0.8 }),
      ...series('1h', { pool: 4, token: address(40), txs: 1 }),
      ...series('1h', { pool: 5, token: address(60), volume: 5 }),
    ]);
    expect(store.snapshot()?.windows['1h']).toHaveLength(1);
    expect(store.snapshot()?.windows['1h']?.[0]).toMatchObject({ address: jacket, volumeUsd: '1000000' });
    expect(store.snapshot()?.windows['5m']).toEqual([]);
  });

  it('reports the quote of the selected representative pool without assuming a token tax', () => {
    const store = createNodeMomentumStore({ coverageStartMs: now - 60 * minute - 1 });
    const preferred = series('1h', { pool: 2, volume: 10_000 }).map(entry => ({ ...entry, quoteAddress: WBNB }));
    appendSeries(store, [...series('1h'), ...preferred]);
    const item = store.snapshot()?.windows['1h']?.[0];
    expect(item?.quoteSymbol).toBe('WBNB');
    expect(item).not.toHaveProperty('buyTaxBps');
    expect(item).not.toHaveProperty('sellTaxBps');
  });

  it('ignores unsettled current minutes and expires the oldest aggregate buckets', () => {
    const store = createNodeMomentumStore({ coverageStartMs: now - 5 * minute - 1 });
    const entries = series('5m', { txs: 7 });
    entries.push(swap(now + 15_000, 30, { volumeUsd: 1_000_000, priceUsd: 1_000 }));
    appendSeries(store, entries);
    expect(store.snapshot()?.windows['5m']?.[0]?.volumeUsd).toBe('14000');
    expect(store.stats()).toEqual({ markets: 1, buckets: 3 });
    const last = store.cursor()!;
    store.append({ blockNumber: last.blockNumber + 1, parentHash: last.blockHash, blockHash: hash(last.blockNumber + 1),
      observedAt: now + 25 * 60 * minute, swaps: [] });
    expect(store.stats()).toEqual({ markets: 0, buckets: 0 });
    expect(store.snapshot()?.windows['24h']).toEqual([]);
  });

  it('does not count repeated logs in one transaction as separate price evidence', () => {
    const store = createNodeMomentumStore({ coverageStartMs: now - 5 * minute - 1 });
    const entries = series('5m', { txs: 7 }).map((entry, i) => i < 7 ? {
      ...entry, blockNumber: 1, blockHash: hash(1), transactionHash: hash(123), logIndex: i,
    } : entry);
    store.appendRange({ fromBlock: 1, parentHash: hash(0), blockNumber: 100, blockHash: hash(100),
      observedAt: now, swaps: entries });
    expect(store.snapshot()?.windows['5m']).toEqual([]);
  });

  it('keeps turnover from authentic swaps with missing or extreme price observations', () => {
    const store = createNodeMomentumStore({ coverageStartMs: now - 5 * minute - 1 });
    const entries = series('5m', { txs: 7 });
    entries[0].priceUsd = 3.399e38;
    entries[entries.length - 1].priceUsd = null;
    appendSeries(store, entries);
    expect(store.snapshot()?.windows['5m']?.[0]).toMatchObject({ volumeUsd: '14000', priceChangePct: 100 });
  });

  it('serializes valid USD amounts as bounded decimals for the panel', () => {
    const store = createNodeMomentumStore({ coverageStartMs: now - 5 * minute - 1 });
    const entries = series('5m', { txs: 7, volume: 100.0123456 });
    entries[entries.length - 1].marketCapUsd = 0.00000001;
    appendSeries(store, entries);
    expect(store.snapshot()?.windows['5m']?.[0]).toMatchObject({ volumeUsd: '1400.1728384', marketCapUsd: '0.00000001' });
  });

  it('requires continuity and stable pool identity without partially applying invalid inputs', () => {
    const store = createNodeMomentumStore({ coverageStartMs: now - 5 * minute - 1 });
    const entries = series('5m', { txs: 7 });
    appendSeries(store, entries, [address(1)]);
    const previous = store.snapshot();
    const last = store.cursor()!;
    expect(() => store.append({ blockNumber: last.blockNumber + 2, parentHash: last.blockHash, blockHash: hash(100),
      observedAt: now + 21_000, swaps: [], coveredPools: [address(1)] })).toThrow('node_momentum_range_discontinuous');
    expect(() => store.append({ blockNumber: last.blockNumber + 1, parentHash: hash(300), blockHash: hash(100),
      observedAt: now + 21_000, swaps: [], coveredPools: [address(1)] })).toThrow('node_momentum_range_discontinuous');
    const newSwap = swap(now + 21_000, last.blockNumber, { tokenAddress: address(90), blockHash: hash(100) });
    expect(() => store.append({ blockNumber: last.blockNumber + 1, parentHash: last.blockHash, blockHash: hash(100),
      observedAt: now + 21_000, swaps: [newSwap], coveredPools: [address(1)] })).toThrow('node_momentum_pool_identity_changed');
    expect(store.snapshot()).toEqual(previous);
    store.reset(now + 20_000);
    expect(store.snapshot()).toBeNull();
    expect(store.cursor()).toBeNull();
    expect(store.stats()).toEqual({ markets: 0, buckets: 0 });
  });

  it('bounds memory and does not reuse a removed pool’s earlier roster coverage', () => {
    const store = createNodeMomentumStore({ coverageStartMs: now - 5 * minute - 1, maxMarkets: 1 });
    expect(() => appendSeries(store, [], [address(1), address(2)])).toThrow('invalid_node_momentum_roster');
    appendSeries(store, series('5m', { txs: 7 }), [address(1)]);
    expect(store.stats().markets).toBe(1);
    const last = store.cursor()!;
    store.append({ blockNumber: last.blockNumber + 1, parentHash: last.blockHash, blockHash: hash(200),
      observedAt: now + 22_000, swaps: [], coveredPools: [address(2)] });
    expect(store.stats().markets).toBe(0);
    const readded = series('5m', { txs: 7 }).map((entry, i) => ({
      ...entry, blockNumber: 201 + i, blockHash: hash(201 + i), at: entry.at + 5 * minute + 30_000,
    }));
    store.appendRange({ fromBlock: last.blockNumber + 2, blockNumber: 300, parentHash: hash(200), blockHash: hash(300),
      observedAt: now + 5 * minute, swaps: readded.filter(entry => entry.at <= now + 5 * minute), coveredPools: [address(1)] });
    expect(store.snapshot()?.windows['5m']).toEqual([]);
  });

  it('persists only a versioned, bounded canonical snapshot and refuses stale/future reads', async () => {
    const store = createNodeMomentumStore({ coverageStartMs: now - 5 * minute - 1 });
    appendSeries(store, series('5m', { txs: 7 }));
    const snapshot = store.snapshot()!;
    const query = vi.fn(async () => ({ rowCount: 1, rows: [{
      value: { ...snapshot, captureRevision: '4' }, block_number: snapshot.blockNumber, block_hash: snapshot.blockHash,
      occurred_at: new Date(snapshot.observedAtMs),
    }] }));
    const db = { query } as unknown as Pick<Pool, 'query'>;
    expect(await persistNodeMomentumSnapshot(db, snapshot, '4')).toBe(true);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('FOR SHARE OF c');
    expect(params[0]).toBe(nodeMomentumCheckpoint);
    expect(JSON.parse(params[5] as string)).toEqual({ ...snapshot, captureRevision: '4' });
    expect(await readNodeMomentumSnapshot(db, '5m', now + minute)).toEqual(snapshot.windows['5m']);
    expect(await readNodeMomentumSnapshot(db, '5m', now + 3 * minute + 1)).toEqual([]);
    expect(await readNodeMomentumSnapshot(db, '5m', now - 1)).toEqual([]);
    expect(await readNodeMomentumSnapshot(db, '6h', now + minute)).toEqual([]);
    await expect(persistNodeMomentumSnapshot(db, { ...snapshot, source: 'wrong' as 'bnb_node' }, '4'))
      .rejects.toThrow('invalid_node_momentum_snapshot');
    const malformedCap = { ...snapshot, windows: { '5m': [{ ...snapshot.windows['5m']![0], marketCapUsd: '0xff' }] } };
    await expect(persistNodeMomentumSnapshot(db, malformedCap, '4')).rejects.toThrow('invalid_node_momentum_snapshot');
  });
});
