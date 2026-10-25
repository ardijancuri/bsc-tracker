import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { championship, championshipLastDay, championshipLimit, type ChampionshipSnapshot } from '../shared/championship.js';
import { createChampionshipFileStore, validateChampionshipSnapshot } from './championshipFileStore.js';

export function validateChampionshipImport(input: unknown, now = Date.now()) {
  const packet = input as { source?: unknown; records?: { key: string; value: ChampionshipSnapshot }[] };
  assert.equal(packet?.source, 'GMGN public championship API and rendered identities, captured through the browser');
  assert.ok(Array.isArray(packet.records) && packet.records.length === 2, 'Expected Daily and Overall boards');
  const expected = new Set([`daily:${championshipLastDay(now)}`, 'overall:all']);
  return packet.records.map(record => {
    assert.ok(record && expected.delete(record.key), 'Unexpected or duplicate championship board');
    const value = validateChampionshipSnapshot(record.value, record.key, now);
    assert.ok(value && value.items.length === championshipLimit, 'Expected 20 validated rankings');
    assert.ok(Math.abs(now - Date.parse(value.fetchedAt)) < 30 * 60_000, 'Browser capture is too old');
    assert.ok(now >= Date.parse(championship.endsAt)
      || Date.parse(value.fetchedAt) - Date.parse(value.updatedAt) < 15 * 60_000, 'Provider snapshot is too old');
    return { key: record.key, value };
  });
}

async function main() {
  const directory = process.env.CHAMPIONSHIP_SNAPSHOT_DIR;
  assert.ok(directory, 'CHAMPIONSHIP_SNAPSHOT_DIR must be configured');
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    assert.ok(Buffer.byteLength(input, 'utf8') <= 256 * 1024, 'Championship import is too large');
  }
  const records = validateChampionshipImport(JSON.parse(input));
  const store = createChampionshipFileStore(directory);
  for (const { key, value } of records) {
    await store.save(key, value);
    const saved = validateChampionshipSnapshot(await store.load(key), key);
    assert.ok(saved && Date.parse(saved.updatedAt) >= Date.parse(value.updatedAt), 'Snapshot was not persisted');
    console.log(JSON.stringify({ key, updatedAt: saved.updatedAt, count: saved.items.length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
