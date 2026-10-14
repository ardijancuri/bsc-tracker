import { describe, expect, it } from 'vitest';
import ReplayCanvas from './tradeReplayCanvas';
import type { TradeReplayData, ReplayInventoryEvent } from './tradeReplayData';

const start = Date.parse('2026-10-13T10:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const hash = '0x' + 'a'.repeat(64);
function data(): TradeReplayData {
  const rows: [ReplayInventoryEvent['kind'], number, number, number, number, number, number, string | undefined][] = [
    ['buy', 0, 100, 100, 100, 0, 0, 'buy'],
    ['sell', 60, 60, 60, 100, 80, 40, 'sell'],
    ['transfer_out', 120, 40, 40, 100, 80, 40, undefined],
    ['buy', 180, 50, 70, 130, 80, 40, 'rebuy'],
  ];
  const events: ReplayInventoryEvent[] = rows.map(([kind, seconds, remaining, basis, invested, sold, realized, tradeId]) => ({
    id: `${kind}-${seconds}`, kind, tradeId, txHash: hash, timestamp: at(seconds), blockNumber: String(100 + seconds),
    transactionIndex: 0, logIndex: 1, tokenAmount: 100, remainingTokenAmount: remaining,
    remainingCostBasisUsd: basis, investedUsd: invested, soldUsd: sold, cumulativeRealizedProfitUsd: realized,
  }));
  const snapshots = [
    { remainingCostBasisUsd: 105, cumulativeRealizedProfitUsd: 0, feesUsd: 5, feeInclusiveCostUsd: 105, transferOutIncomeUsd: 0 },
    { remainingCostBasisUsd: 63, cumulativeRealizedProfitUsd: 36, feesUsd: 7, feeInclusiveCostUsd: 107, transferOutIncomeUsd: 0 },
    { remainingCostBasisUsd: 42, cumulativeRealizedProfitUsd: 74, feesUsd: 8, feeInclusiveCostUsd: 108, transferOutIncomeUsd: 60 },
    { remainingCostBasisUsd: 73, cumulativeRealizedProfitUsd: 74, feesUsd: 9, feeInclusiveCostUsd: 139, transferOutIncomeUsd: 60 },
  ];
  const accountingEvents = events.map((event, index) => ({ ...event, ...snapshots[index] }));
  return {
    kol: { address: '0x' + '1'.repeat(40), name: 'Trader', avatarUrl: null, twitter: null },
    token: { address: '0x' + '2'.repeat(40), symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: 4, marketCapUsd: 4000 },
    trades: [
      { id: 'buy', txHash: hash, timestamp: at(0), side: 'buy', tokenAmount: 100, amountUsd: 100, priceUsd: 1, marketCapUsd: 1000 },
      { id: 'sell', txHash: hash, timestamp: at(60), side: 'sell', tokenAmount: 40, amountUsd: 80, priceUsd: 2, marketCapUsd: 2000 },
      { id: 'rebuy', txHash: hash, timestamp: at(180), side: 'buy', tokenAmount: 10, amountUsd: 30, priceUsd: 3, marketCapUsd: 3000 },
    ],
    position: { status: 'open', tokenBalance: 50, tradeFlowMatched: false, tradesComplete: true, checkedAt: at(240) },
    chart: { points: [0, 60, 120, 180, 240].map(seconds => ({ timestamp: at(seconds), priceUsd: 1 + seconds / 80, marketCapUsd: (1 + seconds / 80) * 1000 })),
      marketCapSupply: 1000, resolution: '1m', source: 'Historical market samples' },
    currentQuote: { timestamp: at(240), priceUsd: 4, marketCapUsd: 4000 },
    source: { chart: 'Historical market samples', tradesComplete: true }, realizedAccounting: { available: true }, generatedAt: at(240),
    inventory: { version: 1, events, coverage: { complete: true, reconciled: true, fromBlock: '100', toBlock: '340', blockHash: hash, checkedAt: at(240), balance: '50' } },
    replayAccounting: { version: 1, source: 'gmgn', policy: 'gmgn_total_profit_v1', walletAddress: '0x' + '1'.repeat(40), tokenAddress: '0x' + '2'.repeat(40),
      status: 'ready', checkedAt: at(240), inventoryBlockNumber: '340', inventoryBlockHash: hash,
      events: accountingEvents, coverage: { transactionsComplete: true, balanceMatched: true, exactFinal: true },
      final: { ...accountingEvents[3], remainingCostBasisUsd: 73.1, cumulativeRealizedProfitUsd: 73.9,
        feesUsd: 9.2, feeInclusiveCostUsd: 139.2, reportedProfitUsd: 200.8, reportedRoi: 200.8 / 139.2, priceUsd: 4, timestamp: at(240) } },
  };
}
interface Drawing { strokes: { width: number; color: unknown }[]; gradients: string[]; text: { value: string; color: unknown }[] }
async function replay(payload = data(), drawing?: Drawing) {
  const context = new Proxy<Record<string, unknown>>({}, { get: (target, key) => key in target ? target[String(key)]
    : key === 'measureText' ? (value: string) => ({ width: value.length * 20 })
    : key === 'stroke' ? () => drawing?.strokes.push({ width: Number(target.lineWidth), color: target.strokeStyle })
    : key === 'fillText' ? (value: string) => drawing?.text.push({ value, color: target.fillStyle })
    : key === 'createLinearGradient' ? () => ({ addColorStop: (_offset: number, color: string) => drawing?.gradients.push(color) }) : () => undefined });
  const renderer = new ReplayCanvas({ getContext: () => context } as unknown as HTMLCanvasElement);
  await renderer.setData(payload);
  return renderer;
}
function progressAt(renderer: ReplayCanvas, seconds: number) {
  let low = 0, high = .94;
  for (let index = 0; index < 60; index++) {
    const middle = (low + high) / 2;
    if (renderer.timeAt(middle) < start + seconds * 1000) low = middle; else high = middle;
  }
  return high;
}

describe('GMGN profit in every replay frame', () => {
  it.each(['gain', 'loss'] as const)('uses neutral unknown-cost frames and the displayed %s color at the verified ending', async direction => {
    const payload = data();
    payload.replayAccounting!.events[3].remainingCostBasisUsd = null;
    payload.replayAccounting!.events[3].cumulativeRealizedProfitUsd = null;
    payload.replayAccounting!.events[3].feeInclusiveCostUsd = null;
    if (direction === 'loss') {
      payload.replayAccounting!.final!.cumulativeRealizedProfitUsd = -327.7;
      payload.replayAccounting!.final!.reportedProfitUsd = -200.8;
      payload.replayAccounting!.final!.reportedRoi = -200.8 / 139.2;
    }
    const drawing: Drawing = { strokes: [], gradients: [], text: [] };
    const renderer = await replay(payload, drawing);
    for (const progress of [.9, 1, .9, 1]) {
      drawing.strokes.length = drawing.gradients.length = drawing.text.length = 0;
      const state = renderer.snapshot(progress);
      renderer.render(progress);
      const color = progress === .9 ? '#a9a69a' : direction === 'gain' ? '#16c784' : '#f6465d';
      const rgb = progress === .9 ? '169,166,154' : direction === 'gain' ? '22,199,132' : '246,70,93';
      expect(drawing.strokes.find(stroke => stroke.width === 8)?.color).toBe(color);
      expect(drawing.gradients).toContain(`rgba(${rgb},0.18)`);
      expect(drawing.strokes.some(stroke => stroke.width === 8 && stroke.color === '#f0b90b')).toBe(false);
      if (progress === .9) {
        expect(state.totalPnl).toBeNull();
        expect(drawing.text.some(text => text.value === '—')).toBe(true);
      } else {
        expect(state.totalPnl).toBe(direction === 'gain' ? 200.8 : -200.8);
        expect(drawing.text.some(text => /^[+−]\$200\.80$/.test(text.value) && text.color === color)).toBe(true);
      }
    }
  });

  it('changes the line with fee-inclusive displayed profit and reproduces colors when seeking backward', async () => {
    const drawing: Drawing = { strokes: [], gradients: [], text: [] };
    const renderer = await replay(data(), drawing);
    const first = renderer.eventProgress(0), sold = renderer.eventProgress(1);
    for (const progress of [first, sold, 1, sold, first]) {
      drawing.strokes.length = drawing.gradients.length = drawing.text.length = 0;
      const state = renderer.snapshot(progress);
      expect(state.totalPnl).not.toBeNull();
      const color = state.totalPnl! >= 0 ? '#16c784' : '#f6465d';
      const rgb = state.totalPnl! >= 0 ? '22,199,132' : '246,70,93';
      renderer.render(progress);
      expect(drawing.strokes.find(stroke => stroke.width === 8)?.color).toBe(color);
      expect(drawing.gradients).toContain(`rgba(${rgb},0.18)`);
      expect(drawing.text.some(text => /^[+−]\$/.test(text.value) && text.color === color)).toBe(true);
    }
    expect(renderer.snapshot(first).totalPnl).toBe(-5);
    expect(renderer.snapshot(sold).totalPnl).toBeGreaterThan(0);
  });

  it('credits marked outgoing gain only when revealed and includes fees exactly once', async () => {
    const renderer = await replay();
    const before = renderer.snapshot(progressAt(renderer, 120) - 1e-6);
    const after = renderer.snapshot(progressAt(renderer, 120) + 1e-6);
    expect(before.realizedPnl).toBe(36); expect(after.realizedPnl).toBe(74);
    expect(after.holdings).toBe(40); expect(after.remainingCostBasis).toBe(42);
    expect(after.proceeds).toBe(80); expect(after.currentEventIndex).toBe(1);
    expect(renderer.markerPosition(3, 1)).toBeNull();
    expect(after.totalPnl).toBeCloseTo(74 + 40 * after.currentPrice - 42);
    expect(after.totalRoi).toBeCloseTo(after.totalPnl! / 108);
  });

  it('uses the exact provider snapshot only at the ending, without moving residuals into earlier frames', async () => {
    const renderer = await replay();
    const before = renderer.snapshot(renderer.eventProgress(2));
    expect(before.realizedPnl).toBe(74); expect(before.remainingCostBasis).toBe(73);
    const final = renderer.snapshot(1);
    expect(final.totalPnl).toBe(200.8); expect(final.totalRoi).toBe(200.8 / 139.2);
    expect(final.realizedPnl).toBe(73.9); expect(final.remainingCostBasis).toBe(73.1);
    expect(final.invested).toBe(130);
    expect(renderer.snapshot(renderer.eventProgress(2))).toEqual(before);
  });

  it('reprices only remaining holdings when the selected final quote differs', async () => {
    const payload = data(); payload.currentQuote!.priceUsd = 5;
    const renderer = await replay(payload), final = renderer.snapshot(1);
    expect(final.totalPnl).toBeCloseTo(250.8); expect(final.totalRoi).toBeCloseTo(250.8 / 139.2);
    expect(final.realizedPnl).toBe(73.9);
  });

  it('uses derived activity totals when an exact provider position is absent', async () => {
    const payload = data(); payload.replayAccounting!.status = 'estimated';
    payload.replayAccounting!.coverage.exactFinal = false; payload.replayAccounting!.final = null;
    const final = (await replay(payload)).snapshot(1);
    expect(final.totalPnl).toBe(201); expect(final.totalRoi).toBe(201 / 139);
  });

  it('withholds requested GMGN profit instead of silently reverting to the old swap ledger', async () => {
    for (const status of ['unavailable', 'pending'] as const) {
      const payload = data(); payload.replayAccounting!.status = status;
      const renderer = await replay(payload);
      for (const p of [0, .5, 1]) {
        const state = renderer.snapshot(p);
        expect(state.totalPnl).toBeNull(); expect(state.pnl).toBeNull(); expect(state.totalRoi).toBeNull();
      }
    }
  });

  it('withholds unknown incoming cost before a separately verified final aggregate', async () => {
    const payload = data();
    payload.replayAccounting!.events[3].remainingCostBasisUsd = null;
    payload.replayAccounting!.events[3].cumulativeRealizedProfitUsd = null;
    payload.replayAccounting!.events[3].feeInclusiveCostUsd = null;
    expect((await replay(payload)).snapshot(.9).totalPnl).toBeNull();
    expect((await replay(payload)).snapshot(1).totalPnl).toBe(200.8);
  });

  it('displays the moving total from complete cash flows when the realized and held-basis allocation is unknown', async () => {
    const payload = data();
    payload.replayAccounting!.events[3].remainingCostBasisUsd = null;
    payload.replayAccounting!.events[3].cumulativeRealizedProfitUsd = null;
    const renderer = await replay(payload);
    const earlier = renderer.snapshot(.8), later = renderer.snapshot(.9);
    for (const state of [earlier, later]) {
      expect(state.realizedPnl).toBeNull(); expect(state.unrealizedPnl).toBeNull();
      expect(state.totalPnl).toBeCloseTo(80 + 60 + 50 * state.currentPrice - 139);
      expect(state.totalRoi).toBeCloseTo(state.totalPnl! / 139);
    }
    expect(later.totalPnl).not.toBe(earlier.totalPnl);
    expect(renderer.snapshot(1).totalPnl).toBe(200.8);
    expect(renderer.snapshot(.8)).toEqual(earlier);
  });

  it('withholds estimated profit when basis is known but fees are unavailable', async () => {
    const payload = data();
    payload.replayAccounting!.events[3].feesUsd = null;
    payload.replayAccounting!.events[3].feeInclusiveCostUsd = null;
    const renderer = await replay(payload);
    expect(renderer.snapshot(.9).totalPnl).toBeNull(); expect(renderer.snapshot(.9).pnl).toBeNull();
    expect(renderer.snapshot(.9).totalRoi).toBeNull();
    expect(renderer.snapshot(1).totalPnl).toBe(200.8);
  });
});
