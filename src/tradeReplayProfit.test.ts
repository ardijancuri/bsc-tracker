import { describe, expect, it } from 'vitest';
import ReplayCanvas from './tradeReplayCanvas';
import type { TradeReplayData } from './tradeReplayData';

const start = Date.parse('2026-10-11T10:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();

function data(): TradeReplayData {
  return {
    kol: { address: '0x1111111111111111111111111111111111111111', name: 'Trader', avatarUrl: null, twitter: null },
    token: { address: '0x2222222222222222222222222222222222222222', symbol: 'TEST', name: 'Test', logoUrl: null, priceUsd: 999, marketCapUsd: 999000 },
    trades: [
      { id: 'first-buy', txHash: '0xfirst', timestamp: at(0), side: 'buy', tokenAmount: 100, amountUsd: 100, priceUsd: 1, marketCapUsd: 1000, cumulativeRealizedProfitUsd: 0 },
      { id: 'second-buy', txHash: '0xsecond', timestamp: at(60), side: 'buy', tokenAmount: 100, amountUsd: 300, priceUsd: 3, marketCapUsd: 3000, cumulativeRealizedProfitUsd: 0 },
      { id: 'partial-sell', txHash: '0xpartial', timestamp: at(180), side: 'sell', tokenAmount: 150, amountUsd: 600, priceUsd: 4, marketCapUsd: 4000, cumulativeRealizedProfitUsd: 350 },
      { id: 'final-sell', txHash: '0xfinal', timestamp: at(300), side: 'sell', tokenAmount: 50, amountUsd: 100, priceUsd: 2, marketCapUsd: 2000, cumulativeRealizedProfitUsd: 300 },
    ],
    position: { status: 'unknown', tokenBalance: null, tradeFlowMatched: false, tradesComplete: true, checkedAt: null },
    chart: {
      points: [[0, 1], [30, 2], [60, 3], [120, 5], [180, 4], [240, .5], [300, 2], [360, 999]].map(([seconds, price]) => ({
        timestamp: at(seconds), priceUsd: price, marketCapUsd: price * 1000,
      })),
      marketCapSupply: 1000, resolution: '1m', source: 'Historical market samples',
    },
    source: { chart: 'Historical market samples', tradesComplete: true },
    realizedAccounting: { available: true },
    generatedAt: at(360),
  };
}

function canvasStub(drawn?: string[]): HTMLCanvasElement {
  const context = new Proxy({}, {
    get: (_target, key) => key === 'measureText' ? (value: string) => ({ width: value.length * 20 })
      : key === 'fillText' ? (value: string) => drawn?.push(value)
      : key === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => undefined,
  });
  return { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
}

async function replay(payload = data(), drawn?: string[]) {
  const renderer = new ReplayCanvas(canvasStub(drawn));
  await renderer.setData(payload);
  return renderer;
}

function between(renderer: ReplayCanvas, before: number, after: number, fraction: number) {
  return renderer.eventProgress(before) + (renderer.eventProgress(after) - renderer.eventProgress(before)) * fraction;
}

function recordingCanvas() {
  const texts: { value: string; color: unknown; font: string; x: number; y: number; baseline: unknown }[] = [];
  const strokes: { width: number; color: unknown; shadow: unknown }[] = [];
  const gradients: { coordinates: number[]; stops: [number, string][] }[] = [];
  const properties: Record<string, unknown> = { font: '10px sans-serif', lineWidth: 1, fillStyle: '#000', strokeStyle: '#000' };
  const stack: Record<string, unknown>[] = [];
  const methods: Record<string, unknown> = {
    measureText: (value: string) => {
      const size = Number(/([\d.]+)px/.exec(String(properties.font))?.[1] ?? 10);
      return { width: value.length * size * .55, actualBoundingBoxAscent: size * .75,
        actualBoundingBoxDescent: size * .2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: value.length * size * .55 };
    },
    fillText: (value: string, x: number, y: number) => texts.push({ value, color: properties.fillStyle, font: String(properties.font), x, y, baseline: properties.textBaseline }),
    stroke: () => strokes.push({ width: Number(properties.lineWidth), color: properties.strokeStyle, shadow: properties.shadowColor }),
    createLinearGradient: (...coordinates: number[]) => {
      const gradient = { coordinates, stops: [] as [number, string][] };
      gradients.push(gradient);
      return { addColorStop: (offset: number, color: string) => gradient.stops.push([offset, color]) };
    },
    save: () => stack.push({ ...properties }),
    restore: () => {
      const saved = stack.pop();
      if (saved) {
        for (const key of Object.keys(properties)) delete properties[key];
        Object.assign(properties, saved);
      }
    },
  };
  const context = new Proxy(properties, {
    get: (target, key) => typeof key === 'string' && key in target ? target[key]
      : typeof key === 'string' && key in methods ? methods[key] : () => undefined,
    set: (target, key, value) => { target[String(key)] = value; return true; },
  });
  return {
    canvas: { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement,
    texts, strokes, gradients,
    clear() { texts.length = strokes.length = gradients.length = 0; },
  };
}

async function recordedReplay(payload = data()) {
  const drawing = recordingCanvas();
  const renderer = new ReplayCanvas(drawing.canvas);
  await renderer.setData(payload);
  drawing.clear();
  return { renderer, drawing };
}

describe('trade replay rolling recorded-position profit', () => {
  it('marks unsold tokens continuously at the same interpolated quote as the chart, including rises and losses', async () => {
    const renderer = await replay();
    const rising = renderer.snapshot(between(renderer, 1, 2, .25));
    const peak = renderer.snapshot(between(renderer, 1, 2, .5));
    const falling = renderer.snapshot(between(renderer, 1, 2, .75));
    expect(peak.currentPrice).toBe(5);
    expect(peak.unrealizedPnl).toBe(600);
    expect(peak.totalPnl).toBe(600);
    expect(peak.totalRoi).toBe(1.5);
    expect(rising.unrealizedPnl).toBeLessThan(peak.unrealizedPnl!);
    expect(falling.unrealizedPnl).toBeLessThan(peak.unrealizedPnl!);
    for (const progress of [between(renderer, 0, 1, .371), between(renderer, 1, 2, .613), between(renderer, 2, 3, .43)]) {
      const snapshot = renderer.snapshot(progress);
      expect(snapshot.currentPrice).toBe(renderer.valueAtStory(progress).priceUsd);
      expect(snapshot.unrealizedPnl).toBeCloseTo(snapshot.holdings! * snapshot.currentPrice - snapshot.remainingCostBasis!, 10);
      expect(snapshot.totalPnl).toBeCloseTo(snapshot.realizedPnl! + snapshot.unrealizedPnl!, 10);
    }
    const loss = renderer.snapshot(between(renderer, 2, 3, .5));
    expect(loss.currentPrice).toBe(.5);
    expect(loss.unrealizedPnl).toBe(-125);
    expect(loss.totalPnl).toBe(225);
  });

  it('uses remaining FIFO cost after a partial sale and avoids double counting realized profit', async () => {
    const renderer = await replay();
    const before = renderer.snapshot(renderer.eventProgress(2) - 1e-7);
    const sold = renderer.snapshot(renderer.eventProgress(2));
    expect(before.holdings).toBe(200);
    expect(before.remainingCostBasis).toBe(400);
    expect(before.realizedPnl).toBe(0);
    expect(sold.holdings).toBe(50);
    expect(sold.remainingCostBasis).toBe(150);
    expect(sold.realizedPnl).toBe(350);
    expect(sold.unrealizedPnl).toBe(50);
    expect(sold.totalPnl).toBe(400);
    expect(sold.totalRoi).toBe(1);
    expect(before.totalPnl).toBeCloseTo(sold.totalPnl!, 3);
    expect(sold.totalPnl).toBe(sold.proceeds! + sold.holdings! * sold.currentPrice - sold.invested!);
  });

  it('moves fully sold positions to zero unrealized profit and holds final realized profit throughout the ending', async () => {
    const renderer = await replay();
    const exit = renderer.snapshot(renderer.eventProgress(3));
    expect(exit.holdings).toBe(0);
    expect(exit.remainingCostBasis).toBe(0);
    expect(exit.realizedPnl).toBe(300);
    expect(exit.unrealizedPnl).toBe(0);
    expect(exit.totalPnl).toBe(300);
    expect(exit.totalRoi).toBe(.75);
    expect(renderer.snapshot(1)).toEqual(exit);
    expect(exit.currentPrice).toBe(2);
  });

  it.each(['unknown', 'mismatched'] as const)('keeps %s wallet P&L withheld while allowing labelled recorded-trade estimates', async variant => {
    const payload = data();
    if (variant === 'mismatched') payload.position = { ...payload.position, status: 'open', tokenBalance: 999, checkedAt: at(360) };
    const renderer = await replay(payload);
    const partial = renderer.snapshot(renderer.eventProgress(2));
    expect(partial.pnl).toBeNull(); expect(partial.roi).toBeNull();
    expect(partial.totalPnl).toBe(400); expect(partial.unrealizedPnl).toBe(50);
    expect(renderer.snapshot(1).status).toBe(variant === 'mismatched' ? 'Open' : 'Unknown');
  });

  it('retains the existing independently reconciled wallet P&L and matches the recorded total when both are available', async () => {
    const payload = data();
    payload.position = { status: 'closed', tokenBalance: 0, tradeFlowMatched: true, tradesComplete: true, checkedAt: at(360) };
    const renderer = await replay(payload);
    for (const progress of [0, between(renderer, 1, 2, .42), renderer.eventProgress(2), 1]) {
      const snapshot = renderer.snapshot(progress);
      expect(snapshot.pnl).toBeCloseTo(snapshot.totalPnl!, 10);
      expect(snapshot.roi).toBeCloseTo(snapshot.totalRoi!, 10);
    }
  });

  it('does not leak final sale totals, later spot prices or later cumulative results into earlier frames', async () => {
    const original = await replay();
    const altered = data();
    altered.token.priceUsd = 1e9;
    altered.trades[3].cumulativeRealizedProfitUsd = 1e8;
    altered.chart.points.at(-1)!.priceUsd = 1e9;
    const changed = await replay(altered);
    for (const progress of [0, between(original, 0, 1, .35), between(original, 1, 2, .5), original.eventProgress(2)]) {
      const snapshot = original.snapshot(progress);
      const other = changed.snapshot(progress);
      expect(other.remainingCostBasis).toBe(snapshot.remainingCostBasis);
      expect(other.realizedPnl).toBe(snapshot.realizedPnl);
      expect(other.unrealizedPnl).toBe(snapshot.unrealizedPnl);
      expect(other.totalPnl).toBe(snapshot.totalPnl);
    }
  });

  it('keeps accounting deterministic for seeking, reverse rendering and export frames rendered out of order', async () => {
    const renderer = await replay();
    const progress = [0, .043, .137, .331, .572, .799, .84, 1];
    const snapshots = progress.map(point => renderer.snapshot(point));
    for (const index of [7, 0, 5, 2, 6, 3, 1, 4, 2, 7]) {
      renderer.render(progress[index]);
      expect(renderer.snapshot(progress[index])).toEqual(snapshots[index]);
    }
  });

  it('accounts for same-second fills only when their distinct replay events are revealed', async () => {
    const payload = data();
    payload.trades[2].timestamp = payload.trades[1].timestamp;
    const renderer = await replay(payload);
    const bought = renderer.snapshot(renderer.eventProgress(1));
    const sold = renderer.snapshot(renderer.eventProgress(2));
    expect(bought.time).toBe(sold.time);
    expect(bought.realizedPnl).toBe(0); expect(bought.remainingCostBasis).toBe(400);
    expect(sold.realizedPnl).toBe(350); expect(sold.remainingCostBasis).toBe(150);
    expect(renderer.eventProgress(2)).toBeGreaterThan(renderer.eventProgress(1));
  });

  it('estimates recorded open lots at the displayed fill-price curve while keeping verified wallet profit withheld', async () => {
    const payload = data();
    payload.chart.points = [];
    payload.chart.source = payload.source.chart = 'Recorded fills';
    const renderer = await replay(payload);
    const open = renderer.snapshot(renderer.eventProgress(2));
    expect(open.remainingCostBasis).toBe(150);
    expect(open.pnl).toBeNull();
    expect(open.unrealizedPnl).toBe(50); expect(open.totalPnl).toBe(400); expect(open.totalRoi).toBe(1);
    const moving = renderer.snapshot(between(renderer, 2, 3, .5));
    expect(moving.unrealizedPnl).toBeCloseTo(moving.holdings! * moving.currentPrice - moving.remainingCostBasis!, 10);
    expect(moving.currentPrice).toBe(renderer.valueAtStory(between(renderer, 2, 3, .5)).priceUsd);
    const exit = renderer.snapshot(1);
    expect(exit.unrealizedPnl).toBe(0); expect(exit.totalPnl).toBe(300);
  });

  it.each(['partial', 'missing-cost', 'missing-quantity', 'missing-sale-cumulative', 'no-realized-summary', 'oversell'] as const)(
    'withholds rolling profit for %s accounting instead of presenting a partial total', async variant => {
      const payload = data();
      if (variant === 'partial') payload.source.tradesComplete = payload.position.tradesComplete = false;
      if (variant === 'missing-cost') payload.trades[0].amountUsd = null;
      if (variant === 'missing-quantity') payload.trades[0].tokenAmount = null;
      if (variant === 'missing-sale-cumulative') payload.trades[2].cumulativeRealizedProfitUsd = null;
      if (variant === 'no-realized-summary') payload.realizedAccounting!.available = false;
      if (variant === 'oversell') payload.trades[2].tokenAmount = 201;
      const renderer = await replay(payload);
      const snapshot = renderer.snapshot(renderer.eventProgress(2));
      expect(snapshot.remainingCostBasis).toBeNull();
      expect(snapshot.unrealizedPnl).toBeNull(); expect(snapshot.totalPnl).toBeNull(); expect(snapshot.totalRoi).toBeNull();
    },
  );

  it('rejects negative remaining basis and a supposedly closed sale whose cumulative profit leaves a nonzero basis', async () => {
    for (const [sale, cumulative] of [[2, 100], [3, 310]]) {
      const payload = data(); payload.trades[sale].cumulativeRealizedProfitUsd = cumulative;
      const renderer = await replay(payload);
      const snapshot = renderer.snapshot(renderer.eventProgress(sale));
      expect(snapshot.remainingCostBasis).toBeNull();
      expect(snapshot.unrealizedPnl).toBeNull(); expect(snapshot.totalPnl).toBeNull();
    }
  });

  it('preserves tiny token quantities and their dollar cost instead of treating an open lot as a free balance', async () => {
    const payload = data();
    for (const trade of payload.trades) {
      trade.tokenAmount! *= 1e-15;
      trade.priceUsd! *= 1e15;
    }
    for (const point of payload.chart.points) point.priceUsd *= 1e15;
    payload.chart.marketCapSupply = null;
    const renderer = await replay(payload);
    const sold = renderer.snapshot(renderer.eventProgress(2));
    expect(sold.holdings).toBeCloseTo(5e-14, 25);
    expect(sold.remainingCostBasis).toBe(150);
    expect(sold.unrealizedPnl).toBeCloseTo(50, 10);
    expect(sold.totalPnl).toBeCloseTo(400, 10);
  });

  it('renders a simple total profit and return row without extra titles or breakdown', async () => {
    const drawn: string[] = [];
    const renderer = await replay(data(), drawn);
    drawn.length = 0;
    renderer.render(renderer.eventProgress(2));
    expect(drawn.some(value => /p&l|total return|^realized$|^unrealized$/i.test(value))).toBe(false);
    expect(drawn).toContain('+$400.00');
    expect(drawn).toContain('('); expect(drawn).toContain('▲ '); expect(drawn).toContain('100.00%'); expect(drawn).toContain(')');
    expect(drawn).not.toContain('+$350.00');
    expect(drawn).not.toContain('+$50.00');
  });
});

describe('trade replay profit colors and position labels', () => {
  it('uses the moving recorded-price estimate for fallback profit, gradient and scrolling while withholding wallet valuation', async () => {
    const payload = data(); payload.chart.points = [];
    payload.chart.source = payload.source.chart = 'Recorded fills';
    const { renderer, drawing } = await recordedReplay(payload);
    const early = between(renderer, 1, 2, .25), late = between(renderer, 1, 2, .75);
    const first = renderer.snapshot(early), second = renderer.snapshot(late);
    expect(first.pnl).toBeNull(); expect(second.pnl).toBeNull();
    expect(second.totalPnl).toBeGreaterThan(first.totalPnl!);
    expect(second.totalPnl).toBeCloseTo(second.realizedPnl! + second.holdings! * second.currentPrice - second.remainingCostBasis!, 10);
    expect(renderer.viewportAt(late).startQ).toBeGreaterThan(renderer.viewportAt(early).startQ);
    renderer.render(late);
    expect(drawing.strokes.find(stroke => stroke.width === 8)?.color).toBe('#16c784');
    expect(drawing.gradients.find(gradient => gradient.coordinates.join(',') === '0,272,0,651')?.stops[0]).toEqual([0, 'rgba(22,199,132,0.18)']);
  });

  it('keeps fallback profit unavailable when recorded costs or cumulative sale accounting are missing', async () => {
    for (const variant of ['cost', 'quantity', 'sale', 'coverage'] as const) {
      const payload = data(); payload.chart.points = [];
      payload.chart.source = payload.source.chart = 'Recorded fills';
      if (variant === 'cost') payload.trades[0].amountUsd = null;
      if (variant === 'quantity') payload.trades[0].tokenAmount = null;
      if (variant === 'sale') payload.trades[2].cumulativeRealizedProfitUsd = null;
      if (variant === 'coverage') payload.source.tradesComplete = false;
      const renderer = await replay(payload);
      expect(renderer.snapshot(renderer.eventProgress(2)).totalPnl).toBeNull();
    }
  });
  it.each([
    ['positive', '#16c784', '22,199,132'],
    ['negative', '#f6465d', '246,70,93'],
    ['zero', '#16c784', '22,199,132'],
    ['unavailable', '#f0b90b', '240,185,11'],
  ] as const)('colors the actual chart line and area from %s displayed profit', async (variant, color, rgb) => {
    const payload = data();
    if (variant === 'negative') payload.chart.points[1] = { timestamp: at(30), priceUsd: .5, marketCapUsd: 500 };
    if (variant === 'unavailable') payload.realizedAccounting!.available = false;
    const { renderer, drawing } = await recordedReplay(payload);
    const progress = variant === 'zero' ? renderer.eventProgress(0)
      : variant === 'negative' ? between(renderer, 0, 1, .5) : renderer.eventProgress(2);
    const state = renderer.snapshot(progress);
    expect(state.pnl).toBeNull();
    expect(state.totalPnl).toBe(variant === 'positive' ? 400 : variant === 'negative' ? -50 : variant === 'zero' ? 0 : null);
    renderer.render(progress);
    expect(drawing.strokes.filter(stroke => stroke.width === 8)).toEqual([
      { width: 8, color, shadow: `rgba(${rgb},0.38)` },
    ]);
    expect(drawing.gradients.find(gradient => gradient.coordinates.join(',') === '0,272,0,651')?.stops).toEqual([
      [0, `rgba(${rgb},0.18)`], [.68, `rgba(${rgb},0.055)`], [1, `rgba(${rgb},0)`],
    ]);
    if (variant !== 'unavailable') expect(drawing.texts.some(text => text.color === color && /^[+−]?\$/.test(text.value))).toBe(true);
  });

  it('switches with live total P&L and stays green when realized gains outweigh falling unrealized profit', async () => {
    const payload = data();
    payload.chart.points[1] = { timestamp: at(30), priceUsd: .5, marketCapUsd: 500 };
    const { renderer, drawing } = await recordedReplay(payload);
    const samples = [
      { progress: between(renderer, 0, 1, .5), pnl: -50, color: '#f6465d' },
      { progress: renderer.eventProgress(1), pnl: 200, color: '#16c784' },
      { progress: between(renderer, 2, 3, .5), pnl: 225, color: '#16c784' },
    ];
    for (const sample of samples) {
      drawing.clear();
      expect(renderer.snapshot(sample.progress).totalPnl).toBe(sample.pnl);
      renderer.render(sample.progress);
      expect(drawing.strokes.find(stroke => stroke.width === 8)?.color).toBe(sample.color);
    }
    expect(renderer.snapshot(samples[2].progress).unrealizedPnl).toBe(-125);
  });

  it.each(['gain', 'loss'] as const)('renders %s percentages white, parentheses gray, and direction arrows in the profit color', async variant => {
    const payload = data();
    if (variant === 'loss') payload.chart.points[1] = { timestamp: at(30), priceUsd: .5, marketCapUsd: 500 };
    const { renderer, drawing } = await recordedReplay(payload);
    renderer.render(variant === 'loss' ? between(renderer, 0, 1, .5) : renderer.eventProgress(2));
    const parts = ['(', variant === 'loss' ? '▼ ' : '▲ ', variant === 'loss' ? '50.00%' : '100.00%', ')'];
    const drawn = parts.map(value => drawing.texts.find(text => text.value === value)!);
    expect(drawn.map(text => text?.color)).toEqual(['#a9a69a', variant === 'loss' ? '#f6465d' : '#16c784', '#f8f6ee', '#a9a69a']);
    const sizes = drawn.map(text => Number(/([\d.]+)px/.exec(text.font)![1]));
    expect(sizes[2]).toBeGreaterThanOrEqual(26); expect(sizes[2]).toBeLessThanOrEqual(36);
    expect(sizes[0]).toBeLessThan(sizes[2]); expect(sizes[1]).toBeLessThan(sizes[2]);
    expect(sizes[3]).toBe(sizes[0]);
    drawn.forEach((text, index) => expect(text.y - sizes[index] * (.75 - .2) / 2).toBeCloseTo(907));
    expect(drawn.every((text, index) => index === 0 || text.x > drawn[index - 1].x)).toBe(true);
  });

  it('labels partial sells Open and falls back to complete recorded positions at the ending', async () => {
    const payload = data();
    const { renderer, drawing } = await recordedReplay(payload);
    renderer.render(renderer.eventProgress(2));
    expect(drawing.texts.some(text => text.value === 'Open')).toBe(true);
    drawing.clear(); renderer.render(1);
    expect(renderer.snapshot(1).status).toBe('Unknown');
    expect(drawing.texts.some(text => text.value === 'Closed')).toBe(true);

    payload.trades = payload.trades.slice(0, 3);
    const open = await recordedReplay(payload);
    open.renderer.render(1);
    expect(open.renderer.snapshot(1).status).toBe('Unknown');
    expect(open.drawing.texts.some(text => text.value === 'Open')).toBe(true);
  });

  it('labels a reconciled loss exit Closed without claiming a realized profit', async () => {
    const payload = data();
    payload.trades[2] = { ...payload.trades[2], amountUsd: 100, cumulativeRealizedProfitUsd: -150 };
    payload.trades[3] = { ...payload.trades[3], amountUsd: 25, cumulativeRealizedProfitUsd: -275 };
    payload.position = { status: 'closed', tokenBalance: 0, tradeFlowMatched: true, tradesComplete: true, checkedAt: at(360) };
    const { renderer, drawing } = await recordedReplay(payload);
    renderer.render(1);
    expect(renderer.snapshot(1).totalPnl).toBe(-275);
    expect(drawing.texts.some(text => text.value === 'Closed')).toBe(true);
    expect(drawing.texts.some(text => /profit realized/i.test(text.value))).toBe(false);
  });

  it('prefers verified ending balances when complete recorded swaps disagree', async () => {
    const held = data();
    held.position = { ...held.position, status: 'open', tokenBalance: 999, checkedAt: at(360) };
    const open = await recordedReplay(held); open.renderer.render(1);
    expect(open.renderer.snapshot(1).holdings).toBe(0);
    expect(open.renderer.snapshot(1).status).toBe('Open');
    expect(open.drawing.texts.some(text => text.value === 'Open')).toBe(true);
    expect(open.drawing.texts.some(text => text.value === 'Closed')).toBe(false);

    const transferred = data(); transferred.trades = transferred.trades.slice(0, 3);
    transferred.position = { ...transferred.position, status: 'closed', tokenBalance: 0, checkedAt: at(360) };
    const closed = await recordedReplay(transferred); closed.renderer.render(1);
    expect(closed.renderer.snapshot(1).holdings).toBe(50);
    expect(closed.renderer.snapshot(1).status).toBe('Closed');
    expect(closed.drawing.texts.some(text => text.value === 'Closed')).toBe(true);
    expect(closed.drawing.texts.some(text => text.value === 'Open')).toBe(false);
  });

  it.each(['incomplete', 'missing-quantity', 'oversell'] as const)('omits the position badge for %s recorded trades without a verified balance', async variant => {
    const payload = data();
    if (variant === 'incomplete') payload.source.tradesComplete = payload.position.tradesComplete = false;
    if (variant === 'missing-quantity') payload.trades[0].tokenAmount = null;
    if (variant === 'oversell') payload.trades[2].tokenAmount = 201;
    const { renderer, drawing } = await recordedReplay(payload); renderer.render(1);
    expect(renderer.snapshot(1).status).toBe('Unknown');
    expect(drawing.texts.some(text => text.value === 'Open' || text.value === 'Closed')).toBe(false);
    expect(drawing.texts.some(text => /STATUS UNAVAILABLE|RECORDED POSITION|EXITED/.test(text.value))).toBe(false);
  });
});
