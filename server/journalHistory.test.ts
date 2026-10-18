import { describe, expect, it } from 'vitest';
import { journalDecimal, parseJournalHistoryRows, sumJournalDecimals } from './journalHistory.js';

const wallet = `0x${'a'.repeat(40)}`, token = `0x${'b'.repeat(40)}`, tx = `0x${'1'.repeat(64)}`, now = 1_800_000_000_000;
const row = (override: Record<string, unknown> = {}) => ({ tx_hash: tx, wallet, chain: 'bsc', event_type: 'buy', timestamp: 1_700_000_000,
  token: { address: token, symbol: 'TEST', name: 'Test', decimals: 18 }, token_amount: '1000000000000000000000.000000000000000001', cost_usd: '12.3',
  gas_usd: '0.01', dex_usd: '0.02', priority_fee: '0', tip_fee: '0', ...override });
describe('journal history normalization', () => {
  it('preserves large decimal quantities without floating point', () => {
    expect(parseJournalHistoryRows([row()], wallet, now)[0]).toMatchObject({ tokenAmount: '1000000000000000000000.000000000000000001', amountUsd: '12.3', feeUsd: '0.03' });
    expect(sumJournalDecimals(['0.000000000000000001', '99999999999999999999.999999999999999999'])).toBe('100000000000000000000');
    expect(journalDecimal('1.2e-8')).toBe('0.000000012');
    expect(journalDecimal('-1')).toBeNull();
  });
  it('keeps unknown fees and acquisition costs unknown', () => {
    expect(parseJournalHistoryRows([row({ gas_usd: null, cost_usd: null })], wallet, now)[0]).toMatchObject({ amountUsd: null, feeUsd: null });
    expect(parseJournalHistoryRows([row({ event_type: 'transferIn', cost_usd: '0', gas_usd: '0', dex_usd: '0' })], wallet, now)[0]).toMatchObject({ amountUsd: null, feeUsd: '0' });
    expect(parseJournalHistoryRows([row({ cost_usd: '0' })], wallet, now)[0].amountUsd).toBeNull();
  });
  it('does not invalidate financial history when token display metadata changes', () => {
    const original = parseJournalHistoryRows([row()], wallet, now)[0];
    const renamed = parseJournalHistoryRows([row({ token: { address: token, symbol: 'RENAMED', name: 'New display name', decimals: 18 } })], wallet, now)[0];
    expect(original.evidenceHash).toBe(renamed.evidenceHash);
  });
  it('rejects a different wallet, token, future or malformed activity', () => {
    for (const invalid of [{ wallet: token }, { timestamp: now / 1000 + 1 }, { token_amount: '0' }, { tx_hash: 'bad' }, { chain: 'eth' }]) expect(() => parseJournalHistoryRows([row(invalid)], wallet, now)).toThrow('provider_history_invalid');
  });
  it('applies existing quote and dividend exclusions before accounting', () => {
    expect(parseJournalHistoryRows([row({ token: { address: token, symbol: 'Cake-LP', name: 'Pool' } })], wallet, now)).toEqual([]);
    expect(parseJournalHistoryRows([row({ token: { address: '0xce24439f2d9c6a2289f741120fe202248b666666', symbol: 'REWARD' } })], wallet, now)).toEqual([]);
  });
  it('preserves repeated smart-account operations when provider identities exist', () => {
    const values = parseJournalHistoryRows([row({ event_id: 'op1' }), row({ event_id: 'op2', token_amount: '3' })], wallet, now);
    expect(values).toHaveLength(2); expect(values[0].eventKey).not.toBe(values[1].eventKey);
    expect(() => parseJournalHistoryRows([row(), row()], wallet, now)).toThrow('provider_execution_identity_ambiguous');
    expect(() => parseJournalHistoryRows([row({ id: 'same' }), row({ id: 'same', token_amount: '3' })], wallet, now)).toThrow('provider_execution_identity_ambiguous');
  });
});
