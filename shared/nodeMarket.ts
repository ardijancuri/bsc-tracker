/** Persisted market evidence. Financial strings are decimal, never JS float inputs. */
export type NodeMarketProvenance = 'node' | 'imported' | 'mixed';
export type NodeMarketProtocol = 'pcs_v2' | 'pcs_v3' | 'fourmeme' | 'flap' | 'infinity_cl' | 'infinity_bin';
export interface NodeMarketQuote {
  tokenAddress: string; priceUsd: string | null; marketCapUsd: string | null; supply: string | null;
  timestamp: string | null; blockNumber: string | null; blockHash: string | null;
  source: NodeMarketProvenance; marketId: string | null; stale: boolean;
  supplyEstimated: boolean; reason: 'no_market' | 'missing_quote' | 'stale_quote' | 'unsupported_decoder' | null;
}
export interface NodeMarketBar {
  timestamp: string; open: string; high: string; low: string; close: string;
  /** Node bars retain actual observed endpoints inside their aggregation bucket. */
  firstObservationAt?: string; lastObservationAt?: string;
  volumeUsd: string | null; intervalSeconds: number; source: NodeMarketProvenance;
  /** Only a supply observed at the applicable block is an exact historical MCAP. */
  supply: string | null; supplyEstimated: boolean;
}
export interface NodeMarketChart {
  tokenAddress: string; from: string; to: string; intervalSeconds: number;
  bars: NodeMarketBar[]; source: NodeMarketProvenance; sparse: boolean; complete: boolean;
  coverage: { from: string; to: string; source: NodeMarketProvenance }[];
  reason: 'no_market' | 'incomplete_chart_coverage' | 'unsupported_decoder' | null;
}
/** Genuine price samples for a replay line. State marks never become candles. */
export interface NodeMarketReplaySamples {
  tokenAddress:string;from:string;to:string;truncated:boolean;
  observations:{timestamp:string;priceUsd:string;supply:string|null;supplyEstimated:boolean;
    blockNumber:string;blockHash:string;marketId:string;kind:'swap'|'state'}[];
  coverage:{from:string;to:string;source:NodeMarketProvenance}[];
}
export interface NodeMarketImport {
  token: string; importId: string; from: string; to: string; complete: boolean;
  /** Original provider/cache observation time; reading it again never renews it. */
  observedAt?: string;
  observations: { timestamp: string; priceUsd: string; intervalSeconds?: number;
    open?: string; high?: string; low?: string; close?: string; volumeUsd?: string | null;
    supply?: string | null }[];
}
