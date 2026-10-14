import type { Position, TokenChart } from '../shared/intelligence';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import type { Kol, Token } from './types';
import type { ReplayMarketChart } from '../shared/replayChart';

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
    sparseHistory?: boolean;
  };
  source: { chart: string; tradesComplete: boolean };
  realizedAccounting?: { available: boolean };
  generatedAt: string;
  currentQuote?: { timestamp: string; priceUsd: number; marketCapUsd: number | null };
}

export type ReplayActivity = KolTokenActivity;

/** Checked ending balances win; otherwise use only complete, consistent recorded quantities. */
export function replayIsOpen(data: Pick<TradeReplayData, 'position' | 'source' | 'trades'>): boolean {
  if (data.position.status === 'open' || data.position.status === 'closed') return data.position.status === 'open';
  if (!data.source.tradesComplete || !data.position.tradesComplete || !data.trades.length) return false;
  let bought = 0, sold = 0;
  for (const trade of data.trades) {
    const quantity = replayNumber(trade.tokenAmount);
    if (quantity === null) return false;
    if (trade.side === 'buy') bought += quantity;
    else if (trade.side === 'sell') sold += quantity;
    else return false;
    if (!Number.isFinite(bought) || !Number.isFinite(sold) || sold > bought + Math.max(Number.MIN_VALUE, bought * 1e-10)) return false;
  }
  return bought - sold > Math.max(Number.MIN_VALUE, bought * 1e-10);
}

function checkedCurrentQuote(data: TradeReplayData, quote: ReplayMarketChart['currentQuote'] | TradeReplayData['currentQuote'], supply: number | null, now: number) {
  if (!quote || !replayIsOpen(data)) return undefined;
  const time = Date.parse(quote.timestamp), price = replayNumber(quote.priceUsd);
  const lastFill = Date.parse(data.trades.at(-1)?.timestamp ?? '');
  if (price === null || !Number.isFinite(time) || !Number.isFinite(lastFill) || time < lastFill || time > now || now - time > 180_000) return undefined;
  return { timestamp: new Date(time).toISOString(), priceUsd: price, marketCapUsd: scaledPrice(price, supply) };
}

export function validReplayCurrentQuote(data: TradeReplayData, now = Date.now()) {
  return checkedCurrentQuote(data, data.currentQuote, data.chart.marketCapSupply, now);
}

function sparseQuoteTail(chart: TradeReplayData['chart'], currentQuote: TradeReplayData['currentQuote']) {
  if (chart.sparseHistory) return true;
  if (!currentQuote || !chart.points.length || chart.source.toLowerCase().includes('recorded fill')) return false;
  const intervalSeconds: Record<string, number> = { '30s': 30, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
  const seconds = intervalSeconds[chart.resolution];
  const lastObservation = Date.parse(chart.points.at(-1)!.timestamp), currentTime = Date.parse(currentQuote.timestamp);
  return Boolean(seconds && Number.isFinite(lastObservation) && currentTime - lastObservation > seconds * 1000);
}

/** Observed history covering the selected window can replace the preview;
 * it never changes the selected wallet, executions, or accounting snapshot. */
export function applyReplayMarketChart(data: TradeReplayData, chart: ReplayMarketChart, now = Date.now()): TradeReplayData {
  if (chart.address.toLowerCase() !== data.token.address.toLowerCase() || !data.trades.length) return data;
  const open = replayIsOpen(data);
  const supply = replayNumber(chart.marketCapSupply) ?? data.chart.marketCapSupply;
  const currentQuote = checkedCurrentQuote(data, chart.currentQuote, supply, now) ?? checkedCurrentQuote(data, data.currentQuote, supply, now);
  let selected = currentQuote ? { ...data, currentQuote, chart: { ...data.chart, marketCapSupply: supply,
    points: data.chart.points.filter(point => Date.parse(point.timestamp) <= Date.parse(currentQuote.timestamp))
      .map(point => ({ ...point, marketCapUsd: scaledPrice(point.priceUsd, supply) })) } } : data;
  if (currentQuote && sparseQuoteTail(selected.chart, currentQuote)) selected.chart.sparseHistory = true;
  if (!currentQuote && data.currentQuote) { selected = { ...data }; delete selected.currentQuote; }
  if (chart.source === 'unavailable' || chart.partialHistory || !['30s', '1m', '5m', '15m', '1h'].includes(chart.resolution)) return selected;
  const observationEnd = currentQuote ? Date.parse(currentQuote.timestamp) : now;
  const byTime = new Map<number, TradeReplayData['chart']['points'][number]>();
  for (const point of chart.points) {
    const time = Date.parse(point.timestamp), price = replayNumber(point.priceUsd);
    if (Number.isFinite(time) && time <= now && (!open || time <= observationEnd) && price) byTime.set(time, { timestamp: new Date(time).toISOString(), priceUsd: price, marketCapUsd: scaledPrice(price, supply) });
  }
  const points = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, point]) => point);
  const first = Date.parse(data.trades[0].timestamp), last = Date.parse(data.trades.at(-1)!.timestamp);
  if (!points.length || Date.parse(points[0].timestamp) > first || Date.parse(points.at(-1)!.timestamp) < last) return selected;
  for (const time of [first, last]) {
    const after = points.findIndex(point => Date.parse(point.timestamp) >= time);
    if (after > 0 && Date.parse(points[after].timestamp) !== time) {
      const before = points[after - 1], next = points[after];
      const fraction = (time - Date.parse(before.timestamp)) / (Date.parse(next.timestamp) - Date.parse(before.timestamp));
      const price = before.priceUsd + (next.priceUsd - before.priceUsd) * fraction;
      points.splice(after, 0, { timestamp: new Date(time).toISOString(), priceUsd: price, marketCapUsd: scaledPrice(price, supply) });
    }
  }
  const start = points.findIndex(point => Date.parse(point.timestamp) === first);
  const end = points.findIndex(point => Date.parse(point.timestamp) === last);
  if (start < 0 || end < start) return selected;
  const source = chart.source === 'gmgn' ? 'GMGN historical samples' : 'GeckoTerminal historical samples';
  const selectedChart = { points: points.slice(Math.max(0, start - 1), open ? undefined : end + 1), marketCapSupply: supply,
    resolution: chart.resolution, source, sparseHistory: chart.sparseHistory || data.chart.sparseHistory };
  if (sparseQuoteTail(selectedChart, currentQuote)) selectedChart.sparseHistory = true;
  return { ...selected, chart: selectedChart, source: { ...data.source, chart: source } };
}

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

/** Candle extrema have no exact intrabar timestamps, so a replay only samples
 * their actual opening boundary and completed closing boundaries. */
function completedCandleRun(chart: TokenChart, firstTrade: number, lastTrade: number, now: number) {
  const intervalSeconds: Record<string, number> = { '1m': 60, '5m': 300, '1h': 3600, '4h': 14400, '1d': 86400 };
  const seconds = intervalSeconds[chart.resolution] ?? intervalSeconds[chart.period];
  if (!seconds) return null;
  const byTime = new Map<number, TokenChart['candles'][number]>();
  for (const candle of chart.candles) {
    if (!Number.isFinite(candle.time) || !Number.isInteger(candle.time) || candle.time < 0
      || !replayNumber(candle.open) || !replayNumber(candle.close)
      || (candle.time + seconds) * 1000 > now) continue;
    byTime.set(candle.time, candle);
  }
  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (!candles.length) return null;
  // Missing intervals must not be bridged as if the market had been observed.
  // An earlier or later gap is harmless when one contiguous run covers all fills.
  let start = 0;
  for (let end = 0; end < candles.length; end += 1) {
    const runEnds = end === candles.length - 1 || candles[end + 1].time !== candles[end].time + seconds;
    if (!runEnds) continue;
    if ((!Number.isFinite(firstTrade) || candles[start].time * 1000 <= firstTrade)
      && (!Number.isFinite(lastTrade) || (candles[end].time + seconds) * 1000 >= lastTrade)) {
      return { candles: candles.slice(start, end + 1), seconds };
    }
    start = end + 1;
  }
  return null;
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
      || !['buy', 'sell'].includes(trade.side) || !Number.isFinite(Date.parse(trade.timestamp)) || Date.parse(trade.timestamp) > now) return false;
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
  const replayPosition: TradeReplayData['position'] = { status: balance === null ? 'unknown' : balance === 0 ? 'closed' : 'open',
    tokenBalance: balance, tradeFlowMatched: flowMatched, tradesComplete: complete, checkedAt: fresh ? position?.checkedAt ?? null : null };
  const open = replayIsOpen({ trades, position: replayPosition, source: { chart: '', tradesComplete: complete } });

  const pointsByTime = new Map<number, TradeReplayData['chart']['points'][number]>();
  const addPoint = (time: number, rawPrice: unknown) => {
    const price = replayNumber(rawPrice);
    if (Number.isFinite(time) && time <= now && price) pointsByTime.set(time, { timestamp: new Date(time).toISOString(), priceUsd: price, marketCapUsd: scaledPrice(price, supply) });
  };
  if (selectedChart && selectedChart.source !== 'quote' && selectedChart.source !== 'unavailable') {
    // The app's convenience points place candle closes at their opening times.
    // Use the underlying completed candles for the replay's exact event timeline.
    if (selectedChart.candles.length) {
      const run = completedCandleRun(selectedChart, Date.parse(trades[0]?.timestamp ?? ''), Date.parse(trades.at(-1)?.timestamp ?? ''), now);
      if (run) for (const [index, candle] of run.candles.entries()) {
        if (index === 0) addPoint(candle.time * 1000, candle.open);
        addPoint((candle.time + run.seconds) * 1000, candle.close);
      }
    } else for (const point of selectedChart.points) addPoint(Date.parse(point.timestamp), point.priceUsd);
  }
  let points = [...pointsByTime.entries()].sort((a, b) => a[0] - b[0]).map(([, point]) => point);
  // Recent-only charts must never be extrapolated backward as historical prices.
  if (trades.length && (Date.parse(points[0]?.timestamp ?? '') > Date.parse(trades[0].timestamp)
    || Date.parse(points.at(-1)?.timestamp ?? '') < Date.parse(trades.at(-1)!.timestamp))) points = [];
  // Closed recaps stop at their final fill. Open recaps may preserve actual
  // later observations; a separate fresh currentQuote is still required to
  // claim a current endpoint. Activity token fields never supply that quote.
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
    const first = points.findIndex(point => Date.parse(point.timestamp) === Date.parse(trades[0].timestamp));
    const last = points.findIndex(point => Date.parse(point.timestamp) === Date.parse(trades.at(-1)!.timestamp));
    // One prior genuine sample gives the chart context without adding a long
    // lead-in or inventing a price before the available history begins.
    if (first >= 0 && last >= first) points = points.slice(Math.max(0, first - 1), open ? undefined : last + 1);
    else points = [];
  }
  const chartSource = points.length ? (selectedChart?.source === 'recorded' ? 'Recorded observations' : 'Historical market samples') : 'Recorded fills';
  return {
    kol, token: { ...token, priceUsd: replayNumber(token.priceUsd), marketCapUsd: replayNumber(token.marketCapUsd) }, trades,
    position: replayPosition,
    chart: { points, marketCapSupply: supply, resolution: selectedChart?.resolution ?? '', source: chartSource },
    source: { chart: chartSource, tradesComplete: complete }, generatedAt: new Date(now).toISOString(),
    realizedAccounting: { available: complete && replaySignedNumber(activity.summary.realizedProfitUsd) !== null },
  };
}
