import { afterEach, describe, expect, it, vi } from 'vitest';
import ReplayCanvas from './tradeReplayCanvas';
import { journalReplayFixture } from './journalReplay.fixture';
import { journalTokenProfit, prepareJournalReplay } from './journalReplay';
import { prepareTradeReplayData, replayInventoryIsFresh, validReplayAccountingFinal } from './tradeReplayData';
import { tradeActivityBase, tradeRequestHeaders } from './tradeRequestContext';


afterEach(() => vi.unstubAllGlobals());

describe('authorized private journal replay preparation', () => {
  it('uses private endpoints and account headers without public fallback', () => {
    const { activity, context } = journalReplayFixture();
    expect(tradeActivityBase(activity.kol.address, activity.token.address, context)).toBe(`/api/journal/wallets/${activity.kol.address}/tokens/${activity.token.address}`);
    expect(tradeRequestHeaders(context)).toEqual({ 'X-Watchlist-Owner': context.accountId });
    expect(tradeActivityBase(activity.kol.address, activity.token.address)).toBe(`/api/kols/${activity.kol.address}/tokens/${activity.token.address}`);
  });
  it('requires a current private membership and frozen snapshot contract', () => {
    const { activity, context, now } = journalReplayFixture();
    expect(prepareJournalReplay(activity, now, context)?.accounting.events).toHaveLength(3);
    expect(prepareJournalReplay(activity, now)).toBeUndefined();
    expect(prepareJournalReplay(activity, now, { ...context, snapshotId: 'c'.repeat(64) })).toBeUndefined();
    expect(prepareJournalReplay(activity, now, { ...context, accountId: '33333333-3333-4333-8333-333333333333' })).toBeUndefined();
    activity.journal.private = false as true;
    expect(prepareJournalReplay(activity, now, context)).toBeUndefined();
  });
  it('does not allow server metadata clock skew to authorize a future movement', () => {
    const { activity, context, now } = journalReplayFixture(), raw = activity.replayAccounting!;
    raw.history!.balanceProof.blockTimestamp = new Date(now + 1000).toISOString();
    raw.history!.events.at(-1)!.timestamp = new Date(now + 500).toISOString();
    expect(prepareJournalReplay(activity, now, context)).toBeUndefined();
  });
  it('requires exact decimal ending balance agreement without rounding different raw quantities together', () => {
    const { activity, context, now } = journalReplayFixture(), raw = activity.replayAccounting!;
    raw.history!.balanceProof.balance = '40.000000000000000001';
    raw.history!.events.at(-1)!.remainingTokenAmount = '40.000000000000000002';
    raw.final!.remainingTokenAmount = '40.000000000000000001';
    expect(prepareJournalReplay(activity, now, context)).toBeUndefined();
  });
  it('never exposes accounting from a differently selected private snapshot', () => {
    const { activity, context, now } = journalReplayFixture();
    const prepared = prepareTradeReplayData(activity, null, null, now, { ...context, snapshotId: 'c'.repeat(64) })!;
    expect(prepared.replayAccounting?.coverage.journalFinal).not.toBe(true);
    expect(validReplayAccountingFinal(prepared, now)).toBeNull();
  });
  it.each(['expired', 'wrong_wallet', 'wrong_token', 'wrong_block', 'duplicate_event', 'unordered', 'unknown_quantity', 'unreconciled', 'invalid_final'] as const)('rejects %s evidence', variant => {
    const { activity, context, now } = journalReplayFixture(), raw = activity.replayAccounting!;
    if (variant === 'expired') activity.journal.preparedAt = new Date(now - 180001).toISOString();
    if (variant === 'wrong_wallet') raw.walletAddress = activity.token.address;
    if (variant === 'wrong_token') raw.tokenAddress = activity.kol.address;
    if (variant === 'wrong_block') raw.inventoryBlockHash = `0x${'d'.repeat(64)}`;
    if (variant === 'duplicate_event') raw.history!.events[1].id = raw.history!.events[0].id;
    if (variant === 'unordered') raw.history!.events.reverse();
    if (variant === 'unknown_quantity') raw.history!.events[1].remainingTokenAmount = null;
    if (variant === 'unreconciled') raw.history!.balanceProof.balance = '41';
    if (variant === 'invalid_final') raw.final!.remainingTokenAmount = '41';
    expect(prepareJournalReplay(activity, now, context)).toBeUndefined();
  });
  it('preserves provider-only movements without manufacturing canonical block positions', () => {
    const { activity, context, now } = journalReplayFixture(), prepared = prepareJournalReplay(activity, now, context)!;
    expect(prepared.inventory.events.map(event => event.blockNumber)).toEqual([null, null, null]);
    expect(prepared.accounting.events[2]).toMatchObject({ kind: 'transfer_out', transferOutIncomeUsd: 50, feesUsd: 3.5 });
  });
  it('freezes the modal profit and export ending while retaining moving estimated history', async () => {
    const { activity, context, now, chartPoints } = journalReplayFixture(), data = prepareTradeReplayData(activity, null, null, now, context)!;
    data.chart = { ...data.chart, points: chartPoints, resolution: '30s', source: 'Historical market samples' };
    data.source.chart = 'Historical market samples'; data.currentQuote = { timestamp: new Date(now).toISOString(), priceUsd: 4, marketCapUsd: 40000 };
    expect(replayInventoryIsFresh(data, now)).toBe(true);
    expect(validReplayAccountingFinal(data, now)?.reportedProfitUsd).toBe(186.5);
    const context2d = new Proxy<Record<string, unknown>>({}, { get: (target, key) => key in target ? target[String(key)] : key === 'measureText' ? (value: string) => ({ width: value.length * 12 }) : key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => undefined });
    const renderer = new ReplayCanvas({ getContext: () => context2d } as unknown as HTMLCanvasElement);
    await renderer.setData(data);
    const ending = renderer.snapshot(1), first = renderer.snapshot(renderer.eventProgress(0));
    expect(ending.totalPnl).toBe(journalTokenProfit(activity, context, now));
    expect(ending.totalPnl).toBe(Number(activity.realizedAccounting!.position!.estimatedProfitUsd));
    expect(ending.totalRoi).toBe(Number(activity.realizedAccounting!.position!.estimatedRoi));
    expect(first.totalPnl).not.toBe(ending.totalPnl);
    expect(first.totalPnl).not.toBeNull();
    // Encoding can render out of order and must reproduce the same frozen ending.
    renderer.snapshot(.5); expect(renderer.snapshot(1)).toEqual(ending);
    activity.token.priceUsd = '100'; expect(renderer.snapshot(1)).toEqual(ending);
  });
});
