import { describe, expect, it } from 'vitest';
import { localMaintenanceDatabase, parseMaintenanceArguments } from './databaseMaintenance.js';

describe('local maintenance boundaries', () => {
  it('defaults to a non-mutating status and requires explicit bounded mutation', () => {
    expect(parseMaintenanceArguments([]).command).toBe('status');
    expect(() => parseMaintenanceArguments(['all'])).toThrow('--apply');
    expect(parseMaintenanceArguments(['market-coverage', '--apply', '--batches', '10', '--limit', '500', '--prune-legacy']))
      .toMatchObject({ command: 'market-coverage', apply: true, batches: 10, limit: 500, pruneLegacy: true });
    for (const value of ['0', '-1', 'NaN', '1.5', '2001']) expect(() => parseMaintenanceArguments(['positions', '--apply', '--limit', value])).toThrow();
    expect(() => parseMaintenanceArguments(['status', '--unknown'])).toThrow();
  });
  it('cannot target the VPS, forwarded production ports or system databases', () => {
    expect(localMaintenanceDatabase('postgres://test@127.0.0.1:5435/bscan_chart_preview').pathname).toBe('/bscan_chart_preview');
    for (const value of [undefined,'postgres://test@65.21.69.43:5435/bscan','postgres://test@localhost:5434/bscan',
      'postgres://test@127.0.0.1:5435/postgres','postgres://test@127.0.0.1:5435/template1',
      'postgres://test@127.0.0.1:5435/bscan?host=65.21.69.43&port=5432',
      'postgres://test@127.0.0.1:5435/bscan?options=-csearch_path=public',
      'postgres://test@127.0.0.1:5435/bscan#ignored','https://127.0.0.1:5435/bscan'])
      expect(() => localMaintenanceDatabase(value)).toThrow('local test PostgreSQL');
  });
});
