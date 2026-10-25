import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, HistogramSeries, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { CandleInterval, MarketCandle } from '../shared/intelligence';
import { getLocale, t } from './i18n';
import { compact } from './lib';
import { marketCapCandles } from './tokenChartData';
import { useTokenChart } from './useTokenChart';
import { tokenChartContextKey, type TokenChartRequestContext } from './privateTokenCharts';
import { kolTradeMarkers, tradeVisibleRange, type ChartTrade } from './kolTradeChartData';
import { chartPriceTickmarks, formatChartPrice, latestSubstantialSegmentStart, majorCandleGaps, readableCandleSlots, remapChartViewport, type CandleViewport } from './chartViewport';

type MarketHistoryBounds = { firstTime: number; lastTime: number; count: number };

/** Volume shares the candle pane but keeps an independent, hidden value scale. */
export function addVolumeOverlay(instance: IChartApi) {
  const histogram=instance.addSeries(HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},
    priceLineVisible:false,lastValueVisible:false});
  histogram.priceScale().applyOptions({scaleMargins:{top:.80,bottom:0}});
  return histogram;
}

export function marketHistoryViewport(candles: MarketCandle[], previous: MarketHistoryBounds | null, plotWidth = 1200, interval?: CandleInterval) {
  if (!candles.length) return null;
  if (previous) return null;
  // Short histories need empty time on both sides, rather than oversized bars.
  // Center the real candle group exactly, keeping bars around 12px wide.
  const slots = readableCandleSlots(plotWidth);
  const segmentStart = interval ? latestSubstantialSegmentStart(candles, interval) : 0;
  const segmentCount = candles.length - segmentStart;
  const span = Math.min(slots.maximum, Math.max(slots.minimum, segmentCount + 2.5));
  // Centering with blank time before this segment would bring the older bars
  // back into view. Start just before its first real bar and retain right space.
  if (segmentStart > 0 && segmentCount + 2.5 <= slots.maximum) return { from: segmentStart - .5, to: segmentStart - .5 + span };
  if (candles.length + 2.5 > slots.maximum) return { from: candles.length - 1 + 3 - span, to: candles.length - 1 + 3 };
  const center = (candles.length - 1) / 2;
  return { from: center - span / 2, to: center + span / 2 };
}

export function tradeChartViewport(candles: MarketCandle[], trades: ChartTrade[], interval: CandleInterval, plotWidth = 480) {
  // Young tokens can fit their whole candle history without widening the bars.
  if (candles.length <= readableCandleSlots(plotWidth).minimum) return marketHistoryViewport(candles, null, plotWidth);
  const focused = tradeVisibleRange(candles, trades, interval, plotWidth);
  if (focused) return focused;
  // Activity can finish after the candles. Keep that first view compact too.
  return marketHistoryViewport(candles, null, plotWidth);
}

export function tradeChartNeedsRefit(candles: MarketCandle[], previous: MarketHistoryBounds | null, selectionChanged: boolean, userAdjusted: boolean) {
  return !userAdjusted && candles.length > 0 && (!previous || selectionChanged ||
    candles.length !== previous.count || candles[0].time !== previous.firstTime || candles.at(-1)!.time !== previous.lastTime);
}

export function TokenPriceChart({ address, interval, trades, focusTrades = false, fullHistory = false, enabled = true, requestContext }: { address: string; interval: CandleInterval; trades?: ChartTrade[]; focusTrades?: boolean; fullHistory?: boolean; enabled?: boolean; requestContext?: TokenChartRequestContext }) {
  const scope = tokenChartContextKey(requestContext);
  const { chart: data, error, retry } = useTokenChart(address, interval, enabled, 'chart', fullHistory, requestContext);
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const candleLookup = useRef(new Map<number, MarketCandle>());
  const fitted = useRef<string | null>(null);
  const previousHistory = useRef<MarketHistoryBounds | null>(null);
  const previousCandles = useRef<MarketCandle[]>([]);
  const preservedViewport = useRef<CandleViewport | null>(null);
  const chartIdentity = useRef('');
  const tradeRange = useRef<{ from: number; to: number } | null>(null);
  const tradeSelection = useRef<ChartTrade[]>([]);
  const fittingFrame = useRef(0);
  const userAdjustedViewport = useRef(false);
  const [hover, setHover] = useState<MarketCandle | null>(null);
  const showVolume = data?.volumeCurrency !== 'unknown';
  const hasSupply = Number.isFinite(Number(data?.marketCapSupply)) && Number(data?.marketCapSupply) > 0;
  const marketCandles = useMemo(() => marketCapCandles(data?.candles ?? [],hasSupply?data?.marketCapSupply:'1'), [data,hasSupply]);
  const observationGaps = useMemo(() => majorCandleGaps(marketCandles, interval), [marketCandles, interval]);
  const gapDescription = observationGaps.slice(-5).map(gap => {
    const date = (time: number) => new Date(time * 1000).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    return `${date(gap.from)} – ${date(gap.to)} UTC`;
  }).join('\n');
  const last = hover ?? marketCandles.at(-1);
  const axisLabel=hasSupply?'Market cap':'Price';
  const formatPrice=(value:number)=>formatChartPrice(value,hasSupply,getLocale());
  const formatTicks=(values:number[])=>chartPriceTickmarks(values,hasSupply,getLocale());
  const currentCoolingDown = data?.loadStatus === 'rate_limited';
  const historyStatus = !fullHistory || data?.historyComplete ? null
    : data?.historyRecoveryPending ? 'Recovering historical candles…'
    : data?.historyLoadStatus === 'rate_limited' ? 'Earlier history cooling down. Retrying automatically…'
    : data?.historyLoadStatus === 'provider_error' ? 'Earlier history unavailable. Retrying automatically…'
    : data?.historyLoadStatus === 'limited' ? 'Earlier history unavailable'
    : data?.historyPending ? 'Loading earlier candles…' : null;
  const historyFailed = fullHistory && !data?.historyComplete && (data?.historyLoadStatus === 'rate_limited' || data?.historyLoadStatus === 'provider_error');
  const coolingDown = currentCoolingDown || fullHistory && !data?.historyComplete && data?.historyLoadStatus === 'rate_limited';
  const limitedHistory = data?.partialHistory && !(fullHistory && data.historyComplete);
  const refreshFailed = error || data?.loadStatus === 'provider_error' || currentCoolingDown;
  const status = currentCoolingDown ? 'Market provider cooling down. Retrying automatically…'
    : data?.loadStatus === 'provider_error' ? 'Market provider unavailable. Retrying automatically…'
    : error ? 'Chart refresh failed. Retrying automatically…'
    : !data ? 'Loading candles…'
    : data.candles.length && !marketCandles.length && (data.supplyPending || data.pending) ? 'Loading market cap…'
    : data.candles.length && !marketCandles.length && !hasSupply ? 'Market cap data unavailable'
    : data.loadStatus === 'queued' ? 'Waiting for market data…'
    : data.pending ? 'Loading candles…' : 'Candle data unavailable';

  useEffect(() => {
    if (!container.current) return;
    const identity = `${scope}:${address}:${interval}:${focusTrades}`;
    if (chartIdentity.current !== identity) {
      fitted.current = null;
      previousHistory.current = null;
      previousCandles.current = [];
      preservedViewport.current = null;
      tradeRange.current = null;
      userAdjustedViewport.current = false;
      chartIdentity.current = identity;
    }
    candleLookup.current.clear();
    const instance = createChart(container.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0b0e11' }, textColor: '#879299', fontFamily: 'Manrope, sans-serif', fontSize: 11, attributionLogo: true,
        panes:{enableResize:false} },
      grid: { vertLines: { color: '#1b222680' }, horzLines: { color: '#1b222680' } },
      rightPriceScale: { borderColor: '#252d31', scaleMargins: { top: .12, bottom: showVolume ? .24 : .08 } },
      timeScale: { borderColor: '#252d31', timeVisible: interval !== '1d', secondsVisible: false, rightOffset: 3, minBarSpacing: .5, lockVisibleTimeRangeOnResize: true },
      localization: { priceFormatter: formatPrice, tickmarksPriceFormatter: formatTicks, locale: getLocale() },
      crosshair: { mode: 0, vertLine: { color: '#69747a' }, horzLine: { color: '#69747a' } },
    });
    chart.current = instance;
    setHover(null);
    candles.current = instance.addSeries(CandlestickSeries, {
      upColor: '#39cb8f', downColor: '#f1767a', borderVisible: false, wickUpColor: '#39cb8f', wickDownColor: '#f1767a',
      // Explicit integer base avoids floating-point inversion of 1e-18, which
      // otherwise makes Lightweight Charts reject small token-price axes.
      priceFormat: { type: 'custom', minMove: hasSupply ? .01 : 1e-18, base: hasSupply ? 100 : 1e18, formatter: formatPrice, tickmarksFormatter: formatTicks },
    });
    markers.current = createSeriesMarkers(candles.current);
    if (showVolume) {
      volume.current = addVolumeOverlay(instance);
    }
    instance.subscribeCrosshairMove(event => setHover(typeof event.time === 'number' ? candleLookup.current.get(event.time) ?? null : null));
    let width = container.current.clientWidth;
    let resizeFrame = 0;
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width ?? width;
      // The trade modal keeps its chart mounted while the sharing view is open.
      // Retain the last visible width so hiding/restoring it does not refit a pan.
      if (nextWidth <= 0) return;
      if (Math.abs(nextWidth - width) > 1 && focusTrades && tradeRange.current && !userAdjustedViewport.current) {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
          if (userAdjustedViewport.current) return;
          const range = tradeChartViewport([...candleLookup.current.values()], tradeSelection.current, interval, instance.timeScale().width() || nextWidth);
          if (range) { tradeRange.current = range; instance.timeScale().setVisibleLogicalRange(range); }
        });
      }
      width = nextWidth;
    });
    observer.observe(container.current);
    return () => {
      preservedViewport.current = instance.timeScale().getVisibleLogicalRange();
      observer.disconnect(); cancelAnimationFrame(resizeFrame); cancelAnimationFrame(fittingFrame.current); markers.current?.detach(); markers.current = null; instance.remove(); chart.current = null; candles.current = null; volume.current = null;
    };
  }, [address, interval, focusTrades, showVolume,hasSupply,scope]);

  useEffect(() => {
    if (!chart.current || !candles.current) return;
    tradeSelection.current = trades ?? [];
    const priorRange = preservedViewport.current ?? chart.current.timeScale().getVisibleLogicalRange();
    const retainedRange = remapChartViewport(previousCandles.current, marketCandles, priorRange, !userAdjustedViewport.current && !focusTrades);
    preservedViewport.current = null;
    previousCandles.current = marketCandles;
    candleLookup.current = new Map(marketCandles.map(c => [c.time, c]));
    candles.current.setData(marketCandles.map(c => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    volume.current?.setData(marketCandles.filter(c => Number.isFinite(c.volume) && c.volume >= 0).map(c => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? '#39cb8f70' : '#f1767a70' })));
    markers.current?.setMarkers(kolTradeMarkers(marketCandles, trades ?? [], interval).map(marker => ({ ...marker, time: marker.time as UTCTimestamp })));
    if (!focusTrades) {
      // Initial views stay readable. Historical pages preserve the visible
      // timestamps, including a user's pan/zoom, instead of fitting all rows.
      const plotWidth = chart.current.timeScale().width() || container.current?.clientWidth || 1200;
      const range = retainedRange ?? marketHistoryViewport(marketCandles, null, plotWidth, interval);
      if (range) chart.current.timeScale().setVisibleLogicalRange(range);
      if (marketCandles.length) previousHistory.current = {
        firstTime: marketCandles[0].time, lastTime: marketCandles.at(-1)!.time, count: marketCandles.length,
      };
      return;
    }
    if (userAdjustedViewport.current) {
      const range = retainedRange ?? tradeChartViewport(marketCandles, trades ?? [], interval, chart.current.timeScale().width() || container.current?.clientWidth || 480);
      if (range) chart.current.timeScale().setVisibleLogicalRange(range);
    }
    const history = `${data?.partialHistory ? 'partial' : 'full'}:${trades?.length}:${trades?.[0]?.id}:${trades?.at(-1)?.id}`;
    const previous = previousHistory.current;
    if (tradeChartNeedsRefit(marketCandles, previous, fitted.current !== history, userAdjustedViewport.current)) {
      tradeRange.current = tradeChartViewport(marketCandles, trades ?? [], interval, chart.current.timeScale().width() || container.current?.clientWidth || 480);
      if (tradeRange.current) chart.current.timeScale().setVisibleLogicalRange(tradeRange.current);
      // The first price labels can change the plot width after setData. Refit
      // after that layout so the centered range uses the actual candle pane.
      cancelAnimationFrame(fittingFrame.current);
      fittingFrame.current = requestAnimationFrame(() => {
        const instance = chart.current;
        if (!instance || !tradeRange.current || userAdjustedViewport.current) return;
        const range = tradeChartViewport([...candleLookup.current.values()], tradeSelection.current, interval, instance.timeScale().width() || container.current?.clientWidth || 480);
        if (range) { tradeRange.current = range; instance.timeScale().setVisibleLogicalRange(range); }
      });
      fitted.current = history;
    }
    if (marketCandles.length) previousHistory.current = {
      firstTime: marketCandles[0].time, lastTime: marketCandles.at(-1)!.time, count: marketCandles.length,
    };
  }, [data, marketCandles, address, interval, trades, focusTrades, showVolume,hasSupply]);

  return <div className="token-price-chart">
    <div className="price-chart-legend" aria-live="off" title={t(hasSupply?'Calculated using current token supply':'Market cap unavailable; showing token price')}>
      {last ? <><span>{t(axisLabel)} <b>{formatPrice(last.close)}</b></span><span>O <b>{formatPrice(last.open)}</b></span><span>H <b>{formatPrice(last.high)}</b></span><span>L <b>{formatPrice(last.low)}</b></span><span>C <b>{formatPrice(last.close)}</b></span>{showVolume && <span>{t('Volume')} <b>{compact(last.volume, true)}</b></span>}</> : <span>{t(axisLabel)} —</span>}
      {data?.stale && <span>{t('Cached')}</span>}
      {hover && <span>{new Date(hover.time * 1000).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</span>}
    </div>
    <div className="price-chart-canvas" ref={container} onPointerDownCapture={() => { userAdjustedViewport.current = true; }} onWheelCapture={() => { userAdjustedViewport.current = true; }} role="img" aria-busy={!marketCandles.length && !refreshFailed && data?.pending !== false} aria-label={`${t(hasSupply?'Token market cap chart':'Token price chart')}: ${marketCandles.length} ${t('candles')}`} />
    {!marketCandles.length && <div className="price-chart-status" role="status"><span>{t(status)}</span><div className="price-chart-recovery"><button type="button" onClick={() => retry?.()} disabled={coolingDown}>{t('Try again')}</button><a href={`https://gmgn.ai/bsc/token/${address}`} target="_blank" rel="noopener noreferrer">{t('Open live chart')}</a></div></div>}
    <div className="price-chart-footer"><span>{marketCandles.length ? `${marketCandles.length} ${t('candles')} · UTC` : t(status)}{limitedHistory && marketCandles.length > 0 && ` · ${t('Limited history')}`}{observationGaps.length > 0 && <span title={`${t('Gaps in available observations')}\n${gapDescription}`}> · {t('Gaps in available observations')}: {observationGaps.length}</span>}{historyStatus && marketCandles.length > 0 && <span role="status"> · {t(historyStatus)}</span>}{refreshFailed && marketCandles.length > 0 && <span role="status"> · {t(status)}</span>}{(refreshFailed || historyFailed) && marketCandles.length > 0 && <button type="button" onClick={() => retry?.()} disabled={coolingDown}>{t('Try again')}</button>}</span><span>{data?.source === 'geckoterminal' && data.poolAddress && <a href={`https://www.geckoterminal.com/bsc/pools/${data.poolAddress}`} target="_blank" rel="noopener noreferrer">GeckoTerminal</a>}{data?.source === 'gmgn' && <a href={`https://gmgn.ai/bsc/token/${address}`} target="_blank" rel="noopener noreferrer">GMGN</a>}{data?.source === 'coinmarketcap' && <span>CoinMarketCap</span>}<a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a></span></div>
  </div>;
}
