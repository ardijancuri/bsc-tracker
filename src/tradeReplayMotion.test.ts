import { describe, expect, it } from 'vitest';
import ReplayCanvas from './tradeReplayCanvas';
import type { TradeReplayData } from './tradeReplayData';

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
  chartProgress(progress: number): number;
  viewportAt(progress: number): Viewport;
  valueAtTime(timestamp: number): { priceUsd: number; marketCapUsd: number };
  valueAtStory(progress: number): { priceUsd: number; marketCapUsd: number };
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

interface PaintedArc {
  x: number;
  y: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  color: string;
  alpha: number;
}

function canvasStub(drawn?: { value: string; x: number; y: number; alpha: number }[], painted?: PaintedArc[]): HTMLCanvasElement {
  let currentArc: Omit<PaintedArc, 'color' | 'alpha'> | null = null;
  const context = new Proxy({}, {
    get: (target, key) => key === 'measureText' ? (value: string) => ({ width: value.length * 20 })
      : key === 'fillText' ? (value: string, x: number, y: number) => drawn?.push({ value, x, y, alpha: (target as { globalAlpha?: number }).globalAlpha ?? 1 })
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

  it('places each circle four pixels above its exact fill vertex in the composite curve', async () => {
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
      expect(marker.y + motion.markerRadius + 4).toBeCloseTo(Math.min(658, Math.max(265, fillY)), 10);
    }
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
    expect(painted.find(arc => arc.color === '#16c784' && Math.abs(arc.x - buy.x) < .001)).toBeDefined();
    expect(painted.find(arc => arc.color === '#f6465d' && Math.abs(arc.x - sell.x) < .001)).toBeDefined();
  });

  it('removes the requested UTC, pacing and gas footer line from generated frames', async () => {
    const drawn: { value: string; x: number; y: number; alpha: number }[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(data());
    drawn.length = 0; renderer.render(1);
    expect(drawn.some(label => /UTC TIMES|PACED REPLAY|GAS EXCLUDED/.test(label.value))).toBe(false);
  });
});
