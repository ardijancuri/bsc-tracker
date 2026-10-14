import { kolTokenPositionQuoteMaxAgeMs, type KolTokenActivity } from '../shared/kolTokenTrades.js';

/** Profile cards poll independently of expensive history/provider work. Keep the
 * original proof and quote timestamps; this cache never refreshes evidence. */
export function createKolTokenProfilePnl({ now = Date.now, waitMs = 75, maxJobs = 8 }:
  { now?: () => number; waitMs?: number; maxJobs?: number } = {}) {
  type Entry = { revision: string; work: Promise<KolTokenActivity | null>; value?: KolTokenActivity;
    completedAt?: number; deliveredAt?: number };
  const entries = new Map<string, Entry>();
  let active = 0;
  const ready = (value: KolTokenActivity) => value.realizedAccounting?.status === 'ready'
    && !value.realizedAccounting.retryAfterMs
    && !value.realizedAccounting.position?.retryAfterMs
    && (value.realizedAccounting.position?.status !== 'open' || value.realizedAccounting.position.estimatedProfitUsd !== null);
  const evidenceExpired = (value: KolTokenActivity) => {
    // A ready snapshot can have less validity left than this cache's ten-second
    // lifetime. Refresh it when its original evidence expires, while leaving
    // pending responses on their existing delivery/cooldown schedule.
    if (!ready(value)) return false;
    const expiredDate = (date: string | null | undefined, maxAge: number) => {
      const timestamp = typeof date === 'string' ? Date.parse(date) : NaN;
      return !Number.isFinite(timestamp) || timestamp > now() + 1000 || now() - timestamp > maxAge;
    };
    const proof = value.inventory?.coverage, position = value.realizedAccounting?.position;
    return proof?.complete === true && expiredDate(proof.checkedAt, 180_000)
      || position?.status === 'open' && expiredDate(position.pricedAt, kolTokenPositionQuoteMaxAgeMs);
  };
  const expired = (entry: Entry) => entry.value && entry.completedAt !== undefined
    && (now() - entry.completedAt >= 10_000 || now() < entry.completedAt || evidenceExpired(entry.value)
      || !ready(entry.value) && entry.deliveredAt !== undefined && now() - entry.deliveredAt >= 1000);
  return async (key: string, revision: string, prepare: () => Promise<KolTokenActivity>): Promise<KolTokenActivity | null> => {
    for (const [name, item] of entries) if (expired(item)) entries.delete(name);
    let entry = entries.get(key);
    if (entry?.revision !== revision) { entries.delete(key); entry = undefined; }
    if (!entry) {
      if (active >= maxJobs) return null;
      active += 1;
      const created: Entry = { revision, work: Promise.resolve(null) };
      entries.set(key, created);
      created.work = Promise.resolve().then(prepare).then(value => {
        created.value = value; created.completedAt = now();
        return value;
      }, () => {
        if (entries.get(key) === created) entries.delete(key);
        return null;
      }).finally(() => { active -= 1; });
      entry = created;
      // In-flight work is bounded separately and must never be duplicated by eviction.
      for (const [name, item] of entries) {
        if (entries.size <= 64) break;
        if (item.completedAt !== undefined) entries.delete(name);
      }
    }
    if (!entry.value) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([entry.work, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    if (!entry.value) return null;
    entry.deliveredAt ??= now();
    return entry.value;
  };
}
