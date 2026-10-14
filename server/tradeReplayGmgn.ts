import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import type { TradeReplayAccounting } from '../shared/tradeReplayAccounting.js';
import { MarketProviderDeferred } from './geckoApi.js';
import { gmgnRequest, GmgnHttpError, type GmgnRequestOptions } from './gmgnApi.js';
import { buildTradeReplayGmgnAccounting, type GmgnReplayActivity } from './tradeReplayGmgnAccounting.js';

type Requester = (url: URL, options: GmgnRequestOptions) => Promise<any>;
type Builder = typeof buildTradeReplayGmgnAccounting;
type Sort = 'amount_percentage' | 'profit' | 'buy_volume_cur';
interface History {
  version: 2; wallet: string; token: string; signature: string; rows: GmgnReplayActivity[];
  cursor: string | null; cursors: string[]; complete: boolean; pages: number; updatedAt: number;
}
interface Traders { version: 1; token: string; sort: Sort; rows: Record<string, unknown>[]; checkedAt: number }
interface RankingHints { version: 1; wallet: string; token: string; signature: string; successful?: Sort; misses: Partial<Record<Sort, number>>; updatedAt: number }
interface Job { foreground: boolean; work: Promise<ProviderData> }
interface ProviderData { history: History; aggregate: Record<string, unknown> | null; checkedAt: number; aggregateOnly?: boolean;
  fallbackHistory?: History; pending?: { reason: string; retryAfterMs: number }; failure?: string }
const addressRe = /^0x[0-9a-f]{40}$/;
const hashRe = /^0x[0-9a-f]{64}$/;
const ttlMs = 15_000;
const historyTtlMs = 180_000;
const resumeTtlMs = 600_000;
const maxRows = 10_000;
const fields = ['token_amount', 'quote_amount', 'cost_usd', 'buy_cost_usd', 'gas_usd', 'gas_native', 'dex_usd', 'priority_fee', 'tip_fee', 'price_usd'] as const;
const sorts = ['amount_percentage', 'profit', 'buy_volume_cur'] as const;
const transientInventory = new Set(['scan_pending', 'scan_queued', 'confirmation_pending', 'unindexed_swap_pending', 'indexed_snapshot_changed',
  'confirmed_endpoint_stale', 'inventory_rpc_unavailable', 'canonical_block_unavailable', 'canonical_receipt_unavailable',
  'canonical_transaction_unavailable', 'movement_scan_unavailable']);
const aggregateFields = ['balance', 'amount_cur', 'usd_value', 'cost_cur', 'accu_cost', 'cost', 'history_bought_cost', 'history_bought_fee',
  'history_sold_income', 'history_sold_fee', 'history_transfer_in_cost', 'history_transfer_out_income', 'history_transfer_out_fee',
  'history_transfer_in_amount', 'history_transfer_out_amount', 'current_buy_amount', 'buy_amount_cur', 'current_sell_amount', 'sell_amount_cur',
  'buy_tx_count_cur', 'sell_tx_count_cur', 'transfer_in_count', 'transfer_out_count', 'last_block', 'last_active_timestamp', 'total_cost',
  'profit', 'profit_change', 'realized_profit', 'unrealized_profit'] as const;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  cache.delete(key); cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}
const numericValue = (value: unknown): string | number | null => (typeof value === 'number' && Number.isFinite(value)
  || typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && Number.isFinite(Number(value))) ? value as string | number : null;
const kind = (value: unknown) => {
  const result = String(value ?? '').replace(/[_-]/g, '').toLowerCase();
  return result === 'buy' || result === 'sell' ? result : result === 'transferin' ? 'transferIn' : result === 'transferout' ? 'transferOut' : null;
};
const activityKey = (row: GmgnReplayActivity) => `${row.tx_hash}:${kind(row.event_type ?? row.type)}`;
function activityRows(input: unknown, wallet: string, token: string, now: number): GmgnReplayActivity[] {
  if (!Array.isArray(input) || input.length > maxRows) throw Error('provider_response_invalid');
  return input.map(row => {
    const event = kind(row?.event_type ?? row?.type), tx = String(row?.tx_hash ?? '').toLowerCase(), timestamp = numericValue(row?.timestamp);
    const amount = numericValue(row?.token_amount);
    if (!row || String(row.wallet ?? wallet).toLowerCase() !== wallet || (row.chain ?? 'bsc') !== 'bsc'
      || String(row.token?.address ?? '').toLowerCase() !== token || !hashRe.test(tx) || !event || amount === null || Number(amount) <= 0
      || timestamp === null || Number(timestamp) <= 0 || Number(timestamp) * 1000 > now + 1000) throw Error('provider_response_invalid');
    const selected: GmgnReplayActivity = { wallet, chain: 'bsc', tx_hash: tx, event_type: event, timestamp, token: { address: token } };
    for (const field of fields) selected[field] = numericValue(row[field]);
    if (typeof row.quote_address === 'string' && addressRe.test(row.quote_address.toLowerCase())) selected.quote_address = row.quote_address.toLowerCase();
    if (row.quote_token && typeof row.quote_token.token_address === 'string' && addressRe.test(row.quote_token.token_address.toLowerCase())) {
      selected.quote_token = { token_address: row.quote_token.token_address.toLowerCase(),
        ...(typeof row.quote_token.symbol === 'string' && row.quote_token.symbol.length <= 20 ? { symbol: row.quote_token.symbol } : {}) };
    }
    return selected;
  });
}
function traderRows(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input) || input.length > 100) throw Error('provider_response_invalid');
  return input.flatMap(row => {
    const address = String(row?.address ?? '').toLowerCase();
    if (!addressRe.test(address)) return [];
    return [{ address, ...Object.fromEntries(aggregateFields.filter(field => !['buy_amount_cur', 'sell_amount_cur'].includes(field)
      || Object.hasOwn(row, field)).map(field => [field, numericValue(row[field])])) }];
  });
}
function fingerprint(activity: KolTokenActivity) {
  return digest({ balance: activity.inventory?.coverage.balance, fromBlock: activity.inventory?.coverage.fromBlock,
    initialBalanceSource: activity.inventory?.coverage.initialBalanceSource,
    events: activity.inventory?.events.map(event => [event.id, event.tradeId, event.kind, event.txHash, event.timestamp,
      event.blockNumber, event.transactionIndex, event.logIndex, event.tokenAmount, event.remainingTokenAmount]),
    trades: activity.trades.map(trade => [trade.id, trade.side, trade.txHash, trade.timestamp, trade.blockNumber, trade.transactionIndex,
      trade.tokenAmount, trade.amountUsd, trade.priceUsd, trade.quoteTokenAddress, trade.quoteAmount, trade.quoteSymbol, trade.valuationStatus, trade.source]) });
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

/** Share/export and profile realized P&L opt into these calls. Work shares the chart account's
 * DB rate budget; public cache payloads contain neither credentials nor errors. */
export function createTradeReplayGmgnLoader({ request = gmgnRequest, builder = buildTradeReplayGmgnAccounting,
  directory = path.join(process.env.TOKEN_CHART_CACHE_DIR || path.join(process.cwd(), '.cache', 'token-charts'), 'replay-gmgn'),
  now = Date.now, budgetMs = 8000, apiKey = () => process.env.GMGN_CHART_API_KEY?.trim() || process.env.GMGN_API_KEY?.trim() || '',
}: { request?: Requester; builder?: Builder; directory?: string; now?: () => number; budgetMs?: number; apiKey?: () => string } = {}) {
  const histories = new Map<string, History>(), completedHistories = new Map<string, History>(), traders = new Map<string, Traders>();
  const hints = new Map<string, RankingHints>();
  const jobs = new Map<string, Job>(), traderJobs = new Map<string, { work: Promise<Traders>; priority: () => 'chart' | 'prefetch' }>();
  let active = 0;
  async function read<T>(name: string): Promise<T | null> {
    try { const envelope = JSON.parse(await readFile(path.join(directory, name + '.json'), 'utf8'));
      return envelope?.version === 1 && envelope.checksum === digest(envelope.value) ? envelope.value : null;
    } catch { return null; }
  }
  async function save(name: string, value: unknown) {
    const target = path.join(directory, name + '.json'), temporary = target + '.' + randomUUID() + '.tmp';
    try { await mkdir(directory, { recursive: true }); await writeFile(temporary, JSON.stringify({ version: 1, checksum: digest(value), value })); await rename(temporary, target); }
    catch { /* An optional public cache never prevents a usable replay. */ }
  }
  const validTime = (time: unknown, ttl: number) => typeof time === 'number' && Number.isFinite(time) && time <= now() && now() - time < ttl;
  const freshHistory = (wallet: string, token: string, signature: string): History => ({ version: 2, wallet, token, signature,
    rows: [], cursor: null, cursors: [], complete: false, pages: 0, updatedAt: now() });
  function validHistory(stored: History | null | undefined, wallet: string, token: string, signature: string, ttl: number): History | null {
    if (stored?.version === 2 && stored.wallet === wallet && stored.token === token && stored.signature === signature
      && validTime(stored.updatedAt, ttl) && Array.isArray(stored.cursors) && stored.cursors.length <= 200
      && stored.cursors.every(cursor => typeof cursor === 'string' && cursor.length <= 4096) && new Set(stored.cursors).size === stored.cursors.length
      && (stored.cursor === null || typeof stored.cursor === 'string' && stored.cursor.length <= 4096) && typeof stored.complete === 'boolean'
      && Number.isInteger(stored.pages) && stored.pages >= 0 && stored.pages <= 200
      && (stored.complete ? stored.cursor === null : stored.pages === 0 ? stored.cursor === null : stored.cursor === stored.cursors.at(-1))) {
      try {
        stored.rows = activityRows(stored.rows, wallet, token, now());
        if (new Set(stored.rows.map(activityKey)).size !== stored.rows.length) throw Error('duplicate cached activity');
        return stored;
      } catch { /* Discard malformed records. */ }
    }
    return null;
  }
  async function historyFor(wallet: string, token: string, signature: string) {
    const key = `${wallet}-${token}`, stored = histories.get(key) ?? await read<History>('activity-' + key);
    const completed = stored?.complete ? stored : completedHistories.get(key) ?? await read<History>('completed-activity-' + key);
    const fallback = completed?.complete ? validHistory(completed, wallet, token, signature, resumeTtlMs) : null;
    if (fallback) remember(completedHistories, key, fallback, 24); else completedHistories.delete(key);
    const history = validHistory(stored, wallet, token, signature, stored?.complete ? historyTtlMs : resumeTtlMs)
      ?? freshHistory(wallet, token, signature);
    remember(histories, key, history, 24); return { history, fallback };
  }
  async function rankingHints(wallet: string, token: string, signature: string) {
    const key = `${wallet}-${token}`, stored = hints.get(key) ?? await read<RankingHints>('rankings-' + key);
    if (stored?.version === 1 && stored.wallet === wallet && stored.token === token && stored.signature === signature
      && validTime(stored.updatedAt, resumeTtlMs) && stored.misses && typeof stored.misses === 'object'
      && (!stored.successful || sorts.includes(stored.successful))) {
      const value: RankingHints = { ...stored, misses: Object.fromEntries(sorts.filter(sort => validTime(stored.misses[sort], historyTtlMs)).map(sort => [sort, stored.misses[sort]])) };
      remember(hints, key, value, 128); return value;
    }
    const value: RankingHints = { version: 1, wallet, token, signature, misses: {}, updatedAt: now() };
    remember(hints, key, value, 128); return value;
  }
  async function topTraders(token: string, sort: Sort, key: string, signal: AbortSignal, priority: () => 'chart' | 'prefetch'): Promise<Traders> {
    const name = `${token}-${sort}`;
    const stored = traders.get(name) ?? await read<Traders>('traders-' + name);
    if (stored?.version === 1 && stored.token === token && stored.sort === sort && validTime(stored.checkedAt, ttlMs)) {
      try { stored.rows = traderRows(stored.rows); remember(traders, name, stored, 100); return stored; } catch { /* Discard malformed cache. */ }
    }
    const running = traderJobs.get(name);
    if (running) {
      const previous = running.priority;
      running.priority = () => previous() === 'chart' || priority() === 'chart' ? 'chart' : 'prefetch';
      return bounded(running.work, signal);
    }
    const job = { priority, work: null as unknown as Promise<Traders> };
    const work = (async () => {
      const url = new URL('https://openapi.gmgn.ai/v1/market/token_top_traders');
      url.searchParams.set('timestamp', String(Math.floor(now() / 1000))); url.searchParams.set('client_id', randomUUID());
      url.searchParams.set('chain', 'bsc'); url.searchParams.set('address', token); url.searchParams.set('limit', '100');
      url.searchParams.set('order_by', sort); url.searchParams.set('direction', 'desc');
      if (sort !== 'amount_percentage') url.searchParams.set('tag', 'renowned');
      const response = await bounded(request(url, { apiKey: key, weight: 5, priority: () => job.priority(), signal, timeoutMs: budgetMs }), signal);
      const entry: Traders = { version: 1, token, sort, checkedAt: now(), rows: traderRows((response.data ?? response)?.list) };
      remember(traders, name, entry, 100); await save('traders-' + name, entry); return entry;
    })();
    job.work = work; traderJobs.set(name, job);
    try { return await work; } finally { if (traderJobs.get(name) === job) traderJobs.delete(name); }
  }
  async function fetchData(wallet: string, token: string, signature: string, key: string, priority: () => 'chart' | 'prefetch'): Promise<ProviderData> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(Error('provider_timeout')), Math.max(1, Math.min(8000, budgetMs)));
    const signal = controller.signal; let history = freshHistory(wallet, token, signature), fallbackHistory: History | null = null;
    let aggregate: Record<string, unknown> | null = null, checkedAt = now();
    try {
      const cached = await bounded(historyFor(wallet, token, signature), signal); history = cached.history; fallbackHistory = cached.fallback;
      while (!history.complete) {
        signal.throwIfAborted();
        if (history.pages >= 200 || history.rows.length >= maxRows) throw Error('provider_history_limit');
        const url = new URL('https://openapi.gmgn.ai/v1/user/wallet_activity');
        url.searchParams.set('timestamp', String(Math.floor(now() / 1000))); url.searchParams.set('client_id', randomUUID());
        url.searchParams.set('chain', 'bsc'); url.searchParams.set('wallet_address', wallet); url.searchParams.set('token_address', token);
        url.searchParams.set('limit', '50'); for (const type of ['buy', 'sell', 'transferIn', 'transferOut']) url.searchParams.append('type', type);
        if (history.cursor) url.searchParams.set('cursor', history.cursor);
        const response = await bounded(request(url, { apiKey: key, weight: 3, priority, signal, timeoutMs: budgetMs }), signal);
        const body = response.data ?? response, page = activityRows(body?.activities, wallet, token, now());
        const next = body.next == null || body.next === '' ? null : body.next;
        if (next !== null && (typeof next !== 'string' || next.length > 4096 || history.cursors.includes(next) || next === history.cursor)) throw Error('provider_cursor_invalid');
        const combined = new Map(history.rows.map(row => [activityKey(row), row]));
        for (const row of page) {
          const old = combined.get(activityKey(row));
          if (old && digest(old) !== digest(row)) throw Error('provider_activity_conflict');
          combined.set(activityKey(row), row);
        }
        if (combined.size > maxRows) throw Error('provider_history_limit');
        history = { ...history, rows: [...combined.values()], cursor: next, cursors: next ? [...history.cursors, next] : history.cursors,
          pages: history.pages + 1, complete: next === null, updatedAt: now() };
        remember(histories, `${wallet}-${token}`, history, 24); await bounded(save('activity-' + `${wallet}-${token}`, history), signal);
        if (history.complete) {
          remember(completedHistories, `${wallet}-${token}`, history, 24);
          await bounded(save('completed-activity-' + `${wallet}-${token}`, history), signal);
        }
      }
      const ranking = await bounded(rankingHints(wallet, token, signature), signal);
      const ordered = ranking.successful ? [ranking.successful, ...sorts.filter(sort => sort !== ranking.successful)] : sorts;
      for (const sort of ordered) {
        if (validTime(ranking.misses[sort], historyTtlMs)) continue;
        const entry = await bounded(topTraders(token, sort, key, signal, priority), signal);
        const found = entry.rows.find(row => row.address === wallet);
        ranking.updatedAt = now();
        if (found) { ranking.successful = sort; delete ranking.misses[sort]; }
        else { ranking.misses[sort] = entry.checkedAt; if (ranking.successful === sort) delete ranking.successful; }
        remember(hints, `${wallet}-${token}`, ranking, 128);
        await bounded(save('rankings-' + `${wallet}-${token}`, ranking), signal);
        if (found) { aggregate = found; checkedAt = entry.checkedAt; break; }
      }
      return { history, aggregate, checkedAt: aggregate ? checkedAt : now() };
    } catch (error) {
      if (error instanceof MarketProviderDeferred) return { history, aggregate, checkedAt, aggregateOnly: history.complete,
        ...(!history.complete && fallbackHistory ? { fallbackHistory } : {}), pending: { reason: error.reason === 'rate_limited' ? 'provider_rate_limited' : 'provider_busy', retryAfterMs: error.retryAfterMs } };
      if (signal.aborted || error instanceof Error && (error.message === 'provider_timeout' || ['AbortError', 'TimeoutError'].includes(error.name)))
        return { history, aggregate, checkedAt, aggregateOnly: history.complete,
          ...(!history.complete && fallbackHistory ? { fallbackHistory } : {}), pending: { reason: 'provider_timeout', retryAfterMs: 1000 } };
      return { history, aggregate, checkedAt, aggregateOnly: history.complete, failure: error instanceof GmgnHttpError ? `provider_http_${error.status}`
        : error instanceof Error && ['provider_response_invalid', 'provider_cursor_invalid', 'provider_activity_conflict', 'provider_history_limit'].includes(error.message) ? error.message : 'provider_unavailable' };
    } finally { clearTimeout(timer); }
  }
  function result(activity: KolTokenActivity, data?: ProviderData, reason?: string): TradeReplayAccounting {
    const checkedAt = new Date(data?.checkedAt ?? now()).toISOString();
    const usablePrefix = (value: TradeReplayAccounting) => {
      const last = value.events.at(-1);
      const known = (field: string | null | undefined) => field !== null && field !== undefined && field.trim() !== '' && Number.isFinite(Number(field));
      return value.coverage.transactionsComplete && value.coverage.balanceMatched && last && [last.remainingTokenAmount,
        last.investedUsd, last.soldUsd, last.transferOutIncomeUsd, last.feesUsd, last.feeInclusiveCostUsd].every(known)
        && (Number(last.remainingTokenAmount) > 0 || known(last.cumulativeRealizedProfitUsd));
    };
    if (data?.fallbackHistory && data.pending && data.pending.reason !== 'canonical_snapshot_changed') {
      // Only historical transaction values are reused. A fresh canonical proof
      // must match the entire fingerprint; no cached price/final accompanies it.
      const fallback = builder(activity, data.fallbackHistory.rows, { activitiesComplete: true, aggregateRow: null, checkedAt, now: now() });
      if (usablePrefix(fallback)) {
        fallback.status = 'estimated'; fallback.final = null; fallback.coverage.exactFinal = false;
        fallback.coverage.reason = `historical_cache_${data.pending.reason}`; fallback.retryAfterMs = data.pending.retryAfterMs; return fallback;
      }
    }
    const value = builder(activity, data?.history.rows ?? [], { activitiesComplete: data?.history.complete ?? false,
      aggregateRow: data?.aggregate, checkedAt, now: now() });
    const usableEstimate = data?.aggregateOnly && data.history.complete && usablePrefix(value) && data.pending?.reason !== 'canonical_snapshot_changed';
    if (usableEstimate && (data.pending || data.failure)) {
      value.status = 'estimated'; value.final = null; value.coverage.exactFinal = false;
      value.coverage.reason = `aggregate_${data.pending?.reason ?? data.failure}`;
      if (data.pending) value.retryAfterMs = data.pending.retryAfterMs;
      return value;
    }
    if (data?.pending) { value.status = 'pending'; value.retryAfterMs = data.pending.retryAfterMs; value.coverage.reason = data.pending.reason; }
    if (data?.failure || reason) { value.status = 'unavailable'; value.final = null; value.coverage.exactFinal = false; value.coverage.reason = data?.failure ?? reason; }
    return value;
  }
  return async (activity: KolTokenActivity, options: { historicalRealized?: boolean } = {}): Promise<TradeReplayAccounting> => {
    const wallet = activity.kol.address.toLowerCase(), token = activity.token.address.toLowerCase(), key = apiKey();
    if (!addressRe.test(wallet) || !addressRe.test(token)) return result(activity, undefined, 'invalid_pair');
    if (!key) return result(activity, undefined, 'provider_key_unavailable');
    const proof = activity.inventory?.coverage;
    if (!activity.coverage.complete || !proof?.complete || !proof.reconciled || !validTime(Date.parse(proof.checkedAt ?? ''), historyTtlMs)) {
      const value = result(activity);
      if (activity.coverage.complete && (proof?.status === 'pending' || transientInventory.has(proof?.reason ?? ''))) {
        value.status = 'pending'; value.final = null; value.coverage.exactFinal = false;
        value.coverage.reason = proof?.reason ?? 'scan_pending'; value.retryAfterMs = 1000;
      }
      return value;
    }
    const historicalRealized = options.historicalRealized === true;
    const signature = fingerprint(activity), jobKey = `${wallet}-${token}`;
    let job = jobs.get(jobKey);
    if (!job) {
      if (active >= 2) { const value = result(activity); value.status = 'pending'; value.coverage.reason = 'provider_busy'; value.retryAfterMs = 1000; return value; }
      active++;
      job = { foreground: !historicalRealized, work: null as unknown as Promise<ProviderData> };
      const selected = job;
      job.work = fetchData(wallet, token, signature, key, () => selected.foreground ? 'chart' : 'prefetch'); jobs.set(jobKey, job);
      void job.work.finally(() => { active--; if (jobs.get(jobKey) === job) jobs.delete(jobKey); });
    }
    if (!historicalRealized) job.foreground = true;
    const data = await job.work;
    return result(activity, data.history.signature === signature ? data : { ...data, aggregate: null, pending: { reason: 'canonical_snapshot_changed', retryAfterMs: 1000 } });
  };
}

export const currentTradeReplayGmgnAccounting = createTradeReplayGmgnLoader();
