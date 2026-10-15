import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordWalletTransfers } from './intelligenceWorker.js';
const query = vi.hoisted(() => vi.fn());
vi.mock('./db.js', () => ({ pool: { query }, notifyUpdate: vi.fn(), setState: vi.fn() }));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/smartAccountSale.json', import.meta.url), 'utf8'));
afterEach(() => vi.resetAllMocks());

describe('smart-account inventory classification', () => {
  it('records the authenticated AA token debits as the indexed sale and repairs old transfer classifications', async () => {
    query.mockResolvedValueOnce({ rows: [{ address: fixture.token }] })
      .mockResolvedValueOnce({ rows: [{ wallet_address: fixture.wallet, token_address: fixture.token, side: 'sell' }] })
      .mockResolvedValue({ rows: [] });
    await recordWalletTransfers(fixture.tx, fixture.receipt, fixture.block, new Set([fixture.wallet]));
    const writes = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO wallet_transfers'));
    expect(writes).toHaveLength(2);
    expect(writes.every(([, values]) => values[6] === 'sell')).toBe(true);
    expect(writes.reduce((total, [, values]) => total + BigInt(values[5]), 0n)).toBe(-7756869718250679382671672n);
    expect(writes[0][0]).toContain('ON CONFLICT(id) DO UPDATE SET kind=EXCLUDED.kind');
    expect(writes[0][0]).toContain('wallet_transfers.block_hash=EXCLUDED.block_hash');
  });
  it('keeps token movements as transfers if no authenticated wallet operation exists', async () => {
    query.mockResolvedValueOnce({ rows: [{ address: fixture.token }] })
      .mockResolvedValueOnce({ rows: [{ wallet_address: fixture.wallet, token_address: fixture.token, side: 'sell' }] })
      .mockResolvedValue({ rows: [] });
    const receipt = structuredClone(fixture.receipt); receipt.logs.at(-1).address = '0x' + '3'.repeat(40);
    await recordWalletTransfers(fixture.tx, receipt, fixture.block, new Set([fixture.wallet]));
    const writes = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO wallet_transfers'));
    expect(writes).toHaveLength(2); expect(writes.every(([, values]) => values[6] === 'transfer')).toBe(true);
  });
});
