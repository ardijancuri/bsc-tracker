import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import reference from './data/championship-reference.json' with { type: 'json' };
import { createChampionshipService, parseChampionshipBoard } from './championship.js';
import { createChampionshipFileStore, validateChampionshipSnapshot } from './championshipFileStore.js';

const capturedAt = Date.parse(reference.capturedAt);
const key = 'daily:2026-10-20';
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'kollens-championship-'));
  directories.push(path);
  return path;
}
function snapshot(version = 60) {
  const payload = structuredClone(reference.daily.payload);
  payload.data.updated_at = Math.floor(capturedAt / 1000) + version;
  payload.data.list[0].daily_pnl = `${12_000 + version}.00`;
  return parseChampionshipBoard(payload, 'daily', '2026-10-20', capturedAt + version * 1000);
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('championship file snapshots', () => {
  it('survives a new store instance and leaves only the complete board file after saving', async () => {
    const path = await directory(), value = snapshot();
    value.items[0].name = '交易员 🏆';
    await createChampionshipFileStore(path).save(key, value);
    expect(await createChampionshipFileStore(path).load(key)).toEqual(value);
    expect(JSON.parse(await readFile(join(path, 'daily.2026-10-20.json'), 'utf8'))).toEqual(value);
    expect(await readdir(path)).toEqual(['daily.2026-10-20.json']);
    expect('daily.2026-10-20.json').not.toMatch(/^[^/\\]+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/);
  });

  it('never regresses provider time and uses capture time to resolve equal provider times', async () => {
    const path = await directory(), store = createChampionshipFileStore(path), current = snapshot(120);
    await store.save(key, current);
    const olderProvider = { ...snapshot(60), fetchedAt: snapshot(180).fetchedAt };
    await store.save(key, olderProvider);
    await store.save(key, { ...current, fetchedAt: snapshot(60).fetchedAt });
    expect(await store.load(key)).toEqual(current);
    const laterCapture = { ...current, fetchedAt: snapshot(180).fetchedAt };
    laterCapture.items = structuredClone(current.items);
    laterCapture.items[0].name = 'Updated identity';
    await store.save(key, laterCapture);
    expect(await store.load(key)).toEqual(laterCapture);
  });

  it('restricts files to the competition dates and rejects unsafe or mismatched snapshot contents', async () => {
    const path = await directory(), store = createChampionshipFileStore(path);
    for (const invalid of ['../overall', 'daily:../../outside', 'daily:2026-10-16', 'daily:2026-10-27', 'daily:2026-02-30', 'overall:2026-10-20']) {
      await expect(store.load(invalid)).rejects.toThrow('key');
      await expect(store.save(invalid, snapshot())).rejects.toThrow('key');
    }
    const invalidUrl = snapshot(); invalidUrl.items[0].liveUrl = 'javascript:alert(1)';
    await expect(store.save(key, invalidUrl)).rejects.toThrow('Invalid championship snapshot');
    const wrongDay = snapshot(); wrongDay.date = '2026-10-21';
    expect(validateChampionshipSnapshot(wrongDay, key)).toBeUndefined();
    const duplicate = snapshot(); duplicate.items[1].id = duplicate.items[0].id;
    expect(validateChampionshipSnapshot(duplicate, key)).toBeUndefined();
    expect(await readdir(path)).toEqual([]);
  });

  it('ignores broken JSON and validates untrusted disk timestamps before loading', async () => {
    const path = await directory(), file = join(path, 'daily.2026-10-20.json'), store = createChampionshipFileStore(path);
    await writeFile(file, '{unfinished');
    expect(await store.load(key)).toBeUndefined();
    await store.save(key, snapshot());
    expect(await store.load(key)).toEqual(snapshot());
    await writeFile(file, JSON.stringify({ ...snapshot(), fetchedAt: new Date(Date.now() + 120_000).toISOString() }));
    expect(await store.load(key)).toBeUndefined();
  });

  it('preserves the prior file when another writer owns its lock', async () => {
    const path = await directory(), store = createChampionshipFileStore(path), current = snapshot();
    await store.save(key, current);
    const lockPath = join(path, 'daily.2026-10-20.json.lock');
    const lock = await open(lockPath, 'wx');
    try {
      await expect(createChampionshipFileStore(path).save(key, snapshot(120))).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await store.load(key)).toEqual(current);
    } finally { await lock.close(); await rm(lockPath); }
    await store.save(key, snapshot(120));
    expect(await store.load(key)).toEqual(snapshot(120));
  });
});

describe('championship imports without process restarts', () => {
  it('loads a new disk capture on explicit refresh inside the cooldown and coalesces concurrent refreshes', async () => {
    const path = await directory(), store = createChampionshipFileStore(path);
    const fetcher = vi.fn(async () => new Response('', { status: 403 }));
    const service = createChampionshipService({ store, fetcher, now: () => capturedAt + 600_000 });
    const original = await service.get('daily', '2026-10-20');
    const imported = snapshot();
    await createChampionshipFileStore(path).save(key, imported);
    const [updated, concurrent] = await Promise.all([
      service.get('daily', '2026-10-20', { refresh: true }),
      service.get('daily', '2026-10-20', { refresh: true }),
    ]);
    expect(updated).toEqual(concurrent);
    expect(updated).toMatchObject({ ...imported, freshness: 'saved', upstreamBlocked: true });
    expect(updated.items[0].pnlUsd).not.toBe(original.items[0].pnlUsd);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains cheap cached requests and discovers an imported board on the next polling cycle', async () => {
    let now = capturedAt + 600_000;
    const path = await directory(), store = createChampionshipFileStore(path), load = vi.spyOn(store, 'load');
    const service = createChampionshipService({ store, fetcher: async () => new Response('', { status: 403 }), now: () => now });
    const original = await service.get('daily', '2026-10-20');
    await createChampionshipFileStore(path).save(key, snapshot());
    expect(await service.get('daily', '2026-10-20')).toEqual(original);
    expect(load).toHaveBeenCalledTimes(1);
    now += 60_001;
    expect(await service.get('daily', '2026-10-20')).toMatchObject({ ...snapshot(), freshness: 'saved' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps memory when stored snapshots regress, use another day, contain future times or cannot be read', async () => {
    const current = snapshot(120), now = capturedAt + 600_000;
    const load = vi.fn(async (): Promise<unknown> => current);
    const service = createChampionshipService({ store: { load, save: vi.fn() }, fetcher: async () => new Response('', { status: 403 }), now: () => now });
    expect(await service.get('daily', '2026-10-20')).toMatchObject(current);
    for (const invalid of [snapshot(60), { ...current, date: '2026-10-21' },
      { ...current, fetchedAt: new Date(now + 120_000).toISOString() },
      { ...current, updatedAt: new Date(now + 120_000).toISOString(), fetchedAt: new Date(now).toISOString() }]) {
      load.mockResolvedValueOnce(invalid);
      expect(await service.get('daily', '2026-10-20', { refresh: true })).toMatchObject({ ...current, freshness: 'saved' });
    }
    load.mockRejectedValueOnce(new Error('disk unavailable'));
    expect(await service.get('daily', '2026-10-20', { refresh: true })).toMatchObject(current);
  });

  it('selects the file store only when its environment directory is configured', async () => {
    const path = await directory(), imported = snapshot();
    await createChampionshipFileStore(path).save(key, imported);
    const options = { fetcher: async () => new Response('', { status: 403 }), now: () => capturedAt + 600_000 };
    vi.stubEnv('CHAMPIONSHIP_SNAPSHOT_DIR', path);
    expect(await createChampionshipService(options).get('daily', '2026-10-20')).toMatchObject(imported);
    vi.stubEnv('CHAMPIONSHIP_SNAPSHOT_DIR', '');
    const fallback = await createChampionshipService(options).get('daily', '2026-10-20');
    expect(fallback.updatedAt).toBe(new Date(reference.daily.payload.data.updated_at * 1000).toISOString());
    expect(fallback.items[0].pnlUsd).not.toBe(imported.items[0].pnlUsd);
  });

  it('keeps a good upstream result in memory even when persistence fails', async () => {
    const payload = structuredClone(reference.daily.payload);
    payload.data.updated_at = Math.floor(capturedAt / 1000) + 60;
    payload.data.list[0].daily_pnl = '13000.00';
    const fetcher = vi.fn(async () => Response.json(payload));
    const store = { load: vi.fn(async () => { throw new Error('disk unavailable'); }), save: vi.fn(async () => { throw new Error('disk full'); }) };
    const service = createChampionshipService({ store, fetcher, now: () => capturedAt + 60_000 });
    const first = await service.get('daily', '2026-10-20');
    expect(first).toMatchObject({ freshness: 'live', items: [expect.objectContaining({ pnlUsd: '13000.00' }), ...first.items.slice(1)] });
    expect(store.save).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(new Response('', { status: 403 }));
    const failed = await service.get('daily', '2026-10-20', { refresh: true });
    expect(failed).toMatchObject({ items: first.items, updatedAt: first.updatedAt, fetchedAt: first.fetchedAt, freshness: 'saved' });
  });
});
