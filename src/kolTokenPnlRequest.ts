import type { KolTokenActivity } from '../shared/kolTokenTrades';

export interface KolTokenPnlSelection { walletAddress: string; tokenAddress: string; lastTradeAt: string | null }
export interface KolTokenPnlResult { activity: KolTokenActivity | null; status: 'ready' | 'pending' | 'unavailable'; retryAfterMs?: number }
const address = /^0x[0-9a-f]{40}$/i;
const requestBudgetMs = 20_000;
const recentResultMs = 5000;

export function kolTokenPnlKey(selection: KolTokenPnlSelection) {
  const time = Date.parse(selection.lastTradeAt ?? '');
  return `${selection.walletAddress.toLowerCase()}:${selection.tokenAddress.toLowerCase()}:${Number.isFinite(time) ? time : selection.lastTradeAt ?? ''}`;
}

export function verifiedTokenRealizedPnl(activity: KolTokenActivity | null) {
  if (!activity?.coverage.complete || activity.inventory && (!activity.inventory.coverage.complete || !activity.inventory.coverage.reconciled)) return null;
  const raw = activity.summary.realizedProfitUsd;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
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
        let response: Response | undefined;
        try {
          signal.throwIfAborted();
          response = await bounded(fetcher(`/api/kols/${encodeURIComponent(walletAddress.toLowerCase())}/tokens/${encodeURIComponent(tokenAddress.toLowerCase())}/activity`,
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
              if (verifiedTokenRealizedPnl(body) !== null) return { activity: body, status: 'ready' };
              const proof = body.inventory?.coverage;
              pending = proof?.status === 'pending' || ['inventory_rpc_unavailable', 'canonical_block_unavailable', 'canonical_receipt_unavailable',
                'canonical_transaction_unavailable', 'movement_scan_unavailable', 'confirmed_endpoint_stale'].includes(proof?.reason ?? '');
              if (!pending) return { activity, status: 'unavailable' };
            }
          }
        } catch {
          if (signal.aborted) break;
          pending = true;
        } finally { release(); }
        delay = retryDelay(response, attempt);
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
