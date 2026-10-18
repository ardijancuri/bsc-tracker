import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { initializeJournalCollectionBoundary, monitoredWallets, nextJournalCollectionRepair, recordJournalCollectionRange, rollbackJournalCollection, validateCollectedReceipt } from './journalCollection.js';
const hash = `0x${'a'.repeat(64)}`, blockHash = `0x${'b'.repeat(64)}`;
const tx = { hash, blockNumber: '0x64', blockHash, transactionIndex: '0x0' };
const receipt = { transactionHash: hash, blockNumber: '0x64', blockHash, status: '0x1', logs: [] };
function database(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows }));
  return { query, db: { query } as unknown as Pick<PoolClient, 'query'> };
}
describe('private journal collection boundaries', () => {
  it('deduplicates public and private monitored wallets without changing roster flags', async () => {
    const { query, db } = database([{ address: '0xAbC' }, { address: '0xabc' }]);
    expect(await monitoredWallets(db)).toEqual(new Set(['0xabc']));
    expect(query.mock.calls[0][0]).toContain('WHERE is_tracked'); expect(query.mock.calls[0][0]).toContain('UNION SELECT DISTINCT wallet_address');
    expect(query.mock.calls[0][0]).not.toMatch(/UPDATE|INSERT/);
  });
  it('advances coverage only for wallets captured before the range began', async () => {
    const { query, db } = database();
    await recordJournalCollectionRange(db, new Set(['wallet-a']), 100, 120);
    expect(query.mock.calls[0][1]).toEqual([['wallet-a'], 100, 120, false, null]);
    expect(query.mock.calls[0][0]).toContain('c.wallet_address=ANY($1::text[])');
  });
  it('initializes subscriptions created before the first node checkpoint', async () => {
    const { query, db } = database();
    await initializeJournalCollectionBoundary(db, new Set(['wallet-a']), { number: 99, hash: blockHash });
    expect(query.mock.calls).toHaveLength(2);
    expect(query.mock.calls[0][1]).toEqual([['wallet-a'], 99, blockHash, null]);
    expect(query.mock.calls[0][0]).toContain('c.registration_block IS NULL');
    expect(query.mock.calls[1][0]).toContain('registration_block IS NULL');
  });
  it('binds a collected range to its original subscription generation', async () => {
    const { query, db } = database();
    await recordJournalCollectionRange(db, new Set(['wallet-a']), 100, 120, false, new Map([['wallet-a', 'generation-before-readd']]));
    expect(query.mock.calls[0][1]?.[4]).toBe('{"wallet-a":"generation-before-readd"}');
    expect(query.mock.calls[0][0]).toContain('c.generation::text=($5::jsonb->>c.wallet_address)');
  });
  it('retains a resumable registration repair cursor and bounds each repair', async () => {
    const { db } = database([{ wallet_address: 'a', repair_from_block: '100' }]);
    expect(await nextJournalCollectionRepair(db, 1000)).toEqual({ wallet: 'a', from: 100, to: 611 });
    expect(await nextJournalCollectionRepair(db, 150)).toEqual({ wallet: 'a', from: 100, to: 150 });
  });
  it('only considers repairs with an active subscriber', async () => {
    const { query, db } = database();
    expect(await nextJournalCollectionRepair(db, 100)).toBeNull();
    expect(query.mock.calls[0][0]).toContain('EXISTS(SELECT 1 FROM journal_wallets');
  });
  it('invalidates valuation proofs, snapshots and orphaned durable receipts on reorg', async () => {
    const { query, db } = database(); await rollbackJournalCollection(db, 100);
    const statements = query.mock.calls.map(call => call[0]);
    expect(statements.some(sql => sql.includes('DELETE FROM journal_node_evidence'))).toBe(true);
    expect(statements.some(sql => sql.includes("reason='chain_reorganization'"))).toBe(true);
    expect(statements.some(sql => sql.includes('DELETE FROM journal_snapshots'))).toBe(true);
    expect(statements.some(sql => sql.includes('repair_from_block=LEAST'))).toBe(true);
    expect(statements.some(sql => sql.includes('UPDATE journal_wallets SET registration_hash') && sql.includes('revision=md5') && sql.includes('registration_block=LEAST'))).toBe(true);
  });
  it('fails an incomplete range when a receipt or transaction is missing', () => {
    expect(() => validateCollectedReceipt(hash, tx, null, 100, 101)).toThrow('incomplete');
    expect(() => validateCollectedReceipt(hash, null, receipt, 100, 101)).toThrow('incomplete');
  });
  it('validates transaction identity, requested height, receipt hash and logs', () => {
    expect(validateCollectedReceipt(hash, tx, receipt, 100, 101)).toBe(100);
    expect(() => validateCollectedReceipt(`0x${'c'.repeat(64)}`, tx, receipt, 100, 101)).toThrow('identity');
    expect(() => validateCollectedReceipt(hash, tx, receipt, 101, 102)).toThrow('number');
    expect(() => validateCollectedReceipt(hash, tx, { ...receipt, blockHash: `0x${'d'.repeat(64)}` }, 100, 101)).toThrow('hash');
    expect(() => validateCollectedReceipt(hash, tx, { ...receipt, logs: [{ transactionHash: hash, blockNumber: '0x63' }] }, 100, 101)).toThrow('canonical');
    expect(() => validateCollectedReceipt(hash, tx, { ...receipt, logs: [{ removed: true }] }, 100, 101)).toThrow('canonical');
  });
  it('recognizes a proved failed transaction without silently accepting malformed statuses', () => {
    expect(validateCollectedReceipt(hash, tx, { ...receipt, status: '0x0' }, 100, 101)).toBe(100);
    expect(() => validateCollectedReceipt(hash, tx, { ...receipt, status: '' }, 100, 101)).toThrow('status');
  });
});
