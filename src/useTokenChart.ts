import { useEffect, useRef, useState } from 'react';
import type { TokenChart, ChartRange } from '../shared/intelligence';
import { createTokenChartRequests } from './tokenChartRequest';

const charts = createTokenChartRequests();

export function preloadTokenChart(address: string, period: ChartRange = '5m') {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return;
  void charts.request(address, period).catch(() => { /* The mounted chart handles retry and error display. */ });
}

export function useTokenChart(address: string | undefined, period: ChartRange, enabled = true) {
  const key = `${address}-${period}`;
  const [result, setResult] = useState<{ key: string; chart: TokenChart } | null>(null);
  const [error, setError] = useState(false);
  const chart = result?.key === key ? result.chart : address ? charts.peek(address, period) : null;
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
        if (!stopped) { setResult({ key, chart: value }); setError(false); }
        if (value.retryAfterMs) delay = Math.max(1000, Math.min(value.retryAfterMs, 600_000));
        else if (value.pending) delay = 3000;
      } catch { if (!stopped) setError(true); }
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
  return { chart, error };
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
