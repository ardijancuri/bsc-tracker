import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChartDiskCache, HISTORICAL_CHART_TTL_MS, RECENT_CHART_TTL_MS } from './cache.js';
const directories: string[] = [];
const directory = async () => { const value = await mkdtemp(path.join(os.tmpdir(), 'kollens-charts-')); directories.push(value); return value; };
afterEach(async () => { await Promise.all(directories.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

describe('fresh disposable disk chart cache', () => {
  it('shares pages between instances and preserves original observations across cache reads', async () => {
    const folder = await directory(); let now = 1000;
    const left = new ChartDiskCache(folder, { now: () => now }), right = new ChartDiskCache(folder, { now: () => now });
    await left.put('historical-normalized-parameters', { candles: [1, 2] }, HISTORICAL_CHART_TTL_MS);
    now += 100_000;
    expect(await right.get('historical-normalized-parameters')).toEqual({ value: { candles: [1, 2] }, observedAt: 1000 });
    const contents = await readFile(path.join(folder, (await readdir(folder)).find(name => name.endsWith('.json'))!), 'utf8');
    expect(contents).not.toContain('historical-normalized-parameters');
  });
  it('expires recent tails at 15 seconds and completed historical pages after seven days', async () => {
    let now = 1000; const cache = new ChartDiskCache(await directory(), { now: () => now });
    await cache.put('tail', { x: 1 }, RECENT_CHART_TTL_MS); await cache.put('history', { x: 1 }, HISTORICAL_CHART_TTL_MS);
    now += RECENT_CHART_TTL_MS;
    expect(await cache.get('tail')).toBeNull(); expect(await cache.get('history')).not.toBeNull();
    now = 1000 + HISTORICAL_CHART_TTL_MS;
    expect(await cache.get('history')).toBeNull(); expect((await cache.statistics()).entries).toBe(0);
  });
  it('evicts the least recently used page and never exceeds its byte cap', async () => {
    let now = 1000; const cache = new ChartDiskCache(await directory(), { now: () => now, maxBytes: 850 });
    await cache.put('a', 'a'.repeat(150), 100_000); now++;
    await cache.put('b', 'b'.repeat(150), 100_000); now++;
    expect(await cache.get('a')).not.toBeNull(); now++;
    await cache.put('c', 'c'.repeat(150), 100_000);
    expect(await cache.get('b')).toBeNull(); expect(await cache.get('a')).not.toBeNull(); expect(await cache.get('c')).not.toBeNull();
    expect((await cache.statistics()).bytes).toBeLessThanOrEqual(850);
    expect(await cache.put('too-large', 'x'.repeat(1000), 100_000)).toBe(false);
  });
  it('serializes concurrent writers across processes and rejects corrupted payloads', async () => {
    const folder = await directory(), options = { maxBytes: 1200 };
    const left = new ChartDiskCache(folder, options), right = new ChartDiskCache(folder, options);
    await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? left : right).put(String(index), 'x'.repeat(120), 10000)));
    expect((await left.statistics()).bytes).toBeLessThanOrEqual(1200);
    const files = (await readdir(folder)).filter(name => name.endsWith('.json'));
    const file = path.join(folder, files[0]); const body = JSON.parse(await readFile(file, 'utf8')); body.value = 'tampered'; await writeFile(file, JSON.stringify(body));
    // Statistics clears malformed JSON; a keyed read additionally checks hashes.
    let misses = 0; for (let index = 0; index < 10; index++) if (!await right.get(String(index))) misses++;
    expect(misses).toBeGreaterThan(0); expect((await right.statistics()).corrupt).toBeGreaterThan(0);
  });
});
