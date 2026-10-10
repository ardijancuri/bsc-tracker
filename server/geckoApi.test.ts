import { describe, expect, it } from 'vitest';
import { createGeckoQueue, MarketProviderDeferred, providerRetryMs, reserveGeckoSlot, type GeckoPriority } from './geckoApi.js';

describe('shared market provider budget', () => {
  it('honours both Retry-After formats and bounds missing or excessive delays', () => {
    expect(providerRetryMs('120')).toBe(120_000);
    expect(providerRetryMs('6000')).toBe(600_000);
    expect(providerRetryMs(new Date(120_000).toUTCString(), 60_000)).toBe(60_000);
    for (const value of [null, 'invalid', '-1', '0']) expect(providerRetryMs(value)).toBe(60_000);
  });
  it('does not let optional metadata reserve queued slots or ignore shared pauses', async () => {
    await expect(reserveGeckoSlot('metadata', async () => ({ rows: [] }))).rejects.toThrow('Market provider busy');
    await expect(reserveGeckoSlot('chart', async () => ({ rows: [] }))).rejects.toThrow('Market provider busy');
    expect(await reserveGeckoSlot('chart', async () => ({ rows: [{ delay: 4000 }] }))).toBe(4000);
  });
  it('dispatches a selected chart before waiting watchlist requests and keeps equal-priority requests ordered', async () => {
    const enqueue = createGeckoQueue<number>();
    const order: string[] = [];
    let finish!: (value: number) => void;
    const first = enqueue('sparkline', () => new Promise(resolve => { finish = resolve; }));
    const background = enqueue('sparkline', async () => { order.push('background'); return 2; });
    const chart = enqueue('chart', async () => { order.push('chart'); return 3; });
    const nextChart = enqueue('chart', async () => { order.push('next chart'); return 4; });
    await expect(enqueue('metadata', async () => 5)).rejects.toBeInstanceOf(MarketProviderDeferred);
    finish(1);
    await Promise.all([first, background, chart, nextChart]);
    expect(order).toEqual(['chart', 'next chart', 'background']);
  });
  it('promotes a queued sparkline when its token page is opened', async () => {
    const enqueue = createGeckoQueue<number>();
    const order: string[] = [];
    let finish!: (value: number) => void;
    let selected: GeckoPriority = 'sparkline';
    const first = enqueue('sparkline', () => new Promise(resolve => { finish = resolve; }));
    const background = enqueue('sparkline', async () => { order.push('background'); return 2; });
    const promoted = enqueue(() => selected, async () => { order.push('promoted'); return 3; });
    selected = 'chart'; finish(1);
    await Promise.all([first, background, promoted]);
    expect(order).toEqual(['promoted', 'background']);
  });
  it('returns the remaining shared cooldown instead of a generic minute-long failure', async () => {
    let calls = 0;
    try {
      await reserveGeckoSlot('chart', async () => ({ rows: ++calls === 1 ? [] : [{ delay: 125_000 }] }));
      throw new Error('Expected cooldown');
    } catch (error) {
      expect(error).toMatchObject({ reason: 'rate_limited', retryAfterMs: 125_000 });
    }
  });
  it('bounds reserved chart slots to one spaced request, not a 45-second watchlist backlog', async () => {
    await reserveGeckoSlot('chart', async (_sql, values) => {
      expect(values.slice(1)).toEqual([6500, 6500]);
      return { rows: [{ delay: 6500 }] };
    });
    await reserveGeckoSlot('metadata', async (_sql, values) => {
      expect(values.slice(1)).toEqual([6500, 0]);
      return { rows: [{ delay: 0 }] };
    });
  });
});
