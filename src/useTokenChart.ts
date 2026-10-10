import { useEffect, useRef, useState } from 'react';
import { candleIntervals, type TokenChart, type ChartRange, type CandleInterval } from '../shared/intelligence';
import { api } from './lib';

const saved = new Map<string, { chart: TokenChart; checked: number }>();
const requests = new Map<string, Promise<TokenChart>>();
async function chartRequest(address: string, period: ChartRange) {
  const key = `${address}-${period}`;
  const cached = saved.get(key);
  if (cached && Date.now() - cached.checked < 10_000) return cached.chart;
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
    let timer: number;
    const refresh = async () => {
      let delay = 30_000;
      try {
        const value = await chartRequest(address, period);
        if (!stopped) { setResult({ key, chart: value }); setError(false); }
        if (value.pending) delay = 8000;
      } catch { if (!stopped) setError(true); }
      if (!stopped) timer = window.setTimeout(() => void refresh(), delay);
    };
    void refresh();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [address, period, key, enabled]);
  return { chart, error };
}

export function useChartVisibility() {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current || visible) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '80px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  return { ref, visible };
}
