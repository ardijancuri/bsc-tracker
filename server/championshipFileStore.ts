import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { championship, championshipLimit, validChampionshipDate, type ChampionshipSnapshot } from '../shared/championship.js';
import type { ChampionshipStore } from './championship.js';

const number = z.string().regex(/^-?\d+(?:\.\d+)?$/).refine(value => Number.isFinite(Number(value)));
const httpsUrl = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
});
export const championshipSnapshotSchema = z.object({
  period: z.enum(['daily', 'overall']), date: z.string().nullable(), updatedAt: z.string().datetime(), fetchedAt: z.string().datetime(),
  items: z.array(z.object({ rank: z.number().int().min(1).max(championshipLimit), id: z.string().uuid(),
    xHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/), name: z.string(), avatarUrl: httpsUrl.nullable(), verified: z.boolean(),
    liveUrl: httpsUrl.refine(value => {
      try { return ['twitch.tv', 'kick.com', 'binance.com', 'youtube.com', 'youtu.be'].includes(new URL(value).hostname.replace(/^www\./, '')); }
      catch { return false; }
    }).nullable(),
    isLive: z.boolean(), pnlUsd: number.nullable(), roi: number.nullable() })).max(championshipLimit),
});

function selection(key: string) {
  if (key === 'overall:all') return { period: 'overall' as const, date: null, file: 'overall.json' };
  const date = /^daily:(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1];
  if (!date || !validChampionshipDate(date, Date.parse(championship.endsAt))) throw new Error('Invalid championship snapshot key');
  return { period: 'daily' as const, date, file: `daily.${date}.json` };
}

/** Validate disk/import data independently of the process that captured it. */
export function validateChampionshipSnapshot(value: unknown, key: string, now = Date.now()): ChampionshipSnapshot | undefined {
  const expected = selection(key);
  const parsed = championshipSnapshotSchema.safeParse(value);
  if (!parsed.success) return;
  const snapshot = parsed.data;
  const updatedAt = Date.parse(snapshot.updatedAt), fetchedAt = Date.parse(snapshot.fetchedAt);
  if (snapshot.period !== expected.period || snapshot.date !== expected.date
    || updatedAt > now + 60_000 || fetchedAt > now + 60_000 || updatedAt > fetchedAt + 60_000
    || snapshot.items.some((item, index) => item.rank !== index + 1)
    || new Set(snapshot.items.map(item => item.id)).size !== snapshot.items.length) return;
  return snapshot;
}

/** Provider time wins; a later capture can update identities at the same provider time. */
export function compareChampionshipSnapshots(a: ChampionshipSnapshot, b: ChampionshipSnapshot) {
  return Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || Date.parse(a.fetchedAt) - Date.parse(b.fetchedAt);
}

/** The directory is opt-in; keys can only address this competition's bounded set of boards. */
export function createChampionshipFileStore(directory: string): ChampionshipStore {
  if (!directory.trim()) throw new Error('Championship snapshot directory is empty');
  const root = resolve(directory);
  const file = (key: string) => join(root, selection(key).file);
  const load = async (key: string) => {
    try {
      const bytes = await readFile(file(key));
      if (bytes.length > 256 * 1024) throw new Error('Championship snapshot is too large');
      return validateChampionshipSnapshot(JSON.parse(bytes.toString('utf8')), key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof SyntaxError) return;
      throw error;
    }
  };
  return {
    load,
    async save(key, value) {
      const snapshot = validateChampionshipSnapshot(value, key);
      if (!snapshot) throw new Error('Invalid championship snapshot');
      const text = JSON.stringify(snapshot) + '\n';
      if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Championship snapshot is too large');
      const destination = file(key), lockPath = `${destination}.lock`;
      await mkdir(root, { recursive: true });
      // Importers share this exclusive lock so their comparison and rename cannot interleave.
      const lock = await open(lockPath, 'wx', 0o600);
      const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const previous = await load(key);
        if (previous && compareChampionshipSnapshots(snapshot, previous) <= 0) return;
        const output = await open(temporary, 'wx', 0o600);
        try {
          await output.writeFile(text, 'utf8');
          await output.sync();
        } finally { await output.close(); }
        await rename(temporary, destination);
      } finally {
        try { await rm(temporary, { force: true }); }
        finally {
          try { await lock.close(); }
          finally { await rm(lockPath, { force: true }); }
        }
      }
    },
  };
}
