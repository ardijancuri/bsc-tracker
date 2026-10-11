import type { KolTokenTrade, KolTokenTradeSummary } from '../shared/kolTokenTrades.js';

export type IndexedKolTokenTrade = Omit<KolTokenTrade, 'marketCapUsd' | 'valuationStatus' | 'realizedProfitUsd' | 'cumulativeRealizedProfitUsd'> & {
  sharedQuote?: boolean;
};
type Lot = { quantity: number; costPerToken: number | null };

const validNumber = (value: string | null, positive = false): number | null => {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && (positive ? parsed > 0 : parsed >= 0) ? parsed : null;
};
const text = (value: number): string | null => Number.isFinite(value) ? String(Number(value.toPrecision(15))) : null;
const timestamp = (value: string | Date) => new Date(value).toISOString();
function ordered(a: IndexedKolTokenTrade, b: IndexedKolTokenTrade) {
  return Date.parse(a.timestamp) - Date.parse(b.timestamp) || Number(a.blockNumber || 0) - Number(b.blockNumber || 0)
    || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) || a.id.localeCompare(b.id);
}

/** FIFO over confirmed trades for the requested pair; never reuse an incomplete sale's lots. */
export function summarizeKolTokenTrades(input: IndexedKolTokenTrade[], walletAddress: string, tokenAddress: string,
  marketCapSupply: string | null, complete = true, now = Date.now()): { trades: KolTokenTrade[]; summary: KolTokenTradeSummary } {
  const wallet = walletAddress.toLowerCase(), token = tokenAddress.toLowerCase();
  const trades = input.filter(row => row.walletAddress.toLowerCase() === wallet && row.tokenAddress.toLowerCase() === token && row.blockNumber != null
    && Number.isFinite(Date.parse(row.timestamp)) && Date.parse(row.timestamp) <= now).sort(ordered);
  const supply = validNumber(marketCapSupply, true);
  const lots: Lot[] = [];
  const details: KolTokenTrade[] = [];
  let invested = 0, proceeds = 0, boughtQuantity = 0, soldQuantity = 0, realized = 0;
  let buyCount = 0, sellCount = 0, valuedBuyCount = 0, valuedSellCount = 0, excludedSellCount = 0, unpricedTradeCount = 0;
  let buyComplete = complete, sellComplete = complete, basisComplete = complete, cumulativeComplete = complete;
  for (const row of trades) {
    const quantity = validNumber(row.tokenAmount, true), amount = validNumber(row.amountUsd);
    const valuationStatus = quantity == null ? 'invalid_quantity' : row.sharedQuote ? 'shared_quote' : amount == null ? 'unpriced' : 'valued';
    const valued = valuationStatus === 'valued';
    if (!valued) unpricedTradeCount++;
    // A stored price can originate from the same duplicated or unresolved quote
    // budget as amountUsd. Only expose a fill price when the trade valuation is usable.
    const price = valued ? validNumber(row.priceUsd, true) ?? amount! / quantity! : null;
    let rowProfit: string | null = null;
    if (row.side === 'buy') {
      buyCount++;
      if (valued) { invested += amount!; boughtQuantity += quantity!; valuedBuyCount++; }
      else buyComplete = false;
      if (quantity != null) lots.push({ quantity, costPerToken: valued ? amount! / quantity : null });
      else { basisComplete = false; cumulativeComplete = false; }
    } else if (row.side === 'sell') {
      sellCount++;
      if (valued) { proceeds += amount!; soldQuantity += quantity!; }
      else sellComplete = false;
      let remaining = quantity ?? 0, profit = 0, matched = valued && complete && basisComplete;
      const tolerance = Math.max(Number.MIN_VALUE, remaining * 1e-12);
      while (remaining > tolerance && lots.length) {
        const lot = lots[0], used = Math.min(remaining, lot.quantity);
        if (valued && lot.costPerToken != null) profit += used * (amount! / quantity! - lot.costPerToken);
        else matched = false;
        remaining -= used; lot.quantity -= used;
        if (lot.quantity <= tolerance) lots.shift();
      }
      if (remaining > tolerance || quantity == null || !Number.isFinite(profit)) matched = false;
      if (matched) { realized += profit; rowProfit = text(profit); valuedSellCount++; }
      else { excludedSellCount++; cumulativeComplete = false; }
      if (quantity == null) basisComplete = false;
    } else {
      // An unresolved swap/movement could change the cost basis of later sales.
      basisComplete = false; cumulativeComplete = false;
    }
    const { sharedQuote: _shared, ...publicRow } = row;
    details.push({ ...publicRow, timestamp: timestamp(row.timestamp), valuationStatus,
      priceUsd: price != null ? text(price) : null,
      marketCapUsd: price != null && supply != null ? text(price * supply) : null,
      realizedProfitUsd: rowProfit, cumulativeRealizedProfitUsd: cumulativeComplete ? text(realized) : null });
  }
  const remaining = lots.reduce((total, lot) => total + lot.quantity, 0);
  const remainingCost = lots.reduce((total, lot) => total + lot.quantity * (lot.costPerToken ?? 0), 0);
  const remainingComplete = basisComplete && lots.every(lot => lot.costPerToken != null);
  const avgBuy = buyComplete && boughtQuantity > 0 ? invested / boughtQuantity : null;
  const avgSell = sellComplete && soldQuantity > 0 ? proceeds / soldQuantity : null;
  return { trades: details.reverse(), summary: {
    investedUsd: buyComplete ? text(invested) : null, soldUsd: sellComplete ? text(proceeds) : null,
    realizedProfitUsd: cumulativeComplete ? text(realized) : null,
    avgBoughtPriceUsd: avgBuy != null ? text(avgBuy) : null, avgSoldPriceUsd: avgSell != null ? text(avgSell) : null,
    avgBoughtMcapUsd: avgBuy != null && supply != null ? text(avgBuy * supply) : null,
    avgSoldMcapUsd: avgSell != null && supply != null ? text(avgSell * supply) : null,
    remainingTokenAmount: basisComplete ? text(remaining) : null,
    remainingCostBasisUsd: remainingComplete ? text(remainingCost) : null,
    buyCount, sellCount, valuedBuyCount, valuedSellCount, excludedSellCount, unpricedTradeCount,
    firstTradeAt: trades[0] ? timestamp(trades[0].timestamp) : null, lastTradeAt: trades.at(-1) ? timestamp(trades.at(-1)!.timestamp) : null,
    status: basisComplete && cumulativeComplete ? remaining > Math.max(Number.MIN_VALUE, (boughtQuantity + soldQuantity) * 1e-12) ? 'open' : 'closed' : 'unknown', profitBasis: 'observed_fifo',
  } };
}
