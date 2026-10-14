import type { KolTokenActivity } from '../shared/kolTokenTrades';

export interface KolTokenPnlSelection { walletAddress: string; tokenAddress: string; lastTradeAt: string | null }
export interface KolTokenPnlResult { activity: KolTokenActivity | null; status: 'ready' | 'pending' | 'unavailable'; retryAfterMs?: number }
const address = /^0x[0-9a-f]{40}$/i;
const requestBudgetMs = 20_000;
const recentResultMs = 5000;
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
export const gmgnRealizedPnlNote = 'GMGN realized P&L includes marked transfer-out gains and fees.';
export function gmgnRealizedPnlDescription(activity: KolTokenActivity | null) {
  return gmgnRealizedPnlNote + (activity?.realizedAccounting?.status === 'ready'
    && activity.realizedAccounting.coverage?.reason === 'gmgn_activity_estimate'
    ? ' Estimated from matched GMGN activity; a reported position total is unavailable.' : '');
}

export function kolTokenPnlKey(selection: KolTokenPnlSelection) {
  const time = Date.parse(selection.lastTradeAt ?? '');
  return `${selection.walletAddress.toLowerCase()}:${selection.tokenAddress.toLowerCase()}:${Number.isFinite(time) ? time : selection.lastTradeAt ?? ''}`;
}

export function verifiedTokenRealizedPnl(activity: KolTokenActivity | null, now = Date.now()) {
  const proof = activity?.inventory?.coverage, accounting = activity?.realizedAccounting;
  if (!activity || typeof activity.kol?.address !== 'string' || typeof activity.token?.address !== 'string'
    || !address.test(activity.kol.address) || !address.test(activity.token.address)
    || activity.coverage?.complete !== true || activity.inventory?.version !== 1 || !proof
    || proof.complete !== true || proof.reconciled !== true || !accounting || accounting.version !== 1
    || accounting.source !== 'gmgn' || accounting.policy !== 'gmgn_realized_profit_v1' || accounting.status !== 'ready'
    || accounting.coverage?.transactionsComplete !== true || accounting.coverage.balanceMatched !== true
    || typeof accounting.walletAddress !== 'string' || typeof accounting.tokenAddress !== 'string'
    || accounting.walletAddress.toLowerCase() !== activity.kol.address.toLowerCase()
    || accounting.tokenAddress.toLowerCase() !== activity.token.address.toLowerCase()) return null;
  const checkedAt = typeof proof.checkedAt === 'string' ? Date.parse(proof.checkedAt) : NaN;
  const providerCheckedAt = typeof accounting.checkedAt === 'string' ? Date.parse(accounting.checkedAt) : NaN;
  const balance = typeof proof.balance === 'string' && decimal.test(proof.balance.trim()) ? Number(proof.balance) : NaN;
  if (!Number.isFinite(checkedAt) || checkedAt > now + 1000 || now - checkedAt > 180_000
    || !Number.isFinite(providerCheckedAt) || providerCheckedAt > now + 1000 || !Number.isFinite(balance) || balance < 0) return null;
  const raw = accounting.realizedProfitUsd;
  if (typeof raw !== 'string' || !decimal.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function tokenRealizedPnlUnavailableNotice(activity: KolTokenActivity | null) {
  const accounting = activity?.realizedAccounting, reason = accounting?.coverage?.reason;
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

/** Card attempts share one fair slot; retries release it so one old token cannot
 * block the rest. Foreground modal work uses the other inventory scanner slot. */
export function createKolTokenPnlLoader({ fetcher = (input, init) => fetch(input, init), now = Date.now }:
  { fetcher?: typeof fetch; now?: () => number } = {}) {
  type Client = { resolve(value: KolTokenPnlResult): void; reject(error: unknown): void; detach(): void; onActivity?(activity: KolTokenActivity): void };
  type Job = { key: string; cacheKey: string; selection: KolTokenPnlSelection; controller: AbortController; clients: Set<Client>; foreground: boolean };
  type Ticket = { job: Job; start(): void; stop(): void };
  const jobs = new Map<string, Job>(), queue: Ticket[] = [];
  const recent = new Map<string, { value: KolTokenPnlResult; checkedAt: number }>();
  let active = false;
  const dispatch = () => {
    if (active) return;
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
          response = await bounded(fetcher(`/api/kols/${encodeURIComponent(walletAddress.toLowerCase())}/tokens/${encodeURIComponent(tokenAddress.toLowerCase())}/activity?pnl=true`,
            { signal, cache: 'no-store' }), signal);
          if (!response.ok) {
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
              if (verifiedTokenRealizedPnl(body, now()) !== null) return { activity: body, status: 'ready' };
              const proof = body.inventory?.coverage;
              const accounting = body.realizedAccounting;
              pending = accounting?.status === 'pending' || proof?.status === 'pending' || ['inventory_rpc_unavailable', 'canonical_block_unavailable', 'canonical_receipt_unavailable',
                'canonical_transaction_unavailable', 'movement_scan_unavailable', 'confirmed_endpoint_stale'].includes(proof?.reason ?? '');
              if (typeof accounting?.retryAfterMs === 'number' && Number.isFinite(accounting.retryAfterMs) && accounting.retryAfterMs > 0) providerDelay = Math.max(1000, accounting.retryAfterMs);
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
  return (selection: KolTokenPnlSelection, signal: AbortSignal,
    options: { priority?: 'background' | 'foreground'; onActivity?(activity: KolTokenActivity): void } = {}): Promise<KolTokenPnlResult> => {
    if (signal.aborted) return Promise.reject(cancelled());
    if (!address.test(selection.walletAddress) || !address.test(selection.tokenAddress)) return Promise.resolve({ activity: null, status: 'unavailable' });
    const cacheKey = kolTokenPnlKey(selection), cached = recent.get(cacheKey);
    if (cached && now() >= cached.checkedAt && now() - cached.checkedAt < recentResultMs) {
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
}

export const requestKolTokenPnl = createKolTokenPnlLoader();
