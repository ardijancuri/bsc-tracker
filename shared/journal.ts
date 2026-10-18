import type { KolTokenActivity } from './kolTokenTrades.js';

export const journalWalletLimit = 3;
export const journalHistoryDays = 7;
export interface JournalWallet {
  address: string; label: string; addedAt: string; activityFrom: string; revision: string;
  publicIdentity?: { name: string | null; avatarUrl: string | null };
  preparation: { status: 'pending' | 'ready' | 'cooldown' | 'unavailable'; reason?: string; retryAfterMs?: number; historyComplete: boolean };
}
export interface JournalWallets { wallets: JournalWallet[]; limit: number }
export interface JournalTokenIdentity { address: string; symbol: string | null; name: string | null; logoUrl: string | null }
export interface JournalPosition {
  token: JournalTokenIdentity; wallets: string[]; status: 'open' | 'closed' | 'unknown';
  remainingTokenAmount: string | null; remainingCostBasisUsd: string | null; valueUsd: string | null;
  investedUsd: string | null; soldUsd: string | null; realizedProfitUsd: string | null;
  estimatedProfitUsd: string | null; roi: string | null; feeInclusiveCapitalUsd: string | null;
  feesUsd: string | null; complete: boolean; reasons: string[];
}
export interface JournalTotals {
  valueUsd: string | null; investedUsd: string | null; soldUsd: string | null;
  realizedProfitUsd: string | null; estimatedProfitUsd: string | null; roi: string | null;
  feeInclusiveCapitalUsd: string | null; feesUsd: string | null;
}
export interface JournalSummary {
  version: 1; snapshotId: string; selectedWallets: string[]; asOf: string;
  activityFrom: string | null; coverage: 'available_position_history';
  complete: boolean; preparing: boolean; reasons: string[]; positions: JournalPosition[];
  totals: JournalTotals; savedSnapshot?: { snapshotId: string; asOf: string; totals: JournalTotals };
  retryAfterMs?: number;
}
export interface JournalTrade {
  id: string; walletAddress: string; tokenAddress: string; tokenSymbol: string | null; tokenName: string | null;
  tokenLogoUrl: string | null; side: 'buy' | 'sell'; tokenAmount: string | null; amountUsd: string | null;
  quoteAmount: string | null; quoteSymbol: string | null; txHash: string; timestamp: string;
  source: 'node' | 'gmgn' | 'node+gmgn';
}
export interface JournalActivity { trades: JournalTrade[]; cursor: string | null; activityFrom: string | null; preparing: boolean }
/** Private exports retain the public replay contract, with an account-bound lease. */
export interface JournalTokenActivity extends KolTokenActivity {
  journal: { accountId: string; walletAddress: string; membershipRevision: string; preparedAt: string; private: true; snapshotId?: string };
}
