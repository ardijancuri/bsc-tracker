import { useEffect, useRef, useState } from 'react';
import { candleIntervals, type TokenChart, type ChartRange, type CandleInterval } from '../shared/intelligence';
import { api } from './lib';

const saved = new Map<string, { chart: TokenChart; checked: number }>();
const requests = new Map<string, Promise<TokenChart>>();
async function chartRequest(address: string, period: ChartRange) {
  const key = `${address}-${period}`;
  const cached = saved.get(key);
  if (cached && Date.now() - cached.checked < (cached.chart.pending || cached.chart.loadStatus ? 1000 : 10_000)) return cached.chart;
  let request = requests.get(key);
  if (!request) {
    const parameter = candleIntervals.includes(period as CandleInterval) ? 'interval' : 'period';
    request = api<TokenChart>(`/api/tokens/${address}/chart?${parameter}=${period}`).then(chart => {
      if (saved.size > 500) saved.delete(saved.keys().next().value!);
      saved.set(key, { chart, checked: Date.now() });
      return chart;
    }).finally(() => requests.delete(key));
    requests.set(key, request);
  }
  return request;
}

export function useTokenChart(address: string | undefined, period: ChartRange, enabled = true) {
  const key = `${address}-${period}`;
  const [result, setResult] = useState<{ key: string; chart: TokenChart } | null>(null);
  const [error, setError] = useState(false);
  const chart = result?.key === key ? result.chart : saved.get(key)?.chart ?? null;
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
        const value = await chartRequest(address, period);
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
