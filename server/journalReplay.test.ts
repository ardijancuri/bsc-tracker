import { describe, expect, it } from 'vitest';
import { applyJournalReplay } from './journalReplay.js';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import type { JournalLedgerEvent } from './journalLedger.js';
const wallet = `0x${'a'.repeat(40)}`, token = `0x${'b'.repeat(40)}`, now = Date.parse('2026-10-18T12:00:00.000Z');
const activity: KolTokenActivity = { kol: { address: wallet, name: null, avatarUrl: null, twitter: null, source: 'journal', lastSeenAt: null },
  token: { address: token, symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: '1000' }, trades: [],
  summary: { investedUsd: null, soldUsd: null, realizedProfitUsd: null, avgBoughtPriceUsd: null, avgSoldPriceUsd: null, avgBoughtMcapUsd: null, avgSoldMcapUsd: null,
    remainingTokenAmount: null, remainingCostBasisUsd: null, buyCount: 0, sellCount: 0, valuedBuyCount: 0, valuedSellCount: 0, excludedSellCount: 0, unpricedTradeCount: 0,
    firstTradeAt: null, lastTradeAt: null, status: 'unknown', profitBasis: 'observed_fifo' },
  coverage: { source: 'indexed', indexedTradeCount: 0, returnedTradeCount: 0, complete: true, historyLimit: 2000, costsIncluded: false }, generatedAt: new Date(now).toISOString() };
const event = (id: string, kind: JournalLedgerEvent['kind'], quantity: string, amount: string | null, fee: string | null, elapsed: number): JournalLedgerEvent => ({ id, kind,
  walletAddress: wallet, tokenAddress: token, txHash: `0x${id.repeat(64)}`, timestamp: new Date(now - elapsed).toISOString(), tokenAmount: quantity, amountUsd: amount, feeUsd: fee });
const proof = { walletAddress: wallet, tokenAddress: token, chain: 'bsc' as const, blockNumber: '1000', blockHash: `0x${'f'.repeat(64)}`, blockTimestamp: new Date(now - 3000).toISOString(), checkedAt: new Date(now).toISOString(), balance: '60' };
describe('journal server replay accounting', () => {
  it('uses the identical prepared ending profit and acquisition return for modal and export', () => {
    const value = applyJournalReplay(activity, { events: [event('1', 'buy', '100', '100', '1', 60_000), event('2', 'transfer_out', '40', '80', '0.1', 30_000)], proof,
      quote: { priceUsd: '2', timestamp: new Date(now).toISOString() }, coverageComplete: true, source: 'gmgn', now });
    expect(value.realizedAccounting?.status).toBe('ready');
    expect(value.realizedAccounting?.position?.estimatedProfitUsd).toBe('98.9');
    expect(value.replayAccounting?.final?.reportedProfitUsd).toBe(value.realizedAccounting?.position?.estimatedProfitUsd);
    expect(value.replayAccounting?.final?.reportedRoi).toBe(value.realizedAccounting?.position?.estimatedRoi);
    expect(value.replayAccounting?.final?.feeInclusiveCostUsd).toBe('101.1');
    expect(value.realizedAccounting?.position?.feeInclusiveCostUsd).toBe('101');
    expect(value.replayAccounting?.history?.events.map(row => row.blockNumber)).toEqual([null, null]);
    expect(value.trades).toHaveLength(1); expect(value.trades[0].blockNumber).toBeNull();
    expect(value.summary.avgBoughtPriceUsd).toBe('1'); expect(value.summary.avgBoughtMcapUsd).toBe('1000'); expect(value.summary.avgSoldPriceUsd).toBeNull();
  });
  it('does not invent zero costs or verified totals from an unknown acquisition', () => {
    const value = applyJournalReplay(activity, { events: [event('1', 'buy', '60', null, '1', 60_000)], proof,
      quote: { priceUsd: '2', timestamp: new Date(now).toISOString() }, coverageComplete: true, source: 'gmgn', now });
    expect(value.replayAccounting?.final).toBeNull(); expect(value.realizedAccounting?.position?.estimatedProfitUsd).toBeNull();
    expect(value.realizedAccounting?.status).toBe('unavailable');
  });
  it('keeps same-second snapshots atomic and preserves repeated event identities', () => {
    const one = event('1', 'buy', '30', '30', '0.1', 60_000), two = event('2', 'buy', '30', '30', '0.1', 60_000);
    const value = applyJournalReplay(activity, { events: [one, two], proof,
      quote: { priceUsd: '2', timestamp: new Date(now).toISOString() }, coverageComplete: true, source: 'gmgn', now });
    const events = value.replayAccounting?.history?.events;
    expect(events?.map(row => row.remainingTokenAmount)).toEqual(['60', '60']); expect(events?.map(row => row.id)).toEqual(['1', '2']);
  });
  it('sums decimal token holdings exactly', () => {
    const value = applyJournalReplay(activity, { events: [event('1', 'buy', '1000000000000000.000000000000000001', '1', '0', 60_000), event('2', 'sell', '1000000000000000', '1', '0', 30_000)],
      proof: { ...proof, balance: '0.000000000000000001' }, quote: { priceUsd: '2', timestamp: new Date(now).toISOString() }, coverageComplete: true, source: 'gmgn', now });
    expect(value.replayAccounting?.history?.events.at(-1)?.remainingTokenAmount).toBe('0.000000000000000001');
    expect(value.replayAccounting?.final?.remainingTokenAmount).toBe('0.000000000000000001');
  });
});
