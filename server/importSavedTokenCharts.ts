import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { chartImportHash, chartIntervals, normalizeImportedChart } from './nodeChartImport.js';
import { nodeMarketService } from './nodeMarket.js';
import { pool, ensureSchema } from './db.js';
import { publicTokenEvidenceSql } from './nodeMarketReadSql.js';
import { nonStockTokenSql } from './stockToken.js';

type CachedInput = { token: string; seconds: number; provider: string; observedAt: string; rows: unknown[]; payload: unknown };
const providers = ['gmgn', 'geckoterminal', 'coinmarketcap'];
/** Legacy snapshots are price evidence only. Their old "complete" flags do not
 * prove exhaustive retrieval, purchase history, block positions or fresh quotes. */
export function normalizeSavedTokenChart(value: any, now = Date.now()): CachedInput {
  const seconds = chartIntervals[value?.resolution as keyof typeof chartIntervals], observed = Date.parse(value?.updatedAt);
  if (!/^0x[0-9a-f]{40}$/.test(value?.address ?? '') || !providers.includes(value?.source) || !seconds
    || !Number.isFinite(observed) || observed > now || !Array.isArray(value.candles) || !value.candles.length || value.candles.length > 1000) throw new Error('legacy_chart_invalid');
  if (value.candles.some((row: unknown) => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('legacy_chart_invalid');
  const rows = value.candles.map((row: any) => ({ time: row.time, open: row.open, high: row.high, low: row.low, close: row.close,
    volume: value.volumeCurrency === 'usd' ? row.volume : null }));
  return { token: value.address, seconds, provider: value.source, observedAt: new Date(observed).toISOString(), rows, payload: value };
}
async function jsonFile(filename: string, maximum = 400_000) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('legacy_chart_file_invalid');
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch(error) { if(error instanceof SyntaxError)throw new Error('legacy_chart_json_invalid');throw error; }
}
export async function migrateSavedTokenCharts(directory: string, options: {
  db?: Pick<Pool, 'query'>; market?: Pick<typeof nodeMarketService, 'importObservations'>; dryRun?: boolean; now?: () => number;
  onProgress?: (result: { sourcePath: string; state: string; bars?: number }) => void;
} = {}) {
  const root = path.resolve(directory), dryRun = options.dryRun !== false, now = options.now ?? Date.now;
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('legacy_chart_directory_invalid');
  const db = options.db ?? pool, market = options.market ?? nodeMarketService;
  const report = { dryRun, files: 0, imported: 0, skipped: 0, invalid: 0, bars: 0, issues: [] as { sourcePath: string; reason: string }[] };
  async function save(sourcePath: string, input: CachedInput) {
    report.files++;
    const rawTimes = input.rows.map((row: any) => Number(row.time));
    if (rawTimes.some(time => !Number.isSafeInteger(time) || time < 1 || time * 1000 > now())) throw new Error('legacy_chart_timestamp_invalid');
    const normalized = normalizeImportedChart({ data: input.rows }, Math.min(...rawTimes) * 1000, Math.max(...rawTimes) * 1000,
      input.seconds, Date.parse(input.observedAt));
    if (!normalized.observations.length) { report.skipped++; return; }
    const hash = chartImportHash([sourcePath, input.token, input.seconds, input.observedAt, input.payload]);
    if (!dryRun) {
      if ((await db.query('SELECT 1 FROM node_legacy_chart_imports WHERE content_hash=$1', [hash])).rowCount) { report.skipped++; return; }
      const known = await db.query(`SELECT 1 FROM tokens v WHERE v.address=$1 AND ${nonStockTokenSql()} AND ${publicTokenEvidenceSql()}`, [input.token]);
      if (!known.rowCount) { report.skipped++; return; }
      await db.query(`INSERT INTO node_import_chart_pages(token_address,resolution,from_at,to_at,payload_hash,payload,observed_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING`, [input.token, input.seconds, normalized.coverageFrom === null ? null : new Date(normalized.coverageFrom),
        new Date(normalized.coverageTo!), hash, JSON.stringify({ origin: 'legacy_cache', provider: input.provider, sourcePath, observedAt: input.observedAt, original: input.payload }), input.observedAt]);
      await market.importObservations({ token: input.token, importId: `legacy-cache:${input.provider}:${hash}`, observedAt: input.observedAt,
        observations: normalized.observations, from: new Date(normalized.coverageFrom!).toISOString(), to: new Date(normalized.coverageTo!).toISOString(), complete: false });
      await db.query(`INSERT INTO node_legacy_chart_imports(content_hash,source_path,token_address,resolution,provider,observed_at,bar_count)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [hash, sourcePath, input.token, input.seconds, input.provider, input.observedAt, normalized.observations.length]);
    }
    report.imported++; report.bars += normalized.observations.length;
    options.onProgress?.({ sourcePath, state: dryRun ? 'validated' : 'imported', bars: normalized.observations.length });
  }
  async function attempt(sourcePath: string, work: () => Promise<void>) {
    try { await work(); }
    catch (error) {
      // Validation failures are isolated; database failures stop the resumable
      // migration instead of marking an unpersisted file successfully imported.
      const reason = error instanceof Error ? error.message : 'legacy_chart_invalid';
      if (!/^(legacy_|import_chart_)/.test(reason)) throw error;
      report.invalid++; if (report.issues.length < 100) report.issues.push({ sourcePath, reason });
    }
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !/^0x[0-9a-f]{40}-(?:1m|5m|1h|4h|1d|24h|7d|30d)\.json$/.test(entry.name)) continue;
    await attempt(entry.name, async () => {
      const input = normalizeSavedTokenChart(await jsonFile(path.join(root, entry.name)), now());
      if (!entry.name.startsWith(`${input.token}-`)) throw new Error('legacy_chart_identity_mismatch');
      await save(entry.name, input);
    });
  }
  // Full-history archives use the old GMGN-only manifest/chunk format. Ignore
  // inventory/accounting directories; no private labels or P&L are imported.
  const archiveRoot = path.join(root, 'full-history');
  const archiveInfo = await lstat(archiveRoot).catch(() => null);
  if (archiveInfo?.isDirectory() && !archiveInfo.isSymbolicLink()) for (const entry of await readdir(archiveRoot, { withFileTypes: true })) {
    const match = /^(0x[0-9a-f]{40})-(1m|5m|1h|4h|1d)$/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    await attempt(`full-history/${entry.name}`, async () => {
      const folder = path.join(archiveRoot, entry.name), manifest = await jsonFile(path.join(folder, 'manifest.json'), 8_000_000);
      const seconds = chartIntervals[match[2] as keyof typeof chartIntervals];
      if (manifest.version !== 1 || manifest.address !== match[1] || manifest.interval !== match[2] || !Array.isArray(manifest.chunks)
        || manifest.chunks.length > 100_000 || !Number.isFinite(Date.parse(manifest.updatedAt)) || Date.parse(manifest.updatedAt) > now()) throw new Error('legacy_chart_manifest_invalid');
      const seen = new Set<number>();
      for (const chunk of manifest.chunks) {
        if (!Number.isSafeInteger(chunk.bucket) || chunk.bucket < 0 || seen.has(chunk.bucket) || !Number.isInteger(chunk.count) || chunk.count < 1 || chunk.count > 1000) throw new Error('legacy_chart_chunk_index_invalid');
        seen.add(chunk.bucket);
        const relative = `full-history/${entry.name}/${chunk.bucket}.json`;
        await attempt(relative, async () => {
          const rows = await jsonFile(path.join(folder, `${chunk.bucket}.json`));
          if (!Array.isArray(rows) || rows.length !== chunk.count || rows.some(row => !Array.isArray(row) || row.length !== 6
            || Math.floor(row[0] / (seconds * 1000)) !== chunk.bucket) || rows[0]?.[0] !== chunk.first || rows.at(-1)?.[0] !== chunk.last) throw new Error('legacy_chart_chunk_invalid');
          await save(relative, { token: match[1], seconds, provider: 'gmgn', observedAt: manifest.updatedAt,
            rows: rows.map(row => ({ time: row[0], open: row[1], high: row[2], low: row[3], close: row[4], volume: manifest.volumeCurrency === 'usd' ? row[5] : null })),
            payload: { manifest, rows } });
        });
      }
    });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv.find(arg => arg.startsWith('--directory='))?.slice(12), apply = process.argv.includes('--apply');
  if (!directory) throw new Error('Use --directory=<saved chart directory>; dry run is default, --apply writes to DATABASE_URL.');
  try {
    if (apply) await ensureSchema();
    console.log(JSON.stringify(await migrateSavedTokenCharts(directory, { dryRun: !apply }), null, 2));
  } finally { await pool.end(); }
}
