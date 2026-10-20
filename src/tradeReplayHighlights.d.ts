export interface ReplayHighlightTrade {
  id: string;
  timestamp: string;
  ts?: number;
  side: 'buy' | 'sell';
  amountUsd: number | null;
  cumulativeRealizedProfitUsd?: number | null;
}

export interface ReplayHighlightAccountingEvent {
  timestamp: string;
  ts?: number;
  tradeId?: string;
  kind: 'buy' | 'sell' | 'transfer_in' | 'transfer_out';
  cumulativeRealizedProfitUsd?: number | string | null;
}

export interface ReplaySellHighlight {
  tradeIndex: number;
  amountUsd: number;
  label: 'Big sell' | 'Take profit';
}

/** Select at most three material sells; a positive realized delta is required for Take profit. */
export function selectReplaySellHighlights(trades: readonly ReplayHighlightTrade[], accountingEvents?: readonly ReplayHighlightAccountingEvent[]): ReplaySellHighlight[];

/** Reweight only presentation time, retaining phase endpoints and same-progress atomic groups. */
export function reweightReplayProgress(baseProgresses: readonly number[], selectedIndices: readonly number[], endPhase?: number): number[];
