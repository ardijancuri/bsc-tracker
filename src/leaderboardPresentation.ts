import type { NodeLeaderboardSnapshot } from '../shared/nodeLeaderboard';
import { nodeLeaderboardStatus } from '../shared/nodeLeaderboard';

export function leaderboardPresentation(input: { accounting?: NodeLeaderboardSnapshot | null; tradeCount24h?: number } | null | undefined) {
  const candidate = input?.accounting;
  const snapshot = candidate?.version === 1 && candidate.policy === 'kollens_fifo_v1' ? candidate : null;
  const status = nodeLeaderboardStatus(snapshot);
  const value = status === 'ready' ? snapshot!.realizedProfitUsd : status === 'partial' ? snapshot!.knownRealizedProfitUsd : null;
  const transferCount = snapshot ? snapshot.valuedTransferOutCount + snapshot.excludedTransferOutCount : 0;
  const realizedCount = snapshot ? snapshot.valuedSellCount + snapshot.valuedTransferOutCount + (snapshot.valuedFeeCount ?? 0) : 0;
  const unavailableCount = snapshot ? snapshot.excludedSellCount + snapshot.excludedTransferOutCount + (snapshot.excludedFeeCount ?? 0) : 0;
  return { status, value, canRank: status === 'ready' && ((input?.tradeCount24h ?? 0) > 0 || transferCount > 0 || (snapshot?.valuedFeeCount ?? 0) > 0),
    realizedCount, unavailableCount, asOf: snapshot?.asOf ?? null };
}
