import type { NodeAccountingSummary } from '../shared/nodeAccounting';

type Subscriber = { resolve(value: NodeAccountingSummary): void; reject(error: unknown): void; signal: AbortSignal; abort(): void };
const batches = new Map<string, Map<string, Set<Subscriber>>>();
const activePairs = new Map<string, Set<Subscriber>>();
const cache = new Map<string, { value: NodeAccountingSummary; observedAt: number }>();
let scheduled = false;

/** Six cards share one compact request, without loading six transaction histories. */
export function requestNodePnlSummary(wallet: string, token: string, signal: AbortSignal): Promise<NodeAccountingSummary> {
  wallet = wallet.toLowerCase(); token = token.toLowerCase();
  const key = `${wallet}:${token}`, saved = cache.get(key);
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  if (saved && Date.now() - saved.observedAt < 1500) return Promise.resolve(saved.value);
  return new Promise((resolve, reject) => {
    const existing = activePairs.get(key);
    const batch = batches.get(wallet) ?? new Map<string, Set<Subscriber>>(), subscribers = existing ?? batch.get(token) ?? new Set<Subscriber>();
    const subscriber: Subscriber = { resolve, reject, signal, abort: () => {
      subscribers.delete(subscriber); reject(new DOMException('Cancelled', 'AbortError'));
    } };
    subscribers.add(subscriber);
    activePairs.set(key, subscribers);
    signal.addEventListener('abort', subscriber.abort, { once: true });
    if (!existing) {
      batch.set(token, subscribers); batches.set(wallet, batch);
      if (!scheduled) { scheduled = true; queueMicrotask(() => void flush()); }
    }
  });
}

async function flush() {
  scheduled = false;
  const work = [...batches.entries()]; batches.clear();
  await Promise.all(work.map(async ([wallet, batch]) => {
    const tokens = [...batch].filter(([token, subscribers]) => { if (subscribers.size) return true; activePairs.delete(`${wallet}:${token}`); return false; }).map(([token]) => token);
    for (let offset = 0; offset < tokens.length; offset += 24) {
      const selected = tokens.slice(offset, offset + 24);
      try {
        const response = await fetch(`/api/kols/${encodeURIComponent(wallet)}/token-summaries?tokens=${selected.join(',')}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error('Position summaries unavailable');
        const result = await response.json() as { summaries: Record<string, NodeAccountingSummary> };
        for (const token of selected) {
          const value = result.summaries[token];
          if (!value || value.tokenAddress !== token) throw new Error('Position summary identity changed');
          cache.set(`${wallet}:${token}`, { value, observedAt: Date.now() });
          for (const subscriber of batch.get(token) ?? []) if (!subscriber.signal.aborted) subscriber.resolve(value);
        }
      } catch (error) { for (const token of selected) for (const subscriber of batch.get(token) ?? []) if (!subscriber.signal.aborted) subscriber.reject(error); }
      finally { for (const token of selected) {
        activePairs.delete(`${wallet}:${token}`);
        for (const subscriber of batch.get(token) ?? []) subscriber.signal.removeEventListener('abort', subscriber.abort);
      } }
    }
  }));
  if (cache.size > 300) for (const key of [...cache.keys()].slice(0, cache.size - 300)) cache.delete(key);
}
