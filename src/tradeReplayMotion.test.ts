import { describe, expect, it } from 'vitest';
import ReplayCanvas from './tradeReplayCanvas';
import type { TradeReplayData } from './tradeReplayData';
import { selectReplaySellHighlights } from './tradeReplayHighlights';

const start = Date.parse('2026-10-11T10:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();

interface Viewport {
  time: number;
  startTime: number;
  endTime: number;
  spanTime: number;
  yMin: number;
  yMax: number;
  startQ: number;
  endQ: number;
}
interface Marker {
  index: number;
  ts: number;
  x: number;
  y: number;
  anchorY: number;
  marketValue: number;
  executionValue: number | null;
  visible: boolean;
  alpha: number;
  q: number;
}
interface MotionMethods {
  storyWindow: number;
  markerRadius: number;
  storyVertices: { ts: number; q: number; priceUsd: number; marketCapUsd: number }[];
  timeAt(progress: number): number;
  progressAtTime(timestamp: number): number;
  chartProgress(progress: number): number;
  viewportAt(progress: number): Viewport;
  valueAtTime(timestamp: number): { priceUsd: number; marketCapUsd: number };
  valueAtStory(progress: number): { priceUsd: number; marketCapUsd: number };
  cameraAt(progress: number): { min: number; max: number };
  markerPosition(index: number, progress: number): Marker | null;
  visibleLine(progress: number, viewport?: Viewport): { ts: number; q: number; cap: number; x: number; y: number }[];
}

function data(): TradeReplayData {
  return {
    kol: { address: '0x1111111111111111111111111111111111111111', name: 'Trader', avatarUrl: null, twitter: null },
    token: { address: '0x2222222222222222222222222222222222222222', symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: 4, marketCapUsd: 4000 },
    trades: [
      { id: 'first', txHash: '0xfirst', timestamp: at(0), side: 'buy', tokenAmount: 1, amountUsd: 2, priceUsd: 2, marketCapUsd: 2000 },
      { id: 'same-buy', txHash: '0xsamebuy', timestamp: at(60), side: 'buy', tokenAmount: 1, amountUsd: 20, priceUsd: 20, marketCapUsd: 20000 },
      { id: 'same-sell', txHash: '0xsamesell', timestamp: at(60), side: 'sell', tokenAmount: 1, amountUsd: 30, priceUsd: 30, marketCapUsd: 30000 },
      { id: 'last', txHash: '0xlast', timestamp: at(300), side: 'sell', tokenAmount: 1, amountUsd: 50, priceUsd: 50, marketCapUsd: 50000 },
    ],
    position: { status: 'closed', tokenBalance: 0, tradeFlowMatched: true, tradesComplete: true, checkedAt: at(360) },
    chart: {
      points: [-120, 0, 60, 120, 300, 360].map((seconds, index) => ({ timestamp: at(seconds), priceUsd: [1, 2, 3, 5, 4, 4][index], marketCapUsd: [1000, 2000, 3000, 5000, 4000, 4000][index] })),
      marketCapSupply: 1000, resolution: '5m', source: 'Historical market samples',
    },
    source: { chart: 'Historical market samples', tradesComplete: true },
    generatedAt: at(360),
  };
}

function longPosition(tailSeconds = 8 * 60): TradeReplayData {
  const payload = data(), tradeEnd = 32 * 3600, endpoint = tradeEnd + tailSeconds;
  const times = [0, 8 * 3600, 16 * 3600, tradeEnd];
  const prices = [8, 250, 600, 1400], amounts = [100, 20, 40, 30];
  const realized = [0, 0, 23_680, 65_440];
  payload.trades = payload.trades.map((trade, index) => ({ ...trade, timestamp: at(times[index]),
    tokenAmount: amounts[index], amountUsd: prices[index] * amounts[index], priceUsd: prices[index], marketCapUsd: prices[index] * 1000,
    cumulativeRealizedProfitUsd: realized[index] }));
  payload.realizedAccounting = { available: true };
  payload.position = { ...payload.position, status: 'open', tokenBalance: 50, checkedAt: at(endpoint) };
  payload.chart.points = [
    ...times.map((seconds, index) => ({ timestamp: at(seconds), priceUsd: prices[index], marketCapUsd: prices[index] * 1000 })),
    ...[1402, 1425, 1418].map((price, index) => ({ timestamp: at(tradeEnd + tailSeconds * (index + 1) / 4), priceUsd: price, marketCapUsd: price * 1000 })),
  ];
  payload.currentQuote = { timestamp: at(endpoint), priceUsd: 1430, marketCapUsd: 1_430_000 };
  payload.generatedAt = at(endpoint);
  return payload;
}

function densePosition(rising = false): TradeReplayData {
  const payload = data();
  let realized = 0;
  payload.trades = Array.from({ length: 40 }, (_, index) => {
    const price = 100 + (rising ? index : 0);
    if (index % 2) realized += rising ? 1 : 0;
    return { id: `dense-${index}`, txHash: `0xdense${index}`, timestamp: at(index * 60 + (index >= 20 ? -59 : 0)),
      side: index % 2 ? 'sell' as const : 'buy' as const, tokenAmount: 1,
      amountUsd: price, priceUsd: price, marketCapUsd: price * 1000,
      cumulativeRealizedProfitUsd: realized };
  });
  payload.realizedAccounting = { available: true };
  payload.position.checkedAt = payload.trades.at(-1)!.timestamp;
  payload.chart.points = payload.trades.map(trade => ({ timestamp: trade.timestamp,
    priceUsd: trade.priceUsd!, marketCapUsd: trade.marketCapUsd }));
  payload.generatedAt = payload.position.checkedAt!;
  return payload;
}

function atomicPosition(): TradeReplayData {
  const payload = densePosition();
  payload.trades[20].timestamp = payload.trades[19].timestamp;
  let invested = 0, sold = 0, balance = 0;
  const events = payload.trades.map((trade, index) => {
    if (trade.side === 'buy') { invested += trade.amountUsd!; balance += trade.tokenAmount!; }
    else { sold += trade.amountUsd!; balance -= trade.tokenAmount!; }
    return { id: `movement-${index}`, tradeId: trade.id, kind: trade.side, txHash: trade.txHash, timestamp: trade.timestamp,
      blockNumber: String(index + 1), transactionIndex: 0, logIndex: index, tokenAmount: trade.tokenAmount,
      remainingTokenAmount: balance, remainingCostBasisUsd: balance * 100, cumulativeRealizedProfitUsd: 0,
      investedUsd: invested, soldUsd: sold, transferOutIncomeUsd: 0, feesUsd: 0, feeInclusiveCostUsd: invested };
  });
  payload.inventory = { version: 1, events, coverage: { complete: true, reconciled: true, fromBlock: '1', toBlock: '40',
    blockHash: '0xconfirmed', checkedAt: payload.generatedAt, balance: '0' } };
  payload.replayAccounting = { version: 2, source: 'node', policy: 'kollens_fifo_v1', walletAddress: payload.kol.address,
    tokenAddress: payload.token.address, status: 'ready', checkedAt: payload.generatedAt,
    inventoryBlockNumber: '40', inventoryBlockHash: '0xconfirmed', events,
    final: { ...events.at(-1)!, timestamp: payload.generatedAt, reportedProfitUsd: 0, reportedRoi: 0, priceUsd: null },
    coverage: { transactionsComplete: true, balanceMatched: true, exactFinal: true, verification: 'node_history' } };
  payload.chart.points = payload.trades.map(trade => ({ timestamp: trade.timestamp, priceUsd: 100, marketCapUsd: 100000 }));
  return payload;
}

interface PaintedArc {
  x: number;
  y: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  color: string;
  alpha: number;
}

function canvasStub(drawn?: { value: string; x: number; y: number; alpha: number }[], painted?: PaintedArc[],
  filled?: { x: number; y: number; width: number; height: number }[]): HTMLCanvasElement {
  let currentArc: Omit<PaintedArc, 'color' | 'alpha'> | null = null;
  const context = new Proxy({}, {
    get: (target, key) => key === 'measureText' ? (value: string) => ({ width: value.length * 20 })
      : key === 'fillText' ? (value: string, x: number, y: number) => drawn?.push({ value, x, y, alpha: (target as { globalAlpha?: number }).globalAlpha ?? 1 })
      : key === 'fillRect' ? (x: number, y: number, width: number, height: number) => filled?.push({ x, y, width, height })
      : key === 'beginPath' ? () => { currentArc = null; }
      : key === 'arc' ? (x: number, y: number, radius: number, startAngle: number, endAngle: number) => { currentArc = { x, y, radius, startAngle, endAngle }; }
      : key === 'fill' ? () => {
        if (currentArc) painted?.push({ ...currentArc, color: (target as { fillStyle?: string }).fillStyle ?? '', alpha: (target as { globalAlpha?: number }).globalAlpha ?? 1 });
      }
      : key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => undefined,
  });
  return { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
}

async function replay(payload = data()) {
  const renderer = new ReplayCanvas(canvasStub());
  await renderer.setData(payload);
  return { renderer, motion: renderer as ReplayCanvas & MotionMethods };
}

const activeX = 42 + 772 * .74;

describe('handoff replay canvas geometry', () => {
  it('paces simultaneous fills separately while retaining every exact execution timestamp', async () => {
    const { renderer, motion } = await replay();
    const progress = renderer.eventProgress(3);
    const buy = motion.markerPosition(1, progress)!;
    const sell = motion.markerPosition(2, progress)!;
    expect(buy.ts).toBe(start + 60000); expect(sell.ts).toBe(buy.ts);
    expect(sell.q).toBeGreaterThan(buy.q); expect(sell.x).toBeGreaterThan(buy.x);
    for (let index = 0; index < 4; index += 1) {
      const marker = motion.markerPosition(index, progress)!;
      expect(motion.timeAt(renderer.eventProgress(index))).toBe(Date.parse(data().trades[index].timestamp));
      expect(marker.x).toBeCloseTo(42 + (marker.q - motion.viewportAt(progress).startQ) / motion.storyWindow * 772, 10);
    }
  });

  it('places each compact circle directly on its exact fill vertex', async () => {
    const { renderer, motion } = await replay();
    for (let index = 0; index < 4; index += 1) {
      const progress = renderer.eventProgress(index);
      const marker = motion.markerPosition(index, progress)!;
      const fill = motion.storyVertices.find(point => point.q === progress)!;
      const viewport = motion.viewportAt(progress);
      expect(fill.marketCapUsd).toBe(data().trades[index].marketCapUsd);
      expect(marker.marketValue).toBe(fill.marketCapUsd);
      expect(marker.executionValue).toBe(fill.marketCapUsd);
      expect(marker.x).toBeCloseTo(activeX, 10);
      const fillY = 651 - (fill.marketCapUsd - viewport.yMin) / (viewport.yMax - viewport.yMin) * 379;
      expect(marker.y).toBeCloseTo(fillY, 10);
      expect(marker.anchorY).toBeCloseTo(fillY, 10);
    }
  });

  it('keeps dense trades readable and limits horizontal movement despite a one-second trade gap', async () => {
    const payload = densePosition(true);
    expect(Date.parse(payload.trades[20].timestamp) - Date.parse(payload.trades[19].timestamp)).toBe(1000);
    const { renderer, motion } = await replay(payload);
    expect(motion.storyWindow).toBeGreaterThanOrEqual(.32);
    expect(motion.markerRadius).toBeGreaterThanOrEqual(18);
    expect(motion.markerRadius).toBeLessThanOrEqual(22);
    expect(renderer.getDuration()).toBe(15.5);
    for (let index = 0; index < payload.trades.length; index += 1) {
      const event = renderer.eventProgress(index);
      expect(motion.timeAt(event)).toBe(Date.parse(payload.trades[index].timestamp));
      expect(renderer.snapshot(event).currentEventIndex).toBe(index);
    }
    const frames = Math.round(renderer.getDuration() * 30);
    let previous = motion.markerPosition(0, 0)!.x;
    for (let frame = 1; frame < frames; frame += 1) {
      const current = motion.markerPosition(0, frame / (frames - 1))!.x;
      expect(previous - current).toBeGreaterThanOrEqual(-1e-9);
      expect(previous - current).toBeLessThanOrEqual(5.3);
      previous = current;
    }
    const final = renderer.snapshot(1);
    const invested = payload.trades.filter(trade => trade.side === 'buy').reduce((total, trade) => total + trade.amountUsd!, 0);
    const sold = payload.trades.filter(trade => trade.side === 'sell').reduce((total, trade) => total + trade.amountUsd!, 0);
    expect(final.time).toBe(payload.trades.at(-1)!.timestamp);
    expect(final.currentPrice).toBe(payload.trades.at(-1)!.priceUsd);
    expect(final.totalPnl).toBe(sold - invested);
    expect(final.totalRoi).toBe((sold - invested) / invested);
  });

  it.each([false, true])('keeps dense %s-price markers on the curve without shifting trade times or moving between seeks', async rising => {
    const payload = densePosition(rising), { renderer, motion } = await replay(payload);
    for (let frame = 0; frame < 465; frame += 1) {
      const progress = frame / 464;
      const markers = payload.trades.map((_, index) => motion.markerPosition(index, progress)!)
        .filter(marker => marker.visible);
      for (let index = 0; index < markers.length; index += 1) {
        const marker = markers[index], viewport = motion.viewportAt(progress);
        expect(marker.ts).toBe(Date.parse(payload.trades[marker.index].timestamp));
        expect(marker.x).toBeCloseTo(42 + (marker.q - viewport.startQ) / motion.storyWindow * 772, 10);
        const fillY = 651 - (marker.executionValue! - viewport.yMin) / (viewport.yMax - viewport.yMin) * 379;
        expect(marker.y).toBeCloseTo(fillY, 10);
        expect(marker.anchorY).toBeCloseTo(fillY, 10);
      }
    }
    const progress = renderer.eventProgress(20) + .005;
    const expected = { viewport: motion.viewportAt(progress), snapshot: renderer.snapshot(progress),
      markers: payload.trades.map((_, index) => motion.markerPosition(index, progress)) };
    for (const seek of [1, .02, .8, 0, .4, progress]) renderer.render(seek);
    expect({ viewport: motion.viewportAt(progress), snapshot: renderer.snapshot(progress),
      markers: payload.trades.map((_, index) => motion.markerPosition(index, progress)) }).toEqual(expected);
  });

  it('retains atomic same-second movement groups without collapsing the viewport or marker size', async () => {
    const payload = atomicPosition(), { renderer, motion } = await replay(payload);
    const shared = renderer.eventProgress(19);
    expect(renderer.eventProgress(20)).toBe(shared);
    expect(motion.timeAt(shared)).toBe(Date.parse(payload.trades[19].timestamp));
    expect(motion.markerPosition(19, shared)!.x).toBe(motion.markerPosition(20, shared)!.x);
    expect(motion.markerPosition(19, shared)!.y).toBe(motion.markerPosition(20, shared)!.y);
    expect(renderer.snapshot(shared).currentEventIndex).toBe(20);
    expect(motion.storyWindow).toBeGreaterThanOrEqual(.32);
    expect(motion.markerRadius).toBeGreaterThanOrEqual(18);
    expect(motion.markerRadius).toBeLessThanOrEqual(22);
    expect(renderer.getDuration()).toBe(15.5);
    expect(renderer.snapshot(1)).toEqual(expect.objectContaining({ time: payload.trades.at(-1)!.timestamp,
      totalPnl: 0, totalRoi: 0, currentEventIndex: 39 }));
  });

  it('keeps exact first and last fill times and holds the entire final geometry', async () => {
    const { renderer, motion } = await replay();
    const closing = renderer.eventProgress(3);
    expect(motion.timeAt(0)).toBe(start); expect(renderer.snapshot(0).currentEventIndex).toBe(0);
    expect(motion.timeAt(closing)).toBe(start + 300000); expect(motion.timeAt(1)).toBe(start + 300000);
    expect(motion.chartProgress(1)).toBe(closing);
    expect(motion.viewportAt(1)).toEqual(motion.viewportAt(closing));
    expect(renderer.snapshot(1).currentPrice).toBe(50);
    expect(renderer.snapshot(1).currentPrice).toBe(renderer.snapshot(closing).currentPrice);
    const marker = motion.markerPosition(3, closing)!;
    expect(motion.markerPosition(3, 1)).toEqual(expect.objectContaining({ ts: marker.ts, x: marker.x, y: marker.y, marketValue: marker.marketValue, visible: true, alpha: 1 }));
  });

  it.each(['open', 'unknown'] as const)('keeps an %s recap at the final fill when no explicit fresh current quote is available', async status => {
    const payload = data();
    payload.position = { ...payload.position, status, tokenBalance: status === 'open' ? 1 : null, tradeFlowMatched: false };
    payload.chart.points.at(-1)!.priceUsd = 999; payload.chart.points.at(-1)!.marketCapUsd = 999000;
    const { renderer, motion } = await replay(payload);
    expect(Date.parse(renderer.snapshot(1).time!)).toBe(start + 300000);
    expect(renderer.snapshot(1).currentPrice).toBe(50);
    expect(motion.viewportAt(1)).toEqual(motion.viewportAt(renderer.eventProgress(3)));
    expect(motion.storyVertices.some(point => point.priceUsd === 999)).toBe(false);
  });

  it('continues an open position through post-trade observations to the current quote, then holds the final view', async () => {
    const payload = data();
    payload.trades = payload.trades.slice(0, 3);
    payload.position = { ...payload.position, status: 'open', tokenBalance: 1 };
    payload.currentQuote = { timestamp: at(3600), priceUsd: 9.5, marketCapUsd: 9500 };
    payload.generatedAt = at(3600);
    const { renderer, motion } = await replay(payload);
    const lastFill = renderer.eventProgress(2);
    expect(motion.timeAt(lastFill)).toBe(start + 60000);
    expect(motion.timeAt(.8)).toBeGreaterThan(start + 60000);
    expect(motion.timeAt(1)).toBe(start + 3600000);
    expect(renderer.snapshot(1).currentPrice).toBe(9.5);
    expect(renderer.snapshot(1).currentCap).toBe(9500);
    expect(motion.viewportAt(.85).startQ).toBeGreaterThan(motion.viewportAt(lastFill).startQ);
    expect(motion.viewportAt(1)).toEqual(motion.viewportAt(.94));
    expect(renderer.snapshot(1).currentEventIndex).toBe(2);
    expect(motion.storyVertices.some(point => point.ts === start + 300000)).toBe(true);
    const expected = { view: motion.viewportAt(.8), state: renderer.snapshot(.8) };
    for (const progress of [1, .25, .9, 0, .8]) renderer.render(progress);
    expect({ view: motion.viewportAt(.8), state: renderer.snapshot(.8) }).toEqual(expected);
  });

  it('animates a single still-open buy to its current quote without adding another transaction', async () => {
    const payload = data();
    payload.trades = payload.trades.slice(0, 1);
    payload.position = { ...payload.position, status: 'open', tokenBalance: 1 };
    payload.currentQuote = { timestamp: at(3600), priceUsd: 4, marketCapUsd: 4000 };
    const { renderer, motion } = await replay(payload);
    expect(renderer.eventProgress(0)).toBe(0);
    expect(motion.timeAt(.5)).toBeGreaterThan(start);
    expect(renderer.snapshot(1).time).toBe(at(3600));
    expect(renderer.snapshot(1).currentPrice).toBe(4);
    expect(renderer.snapshot(1).currentEventIndex).toBe(0);
    expect(motion.markerPosition(1, 1)).toBeNull();
  });

  it('plays a short post-trade tail briefly while preserving every market observation and the final result', async () => {
    const payload = longPosition();
    const { renderer, motion } = await replay(payload);
    const lastFill = renderer.eventProgress(payload.trades.length - 1), endpoint = motion.chartProgress(1);
    const tailDuration = (endpoint - lastFill) * renderer.getDuration();
    expect(tailDuration).toBeGreaterThan(0); expect(tailDuration).toBeLessThan(1);
    expect((1 - endpoint) * renderer.getDuration()).toBeLessThan(1);
    for (const point of payload.chart.points) {
      const time = Date.parse(point.timestamp), progress = motion.progressAtTime(time);
      expect(motion.timeAt(progress)).toBeCloseTo(time, 0);
      expect(motion.valueAtStory(progress).priceUsd).toBeCloseTo(point.priceUsd, 8);
      expect(motion.storyVertices.some(vertex => vertex.ts === time && vertex.priceUsd === point.priceUsd)).toBe(true);
    }
    const final = renderer.snapshot(1);
    expect(final.time).toBe(payload.currentQuote!.timestamp);
    expect(final.currentPrice).toBe(1430); expect(final.currentCap).toBe(1_430_000);
    expect(final.totalPnl).toBeCloseTo(66_000 + 50 * 1430 - 5800, 8);
    expect(renderer.snapshot(endpoint)).toEqual(final);
    let previous = motion.timeAt(0);
    for (let frame = 1; frame <= 500; frame += 1) {
      const time = motion.timeAt(frame / 500);
      expect(Number.isFinite(time)).toBe(true); expect(time).toBeGreaterThanOrEqual(previous); previous = time;
    }
  });

  it('shows a take-profit transition only after a large sale with known profit without changing accounting', async () => {
    const payload = longPosition(), original = structuredClone(payload);
    const drawn: { value: string; x: number; y: number; alpha: number }[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(payload);
    const sale = renderer.eventProgress(2), emphasized = sale + .2 / renderer.getDuration();
    drawn.length = 0; renderer.render(sale - 1e-7);
    expect(renderer.snapshot(sale - 1e-7).currentEventIndex).toBe(1);
    expect(drawn.some(label => /^(TAKE PROFIT|BIG SELL)/.test(label.value))).toBe(false);
    drawn.length = 0; renderer.render(emphasized);
    const badge = drawn.find(label => label.value.startsWith('TAKE PROFIT'));
    expect(badge).toBeDefined(); expect(badge!.alpha).toBeGreaterThan(0);
    expect(drawn.some(label => label.value.startsWith('BIG SELL'))).toBe(false);
    const expected = { badge, snapshot: renderer.snapshot(emphasized) };
    for (const seek of [1, 0, .9, sale - 1e-7, emphasized]) renderer.render(seek);
    drawn.length = 0; renderer.render(emphasized);
    expect({ badge: drawn.find(label => label.value.startsWith('TAKE PROFIT')),
      snapshot: renderer.snapshot(emphasized) }).toEqual(expected);
    drawn.length = 0; renderer.render(1);
    expect(drawn.some(label => /^(TAKE PROFIT|BIG SELL)/.test(label.value))).toBe(false);
    expect(renderer.snapshot(1)).toEqual(expect.objectContaining({ time: payload.currentQuote!.timestamp,
      currentPrice: 1430, totalPnl: 131700, totalRoi: 131700 / 5800, realizedPnl: 65440 }));
    expect(renderer.getDuration()).toBe(15.5);
    expect(payload).toEqual(original);
  });

  it('labels a large sale with unknown profit Big sell without inventing take-profit accounting', async () => {
    const payload = longPosition();
    for (const trade of payload.trades) delete trade.cumulativeRealizedProfitUsd;
    payload.realizedAccounting = { available: false };
    const original = structuredClone(payload);
    const drawn: { value: string; x: number; y: number; alpha: number }[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(payload);
    const sale = renderer.eventProgress(2), emphasized = sale + .2 / renderer.getDuration();
    drawn.length = 0; renderer.render(sale - 1e-7);
    expect(drawn.some(label => /^(TAKE PROFIT|BIG SELL)/.test(label.value))).toBe(false);
    drawn.length = 0; renderer.render(emphasized);
    const badge = drawn.find(label => label.value.startsWith('BIG SELL'));
    expect(badge).toBeDefined(); expect(badge!.alpha).toBeGreaterThan(0);
    expect(drawn.some(label => label.value.startsWith('TAKE PROFIT'))).toBe(false);
    expect(renderer.snapshot(emphasized).realizedPnl).toBeNull();
    expect(renderer.snapshot(emphasized).totalPnl).toBeNull();
    const expected = { badge, snapshot: renderer.snapshot(emphasized) };
    for (const seek of [1, .01, .8, 0, emphasized]) renderer.render(seek);
    drawn.length = 0; renderer.render(emphasized);
    expect({ badge: drawn.find(label => label.value.startsWith('BIG SELL')),
      snapshot: renderer.snapshot(emphasized) }).toEqual(expected);
    drawn.length = 0; renderer.render(1);
    expect(drawn.some(label => /^(TAKE PROFIT|BIG SELL)/.test(label.value))).toBe(false);
    expect(renderer.snapshot(1)).toEqual(expect.objectContaining({ time: payload.currentQuote!.timestamp,
      currentPrice: 1430, realizedPnl: null, totalPnl: null, totalRoi: null }));
    expect(renderer.getDuration()).toBe(15.5);
    expect(payload).toEqual(original);
  });

  it('keeps the regular chart scale around a large sale with its line, markers and price guide aligned', async () => {
    const drawn: { value: string; x: number; y: number; alpha: number }[] = [], painted: PaintedArc[] = [];
    const filled: { x: number; y: number; width: number; height: number }[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn, painted, filled)); await renderer.setData(longPosition());
    const motion = renderer as ReplayCanvas & MotionMethods;
    const sale = renderer.eventProgress(2), progress = sale + .7 / renderer.getDuration();
    const viewport = motion.viewportAt(progress), span = viewport.endQ - viewport.startQ;
    expect(span).toBeCloseTo(motion.storyWindow, 10);
    const state = renderer.snapshot(progress), baseCamera = motion.cameraAt(motion.chartProgress(progress));
    expect(viewport.yMin).toBe(baseCamera.min);
    expect(viewport.yMax).toBe(baseCamera.max);
    const tip = motion.visibleLine(progress, viewport).at(-1)!;
    expect(tip.cap).toBe(state.currentCap); expect(tip.q).toBe(motion.chartProgress(progress));
    expect(tip.x).toBeCloseTo(activeX, 10);
    const quoteY = 651 - (state.currentCap - viewport.yMin) / (viewport.yMax - viewport.yMin) * 379;
    expect(tip.y).toBeCloseTo(quoteY, 10);
    expect(motion.visibleLine(progress).every(point => point.q <= motion.chartProgress(progress))).toBe(true);
    const marker = motion.markerPosition(2, progress)!;
    expect(marker.x).toBeCloseTo(42 + (marker.q - viewport.startQ) / span * 772, 10);
    expect(marker.y).toBeCloseTo(651 - (marker.executionValue! - viewport.yMin) / (viewport.yMax - viewport.yMin) * 379, 10);
    drawn.length = 0; painted.length = 0; filled.length = 0; renderer.render(progress);
    expect(drawn.find(label => label.x === 938)?.y).toBeCloseTo(Math.min(645, Math.max(278, quoteY)) + 1, 10);
    expect(painted.find(arc => arc.radius === 4 && Math.abs(arc.x - activeX) < .001)?.y)
      .toBeCloseTo(Math.min(645, Math.max(278, quoteY)), 10);
    expect(painted.find(arc => arc.color === '#f6465d' && Math.abs(arc.x - marker.x) < .001)?.y).toBeCloseTo(marker.y, 10);
    // The badge leaves the regular chart viewport unobscured.
    filled.length = 0; renderer.render(sale + .2 / renderer.getDuration());
    expect(filled.some(rect => rect.x === 27 && rect.y === 235 && rect.width === 1018 && rect.height === 475)).toBe(false);
    const expected = { viewport, marker, snapshot: state };
    for (const seek of [1, 0, .8, sale - .001, progress]) renderer.render(seek);
    expect({ viewport: motion.viewportAt(progress), marker: motion.markerPosition(2, progress),
      snapshot: renderer.snapshot(progress) }).toEqual(expected);
    expect(renderer.getDuration()).toBe(15.5);
    expect(renderer.snapshot(1)).toEqual(expect.objectContaining({ totalPnl: 131700, totalRoi: 131700 / 5800 }));
  });

  it.each(['open', 'closed'] as const)('keeps an %s sale and ending hold on the base camera without zooming', async status => {
    const payload = longPosition(), original = structuredClone(payload);
    if (status === 'closed') {
      payload.position = { ...payload.position, status: 'closed', tokenBalance: 0 };
      payload.trades[3] = { ...payload.trades[3], tokenAmount: 80, amountUsd: 112000, cumulativeRealizedProfitUsd: 130200 };
      delete payload.currentQuote;
    }
    const prepared = structuredClone(payload), { renderer, motion } = await replay(payload);
    const sale = renderer.eventProgress(3);
    for (let frame = 0; frame < 465; frame += 1) {
      const progress = frame / 464, viewport = motion.viewportAt(progress);
      const base = motion.cameraAt(motion.chartProgress(progress));
      expect(viewport.endQ - viewport.startQ).toBeCloseTo(motion.storyWindow, 10);
      expect(viewport.yMin).toBe(base.min); expect(viewport.yMax).toBe(base.max);
    }
    for (let index = 0; index < payload.trades.length; index += 1) {
      expect(motion.timeAt(renderer.eventProgress(index))).toBe(Date.parse(payload.trades[index].timestamp));
    }
    const final = renderer.snapshot(1), geometry = motion.viewportAt(1);
    const ending = motion.chartProgress(1);
    expect(motion.viewportAt(ending)).toEqual(geometry);
    renderer.render(sale + .7 / renderer.getDuration()); renderer.render(0); renderer.render(1);
    expect(renderer.snapshot(1)).toEqual(final); expect(motion.viewportAt(1)).toEqual(geometry);
    expect(renderer.getDuration()).toBe(15.5);
    if (status === 'closed') {
      expect(motion.chartProgress(sale + .7 / renderer.getDuration())).toBe(sale);
      expect(final).toEqual(expect.objectContaining({ time: payload.trades.at(-1)!.timestamp,
        currentPrice: 1400, holdings: 0, totalPnl: 130200, totalRoi: 130200 / 5800 }));
    } else {
      expect(final).toEqual(expect.objectContaining({ time: original.currentQuote!.timestamp,
        currentPrice: 1430, holdings: 50, totalPnl: 131700, totalRoi: 131700 / 5800 }));
    }
    expect(payload).toEqual(prepared);
  });

  it.each([false, true])('keeps the same pacing for small and large sells in a modern=%s replay', async modern => {
    const source = modern ? atomicPosition() : longPosition(), saleIndex = modern ? 19 : 2;
    const small = structuredClone(source), large = structuredClone(source);
    for (const payload of [small, large]) for (const trade of payload.trades) if (trade.side === 'sell') trade.amountUsd = 10;
    large.trades[saleIndex].amountUsd = 10_000_000;
    expect(selectReplaySellHighlights(small.trades)).toEqual([]);
    expect(selectReplaySellHighlights(large.trades).map(highlight => highlight.tradeIndex)).toEqual([saleIndex]);
    const before = await replay(small), after = await replay(large);
    expect(after.renderer.getDuration()).toBe(15.5);
    for (let index = 0; index < source.trades.length; index += 1) {
      expect(after.renderer.eventProgress(index)).toBe(before.renderer.eventProgress(index));
      expect(after.motion.timeAt(after.renderer.eventProgress(index))).toBe(Date.parse(source.trades[index].timestamp));
    }
    const sale = before.renderer.eventProgress(saleIndex);
    for (const progress of [0, sale - 1e-7, sale, sale + .2 / 15.5, sale + .7 / 15.5, .9, 1]) {
      expect(after.motion.chartProgress(progress)).toBe(before.motion.chartProgress(progress));
      expect(after.motion.timeAt(progress)).toBe(before.motion.timeAt(progress));
      expect(after.motion.viewportAt(progress)).toEqual(before.motion.viewportAt(progress));
      expect(after.motion.visibleLine(progress)).toEqual(before.motion.visibleLine(progress));
    }
    if (modern) {
      expect(after.renderer.eventProgress(19)).toBe(after.renderer.eventProgress(20));
      expect(after.renderer.snapshot(1)).toEqual(before.renderer.snapshot(1));
    }
  });

  it('gives a day of post-trade market history more playback time than a few minutes', async () => {
    const brief = await replay(longPosition()), extended = await replay(longPosition(24 * 3600));
    const tailSeconds = ({ renderer, motion }: Awaited<ReturnType<typeof replay>>) =>
      (motion.chartProgress(1) - renderer.eventProgress(3)) * renderer.getDuration();
    expect(tailSeconds(extended)).toBeGreaterThan(tailSeconds(brief) * 2);
    expect(tailSeconds(extended)).toBeLessThan(4.1);
    expect(extended.renderer.snapshot(1).currentPrice).toBe(brief.renderer.snapshot(1).currentPrice);
    expect(extended.renderer.snapshot(1).totalPnl).toBe(brief.renderer.snapshot(1).totalPnl);
    expect(extended.renderer.snapshot(1).time).toBe(at(56 * 3600));
  });

  it.each([0, 60])('keeps simultaneous fills and a %s-second ending finite and ordered', async tailSeconds => {
    const payload = longPosition(tailSeconds);
    payload.trades = payload.trades.map(trade => ({ ...trade, timestamp: at(0) }));
    payload.chart.points = [{ timestamp: at(0), priceUsd: 1400, marketCapUsd: 1_400_000 }];
    payload.currentQuote!.timestamp = at(tailSeconds); payload.generatedAt = at(tailSeconds);
    payload.position.checkedAt = at(tailSeconds);
    const { renderer, motion } = await replay(payload);
    let previousEvent = -1, previousTime = start;
    for (let index = 0; index < payload.trades.length; index += 1) {
      const progress = renderer.eventProgress(index);
      expect(Number.isFinite(progress)).toBe(true); expect(progress).toBeGreaterThan(previousEvent);
      expect(motion.timeAt(progress)).toBe(start); previousEvent = progress;
    }
    for (let frame = 0; frame <= 100; frame += 1) {
      const progress = frame / 100, time = motion.timeAt(progress);
      expect(Number.isFinite(time)).toBe(true); expect(time).toBeGreaterThanOrEqual(previousTime); previousTime = time;
      expect(Number.isFinite(renderer.snapshot(progress).currentCap)).toBe(true);
    }
    expect(renderer.snapshot(1).time).toBe(at(tailSeconds));
    expect(renderer.snapshot(1).currentCap).toBe(1_430_000);
  });

  it.each([[1_400_000, '$1.40M'], [1_430_000, '$1.43M'], [1_430_000_000, '$1.43B'], [1_430_000_000_000, '$1.43T'], [14_300, '$14.3K']] as const)
    ('shows enough precision to distinguish market-cap changes at %s', async (cap, expected) => {
      const payload = longPosition();
      payload.currentQuote = { ...payload.currentQuote!, priceUsd: cap / 1000, marketCapUsd: cap };
      const drawn: { value: string; x: number; y: number; alpha: number }[] = [];
      const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(payload);
      drawn.length = 0; renderer.render(1);
      // The right-hand live market badge, separate from footer and fill labels.
      expect(drawn.some(label => label.value === expected && label.x > 840 && label.y < 700)).toBe(true);
    });

  it('ignores a current quote for a closed position and preserves its final sell geometry', async () => {
    const payload = data();
    payload.currentQuote = { timestamp: at(3600), priceUsd: 999, marketCapUsd: 999000 };
    const { renderer, motion } = await replay(payload);
    expect(renderer.snapshot(1).time).toBe(at(300));
    expect(renderer.snapshot(1).currentPrice).toBe(50);
    expect(motion.viewportAt(1)).toEqual(motion.viewportAt(renderer.eventProgress(3)));
  });

  it('uses one composite quote for the visible tip, live value and current price guide', async () => {
    const { renderer, motion } = await replay();
    for (const progress of [0, .031, .15, .333, .519, .731, .84, .94, 1]) {
      const snapshot = renderer.snapshot(progress);
      const chartProgress = motion.chartProgress(progress);
      const quote = motion.valueAtStory(chartProgress);
      expect(snapshot.currentPrice).toBe(quote.priceUsd); expect(snapshot.currentCap).toBe(quote.marketCapUsd);
      const viewport = motion.viewportAt(progress);
      expect(viewport.time).toBe(motion.timeAt(chartProgress));
      const tip = motion.visibleLine(progress, viewport).at(-1)!;
      expect(tip.q).toBe(chartProgress); expect(tip.cap).toBe(snapshot.currentCap);
      expect(tip.x).toBeCloseTo(activeX, 10);
      expect(tip.y).toBeCloseTo(651 - (snapshot.currentCap - viewport.yMin) / (viewport.yMax - viewport.yMin) * 379, 10);
      expect(motion.visibleLine(progress, viewport).every(point => point.q <= chartProgress)).toBe(true);
    }
  });

  it('does not let an unrevealed later pump rescale the initial visible chart', async () => {
    const futurePump = data();
    futurePump.chart.points = futurePump.chart.points.map(point => Date.parse(point.timestamp) >= start + 300000
      ? { ...point, priceUsd: point.priceUsd * 1000, marketCapUsd: point.marketCapUsd! * 1000 } : point);
    futurePump.trades[3].priceUsd = 50000; futurePump.trades[3].marketCapUsd = 50000000;
    const before = await replay(); const after = await replay(futurePump);
    expect(after.motion.viewportAt(0)).toEqual(before.motion.viewportAt(0));
    expect(after.motion.markerPosition(0, 0)).toEqual(before.motion.markerPosition(0, 0));
    expect(after.motion.markerPosition(3, 0)).toEqual(expect.objectContaining({ visible: false, alpha: 0 }));
  });

  it('keeps clock and camera positions continuous at event boundaries without reversing time', async () => {
    const { renderer, motion } = await replay();
    let previousTime = motion.timeAt(0);
    for (let frame = 1; frame <= 500; frame += 1) {
      const time = motion.timeAt(frame / 500); expect(time).toBeGreaterThanOrEqual(previousTime); previousTime = time;
    }
    for (let index = 1; index < 4; index += 1) {
      const boundary = renderer.eventProgress(index);
      const before = motion.viewportAt(boundary - 1e-7); const after = motion.viewportAt(boundary + 1e-7);
      expect(Math.abs(after.time - before.time)).toBeLessThan(2);
      expect(Math.abs(after.startQ - before.startQ)).toBeLessThan(1e-6);
      expect(Math.abs(after.yMax - before.yMax) / before.yMax).toBeLessThan(.0001);
    }
  });

  it('keeps the adaptive camera finite and retains the current quote within its range', async () => {
    const { motion } = await replay();
    for (let frame = 0; frame <= 500; frame += 1) {
      const progress = frame / 500;
      const viewport = motion.viewportAt(progress);
      expect(Number.isFinite(viewport.yMin)).toBe(true); expect(Number.isFinite(viewport.yMax)).toBe(true);
      expect(viewport.yMin).toBeGreaterThanOrEqual(0); expect(viewport.yMax).toBeGreaterThan(viewport.yMin);
      const quote = motion.valueAtStory(motion.chartProgress(progress)).marketCapUsd;
      expect(quote).toBeGreaterThanOrEqual(viewport.yMin); expect(quote).toBeLessThan(viewport.yMax);
    }
  });

  it('produces identical geometry when seeking and rendering frames in a different order', async () => {
    const { renderer, motion } = await replay();
    const progress = .519;
    const expected = { viewport: motion.viewportAt(progress), snapshot: renderer.snapshot(progress), markers: [0, 1, 2, 3].map(index => motion.markerPosition(index, progress)) };
    for (const seek of [1, .12, .76, 0, .91, progress]) renderer.render(seek);
    expect({ viewport: motion.viewportAt(progress), snapshot: renderer.snapshot(progress), markers: [0, 1, 2, 3].map(index => motion.markerPosition(index, progress)) }).toEqual(expected);
  });

  it('draws the final sell circle at full opacity throughout the final held frame', async () => {
    const drawn: { value: string; x: number; y: number; alpha: number }[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(data());
    const motion = renderer as ReplayCanvas & MotionMethods;
    const marker = motion.markerPosition(3, 1)!;
    drawn.length = 0; renderer.render(1);
    const finalSell = drawn.find(label => label.value === 'S' && Math.abs(label.x - marker.x) < .001);
    expect(finalSell).toBeDefined(); expect(finalSell!.alpha).toBe(1);
  });

  it('retains separate green buy and red sell circles for paced simultaneous fills', async () => {
    const drawn: { value: string; x: number; y: number; alpha: number }[] = [];
    const painted: PaintedArc[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn, painted)); await renderer.setData(data());
    const motion = renderer as ReplayCanvas & MotionMethods;
    const progress = renderer.eventProgress(2) + .02;
    const buy = motion.markerPosition(1, progress)!; const sell = motion.markerPosition(2, progress)!;
    drawn.length = 0; painted.length = 0; renderer.render(progress);
    expect(drawn.find(label => label.value === 'B' && Math.abs(label.x - buy.x) < .001)).toBeDefined();
    expect(drawn.find(label => label.value === 'S' && Math.abs(label.x - sell.x) < .001)).toBeDefined();
    expect(drawn.some(label => label.value === 'B/S')).toBe(false);
    const paintedBuy = painted.find(arc => arc.color === '#16c784' && Math.abs(arc.x - buy.x) < .001);
    const paintedSell = painted.find(arc => arc.color === '#f6465d' && Math.abs(arc.x - sell.x) < .001);
    expect(paintedBuy).toBeDefined(); expect(paintedSell).toBeDefined();
    expect(paintedBuy!.y).toBeCloseTo(buy.anchorY, 10);
    expect(paintedSell!.y).toBeCloseTo(sell.anchorY, 10);
    for (const circle of [paintedBuy!, paintedSell!]) {
      expect(circle.radius).toBeGreaterThanOrEqual(18);
      expect(circle.radius).toBeLessThanOrEqual(22);
    }
  });

  it('removes the requested UTC, pacing and gas footer line from generated frames', async () => {
    const drawn: { value: string; x: number; y: number; alpha: number }[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(data());
    drawn.length = 0; renderer.render(1);
    expect(drawn.some(label => /UTC TIMES|PACED REPLAY|GAS EXCLUDED/.test(label.value))).toBe(false);
  });
});
