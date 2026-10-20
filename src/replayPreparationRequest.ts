import type { ReplayPreparation, ReplayPreparationReason } from '../shared/replayPreparation';
import { replayPreparationMessages } from '../shared/replayPreparation';
import { tradeActivityBase, tradeRequestHeaders } from './tradeRequestContext';
import { applyReplayMarketChart, prepareTradeReplayData, type TradeReplayData } from './tradeReplayData';
import { capturedPositionDescription } from './nodeAccountingScope';
import { t } from './i18n';

export interface ReplayMarketRequestResult {
  data: TradeReplayData; notice: string | null; currentPriceNotice?: string; inventoryNotice?: string; accountingNotice?: string;
  preparationStatus: 'ready' | 'pending' | 'unavailable'; blockingReason?: ReplayPreparationReason; retryAfterMs?: number;
}
function withoutApproval(data: TradeReplayData): TradeReplayData {
  return { ...data, replayAccounting: data.replayAccounting ? { ...data.replayAccounting, status: 'unavailable', final: null,
    coverage: { ...data.replayAccounting.coverage, exactFinal: false, transactionsComplete: false, balanceMatched: false } } : undefined };
}

/** One database preparation read. The sole outer poll joins server work; no
 * nested activity/chart retries or financial-provider requests exist here. */
export async function replayMarketData(data: TradeReplayData, signal: AbortSignal): Promise<ReplayMarketRequestResult> {
  // An old media lease must not pin every retry to the same expired valuation.
  // Rebind accounting and chart together; onResult updates the modal as well.
  const snapshotFresh = data.accountingSnapshot && Date.now() - Date.parse(data.accountingSnapshot.asOf) <= 180_000;
  const context = data.requestContext && !snapshotFresh ? { ...data.requestContext, snapshotId: undefined } : data.requestContext;
  const frozen = context?.snapshotId ?? (!context && snapshotFresh && data.accountingSnapshot?.complete ? data.accountingSnapshot.snapshotId : undefined);
  const query = frozen ? `?snapshot=${encodeURIComponent(frozen)}` : '';
  const response = await fetch(`${tradeActivityBase(data.kol.address, data.token.address, context)}/replay-preparation${query}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), cache: 'no-store', headers: tradeRequestHeaders(context),
  });
  if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
  if (response.status === 410 || response.status === 404 && frozen) return { data: { ...withoutApproval(data), accountingSnapshot: undefined,
    requestContext: context ? { ...context, snapshotId: undefined } : undefined }, notice: replayPreparationMessages.accounting_pending,
    preparationStatus: 'pending', blockingReason: 'accounting_pending', retryAfterMs: 1000 };
  if (!response.ok) return { data: withoutApproval(data), notice: response.status === 403 || response.status === 401 ? 'Portfolio access changed. Close this replay and try again.' : 'Replay preparation is temporarily unavailable.',
    preparationStatus: [429, 502, 503, 504].includes(response.status) ? 'pending' : 'unavailable', blockingReason: 'accounting_pending', retryAfterMs: 2000 };
  const result = await response.json() as ReplayPreparation;
  if (result.version !== 2 || !['ready', 'pending', 'unavailable'].includes(result.status)) throw new Error('Invalid replay preparation response');
  const activity = result.activity;
  if (activity && (activity.kol.address.toLowerCase() !== data.kol.address.toLowerCase() || activity.token.address.toLowerCase() !== data.token.address.toLowerCase())) throw new Error('Replay identity changed');
  const privateSnapshot = (activity as import('../shared/journal').JournalTokenActivity | undefined)?.journal?.snapshotId;
  const selectedContext = context && privateSnapshot ? { ...context, snapshotId: privateSnapshot } : context;
  const selected = activity ? prepareTradeReplayData(activity, null, undefined, Date.now(), selectedContext) ?? data : data;
  if (result.status !== 'ready') return { data: selected, notice: result.reason ? replayPreparationMessages[result.reason] : null,
    preparationStatus: result.status, blockingReason: result.reason, retryAfterMs: result.retryAfterMs };
  const chart = result.chart, identity = activity?.accountingSnapshot;
  if (!activity || !chart || !identity || !identity.complete || !selected.replayAccounting || !result.window
    || result.snapshotId !== identity.snapshotId || chart.snapshotId !== result.snapshotId || chart.windowId !== result.window.id
    || !/^[a-f0-9]{64}$/.test(result.window.id) || chart.address.toLowerCase() !== data.token.address.toLowerCase()
    || !['node', 'mixed', 'imported'].includes(chart.source) || chart.partialHistory || chart.stale
    || !Number.isFinite(Date.parse(result.window.from)) || !Number.isFinite(Date.parse(result.window.to))
    || Date.parse(result.window.from) > Date.parse(result.window.to)) throw new Error('Replay snapshot and market window do not agree');
  const prepared = applyReplayMarketChart(selected, chart);
  if (!prepared.chart.points.length || !prepared.replayAccounting?.final) throw new Error('Replay snapshot could not be rendered');
  return { data: prepared, notice: chart.sparseHistory ? 'Market observations are sparse. Prices and profit between observations are estimates.' : null,
    accountingNotice: `${capturedPositionDescription(identity) ?? `${identity.source === 'node' ? 'Node' : identity.source === 'mixed' ? 'Node and imported' : 'Imported'} accounting.`} ${t('Historical frames are estimates; the ending uses the frozen position valuation.')}`, preparationStatus: 'ready' };
}
