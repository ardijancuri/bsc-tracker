import { kolTokenPositionQuoteMaxAgeMs } from '../shared/kolTokenTrades.js';
import { MarketProviderDeferred } from './geckoApi.js';
import { gmgnApiKey, gmgnRequest, GmgnHttpError, recordGmgnCacheHit, type GmgnRequestOptions } from './gmgnApi.js';
import type { TokenPositionQuote, TokenPositionQuoteResult } from './tokenPositionQuote.js';

type Requester = (url: URL, options: GmgnRequestOptions) => Promise<unknown>;
export interface PositionQuoteLoadOptions { foreground?: boolean | (() => boolean); deadlineAt?: () => number }
const foregroundRequested = (options: PositionQuoteLoadOptions) => typeof options.foreground === 'function' ? options.foreground() : options.foreground === true;
const positivePrice = (value: unknown): value is string => typeof value === 'string'
  && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;

/** Token info is a one-unit current price lookup, independent of OHLC history.
 * All traffic still uses the shared account limiter, including its cooldown. */
export function createTokenGmgnPositionQuote({ request = gmgnRequest, now = Date.now, timeoutMs = 1500,
  apiKey = () => gmgnApiKey('market'), maxEntries = 128 }:
  { request?: Requester; now?: () => number; timeoutMs?: number; apiKey?: () => string; maxEntries?: number } = {}) {
  type Entry = { quote?: TokenPositionQuote; retryAt: number; reason?: string };
  type Job = { work: Promise<TokenPositionQuoteResult>; foreground: boolean; subscribers: PositionQuoteLoadOptions[] };
  const cache = new Map<string, Entry>(), jobs = new Map<string, Job>();
  const foreground = (job: Job) => job.foreground ||= job.subscribers.some(foregroundRequested);
  const usable = (quote: TokenPositionQuote | undefined, maxAge = kolTokenPositionQuoteMaxAgeMs) => {
    const observed = Date.parse(quote?.timestamp ?? '');
    return quote && positivePrice(quote.priceUsd) && Number.isFinite(observed) && observed <= now() && now() - observed <= maxAge ? quote : undefined;
  };
  const remember = (token: string, entry: Entry) => {
    cache.delete(token); cache.set(token, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
  };
  const result = (token: string, reason?: string, retryAfterMs?: number): TokenPositionQuoteResult => {
    const quote = usable(cache.get(token)?.quote);
    return { ...(quote ? { quote: { ...quote } } : {}), ...(reason ? { reason } : {}), ...(retryAfterMs ? { retryAfterMs } : {}) };
  };
  async function refresh(token: string, key: string, job: Job) {
    const controller = new AbortController();
    const startedAt = Date.now();
    const deadlineAt = () => Math.min(startedAt + (foreground(job) ? 8000 : timeoutMs),
      Math.max(...job.subscribers.map(subscriber => subscriber.deadlineAt?.() ?? Infinity)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = new URL('https://openapi.gmgn.ai/v1/token/info');
      url.searchParams.set('chain', 'bsc'); url.searchParams.set('address', token);
      // The shared requester adds timestamp/client_id at dispatch, after any
      // queue or account-budget delay, so authentication cannot expire waiting.
      const response = await Promise.race([request(url, { apiKey: key, workload: 'market', weight: 1, priority: 'prefetch',
        foreground: () => foreground(job), signal: controller.signal, timeoutMs: 8000 }),
        new Promise<never>((_, reject) => {
          const expire = () => {
            const remaining = deadlineAt() - Date.now();
            if (remaining > 0) timer = setTimeout(expire, remaining);
            else { controller.abort(); reject(Error('quote_timeout')); }
          };
          timer = setTimeout(expire, Math.max(0, deadlineAt() - Date.now()));
        })]);
      const body = response as { code?: unknown; data?: { address?: unknown; price?: { price?: unknown } } } | null;
      if (body?.code !== 0 || typeof body.data?.address !== 'string' || body.data.address.toLowerCase() !== token || !positivePrice(body.data.price?.price)) {
        remember(token, { quote: usable(cache.get(token)?.quote), retryAt: now() + 30_000, reason: 'current_quote_unavailable' });
        return result(token, 'current_quote_unavailable', 30_000);
      }
      // This dates the successful current-info response, never a cached read or
      // an error. No historical trade timestamp is substituted for this mark.
      const quote = { priceUsd: body.data.price.price, timestamp: new Date(now()).toISOString() };
      remember(token, { quote, retryAt: 0 }); return { quote: { ...quote } };
    } catch (error) {
      const reason = error instanceof MarketProviderDeferred && error.reason === 'rate_limited' ? 'quote_rate_limited'
        : error instanceof GmgnHttpError && [401, 403].includes(error.status) ? 'quote_key_unavailable' : 'current_quote_unavailable';
      const suppliedDelay = error instanceof MarketProviderDeferred || error instanceof GmgnHttpError ? error.retryAfterMs : undefined;
      const retryAfterMs = suppliedDelay && Number.isFinite(suppliedDelay) ? Math.max(1000, Math.min(600_000, suppliedDelay)) : 3000;
      remember(token, { quote: usable(cache.get(token)?.quote), retryAt: now() + retryAfterMs, reason });
      return result(token, reason, retryAfterMs);
    } finally { if (timer) clearTimeout(timer); }
  }
  return async (rawToken: string, options: PositionQuoteLoadOptions = {}): Promise<TokenPositionQuoteResult> => {
    const token = rawToken.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(token)) return { reason: 'current_quote_unavailable' };
    if (options.deadlineAt && options.deadlineAt() <= Date.now()) return result(token, 'current_quote_unavailable', 3000);
    const entry = cache.get(token), quote = usable(entry?.quote);
    if (usable(quote, 30_000)) { recordGmgnCacheHit('market'); return { quote: { ...quote! } }; }
    if (entry && entry.retryAt > now()) return result(token, entry.reason ?? 'current_quote_unavailable', entry.retryAt - now());
    let work = jobs.get(token);
    if (!work) {
      const key = apiKey().trim();
      if (!key) return result(token, 'quote_key_unavailable', 60_000);
      if (jobs.size >= 8) return result(token, 'quote_busy', 3000);
      work = { foreground: foregroundRequested(options), subscribers: [options], work: null as unknown as Promise<TokenPositionQuoteResult> };
      jobs.set(token, work); work.work = refresh(token, key, work);
      void work.work.finally(() => { if (jobs.get(token) === work) jobs.delete(token); }).catch(() => {});
    } else { work.subscribers.push(options); foreground(work); }
    if (quote) { void work; return { quote: { ...quote } }; }
    return work.work;
  };
}

export const currentTokenGmgnPositionQuote = createTokenGmgnPositionQuote();
