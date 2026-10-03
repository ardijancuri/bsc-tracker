import { describe, expect, it } from 'vitest';
import { defaultPreferences } from '../shared/intelligence.js';
import { classifyPosition, compareTrades, cooldownAllows, decimalUnits, detectSignals, positionIsFresh, type ObservedTrade } from './intelligenceLogic.js';

const origin = Date.parse('2026-10-03T12:00:00Z');
function trade(id: number, wallet = 'alice', side = 'buy', minutes = id): ObservedTrade {
  return { id: String(id), txHash: `tx${id}`, walletAddress: wallet, tokenAddress: 'token', kolName: wallet, side,
    timestamp: new Date(origin + minutes * 60_000).toISOString(), blockNumber: String(100 + id), blockHash: `block${id}`, transactionIndex: 0 };
}
describe('radar rules', () => {
  it('requires distinct wallets, never repeated buys by one wallet', () => {
    const rows = [trade(1), trade(2), trade(3, 'bob')];
    expect(detectSignals(rows[2], rows, defaultPreferences).map(row => row.kind)).not.toContain('clustered_buys');
    rows.push(trade(4, 'carol'));
    expect(detectSignals(rows[3], rows, defaultPreferences).find(row => row.kind === 'clustered_buys')?.wallets).toEqual(['alice', 'bob', 'carol']);
  });
  it.each([5, 10, 30] as const)('uses the configured %i minute window and threshold', windowMinutes => {
    const rows = [trade(1, 'alice', 'buy', 0), trade(2, 'bob', 'buy', windowMinutes)];
    const preferences = { ...defaultPreferences, windowMinutes, minBuyers: 2 };
    expect(detectSignals(rows[1], rows, preferences).some(row => row.kind === 'clustered_buys')).toBe(true);
    rows[1].timestamp = new Date(origin + windowMinutes * 60_000 + 1).toISOString();
    expect(detectSignals(rows[1], rows, preferences)).toEqual([]);
  });
  it('deduplicates transaction evidence and requires two separate purchases', () => {
    const first = trade(1), duplicate = { ...first, id: 'duplicate' }, second = trade(2);
    expect(detectSignals(duplicate, [first, duplicate], defaultPreferences)).toEqual([]);
    expect(detectSignals(second, [first, duplicate, second], defaultPreferences)[0].evidence).toHaveLength(2);
  });
  it('excludes future chain activity, even with an earlier timestamp', () => {
    const first = trade(1), next = trade(2, 'bob', 'buy', 0);
    expect(detectSignals(first, [first, next], { ...defaultPreferences, minBuyers: 2 })).toEqual([]);
  });
  it('requires the selling wallet to have an observed purchase within 24 hours', () => {
    const buy = trade(1, 'alice', 'buy', 0), sell = trade(2, 'alice', 'sell', 1440);
    expect(detectSignals(sell, [buy, sell], defaultPreferences)[0].kind).toBe('buyer_selling');
    expect(detectSignals({ ...sell, walletAddress: 'bob' }, [buy, sell], defaultPreferences)).toEqual([]);
    sell.timestamp = new Date(origin + 86400_001).toISOString();
    expect(detectSignals(sell, [buy, sell], defaultPreferences)).toEqual([]);
  });
  it('enforces ten minute cooldowns and produces a new ID on a changed canonical block', () => {
    const first = trade(1), second = trade(2);
    expect(cooldownAllows(first.timestamp, new Date(Date.parse(first.timestamp) + 599_999).toISOString())).toBe(false);
    expect(cooldownAllows(first.timestamp, new Date(Date.parse(first.timestamp) + 600_000).toISOString())).toBe(true);
    expect(detectSignals(second, [first, second], defaultPreferences)[0].id).not.toBe(detectSignals({ ...second, blockHash: 'replacement' }, [first, { ...second, blockHash: 'replacement' }], defaultPreferences)[0].id);
  });
  it('compares block numbers without losing bigint precision', () => {
    expect(compareTrades({ ...trade(1), blockNumber: '9007199254740993' }, { ...trade(2), blockNumber: '9007199254740992' })).toBe(1);
  });
});
describe('holding evidence', () => {
  it('establishes initial balances without inventing a movement', () => {
    expect(classifyPosition(null, 200n, [{ kind: 'buy', delta: 100n }])).toBe('Holding');
    expect(classifyPosition(null, 0n, [])).toBe('Unknown');
    expect(classifyPosition(200n, 200n, [], 'Added')).toBe('Added');
  });
  it.each([
    [100n, 150n, 'buy', 50n, 'Added'], [0n, 50n, 'buy', 50n, 'Holding'],
    [100n, 60n, 'sell', -40n, 'Reduced'], [100n, 0n, 'sell', -100n, 'Exited'],
    [100n, 0n, 'transfer', -100n, 'Transferred'], [100n, 130n, 'transfer', 30n, 'Transferred'],
  ] as const)('classifies only reconciled movements', (previous, balance, kind, delta, status) => {
    expect(classifyPosition(previous, balance, [{ kind, delta }])).toBe(status);
  });
  it('does not call zero balances or unexplained changes a sale', () => {
    expect(classifyPosition(100n, 0n, [])).toBe('Unknown');
    expect(classifyPosition(100n, 130n, [{ kind: 'buy', delta: 40n }])).toBe('Unknown');
    expect(classifyPosition(100n, 110n, [{ kind: 'buy', delta: 20n }, { kind: 'transfer', delta: -10n }])).toBe('Unknown');
    expect(classifyPosition(100n, 100n, [{ kind: 'buy', delta: 20n }, { kind: 'sell', delta: -20n }])).toBe('Unknown');
  });
  it('keeps exact quantities for unusual decimals', () => {
    expect(decimalUnits(1234567890123456789012345678901234567n, 36)).toBe('1.234567890123456789012345678901234567');
    expect(decimalUnits(123n, 0)).toBe('123');
    expect(decimalUnits(1000000n, 6)).toBe('1');
    expect(() => decimalUnits(1n, 37)).toThrow();
  });
  it('rejects stale, missing and implausibly future snapshot times', () => {
    expect(positionIsFresh(new Date(origin - 300_001).toISOString(), origin)).toBe(false);
    expect(positionIsFresh(null, origin)).toBe(false);
    expect(positionIsFresh(new Date(origin + 31_000).toISOString(), origin)).toBe(false);
    expect(positionIsFresh(new Date(origin - 300_000).toISOString(), origin)).toBe(true);
  });
});
