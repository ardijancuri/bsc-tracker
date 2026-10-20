import { z } from 'zod';
import { championshipApiUrl, championshipLimit, type ChampionshipBoard, type ChampionshipPeriod, type ChampionshipSnapshot } from '../shared/championship.js';
import reference from './data/championship-reference.json' with { type: 'json' };

const number = z.string().regex(/^-?\d+(?:\.\d+)?$/).refine(value => Number.isFinite(Number(value)));
const payloadSchema = z.object({ code: z.literal(0), data: z.object({
  status: z.string(), updated_at: z.number().int().positive(), date: z.string().optional(),
  list: z.array(z.object({
    rank: z.number().int().positive(), user_id: z.string().uuid(), x_handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
    live_url: z.string().nullish(), is_live: z.boolean().optional(),
    daily_pnl: number.nullish(), total_pnl: number.nullish(), roi: number.nullish(),
  })).max(1000),
}) });

function streamUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && ['twitch.tv', 'kick.com', 'binance.com', 'youtube.com', 'youtu.be'].includes(url.hostname.replace(/^www\./, '')) ? url.href : null;
  } catch { return null; }
}

export function parseChampionshipBoard(payload: unknown, period: ChampionshipPeriod, date: string | null, now = Date.now()): ChampionshipSnapshot {
  const { data } = payloadSchema.parse(payload);
  if (period === 'daily' && data.date !== date?.replaceAll('-', '')) throw new Error('GMGN returned a different daily board');
  const updatedAt = new Date(data.updated_at * 1000).toISOString();
  if (data.updated_at * 1000 > now + 60_000) throw new Error('GMGN returned a future update time');
  const selected = data.list.filter(row => row.rank <= championshipLimit).sort((a, b) => a.rank - b.rank);
  if (new Set(selected.map(row => row.rank)).size !== selected.length || new Set(selected.map(row => row.user_id)).size !== selected.length) {
    throw new Error('GMGN returned duplicate rankings');
  }
  return { period, date: period === 'daily' ? date : null, updatedAt, fetchedAt: new Date(now).toISOString(),
    items: selected.map(row => {
      const identity = reference.identities.find(item => item.id === row.user_id);
      return { rank: row.rank, id: row.user_id, xHandle: row.x_handle, name: identity?.name || row.x_handle,
        avatarUrl: identity?.avatarUrl || null, verified: identity?.verified || false,
        liveUrl: streamUrl(row.live_url), isLive: row.is_live === true,
        pnlUsd: (period === 'daily' ? row.daily_pnl : row.total_pnl) ?? null, roi: row.roi ?? null };
    }),
  };
}

export interface ChampionshipStore {
  load(key: string): Promise<unknown>;
  save(key: string, value: ChampionshipSnapshot): Promise<void>;
}

const snapshotSchema = z.object({
  period: z.enum(['daily', 'overall']), date: z.string().nullable(), updatedAt: z.string().datetime(), fetchedAt: z.string().datetime(),
  items: z.array(z.object({ rank: z.number().int().min(1).max(championshipLimit), id: z.string().uuid(),
    xHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/), name: z.string(), avatarUrl: z.string().url().nullable(), verified: z.boolean(),
    liveUrl: z.string().url().nullable(), isLive: z.boolean(), pnlUsd: number.nullable(), roi: number.nullable() })).max(championshipLimit),
});

/** Separate period/date caches and shared requests; explicit refreshes bypass the polling cooldown. */
export function createChampionshipService({ fetcher = fetch, now = Date.now, store }:
  { fetcher?: typeof fetch; now?: () => number; store?: ChampionshipStore } = {}) {
  type Entry = { snapshot?: ChampionshipSnapshot; checkedAt: number; blocked: boolean; healthy: boolean; loaded: boolean; inFlight?: Promise<void> };
  const entries = new Map<string, Entry>();
  const capturedAt = Date.parse(reference.capturedAt);
  for (const period of ['daily', 'overall'] as const) {
    const date = period === 'daily' ? reference.daily.date : null;
    const snapshot = parseChampionshipBoard(reference[period].payload, period, date, capturedAt);
    entries.set(`${period}:${date || 'all'}`, { snapshot, checkedAt: -Infinity, blocked: false, healthy: false, loaded: false });
  }
  return {
    async get(period: ChampionshipPeriod, date: string | null, { refresh = false }: { refresh?: boolean } = {}): Promise<ChampionshipBoard> {
      const key = `${period}:${period === 'daily' ? date : 'all'}`;
      let entry = entries.get(key);
      if (!entry) { entry = { checkedAt: -Infinity, blocked: false, healthy: false, loaded: false }; entries.set(key, entry); }
      const current = entry;
      if (!current.inFlight && (refresh || now() - current.checkedAt >= 60_000)) {
        current.inFlight = (async () => {
          if (!current.loaded) {
            current.loaded = true;
            try {
              const saved = snapshotSchema.safeParse(await store?.load(key));
              if (saved.success && saved.data.period === period && saved.data.date === date
                && Date.parse(saved.data.fetchedAt) <= now() + 60_000
                && (!current.snapshot || Date.parse(saved.data.updatedAt) > Date.parse(current.snapshot.updatedAt))) current.snapshot = saved.data;
            } catch { /* A cache failure must not hide verified rankings. */ }
          }
          try {
            current.healthy = false;
            const response = await fetcher(championshipApiUrl(period, date), {
              headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store',
            });
            current.blocked = response.status === 401 || response.status === 403;
            if (!response.ok) throw new Error(`Championship upstream HTTP ${response.status}`);
            const snapshot = parseChampionshipBoard(await response.json(), period, date, now());
            // Never replace a newer verified snapshot with a regressed provider response.
            if (!current.snapshot || Date.parse(snapshot.updatedAt) >= Date.parse(current.snapshot.updatedAt)) {
              current.snapshot = snapshot;
              current.healthy = true;
              try { await store?.save(key, snapshot); } catch { /* Memory cache remains usable. */ }
            }
          } catch { /* Keep the original timestamps and report saved data honestly. */ }
          finally { current.checkedAt = now(); }
        })().finally(() => { current.inFlight = undefined; });
      }
      await current.inFlight;
      if (!current.snapshot) throw new Error('Championship rankings are unavailable');
      const snapshot = current.snapshot;
      const fresh = current.healthy && !current.blocked && now() - Date.parse(snapshot.fetchedAt) < 120_000
        && now() - Date.parse(snapshot.updatedAt) < 5 * 60_000;
      return { ...snapshot, freshness: fresh ? 'live' : 'saved', upstreamBlocked: current.blocked,
        sourceUrl: championshipApiUrl(period, date) };
    },
  };
}
