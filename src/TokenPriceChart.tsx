import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, HistogramSeries, LineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { MarketCandle, WatchPeriod, WatchPricePoint } from '../shared/intelligence';
import { getLocale, t } from './i18n';
import { compact } from './lib';
import { useTokenChart } from './useTokenChart';

export function chartPrice(value: number) {
  if (!Number.isFinite(value)) return '—';
  const digits = value > 0 && value < 1 ? Math.min(12, Math.max(4, -Math.floor(Math.log10(value)) + 3)) : 2;
  return `$${new Intl.NumberFormat(getLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)}`;
}
export function linePoints(points: WatchPricePoint[]) {
  const unique = new Map<number, number>();
  for (const point of points) {
    const time = Math.floor(Date.parse(point.timestamp) / 1000), value = Number(point.priceUsd);
    if (Number.isFinite(time) && Number.isFinite(value) && value > 0) unique.set(time, value);
  }
  return [...unique].sort(([a], [b]) => a - b).map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

export function TokenPriceChart({ address, period, fallbackPoints = [], priceUsd, quoteAt }: {
  address: string; period: WatchPeriod; fallbackPoints?: WatchPricePoint[]; priceUsd?: string | null; quoteAt?: string | null;
}) {
  const { chart: data, error } = useTokenChart(address, period);
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const line = useRef<ISeriesApi<'Line'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const candleLookup = useRef(new Map<number, MarketCandle>());
  const fittedSource = useRef<string | null>(null);
  const [mode, setMode] = useState<'candles' | 'line'>('candles');
  const [hover, setHover] = useState<MarketCandle | null>(null);
  const fallback = fallbackPoints.length ? fallbackPoints : Number(priceUsd) > 0 ? [{ timestamp: quoteAt || new Date().toISOString(), priceUsd: priceUsd! }] : [];
  const points = linePoints(data?.points.length ? data.points : fallback);
  const marketCandles = data?.candles ?? [];
  const source = data?.source === 'geckoterminal' ? 'Market candles' : points.length > 1 ? 'Recorded trades' : 'Latest available quote';
  const last = hover ?? marketCandles.at(-1);
  const latestPrice = last?.close ?? points.at(-1)?.value;

  useEffect(() => {
    if (!container.current) return;
    fittedSource.current = null;
    const instance = createChart(container.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0b0e11' }, textColor: '#879299', fontFamily: 'Manrope, sans-serif', fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: '#1b222680' }, horzLines: { color: '#1b222680' } },
      rightPriceScale: { borderColor: '#252d31', scaleMargins: { top: .12, bottom: .08 } },
      timeScale: { borderColor: '#252d31', timeVisible: true, secondsVisible: false, rightOffset: 3, minBarSpacing: .5 },
      localization: { priceFormatter: chartPrice, locale: getLocale() },
      crosshair: { mode: 0, vertLine: { color: '#69747a' }, horzLine: { color: '#69747a' } },
    });
    chart.current = instance;
    setHover(null);
    candles.current = instance.addSeries(CandlestickSeries, { upColor: '#39cb8f', downColor: '#f1767a', borderVisible: false, wickUpColor: '#39cb8f', wickDownColor: '#f1767a' });
    line.current = instance.addSeries(LineSeries, { color: '#39cb8f', lineWidth: 2, visible: false, crosshairMarkerVisible: true });
    volume.current = instance.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1);
    instance.panes()[1].setHeight(65);
    instance.subscribeCrosshairMove(event => setHover(typeof event.time === 'number' ? candleLookup.current.get(event.time) ?? null : null));
    return () => { instance.remove(); chart.current = null; candles.current = null; line.current = null; volume.current = null; };
  }, [address, period]);

  useEffect(() => {
    if (!chart.current || !candles.current || !line.current || !volume.current) return;
    candleLookup.current = new Map(marketCandles.map(c => [c.time, c]));
    candles.current.setData(marketCandles.map(c => ({ ...c, time: c.time as UTCTimestamp })));
    line.current.setData(points);
    const showCandles = mode === 'candles' && marketCandles.length > 0;
    candles.current.applyOptions({ visible: showCandles });
    line.current.applyOptions({ visible: !showCandles, color: points.length > 1 && points.at(-1)!.value < points[0].value ? '#f1767a' : points.length > 1 ? '#39cb8f' : '#879299' });
    volume.current.setData(marketCandles.map(c => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? '#39cb8f70' : '#f1767a70' })));
    const currentSource = marketCandles.length ? 'market' : points.length > 1 ? 'recorded' : 'quote';
    if (fittedSource.current !== currentSource && (marketCandles.length || points.length)) { chart.current.timeScale().fitContent(); fittedSource.current = currentSource; }
  }, [data, fallbackPoints, priceUsd, quoteAt, mode, address, period]);

  return <div className="token-price-chart">
    <div className="price-chart-controls"><span>{t(source)}{data?.resolution && data.source === 'geckoterminal' && <> · {data.resolution}</>}{data?.stale && <> · {t('Cached')}</>}</span>
      <div><button type="button" aria-pressed={mode === 'candles'} onClick={() => setMode('candles')}>{t('Candles')}</button><button type="button" aria-pressed={mode === 'line'} onClick={() => setMode('line')}>{t('Line')}</button><button type="button" onClick={() => chart.current?.timeScale().fitContent()}>{t('Reset')}</button></div></div>
    <div className="price-chart-legend" aria-live="off">
      {last ? <><span>O <b>{chartPrice(last.open)}</b></span><span>H <b>{chartPrice(last.high)}</b></span><span>L <b>{chartPrice(last.low)}</b></span><span>C <b>{chartPrice(last.close)}</b></span><span>{t('Volume')} <b>{compact(last.volume, true)}</b></span></> : <span>USD {latestPrice ? <b>{chartPrice(latestPrice)}</b> : '—'}</span>}
      {hover && <span>{new Date(hover.time * 1000).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</span>}
    </div>
    <div className="price-chart-canvas" ref={container} role="img" aria-label={`${t('Token price chart')}: ${marketCandles.length ? `${marketCandles.length} ${t('candles')}` : t(source)}`} />
    {!points.length && !marketCandles.length && <div className="price-chart-status">{t(error || data?.source === 'unavailable' && !data.pending ? 'Market chart unavailable' : 'Loading market chart…')} <a href={`https://gmgn.ai/bsc/token/${address}`} target="_blank" rel="noopener noreferrer">{t('Open live chart')}</a></div>}
    <div className="price-chart-footer"><span>{marketCandles.length ? `${marketCandles.length} ${t('candles')} · UTC` : t(source)}{error && points.length ? ` · ${t('Refresh paused')}` : ''}</span><span>{data?.source === 'geckoterminal' && <a href={`https://www.geckoterminal.com/bsc/pools/${data.poolAddress}`} target="_blank" rel="noopener noreferrer">GeckoTerminal</a>}<a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a></span></div>
  </div>;
}
