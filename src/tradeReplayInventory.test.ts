import { describe, expect, it } from 'vitest';
import ReplayCanvas from './tradeReplayCanvas';
import type { ReplayInventoryEvent, TradeReplayData } from './tradeReplayData';

const start = Date.parse('2026-10-13T10:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const hash = '0x' + 'a'.repeat(64);

function event(kind: ReplayInventoryEvent['kind'], seconds: number, remaining: number, basis: number | null,
  invested: number, sold: number, realized: number | null, tradeId?: string): ReplayInventoryEvent {
  return { id: `${kind}-${seconds}`, kind, tradeId, txHash: hash, timestamp: at(seconds),
    blockNumber: String(100 + seconds), transactionIndex: 0, logIndex: 1,
    tokenAmount: kind === 'transfer_out' ? 20 : 100, remainingTokenAmount: remaining,
    remainingCostBasisUsd: basis, investedUsd: invested, soldUsd: sold, cumulativeRealizedProfitUsd: realized };
}

function data(): TradeReplayData {
  return {
    kol: { address: '0x' + '1'.repeat(40), name: 'Trader', avatarUrl: null, twitter: null },
    token: { address: '0x' + '2'.repeat(40), symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: 4, marketCapUsd: 4000 },
    trades: [
      { id: 'buy', txHash: hash, timestamp: at(0), side: 'buy', tokenAmount: 100, amountUsd: 100, priceUsd: 1, marketCapUsd: 1000, cumulativeRealizedProfitUsd: 0 },
      { id: 'sell', txHash: hash, timestamp: at(60), side: 'sell', tokenAmount: 40, amountUsd: 80, priceUsd: 2, marketCapUsd: 2000, cumulativeRealizedProfitUsd: 40 },
      { id: 'rebuy', txHash: hash, timestamp: at(180), side: 'buy', tokenAmount: 10, amountUsd: 30, priceUsd: 3, marketCapUsd: 3000, cumulativeRealizedProfitUsd: 40 },
    ],
    position: { status: 'open', tokenBalance: 50, tradeFlowMatched: true, tradesComplete: true, checkedAt: at(240) },
    chart: { points: [0, 60, 120, 180, 240].map(seconds => ({ timestamp: at(seconds), priceUsd: 1 + seconds / 80, marketCapUsd: (1 + seconds / 80) * 1000 })),
      marketCapSupply: 1000, resolution: '1m', source: 'Historical market samples' },
    currentQuote: { timestamp: at(240), priceUsd: 4, marketCapUsd: 4000 },
    source: { chart: 'Historical market samples', tradesComplete: true }, realizedAccounting: { available: true }, generatedAt: at(240),
    inventory: { version: 1, coverage: { complete: true, reconciled: true, fromBlock: '100', toBlock: '340', blockHash: hash, checkedAt: at(240), balance: '50' }, events: [
      event('buy', 0, 100, 100, 100, 0, 0, 'buy'),
      event('sell', 60, 60, 60, 100, 80, 40, 'sell'),
      event('transfer_out', 120, 40, 40, 100, 80, 40),
      event('buy', 180, 50, 70, 130, 80, 40, 'rebuy'),
    ] },
  };
}

async function replay(payload = data()) {
  const context = new Proxy({}, { get: (_target, key) => key === 'measureText' ? (value: string) => ({ width: value.length * 20 })
    : key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => undefined });
  const renderer = new ReplayCanvas({ width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement);
  await renderer.setData(payload);
  return renderer;
}

function progressAt(renderer: ReplayCanvas, seconds: number) {
  let low = 0, high = .94;
  for (let index = 0; index < 60; index += 1) {
    const middle = (low + high) / 2;
    if (renderer.timeAt(middle) < start + seconds * 1000) low = middle; else high = middle;
  }
  return high;
}

describe('transfer-aware replay frames', () => {
  it('removes outgoing quantity and FIFO cost at the movement time without adding proceeds or markers', async () => {
    const renderer = await replay();
    const before = renderer.snapshot(progressAt(renderer, 120) - 1e-6);
    const after = renderer.snapshot(progressAt(renderer, 120) + 1e-6);
    expect(before.holdings).toBe(60); expect(before.remainingCostBasis).toBe(60);
    expect(after.holdings).toBe(40); expect(after.remainingCostBasis).toBe(40);
    expect(after.invested).toBe(100); expect(after.proceeds).toBe(80); expect(after.realizedPnl).toBe(40);
    expect(after.currentEventIndex).toBe(1); expect(renderer.markerPosition(3, 1)).toBeNull();
    const final = renderer.snapshot(1);
    expect(final.holdings).toBe(50); expect(final.remainingCostBasis).toBe(70);
    expect(final.totalPnl).toBe(170); expect(final.totalRoi).toBeCloseTo(170 / 130);
    expect(final.totalPnl).not.toBe(final.proceeds! + final.holdings! * final.currentPrice - final.invested!);
  });

  it('holds unavailable totals when movement coverage is pending or unreconciled', async () => {
    for (const field of ['complete', 'reconciled'] as const) {
      const payload = data(); payload.inventory!.coverage[field] = false;
      const renderer = await replay(payload);
      for (const progress of [0, renderer.eventProgress(1), .8, 1]) {
        const state = renderer.snapshot(progress);
        expect(state.totalPnl).toBeNull(); expect(state.unrealizedPnl).toBeNull(); expect(state.pnl).toBeNull();
      }
    }
  });

  it('withholds unknown-cost incoming lots rather than giving them zero cost', async () => {
    const payload = data();
    payload.inventory!.events[2] = event('transfer_in', 120, 80, null, 100, 80, 40);
    payload.inventory!.events[3] = event('buy', 180, 90, null, 130, 80, 40, 'rebuy');
    payload.position.tokenBalance = 90; payload.inventory!.coverage.balance = '90';
    const renderer = await replay(payload);
    expect(renderer.snapshot(renderer.eventProgress(1)).totalPnl).not.toBeNull();
    expect(renderer.snapshot(1).holdings).toBe(90); expect(renderer.snapshot(1).totalPnl).toBeNull();
  });

  it('finishes at a later transfer closure and keeps the position open until that event', async () => {
    const payload = data(); payload.trades.pop(); delete payload.currentQuote;
    payload.inventory!.events = payload.inventory!.events.slice(0, 2);
    payload.inventory!.events.push(event('transfer_out', 180, 0, 0, 100, 80, 40));
    payload.inventory!.coverage.balance = '0'; payload.position.status = 'closed'; payload.position.tokenBalance = 0;
    const renderer = await replay(payload);
    const lastSale = renderer.snapshot(renderer.eventProgress(1));
    expect(lastSale.holdings).toBe(60); expect(lastSale.status).toBe('Open');
    expect(renderer.snapshot(.9).holdings).toBe(60);
    const final = renderer.snapshot(1);
    expect(final.time).toBe(at(180)); expect(final.holdings).toBe(0); expect(final.remainingCostBasis).toBe(0);
    expect(final.unrealizedPnl).toBe(0); expect(final.totalPnl).toBe(40); expect(final.status).toBe('Closed');
    expect(final.proceeds).toBe(80); expect(final.currentEventIndex).toBe(1);
  });

  it('reveals a same-second transfer between paced fills in canonical order', async () => {
    const payload = data(); payload.trades[2].timestamp = at(60);
    payload.inventory!.events[2].timestamp = payload.inventory!.events[3].timestamp = at(60);
    const renderer = await replay(payload), before = renderer.eventProgress(1), after = renderer.eventProgress(2);
    expect(renderer.snapshot(before).holdings).toBe(60);
    expect(renderer.snapshot(before + (after - before) * .6).holdings).toBe(40);
    expect(renderer.snapshot(after).holdings).toBe(50);
  });

  it.each(['previous', 'next'] as const)('keeps a transfer sharing only the %s fill timestamp inside its canonical fill interval', async boundary => {
    const payload = data();
    payload.inventory!.events[2].timestamp = at(boundary === 'previous' ? 60 : 180);
    const renderer = await replay(payload), before = renderer.eventProgress(1), after = renderer.eventProgress(2);
    expect(renderer.snapshot(before).holdings).toBe(60);
    expect(renderer.snapshot(after - .001).holdings).toBe(40);
    expect(renderer.snapshot(after).holdings).toBe(50);
  });

  it('accepts verified inventory without the older swap-only flow match', async () => {
    const payload = data(); payload.position.tradeFlowMatched = false;
    const renderer = await replay(payload);
    expect(renderer.snapshot(1).pnl).toBe(170);
  });

  it('reveals a same-second closing transfer after the final paced sale', async () => {
    const payload = data(); payload.trades.pop(); delete payload.currentQuote;
    payload.inventory!.events = payload.inventory!.events.slice(0, 2);
    payload.inventory!.events.push(event('transfer_out', 60, 0, 0, 100, 80, 40));
    payload.inventory!.coverage.balance = '0'; payload.position.status = 'closed'; payload.position.tokenBalance = 0;
    const renderer = await replay(payload);
    expect(renderer.snapshot(renderer.eventProgress(1)).holdings).toBe(60);
    expect(renderer.snapshot(1).holdings).toBe(0); expect(renderer.snapshot(1).totalPnl).toBe(40);
  });

  it('withholds legacy ending profit when a checked balance disagrees with swap-only quantities', async () => {
    const payload = data(); delete payload.inventory;
    const renderer = await replay(payload);
    expect(renderer.snapshot(1).totalPnl).toBeNull(); expect(renderer.snapshot(1).pnl).toBeNull();
    expect(renderer.snapshot(1).status).toBe('Open');
  });

  it('preserves deterministic inventory prefixes when seeking or exporting out of order', async () => {
    const renderer = await replay(), points = [0, .19, .38, .58, .77, .9, 1];
    const snapshots = points.map(progress => renderer.snapshot(progress));
    for (const index of [6, 0, 5, 2, 4, 1, 3, 6]) {
      renderer.render(points[index]); expect(renderer.snapshot(points[index])).toEqual(snapshots[index]);
    }
  });
});
