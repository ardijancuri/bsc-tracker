import type { InventoryEvent, KolTokenActivity, KolTokenTrade } from '../shared/kolTokenTrades.js';
import type { ReplayAccountingFinal, ReplayAccountingSnapshot, TradeReplayAccounting } from '../shared/tradeReplayAccounting.js';

export interface GmgnReplayActivity {
  wallet?: unknown; chain?: unknown; tx_hash?: unknown; timestamp?: unknown; event_type?: unknown; type?: unknown;
  token?: { address?: unknown }; token_amount?: unknown; quote_amount?: unknown; cost_usd?: unknown; buy_cost_usd?: unknown;
  gas_usd?: unknown; dex_usd?: unknown; priority_fee?: unknown; tip_fee?: unknown; price_usd?: unknown;
  quote_token?: { token_address?: unknown; symbol?: unknown }; quote_address?: unknown;
}
export interface GmgnReplayAccountingOptions {
  activitiesComplete: boolean; aggregateRow?: Record<string, unknown> | null; checkedAt?: string; now?: number;
  balanceBlock?: string | null; balanceBlockHash?: string | null;
}
const addressRe = /^0x[0-9a-f]{40}$/;
const nativeAddresses = new Set(['0x' + '0'.repeat(40), '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']);
const numeric = (value: unknown, signed = false): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string' || typeof value === 'string' && !value.trim()) return null;
  const result = Number(value); return Number.isFinite(result) && (signed || result >= 0) ? result : null;
};
const text = (value: number | null): string | null => value !== null && Number.isFinite(value) ? String(Number(value.toPrecision(15))) : null;
const close = (a: number, b: number, relative = 1e-10) => Math.abs(a - b) <= Math.max(1e-8, Math.max(Math.abs(a), Math.abs(b)) * relative);
const sameQuantity = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && (a === 0) === (b === 0)
  && Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-12;
// Activity and trader totals use slightly different historical FX rounding. This
// bound covers the observed sub-cent difference, not a missing purchase/sale.
const sameProviderCost = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b)
  && Math.abs(a - b) <= Math.max(1e-8, Math.min(0.01, Math.max(Math.abs(a), Math.abs(b)) * 1e-6));
const kindOf = (value: unknown): InventoryEvent['kind'] | null => {
  const kind = String(value ?? '').replace(/[_-]/g, '').toLowerCase();
  return kind === 'buy' || kind === 'sell' ? kind : kind === 'transferin' ? 'transfer_in' : kind === 'transferout' ? 'transfer_out' : null;
};
const eventKey = (tx: string, kind: string) => `${tx.toLowerCase()}:${kind}`;
function quoteMatched(trade: KolTokenTrade, provider: GmgnReplayActivity) {
  if (trade.valuationStatus !== 'valued' || !['node', 'node+gmgn'].includes(trade.source)) return false;
  const providerAddress = String(provider.quote_address ?? provider.quote_token?.token_address ?? '').toLowerCase();
  const indexedAddress = trade.quoteTokenAddress?.toLowerCase();
  if (nativeAddresses.has(providerAddress)) return trade.quoteTokenAddress === null
    ? trade.quoteSymbol?.toUpperCase() === 'BNB' : indexedAddress !== undefined && nativeAddresses.has(indexedAddress);
  return !!indexedAddress && addressRe.test(providerAddress) && indexedAddress === providerAddress;
}
function ordered(a: InventoryEvent, b: InventoryEvent) {
  const left = BigInt(a.blockNumber), right = BigInt(b.blockNumber);
  return (left < right ? -1 : left > right ? 1 : 0) || (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0)
    || (a.logIndex ?? -1) - (b.logIndex ?? -1) || a.id.localeCompare(b.id);
}
function openingBalance(first: InventoryEvent): { zero: boolean; quantity: number } | null {
  const quantity = first.tokenAmount, remaining = first.remainingTokenAmount;
  if (!quantity || !remaining || !/^\d+(?:\.\d+)?$/.test(quantity) || !/^\d+(?:\.\d+)?$/.test(remaining)) return null;
  const decimals = Math.max(quantity.split('.')[1]?.length ?? 0, remaining.split('.')[1]?.length ?? 0);
  const raw = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole + fraction.padEnd(decimals, '0')); };
  const amount = raw(remaining) + (first.kind === 'buy' || first.kind === 'transfer_in' ? -raw(quantity) : raw(quantity));
  return amount < 0n ? null : { zero: amount === 0n, quantity: Number(amount) / 10 ** decimals };
}

/** Build prefix estimates from matched GMGN events and verified cash flows.
 * Aggregate residuals never get assigned to historical events. */
export function buildTradeReplayGmgnAccounting(activity: KolTokenActivity, gmgnActivities: GmgnReplayActivity[], options: GmgnReplayAccountingOptions): TradeReplayAccounting {
  const now = options.now ?? Date.now(), checkedAt = options.checkedAt ?? new Date(now).toISOString();
  const wallet = activity.kol.address.toLowerCase(), token = activity.token.address.toLowerCase();
  const proof = activity.inventory?.coverage;
  const result: TradeReplayAccounting = { version: 1, source: 'gmgn', policy: 'gmgn_total_profit_v1', walletAddress: wallet, tokenAddress: token,
    status: 'unavailable', checkedAt, inventoryBlockNumber: proof?.toBlock ?? null, inventoryBlockHash: proof?.blockHash ?? null,
    events: [], final: null, coverage: { transactionsComplete: false, balanceMatched: false, exactFinal: false } };
  const reject = (reason: string, pending = false) => { result.status = pending ? 'pending' : 'unavailable'; result.coverage.reason = reason; return result; };
  const proofTime = Date.parse(proof?.checkedAt ?? ''), fetchedTime = Date.parse(checkedAt);
  if (!Number.isFinite(fetchedTime) || fetchedTime > now || now - fetchedTime > 180_000) return reject('provider_snapshot_stale');
  if (!proof?.complete || !proof.reconciled || !activity.coverage.complete || !Number.isFinite(proofTime) || proofTime > now || now - proofTime > 180_000)
    return reject(proof?.reason ?? 'canonical_inventory_unavailable', proof?.status === 'pending');
  const balance = numeric(proof.balance), events = [...(activity.inventory?.events ?? [])];
  if (balance === null || !events.length || !/^\d+$/.test(proof.toBlock ?? '') || !/^0x[0-9a-f]{64}$/i.test(proof.blockHash ?? '')
    || events.some(event => !/^\d+$/.test(event.blockNumber) || !Number.isFinite(Date.parse(event.timestamp)) || Date.parse(event.timestamp) > now
      || !/^0x[0-9a-f]{64}$/i.test(event.txHash) || numeric(event.tokenAmount) === null || numeric(event.remainingTokenAmount) === null))
    return reject('canonical_inventory_unavailable');
  events.sort(ordered);
  const groups = new Map<string, InventoryEvent[]>();
  for (const event of events) {
    const key = eventKey(event.txHash, event.kind), group = groups.get(key) ?? []; group.push(event); groups.set(key, group);
  }
  const rows = new Map<string, GmgnReplayActivity>();
  let transactionCoverage = options.activitiesComplete, reason: string | undefined;
  for (const provider of gmgnActivities) {
    const kind = kindOf(provider.event_type ?? provider.type), tx = String(provider.tx_hash ?? '').toLowerCase();
    if (!kind || provider.wallet !== undefined && String(provider.wallet).toLowerCase() !== wallet || provider.chain !== undefined && provider.chain !== 'bsc'
      || String(provider.token?.address ?? '').toLowerCase() !== token || !/^0x[0-9a-f]{64}$/.test(tx) || rows.has(eventKey(tx, kind))) {
      transactionCoverage = false; reason ??= 'provider_transaction_mismatch'; continue;
    }
    rows.set(eventKey(tx, kind), provider);
  }
  for (const [key, group] of groups) {
    const row = rows.get(key), providerQuantity = numeric(row?.token_amount), canonicalQuantity = group.reduce((sum, event) => sum + (numeric(event.tokenAmount) ?? NaN), 0);
    const timestamp = numeric(row?.timestamp);
    if (!row || providerQuantity === null || !sameQuantity(providerQuantity, canonicalQuantity) || timestamp === null
      || group.some(event => Math.abs(Date.parse(event.timestamp) - timestamp * 1000) > 1000)) { transactionCoverage = false; reason ??= 'provider_transaction_mismatch'; }
  }
  if ([...rows.keys()].some(key => !groups.has(key))) { transactionCoverage = false; reason ??= 'provider_transaction_mismatch'; }
  result.coverage.transactionsComplete = transactionCoverage;
  const trades = new Map(activity.trades.map(trade => [trade.id, trade]));
  const lots: { quantity: number; cost: number | null }[] = [];
  const initial = openingBalance(events[0]);
  let basisKnown = initial?.zero === true, costsKnown = basisKnown, cumulativeKnown = basisKnown;
  let basis = 0, realized = 0, invested = 0, sold = 0, outgoing = 0, fees = 0, incomingCost = 0;
  if (initial && initial.quantity > 0) lots.push({ quantity: initial.quantity, cost: null });
  const take = (quantity: number): number | null => {
    let remaining = quantity, cost = 0, known = true;
    while (remaining > quantity * 1e-12 && lots.length) {
      const lot = lots[0], used = Math.min(remaining, lot.quantity), share = used / lot.quantity;
      if (lot.cost === null) known = false; else { cost += lot.cost * share; lot.cost -= lot.cost * share; }
      lot.quantity -= used; remaining -= used;
      if (lot.quantity <= quantity * 1e-12) lots.shift();
    }
    if (remaining > quantity * 1e-12) known = false;
    return known ? cost : null;
  };
  const countedFees = new Set<string>();
  for (const event of events) {
    const group = groups.get(eventKey(event.txHash, event.kind))!, row = rows.get(eventKey(event.txHash, event.kind));
    const quantity = numeric(event.tokenAmount), providerQuantity = numeric(row?.token_amount), amount = numeric(row?.cost_usd), gas = numeric(row?.gas_usd);
    const groupValid = transactionCoverage && quantity !== null && providerQuantity !== null && providerQuantity > 0 && amount !== null;
    const fraction = groupValid ? quantity! / providerQuantity! : NaN;
    const activityAmount = groupValid ? amount! * fraction : null;
    const lastInGroup = group.at(-1)!.id === event.id;
    const additionalFrictionKnown = numeric(row?.priority_fee) === 0 && numeric(row?.tip_fee) === 0;
    let fee: number | null = gas !== null && additionalFrictionKnown ? lastInGroup && !countedFees.has(eventKey(event.txHash, event.kind)) ? gas : 0 : null;
    if (event.kind === 'buy' || event.kind === 'sell') {
      const trade = event.tradeId ? trades.get(event.tradeId) : undefined;
      const quoteAmount = numeric(row?.quote_amount), indexedQuote = numeric(trade?.quoteAmount);
      if (!groupValid || !trade || !quoteMatched(trade, row!) || quoteAmount === null || quoteAmount <= 0 || indexedQuote === null || indexedQuote <= 0 || fee === null) {
        fee = null; costsKnown = false; reason ??= 'quote_or_fee_unavailable';
      } else {
        const convertedCash = indexedQuote * amount! / quoteAmount;
        const inferredFee = event.kind === 'buy' ? convertedCash - amount! + fee : amount! - convertedCash + fee;
        fee = inferredFee >= -Math.max(1e-8, amount! * 1e-10) ? Math.max(0, inferredFee) : null;
        if (fee === null) { costsKnown = false; reason ??= 'quote_or_fee_unavailable'; }
      }
    } else if (!groupValid || fee === null || numeric(row?.dex_usd) === null || numeric(row?.dex_usd)! !== 0
      || event.kind === 'transfer_in' && gas !== 0) { fee = null; costsKnown = false; reason ??= 'transfer_fee_schema_unavailable'; }
    if (lastInGroup) countedFees.add(eventKey(event.txHash, event.kind));
    if (activityAmount === null || quantity === null) { costsKnown = false; basisKnown = false; cumulativeKnown = false; }
    if (event.kind === 'buy') {
      if (activityAmount !== null) invested += activityAmount;
      const cost = activityAmount !== null && fee !== null ? activityAmount + fee : null;
      if (quantity !== null) lots.push({ quantity, cost });
      if (cost === null) basisKnown = false; else basis += cost;
    } else if (event.kind === 'transfer_in') {
      if (activityAmount !== null) incomingCost += activityAmount;
      if (quantity !== null) lots.push({ quantity, cost: activityAmount });
      if (activityAmount === null) basisKnown = false; else basis += activityAmount;
    } else {
      const fifoCost = quantity !== null ? take(quantity) : null;
      const authoritative = event.kind === 'sell' && groupValid ? numeric(row?.buy_cost_usd) : null;
      const disposedBasis = authoritative ?? fifoCost;
      if (activityAmount !== null) { if (event.kind === 'sell') sold += activityAmount; else outgoing += activityAmount; }
      if (disposedBasis === null || activityAmount === null || fee === null) { basisKnown = false; cumulativeKnown = false; }
      else { basis -= disposedBasis; realized += activityAmount - fee - disposedBasis; }
      if (basis < -Math.max(1e-8, invested * 1e-10)) { basisKnown = false; cumulativeKnown = false; reason ??= 'provider_basis_unreconciled'; }
    }
    if (fee !== null) fees += fee;
    if (numeric(event.remainingTokenAmount) === 0 && (basisKnown || costsKnown && initial?.zero)) {
      basis = 0;
      // A closed prefix has no held basis. Its realized total is therefore the
      // actual cumulative cash-flow identity, even if GMGN rounded a sold lot.
      if (costsKnown) { realized = sold + outgoing - invested - incomingCost - fees; basisKnown = true; cumulativeKnown = true; }
    }
    const snapshot: ReplayAccountingSnapshot = { remainingTokenAmount: event.remainingTokenAmount, remainingCostBasisUsd: basisKnown ? text(Math.max(0, basis)) : null,
      cumulativeRealizedProfitUsd: cumulativeKnown ? text(realized) : null, investedUsd: text(invested), soldUsd: text(sold), transferOutIncomeUsd: text(outgoing),
      feesUsd: costsKnown ? text(fees) : null, feeInclusiveCostUsd: costsKnown ? text(invested + incomingCost + fees) : null };
    result.events.push({ id: event.id, kind: event.kind, ...(event.tradeId ? { tradeId: event.tradeId } : {}), txHash: event.txHash,
      timestamp: event.timestamp, blockNumber: event.blockNumber, transactionIndex: event.transactionIndex, logIndex: event.logIndex, ...snapshot });
  }
  result.coverage.balanceMatched = sameQuantity(numeric(events.at(-1)!.remainingTokenAmount) ?? NaN, balance);
  const row = options.aggregateRow;
  if (row && transactionCoverage && result.coverage.balanceMatched) {
    const aggregateBalance = numeric(row.balance ?? row.amount_cur), aggregateCost = numeric(row.total_cost), profit = numeric(row.profit, true), ratio = numeric(row.profit_change, true);
    const bought = numeric(row.history_bought_cost), buyFees = numeric(row.history_bought_fee), sales = numeric(row.history_sold_income), sellFees = numeric(row.history_sold_fee);
    const received = numeric(row.history_transfer_in_cost), moved = numeric(row.history_transfer_out_income), moveFees = numeric(row.history_transfer_out_fee);
    const heldBasis = numeric(row.cost_cur ?? row.accu_cost ?? row.cost), heldValue = numeric(row.usd_value), realizedReported = numeric(row.realized_profit, true), unrealizedReported = numeric(row.unrealized_profit, true);
    const counts = { buy: [...groups.values()].filter(group => group[0].kind === 'buy').length, sell: [...groups.values()].filter(group => group[0].kind === 'sell').length,
      transfer_in: [...groups.values()].filter(group => group[0].kind === 'transfer_in').length, transfer_out: [...groups.values()].filter(group => group[0].kind === 'transfer_out').length };
    const newestBlock = BigInt(events.at(-1)!.blockNumber), lastBlock = numeric(row.last_block), lastActive = numeric(row.last_active_timestamp);
    const newestTime = Math.max(...events.map(event => Date.parse(event.timestamp) / 1000));
    const quantities = { buy: 0, sell: 0, transfer_in: 0, transfer_out: 0 };
    const gross = { buy: 0, sell: 0, transfer_in: 0, transfer_out: 0 };
    for (const [key, group] of groups) {
      quantities[group[0].kind] += group.reduce((sum, event) => sum + numeric(event.tokenAmount)!, 0);
      gross[group[0].kind] += numeric(rows.get(key)?.cost_usd) ?? NaN;
    }
    // current_* quantities restart after a position is fully sold. The *_cur
    // totals span the history represented by the transaction counts and costs.
    // Validate the full-history fields when supplied, without substituting a
    // matching current-cycle value for malformed or contradictory history.
    const quantitiesMatch = sameQuantity(numeric(Object.hasOwn(row, 'buy_amount_cur') ? row.buy_amount_cur : row.current_buy_amount) ?? NaN, quantities.buy)
      && sameQuantity(numeric(Object.hasOwn(row, 'sell_amount_cur') ? row.sell_amount_cur : row.current_sell_amount) ?? NaN, quantities.sell)
      && sameQuantity(numeric(row.history_transfer_in_amount) ?? NaN, quantities.transfer_in)
      && sameQuantity(numeric(row.history_transfer_out_amount) ?? NaN, quantities.transfer_out);
    const countsMatch = numeric(row.buy_tx_count_cur) === counts.buy && numeric(row.sell_tx_count_cur) === counts.sell
      && numeric(row.transfer_in_count) === counts.transfer_in && numeric(row.transfer_out_count) === counts.transfer_out;
    const valid = String(row.address ?? '').toLowerCase() === wallet && aggregateBalance !== null && sameQuantity(aggregateBalance, balance)
      && aggregateCost !== null && aggregateCost > 0 && profit !== null && ratio !== null && bought !== null && buyFees !== null && sales !== null && sellFees !== null
      && received !== null && moved !== null && moveFees !== null && heldBasis !== null && heldValue !== null && realizedReported !== null && unrealizedReported !== null
      && countsMatch && quantitiesMatch && lastBlock !== null && Number.isSafeInteger(lastBlock)
      && BigInt(lastBlock) >= newestBlock && BigInt(lastBlock) <= BigInt(proof.toBlock!)
      && lastActive !== null && Math.abs(lastActive - newestTime) <= 1
      && sameProviderCost(bought, gross.buy) && sameProviderCost(sales, gross.sell)
      && sameProviderCost(received, gross.transfer_in) && sameProviderCost(moved, gross.transfer_out)
      && close(aggregateCost, bought + buyFees + sellFees + received + moveFees)
      && close(profit, sales + moved + heldValue - aggregateCost)
      && close(profit, realizedReported + unrealizedReported) && close(unrealizedReported, heldValue - heldBasis)
      && close(realizedReported, sales + moved - aggregateCost + heldBasis) && close(ratio, profit / aggregateCost);
    if (valid) {
      const final: ReplayAccountingFinal = { remainingTokenAmount: proof.balance, remainingCostBasisUsd: text(heldBasis), cumulativeRealizedProfitUsd: text(realizedReported),
        investedUsd: text(bought), soldUsd: text(sales), transferOutIncomeUsd: text(moved), feesUsd: text(buyFees! + sellFees! + moveFees!), feeInclusiveCostUsd: text(aggregateCost),
        reportedProfitUsd: text(profit), reportedRoi: text(ratio), priceUsd: aggregateBalance! > 0 ? text(heldValue! / aggregateBalance!) : null, timestamp: checkedAt };
      result.final = final; result.coverage.exactFinal = true;
    } else reason ??= 'aggregate_snapshot_unreconciled';
  }
  result.status = result.coverage.exactFinal ? 'ready' : result.events.length ? 'estimated' : 'unavailable';
  if (!transactionCoverage) result.coverage.reason = reason ?? 'provider_history_incomplete';
  else if (reason) result.coverage.reason = reason;
  return result;
}
