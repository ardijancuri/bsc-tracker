import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { candleIntervals, defaultCandleInterval, type CandleInterval, type ChartRange, type TokenChart } from '../shared/intelligence';
import { createTokenChartRequests, tokenChartNeedsForeground, tokenChartRefreshDelay, type TokenChartPriority } from './tokenChartRequest';
import { privateTokenChartRequests, tokenChartContextKey, type TokenChartRequestContext } from './privateTokenCharts';

const publicCharts = createTokenChartRequests();

export function preloadTokenChart(address: string, period: ChartRange = defaultCandleInterval) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || publicCharts.isForegroundLoading() ||
    (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
  void publicCharts.request(address, period, 'prefetch').catch(() => { /* The mounted chart handles retry and error display. */ });
}

export function useTokenChart(address: string | undefined, period: ChartRange, enabled = true, priority: TokenChartPriority = 'chart', fullHistory = false,
  requestContext?: TokenChartRequestContext) {
  const scope = tokenChartContextKey(requestContext);
  const charts = useMemo(() => requestContext ? privateTokenChartRequests(requestContext) : publicCharts, [scope]);
  const key = `${scope}:${address?.toLowerCase()}-${period}${fullHistory ? '-full' : ''}`;
  const [failure, setFailure] = useState<{ key: string; chart: TokenChart | null; latestRevision: number } | null>(null);
  const refreshNow = useRef<(() => void) | null>(null);
  const refreshHistoryNow = useRef<(() => void) | null>(null);
  const retry = useCallback(() => { refreshNow.current?.(); refreshHistoryNow.current?.(); }, []);
  const subscribe = useCallback((listener: () => void) => address ? charts.subscribe(address, listener) : () => {}, [address, charts]);
  const snapshot = useCallback(() => address ? charts.peek(address, period, fullHistory) : null, [address, period, fullHistory, charts]);
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
      const previous = charts.peek(address, period, fullHistory);
      const latestRevision = charts.latestRevision(address, period, fullHistory);
      try {
        const value = await charts.request(address, period, priority, manual, fullHistory);
        if (!stopped) setFailure(null);
        delay = tokenChartRefreshDelay(value, candleIntervals.includes(period as CandleInterval));
        if (!tokenChartNeedsForeground(value)) release();
      } catch {
        if (!stopped) setFailure({ key, chart: previous, latestRevision });
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
  }, [address, period, key, enabled, priority, fullHistory, charts]);
  useEffect(() => {
    if (!address || !enabled || !fullHistory || !candleIntervals.includes(period as CandleInterval)) return;
    let stopped = false, loading = false;
    let timer: number | undefined;
    const visible = () => document.visibilityState !== 'hidden';
    const canLoad = () => !stopped && visible() && !charts.isForegroundLoading();
    const schedule = (immediate = false) => {
      window.clearTimeout(timer);
      if (!canLoad() || loading) return;
      const delay = charts.historyDelay(address, period);
      if (delay !== null) timer = window.setTimeout(() => void older(), immediate ? 0 : delay);
    };
    const older = async () => {
      if (!canLoad() || loading) return;
      const current = charts.peek(address, period, true);
      if (!current || charts.historyDelay(address, period) === null) return;
      const oldest = current.candles[0]?.time;
      if (!oldest) return;
      const before = Number.isSafeInteger(current.historyBefore) && current.historyBefore! > 0 ? current.historyBefore! : oldest;
      if (!before) return;
      loading = true;
      try { await charts.requestOlder(address, period, before, priority); }
      catch { /* A transient missing snapshot is retried while this full chart stays visible. */ }
      loading = false;
      schedule();
    };
    const unsubscribeChart = charts.subscribe(address, () => schedule());
    const unsubscribePriority = charts.subscribePriority(() => schedule());
    const visibilityChanged = () => schedule();
    refreshHistoryNow.current = () => schedule(true);
    document.addEventListener('visibilitychange', visibilityChanged);
    schedule();
    return () => {
      stopped = true;
      refreshHistoryNow.current = null;
      window.clearTimeout(timer);
      unsubscribeChart(); unsubscribePriority();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [address, period, enabled, fullHistory, priority, charts]);
  // Another viewer or preload can repair the shared chart without this hook's own timer firing.
  const failedCurrentSnapshot = fullHistory && address ? failure?.latestRevision === charts.latestRevision(address, period, true) : failure?.chart === chart;
  return { chart, error: failure?.key === key && failedCurrentSnapshot, retry };
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
