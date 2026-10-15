import { tokenReplaySnapshot, type TokenReplayData } from './tokenReplayData';
import type { ReplayRecordingCanvas } from './tradeReplayExport';

const FONT = 'Manrope, sans-serif';
const colors = { gold: '#f0b90b', dark: '#0c0e11', white: '#f8f6ee', muted: '#a9a69a', green: '#16c784', red: '#f6465d' };
function money(value: number) {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
const date = (time: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(time);

async function image(raw: string | null, signal: AbortSignal, bundled = false): Promise<HTMLImageElement | null> {
  if (!raw || typeof Image === 'undefined' || signal.aborted) return null;
  let url: URL;
  try {
    url = new URL(raw, location.href);
    const compiledSvg = bundled && raw.startsWith('data:image/svg+xml');
    if (!compiledSvg && (url.origin !== location.origin || !/^https?:$/.test(url.protocol))) return null;
  }
  catch { return null; }
  return new Promise(resolve => {
    const img = new Image();
    const finish = (result: HTMLImageElement | null) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); img.onload = null; img.onerror = null; resolve(result);
    };
    const abort = () => finish(null), timer = setTimeout(abort, 2500);
    signal.addEventListener('abort', abort, { once: true });
    img.onload = () => finish(img); img.onerror = abort; img.src = url.href;
  });
}

/** Independent token renderer: market observations and change, without wallet or PNL assumptions. */
export default class TokenReplayCanvas implements ReplayRecordingCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private logo: HTMLImageElement | null = null;
  private icon: HTMLImageElement | null = null;
  private wordmark: HTMLImageElement | null = null;
  constructor(canvas: HTMLCanvasElement, readonly data: TokenReplayData) {
    this.canvas = canvas; canvas.width = 1080; canvas.height = 1350;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
  }
  async loadImages(signal: AbortSignal) {
    [this.logo, this.icon, this.wordmark] = await Promise.all([
      image(this.data.token.logoUrl, signal), image(new URL('./tradeReplayIcon.svg', import.meta.url).href, signal, true),
      image(new URL('./tradeReplayWordmark.svg', import.meta.url).href, signal, true),
    ]);
    if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
  }
  getDuration() { return 15.5; }
  private text(value: string, x: number, y: number, size: number, color = colors.white, weight = 600, align: CanvasTextAlign = 'left', maxWidth?: number) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${FONT}`;
    if (maxWidth) {
      while (size > 22 && ctx.measureText(value).width > maxWidth) ctx.font = `${weight} ${--size}px ${FONT}`;
      while (value.length > 1 && ctx.measureText(value).width > maxWidth) value = value.slice(0, -2) + '…';
    }
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(value, x, y);
  }
  private panel(x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string) {
    const ctx = this.ctx; ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
  }
  render(progress: number) {
    const ctx = this.ctx, data = this.data, state = tokenReplaySnapshot(data, progress);
    const positive = state.changePercent >= 0, color = positive ? colors.green : colors.red;
    const first = data.points[0], last = data.points.at(-1)!;
    ctx.clearRect(0, 0, 1080, 1350); ctx.fillStyle = colors.gold; ctx.fillRect(0, 0, 1080, 1350);
    this.panel(12, 13, 1056, 1154, 60, colors.dark);
    // Token identity, chain and exact observed endpoint stay on the exported card.
    ctx.save(); ctx.beginPath(); ctx.arc(108, 107, 62, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#302a15'; ctx.fillRect(46, 45, 124, 124);
    if (this.logo) ctx.drawImage(this.logo, 46, 45, 124, 124);
    else this.text(Array.from(data.token.symbol || 'T').slice(0, 2).join(''), 108, 107, 45, colors.gold, 800, 'center');
    ctx.restore();
    this.text(data.token.symbol || data.token.name || 'Token', 198, 80, 50, colors.white, 750, 'left', 590);
    this.text('BNB CHAIN', 198, 135, 23, colors.muted, 600);
    this.text(`${data.token.address.slice(0, 8)}…${data.token.address.slice(-6)}`, 198, 176, 22, colors.muted, 500);
    if (this.icon) ctx.drawImage(this.icon, 973, 62, 45, 45);
    this.panel(48, 232, 235, 45, 10, '#3b3214');
    this.text(`${data.period} TOKEN REPLAY`, 165, 255, 23, '#ffd44b', 750, 'center');
    this.text('MARKET CAP', 53, 322, 24, colors.muted, 600);
    this.text(money(state.marketCap), 48, 399, 83, colors.white, 800, 'left', 620);
    this.text(`${positive ? '▲' : '▼'} ${Math.abs(state.changePercent).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`, 1018, 405, 39, color, 750, 'right', 360);

    const plot = { left: 55, right: 1018, top: 510, bottom: 825 };
    const values = data.points.map(point => point.marketCap), min = Math.min(...values), max = Math.max(...values);
    const padding = Math.max((max - min) * .18, max * .025, .0001), lower = Math.max(0, min - padding), upper = max + padding;
    const x = (time: number) => plot.left + (time - first.time) / (last.time - first.time) * (plot.right - plot.left);
    const y = (cap: number) => plot.bottom - (cap - lower) / (upper - lower) * (plot.bottom - plot.top);
    for (let row = 0; row <= 3; row++) {
      ctx.strokeStyle = '#a9a69a12'; ctx.lineWidth = 1; ctx.setLineDash([2, 9]); ctx.beginPath();
      ctx.moveTo(plot.left, plot.top + row * (plot.bottom - plot.top) / 3); ctx.lineTo(plot.right, plot.top + row * (plot.bottom - plot.top) / 3); ctx.stroke();
    }
    ctx.setLineDash([]);
    const shown = data.points.slice(0, state.index + 1);
    if (!state.inGap && state.time > shown.at(-1)!.time) shown.push({ time: state.time, marketCap: state.marketCap });
    // Paint each contiguous section independently; holes remain visibly dashed.
    let section: typeof shown = [];
    const paintSection = () => {
      if (!section.length) return;
      ctx.beginPath(); ctx.moveTo(x(section[0].time), y(section[0].marketCap));
      for (const point of section.slice(1)) ctx.lineTo(x(point.time), y(point.marketCap));
      ctx.lineWidth = 7; ctx.strokeStyle = color; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.shadowColor = color + '66'; ctx.shadowBlur = 17; ctx.stroke(); ctx.shadowBlur = 0;
      ctx.lineTo(x(section.at(-1)!.time), plot.bottom); ctx.lineTo(x(section[0].time), plot.bottom); ctx.closePath();
      const gradient = ctx.createLinearGradient(0, plot.top, 0, plot.bottom); gradient.addColorStop(0, color + '35'); gradient.addColorStop(1, color + '00');
      ctx.fillStyle = gradient; ctx.fill();
    };
    for (const point of shown) {
      const previous = section.at(-1);
      if (previous && point.time - previous.time > data.resolutionMs * 2) {
        paintSection(); ctx.beginPath(); ctx.setLineDash([7, 10]); ctx.moveTo(x(previous.time), y(previous.marketCap)); ctx.lineTo(x(point.time), y(point.marketCap));
        ctx.lineWidth = 2; ctx.strokeStyle = colors.muted + '55'; ctx.stroke(); ctx.setLineDash([]); section = [];
      }
      section.push(point);
    }
    paintSection();
    const activeX = x(state.inGap ? data.points[state.index].time : state.time), activeY = y(state.marketCap);
    ctx.beginPath(); ctx.arc(activeX, activeY, 7, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    this.text(date(first.time), plot.left, 875, 23, colors.muted, 500);
    this.text(date(state.inGap ? data.points[state.index].time : state.time), plot.right, 875, 23, colors.muted, 500, 'right');
    this.text(`${data.partialHistory ? 'AVAILABLE HISTORY' : data.period.toUpperCase()}${data.sparseHistory ? ' · GAPS IN HISTORY' : ''} · UTC`, 53, 920, 19, colors.muted, 500);

    this.panel(28, 962, 1024, 184, 30, '#151513', '#35332b');
    const cells = [{ label: 'Start MCAP', value: first.marketCap }, { label: 'Peak MCAP', value: state.peak }, { label: 'End MCAP', value: state.marketCap }];
    cells.forEach((cell, index) => {
      const center = 28 + (index + .5) * 1024 / 3;
      this.text(cell.label, center, 1015, 25, colors.muted, 500, 'center');
      this.text(money(cell.value), center, 1076, 38, colors.white, 750, 'center', 300);
      if (index) { ctx.beginPath(); ctx.moveTo(28 + index * 1024 / 3, 982); ctx.lineTo(28 + index * 1024 / 3, 1125); ctx.lineWidth = 2; ctx.strokeStyle = '#35332b'; ctx.stroke(); }
    });
    if (this.wordmark) {
      const height = 68, width = this.wordmark.naturalWidth / this.wordmark.naturalHeight * height;
      ctx.save(); ctx.filter = 'brightness(0)'; ctx.drawImage(this.wordmark, 49, 1220, width, height); ctx.restore();
    } else this.text('Kollens', 49, 1255, 75, '#0c0e11', 800);
    this.text('kollens.com', 1031, 1254, 30, '#0c0e11', 650, 'right');
  }
}
