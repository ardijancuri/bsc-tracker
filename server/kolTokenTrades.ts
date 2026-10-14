import type { InventoryEvent, KolTokenInventoryEvidence, KolTokenTrade, KolTokenTradeSummary } from '../shared/kolTokenTrades.js';
export type { KolTokenInventoryEvidence, KolTokenInventoryTransfer } from '../shared/kolTokenTrades.js';

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
function summarizeObservedTrades(input: IndexedKolTokenTrade[], walletAddress: string, tokenAddress: string,
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

const maximumRaw = (1n << 256n) - 1n;
function rawInteger(value: unknown, signed = false): bigint | null {
  if (typeof value !== 'string' || value.length > 79 || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) return null;
  const raw = BigInt(value);
  return raw >= -maximumRaw && raw <= maximumRaw && (signed || raw >= 0n) ? raw : null;
}

/** Parse token units without rounding away a raw unit or accepting excess precision. */
function quantityRaw(value: unknown, decimals: number): bigint | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) return null;
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 300) return null;
  let digits = (match[1] + (match[2] ?? '')).replace(/^0+/, '') || '0';
  const shift = decimals + exponent - (match[2]?.length ?? 0);
  if (shift < 0) {
    const removed = Math.min(-shift, digits.length);
    if (!/^0+$/.test(digits.slice(-removed))) return null;
    digits = digits.slice(0, digits.length - removed) || '0';
  } else {
    if (digits.length + shift > 78) return null;
    digits += '0'.repeat(shift);
  }
  return rawInteger(digits);
}

function tokenUnits(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const fraction = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${raw / divisor}${fraction ? `.${fraction}` : ''}`;
}

type InventoryEntry = Omit<InventoryEvent, 'remainingTokenAmount' | 'remainingCostBasisUsd' | 'cumulativeRealizedProfitUsd' | 'investedUsd' | 'soldUsd'> & {
  raw: bigint | null;
  trade?: KolTokenTrade;
};
type InventoryLot = { raw: bigint; costUsd: number | null };
function inventoryOrder(a: InventoryEntry, b: InventoryEntry) {
  const left = BigInt(a.blockNumber), right = BigInt(b.blockNumber);
  return (left < right ? -1 : left > right ? 1 : 0)
    || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0)
    || (a.logIndex ?? -1) - (b.logIndex ?? -1) || a.id.localeCompare(b.id);
}

/** Optional canonical movement evidence upgrades swap-only FIFO to wallet inventory. */
export function summarizeKolTokenTrades(input: IndexedKolTokenTrade[], walletAddress: string, tokenAddress: string,
  marketCapSupply: string | null, complete = true, now = Date.now(), evidence?: KolTokenInventoryEvidence) {
  const observed = summarizeObservedTrades(input, walletAddress, tokenAddress, marketCapSupply, complete, now);
  if (!evidence) return observed as typeof observed & { inventory?: { version: 1; events: InventoryEvent[]; coverage: KolTokenInventoryEvidence['coverage'] } };
  const wallet = walletAddress.toLowerCase(), token = tokenAddress.toLowerCase();
  const decimalsValid = Number.isInteger(evidence.decimals) && evidence.decimals >= 0 && evidence.decimals <= 36;
  const decimals = decimalsValid ? evidence.decimals : 18;
  const from = rawInteger(evidence.coverage.fromBlock), to = rawInteger(evidence.coverage.toBlock);
  const initial = rawInteger(evidence.initialBalanceRaw), ending = rawInteger(evidence.endingBalanceRaw);
  let invalidReason: string | undefined;
  const invalidate = (reason: string) => { invalidReason ??= reason; };
  if (!decimalsValid || from === null || to === null || from > to || initial === null || ending === null
    || !/^0x[0-9a-f]{64}$/i.test(evidence.coverage.blockHash ?? '')
    || !Number.isFinite(Date.parse(evidence.coverage.checkedAt ?? '')) || Date.parse(evidence.coverage.checkedAt!) > now) invalidate('invalid_inventory_proof');
  if (evidence.coverage.complete && (evidence.coverage.status !== undefined && evidence.coverage.status !== 'verified'
    || evidence.coverage.initialBalanceSource === null
    || evidence.coverage.scannedThroughBlock !== undefined && rawInteger(evidence.coverage.scannedThroughBlock) !== to)) invalidate('incomplete_inventory_proof');
  const reportedBalance = quantityRaw(evidence.coverage.balance, decimals);
  if (ending !== null && reportedBalance !== ending) invalidate('balance_mismatch');
  const inWindow = (block: unknown, time: string) => {
    const height = rawInteger(block), date = Date.parse(time);
    return height !== null && from !== null && to !== null && height >= from && height <= to && Number.isFinite(date) && date <= now;
  };
  const indexValid = (value: number | null) => value === null || Number.isSafeInteger(value) && value >= 0;
  const entries: InventoryEntry[] = [];
  const ids = new Set<string>(), transferLogs = new Set<string>(), swapTransactions = new Set(observed.trades.map(row => row.txHash.toLowerCase()));
  for (const row of observed.trades) {
    if (!inWindow(row.blockNumber, row.timestamp) || !indexValid(row.transactionIndex)
      || !['buy', 'sell'].includes(row.side) || ids.has(row.id)) { invalidate('invalid_inventory_trade'); continue; }
    ids.add(row.id);
    const raw = quantityRaw(row.tokenAmount, decimals);
    if (raw === null || raw === 0n) invalidate('invalid_inventory_quantity');
    entries.push({ id: row.id, kind: row.side as 'buy' | 'sell', tradeId: row.id, txHash: row.txHash, timestamp: row.timestamp,
      blockNumber: BigInt(row.blockNumber!).toString(), transactionIndex: row.transactionIndex, logIndex: null,
      tokenAmount: raw !== null ? tokenUnits(raw, decimals) : null, raw, trade: row });
  }
  for (const transfer of Array.isArray(evidence.transfers) ? evidence.transfers : []) {
    if (!transfer || typeof transfer.walletAddress !== 'string' || typeof transfer.tokenAddress !== 'string'
      || typeof transfer.txHash !== 'string' || typeof transfer.timestamp !== 'string' || typeof transfer.id !== 'string') {
      invalidate('invalid_inventory_transfer'); continue;
    }
    const raw = rawInteger(transfer.deltaRaw, true);
    const key = `${transfer.blockNumber}:${transfer.txHash?.toLowerCase()}:${transfer.logIndex}`;
    if (transfer.walletAddress?.toLowerCase() !== wallet || transfer.tokenAddress?.toLowerCase() !== token
      || !transfer.id || typeof transfer.txHash !== 'string' || !inWindow(transfer.blockNumber, transfer.timestamp)
      || !indexValid(transfer.transactionIndex) || !indexValid(transfer.logIndex) || transfer.logIndex === null
      || raw === null || ids.has(transfer.id) || transferLogs.has(key) || swapTransactions.has(transfer.txHash.toLowerCase())) {
      invalidate('invalid_inventory_transfer'); continue;
    }
    if (raw === 0n) continue;
    ids.add(transfer.id); transferLogs.add(key);
    const amount = raw < 0n ? -raw : raw;
    entries.push({ id: transfer.id, kind: raw > 0n ? 'transfer_in' : 'transfer_out', txHash: transfer.txHash,
      timestamp: timestamp(transfer.timestamp), blockNumber: BigInt(transfer.blockNumber).toString(), transactionIndex: transfer.transactionIndex,
      logIndex: transfer.logIndex, tokenAmount: tokenUnits(amount, decimals), raw: amount });
  }
  if (!Array.isArray(evidence.transfers)) invalidate('invalid_inventory_transfer');
  entries.sort(inventoryOrder);
  for (let index = 1; index < entries.length; index++) {
    const previous = entries[index - 1], current = entries[index];
    if (previous.blockNumber === current.blockNumber && previous.txHash.toLowerCase() !== current.txHash.toLowerCase()
      && (previous.transactionIndex === null || current.transactionIndex === null || previous.transactionIndex === current.transactionIndex)) invalidate('ambiguous_inventory_order');
  }
  const lots: InventoryLot[] = initial !== null && initial > 0n ? [{ raw: initial, costUsd: null }] : [];
  let quantityKnown = initial !== null, realizedKnown = complete, boughtKnown = complete, soldKnown = complete;
  let invested = 0, proceeds = 0, realized = 0, boughtRaw = 0n, soldRaw = 0n;
  let valuedBuyCount = 0, valuedSellCount = 0, excludedSellCount = 0, unpricedTradeCount = 0;
  const rowProfits = new Map<string, { realizedProfitUsd: string | null; cumulativeRealizedProfitUsd: string | null }>();
  const takeLots = (raw: bigint) => {
    let remaining = raw, cost = 0, known = true;
    while (remaining > 0n && lots.length) {
      const lot = lots[0], used = remaining < lot.raw ? remaining : lot.raw;
      const removedCost = lot.costUsd === null ? null : used === lot.raw ? lot.costUsd : lot.costUsd * (Number(used) / Number(lot.raw));
      if (removedCost === null || !Number.isFinite(removedCost)) known = false;
      else cost += removedCost;
      remaining -= used; lot.raw -= used;
      if (lot.costUsd !== null && removedCost !== null) lot.costUsd = Math.max(0, lot.costUsd - removedCost);
      if (lot.raw === 0n) lots.shift();
    }
    if (remaining > 0n) { quantityKnown = false; known = false; invalidate('inventory_underflow'); }
    return known && Number.isFinite(cost) ? cost : null;
  };
  const events: InventoryEvent[] = [];
  for (const entry of entries) {
    const { raw, trade: row, ...identity } = entry;
    const amount = row ? validNumber(row.amountUsd) : null;
    const valued = row?.valuationStatus === 'valued' && raw !== null && raw > 0n && amount !== null;
    let rowProfit: string | null = null;
    if (raw === null || raw === 0n) quantityKnown = false;
    if (entry.kind === 'buy') {
      if (valued) { invested += amount!; boughtRaw += raw!; valuedBuyCount++; } else { boughtKnown = false; unpricedTradeCount++; }
      if (raw !== null && raw > 0n) lots.push({ raw, costUsd: valued ? amount : null });
    } else if (entry.kind === 'transfer_in') {
      if (raw !== null && raw > 0n) lots.push({ raw, costUsd: null });
    } else {
      const removed = raw !== null && raw > 0n ? takeLots(raw) : null;
      if (entry.kind === 'sell') {
        if (valued) { proceeds += amount!; soldRaw += raw!; } else { soldKnown = false; unpricedTradeCount++; }
        const profit = valued && quantityKnown && removed !== null ? amount! - removed : NaN;
        if (Number.isFinite(profit)) { realized += profit; rowProfit = text(profit); valuedSellCount++; }
        else { realizedKnown = false; excludedSellCount++; }
      }
    }
    const remainingRaw = lots.reduce((sum, lot) => sum + lot.raw, 0n);
    const basis = lots.every(lot => lot.costUsd !== null) ? lots.reduce((sum, lot) => sum + lot.costUsd!, 0) : NaN;
    events.push({ ...identity, remainingTokenAmount: quantityKnown ? tokenUnits(remainingRaw, decimals) : null,
      remainingCostBasisUsd: quantityKnown && Number.isFinite(basis) ? text(basis) : null,
      cumulativeRealizedProfitUsd: realizedKnown ? text(realized) : null,
      investedUsd: boughtKnown ? text(invested) : null, soldUsd: soldKnown ? text(proceeds) : null });
    if (row) rowProfits.set(row.id, { realizedProfitUsd: rowProfit, cumulativeRealizedProfitUsd: realizedKnown ? text(realized) : null });
  }
  const remainingRaw = lots.reduce((sum, lot) => sum + lot.raw, 0n);
  if (ending === null || !quantityKnown || remainingRaw !== ending) invalidate('balance_mismatch');
  const inventoryComplete = complete && evidence.coverage.complete && !invalidReason;
  const reconciled = inventoryComplete && evidence.coverage.reconciled && ending !== null && remainingRaw === ending;
  if (!reconciled) for (const event of events) {
    event.remainingTokenAmount = null; event.remainingCostBasisUsd = null; event.cumulativeRealizedProfitUsd = null;
  }
  const final = events.at(-1);
  const averageBuy = boughtKnown && boughtRaw > 0n ? invested / Number(tokenUnits(boughtRaw, decimals)) : null;
  const averageSell = soldKnown && soldRaw > 0n ? proceeds / Number(tokenUnits(soldRaw, decimals)) : null;
  const supply = validNumber(marketCapSupply, true);
  return { trades: observed.trades.map(row => ({ ...row,
    realizedProfitUsd: reconciled ? rowProfits.get(row.id)?.realizedProfitUsd ?? null : null,
    cumulativeRealizedProfitUsd: reconciled ? rowProfits.get(row.id)?.cumulativeRealizedProfitUsd ?? null : null })),
    summary: { ...observed.summary, investedUsd: boughtKnown ? text(invested) : null, soldUsd: soldKnown ? text(proceeds) : null,
      realizedProfitUsd: reconciled && realizedKnown ? text(realized) : null,
      avgBoughtPriceUsd: averageBuy !== null ? text(averageBuy) : null, avgSoldPriceUsd: averageSell !== null ? text(averageSell) : null,
      avgBoughtMcapUsd: averageBuy !== null && supply !== null ? text(averageBuy * supply) : null,
      avgSoldMcapUsd: averageSell !== null && supply !== null ? text(averageSell * supply) : null,
      remainingTokenAmount: reconciled ? tokenUnits(remainingRaw, decimals) : null,
      remainingCostBasisUsd: reconciled ? final?.remainingCostBasisUsd ?? (remainingRaw === 0n ? '0' : null) : null,
      valuedBuyCount, valuedSellCount: reconciled ? valuedSellCount : 0, excludedSellCount: reconciled ? excludedSellCount : observed.summary.sellCount,
      unpricedTradeCount, status: reconciled ? remainingRaw > 0n ? 'open' as const : 'closed' as const : 'unknown' as const },
    inventory: { version: 1 as const, events, coverage: { ...evidence.coverage, complete: inventoryComplete, reconciled,
      balance: ending !== null ? tokenUnits(ending, decimals) : null,
      ...(!reconciled ? { status: evidence.coverage.status === 'pending' ? 'pending' as const : 'unavailable' as const,
        reason: evidence.coverage.reason ?? invalidReason ?? 'inventory_unreconciled' } : {}) } } };
}
