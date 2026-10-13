import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { candleIntervals, defaultCandleInterval, type CandleInterval, type ChartRange } from '../shared/intelligence';
import { createTokenChartRequests, tokenChartRefreshDelay } from './tokenChartRequest';

const charts = createTokenChartRequests();

export function preloadTokenChart(address: string, period: ChartRange = defaultCandleInterval) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return;
  void charts.request(address, period).catch(() => { /* The mounted chart handles retry and error display. */ });
}

export function useTokenChart(address: string | undefined, period: ChartRange, enabled = true) {
  const key = `${address}-${period}`;
  const [failure, setFailure] = useState<string | null>(null);
  const subscribe = useCallback((listener: () => void) => address ? charts.subscribe(address, listener) : () => {}, [address]);
  const snapshot = useCallback(() => address ? charts.peek(address, period) : null, [address, period]);
  const chart = useSyncExternalStore(subscribe, snapshot, () => null);
  useEffect(() => {
    if (!address || !enabled) return;
    let stopped = false;
    let refreshing = false;
    let timer: number;
    const isVisible = () => document.visibilityState !== 'hidden';
    const refresh = async () => {
      if (stopped || refreshing || !isVisible()) return;
      refreshing = true;
      let delay = 30_000;
      try {
        const value = await charts.request(address, period);
        if (!stopped) setFailure(null);
        delay = tokenChartRefreshDelay(value, candleIntervals.includes(period as CandleInterval));
      } catch { if (!stopped) setFailure(key); delay = 3000; }
      refreshing = false;
      if (!stopped && isVisible()) timer = window.setTimeout(() => void refresh(), delay);
    };
    const visibilityChanged = () => {
      window.clearTimeout(timer);
      if (isVisible()) void refresh();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    void refresh();
    return () => { stopped = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', visibilityChanged); };
  }, [address, period, key, enabled]);
  return { chart, error: failure === key };
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
