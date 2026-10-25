import type { KolTokenActivity } from './kolTokenTrades.js';
import type { ReplayMarketChart } from './replayChart.js';

export type ReplayPreparationReason = 'preparation_pending' | 'preparation_timeout' | 'preparation_capacity' | 'accounting_pending' | 'accounting_mismatch' | 'unknown_costs' |
  'chart_coverage' | 'chart_unavailable' | 'stale_quote' | 'unsupported_decoder' | 'provider_cooldown' | 'historical_evidence_unavailable';
export interface ReplayPreparation {
  version: 2;
  status: 'ready' | 'pending' | 'unavailable';
  snapshotId: string | null;
  window: { from: string; to: string; id: string } | null;
  stages: { accounting: 'ready' | 'pending' | 'unavailable'; chart: 'ready' | 'pending' | 'unavailable';
    valuation: 'ready' | 'pending' | 'unavailable' };
  reason?: ReplayPreparationReason;
  retryAfterMs?: number;
  activity?: KolTokenActivity;
  chart?: ReplayMarketChart;
  /** Short signed lease for the frozen object; no response is stored in PostgreSQL. */
  manifest?: string;
  expiresAt?: string;
  asOf: string;
}

export const replayPreparationMessages: Record<ReplayPreparationReason, string> = {
  preparation_pending: 'Replay preparation is taking longer than usual. Retry shortly.',
  preparation_timeout: 'Replay preparation timed out. Saved chart pages are retained; retry shortly.',
  preparation_capacity: 'This replay exceeds the preparation memory limit.',
  accounting_pending: 'Wallet transactions are still being processed. Retry shortly.',
  accounting_mismatch: 'Recorded movements do not match the confirmed wallet balance.',
  unknown_costs: 'Some purchase costs or wallet-paid fees are unavailable.',
  historical_evidence_unavailable: 'Historical token precision or payment evidence is unavailable. Recorded trades remain visible, but this replay cannot be verified.',
  chart_coverage: 'Recovering market history for the full replay window…',
  chart_unavailable: 'The available market history cannot cover this replay. No further history was returned.',
  stale_quote: 'A recent confirmed market price is unavailable.',
  unsupported_decoder: 'This market or wallet execution needs a supported decoder.',
  provider_cooldown: 'A historical import is waiting for its provider cooldown.',
};
