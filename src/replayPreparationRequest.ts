import type { ReplayPreparation, ReplayPreparationReason } from '../shared/replayPreparation';
import { replayPreparationMessages } from '../shared/replayPreparation';
import { tradeActivityBase, tradeRequestHeaders } from './tradeRequestContext';
import { applyReplayMarketChart, prepareTradeReplayData, type TradeReplayData } from './tradeReplayData';
import { capturedPositionDescription } from './nodeAccountingScope';
import { t } from './i18n';
import{validNodeCostEstimate,nodeCostEstimateNote}from'../shared/nodeCostEstimate';

export interface ReplayMarketRequestResult {
  data: TradeReplayData; notice: string | null; currentPriceNotice?: string; inventoryNotice?: string; accountingNotice?: string;
  preparationStatus: 'ready' | 'pending' | 'unavailable'; blockingReason?: ReplayPreparationReason; retryAfterMs?: number;
}
function withoutApproval(data: TradeReplayData): TradeReplayData {
  return { ...data, replayLease: undefined, replayAccounting: data.replayAccounting ? { ...data.replayAccounting, status: 'unavailable', final: null,
    coverage: { ...data.replayAccounting.coverage, exactFinal: false, transactionsComplete: false, balanceMatched: false } } : undefined };
}

/** The server checks signatures, correction epochs and current private access.
 * The browser never treats decoding the manifest as financial authorization. */
export async function validatePreparedTradeReplay(data: TradeReplayData, signal?: AbortSignal): Promise<void> {
  const lease = data.replayLease;
  if (!lease) return;
  if (!Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= Date.now()) throw new Error('Replay approval expired. Retry replay.');
  let response: Response;
  try {
    response = await fetch('/api/replays/validate', { method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...tradeRequestHeaders(data.requestContext) },
      body: JSON.stringify({ manifest: lease.manifest }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
  } catch {
    if (signal?.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
    throw new Error('Replay approval could not be checked. Retry replay.');
  }
  if (!response.ok) throw new Error('Replay access or accounting changed. Retry replay.');
  const result = await response.json() as { valid?: boolean; expiresAt?: string };
  if (result.valid !== true || result.expiresAt && result.expiresAt !== lease.expiresAt) throw new Error('Replay access or accounting changed. Retry replay.');
}

/** One database preparation read. The sole outer poll joins server work; no
 * nested activity/chart retries or financial-provider requests exist here. */
export async function replayMarketData(data: TradeReplayData, signal: AbortSignal): Promise<ReplayMarketRequestResult> {
  // An old media lease must not pin every retry to the same expired valuation.
  // Rebind accounting and chart together; onResult updates the modal as well.
  const snapshotFresh = data.accountingSnapshot && (Date.now() - Date.parse(data.accountingSnapshot.asOf) <= 180_000
    || data.accountingSnapshot.source === 'node' && data.accountingSnapshot.complete && Date.now() - Date.parse(data.generatedAt) <= 180_000
    || data.replayLease && Date.parse(data.replayLease.expiresAt) > Date.now());
  const context = data.requestContext && !snapshotFresh ? { ...data.requestContext, snapshotId: undefined } : data.requestContext;
  const frozen = context?.snapshotId ?? (!context && snapshotFresh &&(data.accountingSnapshot?.complete||validNodeCostEstimate(data.accountingSnapshot)) ? data.accountingSnapshot!.snapshotId : undefined);
  const query = frozen ? `?snapshot=${encodeURIComponent(frozen)}` : '';
  const deadline = AbortSignal.timeout(8000);
  const requestSignal = AbortSignal.any([signal, deadline]);
  const pendingRequest = (): ReplayMarketRequestResult => ({ data: withoutApproval(data), notice: replayPreparationMessages.preparation_pending,
    preparationStatus: 'pending', blockingReason: 'preparation_pending', retryAfterMs: 2000 });
  const timedOut = (problem: unknown) => deadline.aborted || problem instanceof Error && problem.name === 'TimeoutError';
  let response: Response;
  try {
    response = await fetch(`${tradeActivityBase(data.kol.address, data.token.address, context)}/replay-preparation${query}`, {
      signal: requestSignal, cache: 'no-store', headers: tradeRequestHeaders(context),
    });
  } catch (problem) {
    if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
    // One slow read must not end the enclosing bounded preparation poll. The
    // server keeps its coalesced work; a retry joins it without export approval.
    if (timedOut(problem) || problem instanceof TypeError) return pendingRequest();
    throw problem;
  }
  if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
  if (response.status === 410 || response.status === 404 && frozen) return { data: { ...withoutApproval(data), accountingSnapshot: undefined,
    requestContext: context ? { ...context, snapshotId: undefined } : undefined }, notice: replayPreparationMessages.accounting_pending,
    preparationStatus: 'pending', blockingReason: 'accounting_pending', retryAfterMs: 1000 };
  if (!response.ok) return { data: withoutApproval(data), notice: response.status === 403 || response.status === 401 ? 'Portfolio access changed. Close this replay and try again.' : 'Replay preparation is temporarily unavailable.',
    preparationStatus: [429, 500, 502, 503, 504].includes(response.status) ? 'pending' : 'unavailable', blockingReason: 'accounting_pending', retryAfterMs: 2000 };
  let result: ReplayPreparation;
  try { result = await response.json() as ReplayPreparation; }
  catch (problem) {
    if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
    // Fetch's signal also covers body consumption. Malformed JSON and contract
    // errors remain failures rather than becoming repeated transport retries.
    if (timedOut(problem)) return pendingRequest();
    throw problem;
  }
  if (signal.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
  if (result.version !== 2 || !['ready', 'pending', 'unavailable'].includes(result.status)) throw new Error('Invalid replay preparation response');
  const activity = result.activity;
  if (activity && (activity.kol.address.toLowerCase() !== data.kol.address.toLowerCase() || activity.token.address.toLowerCase() !== data.token.address.toLowerCase())) throw new Error('Replay identity changed');
  const privateSnapshot = (activity as import('../shared/journal').JournalTokenActivity | undefined)?.journal?.snapshotId;
  const selectedContext = context && privateSnapshot ? { ...context, snapshotId: privateSnapshot } : context;
  let lease: TradeReplayData['replayLease'];
  if (result.manifest !== undefined || result.expiresAt !== undefined) {
    const expires = Date.parse(result.expiresAt ?? '');
    if (typeof result.manifest !== 'string' || !result.manifest || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 15 * 60_000 + 1000) throw new Error('Invalid replay preparation lease');
    const preparedAt = Math.max(...[activity?.generatedAt, activity?.accountingSnapshot?.asOf, activity?.replayAccounting?.checkedAt,
      activity?.replayAccounting?.history?.balanceProof.checkedAt, activity?.replayAccounting?.final?.timestamp].map(value => Date.parse(value ?? '')).filter(Number.isFinite));
    if (!Number.isFinite(preparedAt) || preparedAt > Date.now() + 1000) throw new Error('Invalid replay preparation lease');
    lease = { manifest: result.manifest, expiresAt: result.expiresAt!, preparedAt: new Date(preparedAt).toISOString(), validatedAt: new Date().toISOString() };
    await validatePreparedTradeReplay({ ...data, requestContext: selectedContext, replayLease: lease }, signal);
  }
  // An approved dated object is rendered at its original observation time;
  // the lease permits reuse without changing a quote or accounting value.
  let selected = activity ? prepareTradeReplayData(activity, null, undefined, lease ? Date.parse(lease.preparedAt) : Date.now(), selectedContext, lease) ?? data : data;
  if (lease) selected = { ...selected, replayLease: lease };
  if (result.status !== 'ready') {
    if (result.reason === 'stale_quote') selected = { ...withoutApproval(selected), accountingSnapshot: undefined,
      requestContext: selected.requestContext ? { ...selected.requestContext, snapshotId: undefined } : undefined };
    return { data: selected, notice: result.reason ? replayPreparationMessages[result.reason] : null,
    preparationStatus: result.status, blockingReason: result.reason, retryAfterMs: result.retryAfterMs };
  }
  const chart = result.chart, identity = activity?.accountingSnapshot;
  const estimated=validNodeCostEstimate(identity)&&selected.replayAccounting?.status==='estimated'&&selected.replayAccounting.coverage.estimatedFinal===true&&lease;
  if (!activity || !chart || !identity || !identity.complete&&!estimated || !selected.replayAccounting || !result.window
    || result.snapshotId !== identity.snapshotId || chart.snapshotId !== result.snapshotId || chart.windowId !== result.window.id
    || !/^[a-f0-9]{64}$/.test(result.window.id) || chart.address.toLowerCase() !== data.token.address.toLowerCase()
    || !['node', 'mixed', 'imported', 'gmgn'].includes(chart.source) || chart.source === 'gmgn' && !lease || chart.partialHistory || chart.stale
    || !Number.isFinite(Date.parse(result.window.from)) || !Number.isFinite(Date.parse(result.window.to))
    || Date.parse(result.window.from) > Date.parse(result.window.to)) throw new Error('Replay snapshot and market window do not agree');
  const prepared = applyReplayMarketChart(selected, chart);
  if (!prepared.chart.points.length || !prepared.replayAccounting?.final) throw new Error('Replay snapshot could not be rendered');
  return { data: prepared, notice: chart.sparseHistory ? 'Market observations are sparse. Prices and profit between observations are estimates.' : null,
    accountingNotice: `${estimated?t(nodeCostEstimateNote):capturedPositionDescription(identity) ?? `${identity.source === 'node' ? 'Node' : identity.source === 'mixed' ? 'Node and imported' : 'Imported'} accounting.`} ${t('Historical frames are estimates; the ending uses the frozen position valuation.')}`, preparationStatus: 'ready' };
}
