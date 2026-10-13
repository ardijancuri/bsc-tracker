import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { candleIntervals, defaultCandleInterval, type CandleInterval, type ChartRange, type TokenChart } from '../shared/intelligence';
import { createTokenChartRequests, tokenChartNeedsForeground, tokenChartRefreshDelay, type TokenChartPriority } from './tokenChartRequest';

const charts = createTokenChartRequests();

export function preloadTokenChart(address: string, period: ChartRange = defaultCandleInterval) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || charts.isForegroundLoading() ||
    (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
  void charts.request(address, period, 'prefetch').catch(() => { /* The mounted chart handles retry and error display. */ });
}

export function useTokenChart(address: string | undefined, period: ChartRange, enabled = true, priority: TokenChartPriority = 'chart') {
  const key = `${address?.toLowerCase()}-${period}`;
  const [failure, setFailure] = useState<{ key: string; chart: TokenChart | null } | null>(null);
  const refreshNow = useRef<(() => void) | null>(null);
  const retry = useCallback(() => refreshNow.current?.(), []);
  const subscribe = useCallback((listener: () => void) => address ? charts.subscribe(address, listener) : () => {}, [address]);
  const snapshot = useCallback(() => address ? charts.peek(address, period) : null, [address, period]);
  const chart = useSyncExternalStore(subscribe, snapshot, () => null);
  useEffect(() => {
    if (!address || !enabled) return;
    let stopped = false;
    let refreshing = false;
    let timer: number | undefined;
    let releaseForeground: (() => void) | undefined;
    const release = () => { releaseForeground?.(); releaseForeground = undefined; };
    const isVisible = () => document.visibilityState !== 'hidden';
    const canRefresh = () => isVisible() && (priority === 'chart' || !charts.isForegroundLoading());
    const refresh = async (manual = false) => {
      if (stopped || refreshing || !canRefresh()) return;
      window.clearTimeout(timer);
      refreshing = true;
      if (priority === 'chart' && !releaseForeground) releaseForeground = charts.holdForeground();
      let delay = 30_000;
      const previous = charts.peek(address, period);
      try {
        const value = await charts.request(address, period, priority, manual);
        if (!stopped) setFailure(null);
        delay = tokenChartRefreshDelay(value, candleIntervals.includes(period as CandleInterval));
        if (!tokenChartNeedsForeground(value)) release();
      } catch {
        if (!stopped) setFailure({ key, chart: previous });
        if (previous?.candles.length) release();
        delay = 3000;
      }
      refreshing = false;
      if (!stopped && canRefresh()) timer = window.setTimeout(() => void refresh(), delay);
    };
    const visibilityChanged = () => {
      window.clearTimeout(timer);
      if (!isVisible()) release();
      else void refresh();
    };
    const unsubscribePriority = priority === 'chart' ? () => {} : charts.subscribePriority(() => {
      window.clearTimeout(timer);
      if (canRefresh()) void refresh();
    });
    refreshNow.current = () => { void refresh(true); };
    document.addEventListener('visibilitychange', visibilityChanged);
    // Give mounted foreground charts their effect turn before visible watchlist requests start.
    if (priority === 'chart') void refresh();
    else timer = window.setTimeout(() => void refresh(), 0);
    return () => {
      stopped = true;
      refreshNow.current = null;
      window.clearTimeout(timer);
      unsubscribePriority();
      release();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [address, period, key, enabled, priority]);
  // Another viewer or preload can repair the shared chart without this hook's own timer firing.
  return { chart, error: failure?.key === key && failure.chart === chart, retry };
}

export function useChartVisibility() {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { rootMargin: '80px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, visible };
}
