import type { ReplayMarketChart } from '../shared/replayChart';
import { applyReplayMarketChart, type TradeReplayData } from './tradeReplayData';

const preparationBudgetMs = 22_000;
const maximumAttempts = 6;
const addressPattern = /^0x[0-9a-f]{40}$/i;
export const recordedPriceEstimateNotice = 'Market history is unavailable. Estimated P&L uses recorded trade prices.';

export function replayUsesRecordedPrices(data: TradeReplayData) {
  return data.source.chart.toLowerCase().includes('recorded fill') || !data.chart.points.length;
}

export interface ReplayMarketRequestResult {
  data: TradeReplayData;
  notice: string | null;
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
  const fallback = (notice: string): ReplayMarketRequestResult => ({ data,
    notice: notice === 'Historical market data is unavailable for this replay.' && replayUsesRecordedPrices(data)
      ? recordedPriceEstimateNotice : notice });
  const url = `/api/kols/${encodeURIComponent(data.kol.address)}/tokens/${encodeURIComponent(data.token.address)}/replay-chart`;
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
      const selected = applyReplayMarketChart(data, chart);
      return selected === data ? fallback('Historical market data is unavailable for this replay.')
        : { data: selected, notice: chart.sparseHistory ? 'Market observations are sparse. Prices and P&L between observations are estimates.' : null };
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
