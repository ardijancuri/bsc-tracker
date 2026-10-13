import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CandleInterval, MarketCandle } from '../shared/intelligence.js';

const steps: Record<CandleInterval, number> = { '1m': 60, '5m': 300, '1h': 3600, '4h': 14400, '1d': 86400 };
const chunkBars = 1000;
type Chunk = { bucket: number; first: number; last: number; count: number };
export interface HistoryManifest {
  version: 1; address: string; interval: CandleInterval; updatedAt: string | null;
  complete: boolean; volumeCurrency: 'usd' | 'unknown'; chunks: Chunk[];
  coverage?: [number, number][];
  latestTo?: number;
}
type IO = { mkdir: typeof mkdir; readFile: typeof readFile; rename: typeof rename; stat: typeof stat; writeFile: typeof writeFile };

export function mergeHistoryCandles(previous: MarketCandle[], incoming: MarketCandle[], limit = Infinity) {
  const candles = new Map<number, MarketCandle>(previous.map(c => [c.time, c]));
  for (const candle of incoming) candles.set(candle.time, candle);
  const sorted = [...candles.values()].sort((a, b) => a.time - b.time);
  return sorted.length > limit ? sorted.slice(-limit) : sorted;
}

export function mergeHistoryCoverage(previous: [number, number][], incoming?: [number, number]) {
  const sorted = [...previous, ...(incoming && incoming[0] <= incoming[1] ? [incoming] : [])].sort((a, b) => a[0] - b[0]);
  const result: [number, number][] = [];
  for (const range of sorted) {
    const last = result.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else result.push([...range]);
  }
  return result;
}

/** Next boundary fills the newest uncovered gap, including gaps after a long offline period. */
export function historyArchiveCursor(manifest: HistoryManifest) {
  if (manifest.latestTo === undefined) return undefined;
  const range = manifest.coverage?.find(([from, to]) => from <= manifest.latestTo! && to >= manifest.latestTo!);
  return range ? range[0] > 1 ? range[0] : undefined : manifest.latestTo;
}

/** Store bounded time chunks, rather than repeatedly serializing a token's entire life. */
export function createTokenHistoryArchive(directory: string, io: IO = { mkdir, readFile, rename, stat, writeFile }) {
  const root = path.resolve(directory);
  const keyDirectory = (address: string, interval: CandleInterval) => {
    if (!/^0x[0-9a-f]{40}$/.test(address) || !(interval in steps)) throw new Error('Invalid history archive key');
    return path.join(root, `${address}-${interval}`);
  };
  const readJson = async (file: string, maximum: number) => {
    if ((await io.stat(file)).size > maximum) throw new Error('History archive file exceeds its bound');
    const text = await io.readFile(file, 'utf8');
    if (text.length > maximum) throw new Error('History archive file exceeds its bound');
    return JSON.parse(text);
  };
  const atomicWrite = async (file: string, value: unknown) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await io.writeFile(temporary, JSON.stringify(value));
    await io.rename(temporary, file);
  };
  const loadManifest = async (address: string, interval: CandleInterval): Promise<HistoryManifest | null> => {
    try {
      const value = await readJson(path.join(keyDirectory(address, interval), 'manifest.json'), 8_000_000);
      const now = Math.floor(Date.now() / 1000), span = steps[interval] * chunkBars;
      if (value?.version !== 1 || value.address !== address || value.interval !== interval || typeof value.complete !== 'boolean' ||
        !Array.isArray(value.chunks) || value.chunks.length > Math.ceil(now / span) + 1 ||
        value.updatedAt !== null && !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('Invalid history manifest');
      const seen = new Set<number>();
      for (const chunk of value.chunks) {
        if (!Number.isSafeInteger(chunk.bucket) || chunk.bucket < 0 || seen.has(chunk.bucket) || !Number.isInteger(chunk.count) || chunk.count < 1 || chunk.count > chunkBars ||
          !Number.isSafeInteger(chunk.first) || !Number.isSafeInteger(chunk.last) || chunk.first < 1 || chunk.first > chunk.last || chunk.last > now ||
          Math.floor(chunk.first / span) !== chunk.bucket || Math.floor(chunk.last / span) !== chunk.bucket) throw new Error('Invalid history chunk index');
        seen.add(chunk.bucket);
      }
      if (value.coverage !== undefined && (!Array.isArray(value.coverage) || value.coverage.some((range: unknown) => !Array.isArray(range) || range.length !== 2 ||
        !range.every(time => Number.isSafeInteger(time)) || range[0] < 1 || range[0] > range[1] || range[1] > now))) throw new Error('Invalid history coverage');
      if (value.latestTo !== undefined && (!Number.isSafeInteger(value.latestTo) || value.latestTo < 1 || value.latestTo > now)) throw new Error('Invalid latest history boundary');
      const coverage = mergeHistoryCoverage(value.coverage ?? []);
      // Legacy manifests cannot prove scanned coverage merely from stored candles.
      const complete = value.latestTo !== undefined && coverage.some(([from, to]) => from === 1 && to >= value.latestTo);
      return { ...value, complete, coverage, volumeCurrency: value.volumeCurrency === 'usd' ? 'usd' : 'unknown', chunks: value.chunks.sort((a: Chunk, b: Chunk) => a.first - b.first) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const loadChunk = async (manifest: HistoryManifest, chunk: Chunk): Promise<MarketCandle[]> => {
    const rows = await readJson(path.join(keyDirectory(manifest.address, manifest.interval), `${chunk.bucket}.json`), 400_000);
    if (!Array.isArray(rows) || rows.length !== chunk.count || rows.length > chunkBars) throw new Error('Invalid history chunk');
    const result: MarketCandle[] = [];
    const span = steps[manifest.interval] * chunkBars;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 6 || !row.every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error('Invalid history candle');
      const [time, open, high, low, close, volume] = row;
      if (!Number.isSafeInteger(time) || time < 1 || Math.floor(time / span) !== chunk.bucket || Math.min(open, high, low, close) <= 0 || volume < 0 ||
        low > Math.min(open, close) || high < Math.max(open, close) || result.length && time <= result.at(-1)!.time) throw new Error('Invalid history candle');
      result.push({ time, open, high, low, close, volume });
    }
    if (result[0]?.time !== chunk.first || result.at(-1)?.time !== chunk.last) throw new Error('History index does not match candles');
    return result;
  };
  const readBefore = async (manifest: HistoryManifest, before: number, limit = 1000, since = 1) => {
    let result: MarketCandle[] = [];
    for (const chunk of [...manifest.chunks].reverse()) {
      if (chunk.first >= before || chunk.last < since) continue;
      const candles = (await loadChunk(manifest, chunk)).filter(c => c.time < before && c.time >= since);
      result = [...candles, ...result];
      if (result.length >= limit) break;
    }
    return result.slice(-limit);
  };
  let writing = Promise.resolve();
  const savePage = (manifest: HistoryManifest, candles: MarketCandle[], options: { latest?: boolean; coverage?: [number, number] } = {}) => {
    const operation = writing.catch(() => {}).then(async () => {
      const folder = keyDirectory(manifest.address, manifest.interval);
      await io.mkdir(folder, { recursive: true });
      const span = steps[manifest.interval] * chunkBars, groups = new Map<number, MarketCandle[]>();
      for (const candle of candles) {
        const bucket = Math.floor(candle.time / span);
        const group = groups.get(bucket) ?? []; group.push(candle); groups.set(bucket, group);
      }
      const chunks = new Map(manifest.chunks.map(chunk => [chunk.bucket, chunk]));
      for (const [bucket, incoming] of groups) {
        const existing = chunks.get(bucket);
        let previous: MarketCandle[] = [];
        if (existing) {
          try { previous = await loadChunk(manifest, existing); }
          catch { /* Replace an unreadable chunk with newly verified candles. */ }
        }
        const merged = mergeHistoryCandles(previous, incoming);
        if (merged.length > chunkBars) throw new Error('History chunk has too many candles');
        if (JSON.stringify(merged) !== JSON.stringify(previous)) {
          await atomicWrite(path.join(folder, `${bucket}.json`), merged.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]));
        }
        chunks.set(bucket, { bucket, first: merged[0].time, last: merged.at(-1)!.time, count: merged.length });
      }
      manifest.chunks = [...chunks.values()].sort((a, b) => a.first - b.first);
      if (options.latest) { manifest.updatedAt = new Date().toISOString(); manifest.latestTo = options.coverage?.[1]; }
      manifest.coverage = mergeHistoryCoverage(manifest.coverage ?? [], options.coverage);
      manifest.complete = manifest.latestTo !== undefined && manifest.coverage.some(([from, to]) => from === 1 && to >= manifest.latestTo!);
      await atomicWrite(path.join(folder, 'manifest.json'), manifest);
    });
    writing = operation;
    return operation;
  };
  return { loadManifest, readBefore, savePage };
}
