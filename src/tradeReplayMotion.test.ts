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

function buyBurst(count = 9, ending = false): TradeReplayData {
  const payload = data();
  payload.trades = Array.from({ length: count }, (_, index) => ({
    id: `buy-${index}`, txHash: `0xbuy${index}`, timestamp: at(ending && index > 0 ? 180 : index), side: 'buy' as const,
    tokenAmount: 1, amountUsd: 15 + index, priceUsd: 15 + index, marketCapUsd: (15 + index) * 1000,
  }));
  payload.trades.push({ id: 'close', txHash: '0xclose', timestamp: at(180), side: 'sell',
    tokenAmount: count, amountUsd: count * 30, priceUsd: 30, marketCapUsd: 30000 });
  payload.chart.points = payload.trades.map(trade => ({ timestamp: trade.timestamp,
    priceUsd: trade.priceUsd!, marketCapUsd: trade.marketCapUsd }));
  payload.generatedAt = payload.position.checkedAt = at(180);
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

interface DrawnText {
  value: string;
  x: number;
  y: number;
  alpha: number;
  color?: string;
  clip?: PaintedBox;
}
interface PaintedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function canvasStub(drawn?: DrawnText[], painted?: PaintedArc[],
  filled?: PaintedBox[], rounded?: PaintedBox[]): HTMLCanvasElement {
  let currentArc: Omit<PaintedArc, 'color' | 'alpha'> | null = null;
  let path: { x: number; y: number }[] = [], corners = 0, closed = false;
  const stack: Record<PropertyKey, unknown>[] = [];
  const context = new Proxy<Record<PropertyKey, unknown>>({ globalAlpha: 1 }, {
    get: (target, key) => key === 'measureText' ? (value: string) => ({ width: value.length * 20 })
      : key === 'fillText' ? (value: string, x: number, y: number) => drawn?.push({ value, x, y,
        alpha: Number(target.globalAlpha ?? 1), color: String(target.fillStyle ?? ''), clip: target.clipBounds as PaintedBox | undefined })
      : key === 'fillRect' ? (x: number, y: number, width: number, height: number) => filled?.push({ x, y, width, height })
      : key === 'save' ? () => { stack.push({ ...target }); }
      : key === 'restore' ? () => {
        const saved = stack.pop();
        if (!saved) return;
        for (const property of Reflect.ownKeys(target)) delete target[property];
        Object.assign(target, saved);
      }
      : key === 'beginPath' ? () => { currentArc = null; path = []; corners = 0; closed = false; }
      : key === 'rect' ? (x: number, y: number, width: number, height: number) => {
        path.push({ x, y }, { x: x + width, y: y + height });
      }
      : key === 'clip' ? () => {
        if (!path.length) return;
        const x = Math.min(...path.map(point => point.x)), y = Math.min(...path.map(point => point.y));
        const right = Math.max(...path.map(point => point.x)), bottom = Math.max(...path.map(point => point.y));
        const previous = target.clipBounds as PaintedBox | undefined;
        const left = Math.max(x, previous?.x ?? -Infinity), top = Math.max(y, previous?.y ?? -Infinity);
        target.clipBounds = { x: left, y: top, width: Math.min(right, previous ? previous.x + previous.width : Infinity) - left,
          height: Math.min(bottom, previous ? previous.y + previous.height : Infinity) - top };
      }
      : key === 'moveTo' || key === 'lineTo' ? (x: number, y: number) => { path.push({ x, y }); }
      : key === 'quadraticCurveTo' ? (cx: number, cy: number, x: number, y: number) => {
        corners += 1; path.push({ x: cx, y: cy }, { x, y });
      }
      : key === 'closePath' ? () => { closed = true; }
      : key === 'arc' ? (x: number, y: number, radius: number, startAngle: number, endAngle: number) => { currentArc = { x, y, radius, startAngle, endAngle }; }
      : key === 'fill' ? () => {
        if (currentArc) painted?.push({ ...currentArc, color: (target as { fillStyle?: string }).fillStyle ?? '', alpha: (target as { globalAlpha?: number }).globalAlpha ?? 1 });
        if (closed && corners === 4 && path.length) {
          const x = Math.min(...path.map(point => point.x)), y = Math.min(...path.map(point => point.y));
          rounded?.push({ x, y, width: Math.max(...path.map(point => point.x)) - x,
            height: Math.max(...path.map(point => point.y)) - y });
        }
      }
      : key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : key in target ? target[key] : () => undefined,
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
  it('adapts the clip to the genuine position span within the requested five-to-twenty-five-second range', async () => {
    const durations: number[] = [];
    for (const span of [0, 5, 60, 300, 3600, 7 * 24 * 3600]) {
      const payload = data();
      payload.trades = [payload.trades[0], { ...payload.trades[3], timestamp: at(span) }];
      payload.chart.points = [{ timestamp: at(0), priceUsd: 2, marketCapUsd: 2000 },
        { timestamp: at(span), priceUsd: 50, marketCapUsd: 50000 }];
      payload.generatedAt = payload.position.checkedAt = at(span);
      const { renderer } = await replay(payload), duration = renderer.getDuration();
      durations.push(duration);
      expect(duration).toBeGreaterThanOrEqual(5); expect(duration).toBeLessThanOrEqual(25);
      expect(renderer.snapshot(1)).toEqual(expect.objectContaining({ time: at(span), holdings: 0, pnl: 48 }));
    }
    expect(durations[0]).toBe(5); expect(durations.at(-1)).toBe(25);
    for (let index = 1; index < durations.length; index += 1) expect(durations[index]).toBeGreaterThan(durations[index - 1]);
  });

  it('uses one linear source clock within each clip and the same steady pan across different durations', async () => {
    const speeds: number[] = [], durations: number[] = [];
    for (const payload of [data(), densePosition(true), longPosition()]) {
      const { renderer, motion } = await replay(payload), duration = renderer.getDuration();
      const first = Date.parse(payload.trades[0].timestamp), last = Date.parse(renderer.snapshot(1).time!);
      const ending = motion.chartProgress(1);
      durations.push(duration);
      expect((1 - ending) * duration).toBeCloseTo(1.5, 10);
      for (const fraction of [0, .1, .37, .68, 1]) {
        expect(motion.timeAt(ending * fraction)).toBeCloseTo(first + (last - first) * fraction, 0);
      }
      for (const fraction of [.05, .3, .6]) {
        const before = ending * fraction, after = before + .1 / duration;
        const distance = motion.markerPosition(0, before)!.x - motion.markerPosition(0, after)!.x;
        speeds.push(distance / .1);
      }
      expect(motion.viewportAt(1)).toEqual(motion.viewportAt(ending));
    }
    expect(new Set(durations).size).toBeGreaterThan(1);
    expect(speeds[0]).toBeGreaterThan(0);
    for (const speed of speeds) expect(speed).toBeCloseTo(speeds[0], 8);
  });

  it('caps dense replays without stretching close execution times into artificial gaps', async () => {
    const payload = densePosition();
    payload.trades = Array.from({ length: 200 }, (_, index) => ({ ...payload.trades[index % 40],
      id: 'burst-' + index, txHash: '0xburst' + index, timestamp: at(index / 100),
      amountUsd: 100, priceUsd: 100, marketCapUsd: 100000, cumulativeRealizedProfitUsd: 0 }));
    payload.chart.points = payload.trades.map(trade => ({ timestamp: trade.timestamp, priceUsd: 100, marketCapUsd: 100000 }));
    payload.position.checkedAt = payload.generatedAt = payload.trades.at(-1)!.timestamp;
    const { renderer, motion } = await replay(payload);
    expect(renderer.getDuration()).toBe(25);
    const gaps = payload.trades.slice(1).map((_, index) => renderer.eventProgress(index + 1) - renderer.eventProgress(index));
    expect(gaps.every(gap => gap > 0)).toBe(true);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 10);
    for (let index = 0; index < payload.trades.length; index += 1) {
      const progress = renderer.eventProgress(index), marker = motion.markerPosition(index, progress)!;
      expect(marker.ts).toBe(Date.parse(payload.trades[index].timestamp));
      expect(motion.timeAt(progress)).toBeCloseTo(marker.ts, 0);
      expect(marker.x).toBeCloseTo(activeX, 10);
    }
  });

  it('keeps simultaneous fills at one horizontal timestamp without inventing gaps', async () => {
    const { renderer, motion } = await replay();
    const progress = renderer.eventProgress(3);
    const buy = motion.markerPosition(1, progress)!;
    const sell = motion.markerPosition(2, progress)!;
    expect(buy.ts).toBe(start + 60000); expect(sell.ts).toBe(buy.ts);
    expect(sell.q).toBe(buy.q); expect(sell.x).toBe(buy.x);
    expect(renderer.eventProgress(1)).toBe(renderer.eventProgress(2));
    for (let index = 0; index < 4; index += 1) {
      const marker = motion.markerPosition(index, progress)!;
      expect(motion.timeAt(renderer.eventProgress(index))).toBe(Date.parse(data().trades[index].timestamp));
      expect(marker.x).toBeCloseTo(42 + (marker.q - motion.viewportAt(progress).startQ) / motion.storyWindow * 772, 10);
    }
  });

  it('places compact circles at their exact fill price and source timestamp, including atomic fills', async () => {
    const { renderer, motion } = await replay();
    for (let index = 0; index < 4; index += 1) {
      const progress = renderer.eventProgress(index);
      const marker = motion.markerPosition(index, progress)!;
      const viewport = motion.viewportAt(progress);
      expect(marker.ts).toBe(Date.parse(data().trades[index].timestamp));
      expect(marker.executionValue).toBe(data().trades[index].marketCapUsd);
      expect(marker.x).toBeCloseTo(activeX, 10);
      const fillY = 651 - (marker.executionValue! - viewport.yMin) / (viewport.yMax - viewport.yMin) * 379;
      expect(marker.y).toBeCloseTo(fillY, 10);
      expect(marker.anchorY).toBeCloseTo(fillY, 10);
    }
  });

  it('keeps dense trades readable and limits horizontal movement despite a one-second trade gap', async () => {
    const payload = densePosition(true);
    expect(Date.parse(payload.trades[20].timestamp) - Date.parse(payload.trades[19].timestamp)).toBe(1000);
    const { renderer, motion } = await replay(payload);
    expect(motion.storyWindow).toBeGreaterThan(0);
    expect(motion.markerRadius).toBeGreaterThanOrEqual(18);
    expect(motion.markerRadius).toBeLessThanOrEqual(22);
    expect(renderer.getDuration()).toBeGreaterThanOrEqual(5);
    expect(renderer.getDuration()).toBeLessThanOrEqual(25);
    for (let index = 0; index < payload.trades.length; index += 1) {
      const event = renderer.eventProgress(index);
      expect(motion.timeAt(event)).toBe(Date.parse(payload.trades[index].timestamp));
      expect(renderer.snapshot(event).currentEventIndex).toBe(index);
    }
    const frames = Math.round(renderer.getDuration() * 30);
    let previous = motion.markerPosition(0, 0)!.x;
    const panSteps: number[] = [];
    for (let frame = 1; frame < frames; frame += 1) {
      const progress = frame / (frames - 1), current = motion.markerPosition(0, progress)!.x;
      expect(previous - current).toBeGreaterThanOrEqual(-1e-9);
      if (progress < motion.chartProgress(1)) panSteps.push(previous - current);
      else if ((frame - 1) / (frames - 1) >= motion.chartProgress(1)) expect(current).toBe(previous);
      previous = current;
    }
    expect(panSteps.length).toBeGreaterThan(1);
    for (const step of panSteps) expect(step).toBeCloseTo(panSteps[0], 8);
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
    const frames = Math.ceil(renderer.getDuration() * 30);
    for (let frame = 0; frame <= frames; frame += 1) {
      const progress = frame / frames;
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
    expect(motion.storyWindow).toBeGreaterThan(0);
    expect(motion.markerRadius).toBeGreaterThanOrEqual(18);
    expect(motion.markerRadius).toBeLessThanOrEqual(22);
    expect(renderer.getDuration()).toBeGreaterThanOrEqual(5);
    expect(renderer.getDuration()).toBeLessThanOrEqual(25);
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
    expect(motion.viewportAt(1)).toEqual(motion.viewportAt(motion.chartProgress(1)));
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
    expect((1 - endpoint) * renderer.getDuration()).toBeCloseTo(1.5, 10);
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

  it.each([true, false])('keeps large sales free of banners and special transitions with known profit %s', async known => {
    const payload = longPosition(), original = structuredClone(payload);
    if (!known) {
      for (const trade of payload.trades) delete trade.cumulativeRealizedProfitUsd;
      payload.realizedAccounting = { available: false };
    }
    const drawn: DrawnText[] = [], boxes: PaintedBox[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn, undefined, undefined, boxes));
    await renderer.setData(payload);
    const motion = renderer as ReplayCanvas & MotionMethods;
    const sale = renderer.eventProgress(2), during = sale + .4 / renderer.getDuration();
    const expected = { viewport: motion.viewportAt(during), snapshot: renderer.snapshot(during) };
    for (const progress of [sale - 1e-7, sale, during, sale + 1.2 / renderer.getDuration(), 1]) {
      drawn.length = 0; boxes.length = 0; renderer.render(progress);
      expect(drawn.some(label => /^(TAKE PROFIT|BIG SELL)/.test(label.value))).toBe(false);
      expect(boxes.some(box => box.y >= 190 && box.y + box.height <= 254 && box.width > 200)).toBe(false);
    }
    for (const seek of [1, 0, .9, sale - 1e-7, during]) renderer.render(seek);
    expect({ viewport: motion.viewportAt(during), snapshot: renderer.snapshot(during) }).toEqual(expected);
    if (known) {
      expect(renderer.snapshot(1)).toEqual(expect.objectContaining({ time: payload.currentQuote!.timestamp,
        currentPrice: 1430, totalPnl: 131700, totalRoi: 131700 / 5800, realizedPnl: 65440 }));
      expect(payload).toEqual(original);
    } else {
      expect(renderer.snapshot(1)).toEqual(expect.objectContaining({ realizedPnl: null, totalPnl: null, totalRoi: null }));
    }
    expect(renderer.getDuration()).toBeGreaterThanOrEqual(5); expect(renderer.getDuration()).toBeLessThanOrEqual(25);
  });

  it.each([false, true])('keeps event timing independent of sale size for atomic movement groups %s', async atomic => {
    const small = atomic ? atomicPosition() : longPosition();
    const large = structuredClone(small);
    for (const trade of small.trades) if (trade.side === 'sell') trade.amountUsd = 10;
    for (const [index, trade] of large.trades.entries()) {
      if (trade.side === 'sell') trade.amountUsd = index === 3 ? 10_000_000 : 100;
    }
    const before = await replay(small), after = await replay(large);
    expect(after.renderer.getDuration()).toBe(before.renderer.getDuration());
    for (let index = 0; index < small.trades.length; index += 1) {
      expect(after.renderer.eventProgress(index)).toBe(before.renderer.eventProgress(index));
      expect(after.motion.timeAt(after.renderer.eventProgress(index))).toBe(Date.parse(small.trades[index].timestamp));
    }
    const frames = Math.ceil(before.renderer.getDuration() * 30);
    for (let frame = 0; frame <= frames; frame += 1) {
      expect(after.motion.timeAt(frame / frames)).toBe(before.motion.timeAt(frame / frames));
    }
  });

  it.each(['open', 'closed'] as const)('keeps the normal viewport and aligned markers through a large %s-position sale', async position => {
    const payload = longPosition();
    if (position === 'closed') {
      payload.position = { ...payload.position, status: 'closed', tokenBalance: 0 };
      payload.trades[3] = { ...payload.trades[3], tokenAmount: 80, amountUsd: 112000, cumulativeRealizedProfitUsd: 130200 };
      delete payload.currentQuote;
    }
    const original = structuredClone(payload), { renderer, motion } = await replay(payload);
    const frames = Math.ceil(renderer.getDuration() * 30);
    for (let frame = 0; frame <= frames; frame += 1) {
      const progress = frame / frames, viewport = motion.viewportAt(progress);
      const base = motion.cameraAt(motion.chartProgress(progress));
      expect(viewport.endQ - viewport.startQ).toBeCloseTo(motion.storyWindow, 10);
      expect(viewport.yMin).toBe(base.min); expect(viewport.yMax).toBe(base.max);
      const tip = motion.visibleLine(progress, viewport).at(-1)!;
      expect(tip.x).toBeCloseTo(activeX, 10);
      expect(tip.cap).toBe(renderer.snapshot(progress).currentCap);
    }
    const progress = renderer.eventProgress(2) + .7 / renderer.getDuration();
    const viewport = motion.viewportAt(progress), marker = motion.markerPosition(2, progress)!;
    expect(marker.x).toBeCloseTo(42 + (marker.q - viewport.startQ) / motion.storyWindow * 772, 10);
    expect(marker.y).toBeCloseTo(651 - (marker.executionValue! - viewport.yMin) / (viewport.yMax - viewport.yMin) * 379, 10);
    const final = renderer.snapshot(1), geometry = motion.viewportAt(1);
    for (const seek of [progress, 0, .8, 1]) renderer.render(seek);
    expect(renderer.snapshot(1)).toEqual(final); expect(motion.viewportAt(1)).toEqual(geometry);
    expect(renderer.getDuration()).toBeGreaterThanOrEqual(5); expect(renderer.getDuration()).toBeLessThanOrEqual(25); expect(payload).toEqual(original);
    if (position === 'closed') {
      expect(final).toEqual(expect.objectContaining({ holdings: 0, totalPnl: 130200, totalRoi: 130200 / 5800 }));
      expect(geometry).toEqual(motion.viewportAt(renderer.eventProgress(3)));
    } else {
      expect(final).toEqual(expect.objectContaining({ holdings: 50, totalPnl: 131700, totalRoi: 131700 / 5800 }));
    }
  });

  it.each([[0, '$2.00', '#16c784'], [2, '$30.00', '#f6465d']] as const)
    ('shows only the amount next to transaction %s without a box, time or execution MCAP', async (index, amount, color) => {
      const drawn: DrawnText[] = [], rounded: PaintedBox[] = [];
      const renderer = new ReplayCanvas(canvasStub(drawn, undefined, undefined, rounded));
      await renderer.setData(data());
      const motion = renderer as ReplayCanvas & MotionMethods;
      const progress = renderer.eventProgress(index) + .4 / renderer.getDuration();
      const marker = motion.markerPosition(index, progress)!;
      drawn.length = 0; rounded.length = 0; renderer.render(progress);
      const label = drawn.find(label => label.value === amount && label.y >= 258 && label.y <= 666)!;
      expect(label).toBeDefined(); expect(label.alpha).toBeGreaterThan(.9); expect(label.color).toBe(color);
      expect(label.x).toBeCloseTo(marker.x, 8);
      expect(Math.abs(label.y - marker.y)).toBeGreaterThan(motion.markerRadius);
      if (index === 0) expect(label.y).toBeLessThan(marker.y);
      else expect(label.y).toBeGreaterThan(marker.y);
      expect(drawn.some(label => /^(BUY|SELL) ·|\d\d:\d\d:\d\d UTC| MCAP$/.test(label.value))).toBe(false);
      expect(rounded.some(box => box.x >= 42 && box.x + box.width <= 814
        && box.y >= 258 && box.y + box.height <= 666 && box.width > 100 && box.height > 40)).toBe(false);
    });

  it('fades the amount in and out around its circle appearance while keeping the circle visible', async () => {
    const drawn: DrawnText[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(data());
    const sale = renderer.eventProgress(3);
    const labelAt = (seconds: number) => {
      drawn.length = 0; renderer.render(sale + seconds / renderer.getDuration());
      return drawn.find(label => label.value === '$50.00' && label.y >= 258 && label.y <= 666);
    };
    expect(labelAt(-.01)).toBeUndefined();
    const entering = labelAt(.06), held = labelAt(.4), leaving = labelAt(1.1);
    expect(entering).toBeDefined(); expect(held).toBeDefined(); expect(leaving).toBeDefined();
    expect(entering!.alpha).toBeGreaterThan(0); expect(entering!.alpha).toBeLessThan(held!.alpha);
    expect(held!.alpha).toBeGreaterThan(.9);
    expect(leaving!.alpha).toBeGreaterThan(0); expect(leaving!.alpha).toBeLessThan(held!.alpha);
    expect(labelAt(1.4)).toBeUndefined();
    expect(drawn.some(label => label.value === 'S')).toBe(true);
    drawn.length = 0; renderer.render(1);
    expect(drawn.some(label => label.value === '$50.00' && label.y >= 258 && label.y <= 666)).toBe(false);
    expect(drawn.some(label => label.value === 'S' && label.alpha === 1)).toBe(true);
  });

  it('fades nearby buy amounts in sequentially underneath the first amount without combining fills', async () => {
    const drawn: DrawnText[] = [], payload = buyBurst(), original = structuredClone(payload);
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(payload);
    const labelsAt = (seconds: number) => {
      drawn.length = 0; renderer.render(seconds / renderer.getDuration());
      return drawn.filter(label => label.color === '#16c784' && /^\$\d+\.00$/.test(label.value)
        && label.y >= 258 && label.y <= 666);
    };
    const first = labelsAt(.06);
    expect(first.map(label => label.value)).toEqual(['$15.00']);
    const second = labelsAt(.28);
    expect(second.map(label => label.value)).toEqual(['$15.00', '$16.00']);
    expect(second[1].alpha).toBeGreaterThan(0); expect(second[1].alpha).toBeLessThan(second[0].alpha);
    expect(second[1].x).toBe(second[0].x);
    expect(second[1].y - second[0].y).toBeCloseTo(36, 8);
    const third = labelsAt(.5);
    expect(third.map(label => label.value)).toEqual(['$15.00', '$16.00', '$17.00']);
    expect(third[2].x).toBe(third[0].x);
    expect(third[2].y - third[1].y).toBeCloseTo(36, 8);
    // The independent source clock has already processed more fills than the
    // callout queue; every original amount still reaches the final accounting.
    const state = renderer.snapshot(.5 / renderer.getDuration());
    expect(state.currentEventIndex).toBeGreaterThan(2);
    const expected = structuredClone(third);
    for (const seek of [1, 0, .7, .1]) renderer.render(seek);
    expect(labelsAt(.5)).toEqual(expected);
    expect(renderer.snapshot(1)).toEqual(expect.objectContaining({ invested: 171, proceeds: 270, holdings: 0, pnl: 99 }));
    expect(payload).toEqual(original);
  });

  it('keeps at most four chronological buy rows in one column, clear of the transaction circles', async () => {
    const drawn: DrawnText[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(buyBurst());
    const shown = new Set<string>();
    for (let seconds = .04; seconds < 3; seconds += .04) {
      drawn.length = 0; renderer.render(seconds / renderer.getDuration());
      const labels = drawn.filter(label => label.color === '#16c784' && /^\$\d+\.00$/.test(label.value)
        && label.y >= 258 && label.y <= 666);
      expect(labels.length).toBeLessThanOrEqual(4);
      labels.forEach(label => shown.add(label.value));
      for (let index = 1; index < labels.length; index += 1) {
        expect(labels[index].x).toBe(labels[0].x);
        expect(labels[index].y - labels[index - 1].y).toBeCloseTo(36, 8);
        expect(Number(labels[index].value.slice(1))).toBeGreaterThan(Number(labels[index - 1].value.slice(1)));
      }
      for (const label of labels) for (const circle of drawn.filter(label => /^[BS]$/.test(label.value))) {
        const left = Math.max(label.x - label.value.length * 10, label.clip?.x ?? -Infinity);
        const right = Math.min(label.x + label.value.length * 10, label.clip ? label.clip.x + label.clip.width : Infinity);
        const top = Math.max(label.y - 15, label.clip?.y ?? -Infinity);
        const bottom = Math.min(label.y + 15, label.clip ? label.clip.y + label.clip.height : Infinity);
        if (right <= left || bottom <= top) continue;
        const dx = Math.max(left - circle.x, 0, circle.x - right);
        const dy = Math.max(top - circle.y, 0, circle.y - bottom);
        expect(Math.hypot(dx, dy), JSON.stringify({ seconds, label, circle })).toBeGreaterThan(20);
      }
    }
    expect([...shown]).toEqual(Array.from({ length: 9 }, (_, index) => `$${15 + index}.00`));
  });

  it('skips an unknown buy amount without leaving a gap in the column', async () => {
    const payload = buyBurst(); payload.trades[1].amountUsd = null;
    const drawn: DrawnText[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(payload);
    drawn.length = 0; renderer.render(.28 / renderer.getDuration());
    const labels = drawn.filter(label => label.color === '#16c784' && /^\$\d+\.00$/.test(label.value)
      && label.y >= 258 && label.y <= 666);
    expect(labels.map(label => label.value)).toEqual(['$15.00', '$17.00']);
    expect(labels[1].y - labels[0].y).toBeCloseTo(36, 8);
  });

  it('finishes a dense closing buy queue within the existing final hold without delaying PnL', async () => {
    const drawn: DrawnText[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(buyBurst(12, true));
    const duration = renderer.getDuration(), closing = renderer.chartProgress(1), shown = new Set<string>();
    expect((1 - closing) * duration).toBeCloseTo(1.5, 8);
    expect(renderer.snapshot(closing)).toEqual(expect.objectContaining({ invested: 246, proceeds: 360, holdings: 0, pnl: 114 }));
    for (let seconds = closing * duration; seconds <= duration; seconds += 1 / 60) {
      drawn.length = 0; renderer.render(seconds / duration);
      for (const label of drawn) if (label.color === '#16c784' && /^\$\d+\.00$/.test(label.value)
        && label.y >= 258 && label.y <= 666) shown.add(label.value);
    }
    expect(shown.size).toBe(11);
    drawn.length = 0; renderer.render(1);
    expect(drawn.some(label => label.color === '#16c784' && label.value.startsWith('$') && label.y >= 258 && label.y <= 666)).toBe(false);
  });

  it('keeps amounts for simultaneous trades separate and clear of visible circles', async () => {
    const payload = atomicPosition();
    payload.trades[19].amountUsd = 141.23; payload.trades[20].amountUsd = 257.45;
    const drawn: DrawnText[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(payload);
    const motion = renderer as ReplayCanvas & MotionMethods;
    const progress = renderer.eventProgress(19) + .4 / renderer.getDuration();
    drawn.length = 0; renderer.render(progress);
    const labels = ['$141.23', '$257.45'].map(value => drawn.find(label => label.value === value && label.y >= 258 && label.y <= 666)!);
    expect(labels.every(Boolean)).toBe(true);
    expect(Math.abs(labels[0].y - labels[1].y)).toBeGreaterThan(25);
    const circles = drawn.filter(label => /^[BS]$/.test(label.value));
    for (const label of labels) for (const circle of circles) {
      const dx = Math.max(Math.abs(label.x - circle.x) - label.value.length * 10, 0);
      const dy = Math.max(Math.abs(label.y - circle.y) - 15, 0);
      expect(Math.hypot(dx, dy)).toBeGreaterThan(motion.markerRadius);
    }
    const expected = structuredClone(labels);
    for (const seek of [1, 0, .8, progress]) renderer.render(seek);
    drawn.length = 0; renderer.render(progress);
    expect(['$141.23', '$257.45'].map(value => drawn.find(label => label.value === value && label.y >= 258 && label.y <= 666))).toEqual(expected);
  });

  it('omits unknown transaction values instead of adding an invented amount', async () => {
    const payload = data(); payload.trades[2].amountUsd = null;
    const drawn: DrawnText[] = [];
    const renderer = new ReplayCanvas(canvasStub(drawn)); await renderer.setData(payload);
    const progress = renderer.eventProgress(2) + .4 / renderer.getDuration();
    drawn.length = 0; renderer.render(progress);
    const labels = drawn.filter(label => label.x >= 42 && label.x <= 814 && label.y >= 258 && label.y <= 666);
    expect(labels.some(label => label.value === '$30.00')).toBe(false);
    expect(labels.some(label => label.value === '$20.00' && label.color === '#16c784')).toBe(true);
    expect(drawn.some(label => label.value === 'S')).toBe(true);
  });

  it('gives a day of post-trade market history more playback time than a few minutes', async () => {
    const brief = await replay(longPosition()), extended = await replay(longPosition(24 * 3600));
    const tailSeconds = ({ renderer, motion }: Awaited<ReturnType<typeof replay>>) =>
      (motion.chartProgress(1) - renderer.eventProgress(3)) * renderer.getDuration();
    expect(tailSeconds(extended)).toBeGreaterThan(tailSeconds(brief) * 2);
    const activeSeconds = extended.motion.chartProgress(1) * extended.renderer.getDuration();
    expect(tailSeconds(extended) / activeSeconds).toBeCloseTo(24 / 56, 10);
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
      expect(Number.isFinite(progress)).toBe(true); expect(progress).toBe(0); expect(progress).toBeGreaterThanOrEqual(previousEvent);
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

  it('retains green buy and red sell circles at their genuine shared timestamp', async () => {
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
