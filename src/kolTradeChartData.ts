import type { CandleInterval, MarketCandle } from '../shared/intelligence';
import type { Trade } from './types';

export type ChartTrade = Pick<Trade, 'id' | 'timestamp' | 'side'>;
const seconds: Record<CandleInterval, number> = { '1m': 60, '5m': 300, '1h': 3600, '4h': 14400, '1d': 86400 };

// A marker identifies its real candle interval, never a fabricated execution price.
export function kolTradeMarkers(candles: MarketCandle[], trades: ChartTrade[], interval: CandleInterval) {
  const groups = new Map<string, { time: number; side: 'buy' | 'sell'; count: number }>();
  const seen = new Set<string>();
  for (const trade of trades) {
    if (seen.has(trade.id) || (trade.side !== 'buy' && trade.side !== 'sell')) continue;
    seen.add(trade.id);
    const time = Date.parse(trade.timestamp) / 1000;
    if (!Number.isFinite(time)) continue;
    let lo = 0, hi = candles.length - 1, index = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (candles[mid].time <= time) { index = mid; lo = mid + 1; } else hi = mid - 1; }
    const candle = candles[index];
    if (!candle || time >= candle.time + seconds[interval]) continue;
    const key = `${candle.time}:${trade.side}`;
    const group = groups.get(key) ?? { time: candle.time, side: trade.side, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.time - b.time || a.side.localeCompare(b.side)).map(group => ({
    time: group.time,
    position: group.side === 'buy' ? 'belowBar' as const : 'aboveBar' as const,
    shape: 'circle' as const,
    color: group.side === 'buy' ? '#39cb8f' : '#f1767a',
    text: `${group.side === 'buy' ? 'B' : 'S'}${group.count > 1 ? group.count : ''}`,
  }));
}

/** Symmetric logical space keeps short trade histories compact and centered,
 * including at the first/last loaded candle. Only observed trade bars focus it. */
export function tradeVisibleRange(candles: MarketCandle[], trades: ChartTrade[], interval: CandleInterval = '5m', plotWidth = 480) {
  if (!candles.length) return null;
  let firstIndex = Infinity, lastIndex = -1;
  for (const trade of trades) {
    if (trade.side !== 'buy' && trade.side !== 'sell') continue;
    const time = Date.parse(trade.timestamp) / 1000;
    if (!Number.isFinite(time)) continue;
    let lo = 0, hi = candles.length - 1, index = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (candles[mid].time <= time) { index = mid; lo = mid + 1; } else hi = mid - 1; }
    const candle = candles[index];
    if (!candle || time >= candle.time + seconds[interval]) continue;
    firstIndex = Math.min(firstIndex, index); lastIndex = Math.max(lastIndex, index);
  }
  if (lastIndex < 0) return null;
  const width = Number.isFinite(plotWidth) && plotWidth > 0 ? plotWidth : 480;
  const tradeSpan = lastIndex - firstIndex + 1, padding = Math.max(8, Math.ceil(tradeSpan * .15));
  const visibleSpan = Math.max(40, Math.ceil(width / 12), tradeSpan + padding * 2);
  const center = (firstIndex + lastIndex) / 2;
  return { from: center - visibleSpan / 2, to: center + visibleSpan / 2 };
}
