import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';

export const CHART_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const HISTORICAL_CHART_TTL_MS = 7 * 86400_000;
export const RECENT_CHART_TTL_MS = 15_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
type Envelope = { version: 1; key: string; observedAt: number; expiresAt: number; hash: string; value: unknown };

/** Disposable chart pages only. Files contain normalized data, never provider
 * credentials. LRU state is the file access modification time, not a DB row.
 * A bounded filesystem lease serializes eviction across API/worker processes. */
export class ChartDiskCache {
  private readonly directory: string;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly counters = { hits: 0, misses: 0, writes: 0, evictions: 0, corrupt: 0 };
  constructor(directory: string, private readonly options: { maxBytes?: number; now?: () => number } = {}) {
    this.directory = path.resolve(directory);
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw new Error('Invalid chart cache limit');
  }
  private get maxBytes() { return this.options.maxBytes ?? CHART_CACHE_MAX_BYTES; }
  private now() { return (this.options.now ?? Date.now)(); }
  private file(key: string) { return path.join(this.directory, digest(key) + '.json'); }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const lease = path.join(this.directory, '.lease');
      const deadline = Date.now() + 5000;
      let handle: Awaited<ReturnType<typeof open>>;
      for (;;) {
        try { handle = await open(lease, 'wx', 0o600); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          try { if (Date.now() - (await stat(lease)).mtimeMs > 30_000) await unlink(lease); } catch (problem) { if (!missing(problem)) throw problem; }
          if (Date.now() >= deadline) throw new Error('chart_cache_busy');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      try { return await work(); }
      finally { await handle.close(); await unlink(lease).catch(error => { if (!missing(error)) throw error; }); }
    });
    this.serial = run; return run;
  }
  async get<T>(key: string): Promise<{ value: T; observedAt: number } | null> {
    return this.exclusive(async () => {
      const file = this.file(key);
      try {
        const size = (await stat(file)).size;
        if (size > this.maxBytes) throw new Error('oversized');
        const envelope = JSON.parse(await readFile(file, 'utf8')) as Envelope;
        if (envelope.version !== 1 || envelope.key !== digest(key) || !Number.isFinite(envelope.observedAt)
          || !Number.isFinite(envelope.expiresAt) || envelope.observedAt > this.now() + 1000
          || envelope.hash !== digest(JSON.stringify(envelope.value))) throw new Error('corrupt');
        if (envelope.expiresAt <= this.now()) { await unlink(file); this.counters.misses++; return null; }
        const time = new Date(this.now()); await utimes(file, time, time);
        this.counters.hits++; return { value: envelope.value as T, observedAt: envelope.observedAt };
      } catch (error) {
        if (!missing(error)) { this.counters.corrupt++; await unlink(file).catch(() => {}); }
        this.counters.misses++; return null;
      }
    });
  }
  async put(key: string, value: unknown, ttlMs: number, observedAt = this.now()): Promise<boolean> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(observedAt) || observedAt > this.now() + 1000) throw new Error('Invalid chart cache lifetime');
    const envelope: Envelope = { version: 1, key: digest(key), observedAt, expiresAt: observedAt + ttlMs,
      hash: digest(JSON.stringify(value)), value };
    const text = JSON.stringify(envelope), bytes = Buffer.byteLength(text);
    if (bytes > this.maxBytes || envelope.expiresAt <= this.now()) return false;
    return this.exclusive(async () => {
      const file = this.file(key);
      await unlink(file).catch(error => { if (!missing(error)) throw error; });
      const entries = await this.entries();
      let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of entries.sort((a, b) => a.accessedAt - b.accessedAt || a.file.localeCompare(b.file))) {
        if (total + bytes <= this.maxBytes) break;
        await unlink(entry.file); total -= entry.bytes; this.counters.evictions++;
      }
      const temporary = path.join(this.directory, '.' + randomUUID() + '.tmp');
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
      const time = new Date(this.now()); await utimes(file, time, time);
      this.counters.writes++; return true;
    });
  }
  private async entries() {
    const entries: { file: string; bytes: number; accessedAt: number }[] = [];
    for (const name of await readdir(this.directory)) {
      const file = path.join(this.directory, name);
      if (/^\.[a-f0-9-]+\.tmp$/.test(name)) {
        const data = await stat(file);
        if (Date.now() - data.mtimeMs > 30_000) await unlink(file);
        continue;
      }
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const data = await stat(file);
      let expired = false;
      // Expiry is in the fixed small header before the candle payload. Eviction
      // must not reread the whole 256 MiB cache for every new 500-bar page.
      try {
        const handle = await open(file, 'r'), header = Buffer.alloc(384);
        let count: number;
        try { count = (await handle.read(header, 0, header.length, 0)).bytesRead; } finally { await handle.close(); }
        const timestamp = /"expiresAt":(\d+),/.exec(header.subarray(0, count).toString());
        if (!timestamp) throw new Error('Invalid cache header');
        expired = Number(timestamp[1]) <= this.now();
      } catch { expired = true; this.counters.corrupt++; }
      if (expired) { await unlink(file); continue; }
      entries.push({ file, bytes: data.size, accessedAt: data.mtimeMs });
    }
    return entries;
  }
  async statistics() {
    return this.exclusive(async () => {
      const entries = await this.entries();
      return { ...this.counters, entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), maxBytes: this.maxBytes };
    });
  }
}
