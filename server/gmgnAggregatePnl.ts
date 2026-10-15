import { createHash } from 'node:crypto';
import { canUseGmgnHistoryFallback, type InventoryEvent, type KolTokenActivity, type KolTokenBalanceProof, type KolTokenRealizedAccounting } from '../shared/kolTokenTrades.js';
import type { GmgnReplayActivity } from './tradeReplayGmgnAccounting.js';

type Kind = InventoryEvent['kind'];
interface Movement { key: string; tx: string; kind: Kind; quantity: number; amount: number; timestamp: number }
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const block = /^[1-9]\d*$/;
const money = (value: number) => String(Number(value.toPrecision(15)));
const numeric = (raw: unknown, signed = false): number | null => {
  if (typeof raw !== 'number' && typeof raw !== 'string' || typeof raw === 'string' && !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)) return null;
  const value = Number(raw); return Number.isFinite(value) && (signed || value >= 0) ? value : null;
};
const close = (left: number, right: number) => Number.isFinite(left) && Number.isFinite(right)
  && Math.abs(left - right) <= Math.max(1e-8, Math.max(Math.abs(left), Math.abs(right)) * 1e-10);
const quantityMatches = (left: number, right: number, scale = Math.max(Math.abs(left), Math.abs(right))) =>
  Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= scale * 1e-12;
const costMatches = (left: number, right: number) => Number.isFinite(left) && Number.isFinite(right)
  && Math.abs(left - right) <= Math.max(1e-8, Math.min(0.01, Math.max(Math.abs(left), Math.abs(right)) * 1e-6));
const kindOf = (raw: unknown): Kind | null => {
  const value = String(raw ?? '').replace(/[_-]/g, '').toLowerCase();
  return value === 'buy' || value === 'sell' ? value : value === 'transferin' ? 'transfer_in' : value === 'transferout' ? 'transfer_out' : null;
};
const incoming = (kind: Kind) => kind === 'buy' || kind === 'transfer_in';
const fresh = (raw: string | number | null | undefined, now: number, maxAge = 180_000) => {
  const value = typeof raw === 'number' ? raw : Date.parse(raw ?? '');
  return Number.isFinite(value) && value <= now && now - value <= maxAge;
};

/** Recover a lifetime aggregate only after complete provider history agrees
 * with every indexed swap, any verified canonical window, and current balance.
 * This does not create historical replay events or assign aggregate fees to them.
 * The caller must have exhausted provider pagination for the supplied rows. */
export function buildGmgnAggregatePnl(activity: KolTokenActivity, rows: GmgnReplayActivity[], aggregate: Record<string, unknown>,
  proof: KolTokenBalanceProof, historyCheckedAt: number, now = Date.now(), aggregateCheckedAt = historyCheckedAt): KolTokenRealizedAccounting | null {
  const wallet = activity.kol.address.toLowerCase(), token = activity.token.address.toLowerCase(), inventory = activity.inventory;
  if (!address.test(wallet) || !address.test(token) || !activity.coverage.complete || !Array.isArray(rows) || !rows.length || rows.length > 10_000
    || !activity.trades.length || activity.coverage.indexedTradeCount !== activity.trades.length || activity.coverage.returnedTradeCount !== activity.trades.length
    || !fresh(historyCheckedAt, now, 30_000) || !fresh(aggregateCheckedAt, now, 30_000) || !inventory || inventory.version !== 1) return null;
  const canonical = inventory.coverage.complete && inventory.coverage.reconciled && inventory.coverage.status === 'verified';
  if (!canonical && !(inventory.coverage.complete === false && inventory.coverage.reconciled === false && inventory.coverage.status === 'unavailable'
    && canUseGmgnHistoryFallback(inventory.coverage.reason))) return null;
  const balance = numeric(proof.balance), endpoint = Date.parse(proof.blockTimestamp);
  if (proof.chain !== 'bsc' || proof.walletAddress !== wallet || proof.tokenAddress !== token || !block.test(proof.blockNumber)
    || !hash.test(proof.blockHash) || balance === null || !fresh(proof.checkedAt, now) || !fresh(endpoint, now)
    || endpoint > Date.parse(proof.checkedAt)) return null;
  const movements = new Map<string, Movement>();
  for (const row of rows) {
    const kind = kindOf(row.event_type ?? row.type), tx = String(row.tx_hash ?? '').toLowerCase();
    const quantity = numeric(row.token_amount), amount = numeric(row.cost_usd), timestamp = numeric(row.timestamp);
    if (!kind || !hash.test(tx) || String(row.wallet ?? '').toLowerCase() !== wallet || row.chain !== 'bsc'
      || String(row.token?.address ?? '').toLowerCase() !== token || quantity === null || quantity <= 0 || amount === null
      || timestamp === null || !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp * 1000 > endpoint
      || movements.has(`${tx}:${kind}`)) return null;
    movements.set(`${tx}:${kind}`, { key: `${tx}:${kind}`, tx, kind, quantity, amount, timestamp });
  }
  const swaps = new Set([...movements.values()].filter(movement => movement.kind === 'buy' || movement.kind === 'sell').map(movement => movement.tx));
  if ([...movements.values()].some(movement => movement.kind.startsWith('transfer') && swaps.has(movement.tx))) return null;
  const indexed = new Set<string>();
  let newestIndexedBlock = 0n;
  for (const trade of activity.trades) {
    const kind = kindOf(trade.side), key = `${trade.txHash.toLowerCase()}:${kind}`, movement = movements.get(key), amount = numeric(trade.tokenAmount);
    if (!['buy', 'sell'].includes(kind ?? '') || trade.walletAddress.toLowerCase() !== wallet || trade.tokenAddress.toLowerCase() !== token
      || !block.test(trade.blockNumber ?? '') || BigInt(trade.blockNumber!) > BigInt(proof.blockNumber) || !movement || indexed.has(key)
      || amount === null || !quantityMatches(amount, movement.quantity) || Math.abs(Date.parse(trade.timestamp) - movement.timestamp * 1000) > 1000
      || !Number.isFinite(Date.parse(trade.timestamp))) return null;
    newestIndexedBlock = BigInt(trade.blockNumber!) > newestIndexedBlock ? BigInt(trade.blockNumber!) : newestIndexedBlock;
    indexed.add(key);
  }
  const ordered = [...movements.values()].sort((left, right) => left.timestamp - right.timestamp || left.key.localeCompare(right.key));
  const quantities = { buy: 0, sell: 0, transfer_in: 0, transfer_out: 0 }, gross = { ...quantities }, counts = { ...quantities };
  let held = 0, movementScale = 0;
  // Same-second order can be unknown for provider-only transfers. Validate the
  // atomic group balance; final aggregate cash flow does not require FIFO order.
  for (let index = 0; index < ordered.length;) {
    const timestamp = ordered[index].timestamp;
    do {
      const movement = ordered[index++];
      quantities[movement.kind] += movement.quantity; gross[movement.kind] += movement.amount; counts[movement.kind]++;
      held += movement.quantity * (incoming(movement.kind) ? 1 : -1); movementScale += movement.quantity;
    } while (index < ordered.length && ordered[index].timestamp === timestamp);
    if (held < 0 && !quantityMatches(held, 0, movementScale)) return null;
  }
  if (!quantityMatches(held, balance, movementScale)) return null;
  if (canonical) {
    const coverage = inventory.coverage;
    if (coverage.reason || !fresh(coverage.checkedAt, now) || !block.test(coverage.fromBlock ?? '') || !block.test(coverage.toBlock ?? '')
      || !hash.test(coverage.blockHash ?? '') || BigInt(coverage.fromBlock!) > BigInt(coverage.toBlock!)
      || BigInt(coverage.toBlock!) > BigInt(proof.blockNumber) || !quantityMatches(numeric(coverage.balance) ?? NaN, balance)
      || coverage.toBlock === proof.blockNumber && coverage.blockHash !== proof.blockHash || !inventory.events.length) return null;
    const events = [...inventory.events];
    if (events.some(event => !block.test(event.blockNumber) || BigInt(event.blockNumber) < BigInt(coverage.fromBlock!)
      || BigInt(event.blockNumber) > BigInt(coverage.toBlock!) || !Number.isFinite(Date.parse(event.timestamp))
      || Date.parse(event.timestamp) > endpoint || !hash.test(event.txHash.toLowerCase()) || kindOf(event.kind) !== event.kind
      || numeric(event.tokenAmount) === null || Number(event.tokenAmount) <= 0 || numeric(event.remainingTokenAmount) === null
      || event.transactionIndex !== null && (!Number.isSafeInteger(event.transactionIndex) || event.transactionIndex < 0)
      || event.logIndex !== null && (!Number.isSafeInteger(event.logIndex) || event.logIndex < 0))) return null;
    events.sort((left, right) => Number(BigInt(left.blockNumber) - BigInt(right.blockNumber))
      || (left.transactionIndex ?? 0) - (right.transactionIndex ?? 0) || (left.logIndex ?? -1) - (right.logIndex ?? -1));
    const first = events[0], firstAt = Date.parse(first.timestamp), groups = new Map<string, InventoryEvent[]>();
    const opening = Number(first.remainingTokenAmount) - Number(first.tokenAmount) * (incoming(first.kind) ? 1 : -1);
    if (opening < 0 && !quantityMatches(opening, 0, movementScale)) return null;
    let running = opening;
    for (const event of events) {
      const key = `${event.txHash.toLowerCase()}:${event.kind}`, group = groups.get(key) ?? [];
      group.push(event); groups.set(key, group);
      running += Number(event.tokenAmount) * (incoming(event.kind) ? 1 : -1);
      if (!quantityMatches(running, Number(event.remainingTokenAmount), movementScale)) return null;
      newestIndexedBlock = BigInt(event.blockNumber) > newestIndexedBlock ? BigInt(event.blockNumber) : newestIndexedBlock;
    }
    if (!quantityMatches(running, balance, movementScale)) return null;
    for (const [key, group] of groups) {
      const row = movements.get(key), quantity = group.reduce((sum, event) => sum + Number(event.tokenAmount), 0);
      if (!row || !quantityMatches(row.quantity, quantity) || group.some(event => Math.abs(Date.parse(event.timestamp) - row.timestamp * 1000) > 1000)) return null;
    }
    for (const trade of activity.trades) if (!groups.get(`${trade.txHash.toLowerCase()}:${trade.side}`)?.some(event => event.tradeId === trade.id)) return null;
    const prefix = ordered.filter(movement => !groups.has(movement.key));
    if (prefix.length && first.blockNumber !== coverage.fromBlock || prefix.some(movement => movement.timestamp * 1000 >= firstAt)) return null;
    const openingFromHistory = prefix.reduce((sum, movement) => sum + movement.quantity * (incoming(movement.kind) ? 1 : -1), 0);
    if (!quantityMatches(openingFromHistory, opening, movementScale)) return null;
  }
  const latest = ordered.at(-1)!, lastBlock = numeric(aggregate.last_block), lastActive = numeric(aggregate.last_active_timestamp);
  if (latest.timestamp * 1000 > Math.min(historyCheckedAt, aggregateCheckedAt)) return null;
  const aggregateBalance = numeric(aggregate.balance ?? aggregate.amount_cur), cost = numeric(aggregate.total_cost), profit = numeric(aggregate.profit, true), roi = numeric(aggregate.profit_change, true);
  const bought = numeric(aggregate.history_bought_cost), buyFees = numeric(aggregate.history_bought_fee), sold = numeric(aggregate.history_sold_income), sellFees = numeric(aggregate.history_sold_fee);
  const received = numeric(aggregate.history_transfer_in_cost), outgoing = numeric(aggregate.history_transfer_out_income), transferFees = numeric(aggregate.history_transfer_out_fee);
  const basis = numeric(aggregate.cost_cur ?? aggregate.accu_cost ?? aggregate.cost), heldValue = numeric(aggregate.usd_value);
  const realized = numeric(aggregate.realized_profit, true), unrealized = numeric(aggregate.unrealized_profit, true);
  if ([aggregateBalance, cost, profit, roi, bought, buyFees, sold, sellFees, received, outgoing, transferFees, basis, heldValue, realized, unrealized].some(value => value === null)
    || String(aggregate.address ?? '').toLowerCase() !== wallet || !quantityMatches(aggregateBalance!, balance) || cost! <= 0
    || balance === 0 && (basis !== 0 || heldValue !== 0 || unrealized !== 0) || balance > 0 && heldValue! <= 0
    || !quantityMatches(numeric(Object.hasOwn(aggregate, 'buy_amount_cur') ? aggregate.buy_amount_cur : aggregate.current_buy_amount) ?? NaN, quantities.buy)
    || !quantityMatches(numeric(Object.hasOwn(aggregate, 'sell_amount_cur') ? aggregate.sell_amount_cur : aggregate.current_sell_amount) ?? NaN, quantities.sell)
    || !quantityMatches(numeric(aggregate.history_transfer_in_amount) ?? NaN, quantities.transfer_in)
    || !quantityMatches(numeric(aggregate.history_transfer_out_amount) ?? NaN, quantities.transfer_out)
    || numeric(aggregate.buy_tx_count_cur) !== counts.buy || numeric(aggregate.sell_tx_count_cur) !== counts.sell
    || numeric(aggregate.transfer_in_count) !== counts.transfer_in || numeric(aggregate.transfer_out_count) !== counts.transfer_out
    || lastBlock === null || !Number.isSafeInteger(lastBlock) || BigInt(lastBlock) < newestIndexedBlock || BigInt(lastBlock) > BigInt(proof.blockNumber)
    || lastActive === null || Math.abs(lastActive - latest.timestamp) > 1 || !costMatches(bought!, gross.buy) || !costMatches(sold!, gross.sell)
    || !costMatches(received!, gross.transfer_in) || !costMatches(outgoing!, gross.transfer_out)
    || !close(cost!, bought! + buyFees! + sellFees! + received! + transferFees!) || !close(profit!, sold! + outgoing! + heldValue! - cost!)
    || !close(profit!, realized! + unrealized!) || !close(unrealized!, heldValue! - basis!)
    || !close(realized!, sold! + outgoing! - cost! + basis!) || !close(roi!, profit! / cost!)) return null;
  return { version: 1, source: 'gmgn', policy: 'gmgn_realized_profit_v1', walletAddress: wallet, tokenAddress: token, status: 'ready',
    checkedAt: new Date(now).toISOString(), realizedProfitUsd: money(realized!),
    coverage: { transactionsComplete: true, balanceMatched: true, verification: 'gmgn_history', reason: 'gmgn_aggregate_verified',
      historyFingerprint: createHash('sha256').update(JSON.stringify({ wallet, token, movements: ordered })).digest('hex'),
      historyCheckedAt: new Date(historyCheckedAt).toISOString(), lastMovementAt: new Date(latest.timestamp * 1000).toISOString(), balanceProof: { ...proof } },
    position: { status: balance > 0 ? 'open' : 'closed', remainingTokenAmount: proof.balance, remainingCostBasisUsd: money(basis!), feeInclusiveCostUsd: money(cost!),
      cashFlow: { investedUsd: money(bought!), soldUsd: money(sold!), transferOutIncomeUsd: money(outgoing!), feesUsd: money(buyFees! + sellFees! + transferFees!) },
      estimatedProfitUsd: money(profit!), estimatedRoi: money(roi!), unrealizedProfitUsd: money(unrealized!),
      priceUsd: balance > 0 ? money(heldValue! / balance) : null, pricedAt: balance > 0 ? new Date(aggregateCheckedAt).toISOString() : null,
      valuationSource: balance > 0 ? 'gmgn' : null } };
}
