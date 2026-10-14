import type { ReplayMarketChart } from '../shared/replayChart';
import type { TokenChart } from '../shared/intelligence';
import { applyReplayMarketChart, prepareTradeReplayData, replayInventoryIsFresh, replayIsOpen, validReplayCurrentQuote, type ReplayActivity, type TradeReplayData } from './tradeReplayData';
export { replayIsOpen } from './tradeReplayData';

const preparationBudgetMs = 22_000;
const activityBudgetMs = 15_000;
const maximumAttempts = 6;
const addressPattern = /^0x[0-9a-f]{40}$/i;
export const recordedPriceEstimateNotice = 'Market history is unavailable. Estimated P&L uses recorded trade prices.';
export const currentQuoteEstimateNotice = 'Market history is unavailable. Prices between recorded trades and the current quote are estimates.';
export const currentPriceUnavailableNotice = 'Current market price is unavailable. This replay ends at the last recorded wallet movement.';
export const inventoryUnavailableNotice = 'Profit is unavailable until wallet movements and the balance are verified at the same block.';

export function replayUsesRecordedPrices(data: TradeReplayData) {
  return data.source.chart.toLowerCase().includes('recorded fill') || !data.chart.points.length;
}

export interface ReplayMarketRequestResult {
  data: TradeReplayData;
  notice: string | null;
  currentPriceNotice?: string;
  inventoryNotice?: string;
}

function cancelled() {
  return new DOMException('Video export cancelled.', 'AbortError');
}

function withinRequest<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? cancelled());
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, problem => {
      signal.removeEventListener('abort', abort); reject(problem);
    });
  });
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? cancelled()); };
    if (signal.aborted) { reject(signal.reason ?? cancelled()); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function withUnverifiedInventory(data: TradeReplayData, reason: string): TradeReplayData {
  if (!data.inventory) return data;
  const selected = { ...data, inventory: { ...data.inventory,
    coverage: { ...data.inventory.coverage, complete: false, reconciled: false, reason } },
    position: { ...data.position, status: 'unknown' as const, tokenBalance: null, checkedAt: null, tradeFlowMatched: false } };
  delete selected.currentQuote;
  return selected;
}

/** Refresh the same pair before freezing an inventory-aware video. The refresh
 * has its own short bound inside the sharing session, leaving time for history. */
async function refreshedActivity(data: TradeReplayData, signal: AbortSignal): Promise<TradeReplayData> {
  const refresh = new AbortController(), abort = () => refresh.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const deadline = Date.now() + activityBudgetMs;
  const timeout = setTimeout(abort, activityBudgetMs);
  let selected = withUnverifiedInventory(data, 'replay_activity_refresh_failed');
  let longestAttemptMs = 0;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = Date.now();
      const response = await withinRequest(fetch(`/api/kols/${encodeURIComponent(data.kol.address)}/tokens/${encodeURIComponent(data.token.address)}/activity`,
        { signal: refresh.signal, cache: 'no-store' }), refresh.signal);
      if (!response.ok) return selected;
      const activity: ReplayActivity = await withinRequest(response.json(), refresh.signal);
      longestAttemptMs = Math.max(longestAttemptMs, Date.now() - startedAt);
      if (typeof activity?.kol?.address !== 'string' || typeof activity?.token?.address !== 'string'
        || activity.kol.address.toLowerCase() !== data.kol.address.toLowerCase()
        || activity.token.address.toLowerCase() !== data.token.address.toLowerCase()
        || !Array.isArray(activity.trades) || !activity.coverage || !activity.summary) return selected;
      // A disappearing inventory contract cannot authorize legacy swap-only P&L.
      if (!activity.inventory) activity.inventory = { version: 1, events: [],
        coverage: { ...data.inventory!.coverage, complete: false, reconciled: false, reason: 'inventory_missing_from_refresh' } };
      const retainedChart: TokenChart | null = replayUsesRecordedPrices(data) ? null : {
        address: data.token.address, period: '5m', candles: [],
        points: data.chart.points.map(point => ({ timestamp: point.timestamp, priceUsd: String(point.priceUsd) })),
        marketCapSupply: data.chart.marketCapSupply === null ? null : String(data.chart.marketCapSupply),
        source: 'recorded', resolution: data.chart.resolution, updatedAt: null, pending: false, stale: false,
      };
      const prepared = prepareTradeReplayData(activity, retainedChart, null);
      if (!prepared?.trades.length) return selected;
      selected = prepared;
      if (prepared.chart.points.length) selected = { ...prepared, chart: { ...prepared.chart,
        source: data.chart.source, sparseHistory: data.chart.sparseHistory }, source: { ...prepared.source, chart: data.source.chart } };
      if (replayInventoryIsFresh(selected) || activity.inventory.coverage.status !== 'pending' || attempt === 2) return selected;
      // A cold scan uses its full server budget. Avoid starting a further scan
      // when that observed duration plus paced retry cannot fit in this stage.
      if (1000 + longestAttemptMs + 500 >= deadline - Date.now()) return selected;
      await waitForRetry(1000, refresh.signal);
    }
    return selected;
  } catch {
    return selected;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

/** Retry only explicit provider deferrals, inside one bounded sharing session. */
export async function replayMarketData(data: TradeReplayData, signal: AbortSignal): Promise<ReplayMarketRequestResult> {
  if (signal.aborted) throw cancelled();
  if (!addressPattern.test(data.kol.address) || !addressPattern.test(data.token.address)) throw new Error('Invalid KOL or token address');
  const request = new AbortController();
  const abort = () => request.abort();
  signal.addEventListener('abort', abort, { once: true });
  const deadline = Date.now() + preparationBudgetMs;
  const timeout = setTimeout(abort, preparationBudgetMs);
  let available = data;
  const result = (selected: TradeReplayData, notice: string | null): ReplayMarketRequestResult => {
    if (selected.inventory && !replayInventoryIsFresh(selected)) selected = withUnverifiedInventory(selected, selected.inventory.coverage.reason ?? 'stale_inventory_snapshot');
    const open = replayIsOpen(selected), currentQuote = validReplayCurrentQuote(selected);
    if (!currentQuote && selected.currentQuote) { selected = { ...selected }; delete selected.currentQuote; }
    const lastInventory = selected.inventory?.events.at(-1);
    const inventoryMissing = selected.inventory && (!replayInventoryIsFresh(selected)
      || lastInventory?.remainingCostBasisUsd == null || lastInventory.cumulativeRealizedProfitUsd == null);
    return { data: selected, notice, ...(open && !currentQuote ? { currentPriceNotice: currentPriceUnavailableNotice } : {}),
      ...(inventoryMissing ? { inventoryNotice: inventoryUnavailableNotice } : {}) };
  };
  const fallback = (notice: string): ReplayMarketRequestResult => result(available,
    notice === 'Historical market data is unavailable for this replay.' && replayUsesRecordedPrices(available)
      ? validReplayCurrentQuote(available) ? currentQuoteEstimateNotice : recordedPriceEstimateNotice : notice);
  try {
    if (data.inventory) available = await refreshedActivity(data, request.signal);
    if (signal.aborted) throw cancelled();
    const url = `/api/kols/${encodeURIComponent(data.kol.address)}/tokens/${encodeURIComponent(data.token.address)}/replay-chart${replayIsOpen(available) ? '?end=current' : ''}`;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const response = await withinRequest(fetch(url, { signal: request.signal }), request.signal);
      if (signal.aborted) throw cancelled();
      if (response.status === 400 || response.status === 404) return fallback('Historical market data is unavailable for this replay.');
      const chart: ReplayMarketChart = await withinRequest(response.json(), request.signal);
      if (signal.aborted) throw cancelled();
      if (typeof chart?.address !== 'string' || chart.address.toLowerCase() !== data.token.address.toLowerCase()
        || chart.period !== 'replay' || !Array.isArray(chart.points)) {
        return fallback('Historical market data could not be loaded; the replay is using available data.');
      }
      const previous = available;
      if (response.ok) available = applyReplayMarketChart(available, chart);
      const transient = response.ok && chart.source === 'unavailable' && (chart.loadStatus === 'queued' || chart.loadStatus === 'rate_limited');
      if (transient) {
        const notice = chart.loadStatus === 'rate_limited'
          ? 'Historical market data is rate limited; the replay is using available data.'
          : 'Historical market data is still loading; the replay is using available data.';
        const reportedDelay = chart.retryAfterMs;
        const delay = typeof reportedDelay === 'number' && Number.isFinite(reportedDelay) && reportedDelay > 0
          ? Math.max(1000, reportedDelay) : 3000;
        if (attempt === maximumAttempts - 1 || delay >= deadline - Date.now()) return fallback(notice);
        await waitForRetry(delay, request.signal);
        continue;
      }
      if (!response.ok) return fallback('Historical market data could not be loaded; the replay is using available data.');
      if (available === previous || chart.source === 'unavailable' || chart.partialHistory || !chart.points.length
        || !['30s', '1m', '5m', '15m', '1h'].includes(chart.resolution)) return fallback('Historical market data is unavailable for this replay.');
      return result(available, chart.sparseHistory ? 'Market observations are sparse. Prices and P&L between observations are estimates.' : null);
    }
    return fallback('Historical market data is still loading; the replay is using available data.');
  } catch {
    if (signal.aborted) throw cancelled();
    return fallback(request.signal.aborted
      ? 'Historical market data timed out; the replay is using available data.'
      : 'Historical market data could not be loaded; the replay is using available data.');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
