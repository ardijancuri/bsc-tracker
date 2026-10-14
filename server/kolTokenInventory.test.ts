import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKolTokenInventory as createInventoryLoader, persistCanonicalInventoryTransfers, type KolTokenInventoryRequest } from './kolTokenInventory.js';
import { transferTopic } from './swap.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('./db.js', () => ({ pool: { query: vi.fn(), connect: mocks.connect } }));
const wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40), other = '0x' + '3'.repeat(40);
const h = (value: number) => `0x${value.toString(16).padStart(64, '0')}`, hex = (value: number) => `0x${value.toString(16)}`;
const addressTopic = (value: string) => `0x${value.slice(2).padStart(64, '0')}`;
const event = (tx: number, height: number, delta: number, index = 0) => ({ address: token, topics: [transferTopic,
  addressTopic(delta < 0 ? wallet : other), addressTopic(delta < 0 ? other : wallet)], data: h(Math.abs(delta)), transactionHash: h(tx),
  blockNumber: hex(height), blockHash: h(height), logIndex: hex(index), transactionIndex: '0x0' });
const logs = [event(1, 100, 10), event(2, 102, -3), event(3, 105, -7)];
const request = (): KolTokenInventoryRequest => ({ wallet, token, firstBlock: '100', decimals: 0, tradesComplete: true,
  trades: [{ txHash: h(1), side: 'buy', tokenAmount: '10', blockNumber: '100' }, { txHash: h(2), side: 'sell', tokenAmount: '3', blockNumber: '102' }] });
const createKolTokenInventory = (options: Parameters<typeof createInventoryLoader>[0] = {}) => createInventoryLoader({ now: () => (1_790_000_000 + 114) * 1000, ...options });
function chain(options: { opening?: number; ending?: number; pruned?: boolean; entries?: typeof logs; timestampOffset?: number; swapTx?: string } = {}) {
  const opening = options.opening ?? 0, ending = options.ending ?? opening, pruned = options.pruned ?? false, entries = options.entries ?? logs;
  let fork = false, head = 114;
  const rpc = vi.fn(async (method: string, params: any[], _signal?: AbortSignal) => {
    if (method === 'eth_blockNumber') return hex(head);
    if (method === 'eth_getBlockByNumber') {
      const height = Number(BigInt(params[0]));
      return { number: hex(height), hash: h(height + (fork ? 1000 : 0)), timestamp: hex(1_790_000_000 + height + (options.timestampOffset ?? 0)) };
    }
    if (method === 'eth_call') {
      if (params[0].data === '0x313ce567') return '0x0';
      if (params[1] === hex(99)) { if (pruned) throw new Error('Pruned state'); return hex(opening); }
      if (options.ending !== undefined) return hex(ending);
      const height = Number(BigInt(params[1]));
      const balance = entries.filter(log => Number(BigInt(log.blockNumber)) <= height).reduce((sum, log) =>
        sum + BigInt(log.data) * (log.topics[2] === addressTopic(wallet) ? 1n : -1n), BigInt(opening));
      return `0x${balance.toString(16)}`;
    }
    if (method === 'eth_getLogs') {
      const filter = params[0], from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
      return entries.filter(log => Number(BigInt(log.blockNumber)) >= from && Number(BigInt(log.blockNumber)) <= to
        && (!filter.topics[1] || log.topics[1] === filter.topics[1]) && (!filter.topics[2] || log.topics[2] === filter.topics[2]));
    }
    if (method === 'eth_getTransactionReceipt') {
      const rows = entries.filter(log => log.transactionHash === params[0]);
      const receiptLogs = params[0] === options.swapTx ? [...rows, { address: other, topics: ['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'], data: '0x' }] : rows;
      return rows.length ? { status: '0x1', transactionHash: params[0], blockNumber: rows[0].blockNumber, blockHash: rows[0].blockHash, transactionIndex: '0x0', logs: receiptLogs } : null;
    }
    if (method === 'eth_getTransactionByHash') {
      const row = entries.find(log => log.transactionHash === params[0]);
      return row ? { hash: params[0], blockNumber: row.blockNumber, blockHash: row.blockHash, from: wallet, to: token, value: '0x0' } : null;
    }
    throw new Error('Unexpected RPC method');
  });
  return { rpc, reorg: () => { fork = true; }, advanceHead: (height: number) => { head = height; } };
}
const query = async () => ({ rows: [] });
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

describe('canonical KOL token inventory', () => {
  it('proves complete movements and same-block balance, exposing an outgoing transfer separately from swaps', async () => {
    const provider = chain(), persist = vi.fn(async (_events: unknown[], _endpoint: unknown, verify: () => Promise<void>) => verify());
    const inventory = createKolTokenInventory({ rpc: provider.rpc, query, persist, directory: null });
    const result = await inventory(request());
    expect(result).toMatchObject({ initialBalanceRaw: '0', endingBalanceRaw: '0', decimals: 0,
      coverage: { complete: true, reconciled: true, fromBlock: '100', toBlock: '108', blockHash: h(108), balance: '0', status: 'verified', initialBalanceSource: 'historical_call' } });
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]).toMatchObject({ txHash: h(3), deltaRaw: '-7', blockNumber: '105', logIndex: 0, transactionIndex: 0 });
    expect(persist.mock.calls[0][0]).toHaveLength(1);
    expect(provider.rpc.mock.calls.filter(([method]) => method === 'eth_call').at(-1)?.[1][1]).toBe(hex(108));
  });
  it('derives zero or positive unknown-cost opening balances only after a complete canonical scan', async () => {
    for (const opening of [0, 5]) {
      const provider = chain({ opening, ending: opening, pruned: true });
      const result = await createKolTokenInventory({ rpc: provider.rpc, query, persist: async () => {}, directory: null })(request());
      expect(result).toMatchObject({ initialBalanceRaw: String(opening), endingBalanceRaw: String(opening),
        coverage: { complete: true, reconciled: true, initialBalanceSource: 'derived_complete_movements', balance: String(opening) } });
    }
  });
  it('rejects a negative derived opening instead of inventing a zero balance', async () => {
    const provider = chain({ pruned: true, entries: [event(1, 100, 10)], ending: 3 });
    const result = await createKolTokenInventory({ rpc: provider.rpc, query, persist: async () => {}, directory: null })(request());
    expect(result).toMatchObject({ initialBalanceRaw: null, coverage: { complete: true, reconciled: false, reason: 'negative_derived_opening' } });
  });
  it('withholds proof for swap quantity, canonical block, and ending balance mismatches', async () => {
    for (const mismatch of ['quantity', 'block', 'balance']) {
      const provider = chain({ ending: mismatch === 'balance' ? 1 : 0 }), selected = request();
      if (mismatch === 'quantity') selected.trades[0].tokenAmount = '9';
      if (mismatch === 'block') selected.trades[0].blockNumber = '101';
      const result = await createKolTokenInventory({ rpc: provider.rpc, query, persist: async () => {}, directory: null })(selected);
      expect(result.coverage.complete).toBe(true); expect(result.coverage.reconciled).toBe(false);
      expect(result.coverage.reason).toMatch(/unreconciled/);
    }
  });
  it('does not turn an empty indexed ledger into a complete empty movement window', async () => {
    const provider = chain();
    const rpc = vi.fn(async (method: string, params: any[], signal: AbortSignal) => { if (method === 'eth_getLogs') throw new Error('Unavailable'); return provider.rpc(method, params, signal); });
    const result = await createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null, pageSize: 512 })(request());
    expect(result.coverage).toMatchObject({ complete: false, reconciled: false, status: 'unavailable' });
    expect(result.initialBalanceRaw).toBeNull();
  });
  it('coalesces concurrent requests and resets cached proof after a canonical reorganization', async () => {
    const provider = chain(), inventory = createKolTokenInventory({ rpc: provider.rpc, query, persist: async () => {}, directory: null });
    const [a, b] = await Promise.all([inventory(request()), inventory(request())]);
    expect(a).toBe(b); expect(a.coverage.reconciled).toBe(true);
    provider.reorg();
    const changed = await inventory(request());
    expect(changed.coverage.reconciled).toBe(false); expect(changed.coverage.complete).toBe(false);
    expect(changed.coverage.reason).toMatch(/canonical/);
  });
  it('resumes completed pages after its request budget rather than blocking the modal', async () => {
    vi.useFakeTimers();
    const provider = chain(), originalTimeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new Error('Budget')), ms); return controller.signal;
    });
    let hold = true;
    const rpc = vi.fn(async (method: string, params: any[], signal: AbortSignal) => {
      if (method === 'eth_getLogs' && Number(BigInt(params[0].fromBlock)) > 102 && hold) return new Promise(() => {});
      return provider.rpc(method, params, signal);
    });
    try {
      const inventory = createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null, pageSize: 3, budgetMs: 100 });
      const first = inventory(request()); await vi.advanceTimersByTimeAsync(100);
      expect((await first).coverage).toMatchObject({ complete: false, reconciled: false, status: 'pending', scannedThroughBlock: '102' });
      hold = false;
      const result = await inventory(request());
      expect(result.coverage).toMatchObject({ complete: true, reconciled: true });
      expect(rpc.mock.calls.filter(([method, params]) => method === 'eth_getLogs' && params[0].fromBlock === hex(100))).toHaveLength(2);
    } finally { originalTimeout.mockRestore(); }
  });
  it('extends a resumed old target through the currently confirmed head before claiming fresh balance proof', async () => {
    vi.useFakeTimers();
    const provider = chain({ entries: [...logs, event(4, 200, 5)] });
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new Error('Budget')), ms); return controller.signal;
    });
    let hold = true;
    const rpc = vi.fn(async (method: string, params: any[], signal: AbortSignal) => {
      if (method === 'eth_getLogs' && Number(BigInt(params[0].fromBlock)) > 102 && hold) return new Promise(() => {});
      return provider.rpc(method, params, signal);
    });
    try {
      const inventory = createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null, pageSize: 3, budgetMs: 100,
        now: () => (1_790_000_000 + 500) * 1000 });
      const pending = inventory(request()); await vi.advanceTimersByTimeAsync(100);
      expect((await pending).coverage).toMatchObject({ complete: false, toBlock: '108', scannedThroughBlock: '102' });
      hold = false; provider.advanceHead(500);
      const resumed = await inventory(request());
      expect(resumed.coverage).toMatchObject({ complete: true, reconciled: true, toBlock: '494', balance: '5' });
      expect(resumed.transfers.some(event => event.blockNumber === '200' && event.deltaRaw === '5')).toBe(true);
    } finally { timeout.mockRestore(); }
  });
  it('limits unique active scans while coalescing the same pair', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new Error('Budget')), ms); return controller.signal;
    });
    const rpc = vi.fn(async () => new Promise(() => {}));
    try {
      const inventory = createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null, budgetMs: 100 });
      const first = inventory(request()), duplicate = inventory(request());
      const second = inventory({ ...request(), wallet: '0x' + '4'.repeat(40) });
      const queued = await inventory({ ...request(), wallet: '0x' + '5'.repeat(40) });
      expect(queued.coverage).toMatchObject({ complete: false, reconciled: false, status: 'pending', reason: 'scan_queued' });
      expect(rpc).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(100);
      const results = await Promise.all([first, duplicate, second]); expect(results[0]).toBe(results[1]);
    } finally { timeout.mockRestore(); }
  });
  it('keeps movement coverage explicit when indexed swaps are incomplete', async () => {
    const provider = chain(), selected = { ...request(), tradesComplete: false };
    const result = await createKolTokenInventory({ rpc: provider.rpc, query, persist: async () => {}, directory: null })(selected);
    expect(result.coverage).toMatchObject({ complete: true, reconciled: false, reason: 'indexed_trades_incomplete' });
  });
  it('ignores orphan indexed-ledger hints absent from the canonical log scan', async () => {
    const provider = chain(), orphan = h(999);
    const inventory = createKolTokenInventory({ rpc: provider.rpc,
      query: async sql => ({ rows: sql.includes('FROM trades') ? [] : [{ txHash: orphan, blockNumber: '103' }] }), persist: async () => {}, directory: null });
    const result = await inventory(request());
    expect(result.coverage).toMatchObject({ complete: true, reconciled: true });
    expect(result.transfers.some(event => event.txHash === orphan)).toBe(false);
  });
  it('discards corrupted disk records and rescans missing indexed swap records', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bscan-inventory-test-'));
    const provider = chain(), options = { rpc: provider.rpc, query, persist: async () => {}, directory };
    const file = path.join(directory, `${wallet}-${token}-100.json`);
    try {
      expect((await createKolTokenInventory(options)(request())).coverage.reconciled).toBe(true);
      for (const corruption of ['bad_raw', 'missing_swap']) {
        const cached = JSON.parse(await readFile(file, 'utf8'));
        if (corruption === 'bad_raw') cached.state.movements[0].deltaRaw = 'bad';
        else { cached.state.movements = cached.state.movements.filter((event: { txHash: string }) => event.txHash !== h(1));
          cached.checksum = createHash('sha256').update(JSON.stringify(cached.state)).digest('hex'); }
        await writeFile(file, JSON.stringify(cached)); provider.rpc.mockClear();
        const repaired = await createKolTokenInventory(options)(request());
        expect(repaired.coverage).toMatchObject({ complete: true, reconciled: true });
        expect(provider.rpc.mock.calls.filter(([method]) => method === 'eth_getLogs')).toHaveLength(2);
      }
    } finally {
      const resolved = path.resolve(directory), intended = path.resolve(tmpdir()) + path.sep;
      if (!resolved.startsWith(intended) || !path.basename(resolved).startsWith('bscan-inventory-test-')) throw new Error('Unsafe inventory test cleanup');
      await rm(resolved, { recursive: true, force: true });
    }
  });
  it('does not relabel an unindexed canonical sale as an ordinary outgoing transfer', async () => {
    const provider = chain({ entries: logs.slice(0, 2), swapTx: h(2) }), selected = request(); selected.trades = selected.trades.slice(0, 1);
    const persist = vi.fn(async () => {});
    const result = await createKolTokenInventory({ rpc: provider.rpc, query, persist, directory: null })(selected);
    expect(result.coverage).toMatchObject({ complete: false, reconciled: false, status: 'pending', reason: 'unindexed_swap_pending' });
    expect(result.transfers.some(event => event.txHash === h(2))).toBe(false); expect(persist).not.toHaveBeenCalled();
  });
  it('keeps recognized unindexed swaps pending even when discovered through an indexed-ledger hint', async () => {
    const provider = chain({ entries: logs.slice(0, 2), swapTx: h(2) }), selected = request(); selected.trades = selected.trades.slice(0, 1);
    const rpc = async (method: string, params: any[], signal: AbortSignal) => {
      const value = await provider.rpc(method, params, signal);
      return method === 'eth_getLogs' && Array.isArray(value) ? value.filter(log => log.transactionHash !== h(2)) : value;
    };
    const result = await createKolTokenInventory({ rpc, persist: async () => {}, directory: null,
      query: async sql => ({ rows: sql.includes('FROM trades') ? [] : [{ txHash: h(2), blockNumber: '102' }] }) })(selected);
    expect(result.coverage).toMatchObject({ complete: false, reconciled: false, status: 'pending', reason: 'unindexed_swap_pending' });
  });
  it('requires a fresh captured indexed snapshot when swaps change during the scan', async () => {
    const provider = chain(), persist = vi.fn(async () => {});
    const result = await createKolTokenInventory({ rpc: provider.rpc, persist, directory: null,
      query: async sql => ({ rows: sql.includes('FROM trades') ? [{ txHash: h(1) }, { txHash: h(2) }, { txHash: h(4) }] : [] }) })(request());
    expect(result.coverage).toMatchObject({ complete: false, reconciled: false, status: 'pending', reason: 'indexed_snapshot_changed' });
    expect(persist).not.toHaveBeenCalled();
  });
  it('withholds current balance proof when the RPC confirmed endpoint is stale or future', async () => {
    for (const timestampOffset of [-3600, 3600]) {
      const provider = chain({ timestampOffset });
      const result = await createKolTokenInventory({ rpc: provider.rpc, query, persist: async () => {}, directory: null })(request());
      expect(result.coverage).toMatchObject({ complete: false, reconciled: false, status: 'unavailable', reason: 'confirmed_endpoint_stale', checkedAt: null });
    }
  });
});

describe('canonical transfer persistence', () => {
  it('locks against worker rollback before rechecking canonical evidence and inserting', async () => {
    const calls: string[] = [], query = vi.fn(async (sql: string) => { calls.push(sql); return { rows: [] }; });
    const release = vi.fn(); mocks.connect.mockResolvedValue({ query, release });
    const movement = { id: 'id', txHash: h(3), walletAddress: wallet, tokenAddress: token, deltaRaw: '-7', timestamp: '2026-10-12T00:00:00Z', blockNumber: '105', transactionIndex: 0, logIndex: 0, blockHash: h(105) };
    await persistCanonicalInventoryTransfers([movement], { height: 108, hash: h(108) }, async () => { calls.push('VERIFY'); }, new AbortController().signal);
    expect(calls.findIndex(sql => sql.includes('pg_advisory_xact_lock(782319)'))).toBeLessThan(calls.indexOf('VERIFY'));
    expect(calls.indexOf('VERIFY')).toBeLessThan(calls.findIndex(sql => sql.includes('INSERT INTO wallet_transfers')));
    expect(calls.at(-1)).toBe('COMMIT'); expect(release).toHaveBeenCalledOnce();
  });
  it('does not persist when the canonical endpoint changes under the lock', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] })); mocks.connect.mockResolvedValue({ query, release: vi.fn() });
    const movement = { id: 'id', txHash: h(3), walletAddress: wallet, tokenAddress: token, deltaRaw: '-7', timestamp: '2026-10-12T00:00:00Z', blockNumber: '105', transactionIndex: 0, logIndex: 0 };
    await expect(persistCanonicalInventoryTransfers([movement], { height: 108, hash: h(108) }, async () => { throw new Error('canonical_endpoint_changed'); }, new AbortController().signal)).rejects.toThrow('canonical_endpoint_changed');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO'))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
