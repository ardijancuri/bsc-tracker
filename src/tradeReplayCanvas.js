/**
 * Adapted from the user-supplied BScan Trade Replay Studio (second handoff).
 * BScan trade recap, drawn entirely on a 1080 × 1350 canvas.
 *
 * The visual timeline can spend more time around a trader's fills than around
 * quiet chart history. Dates, chart prices, and fill values remain real data.
 * All rendering is derived from `progress`; exporting frames in any order gives
 * the same result.
 */

const WIDTH = 1080;
const HEIGHT = 1350;
const DURATION = 15.5;
const MINUTE = 60_000;
const PLAYHEAD_FRACTION = 0.64;
const FONT = 'Inter, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

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
    if (abs >= 1e12) return `$${(abs / 1e12).toFixed(1)}T`;
    if (abs >= 1e9) return `$${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
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
    this.eventProgresses = [];
    this.supply = null;
    this.fillOnly = false;
    this.storyWindow = 0.5;
    this.markerRadius = 26;
    this.markerPlacements = [];
    this.tooltipRects = [];
    this.axisTicks = [];
    this.cameraValues = [];
    this.yMin = 0;
    this.yMax = 1;
    this.render(0);
  }

  async setData(data) {
    if (!data || !data.kol || !data.token) throw new TypeError('Replay data needs kol and token');
    this.data = data;
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
    const firstFillTs = this.trades[0]?.ts ?? -Infinity;
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
    this.plotPoints = [...marketVertices, ...fillVertices]
      .sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        if (a.kind !== b.kind) return a.kind === 'market' ? -1 : 1;
        return (a.tradeIndex ?? 0) - (b.tradeIndex ?? 0);
      });
    if (!this.plotPoints.length) this.plotPoints = this.points.map((point) => ({ ...point, kind: 'market' }));

    const firstTrade = this.trades[0]?.ts;
    const lastTrade = this.trades.at(-1)?.ts;
    const firstPoint = this.points[0]?.ts;
    const lastPoint = this.points.at(-1)?.ts;
    this.timelineStart = firstTrade ?? firstPoint ?? Infinity;
    if (!Number.isFinite(this.timelineStart)) this.timelineStart = Date.now();

    this.tradeEnd = lastTrade ?? this.timelineStart;
    // A trade recap ends with its final recorded fill, even when a current
    // wallet balance is unavailable. Later market hours do not become an exit.
    this.timelineEnd = this.trades.length ? this.tradeEnd : lastPoint ?? this.tradeEnd;
    if (!this.trades.length && this.timelineEnd <= this.timelineStart) this.timelineEnd = this.timelineStart + MINUTE;

    // Trade recaps need enough screen time for consecutive fills even when the
    // chain timestamps differ by seconds. Actual timestamps remain the x-axis
    // and price lookup; these progress knots only set presentation pacing.
    if (this.trades.length >= 2) {
      this.eventPhase = 0.84;
      const gaps = this.trades.slice(1).map((trade, i) => Math.max(0, trade.ts - this.trades[i].ts));
      const minimumGap = Math.min(0.04, this.eventPhase / gaps.length * 0.82);
      const weighted = gaps.map((gap) => Math.log1p(gap / 1000) + 0.5);
      const totalWeight = weighted.reduce((sum, value) => sum + value, 0);
      const discretionary = this.eventPhase - minimumGap * gaps.length;
      this.eventProgresses = [0];
      for (let i = 0; i < gaps.length; i += 1) {
        this.eventProgresses.push(this.eventProgresses.at(-1) + minimumGap + discretionary * weighted[i] / totalWeight);
      }
      this.eventProgresses[this.eventProgresses.length - 1] = this.eventPhase;
    } else {
      this.eventPhase = this.trades.length ? 0 : 1;
      this.eventProgresses = this.trades.length ? [0] : [];
    }

    // Keep exact fill anchors separated horizontally, even for KOLs with a
    // denser trade history. The camera still pans at a constant speed within
    // each replay; only the amount of history visible at once changes.
    const eventGaps = this.eventProgresses.slice(1).map((q, i) => q - this.eventProgresses[i]);
    const minEventGap = eventGaps.length ? Math.min(...eventGaps) : 1;
    this.storyWindow = Math.min(0.5, Math.max(0.08, minEventGap * (814 - 42) / 62));
    const projectedGap = minEventGap * (814 - 42) / this.storyWindow;
    this.markerRadius = clamp((projectedGap - 8) / 2, 12, 26);

    const story = this.plotPoints
      .filter((point) => point.ts <= this.timelineEnd && point.priceUsd > 0)
      .map((point) => ({
        ts: point.ts,
        kind: point.kind,
        tradeIndex: point.tradeIndex,
        q: point.kind === 'fill' ? this.eventProgress(point.tradeIndex) : this.progressAtTime(point.ts),
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
    this.layoutTooltips();

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
    return DURATION;
  }

  chartProgress(progress) {
    return this.trades.length ? Math.min(clamp(finite(progress), 0, 1), this.eventPhase) : clamp(finite(progress), 0, 1);
  }

  viewportAt(progress) {
    const p = this.chartProgress(progress);
    const camera = this.cameraAt(p);
    const startQ = p - this.storyWindow * PLAYHEAD_FRACTION;
    const time = this.timeAt(p);
    const startTime = startQ < 0 ? this.timelineStart + startQ / 0.12 * 2 * MINUTE : this.timeAt(startQ);
    const endTime = this.timeAt(startQ + this.storyWindow);
    return { time, startTime, endTime, spanTime: endTime - startTime,
      startQ, endQ: startQ + this.storyWindow, yMin: camera.min, yMax: camera.max };
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
      x: 42 + (point.q - viewport.startQ) / this.storyWindow * 772,
      y: this.yAtCap(point.marketCapUsd, camera) }));
  }

  markerPosition(index, progress) {
    const marker = this.markerPlacements[index];
    if (!marker || !Number.isFinite(marker.cap) || marker.cap <= 0) return null;
    const p = this.chartProgress(progress);
    const viewport = this.viewportAt(p);
    const x = 42 + (marker.q - viewport.startQ) / this.storyWindow * 772;
    const y = this.markerCenterY(marker.cap, { min: viewport.yMin, max: viewport.yMax });
    const elapsed = Math.max(0, (clamp(finite(progress), 0, 1) - marker.q) * DURATION);
    const entrance = smoothstep(elapsed / 0.19);
    return { index, ts: marker.ts, q: marker.q, x, y, marketValue: marker.cap,
      executionValue: this.capMode ? this.trades[index].marketCapUsd : this.trades[index].priceUsd,
      visible: marker.q <= p + 1e-9 && x - this.markerRadius - 2 >= 42 && x + this.markerRadius + 2 <= 814,
      alpha: marker.q > p + 1e-9 ? 0 : 0.2 + 0.8 * entrance };
  }

  eventProgress(index) {
    return this.eventProgresses[index] ?? 0;
  }

  progressAtTime(ts) {
    if (!this.trades.length) {
      return (ts - this.timelineStart) / (this.timelineEnd - this.timelineStart);
    }
    if (ts < this.trades[0].ts) {
      return -Math.min(0.16, (this.trades[0].ts - ts) / (2 * MINUTE) * 0.12);
    }
    if (ts >= this.tradeEnd) {
      const tail = this.timelineEnd - this.tradeEnd;
      return tail > 0 ? this.eventPhase + (ts - this.tradeEnd) / tail * (1 - this.eventPhase) : this.eventPhase;
    }
    for (let i = 0; i < this.trades.length - 1; i += 1) {
      const a = this.trades[i];
      const b = this.trades[i + 1];
      if (ts <= b.ts) {
        const fraction = b.ts > a.ts ? (ts - a.ts) / (b.ts - a.ts) : 0;
        return this.eventProgress(i) + fraction * (this.eventProgress(i + 1) - this.eventProgress(i));
      }
    }
    return this.eventPhase;
  }

  buildCamera() {
    // Fit the revealed portion of the scrolling viewport. An early position
    // still uses a zero baseline, but once its low prices leave the window,
    // the lower bound follows the visible range. This makes later, smaller
    // swings legible without changing any price or fill vertex. Both bounds
    // are precomputed so seeking and export produce identical frames.
    const samples = 1025;
    const step = 1 / (samples - 1);
    const riseRate = 1 - Math.exp(-DURATION * step / 0.105);
    const fallRate = 1 - Math.exp(-step / 0.055);
    const floorRiseRate = 1 - Math.exp(-DURATION * step / 0.65);
    const floorFallRate = 1 - Math.exp(-DURATION * step / 0.14);
    const maxLogFall = 0.6 * DURATION * step;
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
    // The circle stays at the fill's exact x coordinate; its lower edge sits
    // four pixels above the fill vertex, without a connector stem.
    return clamp(this.yAtCap(cap, cameraRange), 265, 658) - this.markerRadius - 4;
  }

  buildAxisTicks() {
    const span = Math.max(MINUTE, this.timelineEnd - this.timelineStart);
    // Build a denser set of fixed clock ticks, then choose labels by their
    // actual on-screen distance. Story pacing can place two real minutes far
    // apart near the final fills even when earlier minutes are compressed.
    const majorStep = axisStep(span);
    const step = AXIS_STEPS[Math.max(0, AXIS_STEPS.indexOf(majorStep) - 1)];
    const prehistory = 2 * MINUTE * (this.storyWindow + 0.1) / 0.12;
    const first = Math.floor((this.timelineStart - prehistory) / step) * step;
    const minStoryGap = 180 / (814 - 42) * this.storyWindow;
    const candidates = [];
    const labels = new Set();
    for (let ts = first; ts <= this.timelineEnd && candidates.length < 1000; ts += step) {
      const q = ts < this.timelineStart
        ? (ts - this.timelineStart) / (2 * MINUTE) * 0.12
        : this.progressAtTime(ts);
      if (q < -this.storyWindow - 0.1) continue;
      const label = axisLabel(ts, span);
      if (labels.has(label)) continue;
      candidates.push({ q, ts, label });
      labels.add(label);
    }
    const endingQ = this.trades.length && this.timelineEnd === this.tradeEnd ? this.eventPhase : 1;
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
    this.markerPlacements = this.trades.map((trade, index) => ({
      index,
      q: this.eventProgress(index),
      ts: trade.ts,
      cap: this.capMode ? trade.marketCapUsd : trade.priceUsd,
    }));
  }

  layoutTooltips() {
    const left = 42;
    const right = 814;
    this.tooltipRects = this.trades.map((trade, index) => {
      const eventProgress = this.eventProgress(index);
      const nextProgress = this.eventProgresses[index + 1]
        ?? (this.timelineEnd > this.tradeEnd ? 1 : this.eventPhase);
      const anchorX = left + PLAYHEAD_FRACTION * (right - left);
      const anchorCap = this.capMode ? trade.marketCapUsd : trade.priceUsd;
      const anchorY = this.markerCenterY(anchorCap, this.cameraAt(eventProgress));
      const bubbles = [];
      const linePoints = [];
      // Score each fixed position against the chart throughout this fill's
      // on-screen interval. The chosen rectangle never moves before the next
      // trade replaces it, even while the chart pans and zooms underneath.
      const travel = (nextProgress - eventProgress) / this.storyWindow * (right - left);
      const samples = Math.max(2, Math.ceil(travel / 12));
      for (let sample = 0; sample <= samples; sample += 1) {
        const fraction = sample / samples;
        const progress = eventProgress + (nextProgress - eventProgress) * fraction;
        const cameraRange = this.cameraAt(progress);
        const windowStart = progress - this.storyWindow * PLAYHEAD_FRACTION;
        const xAt = (q) => left + (q - windowStart) / this.storyWindow * (right - left);
        for (const marker of this.markerPlacements) {
          if (marker.index > index) continue;
          const q = marker.q;
          const bubbleX = xAt(q);
          const bubbleY = this.markerCenterY(marker.cap, cameraRange);
          if (bubbleX >= left + this.markerRadius && bubbleX <= right - this.markerRadius) {
            bubbles.push({ x: bubbleX, y: bubbleY });
          }
        }
        for (const point of this.storyVertices) {
          if (point.q > progress) continue;
          const x = xAt(point.q);
          if (x >= left && x <= right) linePoints.push({ x, y: this.yAtCap(point.marketCapUsd, cameraRange) });
        }
      }
      return this.chooseTooltip(anchorX, anchorY, bubbles, linePoints);
    });
  }

  timeAt(progress) {
    const p = this.chartProgress(progress);
    if (this.trades.length && p >= this.eventPhase) return this.tradeEnd;
    if (!this.trades.length) return this.timelineStart + p * (this.timelineEnd - this.timelineStart);
    if (p <= this.eventPhase && this.trades.length > 1) {
      for (let i = 0; i < this.eventProgresses.length - 1; i += 1) {
        if (p <= this.eventProgresses[i + 1]) {
          const start = this.eventProgresses[i];
          const end = this.eventProgresses[i + 1];
          const fraction = end > start ? (p - start) / (end - start) : 0;
          return this.trades[i].ts + fraction * (this.trades[i + 1].ts - this.trades[i].ts);
        }
      }
    }
    if (this.eventPhase < 1) {
      return this.tradeEnd + ((p - this.eventPhase) / (1 - this.eventPhase)) * (this.timelineEnd - this.tradeEnd);
    }
    return this.timelineStart + p * (this.timelineEnd - this.timelineStart);
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
    if (this.fillOnly) return {
      priceUsd: a.priceUsd + (b.priceUsd - a.priceUsd) * fraction,
      marketCapUsd: a.marketCapUsd + (b.marketCapUsd - a.marketCapUsd) * fraction,
    };
    return {
      priceUsd: hermite(a.priceUsd, b.priceUsd, this.storyPriceTangents[lo - 1], this.storyPriceTangents[lo], fraction, span),
      marketCapUsd: hermite(a.marketCapUsd, b.marketCapUsd, this.storyCapTangents[lo - 1], this.storyCapTangents[lo], fraction, span),
    };
  }

  snapshot(progress) {
    if (!this.data) return {
      time: null, invested: 0, proceeds: 0, holdings: 0, pnl: 0, roi: 0, realizedPnl: null, realizedRoi: null,
      avgEntryCap: 0, currentCap: 0, currentPrice: 0, currentEventIndex: -1, status: 'Waiting',
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
      if (soldTokens > boughtTokens + Math.max(Number.MIN_VALUE, boughtTokens * 1e-10)) partialHistory = true;
    }
    const holdings = Math.abs(boughtTokens - soldTokens) <= Math.max(Number.MIN_VALUE, boughtTokens * 1e-10) ? 0 : boughtTokens - soldTokens;
    const quote = this.valueAtStory(p);
    const currentPrice = quote.priceUsd;
    const currentCap = quote.marketCapUsd;
    const position = this.data.position;
    const pricedFills = this.trades.every((trade) => trade.amountUsd !== null && trade.tokenAmount !== null && Number.isFinite(trade.amountUsd) && trade.amountUsd > 0);
    const accountingReady = Boolean(position) && (
      position.tradeFlowMatched === true
      && position.tradesComplete === true
      && (position.status === 'open' || position.status === 'closed')
      && pricedFills
    );
    const marketQuoteAvailable = !this.fillOnly || holdings === 0;
    const pnl = partialHistory || !accountingReady || !marketQuoteAvailable || !investedKnown || !proceedsKnown || !quantitiesKnown ? null : proceeds + holdings * currentPrice - invested;
    const roi = pnl === null ? null : invested > 0 ? pnl / invested : 0;
    const realizedRoi = realizedPnl !== null && investedKnown && invested > 0 ? realizedPnl / invested : null;
    const avgEntryCap = investedKnown && quantitiesKnown && boughtTokens > 0 && this.supply ? invested / boughtTokens * this.supply : null;
    let status = partialHistory || !quantitiesKnown ? 'Partial history'
      : currentEventIndex < 0 ? 'Waiting'
      : holdings > Math.max(Number.MIN_VALUE, boughtTokens * 1e-10) ? 'Open' : 'Closed';
    // The replay animates observed swaps, but its ending label reflects the
    // wallet balance checked at generation time. Transfers can make those two
    // views differ, so an unavailable balance is never called closed.
    if (position && currentEventIndex === this.trades.length - 1) {
      status = position.status === 'open' ? 'Open'
        : position.status === 'closed' ? 'Closed' : 'Unknown';
    }
    return {
      time: new Date(ts).toISOString(), invested: investedKnown ? invested : null, proceeds: proceedsKnown ? proceeds : null, holdings: quantitiesKnown ? holdings : null, pnl, roi,
      avgEntryCap, currentCap, currentPrice, currentEventIndex, status, realizedPnl, realizedRoi,
    };
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

    const status = state.status === 'Unknown' ? 'RECORDED TRADES' : state.status.toUpperCase();
    const statusFill = state.status === 'Open' ? '#3b3214' : state.status === 'Closed' || state.status === 'Unknown' ? '#272721' : '#312820';
    const statusText = state.status === 'Open' ? COLOR.goldBright : '#c4bda7';
    const statusFont = `750 25px ${FONT}`;
    ctx.font = statusFont;
    const pillWidth = ctx.measureText(status).width + 36;
    fillRound(ctx, left, detailRow - detailHeight / 2, pillWidth, detailHeight, 11, statusFill);
    rowText(status, left + pillWidth / 2, detailRow, statusFont, statusText, 'center');
    if (this.brandIcon?.naturalWidth > 0) {
      try {
        // The supplied SVG's icon occupies this rectangle inside its viewBox.
        // Crop its transparent padding so the visible edge meets the date.
        const iconWidth = detailHeight * 114 / 120;
        ctx.drawImage(this.brandIcon, 7, 4, 114, 120,
          right - iconWidth, detailRow - detailHeight / 2, iconWidth, detailHeight);
      } catch {
        rowText('k/', right, detailRow, `800 36px ${FONT}`, '#8b877d', 'right');
      }
    } else {
      rowText('k/', right, detailRow, `800 36px ${FONT}`, '#8b877d', 'right');
    }
  }

  drawChart(ctx, progress, state) {
    const chartProgress = this.chartProgress(progress);
    const cameraRange = this.cameraAt(chartProgress);
    const left = 42;
    const right = 814;
    const top = 272;
    const bottom = 651;
    const windowStart = chartProgress - this.storyWindow * PLAYHEAD_FRACTION;
    const windowEnd = windowStart + this.storyWindow;
    const xAtProgress = (storyProgress) => left + (storyProgress - windowStart) / this.storyWindow * (right - left);
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
      if (!this.fillOnly) {
        const area = ctx.createLinearGradient(0, top, 0, bottom);
        area.addColorStop(0, 'rgba(240,185,11,0.18)');
        area.addColorStop(0.68, 'rgba(240,185,11,0.055)');
        area.addColorStop(1, 'rgba(240,185,11,0)');
        this.traceLine(ctx, pathPoints);
        ctx.lineTo(pathPoints.at(-1).x, bottom + 10);
        ctx.lineTo(pathPoints[0].x, bottom + 10);
        ctx.closePath();
        ctx.fillStyle = area;
        ctx.fill();
      }
      ctx.save();
      ctx.shadowColor = 'rgba(240,185,11,0.38)';
      ctx.shadowBlur = 13;
      this.traceLine(ctx, pathPoints);
      ctx.strokeStyle = COLOR.gold;
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
          ctx.fillStyle = COLOR.goldBright;
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
    ctx.strokeStyle = 'rgba(240,185,11,0.42)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    // The clipped spline ends at the same quote as the dashed guide. A small
    // round cap covers the clip edge without revealing any future price.
    if (pathPoints.length) {
      ctx.beginPath();
      ctx.arc(activeX, currentY, this.fillOnly ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = this.fillOnly ? COLOR.goldBright : COLOR.gold;
      ctx.fill();
    }

    } else {
      text(ctx, 'Execution prices unavailable', 428, 470, `550 28px ${FONT}`, COLOR.muted, 'center');
    }
    const visibleMarkers = this.drawTradeMarkers(ctx, progress, windowStart, windowEnd, xAtProgress, state, cameraRange);
    ctx.restore();

    const capText = hasQuote ? this.capMode ? money(state.currentCap, 0, true) : this.priceText(state.currentCap) : '—';
    fillRound(ctx, 844, currentY - 29, 188, 58, 14, COLOR.gold, 'rgba(255,221,97,0.65)', 2);
    text(ctx, capText, 938, currentY + 1, fitFont(ctx, capText, 170, 33, 25, 750), '#18150b', 'center', 'middle');
    text(ctx, this.capMode ? 'FDV' : 'USD PRICE', 939, currentY + 62, `550 21px ${FONT}`, COLOR.dim, 'center');

    for (const tick of this.axisTicks) {
      const x = xAtProgress(tick.q);
      if (x < 68 || x > 788) continue;
      text(ctx, tick.label, x, 698, `500 26px ${FONT}`, '#8c8676', 'center');
    }

    const activeIndex = state.currentEventIndex;
    const active = this.trades[activeIndex];
    if (active) {
      const elapsed = Math.max(0, (progress - this.eventProgress(activeIndex)) * DURATION);
      if (activeIndex > 0 && elapsed < 0.09) {
        const previousRect = this.tooltipRects[activeIndex - 1];
        const clearance = visibleMarkers.reduce((closest, marker) => {
          const dx = Math.max(previousRect.x - marker.x, 0, marker.x - previousRect.x - previousRect.width);
          const dy = Math.max(previousRect.y - marker.y, 0, marker.y - previousRect.y - previousRect.height);
          return Math.min(closest, Math.hypot(dx, dy));
        }, Infinity);
        const clearFade = clamp((clearance - this.markerRadius) / 14, 0, 1);
        const previousOpacity = (1 - smoothstep(elapsed / 0.09)) * clearFade;
        if (previousOpacity > 0.01) {
          this.drawTradeTooltip(ctx, this.trades[activeIndex - 1], previousRect, previousOpacity);
        }
      } else {
        const opacity = activeIndex === 0
          ? 0.15 + 0.85 * smoothstep(elapsed / 0.19)
          : smoothstep((elapsed - 0.09) / 0.10);
        if (opacity > 0.01) this.drawTradeTooltip(ctx, active, this.tooltipRects[activeIndex], opacity);
      }
    }
  }

  traceLine(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) {
      ctx.lineTo(points[0].x + 1, points[0].y);
      return;
    }
    if (this.fillOnly) {
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
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
      const entrance = smoothstep((progress - q) * DURATION / 0.19);
      const alpha = 0.2 + 0.8 * entrance;
      const scale = 0.82 + 0.18 * entrance;
      // Each circle stays at its exact fill time just above its fill vertex.
      if (x - this.markerRadius - 2 < 42 || x + this.markerRadius + 2 > 814) continue;
      markers.push({
        x, y,
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
      ctx.restore();
    }
    for (const marker of markers) {
      ctx.save();
      ctx.globalAlpha = marker.alpha;
      text(ctx, marker.letter, marker.x, marker.y + 1,
        `800 ${Math.max(12, Math.round(this.markerRadius * marker.scale * 0.92))}px ${FONT}`,
        '#ffffff', 'center', 'middle');
      ctx.restore();
    }
    return markers;
  }

  chooseTooltip(anchorX, anchorY, bubbles, linePoints) {
    const width = 346;
    const height = 92;
    const candidates = [];
    for (const y of [258, 348, 450, 548]) {
      for (const x of [42, 130, 230, 358, 458, 488]) candidates.push({ x, y, width, height });
    }
    let best = candidates[0];
    let bestScore = Infinity;
    for (const rect of candidates) {
      const bubblePenalty = bubbles.reduce((total, bubble) => {
        const dx = Math.max(rect.x - bubble.x, 0, bubble.x - (rect.x + rect.width));
        const dy = Math.max(rect.y - bubble.y, 0, bubble.y - (rect.y + rect.height));
        const distance = Math.hypot(dx, dy);
        if (distance < this.markerRadius + 2) {
          return total + 100_000 + (this.markerRadius + 2 - distance) * 1000;
        }
        return total + Math.max(0, this.markerRadius + 16 - distance) * 20;
      }, 0);
      const linePenalty = linePoints.filter((point) =>
        point.x >= rect.x - 8 && point.x <= rect.x + rect.width + 8
        && point.y >= rect.y - 8 && point.y <= rect.y + rect.height + 8).length * 4;
      const centerPenalty = Math.abs(anchorX - (rect.x + width / 2)) * 0.55;
      const verticalPenalty = Math.abs(anchorY - (rect.y + height / 2)) * 0.04;
      const score = bubblePenalty + linePenalty + centerPenalty + verticalPenalty;
      if (score < bestScore) {
        best = rect;
        bestScore = score;
      }
    }
    return best;
  }

  drawTradeTooltip(ctx, trade, rect, opacity) {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 17;
    fillRound(ctx, rect.x, rect.y, rect.width, rect.height, 16, '#1d1c18', '#4b4430', 1);
    ctx.shadowBlur = 0;
    const isBuy = trade.side === 'buy';
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(trade.ts);
    text(ctx, `${isBuy ? 'BUY' : 'SELL'} · ${time} UTC`, rect.x + 20, rect.y + 30, `650 20px ${FONT}`, '#c6bfae');
    const amount = trade.amountUsd > 0 ? `${isBuy ? '+' : '−'} ${money(trade.amountUsd, 2, trade.amountUsd >= 1000)}` : '—';
    const cap = this.capMode && trade.marketCapUsd > 0 ? `${money(trade.marketCapUsd, 1, true)} FDV` : trade.priceUsd > 0 ? this.priceText(trade.priceUsd) : 'Price unavailable';
    text(ctx, amount, rect.x + 20, rect.y + 71, fitFont(ctx, amount, 166, 29, 21, 750), isBuy ? COLOR.green : COLOR.red);
    text(ctx, cap, rect.x + rect.width - 18, rect.y + 70, fitFont(ctx, cap, 150, 23, 17, 600), '#c8c0af', 'right');
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

    const tokenName = shortName(this.data.token.symbol || this.data.token.name || 'TOKEN', 16);
    const tokenText = tokenName.toUpperCase();
    const headingWidth = this.logo ? 37 + 13 + this.measure(ctx, tokenText, `650 34px ${FONT}`) : this.measure(ctx, tokenText, `650 34px ${FONT}`);
    const headingX = 540 - headingWidth / 2;
    if (this.logo) imageCircle(ctx, this.logo, headingX + 18, 798, 19, initials(tokenName), '#967614');
    text(ctx, tokenText, headingX + (this.logo ? 50 : 0), 809, fitFont(ctx, tokenText, 690, 34, 25, 650), COLOR.white);

    ctx.beginPath();
    ctx.setLineDash([3, 11]);
    ctx.moveTo(425, 839);
    ctx.lineTo(655, 839);
    ctx.strokeStyle = '#625a42';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.setLineDash([]);

    const realizedFallback = state.pnl === null && state.realizedPnl !== null;
    const shownPnl = realizedFallback ? state.realizedPnl : state.pnl;
    const shownRoi = realizedFallback ? state.realizedRoi : state.roi;
    const unavailable = shownPnl === null;
    const positive = !unavailable && shownPnl >= 0;
    const result = unavailable ? 'P&L unavailable' : state.currentEventIndex < 0 ? '$0.00' : resultMoney(shownPnl);
    const pnlColor = unavailable ? COLOR.white : positive ? COLOR.green : COLOR.red;
    text(ctx, realizedFallback ? 'REALIZED P&L' : state.status === 'Open' ? 'EST. GROSS P&L' : 'GROSS P&L', 76, 884, `650 18px ${FONT}`, COLOR.muted);
    text(ctx, result, 75, 956, fitFont(ctx, result, 660, 76, 49, 720), pnlColor);

    const roiText = shownRoi === null ? '—' : `${shownRoi >= 0 ? '▲' : '▼'} ${percentage(shownRoi)}`;
    text(ctx, realizedFallback ? 'REALIZED RETURN' : 'RETURN', 1003, 884, `650 18px ${FONT}`, COLOR.muted, 'right');
    text(ctx, roiText, 1003, 946, fitFont(ctx, roiText, 285, 36, 24, 650), shownRoi === null ? COLOR.white : shownRoi >= 0 ? COLOR.green : COLOR.red, 'right');

    ctx.beginPath();
    ctx.moveTo(x + 1, 989);
    ctx.lineTo(x + width - 1, 989);
    ctx.strokeStyle = COLOR.panelEdge;
    ctx.lineWidth = 2;
    ctx.stroke();
    for (const divider of [369, 711]) {
      ctx.beginPath();
      ctx.moveTo(divider, 989);
      ctx.lineTo(divider, y + height - 1);
      ctx.stroke();
    }

    const columns = [
      { center: 199, label: 'Invested', value: state.invested !== null ? money(state.invested, 2, true) : '—' },
      { center: 540, label: 'Avg. entry', value: this.capMode && state.avgEntryCap > 0 ? money(state.avgEntryCap, 0, true) : '—' },
      { center: 881, label: 'Current', value: state.currentCap > 0 ? this.capMode ? money(state.currentCap, 0, true) : this.priceText(state.currentCap) : '—' },
    ];
    for (const column of columns) {
      text(ctx, column.label, column.center, 1050, fitFont(ctx, column.label, 290, 28, 22, 500), '#aaa596', 'center');
      text(ctx, column.value, column.center, 1115, fitFont(ctx, column.value, 280, 40, 28, 600), COLOR.white, 'center');
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
    if (this.brandWordmark?.naturalWidth > 0) {
      try {
        ctx.save();
        // Use the complete outlined wordmark without stretching its lettering.
        // Tint it black for contrast against the solid gold canvas frame.
        ctx.filter = 'brightness(0)';
        const width = 440;
        const height = width * this.brandWordmark.naturalHeight / this.brandWordmark.naturalWidth;
        ctx.drawImage(this.brandWordmark, 49, 1293 - height, width, height);
        ctx.restore();
        return;
      } catch {
        ctx.restore();
      }
    }
    text(ctx, 'kollens', 49, 1293, fitFont(ctx, 'kollens', 440, 76, 55, 850), '#0c0e11');
  }
}

export default ReplayCanvas;
