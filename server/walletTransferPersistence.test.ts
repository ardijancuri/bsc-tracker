import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { recordWalletTransfers } from './intelligenceWorker.js';

vi.mock('./db.js', () => ({
  pool: { query: vi.fn(() => { throw new Error('Unexpected query outside repair transaction'); }) },
  notifyUpdate: vi.fn(), setState: vi.fn(),
}));

const { tx, receipt, wallet, token, block } = JSON.parse(readFileSync(new URL('./fixtures/smartAccountSale.json', import.meta.url), 'utf8'));

describe('wallet transfer persistence inside a repair transaction', () => {
  it('keeps raw transfers before any indexed purchase without inventing metadata', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
    const from = `0x${'9'.repeat(40)}`, to = wallet, address = `0x${'8'.repeat(40)}`;
    const log = { address, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      `0x${from.slice(2).padStart(64, '0')}`, `0x${to.slice(2).padStart(64, '0')}`], data: `0x${'7'.padStart(64, '0')}`, logIndex: '0x4', transactionHash: tx.hash };
    await recordWalletTransfers({ hash: tx.hash, from }, { status: '0x1', logs: [log] }, block, new Set([to]), { query } as unknown as Pick<PoolClient, 'query'>);
    const tokenWrite = query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO tokens'));
    expect(tokenWrite?.[0]).not.toContain('decimals'); expect(tokenWrite?.[1]).toEqual([[address]]);
    const transferWrite = query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO wallet_transfers'));
    expect(transferWrite?.[1]?.slice(3, 7)).toEqual([to, address, '7', 'transfer']);
    expect(transferWrite?.[1]?.[10]).toBe(from);
  });
  it('reads the newly inserted trade and records each transfer through the supplied client', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT address')) return { rows: [{ address: token }] };
      if (sql.startsWith('SELECT wallet_address')) return { rows: [{ wallet_address: wallet, token_address: token, side: 'sell' }] };
      return { rows: [] };
    });
    await recordWalletTransfers(tx, receipt, block, new Set([wallet]), { query } as unknown as Pick<PoolClient, 'query'>);
    const writes = query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO wallet_transfers'));
    expect(writes.length).toBe(2);
    for (const call of writes) {
      const values = (call as unknown as [string, unknown[]])[1];
      expect(values[3]).toBe(wallet);
      expect(values[4]).toBe(token);
      expect(values[6]).toBe('sell');
    }
  });

  it('propagates a transfer write failure so the caller can roll back the entire repair', async () => {
    const failure = new Error('Transfer insert failed');
    let writes = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT address')) return { rows: [{ address: token }] };
      if (sql.startsWith('SELECT wallet_address')) return { rows: [{ wallet_address: wallet, token_address: token, side: 'sell' }] };
      if (++writes === 2) throw failure;
      return { rows: [] };
    });
    await expect(recordWalletTransfers(tx, receipt, block, new Set([wallet]), { query } as unknown as Pick<PoolClient, 'query'>))
      .rejects.toBe(failure);
    expect(writes).toBe(2);
  });
});
