import type { Pool } from 'pg';
import type { Rpc } from '../rpc.js';
import type { FreshCaptureProgress } from './capture.js';
import { createNodeMomentumIngest } from './nodeMomentumIngest.js';
import { createNodeMomentumStore, persistNodeMomentumSnapshot } from './nodeMomentumStore.js';

export const nodeMomentumPollMs = 6_000;
const maxRange = 32;
const maxCursorLag = 64;
const maxCaptureLag = 16;
const maxCaptureAgeMs = 15_000;

interface HeaderRow {
  block_number: string;
  block_hash: string;
  parent_hash: string;
  occurred_at: Date;
}

export function createNodeMomentumWorker(
  db: Pick<Pool, 'query'>,
  rpc: Rpc,
  now = Date.now,
  ingest = createNodeMomentumIngest(rpc),
) {
  let cursor: { number: number; hash: string } | undefined;
  let store: ReturnType<typeof createNodeMomentumStore> | undefined;
  let lastSnapshotMinute = -Infinity;
  let lastSnapshotRevision = '';
  let rangeLimit = maxRange;

  const ready = (capture?: FreshCaptureProgress): capture is FreshCaptureProgress => {
    if (!capture || capture.lagBlocks > maxCaptureLag) return false;
    const age = now() - capture.checkedAt;
    return age >= 0 && age <= maxCaptureAgeMs;
  };

  return async (captureHealth: () => FreshCaptureProgress | undefined, signal: AbortSignal) => {
    if (signal.aborted || !ready(captureHealth())) return { yielded: true, reason: 'capture_priority' };

    const current = (await db.query<{ block_number: string; block_hash: string; revision: string; cursor_ok: boolean }>(`
      SELECT c.block_number,c.block_hash,c.revision,EXISTS(
        SELECT 1 FROM fresh.recent_blocks b WHERE b.block_number=$1 AND b.block_hash=$2
      ) AS cursor_ok FROM fresh.checkpoints c WHERE c.key='capture'`,
    [cursor?.number ?? null, cursor?.hash ?? null])).rows[0];
    if (!current) return { yielded: true, reason: 'capture_checkpoint_unavailable' };

    const head = Number(current.block_number);
    const latestHealth = captureHealth();
    if (signal.aborted || !ready(latestHealth) || head > latestHealth.confirmedHeadBlock
      || latestHealth.confirmedHeadBlock - head > maxCaptureLag) return { yielded: true, reason: 'capture_priority' };
    if (!cursor || !current.cursor_ok || head < cursor.number || head - cursor.number > maxCursorLag) {
      // Start with the current header; a cold worker never claims older coverage.
      const baseline = (await db.query<HeaderRow>(`SELECT block_number,block_hash,parent_hash,occurred_at
        FROM fresh.recent_blocks WHERE block_number=$1 AND block_hash=$2`, [head, current.block_hash])).rows[0];
      if (!baseline) return { yielded: true, reason: 'capture_header_unavailable' };
      ingest.clear();
      cursor = { number: head, hash: baseline.block_hash };
      store = createNodeMomentumStore({ coverageStartMs: baseline.occurred_at.getTime() });
      lastSnapshotMinute = -Infinity;
      lastSnapshotRevision = '';
      rangeLimit = maxRange;
      return { yielded: true, reason: 'warming_up', block: head };
    }
    if (!store || cursor.number >= head) return { yielded: true, reason: 'awaiting_confirmed_blocks' };

    const previous = cursor;
    const through = Math.min(head, previous.number + rangeLimit);
    const { rows } = await db.query<HeaderRow>(`SELECT block_number,block_hash,parent_hash,occurred_at FROM fresh.recent_blocks
      WHERE block_number>$1 AND block_number<=$2 ORDER BY block_number`, [previous.number, through]);
    if (rows.length !== through - previous.number || rows.some((row, index) =>
      Number(row.block_number) !== previous.number + index + 1 || row.parent_hash !== (rows[index - 1]?.block_hash ?? previous.hash))) {
      return { yielded: true, reason: 'capture_headers_changed' };
    }

    if (signal.aborted || !ready(captureHealth())) return { yielded: true, reason: 'capture_priority' };
    const started = performance.now();
    const shouldContinue = () => !signal.aborted && ready(captureHealth());
    let range;
    try {
      range = await ingest.scan(rows.map(row => ({
        number: Number(row.block_number), hash: row.block_hash, timestamp: row.occurred_at.toISOString(),
      })), { parentHash: previous.hash, shouldContinue });
    } catch (error) {
      if (error instanceof Error && error.message === 'momentum_scan_yielded') {
        return { yielded: true, reason: 'capture_priority' };
      }
      if (rows.length > 1 && error instanceof Error
        && ['momentum_scan_log_total_budget', 'momentum_scan_log_request_budget'].includes(error.message)) {
        rangeLimit = Math.floor(rows.length / 2);
        return { yielded: true, reason: 'log_range_budget', retryBlocks: rangeLimit };
      }
      throw error;
    }
    const { observations, coveredPools, stats } = range;
    if (signal.aborted) return { yielded: true, reason: 'shutdown' };

    const last = rows[rows.length - 1];
    const checked = await db.query(`SELECT 1 FROM fresh.recent_blocks WHERE block_number=$1 AND block_hash=$2`,
      [last.block_number, last.block_hash]);
    if (!checked.rowCount) {
      // This scan may have cached pool or quote evidence from the orphaned range.
      ingest.clear();
      return { yielded: true, reason: 'capture_headers_changed' };
    }
    store.appendRange({
      fromBlock: previous.number + 1, parentHash: previous.hash, blockNumber: through,
      blockHash: last.block_hash, observedAt: last.occurred_at.getTime(), swaps: observations, coveredPools,
    });
    cursor = { number: through, hash: last.block_hash };
    rangeLimit = Math.min(maxRange, rangeLimit * 2);
    const minute = Math.floor(last.occurred_at.getTime() / 60_000);
    let published = false;
    if (minute !== lastSnapshotMinute || current.revision !== lastSnapshotRevision) {
      const snapshot = store.snapshot();
      if (snapshot) published = await persistNodeMomentumSnapshot(db, snapshot, current.revision);
      if (published) {
        lastSnapshotMinute = minute;
        lastSnapshotRevision = current.revision;
      }
    }
    return {
      block: through, blocks: rows.length, durationMs: Math.round(performance.now() - started),
      coveredPools: coveredPools.length, observations: observations.length, stats, published, aggregate: store.stats(),
    };
  };
}
