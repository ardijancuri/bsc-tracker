import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import type { CandleInterval, TokenChart } from '../shared/intelligence';
import { getLocale, t } from './i18n';
import { compact } from './lib';
import { areaChartPaths, constrainChartWindow, fullChartWindow, intervalSeconds, marketCapAxis, marketCapLinePoints, nearestAreaPoint, type ChartWindow } from './tokenAreaChartData';
import './tokenAreaChart.css';

export function TokenAreaChart({ address, interval, data, error }: { address: string; interval: CandleInterval; data: TokenChart | null; error: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; window: ChartWindow } | null>(null);
  const [width, setWidth] = useState(960);
  const [window, setWindow] = useState<ChartWindow | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const id = useId().replace(/:/g, '');
  const points = useMemo(() => marketCapLinePoints(data?.candles ?? [], data?.marketCapSupply), [data]);
  const full = fullChartWindow(points, interval);
  const visibleWindow = window ? constrainChartWindow(window, full, intervalSeconds[interval] * 8) : full;
  const visible = points.filter(point => point.time >= visibleWindow.from && point.time <= visibleWindow.to);
  const axis = marketCapAxis(visible);
  const height = width < 600 ? 330 : 410;
  const plot = { left: 8, right: Math.max(160, width - 76), top: 16, bottom: height - 32 };
  const x = (time: number) => plot.left + (time - visibleWindow.from) / (visibleWindow.to - visibleWindow.from) * (plot.right - plot.left);
  const y = (value: number) => plot.bottom - (value - axis.min) / (axis.max - axis.min) * (plot.bottom - plot.top);
  const paths = areaChartPaths(visible, x, y, plot.bottom);
  const hover = hoverTime === null ? null : nearestAreaPoint(visible, hoverTime);
  const current = hover ?? points.at(-1);
  const tickCount = width < 600 ? 3 : 5;
  const timeTicks = Array.from({ length: tickCount }, (_, index) => visibleWindow.from + index / (tickCount - 1) * (visibleWindow.to - visibleWindow.from));
  const timeFormat = (time: number, detail = false) => new Date(time * 1000).toLocaleString(getLocale(), {
    timeZone: 'UTC', ...(detail || visibleWindow.to - visibleWindow.from >= 86400 * 2 ? { month: 'short', day: 'numeric' } : {}),
    ...(detail || visibleWindow.to - visibleWindow.from < 86400 * 2 ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
  const sourceLabels: Record<string, string> = { geckoterminal: 'GeckoTerminal', coingecko: 'CoinGecko', gmgn: 'GMGN', coinmarketcap: 'CoinMarketCap' };
  const status = !data ? error ? 'Market chart unavailable' : 'Loading market chart…'
    : data.candles.length && !points.length && (data.supplyPending || data.pending) ? 'Loading market cap…'
    : data.candles.length && !points.length ? 'Market cap data unavailable'
    : data.loadStatus === 'rate_limited' ? 'Market provider cooling down. Retrying automatically…'
    : data.loadStatus === 'provider_error' ? 'Market provider unavailable. Retrying automatically…'
    : data.loadStatus === 'queued' ? 'Waiting for market data…'
    : data.pending ? 'Loading market chart…' : 'Market chart unavailable';

  useEffect(() => { setWindow(null); setHoverTime(null); drag.current = null; }, [address, interval]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(Math.max(240, next));
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  const eventX = (event: PointerEvent<SVGSVGElement>) => (event.clientX - event.currentTarget.getBoundingClientRect().left) / event.currentTarget.getBoundingClientRect().width * width;
  const zoom = (factor: number) => {
    const span = (visibleWindow.to - visibleWindow.from) * factor;
    const middle = (visibleWindow.from + visibleWindow.to) / 2;
    setWindow(constrainChartWindow({ from: middle - span / 2, to: middle + span / 2 }, full, intervalSeconds[interval] * 8));
    setHoverTime(null);
  };
  const reset = () => { setWindow(null); setHoverTime(null); };
  const pointInView = points.at(-1) && visible.at(-1)?.time === points.at(-1)?.time ? points.at(-1) : null;

  return <div className="token-area-chart" ref={host}>
    <div className="token-area-chart-meta">
      <div className="token-area-chart-values" aria-live="off"><span>{t('Market cap')} <b>{current ? compact(current.value, true) : '—'}</b></span>{data?.volumeCurrency !== 'unknown' && <span>{t('Volume')} <b>{current ? compact(current.volume, true) : '—'}</b></span>}{data?.stale && <span className="token-area-chart-cached">{t('Cached')}</span>}</div>
      <div className="token-area-chart-actions"><button type="button" onClick={() => zoom(.5)} disabled={points.length < 10 || visibleWindow.to - visibleWindow.from <= intervalSeconds[interval] * 8} aria-label={t('Zoom in')} title={t('Zoom in')}><Plus size={14} /></button><button type="button" onClick={() => zoom(2)} disabled={!window} aria-label={t('Zoom out')} title={t('Zoom out')}><Minus size={14} /></button><button type="button" onClick={reset} disabled={!window} aria-label={t('Reset view')} title={t('Reset view')}><RotateCcw size={13} /></button></div>
    </div>
    <div className="token-area-chart-stage" style={{ height }}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${t('Token market cap chart')}: ${points.length} ${t('market samples')}`} tabIndex={points.length ? 0 : undefined}
        onPointerMove={event => {
          const pixel = eventX(event);
          if (drag.current) {
            const shift = (drag.current.x - pixel) / (plot.right - plot.left) * (drag.current.window.to - drag.current.window.from);
            const next = constrainChartWindow({ from: drag.current.window.from + shift, to: drag.current.window.to + shift }, full, intervalSeconds[interval] * 8);
            setWindow(next.from === full.from && next.to === full.to ? null : next);
          } else if (pixel >= plot.left && pixel <= plot.right) setHoverTime(visibleWindow.from + (pixel - plot.left) / (plot.right - plot.left) * (visibleWindow.to - visibleWindow.from));
          else setHoverTime(null);
        }}
        onPointerDown={event => {
          if (!points.length || event.button !== 0) return;
          drag.current = { x: eventX(event), window: visibleWindow }; setHoverTime(null); event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; }} onPointerLeave={() => { if (!drag.current) setHoverTime(null); }}
        onKeyDown={event => {
          if (event.key === 'Escape') { setHoverTime(null); return; }
          if (event.key === 'Home') { event.preventDefault(); reset(); return; }
          if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(.5); return; }
          if (event.key === '-') { event.preventDefault(); zoom(2); return; }
          if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && visible.length) {
            event.preventDefault();
            const index = hover ? visible.findIndex(point => point.time === hover.time) : visible.length - 1;
            setHoverTime(visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)))].time);
          }
        }}>
        <title>{t('Token market cap chart')}</title><desc>{t('Market cap calculated from market closes and current token supply. Drag to pan. Use arrow keys to inspect, plus and minus to zoom, and Home to reset.')}</desc>
        <defs><linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#39cb8f" stopOpacity=".2" /><stop offset="100%" stopColor="#39cb8f" stopOpacity="0" /></linearGradient><clipPath id={`${id}-clip`}><rect x={plot.left} y={plot.top} width={plot.right - plot.left} height={plot.bottom - plot.top} /></clipPath></defs>
        {axis.ticks.map(value => <g key={value}><line className="token-area-chart-grid" x1={plot.left} x2={plot.right} y1={y(value)} y2={y(value)} /><text className="token-area-chart-axis" x={plot.right + 12} y={y(value)} dominantBaseline="middle">{compact(value, true)}</text></g>)}
        {points.length > 0 && timeTicks.map((time, index) => <text key={index} className="token-area-chart-axis" x={x(time)} y={height - 10} textAnchor={index === 0 ? 'start' : index === tickCount - 1 ? 'end' : 'middle'}>{timeFormat(time)}</text>)}
        <g clipPath={`url(#${id}-clip)`}><path d={paths.area} fill={`url(#${id}-area)`} /><path d={paths.line} className="token-area-chart-line" />{pointInView && !hover && <circle cx={x(pointInView.time)} cy={y(pointInView.value)} r="3" fill="#39cb8f" />}
          {hover && <g><line className="token-area-chart-crosshair" x1={x(hover.time)} x2={x(hover.time)} y1={plot.top} y2={plot.bottom} /><line className="token-area-chart-crosshair" x1={plot.left} x2={plot.right} y1={y(hover.value)} y2={y(hover.value)} /><circle cx={x(hover.time)} cy={y(hover.value)} r="4" fill="#39cb8f" stroke="#0b0e11" strokeWidth="2" /></g>}</g>
        {hover && <g><rect x={plot.right + 3} y={y(hover.value) - 11} width="72" height="22" rx="3" fill="#39cb8f" /><text className="token-area-chart-value" x={plot.right + 39} y={y(hover.value)} dominantBaseline="middle" textAnchor="middle">{compact(hover.value, true)}</text></g>}
      </svg>
      {!points.length && <div className="token-area-chart-status" role="status"><span>{t(status)}</span><a href={`https://gmgn.ai/bsc/token/${address}`} target="_blank" rel="noopener noreferrer">{t('Open live chart')}</a></div>}
      {points.length > 0 && !visible.length && <div className="token-area-chart-status"><span>{t('No market samples in this view')}</span><button type="button" onClick={reset}>{t('Reset view')}</button></div>}
    </div>
    <div className="token-area-chart-footer"><span>{hover ? `${timeFormat(hover.time, true)} UTC` : t('Market cap') + ' · UTC'}{data?.partialHistory && points.length > 0 && ` · ${t('Limited history')}`}{error && points.length ? ` · ${t('Refresh paused')}` : ''}</span><span>{data && sourceLabels[data.source]}</span></div>
  </div>;
}
