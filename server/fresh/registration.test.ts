import { describe, expect, it } from 'vitest';
import { mergeFreshRegistrationEvidence } from './registration.js';
import { encodeFreshEvidence, decodeFreshEvidence, type FreshCapturedReceipt } from './capture.js';
const address = (digit: string) => `0x${digit.repeat(40)}`, hash = (digit: string) => `0x${digit.repeat(64)}`;
function fixture(): FreshCapturedReceipt {
  return { transaction: { hash: hash('a'), from: address('1'), to: address('2'), value: '0x0', blockHash: hash('b'), blockNumber: '0x65', transactionIndex: '0x0' },
    receipt: { transactionHash: hash('a'), transactionIndex: '0x0', blockHash: hash('b'), blockNumber: '0x65', status: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', logs: [] },
    wallets: [address('1')], observedAt: '2026-10-21T19:00:00Z', trace: { type: 'CALL', from: address('1'), to: address('2'), value: '0x0' } };
}
describe('targeted wallet registration evidence', () => {
  it('merges only wallet context while preserving original observation and retained trace', () => {
    const existing = fixture(), incoming = { ...fixture(), wallets: [address('2')], observedAt: '2026-10-21T20:00:00Z', trace: undefined };
    const merged = mergeFreshRegistrationEvidence(existing, incoming, address('2'));
    expect(merged.changed).toBe(true); expect(merged.value.wallets).toEqual([address('1'), address('2')]);
    expect(merged.value.historicalWallets).toEqual([address('2')]); expect(merged.value.observedAt).toBe(existing.observedAt); expect(merged.value.trace).toEqual(existing.trace);
    expect(decodeFreshEvidence(encodeFreshEvidence(merged.value))).toMatchObject(merged.value);
  });
  it('does no new work for duplicate registration evidence', () => {
    const existing = fixture(); expect(mergeFreshRegistrationEvidence(existing, fixture(), address('1'))).toEqual({ value: existing, changed: false });
  });
  it('refuses to overwrite contradictory original logs or gas', () => {
    const existing = fixture(), incoming = fixture(); incoming.wallets = [address('2')]; incoming.receipt = { ...incoming.receipt, gasUsed: '0x2' };
    expect(() => mergeFreshRegistrationEvidence(existing, incoming, address('2'))).toThrow('registration_receipt_contradiction');
  });
  it('cannot attach a wallet without authentic collection evidence', () => {
    expect(() => mergeFreshRegistrationEvidence(null, fixture(), address('2'))).toThrow('registration_wallet_evidence_missing');
  });
});
