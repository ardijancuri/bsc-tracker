import type { WatchEntry, WatchPeriod } from '../shared/intelligence.js';

export function observedChange(current: unknown, previous: unknown): string | null {
  if (current == null || previous == null) return null;
  const now = Number(current), before = Number(previous);
  return Number.isFinite(now) && now > 0 && Number.isFinite(before) && before > 0
    ? String((now / before - 1) * 100) : null;
}

export function watchlistMarket(row: WatchEntry & { price1hAgo?: string | null; price24hAgo?: string | null; pricePeriodAgo?: string | null }, period: WatchPeriod = '24h'): WatchEntry {
  const { price1hAgo, price24hAgo, pricePeriodAgo, ...item } = row;
  if (item.kind !== 'token') return item;
  const change24h = observedChange(item.priceUsd, price24hAgo) ?? item.change24h ?? null;
  return { ...item, change1h: observedChange(item.priceUsd, price1hAgo), change24h,
    periodChange: observedChange(item.priceUsd, pricePeriodAgo) ?? (period === '24h' ? change24h : null) };
}
