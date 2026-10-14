import { kolTokenPositionQuoteMaxAgeMs } from '../shared/kolTokenTrades.js';

export interface TokenPositionQuote { priceUsd: string; timestamp: string }
export interface TokenPositionQuoteResult { quote?: TokenPositionQuote; reason?: string; retryAfterMs?: number }
const addressPattern = /^0x[0-9a-f]{40}$/;
const positiveDecimal = (raw: unknown) => typeof raw === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)
  && Number.isFinite(Number(raw)) && Number(raw) > 0;

/** Preserve the age of an HTTP-cached observation rather than redating it on
 * every request. Date and Age are alternate lower bounds on response age. */
function observationTime(headers: Headers, receivedAt: number) {
  const date = headers.get('date'), age = headers.get('age');
  const generatedAt = date === null ? receivedAt : Date.parse(date);
  const ageSeconds = age === null ? 0 : /^\d+(?:\.\d+)?$/.test(age) ? Number(age) : NaN;
  if (!Number.isFinite(generatedAt) || generatedAt > receivedAt + 1000 || !Number.isFinite(ageSeconds)) return null;
  const observedAt = receivedAt - Math.max(0, receivedAt - generatedAt, ageSeconds * 1000);
  return receivedAt - observedAt <= kolTokenPositionQuoteMaxAgeMs ? observedAt : null;
}

function retryDelay(headers: Headers, now: number) {
  const raw = headers.get('retry-after'), seconds = raw === null ? NaN : Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : raw ? Date.parse(raw) - now : NaN;
  return Number.isFinite(delay) && delay > 0 ? Math.max(1000, Math.min(600_000, delay)) : 60_000;
}

/** Independent spot prices keep PNL marking off the full chart-history queue.
 * DEX Screener's token endpoint accepts 30 addresses per request (300 RPM).
 * https://docs.dexscreener.com/api/reference */
export function createTokenPositionQuote({ fetcher = fetch, now = Date.now, batchWaitMs = 25, requestTimeoutMs = 1800,
  requestSpacingMs = 250, waitTimeoutMs = 2400, freshMs = 30_000, maxEntries = 256 }:
  { fetcher?: typeof fetch; now?: () => number; batchWaitMs?: number; requestTimeoutMs?: number;
    requestSpacingMs?: number; waitTimeoutMs?: number; freshMs?: number; maxEntries?: number } = {}) {
  type Entry = { quote?: TokenPositionQuote; retryAt: number; reason?: string };
  type Job = { token: string; promise: Promise<TokenPositionQuoteResult>; resolve(value: TokenPositionQuoteResult): void;
    timer?: ReturnType<typeof setTimeout>; settled: boolean };
  const cache = new Map<string, Entry>(), jobs = new Map<string, Job>(), queued = new Map<string, Job>();
  let active = false, nextRequestAt = 0, pausedUntil = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const usable = (quote: TokenPositionQuote | undefined, maxAge = kolTokenPositionQuoteMaxAgeMs) => {
    const timestamp = Date.parse(quote?.timestamp ?? '');
    return quote && positiveDecimal(quote.priceUsd) && Number.isFinite(timestamp) && timestamp <= now() && now() - timestamp <= maxAge ? quote : undefined;
  };
  const result = (token: string, reason?: string, retryAfterMs?: number): TokenPositionQuoteResult => {
    const quote = usable(cache.get(token)?.quote);
    return { ...(quote ? { quote: { ...quote } } : {}), ...(reason ? { reason } : {}), ...(retryAfterMs ? { retryAfterMs } : {}) };
  };
  const remember = (token: string, entry: Entry) => {
    cache.delete(token); cache.set(token, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
  };
  const settle = (job: Job, value: TokenPositionQuoteResult) => {
    if (job.settled) return;
    job.settled = true; if (job.timer) clearTimeout(job.timer);
    if (jobs.get(job.token) === job) jobs.delete(job.token);
    if (queued.get(job.token) === job) queued.delete(job.token);
    job.resolve(value);
  };
  function schedule() {
    if (active || timer || queued.size === 0) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, Math.max(batchWaitMs, nextRequestAt - now()));
  }
  async function flush() {
    if (active || !queued.size) return;
    if (pausedUntil > now()) {
      for (const job of queued.values()) settle(job, result(job.token, 'quote_rate_limited', pausedUntil - now()));
      return;
    }
    const batch = [...queued.values()].slice(0, 30);
    for (const job of batch) queued.delete(job.token);
    active = true; nextRequestAt = now() + requestSpacingMs;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = (async () => {
        const response = await fetcher(`https://api.dexscreener.com/tokens/v1/bsc/${batch.map(job => job.token).join(',')}`,
          { signal: controller.signal, headers: { Accept: 'application/json' } });
        const receivedAt = now();
        if (response.status === 429) {
          pausedUntil = Math.max(pausedUntil, receivedAt + retryDelay(response.headers, receivedAt));
          return { reason: 'quote_rate_limited', retryAfterMs: pausedUntil - receivedAt };
        }
        if (!response.ok) return { reason: 'current_quote_unavailable', retryAfterMs: 5000 };
        const observedAt = observationTime(response.headers, receivedAt);
        const rows: unknown = await response.json();
        if (!Array.isArray(rows) || observedAt === null) return { reason: 'current_quote_unavailable', retryAfterMs: 5000 };
        const requested = new Set(batch.map(job => job.token));
        const quotes = new Map<string, { priceUsd: string; liquidity: number }>();
        for (const raw of rows) {
          if (raw === null || typeof raw !== 'object') continue;
          const pair = raw as { chainId?: unknown; baseToken?: { address?: unknown }; priceUsd?: unknown; liquidity?: { usd?: unknown } };
          const token = typeof pair.baseToken?.address === 'string' ? pair.baseToken.address.toLowerCase() : '';
          const liquidity = pair.liquidity?.usd;
          if (pair.chainId !== 'bsc' || !requested.has(token) || !positiveDecimal(pair.priceUsd)
            || typeof liquidity !== 'number' || !Number.isFinite(liquidity) || liquidity <= 0) continue;
          if (!quotes.has(token) || quotes.get(token)!.liquidity < liquidity) quotes.set(token, { priceUsd: pair.priceUsd as string, liquidity });
        }
        return { quotes, observedAt };
      })();
      const data = await Promise.race([work, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(Error('quote_timeout')); }, requestTimeoutMs);
      })]);
      for (const job of batch) {
        const selected = 'quotes' in data ? data.quotes?.get(job.token) : undefined;
        const quote = selected && 'observedAt' in data ? { priceUsd: selected.priceUsd, timestamp: new Date(data.observedAt!).toISOString() } : undefined;
        const previous = usable(cache.get(job.token)?.quote);
        const latest = quote && (!previous || Date.parse(quote.timestamp) >= Date.parse(previous.timestamp)) ? quote : previous;
        const reason = quote ? undefined : 'reason' in data ? data.reason : 'current_quote_unavailable';
        const retryAfterMs = quote ? undefined : 'retryAfterMs' in data ? data.retryAfterMs : 30_000;
        remember(job.token, { quote: latest, retryAt: now() + (retryAfterMs ?? 0), reason });
        settle(job, result(job.token, reason, retryAfterMs));
      }
    } catch {
      for (const job of batch) {
        remember(job.token, { quote: usable(cache.get(job.token)?.quote), retryAt: now() + 5000, reason: 'current_quote_unavailable' });
        settle(job, result(job.token, 'current_quote_unavailable', 5000));
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      active = false; schedule();
    }
  }
  function enqueue(token: string) {
    const existing = jobs.get(token); if (existing) return existing.promise;
    if (jobs.size >= maxEntries) return Promise.resolve(result(token, 'quote_busy', 3000));
    let resolve!: (value: TokenPositionQuoteResult) => void;
    const promise = new Promise<TokenPositionQuoteResult>(accept => { resolve = accept; });
    const job: Job = { token, promise, resolve, settled: false };
    job.timer = setTimeout(() => settle(job, result(token, 'quote_busy', 3000)), waitTimeoutMs);
    jobs.set(token, job); queued.set(token, job); schedule();
    return promise;
  }
  return async (rawToken: string): Promise<TokenPositionQuoteResult> => {
    const token = rawToken.toLowerCase();
    if (!addressPattern.test(token)) return { reason: 'current_quote_unavailable' };
    const entry = cache.get(token), quote = usable(entry?.quote);
    if (usable(quote, freshMs)) return { quote: { ...quote! } };
    if (pausedUntil > now()) return result(token, 'quote_rate_limited', pausedUntil - now());
    if (entry && entry.retryAt > now()) return result(token, entry.reason ?? 'current_quote_unavailable', entry.retryAt - now());
    const work = enqueue(token);
    // A still-valid observation remains useful while its refresh runs, but its
    // timestamp must never become the time at which the cache was read.
    if (quote) { void work; return { quote: { ...quote } }; }
    return work;
  };
}

export const currentTokenPositionQuote = createTokenPositionQuote();
