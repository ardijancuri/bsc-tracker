import { describe, expect, it, vi } from 'vitest';
import { createKolTokenTradeRepairQueue, type KolTokenTradeRepairHint, type KolTokenTradeRepairJob } from './kolTokenTradeRepair.js';

vi.mock('./db.js', () => ({ pool: { connect: vi.fn() } }));
const time = Date.parse('2026-10-15T18:00:00Z');
const h = (digit: string) => '0x' + digit.repeat(64), a = (digit: string) => '0x' + digit.repeat(40);
const hint: KolTokenTradeRepairHint = { txHash: h('1'), walletAddress: a('2'), tokenAddress: a('3'), blockNumber: '100', blockHash: h('4') };
const key = (value = hint) => `kol_token_trade_repair:${value.txHash}:${value.walletAddress}:${value.tokenAddress}`;
const record = (extra = {}) => ({ ...hint, version: 1, attempts: 0, nextAttemptAt: time, requestedAt: time, leaseId: null, ...extra });
function fixture(handler: (sql: string, values: unknown[]) => any[] = () => []) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => ({ rows: handler(sql, values) }));
  const release = vi.fn(), connect = vi.fn(async () => ({ query, release }));
  return { query, release, connect, queue: createKolTokenTradeRepairQueue({ connect, now: () => time }) };
}

describe('bounded confirmed trade repair queue', () => {
  it('rejects malformed hints without connecting and bounds admission before insert', async () => {
    const invalid = fixture();
    await invalid.queue.request({ ...hint, txHash: 'not-a-hash' });
    expect(invalid.connect).not.toHaveBeenCalled();
    const full = fixture(sql => sql.startsWith('SELECT COUNT') ? [{ count: 128 }] : []);
    await full.queue.request(hint);
    expect(full.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
    const calls = full.query.mock.calls.map(([sql]) => sql);
    expect(calls.indexOf('SELECT pg_advisory_xact_lock(782323)')).toBeLessThan(calls.findIndex(sql => sql.startsWith('SELECT COUNT')));
    expect(full.release).toHaveBeenCalledOnce();
  });

  it('enqueues a tracked wallet hint and deduplicates repeated profile polls without resetting cooldown', async () => {
    const admitted = fixture(sql => sql.startsWith('SELECT COUNT') ? [{ count: 0 }] : []);
    await admitted.queue.request(hint);
    const insert = admitted.query.mock.calls.find(([sql]) => sql.startsWith('INSERT'))!;
    expect(insert[0]).toContain('WHERE EXISTS(SELECT 1 FROM kols k WHERE k.address=$3 AND (k.is_tracked');
    expect(insert[0]).toContain('EXISTS(SELECT 1 FROM journal_wallets m WHERE m.wallet_address=k.address)');
    expect(JSON.parse(insert[1]![1] as string)).toEqual(record());
    expect(insert[1]![2]).toBe(hint.walletAddress);
    const existing = fixture(sql => sql.startsWith('SELECT value') ? [{ value: record({ attempts: 8, nextAttemptAt: time + 3_600_000 }) }] : []);
    await existing.queue.request(hint);
    expect(existing.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
  });

  it('claims only due jobs, validates records and leases at most the requested batch', async () => {
    const other = { ...hint, txHash: h('5') };
    const { queue, query } = fixture(sql => sql.startsWith('SELECT key,value') ? [
      { key: key(), value: record({ nextAttemptAt: time + 1000 }) },
      { key: key(other), value: record({ ...other, attempts: 2 }) },
      { key: key({ ...hint, txHash: h('6') }), value: record({ txHash: 'invalid' }) },
    ] : []);
    const jobs = await queue.claim(1);
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ ...other, attempts: 3 });
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))!;
    const value = JSON.parse(update[1]![1] as string);
    expect(value).toMatchObject({ ...other, attempts: 3, nextAttemptAt: time + 120_000, leaseId: jobs[0].leaseId });
    expect(query.mock.calls.some(([sql]) => sql.includes('FOR UPDATE SKIP LOCKED'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(true);
    expect(await queue.claim(50)).toEqual([]);
  });

  it('uses lease ownership for completion and backs off failures instead of retrying every profile poll', async () => {
    const { queue, query } = fixture();
    const job: KolTokenTradeRepairJob = { ...hint, key: key(), leaseId: 'owner-1', attempts: 2 };
    await queue.finish(job, false);
    const retry = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))!;
    expect(retry[0]).toContain("value->>'leaseId'=$2");
    expect(retry[1]).toEqual([key(), 'owner-1', String(time + 20_000)]);
    query.mockClear(); await queue.finish({ ...job, attempts: 8 }, false);
    expect(query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))![1]![2]).toBe(String(time + 3_600_000));
    query.mockClear(); await queue.finish(job, true);
    expect(query.mock.calls.find(([sql]) => sql.startsWith('DELETE'))).toEqual([
      "DELETE FROM worker_state WHERE key=$1 AND value->>'leaseId'=$2", [key(), 'owner-1'],
    ]);
  });

  it('rolls back and releases the connection when admission fails', async () => {
    const { queue, query, release } = fixture(sql => { if (sql.startsWith('SELECT value')) throw Error('database unavailable'); return []; });
    await expect(queue.request(hint)).rejects.toThrow('database unavailable');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(release).toHaveBeenCalledOnce();
  });
});
