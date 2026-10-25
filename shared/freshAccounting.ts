export interface FreshAcquisitionCost{version:1;policy:'actual_quote_acquisition_cost_v1';provenance:'node_execution_acquisition';quoteScope:'this_execution_acquired_quote_only';quoteAddress:string;grossNativeWei:string;wrappedNativeWei:string;nativeRouterDeductionWei:string;nativeRouterDeductionRecipient:string;quoteAcquiredRaw:string;quoteSpentRaw:string;quoteChangeRaw:string;nativePriceUsd:string;grossCostUsd:string;tokenCostUsd:string;remainingQuoteCostUsd:string;grossCostQ:string;tokenCostQ:string;remainingQuoteCostQ:string;gasNativeWei:string;}
/** Compact, source-neutral financial facts. Decimal inputs are never JS numbers. */
export interface FreshFinancialEvent {
  id: string; executionKey: string; walletAddress: string; tokenAddress: string | null;
  kind: 'buy' | 'sell' | 'transfer_in' | 'transfer_out' | 'fee';
  quantity: string; amountUsd: string | null; feeUsd: string | null; feeKey: string | null;
  /** Actual settled quote units, independent of USD valuation and wallet gas.
   * BNB is a native settlement; WBNB denotes a genuine ERC20 movement. */
  quoteAddress?: string; quoteSymbol?: string; quoteAmount?: string;
  acquisitionCost?:FreshAcquisitionCost;
  counterparty: string | null; transferKey: string | null;
  blockNumber: string; blockHash: string; transactionHash: string;
  transactionIndex: number; executionIndex: number; logIndex: number | null;
  occurredAt: string; canonical?: boolean;
  /** Only authenticated fees attributable to an eligible tracked token enter its books. */
  feeAttribution?: { status: 'eligible' | 'unattributed' | 'excluded'; tokenAddress?: string; contract?: string; selector?: string; nativeFeeWei: string | null;
    expensePolicy?:'signed_batch_trade_expenses_v1';batchExpenseNativeWei?:string;gasNativeWei?:string };
}
export interface FreshScope {
  id: string; kind: 'kol' | 'portfolio_wallet' | 'portfolio_combined'; walletAddresses: string[];
  accountId: string | null; startsAt: string; startsBlock: string; revision: string;
  /** Active membership boundaries; combined books never adopt another wallet's older history. */
  walletStarts?: Record<string, { startsAt: string; startsBlock: string }>;
  /** Server-validated explicit public-token history only; private membership
   * boundaries never inherit this extension. Not a changed collection start. */
  tokenHistoryStarts?:Record<string,{startsAt:string;startsBlock:string;permissionDigest:string;policy:'gmgn_gang_only_history_v1'}>;
}
export interface FreshLot {
  id: string; scopeId: string; tokenAddress: string; walletAddress: string;
  acquiredEventId: string; acquiredBlock: string; acquiredTransactionIndex: number; acquiredExecutionIndex: number;
  quantityQ: string; costQ: string | null; feeKnown: boolean;
}
export interface FreshPosition {
  scopeId: string; tokenAddress: string; quantityQ: string; investedQ: string; soldQ: string;
  incomingQ: string; outgoingQ: string; feesQ: string; capitalQ: string; realizedQ: string | null;
  unknownCost: boolean; unknownFee: boolean; lastEventId: string | null; lastEventAt: string | null; revision: string;
  unknownPurchaseValue: boolean; unknownSaleValue: boolean; unknownIncomingValue: boolean; unknownOutgoingValue: boolean;
}
export interface FreshEventResult {
  scopeId: string; eventId: string; tokenAddress: string | null; realizedQ: string | null;
  knownRealizedQ: string; capitalQ: string; feeQ: string | null; feeKey: string | null;
  tradeCount: number; volumeQ: string; tokensTrade: boolean; occurredAt: string;
}
export interface FreshPositionSummary {
  scopeId: string; tokenAddress: string; quantity: string; remainingCostUsd: string | null;
  investedUsd: string | null; soldUsd: string | null; incomingTransferCostUsd: string | null; transferOutIncomeUsd: string | null;
  feesUsd: string | null; capitalUsd: string | null; realizedProfitUsd: string | null; valueUsd: string | null;
  estimatedProfitUsd: string | null; roi: string | null; status: 'complete' | 'unknown_costs' | 'unknown_fees' | 'quote_unavailable';
}
export interface FreshFeeExclusions {
  policy: 'eligible_new_tokens_only'; count: number; knownFeesUsd: string; unknownFeeCount: number; unattributedCount: number;
}
