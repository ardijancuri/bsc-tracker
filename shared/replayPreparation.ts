import type { KolTokenActivity } from './kolTokenTrades.js';
import type { ReplayMarketChart } from './replayChart.js';

export type ReplayPreparationReason = 'accounting_pending' | 'accounting_mismatch' | 'unknown_costs' |
  'chart_coverage' | 'chart_unavailable' | 'stale_quote' | 'unsupported_decoder' | 'provider_cooldown';
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
  asOf: string;
}

export const replayPreparationMessages: Record<ReplayPreparationReason, string> = {
  accounting_pending: 'Wallet transactions are still being processed. Retry shortly.',
  accounting_mismatch: 'Recorded movements do not match the confirmed wallet balance.',
  unknown_costs: 'Some purchase costs or wallet-paid fees are unavailable.',
  chart_coverage: 'Recovering market history for the full replay window…',
  chart_unavailable: 'The available market history cannot cover this replay. No further history was returned.',
  stale_quote: 'A recent confirmed market price is unavailable.',
  unsupported_decoder: 'This market or wallet execution needs a supported decoder.',
  provider_cooldown: 'A historical import is waiting for its provider cooldown.',
};
