import type { NodeAccountingSummary } from '../shared/nodeAccounting';

const address = /^0x[a-f0-9]{40}$/i, digest = /^[a-f0-9]{64}$/i;
const exactNumber = (raw: unknown) => typeof raw === 'string' && raw.trim() !== '' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()) && Number.isFinite(Number(raw)) ? Number(raw) : null;
export function validNodeSummaryIdentity(summary: NodeAccountingSummary | undefined, wallet: string, token: string, now = Date.now()) {
  if (!summary || !address.test(wallet) || !address.test(token) || summary.tokenAddress?.toLowerCase() !== token.toLowerCase()) return false;
  const snapshot = summary.snapshot;
  if (!snapshot || snapshot.version !== 2 || !digest.test(snapshot.snapshotId) || !digest.test(snapshot.historyFingerprint)
    || !['node', 'mixed', 'imported'].includes(snapshot.source) || snapshot.scope !== 'public'
    || !Number.isFinite(Date.parse(snapshot.asOf)) || Date.parse(snapshot.asOf) > now + 1000) return false;
  if (summary.tracking !== undefined) {
    const tracking = summary.tracking;
    if (tracking.version !== 1 || tracking.source !== 'fresh' || summary.walletAddress?.toLowerCase() !== wallet.toLowerCase()
      || !['node','mixed'].includes(snapshot.source) || !/^\d+$/.test(tracking.fromBlock) || !/^\d{4}-\d{2}-\d{2}$/.test(tracking.utcDay)
      || !/^\d+$/.test(snapshot.coveredThroughBlock ?? '') || BigInt(snapshot.coveredThroughBlock!) < BigInt(tracking.fromBlock)) return false;
  }
  return true;
}

/** Display only values explicitly approved by the server. Historical realized
 * cash does not expire with the open position's independently dated quote. */
export function nodeSummaryDisplay(summary: NodeAccountingSummary | undefined, wallet: string, token: string, now = Date.now(), options: { realizedOnly?: boolean } = {}): { value: number | null; kind: 'estimated' | 'realized' | 'unavailable' } {
  const unavailable = { value: null, kind: 'unavailable' as const };
  if (!validNodeSummaryIdentity(summary, wallet, token, now)) return unavailable;
  const value = summary!, snapshot = value.snapshot!, fresh = value.tracking?.source === 'fresh';
  const realizedReady = fresh ? value.realizedStatus === 'ready' && snapshot.complete
    && ![value.reason, ...(snapshot.reasons ?? [])].some(reason => reason && /unknown_cost|unknown_fee|unknown_purchase|unknown_sale|unknown_incoming|unknown_outgoing|balance_mismatch|wallet_decode_gap|decoding_pending|registration_pending/.test(reason))
    : value.status === 'ready' && snapshot.complete;
  if (!options.realizedOnly && value.position === 'open' && value.status === 'ready' && snapshot.complete) {
    const at = Date.parse((fresh ? value.quotedAt : snapshot.asOf) ?? ''), estimated = exactNumber(value.estimatedProfitUsd);
    if (estimated !== null && Number.isFinite(at) && at <= now + 1000 && now - at <= (fresh ? 120_000 : 180_000)) return { value: estimated, kind: 'estimated' };
  }
  const realized = exactNumber(value.realizedProfitUsd);
  if (!realizedReady || realized === null) return unavailable;
  return { value: realized, kind: 'realized' };
}

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
  if (!address.test(wallet) || !address.test(token)) return Promise.reject(new Error('Position summary identity changed'));
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
        // Validate the whole response before populating any cache entry. A
        // private or wrong-wallet body cannot leak through a public card batch.
        for (const token of selected) {
          const value = result.summaries?.[token];
          if (!value || value.tokenAddress !== token || value.tracking !== undefined && !validNodeSummaryIdentity(value, wallet, token)) throw new Error('Position summary identity changed');
        }
        for (const token of selected) {
          const value = result.summaries[token];
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
