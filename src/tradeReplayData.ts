import type { Position, TokenChart } from '../shared/intelligence';
import type { InventoryCoverage, InventoryEvent, KolTokenActivity } from '../shared/kolTokenTrades';
import type { Kol, Token } from './types';
import type { ReplayMarketChart } from '../shared/replayChart';
import type { ReplayAccountingEvent, ReplayAccountingFinal, ReplayAccountingSnapshot, TradeReplayAccounting } from '../shared/tradeReplayAccounting';
import { prepareGmgnReplayHistory } from './tradeReplayHistory';

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

type InventoryNumberField = 'tokenAmount' | 'remainingTokenAmount' | 'remainingCostBasisUsd' | 'cumulativeRealizedProfitUsd' | 'investedUsd' | 'soldUsd';
export type ReplayInventoryEvent = Omit<InventoryEvent, InventoryNumberField | 'blockNumber'> & Record<InventoryNumberField, number | null> & { blockNumber: string | null };
export interface ReplayInventory {
  version: 1;
  events: ReplayInventoryEvent[];
  coverage: InventoryCoverage & { verification?: 'gmgn_history' };
}
type AccountingNumbers = { [Key in keyof ReplayAccountingSnapshot]: number | null };
export type ReplayAccounting = Omit<TradeReplayAccounting, 'events' | 'final'> & {
  events: (Omit<ReplayAccountingEvent, keyof ReplayAccountingSnapshot | 'blockNumber'> & AccountingNumbers & { blockNumber: string | null })[];
  final: (Omit<ReplayAccountingFinal, keyof ReplayAccountingSnapshot | 'reportedProfitUsd' | 'reportedRoi' | 'priceUsd'> & AccountingNumbers
    & { reportedProfitUsd: number | null; reportedRoi: number | null; priceUsd: number | null }) | null;
};

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
  inventory?: ReplayInventory;
  replayAccounting?: ReplayAccounting;
}

export type ReplayActivity = KolTokenActivity;

// Server retrieval/check metadata can lead the client's clock slightly. This
// tolerance never applies to chain movements, executions or historical bars.
const serverClockSkewMs = 1000;

export function unavailableReplayAccounting(data: { kol: { address: string }; token: { address: string } }, reason: string, now = Date.now()): ReplayAccounting {
  return { version: 1, source: 'gmgn', policy: 'gmgn_total_profit_v1', walletAddress: data.kol.address, tokenAddress: data.token.address,
    status: 'unavailable', checkedAt: new Date(now).toISOString(), inventoryBlockNumber: null, inventoryBlockHash: null,
    events: [], final: null, coverage: { transactionsComplete: false, balanceMatched: false, exactFinal: false, reason } };
}

export function replayAccountingIsFresh(data: Pick<TradeReplayData, 'replayAccounting'>, now = Date.now()) {
  const accounting = data.replayAccounting, time = Date.parse(accounting?.checkedAt ?? '');
  return Boolean(accounting && ['ready', 'estimated'].includes(accounting.status)
    && accounting.coverage.transactionsComplete && accounting.coverage.balanceMatched
    && Number.isFinite(time) && time <= now + serverClockSkewMs && now - time <= 180_000);
}

/** Total profit does not depend on how GMGN allocates cost between disposed
 * and held lots. Use the complete fee-inclusive cash flows when those are
 * known, even if its realized/unrealized split cannot be established. */
export function replayAccountingTotal(snapshot: AccountingNumbers | null | undefined, priceUsd: number | null | undefined): number | null {
  if (!snapshot) return null;
  const { remainingTokenAmount: quantity, investedUsd: invested, soldUsd: sold,
    transferOutIncomeUsd: transferred, feesUsd: fees, feeInclusiveCostUsd: cost } = snapshot;
  if ([quantity, invested, sold, transferred, fees, cost].some(value => value === null || !Number.isFinite(value) || value < 0)
    || quantity! > 0 && (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0)) return null;
  const tolerance = Math.max(1e-6, Math.max(cost!, invested! + fees!) * 1e-8);
  if (cost! + tolerance < invested! + fees!) return null;
  const value = quantity === 0 ? 0 : quantity! * priceUsd!;
  const total = sold! + transferred! + value - cost!;
  return Number.isFinite(total) ? total : null;
}

export function validReplayAccountingFinal(data: TradeReplayData, now = Date.now()) {
  const accounting = data.replayAccounting, final = accounting?.final;
  if (!final || accounting?.status !== 'ready' || !accounting.coverage.exactFinal || !replayAccountingIsFresh(data, now)
    || !replayInventoryIsFresh(data, now)) return null;
  const time = Date.parse(final.timestamp);
  if (!Number.isFinite(time) || time < replayEndTimestamp(data) || time > now + serverClockSkewMs || now - time > 180_000) return null;
  if (!accountingFinalMatches(final)) return null;
  return final;
}

function accountingFinalMatches(final: NonNullable<ReplayAccounting['final']>) {
  const { remainingTokenAmount: quantity, remainingCostBasisUsd: basis, cumulativeRealizedProfitUsd: realized,
    investedUsd: invested, soldUsd: sold, transferOutIncomeUsd: transferred, feesUsd: fees,
    feeInclusiveCostUsd: cost, reportedProfitUsd: profit, reportedRoi: roi, priceUsd: price } = final;
  if (quantity === null || basis === null || realized === null || invested === null || sold === null || transferred === null || fees === null || cost === null || profit === null || roi === null
    || quantity > 0 && price === null) return false;
  const value = quantity === 0 ? 0 : quantity * price!;
  const matches = (left: number, right: number) => Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= Math.max(1e-6, Math.max(Math.abs(left), Math.abs(right)) * 1e-8);
  const costTolerance = Math.max(1e-6, Math.max(cost, invested + fees) * 1e-8);
  return cost + costTolerance >= invested + fees
    && matches(profit, realized + value - basis) && matches(profit, sold + transferred + value - cost) && matches(profit, roi * cost);
}

function canonicalDecimal(value: unknown) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fractional = ''] = value.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fractional.replace(/0+$/, '')}`;
}

function prepareReplayAccounting(activity: ReplayActivity, trades: ReplayTrade[], inventory: ReplayInventory | undefined, now: number): ReplayAccounting | undefined {
  const raw = activity.replayAccounting;
  if (!raw) return undefined;
  const unavailable = (reason: string) => unavailableReplayAccounting(activity, reason, now);
  const checkedAt = Date.parse(raw.checkedAt);
  if (raw.version !== 1 || raw.source !== 'gmgn' || raw.policy !== 'gmgn_total_profit_v1'
    || raw.walletAddress?.toLowerCase() !== activity.kol.address.toLowerCase() || raw.tokenAddress?.toLowerCase() !== activity.token.address.toLowerCase()
    || !['ready', 'estimated', 'pending', 'unavailable'].includes(raw.status)
    || !Number.isFinite(checkedAt) || checkedAt > now + serverClockSkewMs || now - checkedAt > 180_000 || !raw.coverage || !Array.isArray(raw.events)) return unavailable('invalid_gmgn_accounting');
  if (raw.status === 'pending' || raw.status === 'unavailable') return { ...raw, events: [], final: null,
    coverage: { ...raw.coverage, transactionsComplete: false, balanceMatched: false, exactFinal: false } };
  if (raw.history || raw.coverage.verification === 'gmgn_history') return unavailable('invalid_gmgn_history');
  if (!replayInventoryIsFresh({ inventory }, now) || raw.inventoryBlockNumber !== inventory!.coverage.toBlock
    || raw.inventoryBlockHash?.toLowerCase() !== inventory!.coverage.blockHash?.toLowerCase()
    || raw.coverage.transactionsComplete !== true || raw.coverage.balanceMatched !== true) return unavailable('unverified_gmgn_accounting');
  const numberFields: (keyof ReplayAccountingSnapshot)[] = ['remainingTokenAmount', 'remainingCostBasisUsd', 'cumulativeRealizedProfitUsd',
    'investedUsd', 'soldUsd', 'transferOutIncomeUsd', 'feesUsd', 'feeInclusiveCostUsd'];
  let valid = true;
  const snapshot = (value: ReplayAccountingSnapshot): AccountingNumbers => Object.fromEntries(numberFields.map(field => {
    const parsed = field === 'cumulativeRealizedProfitUsd' ? replaySignedNumber(value[field]) : replayNumber(value[field], true);
    if (value[field] !== null && parsed === null) valid = false;
    return [field, parsed];
  })) as AccountingNumbers;
  const canonical = new Map(inventory!.events.map(event => [event.id, event]));
  const rawInventory = new Map(activity.inventory!.events.map(event => [event.id, event]));
  const seen = new Set<string>();
  const events: ReplayAccounting['events'] = [];
  for (const event of raw.events) {
    const expected = canonical.get(event?.id), original = rawInventory.get(event?.id), time = Date.parse(event?.timestamp);
    if (!event || !expected || seen.has(event.id) || event.kind !== expected.kind || event.tradeId !== expected.tradeId
      || event.txHash?.toLowerCase() !== expected.txHash.toLowerCase() || !Number.isFinite(time) || time > now || time > checkedAt
      || time !== Date.parse(expected.timestamp) || event.blockNumber !== expected.blockNumber
      || event.transactionIndex !== expected.transactionIndex || event.logIndex !== expected.logIndex
      || canonicalDecimal(event.remainingTokenAmount) === null || canonicalDecimal(event.remainingTokenAmount) !== canonicalDecimal(original?.remainingTokenAmount)) {
      valid = false; continue;
    }
    seen.add(event.id); events.push({ ...event, ...snapshot(event) });
  }
  if (seen.size !== canonical.size) valid = false;
  const order = new Map(inventory!.events.map((event, index) => [event.id, index]));
  events.sort((left, right) => order.get(left.id)! - order.get(right.id)!);
  let final: ReplayAccounting['final'] = null;
  if (raw.final) {
    const time = Date.parse(raw.final.timestamp), quantity = canonicalDecimal(raw.final.remainingTokenAmount);
    const reportedProfitUsd = replaySignedNumber(raw.final.reportedProfitUsd), reportedRoi = replaySignedNumber(raw.final.reportedRoi);
    const priceUsd = replayNumber(raw.final.priceUsd);
    if (!Number.isFinite(time) || time < replayEndTimestamp({ trades, inventory })
      || time > now + serverClockSkewMs || now - time > 180_000 || quantity === null || quantity !== canonicalDecimal(inventory!.coverage.balance)
      || raw.final.reportedProfitUsd !== null && reportedProfitUsd === null || raw.final.reportedRoi !== null && reportedRoi === null
      || raw.final.priceUsd !== null && priceUsd === null || quantity !== '0.' && priceUsd === null) valid = false;
    final = { ...raw.final, ...snapshot(raw.final), reportedProfitUsd, reportedRoi, priceUsd };
  }
  if (!valid || raw.coverage.exactFinal && (raw.status !== 'ready' || !final || !accountingFinalMatches(final))) return unavailable('invalid_gmgn_accounting_events');
  return { ...raw, events, final, coverage: { ...raw.coverage, exactFinal: raw.coverage.exactFinal === true && final !== null } };
}

/** Checked ending balances win; otherwise use only complete, consistent recorded quantities. */
export function replayIsOpen(data: Pick<TradeReplayData, 'position' | 'source' | 'trades' | 'inventory'>): boolean {
  if (data.position.status === 'open' || data.position.status === 'closed') return data.position.status === 'open';
  if (data.inventory) return data.inventory.coverage.complete && data.inventory.coverage.reconciled
    && (data.inventory.events.at(-1)?.remainingTokenAmount ?? 0) > 0;
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

export function replayEndTimestamp(data: Pick<TradeReplayData, 'trades' | 'inventory'>): number {
  let end = -Infinity;
  for (const event of [...data.trades, ...(data.inventory?.events ?? [])]) {
    const time = Date.parse(event.timestamp);
    if (Number.isFinite(time)) end = Math.max(end, time);
  }
  return end;
}

export function replayInventoryIsFresh(data: Pick<TradeReplayData, 'inventory'>, now = Date.now()): boolean {
  const checkedAt = Date.parse(data.inventory?.coverage.checkedAt ?? '');
  return Boolean(data.inventory && data.inventory.coverage.complete && data.inventory.coverage.reconciled
    && Number.isFinite(checkedAt) && checkedAt <= now + serverClockSkewMs && now - checkedAt <= 180_000);
}

function prepareReplayInventory(activity: ReplayActivity, trades: ReplayTrade[], complete: boolean, now: number): ReplayInventory | undefined {
  const inventory = activity.inventory;
  if (!inventory) return undefined;
  const coverage = { ...inventory.coverage };
  let valid = inventory.version === 1 && complete && Array.isArray(inventory.events)
    && typeof coverage.complete === 'boolean' && typeof coverage.reconciled === 'boolean'
    && /^0x[0-9a-f]{40}$/i.test(activity.kol.address) && /^0x[0-9a-f]{40}$/i.test(activity.token.address);
  const from = /^\d+$/.test(coverage.fromBlock ?? '') ? BigInt(coverage.fromBlock!) : null;
  const to = /^\d+$/.test(coverage.toBlock ?? '') ? BigInt(coverage.toBlock!) : null;
  const checkedAt = Date.parse(coverage.checkedAt ?? '');
  const fresh = Number.isFinite(checkedAt) && checkedAt <= now + serverClockSkewMs && now - checkedAt <= 180_000;
  if (from === null || to === null || from > to || !/^0x[0-9a-f]{64}$/i.test(coverage.blockHash ?? '') || !fresh) valid = false;
  if (coverage.scannedThroughBlock != null && (!/^\d+$/.test(coverage.scannedThroughBlock)
    || to === null || BigInt(coverage.scannedThroughBlock) !== to)) valid = false;
  if (coverage.initialBalanceSource === null && coverage.complete) valid = false;
  if (coverage.status != null && coverage.status !== 'verified' && (coverage.complete || coverage.reconciled)) valid = false;
  const ids = new Set<string>(), matched = new Set<string>(), transferLogs = new Set<string>();
  const tradeById = new Map(trades.map(trade => [trade.id, trade]));
  const sourceTradeById = new Map(activity.trades.map(trade => [trade.id, trade]));
  const swapTransactions = new Set(trades.map(trade => trade.txHash.toLowerCase()));
  const events: ReplayInventoryEvent[] = [];
  const numberFields: InventoryNumberField[] = ['tokenAmount', 'remainingTokenAmount', 'remainingCostBasisUsd', 'cumulativeRealizedProfitUsd', 'investedUsd', 'soldUsd'];
  for (const event of Array.isArray(inventory.events) ? inventory.events : []) {
    if (!event || typeof event !== 'object') { valid = false; continue; }
    const time = Date.parse(event.timestamp), block = /^\d+$/.test(event.blockNumber ?? '') ? BigInt(event.blockNumber) : null;
    const ordinal = (value: number | null) => value === null || Number.isSafeInteger(value) && value >= 0;
    if (typeof event.id !== 'string' || !event.id || ids.has(event.id) || !/^0x[0-9a-f]{64}$/i.test(event.txHash ?? '') || !['buy', 'sell', 'transfer_in', 'transfer_out'].includes(event.kind)
      || !Number.isFinite(time) || time > now || Number.isFinite(checkedAt) && time > checkedAt
      || block === null || from !== null && block < from || to !== null && block > to
      || !ordinal(event.transactionIndex) || !ordinal(event.logIndex)) { valid = false; continue; }
    ids.add(event.id);
    const numbers = {} as Record<InventoryNumberField, number | null>;
    for (const field of numberFields) {
      const raw = event[field];
      const parsed = field === 'cumulativeRealizedProfitUsd' ? replaySignedNumber(raw) : replayNumber(raw, field !== 'tokenAmount');
      numbers[field] = parsed;
      if (raw !== null && parsed === null) valid = false;
    }
    if (numbers.tokenAmount === null || numbers.remainingTokenAmount === null) valid = false;
    if (event.kind === 'buy' || event.kind === 'sell') {
      const trade = event.tradeId ? tradeById.get(event.tradeId) : undefined;
      const sourceTrade = trade ? sourceTradeById.get(trade.id) : undefined;
      if (!trade || matched.has(trade.id) || trade.side !== event.kind || trade.txHash.toLowerCase() !== event.txHash.toLowerCase()
        || Date.parse(trade.timestamp) !== time || trade.tokenAmount !== numbers.tokenAmount
        || canonicalDecimal(sourceTrade?.tokenAmount) === null || canonicalDecimal(sourceTrade?.tokenAmount) !== canonicalDecimal(event.tokenAmount)
        || sourceTrade?.blockNumber === null || !/^\d+$/.test(sourceTrade?.blockNumber ?? '') || BigInt(sourceTrade!.blockNumber!) !== block
        || sourceTrade?.transactionIndex != null && sourceTrade.transactionIndex !== event.transactionIndex) { valid = false; continue; }
      matched.add(trade.id);
    } else {
      const log = `${block}:${event.txHash.toLowerCase()}:${event.logIndex}`;
      if (event.tradeId || event.logIndex === null || transferLogs.has(log) || swapTransactions.has(event.txHash.toLowerCase())) { valid = false; continue; }
      transferLogs.add(log);
    }
    events.push({ ...event, ...numbers });
  }
  events.sort((a, b) => {
    const block = BigInt(a.blockNumber!) - BigInt(b.blockNumber!);
    return (block < 0n ? -1 : block > 0n ? 1 : 0) || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0)
      || (a.logIndex ?? -1) - (b.logIndex ?? -1) || a.id.localeCompare(b.id);
  });
  if (matched.size !== trades.length || !events.length) valid = false;
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1], current = events[index];
    if (Date.parse(current.timestamp) < Date.parse(previous.timestamp)) valid = false;
    if (BigInt(current.blockNumber!) === BigInt(previous.blockNumber!) && current.txHash.toLowerCase() !== previous.txHash.toLowerCase()
      && (current.transactionIndex === null || previous.transactionIndex === null || current.transactionIndex === previous.transactionIndex)) valid = false;
  }
  const balance = replayNumber(coverage.balance, true), remaining = events.at(-1)?.remainingTokenAmount;
  const finalRaw = (Array.isArray(inventory.events) ? inventory.events : []).find(event => event?.id === events.at(-1)?.id)?.remainingTokenAmount;
  if (balance === null || remaining == null || canonicalDecimal(coverage.balance) === null || canonicalDecimal(coverage.balance) !== canonicalDecimal(finalRaw)) valid = false;
  if (!valid) {
    coverage.complete = coverage.reconciled = false;
    coverage.reason = coverage.reason ?? (fresh ? 'invalid_inventory_events' : 'stale_inventory_snapshot');
  }
  return { version: 1, events, coverage };
}

function checkedCurrentQuote(data: TradeReplayData, quote: { timestamp: string; priceUsd: number | string } | undefined, supply: number | null, now: number) {
  if (!quote || !replayIsOpen(data)) return undefined;
  const time = Date.parse(quote.timestamp), price = replayNumber(quote.priceUsd);
  const lastFill = replayEndTimestamp(data);
  if (price === null || !Number.isFinite(time) || !Number.isFinite(lastFill) || time < lastFill || time > now + serverClockSkewMs || now - time > 180_000) return undefined;
  return { timestamp: new Date(time).toISOString(), priceUsd: price, marketCapUsd: scaledPrice(price, supply) };
}

export function validReplayCurrentQuote(data: TradeReplayData, now = Date.now()) {
  const final = validReplayAccountingFinal(data, now);
  return checkedCurrentQuote(data, final?.priceUsd ? { timestamp: final.timestamp, priceUsd: final.priceUsd } : undefined, data.chart.marketCapSupply, now)
    ?? checkedCurrentQuote(data, data.currentQuote, data.chart.marketCapSupply, now);
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
  const accountingFinal = validReplayAccountingFinal(data, now);
  const providerQuote = accountingFinal?.priceUsd ? { timestamp: accountingFinal.timestamp, priceUsd: accountingFinal.priceUsd } : undefined;
  const currentQuote = checkedCurrentQuote(data, providerQuote, supply, now)
    ?? checkedCurrentQuote(data, chart.currentQuote, supply, now) ?? checkedCurrentQuote(data, data.currentQuote, supply, now);
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
  const first = Date.parse(data.trades[0].timestamp), last = replayEndTimestamp(data);
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
  const history = prepareGmgnReplayHistory(activity, complete, now);
  const inventory = history?.inventory ?? prepareReplayInventory(activity, trades, complete, now);
  const replayAccounting = history?.accounting ?? prepareReplayAccounting(activity, trades, inventory, now);
  const inventoryTrusted = replayInventoryIsFresh({ inventory }, now);
  const validPosition = position?.walletAddress.toLowerCase() === kol.address.toLowerCase()
    && position?.tokenAddress.toLowerCase() === token.address.toLowerCase() && position?.status !== 'Unknown';
  const checkedAt = validPosition && position?.checkedAt ? Date.parse(position.checkedAt) : NaN;
  const fresh = Number.isFinite(checkedAt) && now - checkedAt <= 180_000 && now - checkedAt >= -60_000;
  const balance = inventory ? inventoryTrusted ? replayNumber(inventory.coverage.balance, true) : null
    : fresh ? replayNumber(position?.balance, true) : null;
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
    tokenBalance: balance, tradeFlowMatched: flowMatched, tradesComplete: complete,
    checkedAt: inventoryTrusted ? inventory!.coverage.checkedAt : !inventory && fresh ? position?.checkedAt ?? null : null };
  const open = replayIsOpen({ trades, position: replayPosition, source: { chart: '', tradesComplete: complete }, inventory });
  const replayEnd = replayEndTimestamp({ trades, inventory });

  const pointsByTime = new Map<number, TradeReplayData['chart']['points'][number]>();
  const addPoint = (time: number, rawPrice: unknown) => {
    const price = replayNumber(rawPrice);
    if (Number.isFinite(time) && time <= now && price) pointsByTime.set(time, { timestamp: new Date(time).toISOString(), priceUsd: price, marketCapUsd: scaledPrice(price, supply) });
  };
  if (selectedChart && selectedChart.source !== 'quote' && selectedChart.source !== 'unavailable') {
    // The app's convenience points place candle closes at their opening times.
    // Use the underlying completed candles for the replay's exact event timeline.
    if (selectedChart.candles.length) {
      const run = completedCandleRun(selectedChart, Date.parse(trades[0]?.timestamp ?? ''), replayEnd, now);
      if (run) for (const [index, candle] of run.candles.entries()) {
        if (index === 0) addPoint(candle.time * 1000, candle.open);
        addPoint((candle.time + run.seconds) * 1000, candle.close);
      }
    } else for (const point of selectedChart.points) addPoint(Date.parse(point.timestamp), point.priceUsd);
  }
  let points = [...pointsByTime.entries()].sort((a, b) => a[0] - b[0]).map(([, point]) => point);
  // Recent-only charts must never be extrapolated backward as historical prices.
  if (trades.length && (Date.parse(points[0]?.timestamp ?? '') > Date.parse(trades[0].timestamp)
    || Date.parse(points.at(-1)?.timestamp ?? '') < replayEnd)) points = [];
  // Closed recaps stop at their final wallet movement. Open recaps may preserve actual
  // later observations; a separate fresh currentQuote is still required to
  // claim a current endpoint. Activity token fields never supply that quote.
  if (points.length && trades.length) {
    for (const timestamp of [trades[0].timestamp, trades.at(-1)!.timestamp, new Date(replayEnd).toISOString()]) {
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
    const last = points.findIndex(point => Date.parse(point.timestamp) === replayEnd);
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
    ...(inventory ? { inventory } : {}),
    ...(replayAccounting ? { replayAccounting } : {}),
  };
}
