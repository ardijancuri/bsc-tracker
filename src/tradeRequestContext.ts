export type TradeRequestContext = { kind: 'journal'; accountId: string; snapshotId?: string };
/** Private routes always reauthorize; a public route is never a fallback for a private wallet. */
export function tradeActivityBase(wallet: string, token: string, context?: TradeRequestContext) {
  const pair = `${encodeURIComponent(wallet.toLowerCase())}/tokens/${encodeURIComponent(token.toLowerCase())}`;
  return context ? `/api/journal/wallets/${pair}` : `/api/kols/${pair}`;
}
export function tradeRequestHeaders(context?: TradeRequestContext) {
  return context ? { 'X-Watchlist-Owner': context.accountId } : undefined;
}
