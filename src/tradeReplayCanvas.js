/**
 * Adapted from the user-supplied BScan Trade Replay Studio.
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
const FONT = 'Manrope, "Helvetica Neue", Arial, sans-serif';

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

function axisLabel(time, span, includeSeconds = false) {
  if (span < 2 * 24 * 60 * MINUTE) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit',
      second: includeSeconds ? '2-digit' : undefined, hour12: false,
    }).format(time);
  }
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(time);
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
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0];
    if (i === points.length - 1) return slopes.at(-1);
    const before = slopes[i - 1];
    const after = slopes[i];
    return before * after <= 0 ? 0 : 2 / (1 / before + 1 / after);
  });
  // Limit slopes as a pair. The time curve must never overtake a later fill or
  // reverse while transitioning between presentation speeds.
  for (let i = 0; i < slopes.length; i += 1) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const magnitude = Math.hypot(tangents[i] / slopes[i], tangents[i + 1] / slopes[i]);
    if (magnitude > 3) {
      tangents[i] *= 3 / magnitude;
      tangents[i + 1] *= 3 / magnitude;
    }
  }
  return tangents;
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
    this.timeWindow = MINUTE;
    this.timeKnots = [];
    this.timeTangents = [];
    this.markerRadius = 21;
    this.markerPlacements = [];
    this.tooltipRects = [];
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
        tradeIndex: trade.index,
        priceUsd: trade.priceUsd,
        marketCapUsd: trade.marketCapUsd > 0 ? trade.marketCapUsd : this.supply ? trade.priceUsd * this.supply : NaN,
      }));
    }

    // Preserve market observations as the line. B/S markers follow that line
    // at each recorded time; exact execution prices remain in their receipts.
    const firstFillTs = this.trades[0]?.ts ?? -Infinity;
    const prior = this.points.filter(point => point.ts < firstFillTs).at(-1);
    const marketVertices = this.points
      .filter((point) => point.ts >= firstFillTs || point === prior)
      .map((point) => ({ ...point, kind: this.fillOnly ? 'fill' : 'market' }));
    this.plotPoints = marketVertices.length ? marketVertices : this.points.map(point => ({ ...point, kind: this.fillOnly ? 'fill' : 'market' }));

    const firstTrade = this.trades[0]?.ts;
    const lastTrade = this.trades.at(-1)?.ts;
    const firstPoint = this.points[0]?.ts;
    const lastPoint = this.points.at(-1)?.ts;
    this.timelineStart = firstTrade ?? firstPoint ?? Infinity;
    if (!Number.isFinite(this.timelineStart)) this.timelineStart = Date.now();

    this.tradeEnd = lastTrade ?? this.timelineStart;
    // A recap ends with this trader's last recorded fill. Open or unavailable
    // wallet balances must not make the camera drift through later chart hours.
    this.timelineEnd = this.trades.length ? this.tradeEnd : lastPoint ?? this.tradeEnd;
    if (!this.trades.length && this.timelineEnd <= this.timelineStart) this.timelineEnd = this.timelineStart + MINUTE;

    // Trade recaps need enough screen time for consecutive fills even when the
    // chain timestamps differ by seconds. Actual timestamps remain the x-axis
    // and price lookup; these progress knots only set presentation pacing.
    if (this.trades.length >= 2) {
      this.eventPhase = 0.9;
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
      this.eventPhase = this.trades.length ? 0.9 : 1;
      this.eventProgresses = this.trades.length ? [0] : [];
    }

    this.timeKnots = this.trades.map((trade, index) => ({ q: this.eventProgress(index), ts: trade.ts }));
    this.timeTangents = monotoneTangents(this.timeKnots, 'ts');
    if (this.timeTangents.length) this.timeTangents[this.timeTangents.length - 1] = 0;
    const replayPoints = this.plotPoints.filter(point => point.ts <= this.timelineEnd);
    const sampleGaps = replayPoints.slice(1)
      .map((point, index) => point.ts - replayPoints[index].ts)
      .filter((gap) => gap > 0).sort((a, b) => a - b);
    const sampleInterval = sampleGaps.length ? sampleGaps[Math.floor(sampleGaps.length / 2)] : 0;
    this.timeWindow = Math.max(MINUTE, (this.timelineEnd - this.timelineStart) * 0.62, sampleInterval * 3);

    const story = this.plotPoints
      .filter((point) => point.ts <= this.timelineEnd && point.priceUsd > 0)
      .map((point) => ({
        ts: point.ts,
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

    const caps = this.plotPoints
      .filter((point) => point.ts <= this.timelineEnd && point.ts >= this.timelineStart - 2 * MINUTE)
      .map((point) => this.capMode ? point.marketCapUsd : point.priceUsd)
      .filter((cap) => Number.isFinite(cap) && cap > 0);
    const high = caps.length ? Math.max(...caps) : 1;
    this.yMin = 0;
    this.yMax = Math.max(high * 1.35, this.capMode ? 1 : 1e-12);
    this.buildCamera();
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

  eventProgress(index) {
    return this.eventProgresses[index] ?? 0;
  }

  progressAtTime(ts) {
    if (ts < this.timelineStart) return (ts - this.timelineStart) / Math.max(MINUTE, this.timelineEnd - this.timelineStart);
    if (ts >= this.timelineEnd) return this.trades.length ? this.eventPhase : 1;
    let lo = 0;
    let hi = this.trades.length ? this.eventPhase : 1;
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const mid = (lo + hi) / 2;
      if (this.timeAt(mid) < ts) lo = mid; else hi = mid;
    }
    return hi;
  }

  chartProgress(progress) {
    return Math.min(clamp(finite(progress), 0, 1), this.trades.length ? this.eventPhase : 1);
  }

  buildCamera() {
    // Build a causal range envelope once. Only revealed observations can widen
    // the camera; later pumps cannot shrink today's line in anticipation. The
    // current range floor keeps the revealed curve in view without clamping its
    // geometry. Seeking and recording use the same deterministic envelope.
    const samples = 1025;
    const step = 1 / (samples - 1);
    const riseRate = 1 - Math.exp(-step * DURATION / 0.24);
    const fallRate = 1 - Math.exp(-step * DURATION / 0.8);
    this.cameraValues = new Array(samples);
    let camera = 0;
    for (let i = 0; i < samples; i += 1) {
      const progress = this.chartProgress(i * step);
      const time = this.timeAt(progress);
      const startTime = time - this.timeWindow * 0.78;
      let peak = Math.max(this.valueAtTime(startTime).marketCapUsd, this.valueAtStory(progress).marketCapUsd);
      for (const point of this.plotPoints) {
        if (point.ts >= startTime && point.ts <= time
          && (!this.fillOnly || this.eventProgress(point.tradeIndex) <= progress)) {
          const value = this.capMode ? point.marketCapUsd : point.priceUsd;
          if (Number.isFinite(value)) peak = Math.max(peak, value);
        }
      }
      const target = Math.max(peak * 1.35, this.capMode ? 1 : 1e-12);
      camera = i === 0 ? target : camera + (target - camera) * (target > camera ? riseRate : fallRate);
      camera = Math.max(camera, peak * 1.12);
      this.cameraValues[i] = camera;
    }
  }

  cameraAt(progress) {
    if (!this.cameraValues.length) return this.yMax;
    const p = this.chartProgress(progress);
    const index = p * (this.cameraValues.length - 1);
    const before = Math.floor(index);
    const after = Math.min(before + 1, this.cameraValues.length - 1);
    const smooth = this.cameraValues[before] + (this.cameraValues[after] - this.cameraValues[before]) * (index - before);
    return Math.max(smooth, this.valueAtStory(p).marketCapUsd * 1.12, this.capMode ? 1 : 1e-12);
  }

  yAtCap(cap, cameraMax = this.yMax) {
    const top = 272;
    const bottom = 651;
    return bottom - finite(cap) / Math.max(1e-12, cameraMax) * (bottom - top);
  }

  viewportAt(progress) {
    const p = this.chartProgress(progress);
    const time = this.timeAt(p);
    return { time, startTime: time - this.timeWindow * 0.78, endTime: time + this.timeWindow * 0.22,
      spanTime: this.timeWindow, yMin: 0, yMax: this.cameraAt(p) };
  }

  layoutMarkers() {
    this.markerPlacements = this.trades.map((trade, index) => ({
      index,
      ts: trade.ts,
      q: this.eventProgress(index),
      cap: this.fillOnly ? this.capMode ? trade.marketCapUsd : trade.priceUsd : this.valueAtTime(trade.ts).marketCapUsd,
    }));
  }

  layoutTooltips() {
    this.tooltipRects = this.trades.map((trade, index) => {
      const progress = this.eventProgress(index);
      const anchor = this.markerPosition(index, progress);
      const viewport = this.viewportAt(progress);
      const bubbles = this.markerPlacements.slice(0, index + 1)
        .map(marker => this.markerPosition(marker.index, progress)).filter(marker => marker?.visible);
      const linePoints = this.visibleLine(progress, viewport);
      return this.chooseTooltip(anchor?.x ?? 644, anchor?.y ?? 470, bubbles, linePoints);
    });
  }

  timeAt(progress) {
    const p = this.chartProgress(progress);
    if (!this.trades.length) return this.timelineStart + p * (this.timelineEnd - this.timelineStart);
    if (this.trades.length === 1 || p >= this.eventPhase) return this.tradeEnd;
    for (let i = 0; i < this.timeKnots.length - 1; i += 1) {
      const a = this.timeKnots[i];
      const b = this.timeKnots[i + 1];
      if (p <= b.q) {
        const span = b.q - a.q;
        return hermite(a.ts, b.ts, this.timeTangents[i], this.timeTangents[i + 1], (p - a.q) / span, span);
      }
    }
    return this.tradeEnd;
  }

  valueAtStory(progress) {
    if (!this.fillOnly) return this.valueAtTime(this.timeAt(progress));
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
    // Distinct timestamps keep a fixed, time-proportional connecting segment.
    // Same-second executions have one X coordinate, while their actual recorded
    // values can be revealed in order along that vertical segment.
    const fraction = b.ts > a.ts
      ? clamp((this.timeAt(progress) - a.ts) / (b.ts - a.ts), 0, 1)
      : (progress - a.q) / span;
    return { priceUsd: a.priceUsd + (b.priceUsd - a.priceUsd) * fraction, marketCapUsd: a.marketCapUsd + (b.marketCapUsd - a.marketCapUsd) * fraction };
  }

  valueAtTime(time) {
    const points = this.plotPoints;
    const quote = point => ({ priceUsd: point.priceUsd, marketCapUsd: this.capMode ? point.marketCapUsd : point.priceUsd });
    if (!points.length) return { priceUsd: 0, marketCapUsd: 0 };
    if (time < points[0].ts) return quote(points[0]);
    if (time >= points.at(-1).ts) return quote(points.at(-1));
    let lo = 0, hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].ts <= time) lo = mid + 1; else hi = mid;
    }
    const a = points[Math.max(0, lo - 1)];
    const b = points[lo];
    const fraction = (time - a.ts) / (b.ts - a.ts);
    const before = quote(a), after = quote(b);
    // Straight interpolation is bounded by actual samples. Rounded line joins
    // soften the drawing, without inventing extrema or rebuilding past curves.
    return { priceUsd: before.priceUsd + (after.priceUsd - before.priceUsd) * fraction,
      marketCapUsd: before.marketCapUsd + (after.marketCapUsd - before.marketCapUsd) * fraction };
  }

  visibleLine(progress, viewport = this.viewportAt(progress)) {
    const p = this.chartProgress(progress);
    const points = this.plotPoints.filter(point => point.ts <= viewport.time
      && (!this.fillOnly || this.eventProgress(point.tradeIndex) <= p));
    const firstVisible = points.findIndex(point => point.ts >= viewport.startTime);
    const startIndex = firstVisible > 0 ? firstVisible - 1 : firstVisible < 0 ? Math.max(0, points.length - 1) : 0;
    const visible = points.slice(startIndex).map(point => ({ ts: point.ts,
      cap: this.capMode ? point.marketCapUsd : point.priceUsd }));
    const current = this.valueAtStory(p);
    if (current.marketCapUsd > 0 && (!visible.length || visible.at(-1).ts !== viewport.time || visible.at(-1).cap !== current.marketCapUsd)) {
      visible.push({ ts: viewport.time, cap: current.marketCapUsd });
    }
    return visible.map(point => ({ ...point, x: 42 + (point.ts - viewport.startTime) / viewport.spanTime * 772,
      y: this.yAtCap(point.cap, viewport.yMax) }));
  }

  markerPosition(index, progress) {
    const marker = this.markerPlacements[index];
    if (!marker) return null;
    const viewport = this.viewportAt(progress);
    const trade = this.trades[index];
    const marketValue = marker.cap;
    if (!Number.isFinite(marketValue) || marketValue <= 0) return null;
    const x = 42 + (marker.ts - viewport.startTime) / viewport.spanTime * 772;
    const y = this.yAtCap(marketValue, viewport.yMax);
    const p = this.chartProgress(progress);
    return { index, ts: marker.ts, q: marker.q, x, y, marketValue,
      executionValue: this.capMode ? trade.marketCapUsd : trade.priceUsd,
      visible: marker.q <= p + 1e-9 && x >= 42 && x <= 814 && y >= 272 && y <= 651,
      alpha: index === 0 ? 1 : clamp((clamp(finite(progress), 0, 1) - marker.q) * DURATION / 0.12, 0, 1) };
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
    text(ctx, 'UTC TIMES · PACED REPLAY · GAS EXCLUDED', 540, 1188, `600 17px ${FONT}`, '#332909', 'center');
    this.drawFooter(ctx);
  }

  drawHeader(ctx, state) {
    const kolName = shortName(this.data.kol.name || this.data.kol.address || 'Trader', 26);
    const tokenName = shortName(this.data.token.symbol || this.data.token.name || 'TOKEN', 14);
    imageCircle(ctx, this.avatar, 114, 112, 67, initials(kolName), '#a97f0e');
    text(ctx, kolName, 215, 99, fitFont(ctx, kolName, 520, 55, 34, 650), COLOR.white);
    const subtitle = `${tokenName.toUpperCase()}  /  BNB CHAIN`;
    text(ctx, subtitle, 218, 149, `700 22px ${FONT}`, COLOR.muted);
    const date = dateLabel(new Date(this.timelineEnd));
    text(ctx, date, 1018, 85, `500 32px ${FONT}`, '#8b877d', 'right');

    const status = state.status === 'Unknown' ? 'RECORDED TRADES' : state.status.toUpperCase();
    const statusFill = state.status === 'Open' ? '#3b3214' : state.status === 'Closed' || state.status === 'Unknown' ? '#272721' : '#312820';
    const statusText = state.status === 'Open' ? COLOR.goldBright : '#c4bda7';
    ctx.font = `750 25px ${FONT}`;
    const pillWidth = ctx.measureText(status).width + 33;
    fillRound(ctx, 215, 165, pillWidth, 43, 11, statusFill);
    text(ctx, status, 215 + pillWidth / 2, 188, `750 25px ${FONT}`, statusText, 'center', 'middle');
    if (this.brandIcon?.naturalWidth > 0) {
      try {
        ctx.drawImage(this.brandIcon, 962, 116, 56, 56);
      } catch {
        text(ctx, 'b/', 1018, 163, `800 36px ${FONT}`, COLOR.gold, 'right');
      }
    } else {
      text(ctx, 'b/', 1018, 163, `800 36px ${FONT}`, COLOR.gold, 'right');
    }
  }

  drawChart(ctx, progress, state) {
    const chartProgress = this.chartProgress(progress);
    const viewport = this.viewportAt(chartProgress);
    const cameraMax = viewport.yMax;
    const left = 42;
    const right = 814;
    const top = 272;
    const bottom = 651;
    const hasQuote = Number.isFinite(state.currentCap) && state.currentCap > 0 && this.storyVertices.length > 0;
    const currentY = this.yAtCap(state.currentCap, cameraMax);
    const pathPoints = this.visibleLine(chartProgress, viewport);

    ctx.save();
    roundedRect(ctx, 27, 235, 1018, 475, 20);
    ctx.clip();
    const provenance = this.fillOnly ? 'FILL PRICES ONLY · LINE CONNECTS EXECUTIONS'
      : 'MARKET LINE · B/S AT RECORDED TRADE TIMES';
    text(ctx, provenance, 48, 255, `650 18px ${FONT}`, '#928b74');

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
      // The visible path ends at the same quote used by the badge and markers.
      // Project all geometry first, then clip the drawing as one chart layer.
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top - 12, right - left, bottom - top + 24);
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
      ctx.shadowColor = 'rgba(240,185,11,0.24)';
      ctx.shadowBlur = 5;
      this.traceLine(ctx, pathPoints);
      ctx.strokeStyle = COLOR.gold;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
      if (this.fillOnly) {
        for (const point of pathPoints) {
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
    } else {
      text(ctx, 'Execution prices unavailable', 428, 470, `550 28px ${FONT}`, COLOR.muted, 'center');
    }

    this.drawTradeMarkers(ctx, progress, state);
    ctx.restore();

    const capText = hasQuote ? this.capMode ? money(state.currentCap, 0, true) : this.priceText(state.currentCap) : '—';
    const badgeY = hasQuote ? currentY : (top + bottom) / 2;
    fillRound(ctx, 844, badgeY - 29, 188, 58, 14, COLOR.gold, 'rgba(255,221,97,0.65)', 2);
    text(ctx, capText, 938, badgeY + 1, fitFont(ctx, capText, 170, 33, 25, 750), '#18150b', 'center', 'middle');
    text(ctx, this.capMode ? 'EST. FDV' : 'USD PRICE', 939, badgeY + 62, `550 21px ${FONT}`, COLOR.dim, 'center');
    for (const fraction of [0.25, 0.75]) {
      const y = top + (bottom - top) * fraction;
      if (Math.abs(y - badgeY) < 70) continue;
      const value = cameraMax * (1 - fraction);
      text(ctx, this.capMode ? money(value, 0, true) : this.priceText(value), 1028, y + 7, `500 22px ${FONT}`, COLOR.dim, 'right');
    }

    const spanTime = viewport.spanTime;
    const axisTicks = [0, 1, 2].map((i) => {
      const x = 130 + i * 315;
      return { x, ts: viewport.startTime + (x - left) / (right - left) * viewport.spanTime };
    });
    let axisLabels = axisTicks.map(({ ts }) => axisLabel(ts, spanTime));
    if (new Set(axisLabels).size < axisLabels.length && spanTime < 2 * 24 * 60 * MINUTE) {
      axisLabels = axisTicks.map(({ ts }) => axisLabel(ts, spanTime, true));
    }
    const drawnLabels = new Set();
    axisTicks.forEach(({ x }, i) => {
      const label = axisLabels[i];
      if (drawnLabels.has(label)) return;
      text(ctx, label, x, 698, `500 26px ${FONT}`, '#8c8676', 'center');
      drawnLabels.add(label);
    });

    const active = this.trades[state.currentEventIndex];
    if (active) {
      const tooltipRect = this.tooltipRects[state.currentEventIndex];
      const elapsed = (chartProgress - this.eventProgress(state.currentEventIndex)) * DURATION;
      const next = this.eventProgress(state.currentEventIndex + 1);
      const isLast = state.currentEventIndex === this.trades.length - 1;
      const remaining = next > chartProgress ? (next - chartProgress) * DURATION : 2;
      const opacity = isLast ? 1 : Math.min(1, Math.max(0, (1.4 - elapsed) / 0.24), Math.max(0, remaining / 0.12));
      if (opacity > 0) this.drawTradeTooltip(ctx, active, tooltipRect, opacity);
    }
  }

  traceLine(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) {
      ctx.lineTo(points[0].x + 1, points[0].y);
      return;
    }
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  }

  drawTradeMarkers(ctx, progress, state) {
    const markers = [];
    for (const marker of this.markerPlacements) {
      if (marker.index > state.currentEventIndex) continue;
      const trade = this.trades[marker.index];
      const position = this.markerPosition(marker.index, progress);
      if (!position?.visible) continue;
      // Keep timestamp and quote anchors untouched. Coincident fills may share
      // a circle; they never gain fake time by being pushed sideways.
      if (position.alpha === 0) continue;
      const coincident = markers.find(existing => existing.ts === marker.ts
        && Math.abs(existing.y - position.y) < 0.01);
      if (coincident) {
        if (trade.side === 'buy') coincident.buys += 1; else coincident.sells += 1;
        coincident.alpha = Math.max(coincident.alpha, position.alpha);
        coincident.mixed = coincident.buys > 0 && coincident.sells > 0;
        const buyText = `B${coincident.buys > 1 ? coincident.buys : ''}`;
        const sellText = `S${coincident.sells > 1 ? coincident.sells : ''}`;
        coincident.letter = coincident.mixed ? `${buyText}/${sellText}` : coincident.buys ? buyText : sellText;
        continue;
      }
      markers.push({
        ...position, side: trade.side, mixed: false,
        buys: trade.side === 'buy' ? 1 : 0, sells: trade.side === 'sell' ? 1 : 0,
        color: trade.side === 'buy' ? COLOR.green : COLOR.red,
        letter: trade.side === 'buy' ? 'B' : 'S',
      });
    }
    for (const marker of markers) {
      ctx.save();
      ctx.globalAlpha = marker.alpha;
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, this.markerRadius, 0, Math.PI * 2);
      ctx.fillStyle = marker.mixed ? COLOR.green : marker.color;
      ctx.fill();
      if (marker.mixed) {
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, this.markerRadius, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(marker.x, marker.y - this.markerRadius);
        ctx.closePath();
        ctx.fillStyle = COLOR.red;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, this.markerRadius, 0, Math.PI * 2);
      }
      ctx.strokeStyle = COLOR.dark;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
    for (const marker of markers) {
      ctx.save();
      ctx.globalAlpha = marker.alpha;
      text(ctx, marker.letter, marker.x, marker.y + 1,
        marker.mixed ? fitFont(ctx, marker.letter, 35, 13, 8, 800) : `800 ${marker.letter.length > 1 ? 15 : 19}px ${FONT}`,
        '#15120a', 'center', 'middle');
      ctx.restore();
    }
    return markers;
  }

  chooseTooltip(anchorX, anchorY, bubbles, linePoints) {
    const width = 346;
    const height = 92;
    const candidates = [];
    for (const y of [258, 348, 450, 548]) {
      for (const x of [62, 230, 458]) candidates.push({ x, y, width, height });
    }
    let best = candidates[0];
    let bestScore = Infinity;
    for (const rect of candidates) {
      const bubblePenalty = bubbles.reduce((total, bubble) => {
        const dx = Math.max(rect.x - bubble.x, 0, bubble.x - (rect.x + rect.width));
        const dy = Math.max(rect.y - bubble.y, 0, bubble.y - (rect.y + rect.height));
        return total + (Math.hypot(dx, dy) < this.markerRadius + 16 ? 10_000 : 0);
      }, 0);
      const linePenalty = linePoints.filter((point) =>
        point.x >= rect.x - 8 && point.x <= rect.x + rect.width + 8
        && point.y >= rect.y - 8 && point.y <= rect.y + rect.height + 8).length * 12;
      const near = Math.hypot(anchorX - (rect.x + width / 2), anchorY - (rect.y + height / 2));
      const score = bubblePenalty + linePenalty + near * 0.08;
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
    const amount = trade.amountUsd > 0 ? money(trade.amountUsd, 2, trade.amountUsd >= 1000) : '—';
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
    text(ctx, result, 75, 956, fitFont(ctx, result, 660, 76, 35, 720), pnlColor);

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
      { center: 540, label: 'Avg. entry FDV', value: this.capMode && state.avgEntryCap > 0 ? money(state.avgEntryCap, 0, true) : '—' },
      { center: 881, label: this.capMode ? 'Sample FDV' : 'Sample price', value: state.currentCap > 0 ? this.capMode ? money(state.currentCap, 0, true) : this.priceText(state.currentCap) : '—' },
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
        // Crop away the SVG's gold icon, then tint only its exact wordmark path
        // black for contrast against the solid gold canvas frame.
        ctx.filter = 'brightness(0)';
        ctx.drawImage(this.brandWordmark, 410, 60, 770, 225, 49, 1214, 375, 110);
        ctx.restore();
        return;
      } catch {
        ctx.restore();
      }
    }
    text(ctx, 'bscan', 49, 1293, `850 76px ${FONT}`, '#0c0e11');
  }
}

export default ReplayCanvas;
