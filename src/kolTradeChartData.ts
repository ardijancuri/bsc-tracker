import type { CandleInterval, MarketCandle } from '../shared/intelligence';
import type { Trade } from './types';
import { readableCandleSlots } from './chartViewport';

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

/** Center a readable group of the latest observed trades. Older executions stay
 * available by panning, rather than compressing months into hairline candles. */
export function tradeVisibleRange(candles: MarketCandle[], trades: ChartTrade[], interval: CandleInterval = '5m', plotWidth = 480) {
  if (!candles.length) return null;
  const indices: number[] = [];
  for (const trade of trades) {
    if (trade.side !== 'buy' && trade.side !== 'sell') continue;
    const time = Date.parse(trade.timestamp) / 1000;
    if (!Number.isFinite(time)) continue;
    let lo = 0, hi = candles.length - 1, index = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (candles[mid].time <= time) { index = mid; lo = mid + 1; } else hi = mid - 1; }
    const candle = candles[index];
    if (!candle || time >= candle.time + seconds[interval]) continue;
    indices.push(index);
  }
  if (!indices.length) return null;
  const slots = readableCandleSlots(plotWidth), lastIndex = Math.max(...indices);
  const context = 8;
  const firstIndex = Math.min(...indices.filter(index => lastIndex - index + 1 + context * 2 <= slots.maximum));
  const tradeSpan = lastIndex - firstIndex + 1, padding = Math.max(context, Math.ceil(tradeSpan * .15));
  const visibleSpan = Math.min(slots.maximum, Math.max(slots.minimum, tradeSpan + padding * 2));
  const center = (firstIndex + lastIndex) / 2;
  return { from: center - visibleSpan / 2, to: center + visibleSpan / 2 };
}
