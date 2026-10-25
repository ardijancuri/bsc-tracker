/**
 * Adapted from the user-supplied BScan Trade Replay Studio (second handoff).
 * BScan trade recap, drawn entirely on a 1080 × 1350 canvas.
 *
 * One linear clock compresses the approved position history consistently.
 * Dates, chart prices, and fill values remain real data.
 * All rendering is derived from `progress`; exporting frames in any order gives
 * the same result.
 */

import { BRAND_ICON_PATHS, BRAND_WORDMARK_PATHS } from './tradeReplayBrandPaths';
import { replayAccountingTotal, replayEndTimestamp, replayIsOpen } from './tradeReplayData';
import { createTradeReplayTiming } from './tradeReplayTiming';
import { createTradeReplayAmountSchedule } from './tradeReplayAmounts';

const WIDTH = 1080;
const HEIGHT = 1350;
const MINUTE = 60_000;
const PLAYHEAD_FRACTION = 0.74;
const MARKER_RADIUS = 20;
const FONT = 'Manrope, system-ui, sans-serif';

const COLOR = {
  frame: '#f0b90b',
  dark: '#0c0e11',
  panel: '#151513',
  panelEdge: '#35332b',
  white: '#f8f6ee',
  muted: '#a9a69a',
  dim: '#777367',
  gold: '#f0b90b',
  goldBright: '#ffd44b',
  green: '#16c784',
  red: '#f6465d',
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function finite(value, fallback = 0) {
  if (value == null || value === '' || typeof value === 'boolean') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value) {
  const parsed = finite(value, NaN);
  return parsed > 0 ? parsed : null;
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fillRound(ctx, x, y, width, height, radius, fill, stroke, lineWidth = 1) {
  roundedRect(ctx, x, y, width, height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

function text(ctx, value, x, y, font, color, align = 'left', baseline = 'alphabetic') {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillStyle = color;
  ctx.fillText(String(value), x, y);
}

function textBounds(ctx, value, font) {
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  const metrics = ctx.measureText(value);
  const size = Number(/([\d.]+)px/.exec(font)?.[1]) || 0;
  return {
    ascent: finite(metrics.actualBoundingBoxAscent, size * 0.75),
    descent: finite(metrics.actualBoundingBoxDescent, size * 0.2),
  };
}

function displayedProfit(state) {
  const total = finite(state.totalPnl, null);
  return total !== null
    ? { pnl: total, roi: finite(state.totalRoi, null) }
    : { pnl: finite(state.pnl, null), roi: finite(state.roi, null) };
}

function drawBrandMark(ctx, mark, x, y, width, height, color) {
  const transform = values => {
    for (const [kind, a, b] of values) {
      if (kind === 'translate') ctx.translate(a, b ?? 0);
      else ctx.scale(a, b ?? a);
    }
  };
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(width / mark.width, height / mark.height);
  transform(mark.transforms);
  ctx.fillStyle = color;
  for (const path of mark.paths) {
    ctx.save();
    transform(path.transforms);
    ctx.beginPath();
    let px = 0, py = 0, startX = 0, startY = 0;
    for (const [op, ...values] of path.commands) {
      if (op === 'M') {
        [px, py] = values; [startX, startY] = values;
        ctx.moveTo(px, py);
      } else if (op === 'L') {
        [px, py] = values; ctx.lineTo(px, py);
      } else if (op === 'H') {
        px = values[0]; ctx.lineTo(px, py);
      } else if (op === 'V') {
        py = values[0]; ctx.lineTo(px, py);
      } else if (op === 'C') {
        ctx.bezierCurveTo(...values); [px, py] = values.slice(4);
      } else if (op === 'Q') {
        ctx.quadraticCurveTo(...values); [px, py] = values.slice(2);
      } else {
        ctx.closePath(); px = startX; py = startY;
      }
    }
    ctx.fill('evenodd');
    ctx.restore();
  }
  ctx.restore();
}

function fitFont(ctx, value, maxWidth, size, minSize, weight = 700) {
  let current = size;
  while (current > minSize) {
    ctx.font = `${weight} ${current}px ${FONT}`;
    if (ctx.measureText(String(value)).width <= maxWidth) break;
    current -= 1;
  }
  return `${weight} ${current}px ${FONT}`;
}

function money(value, decimals = 2, compact = false) {
  const abs = Math.abs(finite(value));
  if (compact) {
    if (abs >= 1e12) return `$${(abs / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1)}K`;
    return `$${abs.toLocaleString('en-US', { minimumFractionDigits: abs < 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
  }
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  return `$${abs.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function resultMoney(value) {
  return `${value >= 0 ? '+' : '−'}${money(value)}`;
}

function percentage(value) {
  const pct = Math.abs(finite(value)) * 100;
  const digits = pct < 1000 ? 2 : pct < 100000 ? 1 : 0;
  return `${pct.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

function shortName(value, limit = 25) {
  const name = String(value || '').trim();
  return name.length > limit ? `${name.slice(0, limit - 1)}…` : name;
}

function dateLabel(time) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(time);
}

function axisLabel(time, span) {
  if (span < 24 * 60 * MINUTE) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit',
      hour12: false,
    }).format(time);
  }
  if (span < 2 * 24 * 60 * MINUTE) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(time);
  }
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(time);
}

const AXIS_STEPS = [
  MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE,
  30 * MINUTE, 60 * MINUTE, 2 * 60 * MINUTE, 4 * 60 * MINUTE,
  6 * 60 * MINUTE, 12 * 60 * MINUTE, 24 * 60 * MINUTE,
  2 * 24 * 60 * MINUTE, 7 * 24 * 60 * MINUTE,
  14 * 24 * 60 * MINUTE, 30 * 24 * 60 * MINUTE,
  90 * 24 * 60 * MINUTE, 365 * 24 * 60 * MINUTE,
];

function axisStep(span) {
  const choices = span >= 2 * 24 * 60 * MINUTE
    ? AXIS_STEPS.filter((step) => step >= 24 * 60 * MINUTE)
    : AXIS_STEPS;
  const target = Math.max(MINUTE, span / 7);
  return choices.reduce((best, step) =>
    Math.abs(Math.log(step / target)) < Math.abs(Math.log(best / target)) ? step : best);
}

function normalizeImageUrl(raw) {
  if (!raw || typeof raw !== 'string' || typeof location === 'undefined') return null;
  try {
    const url = new URL(raw, location.href);
    // Cross-origin images can taint the canvas and prevent all video exports.
    return url.origin === location.origin && /^https?:$/.test(url.protocol) ? url.href : null;
  } catch { return null; }
}

function loadImage(url) {
  if (!url || typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => done(null), 8000);
    image.onload = () => done(image);
    image.onerror = () => done(null);
    image.src = url;
  });
}

function imageCircle(ctx, image, x, y, radius, fallbackText, fallbackColor) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  if (image && image.naturalWidth > 0) {
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const sx = (image.naturalWidth - side) / 2;
    const sy = (image.naturalHeight - side) / 2;
    ctx.drawImage(image, sx, sy, side, side, x - radius, y - radius, radius * 2, radius * 2);
  } else {
    const gradient = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
    gradient.addColorStop(0, fallbackColor);
    gradient.addColorStop(1, '#41330c');
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    text(ctx, fallbackText, x, y + 2, `800 ${radius * 0.8}px ${FONT}`, COLOR.white, 'center', 'middle');
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
}

function monotoneTangents(points, key) {
  if (points.length < 2) return points.map(() => 0);
  const slopes = points.slice(1).map((point, i) => {
    const dx = point.q - points[i].q;
    return dx > 0 ? (point[key] - points[i][key]) / dx : 0;
  });
  return points.map((_, i) => {
    if (i === 0) return slopes[0];
    if (i === points.length - 1) return slopes.at(-1);
    const before = slopes[i - 1];
    const after = slopes[i];
    return before * after <= 0 ? 0 : 2 / (1 / before + 1 / after);
  });
}

function hermite(a, b, m0, m1, fraction, span) {
  const t = fraction;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a
    + (t3 - 2 * t2 + t) * span * m0
    + (-2 * t3 + 3 * t2) * b
    + (t3 - t2) * span * m1;
}

export class ReplayCanvas {
  constructor(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('ReplayCanvas requires a canvas element');
    }
    this.canvas = canvas;
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('2D canvas context unavailable');
    this.data = null;
    this.trades = [];
    this.points = [];
    this.plotPoints = [];
    this.storyVertices = [];
    this.storyPriceTangents = [];
    this.storyCapTangents = [];
    this.avatar = null;
    this.logo = null;
    this.brandIcon = null;
    this.brandWordmark = null;
    this.timelineStart = 0;
    this.timelineEnd = 0;
    this.tradeEnd = 0;
    this.eventPhase = 1;
    this.timing = createTradeReplayTiming(0, 0);
    this.durationSeconds = this.timing.durationSeconds;
    this.currentEndPhase = 0;
    this.currentQuote = null;
    this.hasTail = false;
    this.inventoryEvents = [];
    this.accountingEvents = [];
    this.eventProgresses = [];
    this.supply = null;
    this.fillOnly = false;
    this.storyWindow = 0.5;
    this.markerRadius = MARKER_RADIUS;
    this.markerPlacements = [];
    this.amountClusters = [];
    this.axisTicks = [];
    this.cameraValues = [];
    this.yMin = 0;
    this.yMax = 1;
    this.render(0);
  }

  async setData(data) {
    if (!data || !data.kol || !data.token) throw new TypeError('Replay data needs kol and token');
    this.data = data;
    const modern = data.replayAccounting?.version === 2;
    const movementTimes = modern ? (data.inventory?.events ?? []).map(event => Date.parse(event.timestamp)).filter(Number.isFinite) : [];
    this.trades = (Array.isArray(data.trades) ? data.trades : [])
      .map((trade, index) => ({
        ...trade,
        index,
        ts: Date.parse(trade.timestamp),
        side: String(trade.side).toLowerCase(),
        tokenAmount: positive(trade.tokenAmount),
        amountUsd: positive(trade.amountUsd),
        priceUsd: positive(trade.priceUsd),
        marketCapUsd: positive(trade.marketCapUsd),
        cumulativeRealizedProfitUsd: finite(trade.cumulativeRealizedProfitUsd, null),
      }))
      .filter((trade) => Number.isFinite(trade.ts) && (trade.side === 'buy' || trade.side === 'sell'))
      .sort((a, b) => a.ts - b.ts || a.index - b.index)
      .map((trade, index) => ({ ...trade, index }));

    const byTime = new Map();
    for (const point of Array.isArray(data.chart?.points) ? data.chart.points : []) {
      const ts = Date.parse(point.timestamp);
      const priceUsd = finite(point.priceUsd, NaN);
      if (!Number.isFinite(ts) || !Number.isFinite(priceUsd) || priceUsd <= 0) continue;
      byTime.set(ts, { ts, priceUsd, marketCapUsd: finite(point.marketCapUsd, NaN) });
    }
    this.points = [...byTime.values()].sort((a, b) => a.ts - b.ts);
    this.fillOnly = String(data.source?.chart || data.chart?.source || '').toLowerCase().includes('recorded fill');

    const explicitSupply = finite(data.chart?.marketCapSupply, NaN);
    this.supply = explicitSupply > 0 ? explicitSupply : null;
    this.capMode = this.supply !== null;

    for (const point of this.points) {
      if (!(point.marketCapUsd > 0) && this.supply) point.marketCapUsd = point.priceUsd * this.supply;
    }

    // Only synthesize a chart when the upstream returned no historical points.
    // It uses trade fill prices and is visibly identified by the page's source.
    if (!this.points.length) {
      this.fillOnly = true;
      this.points = this.trades.filter((trade) => trade.priceUsd > 0).map((trade) => ({
        ts: trade.ts,
        priceUsd: trade.priceUsd,
        marketCapUsd: trade.marketCapUsd > 0 ? trade.marketCapUsd : this.supply ? trade.priceUsd * this.supply : NaN,
      }));
    }

    // The replay curve is explicitly a composite: sampled pool prices plus
    // exact BScan fill vertices. Every B/S marker therefore sits at a visible
    // fill point. The page's data note explains the composite chart source.
    // A pool quote just before the first on-chain fill can be from a different
    // route and create a false opening spike through the first B/S marker.
    // Begin the recap curve at the first exact execution instead.
    const firstFillTs = movementTimes.length ? Math.min(...movementTimes) : this.trades[0]?.ts ?? -Infinity;
    const lastFillTs = movementTimes.length ? Math.max(...movementTimes) : this.trades.at(-1)?.ts;
    const current = data.currentQuote;
    const currentTs = Date.parse(current?.timestamp);
    const currentPrice = positive(current?.priceUsd);
    this.currentQuote = replayIsOpen(data) && Number.isFinite(currentTs) && currentPrice !== null
      && Number.isFinite(lastFillTs) && currentTs >= lastFillTs
      ? { ts: currentTs, priceUsd: currentPrice,
        marketCapUsd: this.supply ? currentPrice * this.supply : positive(current?.marketCapUsd), kind: 'current' } : null;
    const marketVertices = this.fillOnly ? [] : this.points
      .filter((point) => point.ts >= firstFillTs)
      .map((point) => ({ ...point, kind: 'market' }));
    const fillVertices = this.trades.map((trade, tradeIndex) => ({
      ts: trade.ts,
      priceUsd: trade.priceUsd > 0 ? trade.priceUsd
        : this.supply && trade.marketCapUsd > 0 ? trade.marketCapUsd / this.supply : NaN,
      marketCapUsd: trade.marketCapUsd > 0 ? trade.marketCapUsd
        : this.supply && trade.priceUsd > 0 ? trade.priceUsd * this.supply : NaN,
      kind: 'fill',
      tradeIndex,
    })).filter((point) => point.priceUsd > 0 && (!this.capMode || point.marketCapUsd > 0));
    this.plotPoints = [...marketVertices, ...fillVertices, ...(this.currentQuote ? [this.currentQuote] : [])]
      .sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        if (a.kind === 'current' || b.kind === 'current') return a.kind === 'current' ? 1 : -1;
        if (a.kind !== b.kind) return a.kind === 'market' ? -1 : 1;
        return (a.tradeIndex ?? 0) - (b.tradeIndex ?? 0);
      });
    if (!this.plotPoints.length) this.plotPoints = this.points.map((point) => ({ ...point, kind: 'market' }));

    const firstTrade = this.trades[0]?.ts;
    const lastTrade = this.trades.at(-1)?.ts;
    const firstPoint = this.points[0]?.ts;
    const lastPoint = this.points.at(-1)?.ts;
    this.timelineStart = movementTimes.length ? Math.min(...movementTimes) : firstTrade ?? firstPoint ?? Infinity;
    if (!Number.isFinite(this.timelineStart)) this.timelineStart = Date.now();

    this.tradeEnd = movementTimes.length ? Math.max(...movementTimes) : lastTrade ?? this.timelineStart;
    // An open replay continues to its separately checked current quote. It is
    // a market endpoint, never another execution or an invented final sale.
    const inventoryEnd = replayEndTimestamp(data);
    this.timelineEnd = this.currentQuote?.ts ?? (this.trades.length ? Math.max(this.tradeEnd, inventoryEnd) : lastPoint ?? this.tradeEnd);
    if (modern) this.timelineEnd = this.currentQuote?.ts ?? Math.max(this.tradeEnd, inventoryEnd);
    const lastMovement = data.inventory?.events?.at(-1);
    this.hasTail = Boolean(this.currentQuote) || this.timelineEnd > this.tradeEnd
      || Boolean(lastMovement && String(lastMovement.kind).startsWith('transfer_') && Date.parse(lastMovement.timestamp) >= this.tradeEnd);
    if (modern) this.hasTail = Boolean(this.currentQuote) || this.timelineEnd > this.tradeEnd;
    if (!this.trades.length && this.timelineEnd <= this.timelineStart) this.timelineEnd = this.timelineStart + MINUTE;

    const inventory = Array.isArray(data.inventory?.events) ? data.inventory.events : [];
    this.timing = createTradeReplayTiming(this.timelineStart, this.timelineEnd,
      [...this.trades.map(trade => trade.ts), ...inventory.map(event => Date.parse(event.timestamp))]);
    this.durationSeconds = this.timing.durationSeconds;
    this.currentEndPhase = this.timing.activePhase;
    this.eventPhase = this.progressAtTime(this.tradeEnd);
    this.eventProgresses = this.trades.map(trade => this.progressAtTime(trade.ts));

    // Same-time movements reveal as one canonical group; no artificial pauses
    // or delays are inserted between fills and transfers.
    const tradeIndices = new Map(this.trades.map((trade, index) => [trade.id, index]));
    this.inventoryEvents = inventory.map(event => ({ ...event,
      q: this.progressAtTime(Date.parse(event.timestamp)), tradeIndex: tradeIndices.get(event.tradeId) }));
    const movementById = new Map(this.inventoryEvents.map(event => [event.id, event]));
    this.accountingEvents = (data.replayAccounting?.events ?? []).map(event => {
      const movement = movementById.get(event.id);
      return { ...event, q: movement?.q ?? Infinity, tradeIndex: movement?.tradeIndex };
    });

    // A fixed presentation-time viewport keeps horizontal movement steady
    // across clips of different lengths, without changing execution prices.
    this.storyWindow = this.timing.storyWindow;
    this.markerRadius = MARKER_RADIUS;

    const story = this.plotPoints
      .filter((point) => point.ts <= this.timelineEnd && point.priceUsd > 0)
      .map((point) => ({
        ts: point.ts,
        kind: point.kind,
        tradeIndex: point.tradeIndex,
        q: point.kind === 'current' ? this.currentEndPhase
          : point.kind === 'fill' ? this.eventProgress(point.tradeIndex) : this.progressAtTime(point.ts),
        priceUsd: point.priceUsd,
        marketCapUsd: this.capMode && point.marketCapUsd > 0 ? point.marketCapUsd : point.priceUsd,
      }))
      .sort((a, b) => a.q - b.q);
    this.storyVertices = [];
    for (const vertex of story) {
      if (this.storyVertices.length && Math.abs(vertex.q - this.storyVertices.at(-1).q) < 1e-9) {
        this.storyVertices[this.storyVertices.length - 1] = vertex;
      } else {
        this.storyVertices.push(vertex);
      }
    }
    this.storyPriceTangents = monotoneTangents(this.storyVertices, 'priceUsd');
    this.storyCapTangents = monotoneTangents(this.storyVertices, 'marketCapUsd');

    const caps = this.plotPoints
      .filter((point) => point.ts <= this.timelineEnd && point.ts >= this.timelineStart - 2 * MINUTE)
      .map((point) => this.capMode ? point.marketCapUsd : point.priceUsd)
      .filter((cap) => Number.isFinite(cap) && cap > 0);
    const low = caps.length ? Math.min(...caps) : 0;
    const high = caps.length ? Math.max(...caps) : 1;
    this.yMin = 0;
    this.yMax = Math.max(high * 1.35, this.capMode ? 1 : 1e-12);
    this.buildCamera();
    this.buildAxisTicks();
    this.layoutMarkers();

    const [avatar, logo, brandIcon, brandWordmark] = await Promise.all([
      loadImage(normalizeImageUrl(data.kol.avatarUrl)),
      loadImage(normalizeImageUrl(data.token.logoUrl)),
      loadImage(new URL('./tradeReplayIcon.svg', import.meta.url).href),
      loadImage(new URL('./tradeReplayWordmark.svg', import.meta.url).href),
    ]);
    this.avatar = avatar;
    this.logo = logo;
    this.brandIcon = brandIcon;
    this.brandWordmark = brandWordmark;
    this.render(0);
  }

  getDuration() {
    return this.durationSeconds;
  }

  chartProgress(progress) {
    return Math.min(clamp(finite(progress), 0, 1), this.currentEndPhase);
  }

  viewportAt(progress) {
    const p = this.chartProgress(progress);
    const camera = this.cameraAt(p);
    const window = this.storyWindow;
    const startQ = p - window * PLAYHEAD_FRACTION;
    const time = this.timeAt(p);
    const startTime = this.timing.timeAtProgress(startQ);
    const endTime = this.timeAt(startQ + window);
    return { time, startTime, endTime, spanTime: endTime - startTime,
      startQ, endQ: startQ + window, yMin: camera.min, yMax: camera.max };
  }

  valueAtTime(time) {
    return this.valueAtStory(this.progressAtTime(time));
  }

  visibleLine(progress, viewport = this.viewportAt(progress)) {
    const p = this.chartProgress(progress);
    const camera = { min: viewport.yMin, max: viewport.yMax };
    const firstVisible = this.storyVertices.findIndex(point => point.q >= viewport.startQ);
    const points = this.storyVertices.slice(Math.max(0, firstVisible - 1)).filter(point => point.q <= p);
    const current = this.valueAtStory(p);
    if (current.marketCapUsd > 0 && (!points.length || points.at(-1).q !== p)) {
      points.push({ q: p, ts: this.timeAt(p), priceUsd: current.priceUsd, marketCapUsd: current.marketCapUsd });
    }
    return points.map(point => ({ ts: point.ts, q: point.q, cap: point.marketCapUsd,
      x: 42 + (point.q - viewport.startQ) / (viewport.endQ - viewport.startQ) * 772,
      y: this.yAtCap(point.marketCapUsd, camera) }));
  }

  markerPosition(index, progress) {
    const marker = this.markerPlacements[index];
    if (!marker || !Number.isFinite(marker.cap) || marker.cap <= 0) return null;
    const p = this.chartProgress(progress);
    const viewport = this.viewportAt(progress);
    const x = 42 + (marker.q - viewport.startQ) / (viewport.endQ - viewport.startQ) * 772;
    const camera = { min: viewport.yMin, max: viewport.yMax };
    const y = this.markerCenterY(marker.cap, camera);
    const anchorY = y;
    const elapsed = Math.max(0, (clamp(finite(progress), 0, 1) - marker.q) * this.durationSeconds);
    const entrance = smoothstep(elapsed / 0.19);
    return { index, ts: marker.ts, q: marker.q, x, y, anchorY, marketValue: marker.cap,
      executionValue: this.capMode ? this.trades[index].marketCapUsd : this.trades[index].priceUsd,
      visible: marker.q <= p + 1e-9 && x - this.markerRadius - 2 >= 42 && x + this.markerRadius + 2 <= 814,
      alpha: marker.q > p + 1e-9 ? 0 : 0.2 + 0.8 * entrance };
  }

  eventProgress(index) {
    return this.eventProgresses[index] ?? 0;
  }

  progressAtTime(ts) {
    return this.timing.progressAtTime(ts);
  }

  buildCamera() {
    // Fit the revealed portion of the scrolling viewport. An early position
    // still uses a zero baseline, but once its low prices leave the window,
    // the lower bound follows the visible range. This makes later, smaller
    // swings legible without changing any price or fill vertex. Both bounds
    // are precomputed so seeking and export produce identical frames.
    const samples = 1025;
    const step = 1 / (samples - 1);
    const riseRate = 1 - Math.exp(-this.durationSeconds * step / 0.105);
    const fallRate = 1 - Math.exp(-this.durationSeconds * step / 0.85);
    const floorRiseRate = 1 - Math.exp(-this.durationSeconds * step / 0.65);
    const floorFallRate = 1 - Math.exp(-this.durationSeconds * step / 0.14);
    const maxLogFall = 0.6 * this.durationSeconds * step;
    this.cameraValues = new Array(samples);
    let logCeiling = 0;
    let floor = 0;
    for (let i = 0; i < samples; i += 1) {
      const progress = i * step;
      const start = progress - this.storyWindow * PLAYHEAD_FRACTION;
      const startCap = this.valueAtStory(start).marketCapUsd;
      const currentCap = this.valueAtStory(progress).marketCapUsd;
      let low = Math.min(startCap, currentCap);
      let peak = Math.max(startCap, currentCap);
      for (const point of this.storyVertices) {
        if (point.q >= start && point.q <= progress) {
          low = Math.min(low, point.marketCapUsd);
          peak = Math.max(peak, point.marketCapUsd);
        }
      }
      const visibleSpan = Math.max(peak - low, peak * 0.15, this.capMode ? 1 : 1e-12);
      const firstPriceStillVisible = start <= (this.storyVertices[0]?.q ?? 0);
      const targetFloor = firstPriceStillVisible ? 0
        : Math.min(Math.max(0, low - visibleSpan * 0.3), peak * 0.65);
      const targetCeiling = Math.max(peak + (peak - targetFloor) * 0.35, this.capMode ? 1 : 1e-12);
      const logTarget = Math.log(targetCeiling);
      if (i === 0) {
        floor = targetFloor;
        logCeiling = logTarget;
      } else {
        floor += (targetFloor - floor) * (targetFloor > floor ? floorRiseRate : floorFallRate);
        // A newly revealed low must remain in frame even while the camera
        // eases downward; the target padding normally makes this inactive.
        floor = Math.max(0, Math.min(floor, low - visibleSpan * 0.08));
        if (logTarget >= logCeiling) {
          logCeiling += (logTarget - logCeiling) * riseRate;
        } else {
          logCeiling += Math.max(-maxLogFall, (logTarget - logCeiling) * fallRate);
        }
      }
      const safetyCeiling = floor + (peak - floor) * 1.12;
      logCeiling = Math.max(logCeiling, Math.log(Math.max(safetyCeiling, this.capMode ? 1 : 1e-12)));
      this.cameraValues[i] = { min: floor, max: Math.exp(logCeiling) };
    }
  }

  cameraAt(progress) {
    if (!this.cameraValues.length) return { min: this.yMin, max: this.yMax };
    const index = this.chartProgress(progress) * (this.cameraValues.length - 1);
    const before = Math.floor(index);
    const after = Math.min(before + 1, this.cameraValues.length - 1);
    const fraction = index - before;
    const a = this.cameraValues[before];
    const b = this.cameraValues[after];
    return {
      min: a.min + (b.min - a.min) * fraction,
      max: a.max + (b.max - a.max) * fraction,
    };
  }

  yAtCap(cap, camera = { min: this.yMin, max: this.yMax }) {
    const top = 272;
    const bottom = 651;
    const low = typeof camera === 'number' ? 0 : camera.min;
    const high = typeof camera === 'number' ? camera : camera.max;
    return bottom - (Math.max(0, finite(cap)) - low) / Math.max(1e-12, high - low) * (bottom - top);
  }

  markerCenterY(cap, cameraRange) {
    return this.yAtCap(cap, cameraRange);
  }

  buildAxisTicks() {
    const span = Math.max(MINUTE, this.timelineEnd - this.timelineStart);
    // Fixed clock ticks use the same linear scale as prices and executions.
    const majorStep = axisStep(span);
    const step = AXIS_STEPS[Math.max(0, AXIS_STEPS.indexOf(majorStep) - 1)];
    const prehistory = this.currentEndPhase > 0
      ? (this.timelineEnd - this.timelineStart) * (this.storyWindow + 0.1) / this.currentEndPhase : 0;
    const first = Math.floor((this.timelineStart - prehistory) / step) * step;
    const minStoryGap = 180 / (814 - 42) * this.storyWindow;
    const candidates = [];
    const labels = new Set();
    for (let ts = first; ts <= this.timelineEnd && candidates.length < 1000; ts += step) {
      const q = this.progressAtTime(ts);
      if (q < -this.storyWindow - 0.1) continue;
      const label = axisLabel(ts, span);
      if (labels.has(label)) continue;
      candidates.push({ q, ts, label });
      labels.add(label);
    }
    const endingQ = this.hasTail ? this.currentEndPhase
      : this.trades.length && this.timelineEnd === this.tradeEnd ? this.eventPhase : 1;
    const endingLabel = axisLabel(this.timelineEnd, span);
    if (!labels.has(endingLabel)) {
      candidates.push({ q: endingQ, ts: this.timelineEnd, label: endingLabel });
    }
    // Select from the closing timestamp backwards. This keeps the late view
    // populated even when a just-offscreen older tick would block its neighbor.
    this.axisTicks = [];
    let nextQ = Infinity;
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const tick = candidates[i];
      if (nextQ - tick.q < minStoryGap) continue;
      this.axisTicks.push(tick);
      nextQ = tick.q;
    }
    this.axisTicks.reverse();
  }

  layoutMarkers() {
    this.markerPlacements = this.trades.map((trade, index) => ({ index,
      q: this.eventProgress(index), ts: trade.ts, cap: this.capMode ? trade.marketCapUsd : trade.priceUsd }));
    this.amountClusters = createTradeReplayAmountSchedule(this.trades.map((trade, index) => ({
      index, side: trade.side, atSeconds: this.eventProgress(index) * this.durationSeconds,
      amountUsd: this.markerPlacements[index].cap > 0 ? trade.amountUsd : null,
    })), this.durationSeconds);
  }

  timeAt(progress) {
    return this.timing.timeAtProgress(this.chartProgress(progress));
  }

  priceAt(ts, currentEventIndex = Infinity) {
    const points = this.plotPoints.filter((point) => point.kind !== 'fill' || point.tradeIndex <= currentEventIndex);
    if (!points.length) return finite(this.data?.token?.priceUsd);
    if (ts < points[0].ts) return points[0].priceUsd;
    if (ts >= points.at(-1).ts) return points.at(-1).priceUsd;
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].ts <= ts) lo = mid + 1;
      else hi = mid;
    }
    const prior = points[lo - 1];
    const next = points[lo];
    if (!next || prior.ts === ts) return prior.priceUsd;
    const fraction = (ts - prior.ts) / (next.ts - prior.ts);
    return prior.priceUsd + (next.priceUsd - prior.priceUsd) * fraction;
  }

  valueAtStory(progress) {
    const points = this.storyVertices;
    if (!points.length) {
      return { priceUsd: 0, marketCapUsd: 0 };
    }
    if (progress <= points[0].q) return points[0];
    if (progress >= points.at(-1).q) return points.at(-1);
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].q <= progress) lo = mid + 1;
      else hi = mid;
    }
    const a = points[lo - 1];
    const b = points[lo];
    const span = b.q - a.q;
    const fraction = (progress - a.q) / span;
    return {
      priceUsd: hermite(a.priceUsd, b.priceUsd, this.storyPriceTangents[lo - 1], this.storyPriceTangents[lo], fraction, span),
      marketCapUsd: hermite(a.marketCapUsd, b.marketCapUsd, this.storyCapTangents[lo - 1], this.storyCapTangents[lo], fraction, span),
    };
  }

  snapshot(progress) {
    if (!this.data) return {
      time: null, invested: 0, proceeds: 0, holdings: 0, pnl: 0, roi: 0, realizedPnl: null, realizedRoi: null,
      remainingCostBasis: null, unrealizedPnl: null, totalPnl: null, totalRoi: null,
      avgEntryCap: 0, currentCap: 0, currentPrice: 0, currentEventIndex: -1, status: 'Waiting', recordedStatus: 'Waiting',
    };
    const p = clamp(finite(progress), 0, 1);
    const ts = this.timeAt(p);
    let invested = 0;
    let proceeds = 0;
    let boughtTokens = 0;
    let soldTokens = 0;
    let partialHistory = this.data.source?.tradesComplete === false;
    let investedKnown = !partialHistory, proceedsKnown = !partialHistory, quantitiesKnown = !partialHistory;
    let realizedPnl = !partialHistory && this.data.realizedAccounting?.available === true ? 0 : null;
    let currentEventIndex = -1;
    for (let i = 0; i < this.trades.length; i += 1) {
      const trade = this.trades[i];
      if (this.eventProgress(i) > p + 1e-9) break;
      currentEventIndex = i;
      if (trade.side === 'buy') {
        if (trade.amountUsd === null) investedKnown = false; else invested += trade.amountUsd;
        if (trade.tokenAmount === null) quantitiesKnown = false; else boughtTokens += trade.tokenAmount;
      } else {
        if (trade.amountUsd === null) proceedsKnown = false; else proceeds += trade.amountUsd;
        if (trade.tokenAmount === null) quantitiesKnown = false; else soldTokens += trade.tokenAmount;
        if (realizedPnl !== null) realizedPnl = trade.cumulativeRealizedProfitUsd;
      }
      if (!this.data.inventory && soldTokens > boughtTokens + Math.max(Number.MIN_VALUE, boughtTokens * 1e-10)) partialHistory = true;
    }
    let holdings = Math.abs(boughtTokens - soldTokens) <= Math.max(Number.MIN_VALUE, boughtTokens * 1e-10) ? 0 : boughtTokens - soldTokens;
    const inventory = this.data.inventory;
    const inventoryReady = inventory?.coverage?.complete === true && inventory.coverage.reconciled === true;
    let inventoryState = null;
    if (inventory) {
      for (const event of this.inventoryEvents) {
        if (event.q > p + 1e-9 || event.tradeIndex !== undefined && event.tradeIndex > currentEventIndex) break;
        inventoryState = event;
      }
      if (inventoryReady && inventoryState) {
        invested = inventoryState.investedUsd;
        proceeds = inventoryState.soldUsd;
        holdings = inventoryState.remainingTokenAmount;
        realizedPnl = inventoryState.cumulativeRealizedProfitUsd;
        investedKnown = invested !== null; proceedsKnown = proceeds !== null;
        quantitiesKnown = holdings !== null;
      } else {
        quantitiesKnown = false;
        realizedPnl = null;
      }
    }
    const quote = this.valueAtStory(p);
    const currentPrice = quote.priceUsd;
    const currentCap = quote.marketCapUsd;
    const position = this.data.position;
    const pricedFills = this.trades.every((trade) => trade.amountUsd !== null && trade.tokenAmount !== null && Number.isFinite(trade.amountUsd) && trade.amountUsd > 0);
    const ending = currentEventIndex === this.trades.length - 1 && p + 1e-9 >= (this.hasTail ? this.currentEndPhase : this.eventPhase);
    const balanceMismatch = ending && position?.tokenBalance !== null && position?.tokenBalance !== undefined
      && quantitiesKnown && Math.abs(holdings - position.tokenBalance) > Math.max(Number.MIN_VALUE, Math.max(boughtTokens, soldTokens, holdings, position.tokenBalance) * 1e-10);
    const accountingReady = !balanceMismatch && (!inventory || inventoryReady) && Boolean(position) && (
      (inventory ? inventoryReady : position.tradeFlowMatched === true)
      && position.tradesComplete === true
      && (position.status === 'open' || position.status === 'closed')
      && pricedFills
    );
    const marketQuoteAvailable = !this.fillOnly || holdings === 0;
    const realizedRoi = realizedPnl !== null && investedKnown && invested > 0 ? realizedPnl / invested : null;
    // Verified inventory carries the remaining FIFO basis after each movement.
    // Legacy swap-only estimates must also agree with a checked ending balance.
    const recordedAccountingReady = !balanceMismatch && (!inventory || inventoryReady) && currentEventIndex >= 0 && !partialHistory
      && this.data.source?.tradesComplete === true && position?.tradesComplete === true
      && pricedFills && investedKnown && proceedsKnown && quantitiesKnown && realizedPnl !== null;
    const inventoryAccountingReady = inventoryReady && inventoryState && !partialHistory && !balanceMismatch
      && investedKnown && proceedsKnown && quantitiesKnown && realizedPnl !== null;
    const rawBasis = inventory ? inventoryAccountingReady && inventoryState.remainingCostBasisUsd !== null
      ? inventoryState.remainingCostBasisUsd : NaN : recordedAccountingReady ? invested - proceeds + realizedPnl : NaN;
    const basisTolerance = Math.max(Number.MIN_VALUE, Math.max(invested, proceeds, Math.abs(realizedPnl ?? 0)) * 1e-10);
    const validBasis = Number.isFinite(rawBasis) && rawBasis >= -basisTolerance
      && (holdings !== 0 || Math.abs(rawBasis) <= basisTolerance);
    const remainingCostBasis = validBasis ? Math.abs(rawBasis) <= basisTolerance ? 0 : rawBasis : null;
    const markedValue = holdings === 0 ? 0 : holdings * currentPrice;
    // Recorded-price fallback is an estimate along the disclosed execution
    // curve, not a verified market quote or current wallet valuation. Keep the
    // independently checked gross fields above on their stricter market gate.
    const estimatedQuoteAvailable = marketQuoteAvailable || this.fillOnly && this.storyVertices.length > 0;
    const unrealizedPnl = remainingCostBasis !== null && estimatedQuoteAvailable
      && (holdings === 0 || Number.isFinite(currentPrice) && currentPrice > 0) && Number.isFinite(markedValue)
      ? markedValue - remainingCostBasis : null;
    const combinedPnl = unrealizedPnl !== null && realizedPnl !== null ? realizedPnl + unrealizedPnl : NaN;
    const totalPnl = Number.isFinite(combinedPnl) ? combinedPnl : null;
    const totalRoi = totalPnl === null ? null : invested > 0 ? totalPnl / invested : 0;
    const pnl = inventory ? accountingReady && marketQuoteAvailable ? totalPnl : null
      : partialHistory || !accountingReady || !marketQuoteAvailable || !investedKnown || !proceedsKnown || !quantitiesKnown ? null : proceeds + holdings * currentPrice - invested;
    const roi = pnl === null ? null : invested > 0 ? pnl / invested : 0;
    const avgEntryCap = investedKnown && quantitiesKnown && boughtTokens > 0 && this.supply ? invested / boughtTokens * this.supply : null;
    let status = partialHistory || !quantitiesKnown ? 'Partial history'
      : currentEventIndex < 0 ? 'Waiting'
      : holdings > Math.max(Number.MIN_VALUE, boughtTokens * 1e-10) ? 'Open' : 'Closed';
    const recordedStatus = currentEventIndex < 0 ? 'Waiting'
      : partialHistory || !quantitiesKnown || this.data.source?.tradesComplete !== true || position?.tradesComplete !== true ? 'Unknown'
      : status;
    // The replay animates observed swaps, but its ending label reflects the
    // wallet balance checked at generation time. Transfers can make those two
    // views differ, so an unavailable balance is never called closed.
    if (position && ending) {
      status = position.status === 'open' ? 'Open'
        : position.status === 'closed' ? 'Closed' : 'Unknown';
    }
    const state = {
      time: new Date(ts).toISOString(), invested: investedKnown ? invested : null, proceeds: proceedsKnown ? proceeds : null, holdings: quantitiesKnown ? holdings : null, pnl, roi,
      avgEntryCap, currentCap, currentPrice, currentEventIndex, status, recordedStatus, realizedPnl, realizedRoi,
      remainingCostBasis, unrealizedPnl, totalPnl, totalRoi,
    };
    return this.data.replayAccounting ? this.ledgerSnapshot(p, state, ending, boughtTokens) : state;
  }

  ledgerSnapshot(progress, state, ending, boughtTokens) {
    const accounting = this.data.replayAccounting;
    const valid = ['ready', 'estimated'].includes(accounting.status)
      && accounting.coverage.transactionsComplete && accounting.coverage.balanceMatched
      && this.accountingEvents.length > 0 && this.accountingEvents.length === this.inventoryEvents.length
      && this.accountingEvents.every(event => Number.isFinite(event.q));
    // A requested GMGN result never silently falls back to the indexed ledger.
    const unavailable = { ...state, pnl: null, roi: null, realizedPnl: null, realizedRoi: null,
      remainingCostBasis: null, unrealizedPnl: null, totalPnl: null, totalRoi: null };
    if (!valid) return unavailable;
    let prefix = null;
    for (const event of this.accountingEvents) {
      if (event.q > progress + 1e-9 || event.tradeIndex !== undefined && event.tradeIndex > state.currentEventIndex) break;
      prefix = event;
    }
    const completePrefix = prefix?.id === this.accountingEvents.at(-1)?.id;
    const final = ending && completePrefix && (accounting.coverage.exactFinal || accounting.coverage.journalFinal) ? accounting.final : null;
    const snapshot = final ?? prefix;
    if (!snapshot) return unavailable;
    const invested = finite(snapshot.investedUsd, null), proceeds = finite(snapshot.soldUsd, null);
    const holdings = finite(snapshot.remainingTokenAmount, null);
    const basis = finite(snapshot.remainingCostBasisUsd, null);
    const realized = finite(snapshot.cumulativeRealizedProfitUsd, null);
    const cost = finite(snapshot.feeInclusiveCostUsd, null);
    const fees = finite(snapshot.feesUsd, null);
    const value = holdings === 0 ? 0 : holdings !== null && state.currentPrice > 0 ? holdings * state.currentPrice : null;
    const unrealized = value !== null && basis !== null ? value - basis : null;
    let total = replayAccountingTotal(snapshot, state.currentPrice, accounting.version === 2);
    let roi = total !== null && cost > 0 ? total / cost : null;
    // Exact provider totals belong only to the ending. A different selected
    // price reprices the remaining quantity, without changing disposal gains.
    const reported = finite(final?.reportedProfitUsd, null), referencePrice = positive(final?.priceUsd);
    if (reported !== null && holdings !== null && (holdings === 0 || referencePrice !== null && value !== null)) {
      const delta = holdings === 0 ? 0 : holdings * (state.currentPrice - referencePrice);
      total = reported + delta;
      const sameQuote = holdings === 0 || Math.abs(state.currentPrice - referencePrice) <= referencePrice * 1e-10;
      roi = sameQuote ? finite(final.reportedRoi, cost > 0 ? total / cost : null) : cost > 0 ? total / cost : null;
    }
    return { ...state, invested, proceeds, holdings, remainingCostBasis: basis, accountingFinal: final !== null,
      realizedPnl: realized, realizedRoi: realized !== null && cost > 0 ? realized / cost : null,
      unrealizedPnl: unrealized, pnl: total, roi, totalPnl: total, totalRoi: roi,
      avgEntryCap: invested !== null && boughtTokens > 0 && this.supply ? invested / boughtTokens * this.supply : null };
  }

  render(progress) {
    const ctx = this.ctx;
    const p = clamp(finite(progress), 0, 1);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = COLOR.frame;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    fillRound(ctx, 12, 13, 1056, 1154, 60, COLOR.dark);

    if (this.data) {
      const state = this.snapshot(p);
      this.drawHeader(ctx, state);
      this.drawChart(ctx, p, state);
      this.drawResult(ctx, state);
    } else {
      text(ctx, 'TRADE RECAP', 540, 560, `700 46px ${FONT}`, COLOR.white, 'center');
      text(ctx, 'Choose a KOL and token to begin', 540, 620, `400 30px ${FONT}`, COLOR.muted, 'center');
    }
    this.drawFooter(ctx);
  }

  drawHeader(ctx, state) {
    const kolName = shortName(this.data.kol.name || this.data.kol.address || 'Trader', 26);
    const left = 215;
    const right = 1018;
    const titleRow = 82;
    const detailRow = 147;
    const detailHeight = 44;
    const dateFont = `500 32px ${FONT}`;
    const date = dateLabel(new Date(this.timelineEnd));
    ctx.font = dateFont;
    const nameWidth = Math.min(520, right - ctx.measureText(date).width - left - 36);
    const nameFont = fitFont(ctx, kolName, nameWidth, 55, 34, 650);
    let shownName = kolName;
    if (ctx.measureText(shownName).width > nameWidth) {
      let stem = kolName.replace(/…$/, '');
      while (stem.length && ctx.measureText(`${stem}…`).width > nameWidth) stem = stem.slice(0, -1);
      shownName = `${stem}…`;
    }
    // Align visible letter shapes, independent of the different font sizes.
    const rowText = (value, x, row, font, color, align = 'left') => {
      ctx.font = font;
      ctx.textAlign = align;
      ctx.textBaseline = 'alphabetic';
      const metrics = ctx.measureText(value);
      const baseline = row + (finite(metrics.actualBoundingBoxAscent) - finite(metrics.actualBoundingBoxDescent)) / 2;
      const anchoredX = align === 'left' ? x + finite(metrics.actualBoundingBoxLeft)
        : align === 'right' ? x - finite(metrics.actualBoundingBoxRight)
        : x + (finite(metrics.actualBoundingBoxLeft) - finite(metrics.actualBoundingBoxRight)) / 2;
      text(ctx, value, anchoredX, baseline, font, color, align);
    };
    imageCircle(ctx, this.avatar, 114, (titleRow + detailRow) / 2, 67, initials(kolName), '#a97f0e');
    rowText(shownName, left, titleRow, nameFont, COLOR.white);
    rowText(date, right, titleRow, dateFont, '#8b877d', 'right');

    const ending = state.currentEventIndex === this.trades.length - 1;
    // Prefer a checked ending balance, then the complete recorded position.
    // Withhold the badge when neither can establish an open or closed position.
    const status = ending && (state.status === 'Open' || state.status === 'Closed')
      ? state.status : state.recordedStatus;
    if (status === 'Open' || status === 'Closed') {
      const isOpen = status === 'Open';
      const statusFill = isOpen ? '#3b3214' : '#272721';
      const statusText = isOpen ? COLOR.goldBright : '#c4bda7';
      const statusFont = `750 25px ${FONT}`;
      ctx.font = statusFont;
      const pillWidth = ctx.measureText(status).width + 36;
      fillRound(ctx, left, detailRow - detailHeight / 2, pillWidth, detailHeight, 11, statusFill);
      rowText(status, left + pillWidth / 2, detailRow, statusFont, statusText, 'center');
    }
    if (this.brandIcon?.naturalWidth > 0) {
      try {
        // Use the complete native icon viewBox, matching the app's brand mark.
        ctx.drawImage(this.brandIcon,
          right - detailHeight, detailRow - detailHeight / 2, detailHeight, detailHeight);
      } catch {
        drawBrandMark(ctx, BRAND_ICON_PATHS, right - detailHeight, detailRow - detailHeight / 2, detailHeight, detailHeight, '#F9C932');
      }
    } else {
      drawBrandMark(ctx, BRAND_ICON_PATHS, right - detailHeight, detailRow - detailHeight / 2, detailHeight, detailHeight, '#F9C932');
    }
  }

  drawChart(ctx, progress, state) {
    const { pnl } = displayedProfit(state);
    // A verified ending does not establish profit in an earlier unknown-cost
    // frame. Keep those observations neutral until the displayed P&L is known.
    const chartColor = pnl === null ? COLOR.muted : pnl >= 0 ? COLOR.green : COLOR.red;
    const chartRgb = pnl === null ? '169,166,154' : pnl >= 0 ? '22,199,132' : '246,70,93';
    const chartProgress = this.chartProgress(progress);
    const viewport = this.viewportAt(progress);
    const cameraRange = { min: viewport.yMin, max: viewport.yMax };
    const left = 42;
    const right = 814;
    const top = 272;
    const bottom = 651;
    const windowStart = viewport.startQ;
    const windowEnd = viewport.endQ;
    const xAtProgress = (storyProgress) => left + (storyProgress - windowStart) / (windowEnd - windowStart) * (right - left);
    const activeX = xAtProgress(chartProgress);
    const hasQuote = Number.isFinite(state.currentCap) && state.currentCap > 0 && this.storyVertices.length > 0;
    const currentY = hasQuote ? clamp(this.yAtCap(state.currentCap, cameraRange), top + 6, bottom - 6) : (top + bottom) / 2;

    const pathPoints = this.storyVertices.map((point) => ({
      x: xAtProgress(point.q),
      // Keep offscreen future vertices at their true transformed height.
      // Clamping them changes the spline before they are revealed and makes
      // its visible tip disagree with the live price guide during pumps.
      y: this.yAtCap(point.marketCapUsd, cameraRange),
    }));

    ctx.save();
    roundedRect(ctx, 27, 235, 1018, 475, 20);
    ctx.clip();
    ctx.strokeStyle = 'rgba(196,174,94,0.08)';
    ctx.lineWidth = 1;
    for (const fraction of [0.25, 0.75]) {
      const y = top + (bottom - top) * fraction;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }

    if (pathPoints.length) {
      // The complete spline is fixed. Revealing it with a moving clip keeps
      // previous segments from reshaping when a new fill comes into view.
      ctx.save();
      ctx.beginPath();
      ctx.rect(27, top - 12, Math.max(0, activeX - 27), bottom - top + 24);
      ctx.clip();
      {
        const area = ctx.createLinearGradient(0, top, 0, bottom);
        area.addColorStop(0, `rgba(${chartRgb},0.18)`);
        area.addColorStop(0.68, `rgba(${chartRgb},0.055)`);
        area.addColorStop(1, `rgba(${chartRgb},0)`);
        this.traceLine(ctx, pathPoints);
        ctx.lineTo(pathPoints.at(-1).x, bottom + 10);
        ctx.lineTo(pathPoints[0].x, bottom + 10);
        ctx.closePath();
        ctx.fillStyle = area;
        ctx.fill();
      }
      ctx.save();
      ctx.shadowColor = `rgba(${chartRgb},0.38)`;
      ctx.shadowBlur = 13;
      this.traceLine(ctx, pathPoints);
      ctx.strokeStyle = chartColor;
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
      if (this.fillOnly) {
        for (const point of pathPoints) {
          if (point.x > xAtProgress(chartProgress) + 1) continue;
          ctx.beginPath();
          ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = chartColor;
          ctx.fill();
        }
      }
      ctx.restore();
    }

    if (hasQuote) {
    ctx.setLineDash([12, 13]);
    ctx.beginPath();
    ctx.moveTo(37, currentY);
    ctx.lineTo(828, currentY);
    ctx.strokeStyle = `rgba(${chartRgb},0.42)`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    // The clipped spline ends at the same quote as the dashed guide. A small
    // round cap covers the clip edge without revealing any future price.
    if (pathPoints.length) {
      ctx.beginPath();
      ctx.arc(activeX, currentY, this.fillOnly ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = chartColor;
      ctx.fill();
    }

    } else {
      text(ctx, 'Execution prices unavailable', 428, 470, `550 28px ${FONT}`, COLOR.muted, 'center');
    }
    const visibleMarkers = this.drawTradeMarkers(ctx, progress, windowStart, windowEnd, xAtProgress, state, cameraRange);
    ctx.restore();
    this.drawTradeAmounts(ctx, progress, visibleMarkers);

    const capText = hasQuote ? this.capMode ? money(state.currentCap, 0, true) : this.priceText(state.currentCap) : '—';
    fillRound(ctx, 844, currentY - 29, 188, 58, 14, COLOR.gold, 'rgba(255,221,97,0.65)', 2);
    text(ctx, capText, 938, currentY + 1, fitFont(ctx, capText, 170, 33, 25, 750), '#18150b', 'center', 'middle');
    text(ctx, this.capMode ? 'MCAP' : 'USD PRICE', 939, currentY + 62, `550 21px ${FONT}`, COLOR.dim, 'center');

    for (const tick of this.axisTicks) {
      const x = xAtProgress(tick.q);
      if (x < 68 || x > 788) continue;
      text(ctx, tick.label, x, 698, `500 26px ${FONT}`, '#8c8676', 'center');
    }

  }

  traceLine(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) {
      ctx.lineTo(points[0].x + 1, points[0].y);
      return;
    }
    // Monotone cubic tangents give a smooth curve through every exact fill
    // without the loops and extra peaks of an unrestricted Catmull-Rom spline.
    const slope = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const dx = points[i + 1].x - points[i].x;
      slope.push(dx > 0.001 ? (points[i + 1].y - points[i].y) / dx : 0);
    }
    const tangent = points.map((_, i) => {
      if (i === 0) return slope[0];
      if (i === points.length - 1) return slope.at(-1);
      const before = slope[i - 1];
      const after = slope[i];
      if (before * after <= 0) return 0;
      return 2 / (1 / before + 1 / after);
    });
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      if (dx <= 0.001) {
        ctx.lineTo(b.x, b.y);
      } else {
        ctx.bezierCurveTo(
          a.x + dx / 3, a.y + tangent[i] * dx / 3,
          b.x - dx / 3, b.y - tangent[i + 1] * dx / 3,
          b.x, b.y,
        );
      }
    }
  }

  drawTradeMarkers(ctx, progress, windowStart, windowEnd, xAtProgress, state, cameraRange) {
    const markers = [];
    for (const marker of this.markerPlacements) {
      if (marker.index > state.currentEventIndex) continue;
      const q = marker.q;
      if (!Number.isFinite(marker.cap) || marker.cap <= 0) continue;
      if (q < windowStart || q > windowEnd) continue;
      const trade = this.trades[marker.index];
      const x = xAtProgress(q);
      const y = this.markerCenterY(marker.cap, cameraRange);
      const entrance = smoothstep((progress - q) * this.durationSeconds / 0.19);
      const alpha = 0.2 + 0.8 * entrance;
      const scale = 0.82 + 0.18 * entrance;
      // The circle is centered on its genuine execution point, without stems.
      if (x - this.markerRadius - 2 < 42 || x + this.markerRadius + 2 > 814) continue;
      markers.push({
        index: marker.index, x, y,
        color: trade.side === 'buy' ? COLOR.green : COLOR.red,
        letter: trade.side === 'buy' ? 'B' : 'S',
        alpha, scale,
      });
    }
    for (const marker of markers) {
      ctx.save();
      ctx.globalAlpha = marker.alpha;
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, this.markerRadius * marker.scale, 0, Math.PI * 2);
      ctx.fillStyle = marker.color;
      ctx.fill();
      ctx.strokeStyle = COLOR.dark;
      ctx.lineWidth = 3;
      ctx.stroke();
      // Paint each letter with its circle so a later overlapping execution
      // covers the older label instead of stacking several B/S characters.
      text(ctx, marker.letter, marker.x, marker.y + 1,
        `800 ${Math.max(12, Math.round(this.markerRadius * marker.scale))}px ${FONT}`,
        '#ffffff', 'center', 'middle');
      ctx.restore();
    }
    if (this.data.replayAccounting?.version === 2) for (const event of this.inventoryEvents) {
      if (!String(event.kind).startsWith('transfer_') || event.q > progress + 1e-9 || event.q < windowStart || event.q > windowEnd) continue;
      const value = this.valueAtStory(event.q), cap = this.capMode ? value.marketCapUsd : value.priceUsd;
      if (!(cap > 0)) continue;
      const x = xAtProgress(event.q), y = this.markerCenterY(cap, cameraRange), incoming = event.kind === 'transfer_in';
      if (x - this.markerRadius < 42 || x + this.markerRadius > 814) continue;
      ctx.beginPath(); ctx.arc(x, y, this.markerRadius, 0, Math.PI * 2); ctx.fillStyle = incoming ? COLOR.green : COLOR.red; ctx.fill();
      ctx.strokeStyle = COLOR.dark; ctx.lineWidth = 3; ctx.stroke();
      text(ctx, incoming ? 'IN' : 'OUT', x, y + 1, `750 ${Math.max(10, this.markerRadius * .68)}px ${FONT}`, '#fff', 'center', 'middle');
    }
    return markers;
  }

  drawTradeAmounts(ctx, progress, markers) {
    const labels = [];
    // The amount queue is presentation only; circles and financial state still
    // reveal at the genuine execution timestamp, including simultaneous fills.
    for (const cluster of [...this.amountClusters].reverse()) {
      if (cluster.entries.length > 1) {
        this.drawBuyAmountStack(ctx, progress, markers, cluster, labels);
        continue;
      }
      const entry = cluster.entries[0];
      const marker = markers.find(marker => marker.index === entry.index);
      if (!marker) continue;
      const trade = this.trades[marker.index];
      const elapsed = progress * this.durationSeconds - entry.startSeconds;
      if (!(trade.amountUsd > 0) || elapsed < 0 || elapsed >= 1.35) continue;
      const opacity = smoothstep(elapsed / 0.19) * (1 - smoothstep((elapsed - 0.9) / 0.45));
      if (opacity < 0.01) continue;
      const amount = money(trade.amountUsd, 2, trade.amountUsd >= 1000);
      const font = fitFont(ctx, amount, 160, 28, 22, 750);
      const width = this.measure(ctx, amount, font);
      const x = clamp(marker.x, 48 + width / 2, 808 - width / 2);
      const preferred = trade.side === 'buy' ? -1 : 1;
      let best = null, bestScore = Infinity;
      for (const distance of [44, 80, 116, 152, 188]) for (const direction of [preferred, -preferred]) {
        const y = marker.y + direction * distance;
        if (y < 294 || y > 629) continue;
        const rect = { x: x - width / 2 - 3, y: y - 17, width: width + 6, height: 34 };
        const circlePenalty = markers.reduce((score, circle) => {
          const dx = Math.max(rect.x - circle.x, 0, circle.x - rect.x - rect.width);
          const dy = Math.max(rect.y - circle.y, 0, circle.y - rect.y - rect.height);
          return score + Math.max(0, this.markerRadius + 6 - Math.hypot(dx, dy)) * 1000;
        }, 0);
        const labelPenalty = labels.reduce((score, label) => {
          const overlapX = Math.min(rect.x + rect.width + 4, label.x + label.width) - Math.max(rect.x - 4, label.x);
          const overlapY = Math.min(rect.y + rect.height + 4, label.y + label.height) - Math.max(rect.y - 4, label.y);
          return score + (overlapX > 0 && overlapY > 0 ? overlapX * overlapY * 100 : 0);
        }, 0);
        const score = circlePenalty + labelPenalty + (distance - 44) + (direction === preferred ? 0 : 8);
        if (score < bestScore) { best = { ...rect, centerY: y }; bestScore = score; }
      }
      if (!best) continue;
      labels.push(best);
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 6;
      text(ctx, amount, x, best.centerY, font, marker.color, 'center', 'middle');
      ctx.restore();
    }
  }

  drawBuyAmountStack(ctx, progress, markers, cluster, labels) {
    const seconds = progress * this.durationSeconds;
    const lifetime = cluster.lifetimeSeconds;
    const fadeIn = Math.min(0.19, lifetime * 0.24), fadeOut = lifetime * 0.25;
    const entries = cluster.entries.map((entry, row) => {
      const age = seconds - entry.startSeconds;
      const alpha = smoothstep(age / fadeIn) * (1 - smoothstep((age - lifetime + fadeOut) / fadeOut));
      const amount = money(this.trades[entry.index].amountUsd, 2, this.trades[entry.index].amountUsd >= 1000);
      const font = fitFont(ctx, amount, 160, 28, 22, 750);
      return { ...entry, row, age, alpha, amount, font, width: this.measure(ctx, amount, font) };
    });
    const active = entries.filter(entry => entry.age >= 0 && entry.age < lifetime && entry.alpha >= 0.01);
    if (!active.length) return;
    const indices = new Set(cluster.entries.map(entry => entry.index));
    const circles = markers.filter(marker => indices.has(marker.index));
    if (!circles.length) return;
    const first = this.markerPosition(cluster.entries[0].index, progress);
    const anchor = first?.visible ? first
      : circles.find(circle => active.some(entry => entry.index === circle.index)) ?? circles.at(-1);
    const rowGap = 36, height = (Math.min(4, cluster.entries.length) - 1) * rowGap;
    const width = Math.max(...entries.map(entry => entry.width));
    const anchorX = clamp(anchor.x, 48 + width / 2, 808 - width / 2);
    const above = Math.min(...circles.map(marker => marker.y)) - 44 - height;
    const below = Math.max(...circles.map(marker => marker.y)) + 44;
    const preferred = above >= 294 ? above : below;
    let best = null, bestScore = Infinity;
    // Place the complete column together, so rows cannot scatter above/below
    // individual fills. Move it sideways when the chart leaves no vertical room.
    for (const rawX of [anchorX, anchorX - width - 32, anchorX + width + 32]) {
      const x = clamp(rawX, 48 + width / 2, 808 - width / 2);
      for (const rawY of [preferred, above, below, 294, 629 - height]) {
        const y = clamp(rawY, 294, 629 - height);
        const rect = { x: x - width / 2 - 3, y: y - 17, width: width + 6, height: height + 34 };
        const circlePenalty = markers.reduce((score, circle) => {
          const dx = Math.max(rect.x - circle.x, 0, circle.x - rect.x - rect.width);
          const dy = Math.max(rect.y - circle.y, 0, circle.y - rect.y - rect.height);
          return score + Math.max(0, this.markerRadius + 6 - Math.hypot(dx, dy)) * 1000;
        }, 0);
        const labelPenalty = labels.reduce((score, label) => {
          const overlapX = Math.min(rect.x + rect.width + 4, label.x + label.width) - Math.max(rect.x - 4, label.x);
          const overlapY = Math.min(rect.y + rect.height + 4, label.y + label.height) - Math.max(rect.y - 4, label.y);
          return score + (overlapX > 0 && overlapY > 0 ? overlapX * overlapY * 100 : 0);
        }, 0);
        const score = circlePenalty + labelPenalty + Math.abs(x - anchorX) * 2 + Math.abs(y - preferred);
        if (score < bestScore) { best = { ...rect, centerX: x, top: y }; bestScore = score; }
      }
    }
    if (!best) return;
    labels.push(best);
    // Fading rows slide out above the column; new rows always enter underneath.
    const scroll = cluster.entries.reduce((rows, entry) => rows
      + smoothstep((seconds - entry.startSeconds - lifetime + fadeOut) / fadeOut), 0);
    ctx.save();
    ctx.beginPath(); ctx.rect(best.x, best.y, best.width, best.height); ctx.clip();
    for (const entry of active) {
      ctx.globalAlpha = entry.alpha;
      ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 6;
      text(ctx, entry.amount, best.centerX, best.top + (entry.row - scroll) * rowGap,
        entry.font, COLOR.green, 'center', 'middle');
    }
    ctx.restore();
  }

  drawResult(ctx, state) {
    const x = 28;
    const y = 729;
    const width = 1024;
    const height = 422;
    // The main card ends at y=1167 with a 60px corner. A 16px inset gives
    // this panel a 44px radius and the same bottom-corner center on both paths.
    fillRound(ctx, x, y, width, height, 44, COLOR.panel, COLOR.panelEdge, 2);

    const tokenText = shortName(this.data.token.symbol || this.data.token.name || 'TOKEN', 24);
    const tokenFont = fitFont(ctx, tokenText, 760, 44, 30, 650);
    const tokenWidth = this.measure(ctx, tokenText, tokenFont);
    const iconSize = 58;
    const iconGap = 16;
    const headingWidth = iconSize + iconGap + tokenWidth;
    const headingX = 540 - headingWidth / 2;
    imageCircle(ctx, this.logo, headingX + iconSize / 2, 797, iconSize / 2, initials(tokenText), '#967614');
    text(ctx, tokenText, headingX + iconSize + iconGap, 797, tokenFont, COLOR.white, 'left', 'middle');

    ctx.beginPath();
    ctx.setLineDash([3, 11]);
    ctx.moveTo(headingX + iconSize + iconGap, 839);
    ctx.lineTo(headingX + headingWidth, 839);
    ctx.strokeStyle = '#625a42';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.setLineDash([]);

    const { pnl: shownPnl, roi: shownRoi } = displayedProfit(state);
    const unavailable = shownPnl === null;
    const positive = !unavailable && shownPnl >= 0;
    const result = unavailable ? '—' : state.currentEventIndex < 0 && this.data.replayAccounting?.version !== 2 ? '$0.00' : resultMoney(shownPnl);
    const pnlColor = unavailable ? COLOR.white : positive ? COLOR.green : COLOR.red;
    const resultFont = fitFont(ctx, result, 620, 78, 50, 720);
    const resultWidth = this.measure(ctx, result, resultFont);
    const roiText = shownRoi === null ? '' : `(${shownRoi >= 0 ? '▲' : '▼'} ${percentage(shownRoi)})`;
    const roiInset = 6;
    const roiFont = fitFont(ctx, roiText, 260 - roiInset * 2, 36, 26, 650);
    const roiSize = Number(/([\d.]+)px/.exec(roiFont)?.[1]) || 36;
    const roiParts = roiText ? [
      { text: '(', color: COLOR.muted, scale: 0.86, paddingAfter: roiInset },
      { text: `${shownRoi >= 0 ? '▲' : '▼'} `, color: shownRoi >= 0 ? COLOR.green : COLOR.red, scale: 0.78, paddingAfter: 0 },
      { text: percentage(shownRoi), color: COLOR.white, scale: 1, paddingAfter: roiInset },
      { text: ')', color: COLOR.muted, scale: 0.86, paddingAfter: 0 },
    ].map(part => {
      const font = `650 ${(roiSize * part.scale).toFixed(1)}px ${FONT}`;
      return { ...part, font, width: this.measure(ctx, part.text, font), bounds: textBounds(ctx, part.text, font) };
    }) : [];
    const roiWidth = roiParts.reduce((sum, part) => sum + part.width + part.paddingAfter, 0);
    const profitGap = roiText ? 28 : 0;
    const profitX = 540 - (resultWidth + profitGap + roiWidth) / 2;
    const resultBounds = textBounds(ctx, result, resultFont);
    text(ctx, result, profitX, 907 + (resultBounds.ascent - resultBounds.descent) / 2, resultFont, pnlColor);
    let roiX = profitX + resultWidth + profitGap;
    for (const part of roiParts) {
      text(ctx, part.text, roiX, 907 + (part.bounds.ascent - part.bounds.descent) / 2, part.font, part.color);
      roiX += part.width + part.paddingAfter;
    }
    if (this.data.replayAccounting?.version === 2) text(ctx,
      `${state.accountingFinal ? 'FINAL' : 'ESTIMATE'} · ${String(this.data.replayAccounting.source).toUpperCase()}${this.data.accountingSnapshot?.historyBoundary === 'verified_zero_position' ? ' · TRACKED POSITION' : ''}${this.data.chart.marketCapEstimated ? ' · EST. MCAP' : ''}`,
      540, 958, `500 16px ${FONT}`, COLOR.dim, 'center');

    ctx.beginPath();
    ctx.moveTo(x + 1, 978);
    ctx.lineTo(x + width - 1, 978);
    ctx.strokeStyle = COLOR.panelEdge;
    ctx.lineWidth = 2;
    ctx.stroke();
    for (const divider of [369, 711]) {
      ctx.beginPath();
      ctx.moveTo(divider, 978);
      ctx.lineTo(divider, y + height - 1);
      ctx.stroke();
    }

    const columns = [
      { center: 199, label: 'Invested', value: state.invested !== null ? money(state.invested, 2, true) : '—' },
      { center: 540, label: 'Avg. entry', value: this.capMode && state.avgEntryCap > 0 ? money(state.avgEntryCap, 0, true) : '—' },
      { center: 881, label: 'Current', value: state.currentCap > 0 ? this.capMode ? money(state.currentCap, 0, true) : this.priceText(state.currentCap) : '—' },
    ].map(column => {
      const labelFont = fitFont(ctx, column.label, 290, 28, 22, 500);
      const valueFont = fitFont(ctx, column.value, 280, 40, 28, 600);
      return { ...column, labelFont, valueFont,
        labelBounds: textBounds(ctx, column.label, labelFont), valueBounds: textBounds(ctx, column.value, valueFont) };
    });
    const labelAscent = Math.max(...columns.map(column => column.labelBounds.ascent));
    const labelDescent = Math.max(...columns.map(column => column.labelBounds.descent));
    const valueAscent = Math.max(...columns.map(column => column.valueBounds.ascent));
    const valueDescent = Math.max(...columns.map(column => column.valueBounds.descent));
    const rowGap = 16;
    const contentHeight = labelAscent + labelDescent + rowGap + valueAscent + valueDescent;
    const contentTop = (978 + y + height) / 2 - contentHeight / 2;
    const labelBaseline = contentTop + labelAscent;
    const valueBaseline = labelBaseline + labelDescent + rowGap + valueAscent;
    for (const column of columns) {
      text(ctx, column.label, column.center, labelBaseline, column.labelFont, '#aaa596', 'center');
      text(ctx, column.value, column.center, valueBaseline, column.valueFont, COLOR.white, 'center');
    }
  }

  priceText(value) {
    return Number.isFinite(value) && value > 0 ? '$' + value.toLocaleString('en-US', { maximumSignificantDigits: 4 }) : '—';
  }

  measure(ctx, value, font) {
    ctx.font = font;
    return ctx.measureText(value).width;
  }

  drawFooter(ctx) {
    const width = 330;
    const height = width * BRAND_WORDMARK_PATHS.height / BRAND_WORDMARK_PATHS.width;
    text(ctx, 'kollens.com', WIDTH - 49, 1293 - height / 2, `600 30px ${FONT}`, '#0c0e11', 'right', 'middle');
    if (this.brandWordmark?.naturalWidth > 0) {
      try {
        ctx.save();
        // Keep the app wordmark at its native proportions beside the URL.
        // Tint it black for contrast against the solid gold canvas frame.
        ctx.filter = 'brightness(0)';
        ctx.drawImage(this.brandWordmark, 49, 1293 - height, width, height);
        ctx.restore();
        return;
      } catch {
        ctx.restore();
      }
    }
    drawBrandMark(ctx, BRAND_WORDMARK_PATHS, 49, 1293 - height, width, height, '#0c0e11');
  }
}

export default ReplayCanvas;
