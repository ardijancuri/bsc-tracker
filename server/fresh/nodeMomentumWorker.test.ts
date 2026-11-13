import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Rpc } from '../rpc.js';
import type { FreshCaptureProgress } from './capture.js';
import { createNodeMomentumWorker } from './nodeMomentumWorker.js';
import type { MomentumScanResult } from './nodeMomentumIngest.js';

const epoch = Date.parse('2026-11-13T12:00:01Z');
const hash = (number: number) => '0x' + number.toString(16).padStart(64, '0');
const header = (number: number) => ({
  block_number: String(number), block_hash: hash(number), parent_hash: hash(number - 1),
  occurred_at: new Date(epoch + (number - 100) * 1000),
});

function fixture() {
  let tip = 100, lagBlocks = 0, cursorOk = true, observed = true, isCurrent = true;
  const now = () => header(tip).occurred_at.getTime();
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.includes('AS cursor_ok')) return {
      rows: [{ block_number: String(tip), block_hash: hash(tip), revision: '1', cursor_ok: cursorOk }],
    };
    if (sql.includes('WHERE block_number>$1')) {
      const previous = Number(args?.[0]), last = Number(args?.[1]);
      return { rows: Array.from({ length: last - previous }, (_, index) => header(previous + index + 1)) };
    }
    if (sql.includes('SELECT block_number,block_hash,parent_hash')) return { rows: [header(tip)] };
    if (sql.includes('SELECT 1 FROM fresh.recent_blocks')) return { rowCount: isCurrent ? 1 : 0 };
    if (sql.includes('INSERT INTO fresh.checkpoints')) return { rowCount: 1 };
    throw Error('Unexpected query');
  });
  const stats = {
    logs: 0, emitters: 0, decoded: 0, identitiesAttempted: 0, identitiesVerified: 0,
    pendingIdentities: 0, coveredPools: 0, unpricedPools: 0, quoteBlocksRead: 0,
  };
  const scan = vi.fn<ReturnType<typeof import('./nodeMomentumIngest.js').createNodeMomentumIngest>['scan']>()
    .mockResolvedValue({ observations: [], coveredPools: [], stats } satisfies MomentumScanResult);
  const ingest = { scan, clear: vi.fn() };
  const db = { query } as unknown as Pool;
  const run = createNodeMomentumWorker(db, vi.fn() as unknown as Rpc, now, ingest);
  const capture = (): FreshCaptureProgress => ({
    checkedAt: now() - (observed ? 0 : 30_000), nodeHead: tip + lagBlocks + 6,
    capturedBlock: tip, confirmedHeadBlock: tip + lagBlocks, lagBlocks,
  });
  return { query, ingest, scan, run, capture, setTip: (v: number) => { tip = v; },
    setLag: (v: number) => { lagBlocks = v; }, setCursorOk: (v: boolean) => { cursorOk = v; },
    setObserved: (v: boolean) => { observed = v; }, setCanonical: (v: boolean) => { isCurrent = v; } };
}

describe('node momentum worker', () => {
  it('yields with stale capture health, backlog or shutdown before any worker database or RPC work', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.setLag(17);
    expect(await f.run(f.capture, controller.signal)).toMatchObject({ reason: 'capture_priority' });
    f.setLag(0);
    f.setObserved(false);
    expect(await f.run(f.capture, controller.signal)).toMatchObject({ reason: 'capture_priority' });
    f.setObserved(true);
    controller.abort();
    expect(await f.run(f.capture, controller.signal)).toMatchObject({ reason: 'capture_priority' });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.scan).not.toHaveBeenCalled();
  });

  it('warms from capture, scans at most 32 blocks and skips repeated snapshot writes within one minute', async () => {
    const f = fixture(), { signal } = new AbortController();
    expect(await f.run(f.capture, signal)).toMatchObject({ reason: 'warming_up', block: 100 });
    expect(f.scan).not.toHaveBeenCalled();
    f.setTip(139);
    expect(await f.run(f.capture, signal)).toMatchObject({ block: 132, blocks: 32, published: true });
    expect(f.scan.mock.calls[0][0][0]).toMatchObject({ number: 101, hash: hash(101) });
    expect(f.scan.mock.calls[0][0].at(-1)).toMatchObject({ number: 132, hash: hash(132) });
    expect(f.scan.mock.calls[0][1]?.parentHash).toBe(hash(100));
    expect(await f.run(f.capture, signal)).toMatchObject({ block: 139, blocks: 7, published: false });
    expect(f.scan.mock.calls[1][1]?.parentHash).toBe(hash(132));
    expect(f.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO fresh.checkpoints'))).toHaveLength(1);
  });

  it('discards orphaned RPC results and resets after the committed capture cursor reorgs', async () => {
    const f = fixture(), { signal } = new AbortController();
    await f.run(f.capture, signal);
    f.setTip(104);
    f.setCanonical(false);
    expect(await f.run(f.capture, signal)).toMatchObject({ reason: 'capture_headers_changed' });
    f.setCanonical(true);
    expect(await f.run(f.capture, signal)).toMatchObject({ blocks: 4, published: true });
    f.setCursorOk(false);
    f.setTip(103);
    expect(await f.run(f.capture, signal)).toMatchObject({ reason: 'warming_up', block: 103 });
    expect(f.ingest.clear).toHaveBeenCalledTimes(3);
  });

  it('keeps the range pending when capture asks it to yield during a scan', async () => {
    const f = fixture(), { signal } = new AbortController();
    await f.run(f.capture, signal);
    f.setTip(104);
    f.scan.mockRejectedValueOnce(Error('momentum_scan_yielded'));
    expect(await f.run(f.capture, signal)).toMatchObject({ reason: 'capture_priority' });
    expect(await f.run(f.capture, signal)).toMatchObject({ blocks: 4 });
  });

  it('shrinks an exhausted scan budget without advancing the cursor and restores the range gradually', async () => {
    const f = fixture(), { signal } = new AbortController();
    await f.run(f.capture, signal);
    f.setTip(132);
    f.scan.mockRejectedValueOnce(Error('momentum_scan_log_total_budget'));
    expect(await f.run(f.capture, signal)).toEqual({ yielded: true, reason: 'log_range_budget', retryBlocks: 16 });
    expect(f.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO fresh.checkpoints'))).toBe(false);
    expect(await f.run(f.capture, signal)).toMatchObject({ blocks: 16, block: 116 });
    expect(f.scan.mock.calls[1][0][0].number).toBe(101);
    f.setTip(148);
    expect(await f.run(f.capture, signal)).toMatchObject({ blocks: 32, block: 148 });
  });
});
