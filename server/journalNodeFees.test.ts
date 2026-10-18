import { describe, expect, it } from 'vitest';
import { journalNodeFees } from './journalNodeFees.js';
import { userOperationTopic } from './smartAccountTrades.js';
const wallet = `0x${'1'.repeat(40)}`, bundler = `0x${'2'.repeat(40)}`, hash = `0x${'a'.repeat(64)}`, entry = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const topic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const operation = (id = 'b', fee = '100') => ({ address: entry, topics: [userOperationTopic, `0x${id.repeat(64)}`, topic(wallet), topic(`0x${'0'.repeat(40)}`)],
  data: `0x${['0', '1', BigInt(fee).toString(16), '1'].map(word => word.padStart(64, '0')).join('')}` });
describe('journal wallet-paid fee evidence', () => {
  it('attributes EOA gas once without floating-point arithmetic', () => {
    const result = journalNodeFees({ hash, from: wallet }, { status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [] }, wallet);
    expect(result.complete).toBe(true); expect(result.fees[0].nativeWei).toBe('21000000000000');
  });
  it('uses authenticated operation gas and ignores the bundler fee', () => {
    const result = journalNodeFees({ hash, from: bundler, to: entry }, { status: '0x1', gasUsed: '0xffffff', effectiveGasPrice: '0xffffff', logs: [operation()] }, wallet);
    expect(result.complete).toBe(true); expect(result.fees).toHaveLength(1); expect(result.fees[0].nativeWei).toBe('100');
  });
  it('keeps repeated wallet operations distinct instead of collapsing their fees', () => {
    const result = journalNodeFees({ hash, from: bundler, to: entry }, { status: '0x1', logs: [operation(), operation('c', '200')] }, wallet);
    expect(result.complete).toBe(true); expect(result.fees.map(fee => fee.nativeWei)).toEqual(['100', '200']);
    expect(new Set(result.fees.map(fee => fee.id)).size).toBe(2);
  });
  it('rejects arbitrary contracts asserting a user-operation event', () => {
    const result = journalNodeFees({ hash, from: bundler, to: bundler }, { status: '0x1', logs: [operation()] }, wallet);
    expect(result.complete).toBe(false); expect(result.fees).toHaveLength(0);
  });
  it('keeps paymaster fee policy unknown instead of charging bundler gas', () => {
    const log = operation(); log.topics[3] = topic(bundler);
    const result = journalNodeFees({ hash, from: bundler, to: entry }, { status: '0x1', logs: [log] }, wallet);
    expect(result.complete).toBe(false); expect(result.reason).toBe('sponsored_operation_fee_unknown');
  });
  it('does not turn missing gas evidence or duplicate operation events into zero', () => {
    expect(journalNodeFees({ hash, from: wallet }, { status: '0x1', logs: [] }, wallet).complete).toBe(false);
    expect(journalNodeFees({ hash, from: bundler, to: entry }, { status: '0x1', logs: [operation(), operation()] }, wallet).complete).toBe(false);
  });
});
