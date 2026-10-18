export const creatorChainId = 56 as const;
export const creatorChallengeLifetimeMs = 10 * 60 * 1000;
export const creatorAvatarMaxBytes = 2 * 1024 * 1024;

/** Public customization only. The managing account is deliberately absent. */
export type CreatorProfile = {
  walletAddress: string;
  claimed: boolean;
  walletControlVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  websiteUrl: string | null;
  xUrl: string | null;
  telegramUrl: string | null;
  updatedAt: string | null;
};
export type CreatorStatus = CreatorProfile & { canEdit: boolean };
export type CreatorProfilePatch = Partial<Pick<CreatorProfile, 'displayName' | 'bio' | 'websiteUrl' | 'xUrl' | 'telegramUrl'>>;
export type CreatorChallenge = {
  challengeId: string;
  message: string;
  walletAddress: string;
  chainId: typeof creatorChainId;
  expiresAt: string;
  action: 'claim' | 'release';
};
export type CreatorProof = { challengeId: string; signature: string };
export type CreatorErrorCode = 'invalid_input' | 'unauthorized' | 'wrong_origin' | 'account_changed' | 'not_tracked'
  | 'already_claimed' | 'not_owner' | 'challenge_invalid' | 'signature_invalid' | 'wallet_unsupported' | 'node_unavailable' | 'rate_limited';
export type CreatorApiError = { error: string; code: CreatorErrorCode };
