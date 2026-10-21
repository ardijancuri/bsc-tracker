/** Explicit local maintenance. Normal startup never retires tables or prunes
 * legacy market coverage. No external transports or production connection. */
import pg from 'pg';
import { databaseRetirementStatus, retireObsoleteTables, restoreRetiredTables } from './databaseRetirement.js';
import { ensureNodeMarketCoverageSchema, backfillNodeMarketCoverage, pruneValidatedLegacyMarketCoverage } from './nodeMarketCoverage.js';
import { prunePositionSnapshots } from './positionSnapshotRetention.js';

const commands = ['status', 'archive-unused', 'restore-unused', 'market-coverage', 'positions', 'all'] as const;
type Command = typeof commands[number];
export function parseMaintenanceArguments(args: string[]) {
  const command = (args[0] ?? 'status') as Command;
  if (!commands.includes(command)) throw Error('Use status, archive-unused, restore-unused, market-coverage, positions or all');
  const options = { command, apply: false, pruneLegacy: false, batches: 1, limit: 1000 };
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--apply') options.apply = true;
    else if (flag === '--prune-legacy') options.pruneLegacy = true;
    else if (flag === '--batches' || flag === '--limit') {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1 || value > (flag === '--batches' ? 100_000 : 2000)) throw Error('Invalid bounded maintenance size');
      if (flag === '--batches') options.batches = value; else options.limit = value;
    } else throw Error('Unknown maintenance option');
  }
  if (command !== 'status' && !options.apply) throw Error('Mutation requires --apply; inspect status first');
  return options;
}

export function localMaintenanceDatabase(value: string | undefined) {
  const target = new URL(value ?? 'postgres://invalid');
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.search || target.hash
    || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.port !== '5435'
    || !/^\/(?:bscan|node_)[a-zA-Z0-9_]*$/.test(target.pathname)) throw Error('Maintenance is restricted to the local test PostgreSQL on port 5435');
  return target;
}

export async function runDatabaseMaintenance(args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const options = parseMaintenanceArguments(args), target = localMaintenanceDatabase(environment.DATABASE_URL);
  const database = new pg.Pool({ connectionString: target.href, max: 2, connectionTimeoutMillis: 5000 });
  const print = (event: string, details: unknown) => console.log(JSON.stringify({ event, ...details as Record<string, unknown> }));
  try {
    if (options.command === 'status') {
      print('retired_tables', await databaseRetirementStatus(database));
      const tables = (await database.query(`SELECT relname AS name,n_live_tup AS estimated_rows,
        pg_total_relation_size(relid)::text AS bytes FROM pg_stat_user_tables WHERE schemaname='public'
        AND relname IN('node_market_ranges','node_market_collection_cohorts','node_market_collection_members',
          'node_market_collection_ranges','node_market_coverage_migrations','node_market_coverage_endpoints','position_snapshots') ORDER BY relname`)).rows;
      print('storage', { tables });
      const state = (await database.query(`SELECT value,updated_at FROM worker_state WHERE key='position_snapshot_retention'`)).rows[0] ?? null;
      print('position_retention', { state });
      if ((await database.query(`SELECT to_regclass('public.node_market_coverage_migrations') IS NOT NULL AS present`)).rows[0].present) {
        const migrations = (await database.query(`SELECT CASE WHEN completed_at IS NOT NULL THEN 'validated'
          ELSE COALESCE(state->>'stage','scan') END AS stage,count(*)::text AS markets
          FROM node_market_coverage_migrations GROUP BY 1 ORDER BY 1`)).rows;
        print('market_migration', { stages: migrations });
      }
      return;
    }
    if (options.command === 'archive-unused' || options.command === 'all') print('retirement', await retireObsoleteTables(database));
    if (options.command === 'restore-unused') { print('restore', await restoreRetiredTables(database)); return; }
    if (options.command === 'market-coverage' || options.command === 'all') {
      await ensureNodeMarketCoverageSchema(database);
      for (let batch = 0; batch < options.batches; batch++) {
        const migration = await backfillNodeMarketCoverage(database, { limit: options.limit });
        const pruning = options.pruneLegacy ? await pruneValidatedLegacyMarketCoverage(database, { limit: options.limit }) : undefined;
        print('market_coverage_batch', { batch: batch + 1, migration, pruning });
        if (migration.idle && (!pruning || pruning.idle)) break;
      }
    }
    if (options.command === 'positions' || options.command === 'all') {
      for (let batch = 0; batch < options.batches; batch++) {
        const result = await prunePositionSnapshots(database, { maxRows: options.limit });
        print('position_retention_batch', { batch: batch + 1, ...result });
        if (result.skipped || result.wrapped && result.prunedRows === 0) break;
      }
    }
  } finally { await database.end(); }
}

if (process.argv[1] && /(?:^|[\\/])databaseMaintenance\.(?:ts|js)$/.test(process.argv[1])) {
  runDatabaseMaintenance(process.argv.slice(2)).catch(error => {
    // Never print connection strings, environment values or full query text.
    console.error(error instanceof Error ? error.message : 'Database maintenance failed'); process.exitCode = 1;
  });
}
