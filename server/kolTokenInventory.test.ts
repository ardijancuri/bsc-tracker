import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKolTokenInventory as createInventoryLoader, persistCanonicalInventoryTransfers, type KolTokenInventoryRequest } from './kolTokenInventory.js';
import { transferTopic } from './swap.js';
import { beforeExecutionTopic, userOperationTopic } from './smartAccountTrades.js';
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
const createKolTokenInventory = (options: Parameters<typeof createInventoryLoader>[0] = {}) => createInventoryLoader({
  now: () => (1_790_000_000 + 114) * 1000, requestTradeRepair: async () => {}, ...options });
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
  it('reserves a scanner for foreground work and releases background reservations after timeout', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new Error('Budget')), ms); return controller.signal;
    });
    const rpc = vi.fn(async () => new Promise(() => {}));
    try {
      const inventory = createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null, budgetMs: 100 });
      const selected = { ...request(), priority: 'background' as const };
      const first = inventory(selected), duplicate = inventory(selected), foregroundJoin = inventory(request());
      const otherBackground = { ...selected, wallet: '0x' + '4'.repeat(40) };
      const queued = inventory(otherBackground), queuedDuplicate = inventory(otherBackground);
      expect(rpc).toHaveBeenCalledOnce();
      const foreground = inventory({ ...request(), wallet: '0x' + '5'.repeat(40) });
      expect(rpc).toHaveBeenCalledTimes(2);
      expect((await inventory({ ...request(), wallet: '0x' + '6'.repeat(40) })).coverage.reason).toBe('scan_queued');
      await vi.advanceTimersByTimeAsync(100);
      const results = await Promise.all([first, duplicate, foregroundJoin, foreground]);
      expect(results[0]).toBe(results[1]); expect(results[0]).toBe(results[2]);
      expect(results.every(result => result.coverage.reason === 'scan_pending')).toBe(true);
      expect(rpc).toHaveBeenCalledTimes(3);
      // The three subscribers to the first job must not release extra slots or
      // start a retry ahead of the older queued card.
      const retried = inventory(selected);
      expect(rpc).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(100);
      const queuedResults = await Promise.all([queued, queuedDuplicate]);
      expect(queuedResults[0]).toBe(queuedResults[1]); expect(queuedResults[0].coverage.reason).toBe('scan_pending');
      expect(rpc).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(100);
      expect((await retried).coverage.reason).toBe('scan_pending');
    } finally { timeout.mockRestore(); }
  });
  it('releases the background reservation after a successful canonical scan', async () => {
    const provider = chain();
    const inventory = createKolTokenInventory({ rpc: provider.rpc, query, persist: async () => {}, directory: null });
    const selected = { ...request(), priority: 'background' as const };
    expect((await inventory(selected)).coverage.reconciled).toBe(true);
    provider.rpc.mockClear();
    expect((await inventory(selected)).coverage.reconciled).toBe(true);
    expect(provider.rpc).toHaveBeenCalled();
  });
  it('releases the background reservation after an RPC failure', async () => {
    const rpc = vi.fn(async () => { throw Error('offline'); });
    const inventory = createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null });
    const selected = { ...request(), priority: 'background' as const };
    expect((await inventory(selected)).coverage.reason).toBe('inventory_rpc_unavailable');
    expect((await inventory({ ...selected, wallet: '0x' + '4'.repeat(40) })).coverage.reason).toBe('inventory_rpc_unavailable');
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('bounds the background waiting queue and dispatches cards in arrival order without duplicate scans', async () => {
    const releases: ((value: string) => void)[] = [];
    const rpc = vi.fn(async () => new Promise<string>(resolve => { releases.push(resolve); }));
    const inventory = createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null });
    const selected = (index: number) => ({ ...request(), wallet: '0x' + index.toString(16).padStart(40, '0'), priority: 'background' as const });
    const completed: number[] = [];
    const active = inventory(selected(1)).then(value => { completed.push(1); return value; });
    const queued = Array.from({ length: 8 }, (_, index) => inventory(selected(index + 2)).then(value => { completed.push(index + 2); return value; }));
    const duplicate = inventory(selected(5));
    expect((await inventory(selected(10))).coverage).toMatchObject({ status: 'pending', reason: 'scan_queued' });
    expect(rpc).toHaveBeenCalledOnce();
    for (let index = 0; index < 9; index++) {
      // A head below the first trade ends each admitted job without extra RPC.
      releases[index]('0x1');
      if (index < 8) await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(index + 2));
    }
    const results = await Promise.all([active, ...queued]);
    expect(completed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]); expect(await duplicate).toBe(results[4]);
    expect(results.every(value => value.coverage.reason === 'confirmation_pending')).toBe(true);
  });
  it('starts a waiting background scan when either of two foreground scans releases capacity', async () => {
    const releases: ((value: string) => void)[] = [];
    const rpc = vi.fn(async () => new Promise<string>(resolve => { releases.push(resolve); }));
    const inventory = createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null });
    const first = inventory(request()), second = inventory({ ...request(), wallet: '0x' + '4'.repeat(40) });
    const queued = inventory({ ...request(), wallet: '0x' + '5'.repeat(40), priority: 'background' });
    expect(rpc).toHaveBeenCalledTimes(2);
    releases[1]('0x1'); expect((await second).coverage.reason).toBe('confirmation_pending');
    expect(rpc).toHaveBeenCalledTimes(3);
    releases[0]('0x1'); releases[2]('0x1');
    expect((await first).coverage.reason).toBe('confirmation_pending'); expect((await queued).coverage.reason).toBe('confirmation_pending');
  });
  it('promotes an opened queued card into the reserved foreground slot without duplicating its scan', async () => {
    const releases: ((value: string) => void)[] = [];
    const rpc = vi.fn(async () => new Promise<string>(resolve => { releases.push(resolve); }));
    const inventory = createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null });
    const first = inventory({ ...request(), priority: 'background' });
    const waiting = inventory({ ...request(), wallet: '0x' + '4'.repeat(40), priority: 'background' });
    const selected = { ...request(), wallet: '0x' + '5'.repeat(40) };
    const card = inventory({ ...selected, priority: 'background' });
    expect(rpc).toHaveBeenCalledOnce();
    const modal = inventory(selected), duplicate = inventory(selected);
    expect(rpc).toHaveBeenCalledTimes(2);
    releases[1]('0x1');
    const results = await Promise.all([card, modal, duplicate]);
    expect(results[0]).toBe(results[1]); expect(results[0]).toBe(results[2]);
    // Completing the promoted job does not release the running background job.
    expect(rpc).toHaveBeenCalledTimes(2);
    releases[0]('0x1'); await first; expect(rpc).toHaveBeenCalledTimes(3);
    releases[2]('0x1'); await waiting;
  });
  it('yields background backfills after a verified page while foreground scans finish the whole range', async () => {
    const provider = chain(), inventory = createKolTokenInventory({ rpc: provider.rpc, query, persist: async () => {}, directory: null, pageSize: 3 });
    const background = { ...request(), priority: 'background' as const };
    expect((await inventory(background)).coverage).toMatchObject({ complete: false, reconciled: false, reason: 'scan_pending', scannedThroughBlock: '102' });
    expect((await inventory(background)).coverage).toMatchObject({ complete: false, reconciled: false, reason: 'scan_pending', scannedThroughBlock: '105' });
    expect((await inventory(background)).coverage).toMatchObject({ complete: true, reconciled: true, scannedThroughBlock: '108' });
    expect(provider.rpc.mock.calls.filter(([method, params]) => method === 'eth_getLogs' && params[0].fromBlock === hex(100))).toHaveLength(2);
    const foreground = createKolTokenInventory({ rpc: provider.rpc, query, persist: async () => {}, directory: null, pageSize: 3 });
    expect((await foreground(request())).coverage).toMatchObject({ complete: true, reconciled: true, scannedThroughBlock: '108' });
  });
  it('recovers the configured page size after pairs of successful canonical pages', async () => {
    const provider = chain(); provider.advanceHead(30_000);
    let maximum = 512;
    const rpc = vi.fn(async (method: string, params: any[], signal: AbortSignal) => {
      if (method === 'eth_getLogs' && Number(BigInt(params[0].toBlock)) - Number(BigInt(params[0].fromBlock)) + 1 > maximum) throw Error('Temporary RPC limit');
      return provider.rpc(method, params, signal);
    });
    const inventory = createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null, pageSize: 4096,
      now: () => (1_790_000_000 + 30_000) * 1000 });
    const selected = { ...request(), priority: 'background' as const };
    expect((await inventory(selected)).coverage).toMatchObject({ reason: 'scan_pending', scannedThroughBlock: '611' });
    maximum = Infinity;
    for (const expectedSize of [512, 1024, 1024, 2048, 2048, 4096, 4096, 4096]) {
      rpc.mockClear(); expect((await inventory(selected)).coverage.reason).toBe('scan_pending');
      const windows = rpc.mock.calls.filter(([method]) => method === 'eth_getLogs')
        .map(([, params]) => Number(BigInt(params[0].toBlock)) - Number(BigInt(params[0].fromBlock)) + 1);
      expect(windows).toEqual([expectedSize, expectedSize]);
    }
  });
  it('resets the successful-page streak whenever the RPC window backs off', async () => {
    const provider = chain(); provider.advanceHead(30_000);
    let maximum = 512;
    const rpc = vi.fn(async (method: string, params: any[], signal: AbortSignal) => {
      if (method === 'eth_getLogs' && Number(BigInt(params[0].toBlock)) - Number(BigInt(params[0].fromBlock)) + 1 > maximum) throw Error('Temporary RPC limit');
      return provider.rpc(method, params, signal);
    });
    const inventory = createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null, pageSize: 4096,
      now: () => (1_790_000_000 + 30_000) * 1000 });
    const selected = { ...request(), priority: 'background' as const };
    await inventory(selected); maximum = Infinity;
    await inventory(selected); await inventory(selected); // 512 -> 1024, then one success at 1024.
    maximum = 512; await inventory(selected); // Backoff must clear that earlier success.
    maximum = Infinity; rpc.mockClear(); await inventory(selected);
    const windows = rpc.mock.calls.filter(([method]) => method === 'eth_getLogs')
      .map(([, params]) => Number(BigInt(params[0].toBlock)) - Number(BigInt(params[0].fromBlock)) + 1);
    expect(windows).toEqual([512, 512]);
    rpc.mockClear(); await inventory(selected);
    expect(rpc.mock.calls.filter(([method]) => method === 'eth_getLogs')
      .map(([, params]) => Number(BigInt(params[0].toBlock)) - Number(BigInt(params[0].fromBlock)) + 1)).toEqual([1024, 1024]);
  });
  it.each([false, true])('resumes cached small pages with legacy=%s and grows only after two verified successes', async legacy => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bscan-inventory-test-'));
    const provider = chain(); provider.advanceHead(30_000);
    let maximum = 512;
    const rpc = vi.fn(async (method: string, params: any[], signal: AbortSignal) => {
      if (method === 'eth_getLogs' && Number(BigInt(params[0].toBlock)) - Number(BigInt(params[0].fromBlock)) + 1 > maximum) throw Error('Temporary RPC limit');
      return provider.rpc(method, params, signal);
    });
    const options = { rpc, query, persist: async () => {}, directory, pageSize: 4096, now: () => (1_790_000_000 + 30_000) * 1000 };
    const selected = { ...request(), priority: 'background' as const }, file = path.join(directory, `${wallet}-${token}-100.json`);
    try {
      await createKolTokenInventory(options)(selected);
      const cached = JSON.parse(await readFile(file, 'utf8'));
      expect(cached.state).toMatchObject({ pageSize: 512, successfulPages: 1, scanned: 611 });
      if (legacy) {
        delete cached.state.successfulPages;
        cached.checksum = createHash('sha256').update(JSON.stringify(cached.state)).digest('hex'); await writeFile(file, JSON.stringify(cached));
      }
      maximum = Infinity;
      const resumed = createKolTokenInventory(options);
      expect((await resumed(selected)).coverage.scannedThroughBlock).toBe('1123');
      expect(JSON.parse(await readFile(file, 'utf8')).state.pageSize).toBe(legacy ? 512 : 1024);
      await resumed(selected);
      expect(JSON.parse(await readFile(file, 'utf8')).state.pageSize).toBe(1024);
    } finally {
      const resolved = path.resolve(directory), intended = path.resolve(tmpdir()) + path.sep;
      if (!resolved.startsWith(intended) || !path.basename(resolved).startsWith('bscan-inventory-test-')) throw new Error('Unsafe inventory test cleanup');
      await rm(resolved, { recursive: true, force: true });
    }
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
  it('requests a bounded repair for a confirmed missing sale and waits for the refreshed indexed history', async () => {
    const provider = chain({ entries: logs.slice(0, 2), swapTx: h(2) }), selected = request(); selected.trades = selected.trades.slice(0, 1);
    const requestTradeRepair = vi.fn(async () => {});
    const inventory = createKolTokenInventory({ rpc: provider.rpc, query, persist: async () => {}, directory: null, requestTradeRepair });
    expect((await inventory(selected)).coverage.reason).toBe('unindexed_swap_pending');
    expect(requestTradeRepair).toHaveBeenCalledWith({ txHash: h(2), walletAddress: wallet, tokenAddress: token, blockNumber: '102', blockHash: h(102) });
    expect((await inventory(request())).coverage).toMatchObject({ complete: true, reconciled: true, balance: '7' });
  });
  it.each([true, false])('queues only an authenticated successful account-abstraction sale, authentic=%s', async authentic => {
    const provider = chain({ entries: logs.slice(0, 2), swapTx: h(2) }), selected = request(); selected.trades = selected.trades.slice(0, 1);
    const entryPoint = '0x0000000071727de22e5e9d8baf0edac6f37da032';
    const requestTradeRepair = vi.fn(async () => {});
    const rpc = async (method: string, params: any[], signal: AbortSignal) => {
      const result: any = await provider.rpc(method, params, signal);
      if (params[0] !== h(2)) return result;
      if (method === 'eth_getTransactionByHash') return { ...result, from: other, to: entryPoint };
      if (method === 'eth_getTransactionReceipt') return { ...result, logs: [
        { address: entryPoint, topics: [beforeExecutionTopic], data: '0x' }, ...result.logs,
        { address: authentic ? entryPoint : other, topics: [userOperationTopic, h(9), addressTopic(wallet), addressTopic('0x' + '0'.repeat(40))],
          data: '0x' + [0, 1, 1, 1].map(value => value.toString(16).padStart(64, '0')).join('') },
      ] };
      return result;
    };
    const result = await createKolTokenInventory({ rpc, query, persist: async () => {}, directory: null, requestTradeRepair })(selected);
    expect(result.coverage.reason).toBe('unindexed_swap_pending');
    expect(requestTradeRepair).toHaveBeenCalledTimes(authentic ? 1 : 0);
  });
  it('does not publish partial profit if the missing-trade repair queue is unavailable', async () => {
    const provider = chain({ entries: logs.slice(0, 2), swapTx: h(2) }), selected = request(); selected.trades = selected.trades.slice(0, 1);
    const result = await createKolTokenInventory({ rpc: provider.rpc, query, persist: async () => {}, directory: null,
      requestTradeRepair: async () => { throw Error('queue unavailable'); } })(selected);
    expect(result.coverage).toMatchObject({ complete: false, reconciled: false, reason: 'unindexed_swap_pending' });
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
