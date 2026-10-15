import type { KolTokenActivity, KolTokenRealizedAccounting } from '../shared/kolTokenTrades.js';

const number = (raw: unknown) => typeof raw === 'string' && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)
  && Number.isFinite(Number(raw)) ? Number(raw) : null;
const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && (a === 0) === (b === 0)
  && Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-12;
const money = (value: number) => String(Number(value.toPrecision(15)));

/** An explicitly separate tracked-window estimate. Never present this as GMGN
 * lifetime profit or infer unknown transfer values / opening purchase costs. */
export function trackedTokenPnl(activity: KolTokenActivity, now = Date.now()): KolTokenRealizedAccounting | null {
  const inventory = activity.inventory, proof = inventory?.coverage, events = inventory?.events;
  const checked = Date.parse(proof?.checkedAt ?? ''), balance = number(proof?.balance);
  if (!activity.coverage.complete || inventory?.version !== 1 || !proof?.complete || !proof.reconciled || proof.status !== 'verified'
    || proof.reason || !Number.isFinite(checked) || checked > now || now - checked > 180_000 || balance === null
    || !/^\d+$/.test(proof.fromBlock ?? '') || !/^\d+$/.test(proof.toBlock ?? '') || !/^0x[0-9a-f]{64}$/i.test(proof.blockHash ?? '')
    || BigInt(proof.fromBlock!) > BigInt(proof.toBlock!)
    || !events?.length || events.length !== activity.trades.length || events.some(event => !['buy', 'sell'].includes(event.kind) || !/^\d+$/.test(event.blockNumber))
    || activity.coverage.indexedTradeCount !== activity.trades.length || activity.coverage.returnedTradeCount !== activity.trades.length) return null;
  const trades = new Map(activity.trades.map(trade => [trade.id, trade]));
  if (trades.size !== activity.trades.length) return null;
  for (const event of events) {
    const peers = events.filter(other => other.blockNumber === event.blockNumber);
    if (peers.length > 1 && (event.transactionIndex === null || !Number.isSafeInteger(event.transactionIndex)
      || peers.some(other => other !== event && other.transactionIndex === event.transactionIndex))) return null;
  }
  const seen = new Set<string>();
  const ordered = [...events].sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || (a.transactionIndex ?? -1) - (b.transactionIndex ?? -1));
  const lots: { quantity: number; cost: number }[] = [];
  let quantity = 0, invested = 0, sold = 0, basis = 0;
  for (const event of ordered) {
    const trade = event.tradeId ? trades.get(event.tradeId) : undefined;
    const amount = number(trade?.amountUsd), count = number(event.tokenAmount), remaining = number(event.remainingTokenAmount);
    if (!trade || seen.has(trade.id) || !/^0x[0-9a-f]{64}$/i.test(trade.txHash) || trade.txHash !== event.txHash || trade.side !== event.kind
      || trade.blockNumber !== event.blockNumber || trade.transactionIndex !== event.transactionIndex || trade.timestamp !== event.timestamp
      || event.transactionIndex !== null && (!Number.isSafeInteger(event.transactionIndex) || event.transactionIndex < 0)
      || trade.walletAddress.toLowerCase() !== activity.kol.address.toLowerCase() || trade.tokenAddress.toLowerCase() !== activity.token.address.toLowerCase()
      || !['node', 'node+gmgn'].includes(trade.source) || trade.valuationStatus !== 'valued' || amount === null || amount <= 0
      || count === null || count <= 0 || remaining === null || number(trade.tokenAmount) === null || !close(Number(trade.tokenAmount), count)
      || !/^\d+$/.test(event.blockNumber) || BigInt(event.blockNumber) < BigInt(proof.fromBlock!) || BigInt(event.blockNumber) > BigInt(proof.toBlock!)
      || !Number.isFinite(Date.parse(event.timestamp)) || Date.parse(event.timestamp) > now) return null;
    seen.add(trade.id);
    if (event.kind === 'buy') { quantity += count; invested += amount; basis += amount; lots.push({ quantity: count, cost: amount }); }
    else {
      if (count > quantity && !close(count, quantity)) return null;
      let left = count;
      while (left > count * 1e-12 && lots.length) {
        const lot = lots[0], used = Math.min(left, lot.quantity), cost = lot.cost * used / lot.quantity;
        lot.quantity -= used; lot.cost -= cost; basis -= cost; left -= used;
        if (lot.quantity <= count * 1e-12) lots.shift();
      }
      if (left > count * 1e-12) return null;
      quantity = close(count, quantity) ? 0 : quantity - count; sold += amount;
    }
    if (!close(quantity, remaining)) return null;
    if (remaining === 0) { quantity = 0; basis = 0; lots.length = 0; }
  }
  if (!close(quantity, balance) || (balance === 0) !== (quantity === 0) || invested <= 0 || basis < -1e-8) return null;
  const closed = balance === 0, realized = sold - invested + basis;
  return { version: 1, source: 'onchain', policy: 'onchain_net_trade_profit_v1',
    walletAddress: activity.kol.address.toLowerCase(), tokenAddress: activity.token.address.toLowerCase(), status: 'ready',
    checkedAt: new Date(now).toISOString(), realizedProfitUsd: money(realized),
    coverage: { transactionsComplete: true, balanceMatched: true, reason: 'onchain_estimate_gas_excluded' },
    position: { status: closed ? 'closed' : 'open', remainingTokenAmount: proof.balance!, remainingCostBasisUsd: money(Math.max(0, basis)),
      feeInclusiveCostUsd: money(invested), cashFlow: { investedUsd: money(invested), soldUsd: money(sold), transferOutIncomeUsd: '0', feesUsd: '0' },
      estimatedProfitUsd: closed ? money(realized) : null, estimatedRoi: closed ? money(realized / invested) : null,
      unrealizedProfitUsd: closed ? '0' : null, priceUsd: null, pricedAt: null, valuationSource: null,
      ...(!closed ? { reason: 'current_quote_unavailable' } : {}) } };
}
