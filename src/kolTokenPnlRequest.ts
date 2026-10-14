import { kolTokenPositionQuoteMaxAgeMs, type KolTokenActivity } from '../shared/kolTokenTrades';

export interface KolTokenPnlSelection { walletAddress: string; tokenAddress: string; lastTradeAt: string | null }
export interface KolTokenPnlResult { activity: KolTokenActivity | null; status: 'ready' | 'pending' | 'unavailable'; retryAfterMs?: number }
const address = /^0x[0-9a-f]{40}$/i;
const requestBudgetMs = 20_000;
const recentResultMs = 5000;
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
export const gmgnRealizedPnlNote = 'GMGN realized P&L includes marked transfer-out gains and fees.';
export const gmgnHistoryPnlNote = 'Estimated from GMGN history; current wallet balance checked. Historical movements are not chain-verified.';
export function gmgnRealizedPnlDescription(activity: KolTokenActivity | null) {
  if (isGmgnHistoryFallback(activity)) return gmgnHistoryPnlNote;
  return gmgnRealizedPnlNote + (activity?.realizedAccounting?.status === 'ready'
    && activity.realizedAccounting.coverage?.reason === 'gmgn_activity_estimate'
    ? ' Estimated from matched GMGN activity; a reported position total is unavailable.' : '');
}

export function tokenPositionPnlLabel(activity: KolTokenActivity | null) {
  return activity?.realizedAccounting?.position?.status === 'open'
    && (verifiedTokenPositionPnl(activity) !== null || verifiedTokenRealizedPnl(activity) === null) ? 'Est. profit'
    : isGmgnHistoryFallback(activity) ? 'Est. realized P&L' : 'Realized P&L';
}
export function tokenPositionPnlDescription(activity: KolTokenActivity | null) {
  if (isGmgnHistoryFallback(activity)) return gmgnHistoryPnlNote;
  return tokenPositionPnlLabel(activity) === 'Est. profit'
    ? 'Estimated total profit includes realized gains, the current value of remaining tokens, marked transfer-out gains and fees.'
    : gmgnRealizedPnlDescription(activity);
}
export function tokenPositionPnlLoadingNotice(activity: KolTokenActivity | null) {
  return activity?.realizedAccounting?.position?.status === 'open' ? 'Updating estimated profit…' : 'Loading GMGN realized P&L…';
}
export function tokenPositionPnlPriceTime(activity: KolTokenActivity | null) {
  const position = activity?.realizedAccounting?.position;
  return position?.status === 'open' && position.pricedAt && verifiedTokenPositionPnl(activity) !== null
    ? new Date(position.pricedAt).toISOString().slice(11, 19) : null;
}

/** Open positions require a dated market mark. The historical realized total is
 * still available separately, but must never be mislabeled as current profit. */
export function verifiedTokenPositionPnl(activity: KolTokenActivity | null, now = Date.now()) {
  const accounting = verifiedTokenAccounting(activity, now);
  if (!accounting) return null;
  const realized = verifiedTokenRealizedPnl(activity, now), position = accounting.position;
  if (!position) return realized;
  const proofBalance = Number(accounting.coverage.verification === 'gmgn_history'
    ? accounting.coverage.balanceProof!.balance : activity!.inventory!.coverage.balance);
  const remaining = typeof position.remainingTokenAmount === 'string' && decimal.test(position.remainingTokenAmount.trim())
    ? Number(position.remainingTokenAmount) : NaN;
  if (position.status === 'closed') return remaining === 0 && proofBalance === 0 ? realized : null;
  const price = typeof position.priceUsd === 'string' && decimal.test(position.priceUsd.trim()) ? Number(position.priceUsd) : NaN;
  const pricedAt = typeof position.pricedAt === 'string' ? Date.parse(position.pricedAt) : NaN;
  const value = typeof position.estimatedProfitUsd === 'string' && decimal.test(position.estimatedProfitUsd.trim())
    ? Number(position.estimatedProfitUsd) : NaN;
  if (position.status !== 'open' || !['gmgn', 'market'].includes(position.valuationSource ?? '')
    || !Number.isFinite(remaining) || remaining <= 0 || proofBalance <= 0 || Math.abs(remaining - proofBalance) > proofBalance * 1e-10
    || !Number.isFinite(price) || price <= 0 || !Number.isFinite(pricedAt) || pricedAt > now + 1000
    || now - pricedAt > kolTokenPositionQuoteMaxAgeMs || !Number.isFinite(value)) return null;
  if (accounting.coverage.verification === 'gmgn_history'
    && pricedAt < Date.parse(accounting.coverage.lastMovementAt!)) return null;
  const positiveNumber = (raw: unknown) => typeof raw === 'string' && decimal.test(raw.trim()) && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null;
  const basis = positiveNumber(position.remainingCostBasisUsd), cost = positiveNumber(position.feeInclusiveCostUsd), flow = position.cashFlow;
  const invested = positiveNumber(flow?.investedUsd), sold = positiveNumber(flow?.soldUsd), outgoing = positiveNumber(flow?.transferOutIncomeUsd), fees = positiveNumber(flow?.feesUsd);
  const expected = realized !== null && basis !== null ? realized + remaining * price - basis
    : invested !== null && sold !== null && outgoing !== null && fees !== null && cost !== null && cost + 1e-8 >= invested + fees
      ? sold + outgoing + remaining * price - cost : null;
  if (expected === null || !Number.isFinite(expected) || Math.abs(value - expected) > Math.max(1e-6, Math.abs(expected) * 1e-8)) return null;
  return value;
}

/** A current quote can be temporarily unavailable without invalidating verified
 * historical gains. Keep that realized value visible under its own label while
 * the loader continues to update the open-position estimate. */
export function displayedTokenPnl(activity: KolTokenActivity | null, now = Date.now()) {
  return verifiedTokenPositionPnl(activity, now)
    ?? (activity?.realizedAccounting?.position?.status === 'open' ? verifiedTokenRealizedPnl(activity, now) : null);
}

const retryableInventoryReasons = new Set(['inventory_rpc_unavailable', 'canonical_block_unavailable',
  'canonical_receipt_unavailable', 'canonical_transaction_unavailable', 'movement_scan_unavailable', 'confirmed_endpoint_stale']);
export function terminalTokenInventoryFailure(activity: KolTokenActivity | null) {
  const proof = activity?.inventory?.coverage;
  if (isGmgnHistoryFallback(activity)
    && (activity!.realizedAccounting!.status === 'pending' || verifiedTokenAccounting(activity) !== null)) return false;
  return proof?.status === 'unavailable' && !retryableInventoryReasons.has(proof.reason ?? '');
}

export function tokenPositionPnlUnavailableNotice(activity: KolTokenActivity | null) {
  return activity?.realizedAccounting?.position?.status === 'open' && verifiedTokenAccounting(activity) !== null
    ? 'Estimated profit is unavailable until a current token price is verified.'
    : tokenRealizedPnlUnavailableNotice(activity);
}

export function kolTokenPnlKey(selection: KolTokenPnlSelection) {
  const time = Date.parse(selection.lastTradeAt ?? '');
  return `${selection.walletAddress.toLowerCase()}:${selection.tokenAddress.toLowerCase()}:${Number.isFinite(time) ? time : selection.lastTradeAt ?? ''}`;
}

function verifiedTokenAccounting(activity: KolTokenActivity | null, now = Date.now()) {
  const proof = activity?.inventory?.coverage, accounting = activity?.realizedAccounting;
  if (!activity || typeof activity.kol?.address !== 'string' || typeof activity.token?.address !== 'string'
    || !address.test(activity.kol.address) || !address.test(activity.token.address)
    || activity.coverage?.complete !== true || activity.inventory?.version !== 1 || !proof
    || !accounting || accounting.version !== 1
    || accounting.source !== 'gmgn' || accounting.policy !== 'gmgn_realized_profit_v1' || accounting.status !== 'ready'
    || accounting.coverage?.transactionsComplete !== true || accounting.coverage.balanceMatched !== true
    || typeof accounting.walletAddress !== 'string' || typeof accounting.tokenAddress !== 'string'
    || accounting.walletAddress.toLowerCase() !== activity.kol.address.toLowerCase()
    || accounting.tokenAddress.toLowerCase() !== activity.token.address.toLowerCase()) return null;
  if (accounting.coverage.verification === 'gmgn_history') {
    const balanceProof = accounting.coverage.balanceProof;
    const balance = typeof balanceProof?.balance === 'string' && decimal.test(balanceProof.balance.trim()) ? Number(balanceProof.balance) : NaN;
    const lastMovementAt = typeof accounting.coverage.lastMovementAt === 'string' ? Date.parse(accounting.coverage.lastMovementAt) : NaN;
    if (!isGmgnHistoryFallback(activity) || !balanceProof || balanceProof.chain !== 'bsc'
      || typeof balanceProof.walletAddress !== 'string' || typeof balanceProof.tokenAddress !== 'string'
      || balanceProof.walletAddress.toLowerCase() !== activity.kol.address.toLowerCase()
      || balanceProof.tokenAddress.toLowerCase() !== activity.token.address.toLowerCase()
      || typeof balanceProof.blockNumber !== 'string' || !/^[1-9]\d*$/.test(balanceProof.blockNumber)
      || typeof balanceProof.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(balanceProof.blockHash)
      || typeof accounting.coverage.historyFingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(accounting.coverage.historyFingerprint)
      || !freshProofTime(accounting.coverage.historyCheckedAt, now) || !freshProofTime(balanceProof.checkedAt, now)
      || !freshProofTime(balanceProof.blockTimestamp, now) || Date.parse(balanceProof.blockTimestamp) > now
      || Date.parse(balanceProof.blockTimestamp) > Date.parse(balanceProof.checkedAt)
      || !Number.isFinite(lastMovementAt) || lastMovementAt > Date.parse(balanceProof.blockTimestamp)
      || !freshProofTime(accounting.checkedAt, now) || !Number.isFinite(balance) || balance < 0) return null;
    return accounting;
  }
  // Provider-history evidence must never silently pass as canonical history.
  if (accounting.coverage.verification !== undefined || accounting.coverage.historyFingerprint !== undefined
    || accounting.coverage.historyCheckedAt !== undefined || accounting.coverage.balanceProof !== undefined
    || accounting.coverage.lastMovementAt !== undefined
    || proof.complete !== true || proof.reconciled !== true) return null;
  const checkedAt = typeof proof.checkedAt === 'string' ? Date.parse(proof.checkedAt) : NaN;
  const providerCheckedAt = typeof accounting.checkedAt === 'string' ? Date.parse(accounting.checkedAt) : NaN;
  const balance = typeof proof.balance === 'string' && decimal.test(proof.balance.trim()) ? Number(proof.balance) : NaN;
  if (!Number.isFinite(checkedAt) || checkedAt > now + 1000 || now - checkedAt > 180_000
    || !Number.isFinite(providerCheckedAt) || providerCheckedAt > now + 1000 || !Number.isFinite(balance) || balance < 0) return null;
  return accounting;
}

function freshProofTime(raw: unknown, now: number) {
  const time = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(time) && time <= now + 1000 && now - time <= 180_000;
}

/** This marker allows a separate provider-history path only when the node has
 * pruned the old history. It cannot override a canonical mismatch or failure. */
function isGmgnHistoryFallback(activity: KolTokenActivity | null) {
  const proof = activity?.inventory?.coverage, accounting = activity?.realizedAccounting;
  return !!activity && activity.coverage?.complete === true && activity.inventory?.version === 1
    && proof?.complete === false && proof.reconciled === false && proof.status === 'unavailable'
    && proof.reason === 'inventory_history_unavailable' && accounting?.version === 1
    && accounting.source === 'gmgn' && accounting.policy === 'gmgn_realized_profit_v1'
    && accounting.coverage?.verification === 'gmgn_history'
    && typeof activity.kol?.address === 'string' && address.test(activity.kol.address)
    && typeof activity.token?.address === 'string' && address.test(activity.token.address)
    && typeof accounting.walletAddress === 'string' && typeof accounting.tokenAddress === 'string'
    && accounting.walletAddress.toLowerCase() === activity.kol.address.toLowerCase()
    && accounting.tokenAddress.toLowerCase() === activity.token.address.toLowerCase();
}

export function verifiedTokenRealizedPnl(activity: KolTokenActivity | null, now = Date.now()) {
  const accounting = verifiedTokenAccounting(activity, now);
  const raw = accounting?.realizedProfitUsd;
  if (typeof raw !== 'string' || !decimal.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function tokenRealizedPnlUnavailableNotice(activity: KolTokenActivity | null) {
  const accounting = activity?.realizedAccounting, reason = accounting?.coverage?.reason;
  if (reason === 'inventory_history_unavailable') return 'Historical transaction data is unavailable.';
  if (reason === 'gmgn_position_not_found') return 'GMGN realized P&L is unavailable for this position with the current API key.';
  if (['gmgn_not_configured', 'gmgn_key_unavailable', 'provider_key_unavailable'].includes(reason ?? '')) return 'GMGN realized P&L is unavailable because the provider is not configured.';
  if (['gmgn_realized_cost_unavailable', 'quote_or_fee_unavailable', 'transfer_fee_schema_unavailable'].includes(reason ?? '')) return 'GMGN realized P&L is unavailable because transfer costs or fee data are missing.';
  if (activity && (activity.coverage?.complete !== true || activity.inventory?.coverage?.complete !== true
    || activity.inventory?.coverage?.reconciled !== true)) return 'GMGN realized P&L is unavailable until wallet movements and balance are verified.';
  return 'GMGN realized P&L could not be verified for this token.';
}

/** Transfer-only changes also invalidate a retained total, even when the last
 * indexed trade timestamp has stayed the same. */
export function tokenPnlMovementsMatch(left: KolTokenActivity, right: KolTokenActivity) {
  if (!left.inventory?.coverage || !right.inventory?.coverage || !Array.isArray(left.inventory.events) || !Array.isArray(right.inventory.events)
    || !Array.isArray(left.trades) || !Array.isArray(right.trades) || left.inventory.coverage.balance !== right.inventory.coverage.balance
    || left.inventory.coverage.fromBlock !== right.inventory.coverage.fromBlock
    || left.inventory.coverage.initialBalanceSource !== right.inventory.coverage.initialBalanceSource) return false;
  const oldAccounting = left.realizedAccounting, incoming = right.realizedAccounting;
  if (!oldAccounting || !incoming || incoming.version !== 1 || incoming.source !== 'gmgn' || incoming.policy !== 'gmgn_realized_profit_v1'
    || typeof incoming.walletAddress !== 'string' || typeof incoming.tokenAddress !== 'string'
    || typeof oldAccounting.walletAddress !== 'string' || typeof oldAccounting.tokenAddress !== 'string'
    || incoming.walletAddress.toLowerCase() !== oldAccounting.walletAddress.toLowerCase()
    || incoming.tokenAddress.toLowerCase() !== oldAccounting.tokenAddress.toLowerCase()
    || incoming.realizedProfitUsd !== null && incoming.realizedProfitUsd !== oldAccounting.realizedProfitUsd) return false;
  if (oldAccounting.coverage.verification !== incoming.coverage.verification
    || oldAccounting.coverage.historyFingerprint !== incoming.coverage.historyFingerprint
    || oldAccounting.coverage.lastMovementAt !== incoming.coverage.lastMovementAt
    || oldAccounting.coverage.balanceProof?.balance !== incoming.coverage.balanceProof?.balance) return false;
  if (incoming.coverage.verification === 'gmgn_history') {
    const oldProof = oldAccounting.coverage.balanceProof, nextProof = incoming.coverage.balanceProof;
    if (!isGmgnHistoryFallback(left) || !isGmgnHistoryFallback(right) || !oldProof || !nextProof
      || oldProof.chain !== nextProof.chain || typeof oldProof.walletAddress !== 'string' || typeof nextProof.walletAddress !== 'string'
      || typeof oldProof.tokenAddress !== 'string' || typeof nextProof.tokenAddress !== 'string'
      || oldProof.walletAddress.toLowerCase() !== nextProof.walletAddress.toLowerCase()
      || oldProof.tokenAddress.toLowerCase() !== nextProof.tokenAddress.toLowerCase()
      || typeof nextProof.blockNumber !== 'string' || !/^[1-9]\d*$/.test(nextProof.blockNumber)
      || typeof nextProof.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(nextProof.blockHash)
      || oldProof.blockNumber === nextProof.blockNumber && oldProof.blockHash.toLowerCase() !== nextProof.blockHash.toLowerCase()) return false;
  }
  const events = (activity: KolTokenActivity) => activity.inventory!.events.map(event => [event.id, event.kind, event.txHash,
    event.timestamp, event.blockNumber, event.transactionIndex, event.logIndex, event.tokenAmount]);
  const trades = (activity: KolTokenActivity) => activity.trades.map(trade => [trade.id, trade.side, trade.tokenAmount,
    trade.amountUsd, trade.quoteAmount, trade.quoteSymbol, trade.quoteTokenAddress, trade.priceUsd, trade.source,
    trade.txHash, trade.timestamp, trade.blockNumber, trade.transactionIndex, trade.valuationStatus]);
  return JSON.stringify(events(left)) === JSON.stringify(events(right)) && JSON.stringify(trades(left)) === JSON.stringify(trades(right));
}

function cancelled() { return new DOMException('Token P&L request cancelled.', 'AbortError'); }
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? cancelled());
    if (signal.aborted) { work.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function pause(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function retryDelay(response: Response | undefined, attempt: number) {
  const raw = response?.headers?.get('Retry-After');
  if (raw) {
    const seconds = Number(raw), until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(raw);
    if (Number.isFinite(until) && until > Date.now()) return Math.max(1000, until - Date.now());
  }
  return Math.min(3000, (attempt + 1) * 1000);
}

/** Cards poll the nonblocking profile endpoint through one fair HTTP slot.
 * A pending scan releases the slot immediately, so cached cards can load while
 * it continues. Foreground modal work keeps its dedicated request path. */
export function createKolTokenPnlLoader({ fetcher = (input, init) => fetch(input, init), now = Date.now }:
  { fetcher?: typeof fetch; now?: () => number } = {}) {
  type Client = { resolve(value: KolTokenPnlResult): void; reject(error: unknown): void; detach(): void; onActivity?(activity: KolTokenActivity): void };
  type Job = { key: string; cacheKey: string; selection: KolTokenPnlSelection; controller: AbortController; clients: Set<Client>; foreground: boolean };
  type Ticket = { job: Job; start(): void; stop(): void };
  const jobs = new Map<string, Job>(), queue: Ticket[] = [];
  const recent = new Map<string, { value: KolTokenPnlResult; checkedAt: number }>();
  let active = false, backgroundHolds = 0;
  const dispatch = () => {
    if (active || backgroundHolds > 0) return;
    const next = queue.shift();
    if (!next) return;
    if (next.job.controller.signal.aborted) { next.stop(); dispatch(); return; }
    active = true; next.start();
  };
  function slot(job: Job): Promise<() => void> {
    if (job.controller.signal.aborted) return Promise.reject(cancelled());
    if (job.foreground) return Promise.resolve(() => {});
    return new Promise((resolve, reject) => {
      const signal = job.controller.signal;
      const stop = () => {
        const index = queue.indexOf(ticket); if (index >= 0) queue.splice(index, 1);
        signal.removeEventListener('abort', stop); reject(cancelled());
      };
      const ticket: Ticket = { job, stop, start: () => {
        signal.removeEventListener('abort', stop);
        let released = false;
        resolve(() => { if (released) return; released = true; active = false; dispatch(); });
      } };
      signal.addEventListener('abort', stop, { once: true }); queue.push(ticket); dispatch();
    });
  }
  async function run(job: Job): Promise<KolTokenPnlResult> {
    const { walletAddress, tokenAddress } = job.selection, signal = job.controller.signal;
    let deadline = Infinity, timer: ReturnType<typeof setTimeout> | undefined;
    let activity: KolTokenActivity | null = null, pending = false, delay = 1000;
    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const release = await slot(job);
        if (!timer) { deadline = now() + requestBudgetMs; timer = setTimeout(() => job.controller.abort(), requestBudgetMs); }
        let response: Response | undefined, providerDelay = 0;
        try {
          signal.throwIfAborted();
          response = await bounded(fetcher(`/api/kols/${encodeURIComponent(walletAddress.toLowerCase())}/tokens/${encodeURIComponent(tokenAddress.toLowerCase())}/activity?pnl=true${job.foreground ? '' : '&profile=true'}`,
            { signal, cache: 'no-store' }), signal);
          if (response.status === 202) {
            // Accepted profile work is still running on the server; its small
            // status response is not an activity snapshot to validate or cache.
            pending = true;
          } else if (!response.ok) {
            pending = response.status === 429 || response.status >= 500;
            if (!pending) return { activity: null, status: 'unavailable' };
          } else {
            const body: KolTokenActivity = await bounded(response.json(), signal);
            if (typeof body?.kol?.address !== 'string' || typeof body?.token?.address !== 'string'
              || body.kol.address.toLowerCase() !== walletAddress.toLowerCase() || body.token.address.toLowerCase() !== tokenAddress.toLowerCase()
              || !body.coverage || !body.summary || !Array.isArray(body.trades)) return { activity: null, status: 'unavailable' };
            const expectedTime = Date.parse(job.selection.lastTradeAt ?? ''), returnedTime = Date.parse(body.summary.lastTradeAt ?? '');
            if (Number.isFinite(expectedTime) && (!Number.isFinite(returnedTime) || returnedTime < expectedTime)) pending = true;
            else {
              activity = body;
              for (const client of job.clients) client.onActivity?.(body);
              const proof = body.inventory?.coverage;
              const accounting = body.realizedAccounting;
              // A terminal canonical-history failure cannot be fixed by polling
              // a downstream provider's pending status indefinitely.
              if (terminalTokenInventoryFailure(body)) return { activity: body, status: 'unavailable' };
              const retryAfter = Math.max(accounting?.retryAfterMs ?? 0, accounting?.position?.retryAfterMs ?? 0);
              const provisional = Number.isFinite(retryAfter) && retryAfter > 0;
              if (verifiedTokenPositionPnl(body, now()) !== null && !provisional) return { activity: body, status: 'ready' };
              pending = accounting?.status === 'pending' || (accounting?.status === 'ready' && accounting.position?.status === 'open')
                || provisional
                || proof?.status === 'pending' || retryableInventoryReasons.has(proof?.reason ?? '');
              if (Number.isFinite(retryAfter) && retryAfter > 0) providerDelay = Math.max(1000, retryAfter);
              if (!pending) return { activity, status: 'unavailable' };
            }
          }
        } catch {
          if (signal.aborted) break;
          pending = true;
        } finally { release(); }
        delay = Math.max(retryDelay(response, attempt), providerDelay);
        if (attempt === 5 || delay >= deadline - now()) break;
        await pause(delay, signal);
      }
      return { activity, status: pending || signal.aborted ? 'pending' : 'unavailable', retryAfterMs: delay };
    } catch {
      return { activity, status: 'pending', retryAfterMs: delay };
    } finally { if (timer) clearTimeout(timer); }
  }
  function start(job: Job) {
    void run(job).then(value => {
      // Settle ownership before notifying subscribers. Their next request can
      // start immediately, including after an unavailable result with no cache.
      if (jobs.get(job.key) === job) jobs.delete(job.key);
      if (value.status === 'ready' && job.clients.size) {
        recent.delete(job.cacheKey); recent.set(job.cacheKey, { value, checkedAt: now() });
        while (recent.size > 64) recent.delete(recent.keys().next().value!);
      }
      for (const client of job.clients) { client.detach(); client.resolve(value); }
    });
  }
  const load = (selection: KolTokenPnlSelection, signal: AbortSignal,
    options: { priority?: 'background' | 'foreground'; onActivity?(activity: KolTokenActivity): void } = {}): Promise<KolTokenPnlResult> => {
    if (signal.aborted) return Promise.reject(cancelled());
    if (!address.test(selection.walletAddress) || !address.test(selection.tokenAddress)) return Promise.resolve({ activity: null, status: 'unavailable' });
    const cacheKey = kolTokenPnlKey(selection), cached = recent.get(cacheKey);
    if (cached && now() >= cached.checkedAt && now() - cached.checkedAt < recentResultMs
      && verifiedTokenPositionPnl(cached.value.activity, now()) !== null) {
      if (cached.value.activity) options.onActivity?.(cached.value.activity);
      return Promise.resolve(cached.value);
    }
    recent.delete(cacheKey);
    const foreground = options.priority === 'foreground', key = `${cacheKey}:${foreground ? 'foreground' : 'background'}`;
    let job = jobs.get(key), created = false;
    if (!job) { job = { key, cacheKey, selection, foreground, controller: new AbortController(), clients: new Set() }; jobs.set(key, job); created = true; }
    const selected = job;
    const result = new Promise<KolTokenPnlResult>((resolve, reject) => {
      const abort = () => {
        selected.clients.delete(client); client.detach(); reject(cancelled());
        if (!selected.clients.size) { selected.controller.abort(); if (jobs.get(key) === selected) jobs.delete(key); }
      };
      const client: Client = { resolve, reject, onActivity: options.onActivity, detach: () => signal.removeEventListener('abort', abort) };
      selected.clients.add(client); signal.addEventListener('abort', abort, { once: true });
    });
    if (created) start(selected);
    return result;
  };
  return Object.assign(load, { suspendBackground: () => {
    backgroundHolds++;
    let released = false;
    return () => { if (!released) { released = true; backgroundHolds--; dispatch(); } };
  } });
}

export const requestKolTokenPnl = createKolTokenPnlLoader();
