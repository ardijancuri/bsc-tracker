import type { ReplayMarketChart } from '../shared/replayChart';
import type { TokenChart } from '../shared/intelligence';
import { applyReplayMarketChart, prepareTradeReplayData, replayAccountingIsFresh, replayEndTimestamp, replayInventoryIsFresh, replayIsOpen, unavailableReplayAccounting, validReplayAccountingFinal, validReplayCurrentQuote, type ReplayActivity, type TradeReplayData } from './tradeReplayData';
export { replayIsOpen } from './tradeReplayData';

const preparationBudgetMs = 22_000;
const maximumAttempts = 6;
const addressPattern = /^0x[0-9a-f]{40}$/i;
export const recordedPriceEstimateNotice = 'Market history is unavailable. Estimated P&L uses recorded trade prices.';
export const currentQuoteEstimateNotice = 'Market history is unavailable. Prices between recorded trades and the current quote are estimates.';
export const currentPriceUnavailableNotice = 'Current market price is unavailable. This replay ends at the last recorded wallet movement.';
export const inventoryUnavailableNotice = 'Profit is unavailable until wallet movements and the balance are verified at the same block.';
export const accountingUnavailableNotice = 'GMGN profit and ROI are unavailable for this replay.';
export const accountingEstimateNotice = 'Profit and ROI use estimated GMGN accounting; exact final totals are unavailable.';
export const accountingExactNotice = 'GMGN final profit and ROI are verified. Earlier values are estimates.';

export function replayUsesRecordedPrices(data: TradeReplayData) {
  return data.source.chart.toLowerCase().includes('recorded fill') || !data.chart.points.length;
}

export interface ReplayMarketRequestResult {
  data: TradeReplayData;
  notice: string | null;
  currentPriceNotice?: string;
  inventoryNotice?: string;
  accountingNotice?: string;
  preparationStatus: 'ready' | 'pending' | 'unavailable';
  retryAfterMs?: number;
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

/** Refresh the same pair while historical work runs in parallel. Both stages
 * use the sharing session's deadline and cannot outlive modal cancellation. */
interface ActivityPreparation { data: TradeReplayData; pending: boolean; retryAfterMs?: number }
async function refreshedActivity(data: TradeReplayData, signal: AbortSignal, deadline: number): Promise<ActivityPreparation> {
  const refresh = new AbortController(), abort = () => refresh.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let selected = { ...withUnverifiedInventory(data, 'replay_activity_refresh_failed'),
    replayAccounting: unavailableReplayAccounting(data, 'replay_activity_refresh_failed') };
  let longestAttemptMs = 0;
  let pending = false, retryAfterMs: number | undefined;
  const result = (): ActivityPreparation => ({ data: selected, pending, ...(retryAfterMs ? { retryAfterMs } : {}) });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = Date.now();
      let response: Response, activity: ReplayActivity;
      try {
        response = await withinRequest(fetch(`/api/kols/${encodeURIComponent(data.kol.address)}/tokens/${encodeURIComponent(data.token.address)}/activity?replay=true`,
          { signal: refresh.signal, cache: 'no-store' }), refresh.signal);
        if (!response.ok) {
          pending = response.status === 429 || response.status >= 500;
          if (!pending) return result();
          retryAfterMs = httpRetryDelay(response, attempt);
          if (attempt === 2 || retryAfterMs + 500 >= deadline - Date.now()) return result();
          await waitForRetry(retryAfterMs, refresh.signal); continue;
        }
        activity = await withinRequest(response.json(), refresh.signal);
      } catch {
        pending = true; retryAfterMs = Math.min(2000, 1000 * (attempt + 1));
        if (refresh.signal.aborted || attempt === 2 || retryAfterMs + 500 >= deadline - Date.now()) return result();
        await waitForRetry(retryAfterMs, refresh.signal); continue;
      }
      longestAttemptMs = Math.max(longestAttemptMs, Date.now() - startedAt);
      if (typeof activity?.kol?.address !== 'string' || typeof activity?.token?.address !== 'string'
        || activity.kol.address.toLowerCase() !== data.kol.address.toLowerCase()
        || activity.token.address.toLowerCase() !== data.token.address.toLowerCase()
        || !Array.isArray(activity.trades) || !activity.coverage || !activity.summary) { pending = false; return result(); }
      // A disappearing inventory contract cannot authorize legacy swap-only P&L.
      if (!activity.inventory && data.inventory) activity.inventory = { version: 1, events: [],
        coverage: { ...data.inventory.coverage, complete: false, reconciled: false, reason: 'inventory_missing_from_refresh' } };
      const retainedChart: TokenChart | null = replayUsesRecordedPrices(data) ? null : {
        address: data.token.address, period: '5m', candles: [],
        points: data.chart.points.map(point => ({ timestamp: point.timestamp, priceUsd: String(point.priceUsd) })),
        marketCapSupply: data.chart.marketCapSupply === null ? null : String(data.chart.marketCapSupply),
        source: 'recorded', resolution: data.chart.resolution, updatedAt: null, pending: false, stale: false,
      };
      const prepared = prepareTradeReplayData(activity, retainedChart, null);
      if (!prepared?.trades.length) { pending = false; return result(); }
      selected = { ...prepared, replayAccounting: prepared.replayAccounting ?? unavailableReplayAccounting(prepared, 'gmgn_accounting_missing') };
      if (prepared.chart.points.length) selected = { ...selected, chart: { ...prepared.chart,
        source: data.chart.source, sparseHistory: data.chart.sparseHistory }, source: { ...prepared.source, chart: data.source.chart } };
      const inventoryPending = activity.inventory?.coverage.status === 'pending';
      const accountingPending = selected.replayAccounting.status === 'pending';
      pending = inventoryPending || accountingPending;
      if (!pending) return result();
      // A cold scan uses its full server budget. Avoid starting a further scan
      // when that observed duration plus paced retry cannot fit in this stage.
      const reportedDelay = selected.replayAccounting.retryAfterMs;
      const delay = accountingPending && typeof reportedDelay === 'number' && Number.isFinite(reportedDelay) && reportedDelay > 0 ? Math.max(1000, reportedDelay) : 1000;
      retryAfterMs = delay;
      if (attempt === 2 || delay + longestAttemptMs + 500 >= deadline - Date.now()) return result();
      await waitForRetry(delay, refresh.signal);
    }
    return result();
  } catch {
    pending = true; retryAfterMs ??= 1000; return result();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function httpRetryDelay(response: Response, attempt: number) {
  const retry = response.headers?.get('Retry-After');
  if (retry) {
    const seconds = Number(retry), until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retry);
    if (Number.isFinite(until) && until > Date.now()) return Math.max(1000, until - Date.now());
  }
  return Math.min(2000, 1000 * (attempt + 1));
}

interface HistoryPreparation {
  charts: ReplayMarketChart[];
  notice: string | null;
  pending: boolean;
  retryAfterMs?: number;
}

async function replayHistory(data: TradeReplayData, current: boolean, signal: AbortSignal, deadline: number): Promise<HistoryPreparation> {
  const charts: ReplayMarketChart[] = [];
  const url = `/api/kols/${encodeURIComponent(data.kol.address)}/tokens/${encodeURIComponent(data.token.address)}/replay-chart${current ? '?end=current' : ''}`;
  const problem = 'Historical market data could not be loaded; the replay is using available data.';
  const unavailable = 'Historical market data is unavailable for this replay.';
  try {
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const response = await withinRequest(fetch(url, { signal, cache: 'no-store' }), signal);
      if (response.status === 400 || response.status === 404) return { charts, notice: unavailable, pending: false };
      if (!response.ok) return { charts, notice: problem, pending: response.status === 429 || response.status >= 500,
        ...(response.status === 429 || response.status >= 500 ? { retryAfterMs: httpRetryDelay(response, attempt) } : {}) };
      const chart: ReplayMarketChart = await withinRequest(response.json(), signal);
      if (typeof chart?.address !== 'string' || chart.address.toLowerCase() !== data.token.address.toLowerCase()
        || chart.period !== 'replay' || !Array.isArray(chart.points)
        || !['gmgn', 'geckoterminal', 'unavailable'].includes(chart.source)) return { charts, notice: problem, pending: false };
      charts.push(chart);
      const pending = chart.loadStatus === 'queued' || chart.loadStatus === 'rate_limited';
      const delay = typeof chart.retryAfterMs === 'number' && Number.isFinite(chart.retryAfterMs) && chart.retryAfterMs > 0
        ? Math.max(1000, chart.retryAfterMs) : 3000;
      const notice = chart.loadStatus === 'rate_limited'
        ? 'Historical market data is rate limited; the replay is using available data.'
        : 'Historical market data is still loading; the replay is using available data.';
      // Genuine cached observations are already useful. Keep their original
      // timestamps through a provider cooldown rather than fetching them again.
      if (pending && chart.source !== 'unavailable' && chart.points.length) return { charts, notice, pending: true, retryAfterMs: delay };
      if (pending) {
        if (attempt === maximumAttempts - 1 || delay >= deadline - Date.now()) return { charts, notice, pending: true, retryAfterMs: delay };
        await waitForRetry(delay, signal); continue;
      }
      if (chart.source === 'unavailable' || chart.partialHistory || !chart.points.length
        || !['30s', '1m', '5m', '15m', '1h'].includes(chart.resolution)) return { charts, notice: unavailable, pending: false };
      return { charts, notice: chart.sparseHistory ? 'Market observations are sparse. Prices and P&L between observations are estimates.' : null, pending: false };
    }
    return { charts, notice: 'Historical market data is still loading; the replay is using available data.', pending: true, retryAfterMs: 1000 };
  } catch {
    return { charts, notice: signal.aborted ? 'Historical market data timed out; the replay is using available data.' : problem, pending: true, retryAfterMs: 1000 };
  }
}

/** Refresh accounting and historical observations concurrently inside one
 * bounded session. Unavailable previews never authorize an automatic export. */
export async function replayMarketData(data: TradeReplayData, signal: AbortSignal): Promise<ReplayMarketRequestResult> {
  if (signal.aborted) throw cancelled();
  if (!addressPattern.test(data.kol.address) || !addressPattern.test(data.token.address)) throw new Error('Invalid KOL or token address');
  const request = new AbortController(), abort = () => request.abort();
  signal.addEventListener('abort', abort, { once: true });
  const deadline = Date.now() + preparationBudgetMs, timeout = setTimeout(abort, preparationBudgetMs);
  // Unknown positions can prefetch a current quote. A later verified closed
  // inventory ignores it and trims the genuine history at its final movement.
  const initialCurrent = data.position.status !== 'closed';
  try {
    const activityWork = refreshedActivity(data, request.signal, deadline);
    const historyWork = replayHistory(data, initialCurrent, request.signal, deadline);
    const activity = await activityWork;
    let history = await historyWork;
    if (signal.aborted) throw cancelled();
    let selected = activity.data;
    for (const chart of history.charts) selected = applyReplayMarketChart(selected, chart);
    if (!initialCurrent && replayIsOpen(selected) && !validReplayCurrentQuote(selected) && !request.signal.aborted) {
      const currentHistory = await replayHistory(selected, true, request.signal, deadline);
      for (const chart of currentHistory.charts) selected = applyReplayMarketChart(selected, chart);
      history = { ...currentHistory, charts: [...history.charts, ...currentHistory.charts] };
    }
    if (signal.aborted) throw cancelled();
    if (selected.inventory && !replayInventoryIsFresh(selected)) selected = withUnverifiedInventory(selected, selected.inventory.coverage.reason ?? 'stale_inventory_snapshot');
    if (selected.replayAccounting && (!replayAccountingIsFresh(selected) || !replayInventoryIsFresh(selected))) selected = { ...selected,
      replayAccounting: unavailableReplayAccounting(selected, selected.replayAccounting.coverage.reason ?? 'gmgn_accounting_unavailable') };
    const open = replayIsOpen(selected), currentQuote = validReplayCurrentQuote(selected);
    if (currentQuote) selected = { ...selected, currentQuote };
    else if (selected.currentQuote) { selected = { ...selected }; delete selected.currentQuote; }
    const exactFinal = validReplayAccountingFinal(selected), lastAccounting = selected.replayAccounting?.events.at(-1);
    const endingAccountingKnown = lastAccounting && ['remainingTokenAmount', 'remainingCostBasisUsd', 'cumulativeRealizedProfitUsd',
      'investedUsd', 'soldUsd', 'transferOutIncomeUsd', 'feesUsd', 'feeInclusiveCostUsd'].every(field => {
      const value = lastAccounting[field as keyof typeof lastAccounting];
      return typeof value === 'number' && Number.isFinite(value);
    });
    const accountingKnown = Boolean(exactFinal || replayAccountingIsFresh(selected) && endingAccountingKnown && lastAccounting!.feeInclusiveCostUsd! > 0);
    const points = selected.chart.points, first = Date.parse(selected.trades[0]?.timestamp ?? '');
    const recognizedHistory = ['GMGN historical samples', 'GeckoTerminal historical samples', 'Historical market samples'].includes(selected.chart.source);
    const realHistory = recognizedHistory && points.length > 1
      && Date.parse(points[0].timestamp) <= first && Date.parse(points.at(-1)!.timestamp) >= replayEndTimestamp(selected);
    const markedPrice = currentQuote?.priceUsd ?? points.at(-1)?.priceUsd;
    const estimatedProfit = endingAccountingKnown ? lastAccounting!.cumulativeRealizedProfitUsd!
      + (lastAccounting!.remainingTokenAmount === 0 ? 0 : lastAccounting!.remainingTokenAmount! * (markedPrice ?? NaN))
      - lastAccounting!.remainingCostBasisUsd! : NaN;
    const ready = replayInventoryIsFresh(selected) && accountingKnown && Boolean(exactFinal || Number.isFinite(estimatedProfit)) && realHistory
      && (selected.position.status === 'closed' || open && Boolean(currentQuote));
    const pending = activity.pending || history.pending || request.signal.aborted;
    const preparationStatus = ready ? 'ready' : pending ? 'pending' : 'unavailable';
    let notice = history.notice;
    if (notice === 'Historical market data is unavailable for this replay.' && replayUsesRecordedPrices(selected)) notice = currentQuote ? currentQuoteEstimateNotice : recordedPriceEstimateNotice;
    return { data: selected, notice, preparationStatus,
      ...(preparationStatus === 'pending' ? { retryAfterMs: Math.max(1000, activity.retryAfterMs ?? 0, history.retryAfterMs ?? 0) } : {}),
      ...(open && !currentQuote ? { currentPriceNotice: currentPriceUnavailableNotice } : {}),
      ...(selected.inventory && !replayInventoryIsFresh(selected) ? { inventoryNotice: inventoryUnavailableNotice } : {}),
      accountingNotice: exactFinal ? accountingExactNotice : accountingKnown ? accountingEstimateNotice : accountingUnavailableNotice };
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', abort);
  }
}
