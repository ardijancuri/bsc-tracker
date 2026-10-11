import type { Position, TokenChart } from '../shared/intelligence';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import type { Kol, Token } from './types';

export interface ReplayTrade {
  id: string;
  txHash: string;
  timestamp: string;
  side: 'buy' | 'sell';
  tokenAmount: number | null;
  amountUsd: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  cumulativeRealizedProfitUsd?: number | null;
}

export interface TradeReplayData {
  kol: Pick<Kol, 'address' | 'name' | 'avatarUrl' | 'twitter'>;
  token: Pick<Token, 'address' | 'symbol' | 'name' | 'logoUrl'> & { priceUsd: number | null; marketCapUsd: number | null };
  trades: ReplayTrade[];
  position: {
    status: 'open' | 'closed' | 'unknown';
    tokenBalance: number | null;
    tradeFlowMatched: boolean;
    tradesComplete: boolean;
    checkedAt: string | null;
  };
  chart: {
    points: { timestamp: string; priceUsd: number; marketCapUsd: number | null }[];
    marketCapSupply: number | null;
    resolution: string;
    source: string;
  };
  source: { chart: string; tradesComplete: boolean };
  realizedAccounting?: { available: boolean };
  generatedAt: string;
}

export type ReplayActivity = KolTokenActivity;

export function replayNumber(value: unknown, allowZero = false): number | null {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && (allowZero ? numeric >= 0 : numeric > 0) ? numeric : null;
}

export function replaySignedNumber(value: unknown): number | null {
  if (value == null || typeof value === 'boolean' || typeof value === 'string' && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function scaledPrice(price: number | null, supply: number | null) {
  const cap = price !== null && supply !== null ? price * supply : NaN;
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

function replayOrder(a: KolTokenActivity['trades'][number], b: KolTokenActivity['trades'][number]) {
  const timestamp = Date.parse(a.timestamp) - Date.parse(b.timestamp);
  if (timestamp) return timestamp;
  const block = (value: string | null) => /^\d+$/.test(value ?? '') ? BigInt(value!) : 0n;
  const left = block(a.blockNumber), right = block(b.blockNumber);
  return (left < right ? -1 : left > right ? 1 : 0) || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) || a.id.localeCompare(b.id);
}

/** Only a fresh, independently checked balance can authorize the replay's rolling gross P&L. */
export function prepareTradeReplayData(activity: ReplayActivity, chart: TokenChart | null, position?: Position | null, now = Date.now()): TradeReplayData | null {
  const { kol, token } = activity;
  if (!kol || !token) return null;
  const selectedChart = chart?.address.toLowerCase() === token.address.toLowerCase() ? chart : null;
  const supply = replayNumber(selectedChart?.marketCapSupply) ?? replayNumber(token.marketCapSupply);
  const seen = new Set<string>();
  const trades = activity.trades.filter(trade => {
    if (seen.has(trade.id) || trade.walletAddress.toLowerCase() !== kol.address.toLowerCase()
      || trade.tokenAddress.toLowerCase() !== token.address.toLowerCase()
      || !['buy', 'sell'].includes(trade.side) || !Number.isFinite(Date.parse(trade.timestamp))) return false;
    seen.add(trade.id);
    return true;
  }).sort(replayOrder).map((trade): ReplayTrade => {
    const tokenAmount = replayNumber(trade.tokenAmount);
    const valued = trade.valuationStatus === 'valued';
    const amountUsd = valued ? replayNumber(trade.amountUsd) : null;
    // Do not replace a missing fill valuation with a later spot quote.
    const priceUsd = valued ? replayNumber(trade.priceUsd) ?? (tokenAmount && amountUsd ? amountUsd / tokenAmount : null) : null;
    return { id: trade.id, txHash: trade.txHash, timestamp: trade.timestamp, side: trade.side as 'buy' | 'sell', tokenAmount, amountUsd, priceUsd,
      marketCapUsd: valued ? replayNumber(trade.marketCapUsd) ?? scaledPrice(priceUsd, supply) : null,
      cumulativeRealizedProfitUsd: replaySignedNumber(trade.cumulativeRealizedProfitUsd) };
  });

  const pointsByTime = new Map<number, TradeReplayData['chart']['points'][number]>();
  const addPoint = (time: number, rawPrice: unknown) => {
    const price = replayNumber(rawPrice);
    if (Number.isFinite(time) && time <= now && price) pointsByTime.set(time, { timestamp: new Date(time).toISOString(), priceUsd: price, marketCapUsd: scaledPrice(price, supply) });
  };
  if (selectedChart && selectedChart.source !== 'quote' && selectedChart.source !== 'unavailable') {
    // The app's convenience points place candle closes at their opening times.
    // Use the underlying completed candles for the replay's exact event timeline.
    if (selectedChart.candles.length) {
      const intervalSeconds: Record<string, number> = { '5m': 300, '1h': 3600, '4h': 14400, '1d': 86400 };
      const resolution = intervalSeconds[selectedChart.resolution] ?? intervalSeconds[selectedChart.period];
      if (resolution) for (const [index, candle] of selectedChart.candles.entries()) {
        if (index === 0) addPoint(candle.time * 1000, candle.open);
        if ((candle.time + resolution) * 1000 <= now) addPoint((candle.time + resolution) * 1000, candle.close);
      }
    } else for (const point of selectedChart.points) addPoint(Date.parse(point.timestamp), point.priceUsd);
  }
  let points = [...pointsByTime.entries()].sort((a, b) => a[0] - b[0]).map(([, point]) => point);
  // Recent-only charts must never be extrapolated backward as historical prices.
  if (trades.length && (Date.parse(points[0]?.timestamp ?? '') > Date.parse(trades[0].timestamp)
    || Date.parse(points.at(-1)?.timestamp ?? '') < Date.parse(trades.at(-1)!.timestamp))) points = [];
  // Freeze a closed replay at its last event with the interpolated market sample,
  // rather than a later quote or that event's execution route.
  if (points.length && trades.length) {
    for (const timestamp of [trades[0].timestamp, trades.at(-1)!.timestamp]) {
      const time = Date.parse(timestamp);
      const after = points.findIndex(point => Date.parse(point.timestamp) >= time);
      if (after > 0 && Date.parse(points[after].timestamp) !== time) {
        const previous = points[after - 1], next = points[after];
        const fraction = (time - Date.parse(previous.timestamp)) / (Date.parse(next.timestamp) - Date.parse(previous.timestamp));
        const price = previous.priceUsd + (next.priceUsd - previous.priceUsd) * fraction;
        points.splice(after, 0, { timestamp, priceUsd: price, marketCapUsd: scaledPrice(price, supply) });
      }
    }
  }
  const complete = activity.coverage.complete && trades.length === activity.trades.length;
  const validPosition = position?.walletAddress.toLowerCase() === kol.address.toLowerCase()
    && position?.tokenAddress.toLowerCase() === token.address.toLowerCase() && position?.status !== 'Unknown';
  const checkedAt = validPosition && position?.checkedAt ? Date.parse(position.checkedAt) : NaN;
  const fresh = Number.isFinite(checkedAt) && now - checkedAt <= 180_000 && now - checkedAt >= -60_000;
  const balance = fresh ? replayNumber(position?.balance, true) : null;
  let bought = 0, sold = 0, reconciled = complete && trades.length > 0 && balance !== null
    && activity.trades.every(trade => trade.valuationStatus === 'valued');
  for (const trade of trades) {
    if (trade.tokenAmount === null || trade.amountUsd === null) reconciled = false;
    if (trade.side === 'buy') bought += trade.tokenAmount ?? 0;
    else sold += trade.tokenAmount ?? 0;
    if (sold > bought + Math.max(Number.MIN_VALUE, bought * 1e-10)) reconciled = false;
  }
  const tolerance = Math.max(Number.MIN_VALUE, Math.max(bought, sold, balance ?? 0) * 1e-10);
  const flowMatched = reconciled && Math.abs(bought - sold - (balance ?? 0)) <= tolerance;
  const chartSource = points.length ? (selectedChart?.source === 'recorded' ? 'Recorded observations' : 'Historical market samples') : 'Recorded fills';
  return {
    kol, token: { ...token, priceUsd: replayNumber(token.priceUsd), marketCapUsd: replayNumber(token.marketCapUsd) }, trades,
    position: { status: balance === null ? 'unknown' : balance === 0 ? 'closed' : 'open', tokenBalance: balance, tradeFlowMatched: flowMatched, tradesComplete: complete, checkedAt: fresh ? position?.checkedAt ?? null : null },
    chart: { points, marketCapSupply: supply, resolution: selectedChart?.resolution ?? '', source: chartSource },
    source: { chart: chartSource, tradesComplete: complete }, generatedAt: new Date(now).toISOString(),
    realizedAccounting: { available: complete && replaySignedNumber(activity.summary.realizedProfitUsd) !== null },
  };
}
