import type { NodeLeaderboardSnapshot } from '../shared/nodeLeaderboard';
import { nodeLeaderboardEstimatedValue, nodeLeaderboardStatus } from '../shared/nodeLeaderboard';

export function leaderboardPresentation(input: { accounting?: NodeLeaderboardSnapshot | null; tradeCount24h?: number;
  estimatedRealizedProfitUsd?: string | null; rankingProfitUsd?: string | null; pnlQuality?: 'exact' | 'estimated' | 'unavailable';
  windowStart?: string | null; windowEnd?: string | null } | null | undefined) {
  const candidate = input?.accounting;
  const snapshot = candidate?.version === 1 && candidate.policy === 'kollens_fifo_v1' ? candidate : null;
  const estimatedValue = nodeLeaderboardEstimatedValue(snapshot);
  const estimated = estimatedValue !== null && snapshot?.period === '24h' && (snapshot.source === 'node' || snapshot.source === 'mixed')
    && input?.pnlQuality === 'estimated' && input.estimatedRealizedProfitUsd === estimatedValue
    && (input.rankingProfitUsd === null || input.rankingProfitUsd === estimatedValue)
    && (input.windowStart == null || input.windowStart === snapshot.windowStart) && (input.windowEnd == null || input.windowEnd === snapshot.windowEnd);
  // An estimate is a separate, explicit server projection. A subtotal or a
  // mismatched board/profile envelope never authorizes an approximate display.
  const status = nodeLeaderboardStatus(snapshot && !estimated ? { ...snapshot, estimate: null } : snapshot);
  const value = status === 'ready' ? snapshot!.realizedProfitUsd : estimated ? estimatedValue : null;
  const estimate = estimated ? snapshot!.estimate! : null;
  const transfersAreIncome=snapshot?.realizedPolicy!=='sales_fifo_fees_v2';
  const transferCount = snapshot&&transfersAreIncome ? snapshot.valuedTransferOutCount + snapshot.excludedTransferOutCount : 0;
  const realizedCount = snapshot ? snapshot.valuedSellCount + (transfersAreIncome?snapshot.valuedTransferOutCount:0) + (snapshot.valuedFeeCount ?? 0) : 0;
  const unavailableCount = snapshot ? snapshot.excludedSellCount + (transfersAreIncome?snapshot.excludedTransferOutCount:0) + (snapshot.excludedFeeCount ?? 0) : 0;
  const hasActivity = (input?.tradeCount24h ?? 0) > 0 || transferCount > 0 || realizedCount > 0;
  return { status, value, estimated, estimate, canRank: hasActivity && (status === 'ready' || estimated && input?.rankingProfitUsd === value),
    realizedCount, unavailableCount, asOf: snapshot?.asOf ?? null,
    windowStart: snapshot?.windowStart ?? null, windowEnd: snapshot?.windowEnd ?? null };
}
