import type { ChartRange } from '../shared/intelligence';
import { preloadTokenChart } from './useTokenChart';

let hovered: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;

/** Warm only the chart a user intends to open, without fetching whole lists. */
export function tokenChartIntent(address: string, interval: ChartRange = '5m', prepare?: () => void) {
  const key = `${address.toLowerCase()}-${interval}`;
  const cancel = () => {
    if (hovered?.key !== key) return;
    clearTimeout(hovered.timer);
    hovered = null;
  };
  const warm = () => {
    cancel();
    prepare?.();
    preloadTokenChart(address, interval);
  };
  return {
    onMouseEnter: () => {
      if (hovered) clearTimeout(hovered.timer);
      // Passing over rows should not start a provider request for each token.
      hovered = { key, timer: setTimeout(warm, 120) };
    },
    onMouseLeave: cancel,
    onFocus: warm,
    onPointerDown: warm,
  };
}
