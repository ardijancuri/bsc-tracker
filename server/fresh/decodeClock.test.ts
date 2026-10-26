import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { Rpc } from '../rpc.js';
import { userOperationTopic } from '../smartAccountTrades.js';
import { encodeFreshEvidence, FRESH_ENTRY_POINTS, type FreshCapturedReceipt } from './capture.js';
import { runFreshDecode } from './decode.js';
import { advanceFreshRollingKolTotals, refreshFreshRollingKolTotals } from './rolling.js';

const clock = vi.hoisted(() => ({ storedAsOf: 0, applied: [] as number[] }));
vi.mock('./accounting.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./accounting.js')>();
  return { ...actual, applyFreshFinancialEvents: vi.fn(async (_client, _events, options) => {
    const at = new Date(options.now).getTime();
    // Model a rolling refresh that committed while decoding waited for its lock.
    if (at < clock.storedAsOf) throw Error('rolling_clock_moved_backwards');
    clock.applied.push(at);
    return { inserted: 0, applied: 0 };
  }) };
});

const initial = Date.parse('2026-10-24T12:00:00.000Z');
const wallet = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40);
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');

function fixture(options: { blocks?: number; normalizationFailure?: boolean; repair?: boolean } = {}) {
  const rows = Array.from({ length: options.blocks ?? 1 }, (_, index) => {
    const number = 101 + index, entry: FreshCapturedReceipt = {
      transaction: { hash: hash(number + 1000), from: wallet, to: other, value: '0x0', blockNumber: '0x' + number.toString(16), blockHash: hash(number), transactionIndex: '0x0', gasPrice: '0x1' },
      receipt: { transactionHash: hash(number + 1000), blockNumber: '0x' + number.toString(16), blockHash: hash(number), transactionIndex: '0x0', status: '0x1', gasUsed: '0x1', logs: [] },
      wallets: [wallet], observedAt: new Date(initial).toISOString(),
      ...(options.repair ? { launchRepair: { version: 1 as const, kind: 'stockwave' as const, reason: 'factory_creation_code_unverified' as const } } : {}),
    };
    if (options.normalizationFailure) {
      entry.transaction.to = FRESH_ENTRY_POINTS[0];
      entry.receipt.logs.push({ address: FRESH_ENTRY_POINTS[0], topics: [userOperationTopic, hash(999), '0x' + wallet.slice(2).padStart(64, '0'), hash(0)],
        data: '0x', logIndex: '0x0', transactionHash: entry.transaction.hash, transactionIndex: '0x0', blockNumber: entry.transaction.blockNumber, blockHash: entry.transaction.blockHash });
    }
    return { tx_hash: entry.transaction.hash, block_hash: entry.transaction.blockHash, block_number: number, transaction_index: 0,
      occurred_at: new Date(initial - 60000), wallet_addresses: [wallet], payload: encodeFreshEvidence(entry) };
  });
  const queries: { sql: string; params: any[] }[] = [], lockTimes: number[] = [];
  const query = vi.fn(async (sql: string, params: any[] = []): Promise<any> => {
    queries.push({ sql, params });
    if (sql.includes('LEFT JOIN fresh.jobs j')) { vi.setSystemTime(initial + 10000); return { rows }; }
    if (sql === 'SELECT pg_advisory_xact_lock(73621941)') {
      await Promise.resolve(); const at = initial + 20000 * (lockTimes.length + 1);
      vi.setSystemTime(at); clock.storedAsOf = at; lockTimes.push(at); return { rows: [] };
    }
    if (sql.startsWith('SELECT value FROM fresh.checkpoints')) return { rows: [{ value: { startBlock: 100 } }] };
    if (sql.startsWith('SELECT block_number::text,block_hash,value FROM fresh.checkpoints')) return { rows: [{ block_number:'100',block_hash:hash(100),value:{startBlock:100,startHash:hash(100),startTime:new Date(initial-60000).toISOString()} }] };
    if (sql.startsWith('SELECT * FROM fresh.launch_facts')) return { rows: [] };
    // This non-token, no-log transaction has no authenticated creation or
    // completed boundary-code discovery. Model the new read-only classifier
    // explicitly so it cannot bypass the accounting-clock exercise below.
    if (sql.startsWith('SELECT status,block_number::text FROM fresh.launch_facts') || sql.startsWith('SELECT j.progress,s.block_number::text,s.block_hash')) return { rows: [] };
    if (sql.startsWith('SELECT block_hash FROM fresh.recent_blocks')) return { rows: [{ block_hash: rows.find(row => row.block_number === params[0])!.block_hash }] };
    if (sql.startsWith('SELECT wallet_addresses,payload')) { const row = rows.find(row => row.tx_hash === params[0])!; return { rows: [{ wallet_addresses: row.wallet_addresses, payload: row.payload }] }; }
    if (sql.startsWith('SELECT id FROM fresh.accounting_scopes') || sql.startsWith('SELECT progress FROM fresh.jobs')) return { rows: [] };
    if (sql.startsWith('SELECT min(block_number)')) return { rows: [{ first_pending: null }] };
    if (sql.startsWith('SELECT block_number FROM fresh.checkpoints')) return { rows: [{ block_number: 200 }] };
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || /^(UPDATE fresh\.recent_evidence|DELETE FROM fresh\.jobs|INSERT INTO fresh\.(jobs|checkpoints))/.test(sql)) return { rows: [], rowCount: 1 };
    throw Error('unexpected_test_query');
  });
  const client = { query, release: vi.fn() }, database = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  const rpc = vi.fn(async () => { throw Error('unexpected_test_rpc'); }) as unknown as Rpc;
  return { database, rpc, queries, lockTimes };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(initial); clock.storedAsOf = initial; clock.applied = []; });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('financial transaction clock coordination', () => {
  it('samples live decoder accounting time after a contended financial lock', async () => {
    const f = fixture();
    expect(await runFreshDecode(f.database, f.rpc)).toMatchObject({ receipts: 1, repair: 0, unsupported: 0 });
    expect(clock.applied).toEqual(f.lockTimes);
    expect(f.queries.find(q => q.sql.includes('LEFT JOIN fresh.jobs j'))!.params[0].getTime()).toBe(initial);
  });
  it('samples each block independently when another rolling update advances between block transactions', async () => {
    const f = fixture({ blocks: 2 });
    expect(await runFreshDecode(f.database, f.rpc)).toMatchObject({ receipts: 2 });
    expect(clock.applied).toEqual([initial + 20000, initial + 40000]);
  });
  it('preserves explicit controlled decoder time and still rejects a backwards accounting clock', async () => {
    const f = fixture();
    await expect(runFreshDecode(f.database, f.rpc, { now: new Date(initial) })).rejects.toThrow('rolling_clock_moved_backwards');
    expect(f.queries.some(q => q.sql === 'ROLLBACK')).toBe(true);
    expect(f.queries.some(q => q.sql === 'COMMIT')).toBe(false);
  });
  it.each([{ normalizationFailure: false, repair: true }, { normalizationFailure: true }])('dates repair provenance and due time after its financial lock: %j', async options => {
    const f = fixture(options);
    await runFreshDecode(f.database, f.rpc);
    const job = f.queries.find(q => q.sql.startsWith('INSERT INTO fresh.jobs'))!;
    expect(job.params[4].getTime()).toBe(f.lockTimes[0]);
    expect(job.params[2].getTime()).toBe(f.lockTimes[0] + 30000);
    expect(JSON.parse(job.params[5]).firstFailure.at).toBe(new Date(f.lockTimes[0]).toISOString());
  });
  it('samples default rolling maintenance time only after its financial lock', async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const client = { query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params }); if (sql.includes('pg_advisory_xact_lock(73621941)')) { await Promise.resolve(); vi.setSystemTime(initial + 20000); }
      return { rows: [] };
    }) } as unknown as PoolClient;
    expect(await refreshFreshRollingKolTotals(client)).toMatchObject({ asOf: new Date(initial + 20000).toISOString() });
    expect(queries[1].params[0]).toBe(new Date(initial + 20000).toISOString());
  });
  it('preserves an explicitly supplied rolling maintenance clock', async () => {
    const client = { query: vi.fn(async () => { vi.setSystemTime(initial + 20000); return { rows: [] }; }) } as unknown as PoolClient;
    expect(await refreshFreshRollingKolTotals(client, { now: new Date(initial) })).toMatchObject({ asOf: new Date(initial).toISOString() });
  });
  it('retains the real rolling guard against an explicitly backwards time', async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT id,kind,wallet_addresses')) return { rows: [{ id: 'kol:' + wallet, wallet_addresses: [wallet] }] };
      if (sql.startsWith('SELECT * FROM fresh.kols')) return { rows: [{ rolling_as_of: new Date(initial + 20000) }] };
      return { rows: [] };
    }) } as unknown as PoolClient;
    await expect(advanceFreshRollingKolTotals(client, wallet, initial)).rejects.toThrow('rolling_clock_moved_backwards');
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE fresh.kols'), expect.anything());
  });
});
