import { describe, expect, it } from 'vitest';
import { mergeJournalEvidence, type JournalCanonicalTrade, type JournalStoredMovement } from './journalEvidence.js';
const wallet = `0x${'a'.repeat(40)}`, token = `0x${'b'.repeat(40)}`, txHash = `0x${'1'.repeat(64)}`;
const canonical = (override: Partial<JournalCanonicalTrade> = {}): JournalCanonicalTrade => ({ id: 'indexed', txHash, side: 'buy', tokenAmount: '5', amountUsd: '10', quoteAmount: '0.01', quoteSymbol: 'BNB', timestamp: '2026-10-18T12:00:00.000Z', blockNumber: '100', transactionIndex: 2, ...override });
const provider = (override: Partial<JournalStoredMovement> = {}): JournalStoredMovement => ({ id: 'provider1', txHash, kind: 'buy', tokenAmount: '5', amountUsd: '10', feeUsd: '0.1', quoteAmount: '0.01', quoteSymbol: 'BNB', timestamp: '2026-10-18T12:00:00.000Z', counterparty: null, ...override });
describe('journal canonical/provider evidence merge', () => {
  it('checks one-to-one overlap and retains genuine indexed execution position', () => {
    const result = mergeJournalEvidence(wallet, token, [provider()], [canonical()], true);
    expect(result.reasons).toEqual([]); expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ id: 'provider1', blockNumber: '100', transactionIndex: 2 });
  });
  it('preserves repeated operations and checks their combined quantity', () => {
    const result = mergeJournalEvidence(wallet, token, [provider({ tokenAmount: '2', quoteAmount: '0.004' }), provider({ id: 'provider2', tokenAmount: '3', quoteAmount: '0.006' })], [canonical()], true);
    expect(result.reasons).toEqual([]); expect(result.events).toHaveLength(2);
    expect(result.events.every(row => row.blockNumber === undefined)).toBe(true);
  });
  it('rejects quantity, quote-value and timestamp contradictions', () => {
    expect(mergeJournalEvidence(wallet, token, [provider({ tokenAmount: '6' })], [canonical()], true).reasons).toContain('indexed_history_mismatch');
    expect(mergeJournalEvidence(wallet, token, [provider({ quoteAmount: '0.02' })], [canonical()], true).reasons).toContain('indexed_value_mismatch');
    expect(mergeJournalEvidence(wallet, token, [provider({ quoteAmount: null, amountUsd: '20' })], [canonical()], true).reasons).toContain('indexed_value_mismatch');
    expect(mergeJournalEvidence(wallet, token, [provider({ quoteAmount: null, amountUsd: null })], [canonical()], true).reasons).toContain('overlap_value_unverified');
    expect(mergeJournalEvidence(wallet, token, [provider({ timestamp: '2026-10-18T11:00:00.000Z' })], [canonical()], true).reasons).toContain('indexed_history_mismatch');
  });
  it('retains indexed history while provider history is incomplete and excludes swap-transfer duplication', () => {
    const result = mergeJournalEvidence(wallet, token, [provider({ id: 'transfer', kind: 'transfer_in' })], [canonical()], false);
    expect(result.reasons).toEqual([]); expect(result.events).toHaveLength(1); expect(result.events[0].id).toBe('indexed');
    expect(mergeJournalEvidence(wallet, token, [], [canonical()], true).reasons).toContain('indexed_history_mismatch');
  });
  it('never manufactures a provider transfer identity from transaction and equal quantity', () => {
    const result = mergeJournalEvidence(wallet, token, [provider({ kind: 'transfer_in', counterparty: `0x${'c'.repeat(40)}` })], [], true);
    expect(result.events[0].transferId).toBeNull(); expect(result.events[0].counterparty).toBe(`0x${'c'.repeat(40)}`);
  });
  it('does not allocate the same indexed purchase budget to multiple token legs', () => {
    const value = mergeJournalEvidence(wallet, token, [], [canonical({ sharedQuote: true })], false);
    expect(value.reasons).toContain('shared_quote_unallocated'); expect(value.events[0].amountUsd).toBeNull();
    expect(mergeJournalEvidence(wallet, token, [provider()], [canonical({ sharedQuote: true })], true).reasons).toContain('shared_quote_unallocated');
  });
});
