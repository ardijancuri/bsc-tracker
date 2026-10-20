import { describe, expect, it, vi } from 'vitest';
import { enqueuePublicNodeAccountingPairs, runNodeAccountingWorkers, type NodeAccountingTickResult } from './nodeAccountingQueue.js';

const wallet = `0x${'a'.repeat(40)}`, token = `0x${'b'.repeat(40)}`;
const result = (claimed = 1): NodeAccountingTickResult => ({ claimed, active: 0, updated: claimed, completed: claimed, wallets: claimed ? [wallet] : [] });

describe('durable public accounting requests', () => {
  it('deduplicates normalized pairs, excludes quote assets and caps live priority below visible work', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
    await enqueuePublicNodeAccountingPairs({ query } as any, [
      { wallet, token, priority: 0, throughBlock: '200' }, { wallet: wallet.toUpperCase(), token: token.toUpperCase(), priority: 100, throughBlock: '100' },
      { wallet, token: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', priority: 5 },
      { wallet: 'invalid', token, priority: 5 },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.parse(query.mock.calls[0][1]![0] as string)).toEqual([{ wallet, token, priority: 5, throughBlock: '200' }]);
    const update = query.mock.calls[0][0].split('DO UPDATE SET')[1];
    expect(update).toContain('GREATEST(node_accounting_jobs.priority,EXCLUDED.priority)');
    expect(update).not.toMatch(/lease_|next_attempt_at|requested_at/);
  });
  it('does no database work for empty or excluded requests', async () => {
    const query = vi.fn();
    await enqueuePublicNodeAccountingPairs({ query } as any, []);
    await enqueuePublicNodeAccountingPairs({ query } as any, [{ wallet, token: 'invalid', priority: 5 }]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('independent accounting drain slots', () => {
  it('continues later jobs while one slow pair remains active and never exceeds four slots', async () => {
    const controller = new AbortController();
    let releaseSlow!: () => void, active = 0, maximum = 0, started = 0;
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    const tick = vi.fn(async (limit: number) => {
      expect(limit).toBe(1);
      const index = ++started;
      maximum = Math.max(maximum, ++active);
      if (index === 1) await slow;
      else await Promise.resolve();
      active--;
      if (index === 12) controller.abort();
      return result();
    });
    const progress = vi.fn();
    const running = runNodeAccountingWorkers({ tick, onProgress: progress, signal: controller.signal });
    await vi.waitFor(() => expect(started).toBeGreaterThanOrEqual(12));
    expect(active).toBe(1);
    expect(maximum).toBe(4);
    expect(progress).toHaveBeenCalled();
    releaseSlow(); await running;
    expect(active).toBe(0);
  });
  it('backs off an empty or failing slot without holding successful slots', async () => {
    const controller = new AbortController(), calls: number[] = [];
    let attempts = 0;
    const tick = vi.fn(async () => {
      if (++attempts === 1) throw new Error('database_retry');
      return result(0);
    });
    const errors = vi.fn();
    await runNodeAccountingWorkers({ tick, signal: controller.signal, onError: errors,
      pause: async milliseconds => { calls.push(milliseconds); controller.abort(); } });
    expect(errors).toHaveBeenCalledOnce();
    expect(calls).toEqual([1000, 1000, 1000, 1000]);
  });
});
