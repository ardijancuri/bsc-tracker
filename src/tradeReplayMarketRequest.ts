import type { ReplayMarketChart } from '../shared/replayChart';
import { applyReplayMarketChart, replayIsOpen, validReplayCurrentQuote, type TradeReplayData } from './tradeReplayData';
export { replayIsOpen } from './tradeReplayData';

const preparationBudgetMs = 22_000;
const maximumAttempts = 6;
const addressPattern = /^0x[0-9a-f]{40}$/i;
export const recordedPriceEstimateNotice = 'Market history is unavailable. Estimated P&L uses recorded trade prices.';
export const currentQuoteEstimateNotice = 'Market history is unavailable. Prices between recorded trades and the current quote are estimates.';
export const currentPriceUnavailableNotice = 'Current market price is unavailable. This replay ends at the last recorded trade.';

export function replayUsesRecordedPrices(data: TradeReplayData) {
  return data.source.chart.toLowerCase().includes('recorded fill') || !data.chart.points.length;
}

export interface ReplayMarketRequestResult {
  data: TradeReplayData;
  notice: string | null;
  currentPriceNotice?: string;
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
    const open = replayIsOpen(selected), currentQuote = validReplayCurrentQuote(selected);
    if (!currentQuote && selected.currentQuote) { selected = { ...selected }; delete selected.currentQuote; }
    return { data: selected, notice, ...(open && !currentQuote ? { currentPriceNotice: currentPriceUnavailableNotice } : {}) };
  };
  const fallback = (notice: string): ReplayMarketRequestResult => result(available,
    notice === 'Historical market data is unavailable for this replay.' && replayUsesRecordedPrices(available)
      ? validReplayCurrentQuote(available) ? currentQuoteEstimateNotice : recordedPriceEstimateNotice : notice);
  const url = `/api/kols/${encodeURIComponent(data.kol.address)}/tokens/${encodeURIComponent(data.token.address)}/replay-chart${replayIsOpen(data) ? '?end=current' : ''}`;
  try {
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
