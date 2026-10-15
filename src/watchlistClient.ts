import type { Watchlist } from '../shared/intelligence';

class WatchlistRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export function watchlistIdentityChanged(reason: unknown) { return reason instanceof WatchlistRequestError && (reason.status === 401 || reason.status === 409); }
async function requestWatchlist(url: string, method: string, owner: string, body?: unknown): Promise<Watchlist> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { method, cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', 'X-Watchlist-Owner': owner, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new WatchlistRequestError(value.error || 'Watchlist unavailable', response.status);
    return value as Watchlist;
  } finally { clearTimeout(timer); }
}
export function loadWatchlist(url: string, owner: string) { return requestWatchlist(url, 'GET', owner); }
export function mutateWatchlist(url: string, method: 'PUT' | 'DELETE', owner: string, body?: unknown) { return requestWatchlist(url, method, owner, body); }
