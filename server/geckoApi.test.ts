import { describe, expect, it } from 'vitest';
import { providerRetryMs, reserveGeckoSlot } from './geckoApi.js';

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
});
