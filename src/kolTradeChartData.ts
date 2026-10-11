import type { CandleInterval, MarketCandle } from '../shared/intelligence';
import type { Trade } from './types';

export type ChartTrade = Pick<Trade, 'id' | 'timestamp' | 'side'>;
const seconds: Record<CandleInterval, number> = { '5m': 300, '1h': 3600, '4h': 14400, '1d': 86400 };

export function intervalForTrades(first: string | null, last: string | null, now = Date.now()): CandleInterval {
  const start = Date.parse(first || last || '');
  const end = Date.parse(last || first || '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '5m';
  const age = Math.max(now - start, now - end, end - start);
  return age < 86400_000 ? '5m' : age < 30 * 86400_000 ? '1h' : age < 90 * 86400_000 ? '4h' : '1d';
}

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

export function tradeVisibleRange(candles: MarketCandle[], trades: ChartTrade[], interval: CandleInterval = '5m') {
  const times = trades.map(trade => Date.parse(trade.timestamp) / 1000).filter(Number.isFinite);
  if (!times.length || !candles.length) return null;
  const first = Math.min(...times), last = Math.max(...times);
  if (last < candles[0].time || first >= candles.at(-1)!.time + seconds[interval]) return null;
  let startIndex = 0, endIndex = 0;
  for (let i = 0; i < candles.length; i++) { if (candles[i].time <= first) startIndex = i; if (candles[i].time <= last) endIndex = i; }
  const padding = Math.max(8, Math.ceil((endIndex - startIndex) * .15));
  return { from: Math.max(0, startIndex - padding), to: Math.min(candles.length + 2, Math.max(startIndex + 25, endIndex + padding)) };
}
