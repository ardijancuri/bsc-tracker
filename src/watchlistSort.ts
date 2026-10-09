import type { WatchEntry } from '../shared/intelligence';
import { getLocale } from './i18n';
import { sparklineGeometry } from './WatchTokenVisuals';

export type WatchSortKey = 'name' | 'address' | 'change1h' | 'periodChange' | 'marketCapUsd' | 'periodVolumeUsd' | 'periodKolCount' | 'lastTradeAt' | 'chart';
export function compareWatchTokens(a: WatchEntry, b: WatchEntry, key: WatchSortKey, ascending: boolean) {
  const direction = ascending ? 1 : -1;
  const tie = () => a.address.localeCompare(b.address);
  if (key === 'name' || key === 'address') {
    const label = (token: WatchEntry) => key === 'address' ? token.address : token.symbol || token.name || token.address;
    return label(a).localeCompare(label(b), getLocale(), { numeric: true, sensitivity: 'base' }) * direction || tie();
  }
  const value = (token: WatchEntry) => {
    if (key === 'chart') return sparklineGeometry(token.priceHistory || [])?.change ?? NaN;
    if (key === 'lastTradeAt') return token.lastTradeAt ? Date.parse(token.lastTradeAt) : NaN;
    const raw = token[key];
    return raw == null || raw === '' ? NaN : Number(raw);
  };
  const left = value(a), right = value(b);
  // Keep missing data at the bottom in either direction; zero is a valid value.
  if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : tie();
  if (!Number.isFinite(right)) return -1;
  return (left - right) * direction || tie();
}
