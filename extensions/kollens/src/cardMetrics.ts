import type {TokenCardMetric} from '../../../shared/extension';

// Keep GMGN's displayed precision and tier color. These are tab-local observations.
export function normalizeCardMetric(metric: TokenCardMetric | null | undefined): TokenCardMetric | null {
  const value = typeof metric?.value === 'string' ? metric.value.trim() : '';
  if (!value || value.length > 24 || !/^\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?[KMBT]?$/i.test(value)) return null;
  const color = metric?.color;
  return typeof color === 'string' && color.length <= 64 && /^rgba?\([\d.,%\s/]+\)$/.test(color) ? {value, color} : {value};
}

const suffixMultiplier = {K: 1e3, M: 1e6, B: 1e9, T: 1e12} as const;

// Use the default GMGN Trenches tiers in both popup views, even if the
// observed DOM color was inherited from a neutral wrapper.
export function cardMetricColor(metric: TokenCardMetric | null | undefined): string | undefined {
  const normalized = normalizeCardMetric(metric);
  if (!normalized) return;
  const display = normalized.value.replace(/[$,\s]/g, '').toUpperCase();
  const suffix = display.at(-1) as keyof typeof suffixMultiplier;
  const multiplier = suffixMultiplier[suffix];
  const dollars = Number(multiplier ? display.slice(0, -1) : display) * (multiplier ?? 1);
  if (dollars < 10_000) return;
  if (dollars < 30_000) return '#86d99f';
  if (dollars < 150_000) return '#4ea7fa';
  return '#f2c366';
}

export function readCardMetric(card: HTMLElement, label: 'MC' | 'V') {
  const prefix = new RegExp(`^${label}\\s*(?=\\$)`);
  const selector = `[data-icon="${label}"], [data-sentry-component="MetricLayer"] span`;
  for (const metric of card.querySelectorAll<HTMLElement>(selector)) {
    if (!metric.getClientRects().length || metric.closest('[hidden]')) continue;
    const style = getComputedStyle(metric);
    if (style.visibility !== 'visible') continue;
    const text = metric.innerText?.trim() ?? metric.textContent?.trim() ?? '';
    if (metric.getAttribute('data-icon') !== label && !prefix.test(text)) continue;
    const value = normalizeCardMetric({value: text.replace(prefix, ''), color: style.color});
    if (value) return value;
  }
  return null;
}
