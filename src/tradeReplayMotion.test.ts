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
  timeAt(progress: number): number;
  chartProgress(progress: number): number;
  viewportAt(progress: number): Viewport;
  valueAtTime(timestamp: number): { priceUsd: number; marketCapUsd: number };
  markerPosition(index: number, progress: number): Marker | null;
  visibleLine(progress: number, viewport?: Viewport): { ts: number; cap: number; x: number; y: number }[];
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

describe('trade replay market-time geometry', () => {
  it('places simultaneous executions on one real timestamp and preserves proportional elapsed-time spacing', async () => {
    const { renderer, motion } = await replay();
    const progress = renderer.eventProgress(3);
    const first = motion.markerPosition(0, progress)!;
    const simultaneousBuy = motion.markerPosition(1, progress)!;
    const simultaneousSell = motion.markerPosition(2, progress)!;
    const last = motion.markerPosition(3, progress)!;
    expect(simultaneousBuy.ts).toBe(start + 60000);
    expect(simultaneousSell.ts).toBe(simultaneousBuy.ts);
    expect(simultaneousSell.x).toBeCloseTo(simultaneousBuy.x, 10);
    expect(simultaneousSell.y).toBeCloseTo(simultaneousBuy.y, 10);
    expect((simultaneousBuy.x - first.x) / (last.x - first.x)).toBeCloseTo(60 / 300, 10);
  });

  it('anchors circles to the sampled market line while retaining the different execution price', async () => {
    const { renderer, motion } = await replay();
    const marker = motion.markerPosition(1, renderer.eventProgress(1))!;
    expect(marker.marketValue).toBe(3000);
    expect(marker.executionValue).toBe(20000);
    expect(marker.marketValue).toBe(motion.valueAtTime(marker.ts).marketCapUsd);
    const viewport = motion.viewportAt(renderer.eventProgress(1));
    expect(marker.y).toBeGreaterThan(272);
    expect(marker.y).toBeLessThan(651);
    expect(viewport.yMax).toBeLessThan(marker.executionValue!);
  });

  it('keeps the first and last fill anchored to their recorded times and freezes the entire closing frame', async () => {
    const { renderer, motion } = await replay();
    const closing = renderer.eventProgress(3);
    expect(motion.timeAt(0)).toBe(start);
    expect(renderer.snapshot(0).currentEventIndex).toBe(0);
    expect(motion.timeAt(closing)).toBe(start + 300000);
    expect(motion.timeAt(1)).toBe(start + 300000);
    expect(motion.chartProgress(1)).toBe(closing);
    expect(motion.viewportAt(1)).toEqual(motion.viewportAt(closing));
    expect(renderer.snapshot(1).currentPrice).toBe(renderer.snapshot(closing).currentPrice);
    const closingMarker = motion.markerPosition(3, closing)!;
    expect(motion.markerPosition(3, 1)).toEqual(expect.objectContaining({ ts: closingMarker.ts, x: closingMarker.x, y: closingMarker.y, marketValue: closingMarker.marketValue }));
    expect(motion.markerPosition(3, 1)).toEqual(expect.objectContaining({ visible: true, alpha: 1 }));
  });

  it.each(['open', 'unknown'] as const)('ends an %s position replay at the last fill instead of later chart quotes', async status => {
    const payload = data();
    payload.position = { ...payload.position, status, tokenBalance: status === 'open' ? 1 : null, tradeFlowMatched: false };
    payload.chart.points.at(-1)!.priceUsd = 999;
    payload.chart.points.at(-1)!.marketCapUsd = 999000;
    const { renderer, motion } = await replay(payload);
    const closing = renderer.eventProgress(3);
    expect(Date.parse(renderer.snapshot(1).time!)).toBe(start + 300000);
    expect(renderer.snapshot(1).currentPrice).toBe(4);
    expect(motion.viewportAt(1)).toEqual(motion.viewportAt(closing));
    const closingMarker = motion.markerPosition(3, closing)!;
    expect(motion.markerPosition(3, 1)).toEqual(expect.objectContaining({ ts: closingMarker.ts, x: closingMarker.x, y: closingMarker.y, visible: true, alpha: 1 }));
  });

  it('uses one market quote for the moving line, playhead value, and circle anchors throughout replay', async () => {
    const { renderer, motion } = await replay();
    for (const progress of [0, 0.031, 0.15, 0.333, 0.519, 0.731, 0.84, 0.94, 1]) {
      const snapshot = renderer.snapshot(progress);
      const quote = motion.valueAtTime(Date.parse(snapshot.time!));
      // ISO timestamps round to milliseconds; the market interpolation is continuous.
      expect(snapshot.currentPrice).toBeCloseTo(quote.priceUsd, 4);
      expect(snapshot.currentCap).toBeCloseTo(quote.marketCapUsd, 1);
      const viewport = motion.viewportAt(progress);
      expect(viewport.time).toBeCloseTo(motion.timeAt(motion.chartProgress(progress)), 4);
      expect(viewport.endTime - viewport.startTime).toBeCloseTo(viewport.spanTime, 4);
      const playhead = motion.visibleLine(progress, viewport).at(-1)!;
      expect(playhead.ts).toBe(viewport.time);
      expect(playhead.cap).toBe(snapshot.currentCap);
      expect(playhead.x).toBeCloseTo(42 + 772 * 0.78, 10);
      expect(playhead.y).toBeCloseTo(651 - snapshot.currentCap / viewport.yMax * 379, 10);
      for (let index = 0; index < 4; index += 1) {
        const marker = motion.markerPosition(index, progress)!;
        expect(marker.marketValue).toBe(motion.valueAtTime(marker.ts).marketCapUsd);
      }
    }
  });

  it('does not let an unrevealed later pump rescale the current visible chart', async () => {
    const normal = data();
    const futurePump = data();
    futurePump.chart.points = futurePump.chart.points.map(point => Date.parse(point.timestamp) >= start + 300000
      ? { ...point, priceUsd: point.priceUsd * 1000, marketCapUsd: point.marketCapUsd! * 1000 } : point);
    const before = await replay(normal);
    const after = await replay(futurePump);
    expect(after.motion.viewportAt(0).yMax).toBeCloseTo(before.motion.viewportAt(0).yMax, 10);
    expect(after.motion.viewportAt(0).startTime).toBe(before.motion.viewportAt(0).startTime);
    expect(after.motion.markerPosition(0, 0)).toEqual(before.motion.markerPosition(0, 0));
  });

  it('does not pin an off-scale, unrevealed fill to the top of the visible chart', async () => {
    const payload = data();
    payload.chart.points = payload.chart.points.map(point => Date.parse(point.timestamp) >= start + 300000
      ? { ...point, priceUsd: point.priceUsd * 1000, marketCapUsd: point.marketCapUsd! * 1000 } : point);
    const { motion } = await replay(payload);
    const future = motion.markerPosition(3, 0)!;
    expect(future.marketValue).toBe(4000000);
    expect(future.y).toBeLessThan(272);
    expect(future.visible).toBe(false);
    expect(future.alpha).toBe(0);
  });

  it('keeps the paced clock and camera continuous at event boundaries without reversing time', async () => {
    const { renderer, motion } = await replay();
    let previousTime = motion.timeAt(0);
    for (let frame = 1; frame <= 500; frame += 1) {
      const time = motion.timeAt(frame / 500);
      expect(time).toBeGreaterThanOrEqual(previousTime);
      previousTime = time;
    }
    for (let index = 1; index < 4; index += 1) {
      const boundary = renderer.eventProgress(index);
      const before = motion.viewportAt(boundary - 1e-7);
      const after = motion.viewportAt(boundary + 1e-7);
      expect(Math.abs(after.time - before.time)).toBeLessThan(2);
      expect(Math.abs(after.startTime - before.startTime)).toBeLessThan(2);
      expect(Math.abs(after.yMax - before.yMax) / before.yMax).toBeLessThan(0.0001);
    }
  });

  it('smoothly slows the chart clock to zero before the ending hold', async () => {
    const { renderer, motion } = await replay();
    const end = renderer.eventProgress(3);
    const endTime = motion.timeAt(end);
    const nearVelocity = (endTime - motion.timeAt(end - 1e-5)) / 1e-5;
    const fartherVelocity = (endTime - motion.timeAt(end - 1e-3)) / 1e-3;
    expect(fartherVelocity).toBeGreaterThan(0);
    expect(nearVelocity).toBeGreaterThanOrEqual(0);
    expect(nearVelocity).toBeLessThan(fartherVelocity * 0.05);
    expect(motion.timeAt(end + 1e-3)).toBe(endTime);
  });

  it('produces identical geometry when seeking and rendering frames in a different order', async () => {
    const { renderer, motion } = await replay();
    const progress = 0.519;
    const expected = { viewport: motion.viewportAt(progress), snapshot: renderer.snapshot(progress), markers: [0, 1, 2, 3].map(index => motion.markerPosition(index, progress)) };
    for (const seek of [1, 0.12, 0.76, 0, 0.91, progress]) renderer.render(seek);
    expect({ viewport: motion.viewportAt(progress), snapshot: renderer.snapshot(progress), markers: [0, 1, 2, 3].map(index => motion.markerPosition(index, progress)) }).toEqual(expected);
  });

  it('draws the final sell circle at full opacity while holding the chart still', async () => {
    const drawn: { value: string; x: number; y: number; alpha: number }[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn));
    await renderer.setData(data());
    const motion = renderer as ReplayCanvas & MotionMethods;
    const marker = motion.markerPosition(3, 1)!;
    drawn.length = 0;
    renderer.render(1);
    const finalSell = drawn.find(label => label.value === 'S' && Math.abs(label.x - marker.x) < 0.001);
    expect(finalSell).toBeDefined();
    expect(finalSell!.alpha).toBe(1);
  });

  it('keeps both sides visible in one split-color circle for simultaneous buy and sell executions', async () => {
    const drawn: { value: string; x: number; y: number; alpha: number }[] = [];
    const painted: PaintedArc[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn, painted));
    await renderer.setData(data());
    const motion = renderer as ReplayCanvas & MotionMethods;
    const progress = renderer.eventProgress(2) + 0.02;
    const buy = motion.markerPosition(1, progress)!;
    const sell = motion.markerPosition(2, progress)!;
    expect(buy.x).toBe(sell.x);
    expect(buy.y).toBe(sell.y);
    drawn.length = 0;
    painted.length = 0;
    renderer.render(progress);
    const labelsAtAnchor = drawn.filter(label => Math.abs(label.x - buy.x) < 0.001 && Math.abs(label.y - buy.y - 1) < 0.001);
    expect(labelsAtAnchor).toEqual([{ value: 'B/S', x: buy.x, y: buy.y + 1, alpha: 1 }]);
    const fillsAtAnchor = painted.filter(arc => Math.abs(arc.x - buy.x) < 0.001 && Math.abs(arc.y - buy.y) < 0.001 && arc.alpha === 1);
    expect(fillsAtAnchor.map(arc => arc.color)).toContain('#16c784');
    const redHalf = fillsAtAnchor.find(arc => arc.color === '#f6465d');
    expect(redHalf).toBeDefined();
    expect(Math.abs(redHalf!.endAngle - redHalf!.startAngle)).toBeCloseTo(Math.PI, 10);
  });
});
