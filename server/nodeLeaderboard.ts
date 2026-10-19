import type { Pool, PoolClient } from 'pg';
import type { NodeLeaderboardSnapshot } from '../shared/nodeLeaderboard.js';
import { nodeLeaderboardStatus } from '../shared/nodeLeaderboard.js';

type Database = Pick<PoolClient, 'query'>;
export interface NodeLeaderboardCalculationRequest {
  database: Database;
  wallets: string[];
  windowStart: string;
  windowEnd: string;
  /** Register evidence fences to run under the short publication transaction.
   * This stays internal; public responses contain only the frozen result. */
  beforePublish?: (validate: (database: Database) => Promise<void>) => void;
}
type Calculate = (request: NodeLeaderboardCalculationRequest) => Promise<NodeLeaderboardSnapshot[]>;

export async function ensureNodeLeaderboardSchema(database: Database) {
  // Existing legacy snapshots remain available for rollback, but new reads
  // require the versioned node_accounting contract below.
  await database.query('ALTER TABLE leaderboard_snapshots ADD COLUMN IF NOT EXISTS window_end timestamptz');
  await database.query('ALTER TABLE leaderboard_snapshots ADD COLUMN IF NOT EXISTS node_accounting jsonb');
}

const decimal = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024 && /^-?\d+(?:\.\d+)?$/.test(value);
const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function validateNodeLeaderboardSnapshot(snapshot: NodeLeaderboardSnapshot, request: Pick<NodeLeaderboardCalculationRequest, 'wallets' | 'windowStart' | 'windowEnd'>) {
  if (snapshot.version !== 1 || snapshot.policy !== 'kollens_fifo_v1' || !request.wallets.includes(snapshot.walletAddress)
    || snapshot.windowStart !== request.windowStart || snapshot.windowEnd !== request.windowEnd
    || !Number.isFinite(Date.parse(snapshot.asOf)) || Date.parse(snapshot.asOf) > Date.parse(request.windowEnd)
    || !/^[a-f0-9]{64}$/.test(snapshot.snapshotId) || !['node','mixed','imported'].includes(snapshot.source)
    || !decimal(snapshot.knownRealizedProfitUsd)
    || snapshot.realizedProfitUsd !== null && !decimal(snapshot.realizedProfitUsd)
    || typeof snapshot.complete !== 'boolean' || snapshot.complete !== (snapshot.realizedProfitUsd !== null)
    || !Array.isArray(snapshot.reasons) || snapshot.reasons.some(reason => typeof reason !== 'string' || reason.length > 100)
    || snapshot.complete && (snapshot.reasons.length > 0 || snapshot.excludedSellCount > 0 || snapshot.excludedTransferOutCount > 0 || (snapshot.excludedFeeCount ?? 0) > 0)
    || ![snapshot.valuedSellCount,snapshot.excludedSellCount,snapshot.valuedTransferOutCount,snapshot.excludedTransferOutCount].every(validCount)
    || snapshot.valuedFeeCount !== undefined && !validCount(snapshot.valuedFeeCount)
    || snapshot.excludedFeeCount !== undefined && !validCount(snapshot.excludedFeeCount)
    || snapshot.feeOnlyFeesUsd !== undefined && snapshot.feeOnlyFeesUsd !== null && !decimal(snapshot.feeOnlyFeesUsd)
    || (snapshot.coveredThroughBlock === null) !== (snapshot.coveredThroughHash === null)
    || snapshot.coveredThroughBlock !== null && (!/^\d+$/.test(snapshot.coveredThroughBlock) || !/^0x[a-f0-9]{64}$/.test(snapshot.coveredThroughHash!))) {
    throw new Error('node_leaderboard_snapshot_invalid');
  }
  return snapshot;
}

/** Worker-only accounting. HTTP routes only read these committed snapshots. */
export function createNodeLeaderboardService(options: { database: Pick<Pool, 'connect'>; calculate: Calculate; now?: () => number }) {
  const now = options.now ?? Date.now;
  let inFlight: Promise<{ updatedWallets: number; completeWallets: number; partialWallets: number; pendingWallets: number; elapsedMs: number; skipped?: boolean }> | undefined;
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const started = performance.now(), client = await options.database.connect();
      let locked = false, transaction = false;
      const empty = () => ({ updatedWallets: 0, completeWallets: 0, partialWallets: 0, pendingWallets: 0, elapsedMs: performance.now() - started });
      try {
        // Different workers join the stored result instead of recomputing it.
        locked = (await client.query('SELECT pg_try_advisory_lock(908345) AS acquired')).rows[0]?.acquired === true;
        if (!locked) return { ...empty(), skipped: true };
        const wallets = (await client.query('SELECT address FROM published_kols WHERE is_tracked ORDER BY address')).rows.map(row => String(row.address));
        const windowEnd = new Date(now()).toISOString(), windowStart = new Date(Date.parse(windowEnd) - 86_400_000).toISOString();
        const validators: ((database: Database) => Promise<void>)[] = [];
        const request = { database: client, wallets, windowStart, windowEnd,
          beforePublish: (validate: (database: Database) => Promise<void>) => { validators.push(validate); } };
        const snapshots = await options.calculate(request);
        const seen = new Set<string>();
        for (const snapshot of snapshots) {
          validateNodeLeaderboardSnapshot(snapshot, request);
          if (seen.has(snapshot.walletAddress)) throw new Error('node_leaderboard_duplicate_wallet');
          seen.add(snapshot.walletAddress);
        }
        if (seen.size !== wallets.length) throw new Error('node_leaderboard_wallets_incomplete');
        // The calculator performs all reads before this short publication
        // transaction. Reorg rollback cannot publish an orphaned result after it.
        await client.query('BEGIN'); transaction = true;
        await client.query('SELECT pg_advisory_xact_lock_shared(782319)');
        for (const validate of validators) await validate(client);
        const proofs = [...new Map(snapshots.filter(snapshot => snapshot.coveredThroughBlock !== null)
          .map(snapshot => [`${snapshot.coveredThroughBlock}:${snapshot.coveredThroughHash}`, { block: snapshot.coveredThroughBlock!, hash: snapshot.coveredThroughHash! }])).values()];
        if (proofs.length) {
          const canonical = await client.query(`SELECT requested.block,requested.hash FROM jsonb_to_recordset($1::jsonb) AS requested(block bigint,hash text)
            JOIN node_evidence_blocks b ON b.block_number=requested.block AND b.block_hash=requested.hash`, [JSON.stringify(proofs)]);
          if (canonical.rows.length !== proofs.length) throw new Error('node_leaderboard_canonical_evidence_changed');
        }
        await client.query(`INSERT INTO leaderboard_snapshots(wallet_address,period,window_start,window_end,realized_profit_usd,unrealized_profit_usd,
            buy_count,sell_count,valued_sell_count,excluded_sell_count,updated_at,node_accounting)
          SELECT s->>'walletAddress','1d',(s->>'windowStart')::timestamptz,(s->>'windowEnd')::timestamptz,
            (s->>'realizedProfitUsd')::numeric,NULL,NULL,NULL,(s->>'valuedSellCount')::integer,(s->>'excludedSellCount')::integer,
            (s->>'asOf')::timestamptz,s FROM jsonb_array_elements($1::jsonb) AS s
          ON CONFLICT(wallet_address,period) DO UPDATE SET window_start=EXCLUDED.window_start,window_end=EXCLUDED.window_end,
            realized_profit_usd=EXCLUDED.realized_profit_usd,unrealized_profit_usd=NULL,buy_count=NULL,sell_count=NULL,
            valued_sell_count=EXCLUDED.valued_sell_count,excluded_sell_count=EXCLUDED.excluded_sell_count,
            updated_at=EXCLUDED.updated_at,node_accounting=EXCLUDED.node_accounting`, [JSON.stringify(snapshots)]);
        const statuses = snapshots.map(nodeLeaderboardStatus), result = { updatedWallets: snapshots.length,
          completeWallets: statuses.filter(status => status === 'ready').length, partialWallets: statuses.filter(status => status === 'partial').length,
          pendingWallets: statuses.filter(status => status === 'pending').length, elapsedMs: performance.now() - started };
        const asOf = snapshots.length ? snapshots.reduce((earliest, snapshot) => Date.parse(snapshot.asOf) < Date.parse(earliest) ? snapshot.asOf : earliest, snapshots[0].asOf) : windowEnd;
        await client.query(`INSERT INTO worker_state(key,value,updated_at) VALUES('leaderboard_24h',$1::jsonb,$2::timestamptz)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`,
        [JSON.stringify({ ...result, windowStart, windowEnd, asOf, source: 'node_fifo', policy: 'kollens_fifo_v1', wallets: wallets.length }), asOf]);
        await client.query('COMMIT'); transaction = false;
        return result;
      } catch (error) { if (transaction) await client.query('ROLLBACK'); throw error; }
      finally { try { if (locked) await client.query('SELECT pg_advisory_unlock(908345)'); } finally { client.release(); } }
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  return { refresh };
}
