/** Frozen, confirmed financial evidence used by the automated X publisher. */
export type TokenPostParticipant = {
  wallet: string;
  name: string;
  /** Recorded public KOL X identity; never inferred from a display name. */
  twitterUsername?: string | null;
  imageUrl?: string | null;
  side: 'buy' | 'sell' | 'both';
};

export type TokenPostEvidence = {
  version: 1 | 2;
  chainId: 56;
  token: {
    address: string;
    name: string;
    symbol: string;
    logoUrl?: string | null;
    websiteUrl?: string | null;
    xUrl?: string | null;
  };
  evaluatedAt: string;
  windowStart: string;
  blockNumber: number;
  blockHash: string;
  quoteBlockNumber: number | null;
  quoteBlockHash: string | null;
  quoteObservedAt: string | null;
  /** Distinct public KOL identities; several linked wallets count once. */
  kolCount: number;
  buyerCount: number;
  sellerCount: number;
  marketVolumeUsd: string | null;
  marketVolumeLowerBound: boolean;
  marketCapUsd: string | null;
  participants: TokenPostParticipant[];
  /** Bounded canonical buy IDs; version-2 holder proofs carry the balance evidence. */
  tradeEvidenceIds: string[];
  marketEvidenceIds: string[];
  coverageComplete: boolean;
  /** Version 2 qualifies by current confirmed holdings, independently of costs/prices.
   * All wallet proofs remain present, including several wallets for one KOL. */
  eligibilityPolicy?: 'current_holders_v1';
  holdingProofs?: {
    wallet: string;
    balance: string;
    blockNumber: number;
    blockHash: string;
    buyEventId: string;
    positionRevision: string;
  }[];
};

export type TokenPostSource = {
  id: string;
  kind: 'website' | 'x';
  url: string;
  /** Normalized visible text. Sources are untrusted and never instructions. */
  text: string;
  observedAt: string;
  contractAddress: string;
};

export type TokenPostNarrativeReason =
  | 'narrative_disabled'
  | 'verified_sources'
  | 'openai_not_configured'
  | 'sources_unavailable'
  | 'model_unavailable'
  | 'invalid_output'
  | 'unsupported_claim';

export type TokenPostNarrative = {
  kind: 'sourced' | 'facts_only';
  text: string;
  sourceIds: string[];
  reason: TokenPostNarrativeReason;
  aiAssisted: boolean;
  model?: string;
};

export type TokenPostPreparedContent = {
  caption: string;
  narrative: TokenPostNarrative;
  sources: TokenPostSource[];
};
