import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { kolTokenPositionQuoteMaxAgeMs, type KolTokenActivity, type KolTokenRealizedAccounting, type KolTokenProfitPosition } from '../shared/kolTokenTrades.js';
import type { ReplayAccountingSnapshot, TradeReplayAccounting } from '../shared/tradeReplayAccounting.js';
import { currentTradeReplayGmgnAccounting } from './tradeReplayGmgn.js';
import { currentMarketChart } from './tokenChart.js';

type Loader = (activity: KolTokenActivity) => Promise<TradeReplayAccounting>;
interface PositionQuote { priceUsd: string; timestamp: string }
interface PositionQuoteResult { quote?: PositionQuote; reason?: string; retryAfterMs?: number }
type QuoteLoader = (token: string) => Promise<PositionQuoteResult>;
type Entry = { version: 1; fingerprint: string; observedAt: number; expiresAt: number; value: KolTokenRealizedAccounting };
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/i;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const numeric = (value: unknown, signed = false) => {
  if (typeof value !== 'string' || !(signed ? /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i : /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i).test(value)) return null;
  const parsed = Number(value); return Number.isFinite(parsed) && (signed || parsed >= 0) ? parsed : null;
};
const close = (a: number, b: number, relative = 1e-10) => Math.abs(a - b) <= Math.max(1e-8, Math.max(Math.abs(a), Math.abs(b)) * relative);
const sameQuantity = (a: number, b: number) => (a === 0) === (b === 0) && Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-12;
const money = (value: number) => String(Number(value.toPrecision(15)));
const recent = (value: string | null | undefined, now: number) => Number.isFinite(Date.parse(value ?? ''))
  && Date.parse(value!) <= now && now - Date.parse(value!) <= 180_000;

function base(activity: KolTokenActivity, now: number): KolTokenRealizedAccounting {
  return { version: 1, source: 'gmgn', policy: 'gmgn_realized_profit_v1', walletAddress: activity.kol.address.toLowerCase(),
    tokenAddress: activity.token.address.toLowerCase(), status: 'unavailable', checkedAt: new Date(now).toISOString(), realizedProfitUsd: null,
    coverage: { transactionsComplete: false, balanceMatched: false } };
}
function inventoryReady(activity: KolTokenActivity, now: number) {
  const proof = activity.inventory?.coverage, events = activity.inventory?.events;
  return address.test(activity.kol.address.toLowerCase()) && address.test(activity.token.address.toLowerCase()) && activity.coverage.complete
    && proof?.complete && proof.reconciled && recent(proof.checkedAt, now) && /^\d+$/.test(proof.toBlock ?? '') && hash.test(proof.blockHash ?? '')
    && numeric(proof.balance) !== null && !!events?.length && events.length <= 10_000 && events.every(event => /^\d+$/.test(event.blockNumber)
      && BigInt(event.blockNumber) <= BigInt(proof.toBlock!) && Number.isFinite(Date.parse(event.timestamp)) && Date.parse(event.timestamp) <= now
      && numeric(event.tokenAmount) !== null && numeric(event.remainingTokenAmount) !== null);
}
function fingerprint(activity: KolTokenActivity) {
  // A new endpoint block alone does not change historical realized gains. Fresh
  // canonical coverage is checked separately before reusing this exact history.
  return digest({ schema: 2, wallet: activity.kol.address.toLowerCase(), token: activity.token.address.toLowerCase(),
    balance: activity.inventory?.coverage.balance, fromBlock: activity.inventory?.coverage.fromBlock,
    initialBalanceSource: activity.inventory?.coverage.initialBalanceSource, events: activity.inventory?.events,
    trades: activity.trades.map(trade => [trade.id, trade.txHash, trade.blockNumber, trade.transactionIndex, trade.timestamp,
      trade.tokenAmount, trade.quoteTokenAddress, trade.quoteAmount, trade.quoteSymbol, trade.amountUsd, trade.priceUsd, trade.valuationStatus, trade.source]) });
}
function knownCashFlow(snapshot: ReplayAccountingSnapshot | null | undefined, balance: number) {
  if (!snapshot) return false;
  const quantity = numeric(snapshot.remainingTokenAmount);
  const invested = numeric(snapshot.investedUsd), sold = numeric(snapshot.soldUsd), outgoing = numeric(snapshot.transferOutIncomeUsd);
  const fees = numeric(snapshot.feesUsd), cost = numeric(snapshot.feeInclusiveCostUsd);
  return ![quantity, invested, sold, outgoing, fees, cost].some(value => value === null)
    && sameQuantity(quantity!, balance) && cost! + Math.max(1e-8, cost! * 1e-10) >= invested! + fees!;
}
function knownRealized(snapshot: ReplayAccountingSnapshot | null | undefined, balance: number) {
  if (!snapshot || !knownCashFlow(snapshot, balance)) return null;
  const basis = numeric(snapshot.remainingCostBasisUsd), realized = numeric(snapshot.cumulativeRealizedProfitUsd, true);
  const sold = numeric(snapshot.soldUsd)!, outgoing = numeric(snapshot.transferOutIncomeUsd)!, cost = numeric(snapshot.feeInclusiveCostUsd)!;
  if (basis === null || realized === null
    || balance === 0 && basis !== 0
    || !close(realized, sold + outgoing - cost + basis)) return null;
  return snapshot.cumulativeRealizedProfitUsd;
}
const transient = (reason: string | undefined) => typeof reason === 'string' && (/^(provider_(busy|rate_limited|timeout|unavailable)|provider_http_(429|5\d\d)|canonical_snapshot_changed)$/.test(reason)
  || /^(scan_pending|scan_queued|confirmation_pending|unindexed_swap_pending|indexed_snapshot_changed|confirmed_endpoint_stale|inventory_rpc_unavailable|canonical_block_unavailable|canonical_receipt_unavailable|canonical_transaction_unavailable|movement_scan_unavailable)$/.test(reason));

function markedPosition(position: KolTokenProfitPosition, realized: string | null, quote: PositionQuote, source: 'gmgn' | 'market', activity: KolTokenActivity, now: number) {
  const price = numeric(quote.priceUsd), at = Date.parse(quote.timestamp), last = Date.parse(activity.inventory?.events.at(-1)?.timestamp ?? '');
  const quantity = numeric(position.remainingTokenAmount), basis = numeric(position.remainingCostBasisUsd), cost = numeric(position.feeInclusiveCostUsd);
  if (price === null || price <= 0 || quantity === null || cost === null || !Number.isFinite(at)
    || at > now || now - at > kolTokenPositionQuoteMaxAgeMs || !Number.isFinite(last) || at < last) return null;
  const flows = position.cashFlow, sold = numeric(flows?.soldUsd), outgoing = numeric(flows?.transferOutIncomeUsd);
  const unrealized = basis !== null ? quantity * price - basis : null;
  const total = sold !== null && outgoing !== null ? sold + outgoing + quantity * price - cost
    : numeric(realized, true) !== null && unrealized !== null ? Number(realized) + unrealized : NaN;
  if (unrealized !== null && !Number.isFinite(unrealized) || !Number.isFinite(total)) return null;
  const { reason: _reason, retryAfterMs: _retry, ...plain } = position;
  return { ...plain, estimatedProfitUsd: money(total), estimatedRoi: cost > 0 ? money(total / cost) : null,
    unrealizedProfitUsd: unrealized !== null ? money(unrealized) : null, priceUsd: quote.priceUsd, pricedAt: quote.timestamp, valuationSource: source };
}

/** Keep reusable cost basis and a separately dated valuation. */
function positionFromSnapshot(snapshot: ReplayAccountingSnapshot, realized: string | null): KolTokenProfitPosition {
  const closed = numeric(snapshot.remainingTokenAmount) === 0, cost = numeric(snapshot.feeInclusiveCostUsd)!;
  return { status: closed ? 'closed' : 'open', remainingTokenAmount: snapshot.remainingTokenAmount!,
    remainingCostBasisUsd: snapshot.remainingCostBasisUsd, feeInclusiveCostUsd: snapshot.feeInclusiveCostUsd!,
    cashFlow: { investedUsd: snapshot.investedUsd!, soldUsd: snapshot.soldUsd!, transferOutIncomeUsd: snapshot.transferOutIncomeUsd!, feesUsd: snapshot.feesUsd! },
    estimatedProfitUsd: closed ? realized : null, estimatedRoi: closed && cost > 0 ? String(Number(realized) / cost) : null,
    unrealizedProfitUsd: closed ? '0' : null, priceUsd: null, pricedAt: null, valuationSource: null,
    ...(!closed ? { reason: 'current_quote_unavailable' } : {}) };
}

/** Adapt only GMGN's separately verified policy; indexed FIFO is never a fallback. */
export function realizedAccountingFromReplay(activity: KolTokenActivity, accounting: TradeReplayAccounting, now = Date.now()): KolTokenRealizedAccounting {
  const value = base(activity, now), proof = activity.inventory?.coverage;
  const reject = (reason: string, pending = false) => { value.status = pending ? 'pending' : 'unavailable'; value.coverage.reason = reason;
    if (pending) value.retryAfterMs = Math.max(1000, Math.min(300_000, accounting.retryAfterMs ?? 1000)); return value; };
  if (!inventoryReady(activity, now)) return reject(proof?.reason ?? 'canonical_inventory_unavailable', proof?.status === 'pending' || transient(proof?.reason));
  if (accounting.version !== 1 || accounting.source !== 'gmgn' || accounting.policy !== 'gmgn_total_profit_v1'
    || accounting.walletAddress?.toLowerCase() !== value.walletAddress || accounting.tokenAddress?.toLowerCase() !== value.tokenAddress
    || accounting.inventoryBlockNumber !== proof!.toBlock || accounting.inventoryBlockHash?.toLowerCase() !== proof!.blockHash?.toLowerCase()
    || !recent(accounting.checkedAt, now)) return reject('gmgn_snapshot_unreconciled');
  value.coverage.transactionsComplete = accounting.coverage.transactionsComplete === true;
  value.coverage.balanceMatched = accounting.coverage.balanceMatched === true;
  if (accounting.status === 'pending') return reject(accounting.coverage.reason ?? 'provider_busy', true);
  if (accounting.status === 'unavailable') return reject(accounting.coverage.reason ?? 'gmgn_realized_cost_unavailable', transient(accounting.coverage.reason));
  if (!value.coverage.transactionsComplete || !value.coverage.balanceMatched) return reject(accounting.coverage.reason ?? 'gmgn_history_incomplete');
  const balance = numeric(proof!.balance)!;
  // A full aggregate can rescue unknown historical quote/fee attribution. Its
  // realized identity is independent of the current market quote.
  const exact = accounting.status === 'ready' && accounting.coverage.exactFinal ? knownRealized(accounting.final, balance) : null;
  const events = activity.inventory!.events, aligned = Array.isArray(accounting.events) && accounting.events.length === events.length
    && accounting.events.every((event, index) => {
      const canonical = events[index];
      return event.id === canonical.id && event.kind === canonical.kind && event.tradeId === canonical.tradeId
        && event.txHash.toLowerCase() === canonical.txHash.toLowerCase() && event.timestamp === canonical.timestamp
        && event.blockNumber === canonical.blockNumber && event.transactionIndex === canonical.transactionIndex && event.logIndex === canonical.logIndex;
    });
  const prefix = aligned ? knownRealized(accounting.events.at(-1), balance) : null;
  if (!aligned) return reject('gmgn_history_incomplete');
  const amount = exact ?? prefix;
  const last = accounting.events.at(-1)!;
  const unknownSplit = (last.remainingCostBasisUsd === null || last.cumulativeRealizedProfitUsd === null)
    && (last.remainingCostBasisUsd === null || numeric(last.remainingCostBasisUsd) !== null)
    && (last.cumulativeRealizedProfitUsd === null || numeric(last.cumulativeRealizedProfitUsd, true) !== null);
  if (amount === null && !(balance > 0 && unknownSplit && knownCashFlow(last, balance))) return reject(accounting.coverage.reason ?? 'gmgn_realized_cost_unavailable');
  value.status = 'ready'; value.realizedProfitUsd = amount;
  const snapshot = exact !== null ? accounting.final! : accounting.events.at(-1)!;
  value.position = positionFromSnapshot(snapshot, amount);
  if (exact !== null && value.position.status === 'open' && accounting.final!.priceUsd) {
    const marked = markedPosition(value.position, amount, { priceUsd: accounting.final!.priceUsd!, timestamp: accounting.final!.timestamp }, 'gmgn', activity, now);
    if (marked) value.position = marked;
  }
  if (exact === null) {
    value.coverage.reason = 'gmgn_activity_estimate';
    if (typeof accounting.retryAfterMs === 'number' && Number.isFinite(accounting.retryAfterMs) && accounting.retryAfterMs > 0) {
      value.retryAfterMs = Math.max(1000, Math.min(300_000, accounting.retryAfterMs));
    } else if (/^(aggregate|historical_cache)_provider_/.test(accounting.coverage.reason ?? '')) value.retryAfterMs = 15_000;
  }
  return value;
}

/** Historical totals survive quote refreshes while their canonical inputs remain
 * unchanged. Provider concurrency, priority and rate budget stay in the replay loader. */
export function createKolTokenGmgnPnl({ load = activity => currentTradeReplayGmgnAccounting(activity, { historicalRealized: true }), now = Date.now,
  directory = path.join(process.env.TOKEN_CHART_CACHE_DIR || path.join(process.cwd(), '.cache', 'token-charts'), 'realized-gmgn'),
  ttlMs = 600_000, maxEntries = 128, budgetMs = 8500,
  readCacheFile = (file: string) => readFile(file, 'utf8'), publishCacheFile = rename, loadQuote,
}: { load?: Loader; now?: () => number; directory?: string | null; ttlMs?: number; maxEntries?: number; budgetMs?: number;
  readCacheFile?: (file: string) => Promise<string>; publishCacheFile?: (from: string, to: string) => Promise<void>; loadQuote?: QuoteLoader } = {}) {
  const cache = new Map<string, Entry>(), jobs = new Map<string, Promise<KolTokenRealizedAccounting>>();
  const publications = new Map<string, Promise<void>>();
  const quality = (value: KolTokenRealizedAccounting) => value.status !== 'ready' ? 0 : value.coverage.reason === 'gmgn_activity_estimate' ? 1 : 2;
  const durationFor = (value: KolTokenRealizedAccounting) => value.status === 'ready' ? quality(value) === 2 ? ttlMs : Math.min(ttlMs, value.retryAfterMs ?? 15_000)
    : value.status === 'pending' ? value.retryAfterMs ?? 1000 : 60_000;
  const remember = (key: string, entry: Entry) => { cache.delete(key); cache.set(key, entry); while (cache.size > maxEntries) cache.delete(cache.keys().next().value!); };
  function valid(entry: Entry | null, key: string, activity: KolTokenActivity) {
    const position = entry?.value?.position, quantity = numeric(position?.remainingTokenAmount), basis = numeric(position?.remainingCostBasisUsd), cost = numeric(position?.feeInclusiveCostUsd);
    const flows = position?.cashFlow;
    const snapshot = { remainingTokenAmount: position?.remainingTokenAmount ?? null, remainingCostBasisUsd: position?.remainingCostBasisUsd ?? null,
      cumulativeRealizedProfitUsd: entry?.value?.realizedProfitUsd ?? null, feeInclusiveCostUsd: position?.feeInclusiveCostUsd ?? null,
      investedUsd: flows?.investedUsd ?? null, soldUsd: flows?.soldUsd ?? null, transferOutIncomeUsd: flows?.transferOutIncomeUsd ?? null, feesUsd: flows?.feesUsd ?? null };
    const validCashFlow = knownCashFlow(snapshot, numeric(activity.inventory?.coverage.balance)!);
    const positionValid = position && quantity !== null && (basis !== null || position.remainingCostBasisUsd === null) && cost !== null && validCashFlow
      && position.status === (quantity === 0 ? 'closed' : 'open') && (quantity > 0 || basis === 0);
    return entry?.version === 1 && entry.fingerprint === key && Number.isFinite(entry.observedAt) && entry.observedAt <= now()
      && !!entry.value?.coverage && Number.isFinite(entry.expiresAt) && entry.expiresAt > now() && entry.expiresAt - entry.observedAt <= durationFor(entry.value)
      && entry.value?.version === 1 && entry.value.source === 'gmgn' && entry.value.policy === 'gmgn_realized_profit_v1' && !!entry.value.coverage
      && entry.value.walletAddress === activity.kol.address.toLowerCase() && entry.value.tokenAddress === activity.token.address.toLowerCase()
      && (entry.value.status === 'ready' ? positionValid && (knownRealized(snapshot, quantity!) !== null || entry.value.realizedProfitUsd === null && quantity! > 0)
        && entry.value.coverage.transactionsComplete && entry.value.coverage.balanceMatched
        : ['pending', 'unavailable'].includes(entry.value.status) && entry.value.realizedProfitUsd === null);
  }
  async function read(key: string): Promise<Entry | null> {
    if (!directory) return null;
    try {
      const file = path.join(directory, key + '.json'); if ((await stat(file)).size > 64_000) return null;
      const stored = JSON.parse(await readCacheFile(file));
      return stored?.checksum === digest(stored.value) && stored.value?.value?.status === 'ready' ? stored.value : null;
    } catch { return null; }
  }
  async function save(key: string, entry: Entry) {
    if (!directory || entry.value.status !== 'ready') return;
    // Serialize publication for this history. A newer verified entry must land
    // after older writes so an app restart reads the latest persisted total.
    const previous = publications.get(key) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      if (cache.get(key) !== entry) return;
      const file = path.join(directory, key + '.json'), temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await mkdir(directory, { recursive: true }); await writeFile(temporary, JSON.stringify({ checksum: digest(entry), value: entry })); await publishCacheFile(temporary, file);
        const files = (await readdir(directory)).filter(name => /^[0-9a-f]{64}\.json$/.test(name));
        if (files.length > maxEntries) {
          const ordered = await Promise.all(files.map(async name => ({ name, modified: (await stat(path.join(directory, name))).mtimeMs })));
          ordered.sort((a, b) => b.modified - a.modified);
          await Promise.all(ordered.slice(maxEntries).map(item => unlink(path.join(directory, item.name)).catch(() => {})));
        }
      } catch { await unlink(temporary).catch(() => {}); }
    });
    publications.set(key, work);
    try { await work; } finally { if (publications.get(key) === work) publications.delete(key); }
  }
  const datedValue = (entry: Entry) => ({ ...entry.value, checkedAt: new Date(now()).toISOString(),
    ...(entry.value.status === 'pending' || quality(entry.value) === 1 && entry.value.retryAfterMs !== undefined ? { retryAfterMs: Math.max(1000, entry.expiresAt - now()) } : {}) });
  function confirmedValue(key: string, activity: KolTokenActivity, candidate?: KolTokenRealizedAccounting) {
    const latest = cache.get(key);
    return latest?.value.status === 'ready' && valid(latest, key, activity) && (!candidate || quality(latest.value) >= quality(candidate))
      ? datedValue(latest) : null;
  }
  const historical = async (activity: KolTokenActivity, supplied?: TradeReplayAccounting | Promise<TradeReplayAccounting>): Promise<KolTokenRealizedAccounting> => {
    if (!inventoryReady(activity, now())) {
      const value = base(activity, now()), reason = activity.inventory?.coverage.reason;
      value.status = activity.inventory?.coverage.status === 'pending' || transient(reason) ? 'pending' : 'unavailable';
      value.coverage.reason = reason ?? 'canonical_inventory_unavailable'; if (value.status === 'pending') value.retryAfterMs = 1000; return value;
    }
    const key = fingerprint(activity);
    let stored: Entry | null | undefined = cache.get(key);
    if (!stored) {
      const disk = await read(key);
      // A replay can warm memory while this disk lookup is suspended.
      stored = cache.get(key) ?? disk;
    }
    // Share preparation already paid for a provider snapshot. A verified final
    // warms the profile cache immediately, including during an earlier cooldown.
    if (supplied && 'version' in supplied) {
      const confirmed = realizedAccountingFromReplay(activity, supplied, now());
      if (confirmed.status === 'ready') {
        if (valid(stored ?? null, key, activity) && quality(stored!.value) > quality(confirmed)) {
          remember(key, stored!); return datedValue(stored!);
        }
        const observedAt = now(), entry: Entry = { version: 1, fingerprint: key, observedAt, expiresAt: observedAt + durationFor(confirmed), value: confirmed };
        remember(key, entry); await save(key, entry); return confirmedValue(key, activity) ?? confirmed;
      }
    }
    if (valid(stored ?? null, key, activity)) {
      remember(key, stored!); return datedValue(stored!);
    }
    if (cache.get(key) === stored) cache.delete(key);
    const existing = jobs.get(key); if (existing) return existing;
    if (jobs.size >= 2 && !supplied) { const value = base(activity, now()); value.status = 'pending'; value.retryAfterMs = 1000;
      value.coverage.reason = 'provider_busy'; return value; }
    const work = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined, value: KolTokenRealizedAccounting;
      try {
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('provider_timeout')), budgetMs); });
        const accounting = await Promise.race([supplied ?? load(activity), timeout]);
        value = realizedAccountingFromReplay(activity, accounting, now());
      } catch (error) { value = base(activity, now()); value.status = 'pending'; value.retryAfterMs = 1000;
        value.coverage.reason = error instanceof Error && error.message === 'provider_timeout' ? 'provider_timeout' : 'provider_unavailable'; }
      finally { if (timer) clearTimeout(timer); }
      // A job only starts without a reusable entry. Any confirmed value now
      // present was supplied by a newer replay snapshot while this job waited;
      // A newly reported total may upgrade a concurrently supplied estimate;
      // an estimate must never displace a validated reported total.
      const confirmed = confirmedValue(key, activity, value);
      if (confirmed) return confirmed;
      const observedAt = now(), duration = durationFor(value);
      const entry: Entry = { version: 1, fingerprint: key, observedAt, expiresAt: observedAt + duration, value };
      remember(key, entry); await save(key, entry); return confirmedValue(key, activity) ?? value;
    })();
    jobs.set(key, work);
    try { return await work; } finally { if (jobs.get(key) === work) jobs.delete(key); }
  };
  const quoteJobs = new Map<string, Promise<PositionQuoteResult>>();
  return async (activity: KolTokenActivity, supplied?: TradeReplayAccounting | Promise<TradeReplayAccounting>, options: { markPosition?: boolean } = {}): Promise<KolTokenRealizedAccounting> => {
    const historicalValue = await historical(activity, supplied), position = historicalValue.position;
    if (options.markPosition === false || historicalValue.status !== 'ready' || !position || position.status === 'closed') return historicalValue;
    const value = { ...historicalValue, position: { ...position } };
    let retained: KolTokenProfitPosition | null = null;
    if (position.priceUsd && position.pricedAt && position.valuationSource) {
      const marked = markedPosition(position, value.realizedProfitUsd!, { priceUsd: position.priceUsd, timestamp: position.pricedAt }, position.valuationSource, activity, now());
      if (marked) {
        retained = marked;
        if (!loadQuote || now() - Date.parse(position.pricedAt) <= 30_000) { value.position = marked; return value; }
      }
    }
    // Never extend a stored quote's timestamp when refreshing canonical proof.
    value.position = { ...position, estimatedProfitUsd: null, estimatedRoi: null, unrealizedProfitUsd: null,
      priceUsd: null, pricedAt: null, valuationSource: null, reason: 'current_quote_unavailable' };
    if (!loadQuote) return value;
    const token = activity.token.address.toLowerCase();
    let job = quoteJobs.get(token);
    if (!job) {
      job = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([loadQuote(token), new Promise<PositionQuoteResult>(resolve => {
          timer = setTimeout(() => resolve({ reason: 'current_quote_unavailable', retryAfterMs: 3000 }), 2500);
        })]); } finally { if (timer) clearTimeout(timer); }
      })();
      quoteJobs.set(token, job);
    }
    try {
      const result = await job;
      const marked = result.quote ? markedPosition(value.position, value.realizedProfitUsd!, result.quote, 'market', activity, now()) : null;
      if (marked) value.position = marked;
      else {
        if (retained && now() - Date.parse(retained.pricedAt!) <= kolTokenPositionQuoteMaxAgeMs) value.position = retained;
        value.position.reason = result.reason ?? 'current_quote_unavailable'; value.position.retryAfterMs = Math.max(1000, Math.min(300_000, result.retryAfterMs ?? 3000));
      }
      return value;
    } catch {
      if (retained && now() - Date.parse(retained.pricedAt!) <= kolTokenPositionQuoteMaxAgeMs) value.position = retained;
      value.position.retryAfterMs = 3000; return value;
    }
    finally { if (quoteJobs.get(token) === job) quoteJobs.delete(token); }
  };
}

/** Reuse chart jobs/cache while keeping card valuation below foreground charts. */
async function loadCurrentPositionQuote(token: string): Promise<PositionQuoteResult> {
  const result = await currentMarketChart(token, '1m', 'prefetch', { maxAgeMs: 30_000 });
  const chart = result.chart, now = Date.now(), updated = Date.parse(chart?.updatedAt ?? '');
  const unavailable = { reason: result.loadStatus === 'rate_limited' ? 'quote_rate_limited' : 'current_quote_unavailable', retryAfterMs: result.retryAfterMs ?? 3000 };
  if (!chart || chart.address !== token || chart.resolution !== '1m' || chart.pending || chart.stale
    || !['gmgn', 'geckoterminal', 'coinmarketcap'].includes(chart.source) || !Number.isFinite(updated) || updated > now || now - updated > 30_000) return unavailable;
  const bar = chart.candles.filter(candle => Number.isInteger(candle.time) && candle.time >= 0 && candle.time * 1000 <= now
    && Number.isFinite(candle.close) && candle.close > 0).sort((a, b) => b.time - a.time)[0];
  if (!bar) return unavailable;
  const boundary = (bar.time + 60) * 1000, observed = boundary > now ? updated : boundary;
  if (now - observed > kolTokenPositionQuoteMaxAgeMs) return unavailable;
  return { quote: { priceUsd: String(bar.close), timestamp: new Date(observed).toISOString() } };
}
export const currentKolTokenGmgnPnl = createKolTokenGmgnPnl({ loadQuote: loadCurrentPositionQuote });
