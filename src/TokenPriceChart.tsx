import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { CandleInterval, MarketCandle } from '../shared/intelligence';
import { getLocale, t } from './i18n';
import { compact } from './lib';
import { marketCapCandles } from './tokenChartData';
import { useTokenChart } from './useTokenChart';

export function TokenPriceChart({ address, interval }: { address: string; interval: CandleInterval }) {
  const { chart: data, error } = useTokenChart(address, interval);
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const candleLookup = useRef(new Map<number, MarketCandle>());
  const fitted = useRef<string | null>(null);
  const [hover, setHover] = useState<MarketCandle | null>(null);
  const marketCandles = marketCapCandles(data?.candles ?? [], data?.marketCapSupply);
  const last = hover ?? marketCandles.at(-1);
  const status = error ? 'Market chart unavailable' : !data ? 'Loading candles…'
    : data.candles.length && !marketCandles.length ? 'Market cap data unavailable'
    : data.loadStatus === 'rate_limited' ? 'Market provider cooling down. Retrying automatically…'
    : data.loadStatus === 'provider_error' ? 'Market provider unavailable. Retrying automatically…'
    : data.loadStatus === 'queued' ? 'Waiting for market data…'
    : data.pending ? 'Loading candles…' : 'Candle data unavailable';

  useEffect(() => {
    if (!container.current) return;
    fitted.current = null;
    candleLookup.current.clear();
    const instance = createChart(container.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0b0e11' }, textColor: '#879299', fontFamily: 'Manrope, sans-serif', fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: '#1b222680' }, horzLines: { color: '#1b222680' } },
      rightPriceScale: { borderColor: '#252d31', scaleMargins: { top: .12, bottom: .08 } },
      timeScale: { borderColor: '#252d31', timeVisible: interval !== '1d', secondsVisible: false, rightOffset: 3, minBarSpacing: .5 },
      localization: { priceFormatter: (value: number) => compact(value, true), locale: getLocale() },
      crosshair: { mode: 0, vertLine: { color: '#69747a' }, horzLine: { color: '#69747a' } },
    });
    chart.current = instance;
    setHover(null);
    candles.current = instance.addSeries(CandlestickSeries, {
      upColor: '#39cb8f', downColor: '#f1767a', borderVisible: false, wickUpColor: '#39cb8f', wickDownColor: '#f1767a',
      priceFormat: { type: 'custom', minMove: .01, formatter: (value: number) => compact(value, true) },
    });
    volume.current = instance.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, 1);
    instance.panes()[1].setHeight(65);
    instance.subscribeCrosshairMove(event => setHover(typeof event.time === 'number' ? candleLookup.current.get(event.time) ?? null : null));
    return () => { instance.remove(); chart.current = null; candles.current = null; volume.current = null; };
  }, [address, interval]);

  useEffect(() => {
    if (!chart.current || !candles.current || !volume.current) return;
    candleLookup.current = new Map(marketCandles.map(c => [c.time, c]));
    candles.current.setData(marketCandles.map(c => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    volume.current.setData(marketCandles.map(c => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? '#39cb8f70' : '#f1767a70' })));
    const history = data?.partialHistory ? 'partial' : 'full';
    if (fitted.current !== history && marketCandles.length) {
      const end = marketCandles.length - 1;
      chart.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, end - 149), to: end + 3 });
      fitted.current = history;
    }
  }, [data, address, interval]);

  return <div className="token-price-chart">
    <div className="price-chart-legend" aria-live="off" title={t('Calculated using current token supply')}>
      {last ? <><span>{t('Market cap')} <b>{compact(last.close, true)}</b></span><span>O <b>{compact(last.open, true)}</b></span><span>H <b>{compact(last.high, true)}</b></span><span>L <b>{compact(last.low, true)}</b></span><span>C <b>{compact(last.close, true)}</b></span><span>{t('Volume')} <b>{compact(last.volume, true)}</b></span></> : <span>{t('Market cap')} —</span>}
      {data?.stale && <span>{t('Cached')}</span>}
      {hover && <span>{new Date(hover.time * 1000).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</span>}
    </div>
    <div className="price-chart-canvas" ref={container} role="img" aria-label={`${t('Token market cap chart')}: ${marketCandles.length} ${t('candles')}`} />
    {!marketCandles.length && <div className="price-chart-status">{t(status)} <a href={`https://gmgn.ai/bsc/token/${address}`} target="_blank" rel="noopener noreferrer">{t('Open live chart')}</a></div>}
    <div className="price-chart-footer"><span>{marketCandles.length ? `${marketCandles.length} ${t('candles')} · UTC` : t(status)}{data?.partialHistory && marketCandles.length > 0 && ` · ${t('Limited history')}`}{error && marketCandles.length ? ` · ${t('Refresh paused')}` : ''}</span><span>{data?.source === 'geckoterminal' && <a href={`https://www.geckoterminal.com/bsc/pools/${data.poolAddress}`} target="_blank" rel="noopener noreferrer">GeckoTerminal</a>}<a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a></span></div>
  </div>;
}
