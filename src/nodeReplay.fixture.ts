import type { KolTokenActivity } from '../shared/kolTokenTrades';
import { journalReplayFixture } from './journalReplay.fixture';

/** Synthetic public/private contract fixture; no credentials or real account data. */
export function nodeReplayFixture(now = Date.now(), privateScope = false) {
  const fixture = journalReplayFixture(now), activity = structuredClone(fixture.activity);
  const raw = activity.replayAccounting!, accounting = activity.realizedAccounting!;
  activity.kol.name = 'Kollens demo'; activity.token.name = 'Node replay demo';
  activity.accountingSnapshot = { version: 2, snapshotId: 'd'.repeat(64), source: 'node', scope: privateScope ? 'portfolio' : 'public',
    asOf: activity.generatedAt, historyFingerprint: raw.history!.fingerprint, historyFrom: raw.history!.events[0].timestamp,
    coveredThroughBlock: '1000', valuationBlock: '1000', valuationHash: raw.inventoryBlockHash, complete: true, reasons: [] };
  raw.version = 2; raw.source = 'node'; raw.policy = 'kollens_fifo_v1'; raw.status = 'ready';
  raw.coverage.exactFinal = true; raw.coverage.verification = 'node_history';
  for (const [index, event] of raw.history!.events.entries()) { event.blockNumber = String(100 + index * 100); event.transactionIndex = 0; event.logIndex = 0; event.feeInclusiveCostUsd = '101'; }
  raw.final!.feeInclusiveCostUsd = '101';
  accounting.version = 2; accounting.source = 'node'; accounting.policy = 'kollens_fifo_v1'; accounting.coverage.verification = 'node_history';
  accounting.position!.valuationSource = 'node';
  if (!privateScope) delete (activity as Partial<typeof activity>).journal;
  return { activity: activity as KolTokenActivity, context: privateScope ? fixture.context : undefined, now: fixture.now, chartPoints: fixture.chartPoints };
}
