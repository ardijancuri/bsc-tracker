import { createTokenChartRequests } from './tokenChartRequest';
import { tradeActivityBase } from './tradeRequestContext';

export type TokenChartRequestContext = { accountId: string; walletAddress: string; membershipRevision?: string };
export const tokenChartContextKey = (context?: TokenChartRequestContext) => context
  ? JSON.stringify([context.accountId, context.walletAddress.toLowerCase(), context.membershipRevision ?? 'checking-membership']) : 'public';

/** Private viewers share work only inside the exact account/wallet/membership
 * scope. Nothing from these requests is persisted in browser storage. */
export function createPrivateTokenChartRequests(context: TokenChartRequestContext, options: { fetcher?: typeof fetch; now?: () => number } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const scopedFetch: typeof fetch = async (input, init) => {
    if (typeof input !== 'string') throw new Error('Invalid private chart request');
    const match = /^\/api\/tokens\/(0x[0-9a-f]{40})\/chart(\?.*)?$/.exec(input);
    if (!match) throw new Error('Invalid private chart request');
    const headers = new Headers(init?.headers); headers.set('X-Watchlist-Owner', context.accountId);
    const query = new URLSearchParams((match[2] ?? '').replace(/^\?/, ''));
    if (context.membershipRevision) query.set('membership', context.membershipRevision);
    const url = tradeActivityBase(context.walletAddress, match[1], { kind: 'journal', accountId: context.accountId }) + '/chart?' + query;
    return fetcher(url, { ...init, headers });
  };
  return createTokenChartRequests({ fetcher: scopedFetch, now: options.now, storage: null });
}

const privateClients = new Map<string, ReturnType<typeof createTokenChartRequests>>();
export function privateTokenChartRequests(context: TokenChartRequestContext) {
  const key = tokenChartContextKey(context), prior = privateClients.get(key);
  if (prior) { privateClients.delete(key); privateClients.set(key, prior); return prior; }
  const requests = createPrivateTokenChartRequests(context);
  if (privateClients.size >= 24) privateClients.delete(privateClients.keys().next().value!);
  privateClients.set(key, requests); return requests;
}
