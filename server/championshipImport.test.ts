import { describe, expect, it } from 'vitest';
import reference from './data/championship-reference.json' with { type: 'json' };
import { parseChampionshipBoard } from './championship.js';
import { validateChampionshipImport } from './championshipImport.js';

const at = Date.parse(reference.capturedAt);
function packet() {
  return { source: 'GMGN public championship API and rendered identities, captured through the browser', records: [
    { key: 'daily:2026-10-20', value: parseChampionshipBoard(reference.daily.payload, 'daily', '2026-10-20', at) },
    { key: 'overall:all', value: parseChampionshipBoard(reference.overall.payload, 'overall', null, at) },
  ] };
}

describe('verified championship import', () => {
  it('accepts the current UTC Daily and Overall top 20 with original timestamps', () => {
    const data = packet();
    expect(validateChampionshipImport(data, at)).toEqual(data.records);
  });
  it('rejects duplicate boards, incomplete rankings, and another UTC day', () => {
    const duplicate = packet(); duplicate.records[1] = duplicate.records[0];
    expect(() => validateChampionshipImport(duplicate, at)).toThrow();
    const partial = packet(); partial.records[0].value.items.pop();
    expect(() => validateChampionshipImport(partial, at)).toThrow();
    expect(() => validateChampionshipImport(packet(), at + 24 * 60 * 60_000)).toThrow();
  });
  it('rejects stale captures, future provider times, and stale live provider data', () => {
    expect(() => validateChampionshipImport(packet(), at + 31 * 60_000)).toThrow();
    const future = packet(); future.records[0].value.updatedAt = new Date(at + 120_000).toISOString();
    expect(() => validateChampionshipImport(future, at)).toThrow();
    const stale = packet(); stale.records[0].value.updatedAt = new Date(at - 16 * 60_000).toISOString();
    expect(() => validateChampionshipImport(stale, at)).toThrow();
  });
});
