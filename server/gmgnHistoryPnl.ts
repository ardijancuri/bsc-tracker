import { createHash, randomUUID } from 'node:crypto';
import { canUseGmgnHistoryFallback, type KolTokenActivity, type KolTokenBalanceProof, type KolTokenRealizedAccounting, type KolTokenTrade } from '../shared/kolTokenTrades.js';
import { gmgnRequest, GmgnHttpError, type GmgnRequestOptions } from './gmgnApi.js';
import { MarketProviderDeferred } from './geckoApi.js';
import { currentKolTokenBalance } from './kolTokenBalance.js';

type Kind = 'buy' | 'sell' | 'transfer_in' | 'transfer_out';
type Requester = (url: URL, options: GmgnRequestOptions) => Promise<any>;
type BalanceReader = (request: { wallet: string; token: string; decimals?: number | null }, signal?: AbortSignal) => Promise<KolTokenBalanceProof>;
interface Row { tx: string; kind: Kind; timestamp: number; quantity: number; amount: number; gas: number; nativeGas: number | null;
  quoteAmount: number | null; quoteAddress: string | null; dex: number; priority: number; tip: number; disposedCost: number | null }
interface History { rows: Row[]; cursor: string | null; cursors: Set<string>; pages: number; complete: boolean; checkedAt: number;
  headFingerprint: string | null; headVerified: boolean }
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const nativeAddresses = new Set(['0x' + '0'.repeat(40), '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = (value: number) => String(Number(value.toPrecision(15)));
const numeric = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string' || typeof value === 'string' && !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return null;
  const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const same = (left: number, right: number) => Number.isFinite(left) && Number.isFinite(right)
  && (left === 0) === (right === 0) && Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right)) * 1e-12;
const keyOf = (row: Pick<Row, 'tx' | 'kind'>) => `${row.tx}:${row.kind}`;
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { work.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function kindOf(value: unknown): Kind | null {
  const text = String(value ?? '').replace(/[_-]/g, '').toLowerCase();
  return text === 'buy' || text === 'sell' ? text : text === 'transferin' ? 'transfer_in' : text === 'transferout' ? 'transfer_out' : null;
}
function parseRows(input: unknown, wallet: string, token: string, now: number): Row[] {
  if (!Array.isArray(input) || input.length > 50) throw Error('gmgn_history_response_invalid');
  return input.map(raw => {
    const kind = kindOf(raw?.event_type ?? raw?.type), tx = String(raw?.tx_hash ?? '').toLowerCase();
    const quantity = numeric(raw?.token_amount), timestamp = numeric(raw?.timestamp), amount = numeric(raw?.cost_usd);
    if (!kind || !hash.test(tx) || String(raw?.wallet ?? wallet).toLowerCase() !== wallet || (raw?.chain ?? 'bsc') !== 'bsc'
      || String(raw?.token?.address ?? '').toLowerCase() !== token || quantity === null || quantity <= 0 || timestamp === null
      || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp * 1000 > now || amount === null)
      throw Error('gmgn_history_response_invalid');
    const gas = numeric(raw.gas_usd), dex = numeric(raw.dex_usd), priority = numeric(raw.priority_fee), tip = numeric(raw.tip_fee);
    if (gas === null || dex === null || priority === null || tip === null || priority !== 0 || tip !== 0) throw Error('quote_or_fee_unavailable');
    const rawQuote = raw.quote_address ?? raw.quote_token?.token_address;
    const quoteAddress = typeof rawQuote === 'string' && address.test(rawQuote.toLowerCase()) ? rawQuote.toLowerCase() : null;
    const disposedCost = raw.buy_cost_usd == null ? null : numeric(raw.buy_cost_usd);
    if (raw.buy_cost_usd != null && disposedCost === null) throw Error('gmgn_history_cost_invalid');
    return { tx, kind, timestamp, quantity, amount, gas, dex, priority, tip, quoteAddress, disposedCost,
      nativeGas: numeric(raw.gas_native), quoteAmount: numeric(raw.quote_amount) };
  });
}
function base(activity: KolTokenActivity, now: number): KolTokenRealizedAccounting {
  return { version: 1, source: 'gmgn', policy: 'gmgn_realized_profit_v1', walletAddress: activity.kol.address.toLowerCase(),
    tokenAddress: activity.token.address.toLowerCase(), status: 'unavailable', checkedAt: new Date(now).toISOString(), realizedProfitUsd: null,
    coverage: { transactionsComplete: false, balanceMatched: false } };
}
function indexedCash(trade: KolTokenTrade, row: Row): number | null {
  if (trade.valuationStatus !== 'valued' || !['node', 'node+gmgn'].includes(trade.source)) return null;
  const quote = numeric(trade.quoteAmount);
  if (quote === null || quote <= 0) return null;
  const indexed = trade.quoteTokenAddress?.toLowerCase();
  const isNative = trade.quoteTokenAddress === null && trade.quoteSymbol?.toUpperCase() === 'BNB' || !!indexed && nativeAddresses.has(indexed);
  const quoteMatches = row.quoteAddress !== null && (nativeAddresses.has(row.quoteAddress) ? isNative : indexed === row.quoteAddress);
  if (quoteMatches && row.quoteAmount !== null && row.quoteAmount > 0) return quote * row.amount / row.quoteAmount;
  // Multi-hop GMGN activity can name an intermediate token as the quote. Its
  // same-transaction native gas/USD pair gives native FX without comparing units.
  return isNative && row.nativeGas !== null && row.nativeGas > 0 && row.gas > 0 ? quote * row.gas / row.nativeGas : null;
}
function movementFee(row: Row, trade?: KolTokenTrade) {
  if (row.kind === 'buy' || row.kind === 'sell') {
    const cash = trade ? indexedCash(trade, row) : null;
    if (cash === null || !Number.isFinite(cash) || cash <= 0) throw Error('quote_or_fee_unavailable');
    const inferred = (row.kind === 'buy' ? cash - row.amount : row.amount - cash) + row.gas;
    if (inferred < row.gas + row.dex - Math.max(1e-8, row.amount * 1e-10)) throw Error('quote_or_fee_unavailable');
    return Math.max(0, inferred);
  }
  if (row.dex !== 0 || row.kind === 'transfer_in' && (row.gas !== 0 || row.amount <= 0)) throw Error('transfer_fee_schema_unavailable');
  return row.gas;
}
function build(activity: KolTokenActivity, rows: Row[], proof: KolTokenBalanceProof, historyCheckedAt: number, now: number) {
  const value = base(activity, now), wallet = value.walletAddress, token = value.tokenAddress;
  const proofTime = Date.parse(proof.checkedAt), blockTime = Date.parse(proof.blockTimestamp), balance = numeric(proof.balance);
  if (proof.chain !== 'bsc' || proof.walletAddress !== wallet || proof.tokenAddress !== token || !/^\d+$/.test(proof.blockNumber)
    || !hash.test(proof.blockHash) || balance === null || !Number.isFinite(proofTime) || proofTime > now || now - proofTime > 180_000
    || !Number.isFinite(blockTime) || blockTime > proofTime || proofTime - blockTime > 180_000
    || historyCheckedAt > now || now - historyCheckedAt > 30_000) throw Error('gmgn_history_balance_unavailable');
  const trades = new Map<string, KolTokenTrade>();
  for (const trade of activity.trades) {
    const key = `${trade.txHash.toLowerCase()}:${trade.side}`;
    if (trade.walletAddress.toLowerCase() !== wallet || trade.tokenAddress.toLowerCase() !== token || !['buy', 'sell'].includes(trade.side)
      || !hash.test(trade.txHash.toLowerCase()) || !/^\d+$/.test(trade.blockNumber ?? '') || BigInt(trade.blockNumber!) > BigInt(proof.blockNumber)
      || trades.has(key)) throw Error('gmgn_history_indexed_mismatch');
    trades.set(key, trade);
  }
  const used = new Set<string>();
  for (const row of rows) {
    if (row.timestamp * 1000 > blockTime) throw Error('gmgn_history_balance_unavailable');
    if (row.kind !== 'buy' && row.kind !== 'sell') continue;
    const key = keyOf(row), trade = trades.get(key), quantity = numeric(trade?.tokenAmount);
    if (!trade || quantity === null || !same(row.quantity, quantity) || Math.abs(Date.parse(trade.timestamp) - row.timestamp * 1000) > 1000)
      throw Error('gmgn_history_indexed_mismatch');
    used.add(key);
  }
  if (!rows.length || !trades.size || used.size !== trades.size) throw Error('gmgn_history_indexed_mismatch');
  const feesByMovement = new Map(rows.map(row => [keyOf(row), movementFee(row, trades.get(keyOf(row)))]));
  const groups = new Map<number, Row[]>();
  for (const row of rows) { const group = groups.get(row.timestamp) ?? []; group.push(row); groups.set(row.timestamp, group); }
  // Incoming lots at the same fee-inclusive unit cost are interchangeable:
  // their order cannot change any subsequent FIFO cost or ending cash flow.
  // Check the entire second, so an intervening disposal is never reordered.
  const interchangeable = new Set<number>();
  for (const [timestamp, group] of groups) {
    if (group.length < 2 || !group.every(row => row.kind === 'buy' || row.kind === 'transfer_in')) continue;
    const costs = group.map(row => (row.amount + feesByMovement.get(keyOf(row))!) / row.quantity);
    if (costs.every(cost => Number.isFinite(cost) && cost > 0 && same(cost, costs[0]))) interchangeable.add(timestamp);
  }
  // Other same-second movements still require independently indexed ordinals.
  const ordered = [...rows].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    if (interchangeable.has(a.timestamp)) return keyOf(a).localeCompare(keyOf(b));
    const left = trades.get(keyOf(a)), right = trades.get(keyOf(b));
    if (!left || !right || left.transactionIndex === null || right.transactionIndex === null) throw Error('gmgn_history_order_unavailable');
    const block = BigInt(left.blockNumber!) - BigInt(right.blockNumber!);
    const order = (block < 0n ? -1 : block > 0n ? 1 : 0) || left.transactionIndex - right.transactionIndex;
    if (!order && a.tx !== b.tx || a.tx === b.tx && a.kind !== b.kind) throw Error('gmgn_history_order_unavailable');
    return order;
  });
  let held = 0, basis = 0, basisKnown = true, invested = 0, sold = 0, outgoing = 0, incoming = 0, fees = 0;
  const lots: { quantity: number; cost: number }[] = [];
  const take = (quantity: number) => {
    let remaining = quantity, cost = 0;
    while (remaining > quantity * 1e-12 && lots.length) {
      const lot = lots[0], used = Math.min(remaining, lot.quantity), removed = lot.cost * used / lot.quantity;
      cost += removed; lot.cost -= removed; lot.quantity -= used; remaining -= used;
      if (lot.quantity <= quantity * 1e-12) lots.shift();
    }
    if (remaining > quantity * 1e-12) throw Error('gmgn_history_opening_cost_unknown');
    return cost;
  };
  for (const row of ordered) {
    const fee = feesByMovement.get(keyOf(row))!;
    fees += fee;
    if (row.kind === 'buy' || row.kind === 'transfer_in') {
      const cost = row.amount + fee;
      if (row.amount <= 0) throw Error('gmgn_history_opening_cost_unknown');
      if (row.kind === 'buy') invested += row.amount; else incoming += row.amount;
      lots.push({ quantity: row.quantity, cost }); held += row.quantity; basis += cost;
    } else {
      if (row.quantity > held && !same(row.quantity, held)) throw Error('gmgn_history_opening_cost_unknown');
      const fifo = take(row.quantity), disposed = row.kind === 'sell' ? row.disposedCost ?? fifo : fifo;
      // GMGN may allocate bought cost differently from observed FIFO. The full
      // cash-flow total remains known, but do not mix incompatible allocations
      // into later realized/held-basis values. A fully closed cycle resolves it.
      if (Math.abs(disposed - fifo) > Math.max(1e-8, Math.max(disposed, fifo) * 1e-10)) basisKnown = false;
      held -= row.quantity; basis -= disposed;
      if (row.kind === 'sell') sold += row.amount; else outgoing += row.amount;
      if (Math.abs(held) <= row.quantity * 1e-12) { held = 0; basis = 0; basisKnown = true; lots.length = 0; }
      else if (basis < -Math.max(1e-8, (invested + incoming) * 1e-10)) basisKnown = false;
    }
  }
  if (!same(held, balance)) throw Error('gmgn_history_balance_mismatch');
  const cost = invested + incoming + fees, realized = sold + outgoing - cost + basis;
  if (![held, basis, cost, realized].every(Number.isFinite) || basisKnown && basis < 0 || cost <= 0) throw Error('gmgn_history_cost_invalid');
  const closed = balance === 0;
  value.status = 'ready'; value.realizedProfitUsd = basisKnown ? money(realized) : null;
  value.coverage = { transactionsComplete: true, balanceMatched: true, reason: 'gmgn_history_estimate', verification: 'gmgn_history',
    historyFingerprint: digest({ wallet, token, rows: ordered, trades: [...trades.values()].map(trade => [trade.txHash, trade.side, trade.tokenAmount,
      trade.quoteTokenAddress, trade.quoteSymbol, trade.quoteAmount, trade.timestamp, trade.blockNumber, trade.transactionIndex]) }),
    historyCheckedAt: new Date(historyCheckedAt).toISOString(),
    lastMovementAt: new Date(ordered.at(-1)!.timestamp * 1000).toISOString(), balanceProof: proof };
  value.position = { status: closed ? 'closed' : 'open', remainingTokenAmount: proof.balance, remainingCostBasisUsd: basisKnown ? money(basis) : null,
    feeInclusiveCostUsd: money(cost), cashFlow: { investedUsd: money(invested), soldUsd: money(sold), transferOutIncomeUsd: money(outgoing), feesUsd: money(fees) },
    estimatedProfitUsd: closed ? money(realized) : null, estimatedRoi: closed ? money(realized / cost) : null, unrealizedProfitUsd: closed ? '0' : null,
    priceUsd: null, pricedAt: null, valuationSource: null, ...(!closed ? { reason: 'current_quote_unavailable' } : {}) };
  return value;
}

/** Provider history is explicitly distinct from canonical historical inventory.
 * It can recover profile P&L on pruned nodes without asserting archived proof. */
export function createGmgnHistoryPnl({ request = gmgnRequest, rpc = currentKolTokenBalance, now = Date.now, budgetMs = 8000,
  apiKey = () => process.env.GMGN_CHART_API_KEY?.trim() || process.env.GMGN_API_KEY?.trim() || '',
}: { request?: Requester; rpc?: BalanceReader; now?: () => number; budgetMs?: number; apiKey?: () => string } = {}) {
  const cache = new Map<string, { until: number; value: KolTokenRealizedAccounting }>(), histories = new Map<string, History>();
  const pauses = new Map<string, { until: number; reason: string }>();
  const jobs = new Map<string, { foreground: () => boolean; work: Promise<KolTokenRealizedAccounting> }>();
  return async (activity: KolTokenActivity, options: { foreground?: boolean | (() => boolean) } = {}): Promise<KolTokenRealizedAccounting> => {
    const empty = base(activity, now()), wallet = empty.walletAddress, token = empty.tokenAddress;
    if (!address.test(wallet) || !address.test(token) || !activity.coverage.complete || !canUseGmgnHistoryFallback(activity.inventory?.coverage.reason)) {
      empty.coverage.reason = activity.inventory?.coverage.reason ?? 'canonical_inventory_unavailable'; return empty;
    }
    empty.coverage.verification = 'gmgn_history';
    const key = apiKey();
    if (!key) { empty.coverage.reason = 'provider_key_unavailable'; return empty; }
    const signature = digest({ wallet, token, trades: activity.trades, coverage: activity.coverage });
    const foreground = () => typeof options.foreground === 'function' ? options.foreground() : options.foreground === true;
    const pause = pauses.get(signature);
    if (pause && pause.until > now()) { empty.status = 'pending'; empty.retryAfterMs = Math.max(1000, pause.until - now()); empty.coverage.reason = pause.reason; return empty; }
    pauses.delete(signature);
    const stored = cache.get(signature);
    if (stored && stored.until > now()) return structuredClone(stored.value);
    const existing = jobs.get(signature);
    if (existing) { const previous = existing.foreground; existing.foreground = () => previous() || foreground(); return structuredClone(await existing.work); }
    if (jobs.size >= (foreground() ? 2 : 1)) { empty.status = 'pending'; empty.retryAfterMs = 1000; empty.coverage.reason = 'provider_busy'; return empty; }
    const job = { foreground, work: null as unknown as Promise<KolTokenRealizedAccounting> };
    const work = (async () => {
      const signal = AbortSignal.timeout(budgetMs);
      try {
        let history = histories.get(signature);
        // An unpublished scan can survive a normal provider cooldown. Its head
        // still has to be rechecked before publication; usable complete history
        // retains the much shorter 30-second freshness window.
        const historyTtl = history?.complete && history.headVerified ? 30_000 : 300_000;
        if (!history || history.checkedAt > now() || now() - history.checkedAt > historyTtl) history = { rows: [], cursor: null, cursors: new Set(), pages: 0,
          complete: false, checkedAt: now(), headFingerprint: null, headVerified: false };
        const fetchPage = async (cursor: string | null) => {
          const url = new URL('https://openapi.gmgn.ai/v1/user/wallet_activity');
          url.searchParams.set('timestamp', String(Math.floor(now() / 1000))); url.searchParams.set('client_id', randomUUID());
          url.searchParams.set('chain', 'bsc'); url.searchParams.set('wallet_address', wallet); url.searchParams.set('token_address', token); url.searchParams.set('limit', '50');
          for (const type of ['buy', 'sell', 'transferIn', 'transferOut']) url.searchParams.append('type', type);
          if (cursor) url.searchParams.set('cursor', cursor);
          const response = await bounded(request(url, { apiKey: key, weight: 3, priority: () => job.foreground() ? 'chart' : 'prefetch', signal, timeoutMs: budgetMs }), signal);
          const body = response.data ?? response, page = parseRows(body.activities, wallet, token, now());
          const next = body.next === '' || body.next === null ? null : body.next;
          if (next !== null && (typeof next !== 'string' || !next || next.length > 4096)) throw Error('gmgn_history_cursor_invalid');
          return { page, next: next as string | null };
        };
        while (!history.complete) {
          signal.throwIfAborted();
          if (history.pages >= 200 || history.rows.length >= 10_000) throw Error('gmgn_history_limit');
          const { page, next } = await fetchPage(history.cursor);
          if (next !== null && (history.cursors.has(next) || next === history.cursor)) throw Error('gmgn_history_cursor_invalid');
          const combined: Map<string, Row> = new Map(history.rows.map(row => [keyOf(row), row]));
          for (const row of page) {
            const previous = combined.get(keyOf(row));
            if (previous && digest(previous) !== digest(row)) throw Error('gmgn_history_conflict');
            if (page.filter(item => keyOf(item) === keyOf(row)).length > 1) throw Error('gmgn_history_duplicate');
            combined.set(keyOf(row), row);
          }
          if (combined.size > 10_000) throw Error('gmgn_history_limit');
          history = { rows: [...combined.values()], cursor: next, cursors: new Set([...history.cursors, ...(next ? [next] : [])]),
            pages: history.pages + 1, complete: next === null, checkedAt: now(), headFingerprint: history.headFingerprint ?? digest({ page, next }),
            headVerified: history.pages === 0 && next === null };
          histories.delete(signature); histories.set(signature, history);
          while (histories.size > 32) histories.delete(histories.keys().next().value!);
        }
        // Cursor pagination can span several request budgets. Refresh its head
        // before publishing: an old first page must not acquire a new timestamp
        // merely because a later historical page finished successfully.
        if (!history.headVerified) {
          const currentHead = await fetchPage(null);
          if (digest(currentHead) !== history.headFingerprint) { histories.delete(signature); throw Error('gmgn_history_snapshot_changed'); }
          history = { ...history, checkedAt: now(), headVerified: true }; histories.set(signature, history);
        }
        const proof = await bounded(rpc({ wallet, token }, signal), signal);
        const value = build(activity, history.rows, proof, history.checkedAt, now());
        cache.delete(signature); cache.set(signature, { until: Math.min(now() + 30_000, history.checkedAt + 30_000), value });
        while (cache.size > 64) cache.delete(cache.keys().next().value!);
        return value;
      } catch (error) {
        const value = base(activity, now()); value.coverage.verification = 'gmgn_history';
        const reason = error instanceof Error ? error.message : 'provider_unavailable';
        if (error instanceof MarketProviderDeferred || error instanceof GmgnHttpError && (error.status === 429 || error.status >= 500)
          || signal.aborted || reason === 'gmgn_history_snapshot_changed' || /^balance_(rpc_unavailable|timeout|aborted|block_stale|block_future|reorg)$/.test(reason)
          || !(error instanceof GmgnHttpError) && !/^gmgn_history_|^quote_or_fee_unavailable$|^transfer_fee_schema_unavailable$|^balance_/.test(reason)) {
          value.status = 'pending'; value.retryAfterMs = error instanceof MarketProviderDeferred || error instanceof GmgnHttpError ? error.retryAfterMs ?? 1000 : 1000;
          value.coverage.reason = error instanceof MarketProviderDeferred ? `provider_${error.reason}` : error instanceof GmgnHttpError ? `provider_http_${error.status}`
            : signal.aborted ? 'provider_timeout' : /^balance_/.test(reason) || reason === 'gmgn_history_snapshot_changed' ? reason : 'provider_unavailable';
          if (error instanceof MarketProviderDeferred || error instanceof GmgnHttpError) {
            pauses.set(signature, { until: now() + value.retryAfterMs, reason: value.coverage.reason });
            while (pauses.size > 64) pauses.delete(pauses.keys().next().value!);
          }
        } else value.coverage.reason = error instanceof GmgnHttpError ? `provider_http_${error.status}` : /^gmgn_history_|^quote_or_fee_unavailable$|^transfer_fee_schema_unavailable$|^balance_/.test(reason) ? reason : 'provider_unavailable';
        return value;
      }
    })();
    job.work = work; jobs.set(signature, job);
    try { return structuredClone(await work); } finally { if (jobs.get(signature) === job) jobs.delete(signature); }
  };
}
export const currentGmgnHistoryPnl = createGmgnHistoryPnl();
