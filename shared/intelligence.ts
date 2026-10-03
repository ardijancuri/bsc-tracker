export const signalKinds = ['clustered_buys', 'repeat_buy', 'buyer_selling', 'near_graduation', 'graduated'] as const;
export type SignalKind = typeof signalKinds[number];
export const signalLabels: Record<SignalKind, string> = {
  clustered_buys: 'KOLs buying', repeat_buy: 'Buying again', buyer_selling: 'Buyer selling',
  near_graduation: 'Near graduation', graduated: 'Graduated',
};
export interface AlertPreferences {
  windowMinutes: 5 | 10 | 30;
  minBuyers: number;
  categories: SignalKind[];
  muted: boolean;
}
export const defaultPreferences: AlertPreferences = { windowMinutes: 10, minBuyers: 3, categories: [...signalKinds], muted: false };
export interface WatchEntry { kind: 'kol' | 'token'; address: string; name: string | null; symbol?: string | null; avatarUrl?: string | null; logoUrl?: string | null }
export interface TelegramStatus {
  recipient: string | null;
  available: boolean;
  state: 'disconnected' | 'pending' | 'confirm' | 'connected';
  username: string | null;
  linkUrl: string | null;
  expiresAt: string | null;
}
export interface Watchlist { items: WatchEntry[]; preferences: AlertPreferences; telegram: TelegramStatus }
export interface SignalEvidence {
  id: string; txHash: string; walletAddress: string; kolName: string | null;
  side: string; timestamp: string; blockNumber: string; blockHash: string;
}
export interface Signal {
  id: string; kind: SignalKind; tokenAddress: string; tokenSymbol: string | null;
  tokenName: string | null; tokenLogoUrl: string | null;
  walletAddresses: string[]; kols: { address: string; name: string | null; avatarUrl: string | null }[];
  windowMinutes: number; minBuyers: number; timestamp: string; publishedAt: string;
  corrected: boolean; evidence: SignalEvidence[];
}
export type PositionStatus = 'Holding' | 'Added' | 'Reduced' | 'Exited' | 'Transferred' | 'Unknown';
export interface Position {
  walletAddress: string; tokenAddress: string; balance: string | null; status: PositionStatus;
  checkedAt: string | null; blockNumber: string | null; lastMovementAt: string | null;
}
export type LaunchStage = 'bonding' | 'near_graduation' | 'graduated' | 'unavailable';
export interface LaunchState {
  tokenAddress: string; platform: 'fourmeme' | 'flap' | null; stage: LaunchStage;
  progress: number | null; launchedAt: string | null; firstKolAt: string | null;
  graduatedAt: string | null; graduationTxHash: string | null;
  quoteAddress: string | null; poolAddress: string | null; poolId: string | null;
  liquidityUsd: string | null; liquidityBaselineUsd: string | null;
  liquidityBaselineAt: string | null; liquidityAt: string | null; checkedAt: string | null;
}
export interface LaunchItem extends LaunchState { symbol: string | null; name: string | null; logoUrl: string | null }
