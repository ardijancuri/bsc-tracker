import { canUseGmgnHistoryFallback, type KolTokenActivity } from '../shared/kolTokenTrades';
import type { ReplayAccountingSnapshot } from '../shared/tradeReplayAccounting';
import type { ReplayAccounting, ReplayInventory } from './tradeReplayData';

const fields: (keyof ReplayAccountingSnapshot)[] = ['remainingTokenAmount', 'remainingCostBasisUsd', 'cumulativeRealizedProfitUsd',
  'investedUsd', 'soldUsd', 'transferOutIncomeUsd', 'feesUsd', 'feeInclusiveCostUsd'];
const hash = /^0x[0-9a-f]{64}$/i;
const quantity = (left: number, right: number) => (left === 0) === (right === 0)
  && Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right)) * 1e-12;
const close = (left: number, right: number) => Math.abs(left - right) <= Math.max(1e-8, Math.abs(left) * 1e-10, Math.abs(right) * 1e-10);
const number = (value: unknown, signed = false): number | null => {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return null;
  const parsed = Number(value); return Number.isFinite(parsed) && (signed || parsed >= 0) ? parsed : null;
};

/** This adapter authorizes estimated replay cash flows, not canonical historical
 * inventory. No block or log position is manufactured for provider transfers. */
export function prepareGmgnReplayHistory(activity: KolTokenActivity, complete: boolean, now: number): { inventory: ReplayInventory; accounting: ReplayAccounting } | undefined {
  const raw = activity.replayAccounting, history = raw?.history, proof = history?.balanceProof;
  const fresh = (value: string | undefined) => { const time = Date.parse(value ?? ''); return Number.isFinite(time) && time <= now + 1000 && now - time <= 180_000; };
  if (!raw || !history || !proof || !complete || !canUseGmgnHistoryFallback(activity.inventory?.coverage.reason)
    || raw.version !== 1 || raw.source !== 'gmgn' || raw.policy !== 'gmgn_total_profit_v1' || raw.status !== 'estimated'
    || raw.coverage?.verification !== 'gmgn_history' || !raw.coverage.transactionsComplete || !raw.coverage.balanceMatched
    || raw.coverage.exactFinal || raw.final !== null || raw.events.length !== 0
    || raw.walletAddress !== activity.kol.address.toLowerCase() || raw.tokenAddress !== activity.token.address.toLowerCase()
    || proof.walletAddress !== raw.walletAddress || proof.tokenAddress !== raw.tokenAddress || proof.chain !== 'bsc'
    || !/^0x[0-9a-f]{40}$/.test(raw.walletAddress) || !/^0x[0-9a-f]{40}$/.test(raw.tokenAddress)
    || !/^\d+$/.test(proof.blockNumber) || !hash.test(proof.blockHash) || raw.inventoryBlockNumber !== proof.blockNumber
    || raw.inventoryBlockHash !== proof.blockHash || !/^[a-f0-9]{64}$/.test(history.fingerprint)
    || !fresh(raw.checkedAt) || !fresh(history.checkedAt) || !fresh(proof.checkedAt) || !fresh(proof.blockTimestamp)
    || Date.parse(proof.blockTimestamp) > Date.parse(proof.checkedAt) || Date.parse(proof.checkedAt) > Date.parse(raw.checkedAt)
    || Date.parse(history.checkedAt) > Date.parse(raw.checkedAt)
    || !Array.isArray(history.events) || !history.events.length || history.events.length > 10_000) return;
  const balance = number(proof.balance);
  if (balance === null) return;
  const trades = new Map(activity.trades.map(trade => [trade.id, trade])), matched = new Set<string>(), seen = new Set<string>();
  const swapTxs = new Set(activity.trades.map(trade => trade.txHash.toLowerCase()));
  const events: ReplayAccounting['events'] = [], inventoryEvents: ReplayInventory['events'] = [];
  let held = 0, invested = 0, sold = 0, out = 0, fees = 0, cost = 0, previousTime = -Infinity;
  const groups = new Map<number, { incoming: boolean; unitCost: number; block: string | null; ordinal: number | null }[]>();
  for (const event of history.events) {
    if (!event) return;
    const timestamp = Date.parse(event.timestamp), amount = number(event.tokenAmount);
    const key = `${event.txHash}:${event.kind}`, incoming = event.kind === 'buy' || event.kind === 'transfer_in';
    if (!hash.test(event.txHash) || event.id !== `gmgn:${key}` || seen.has(key) || !['buy', 'sell', 'transfer_in', 'transfer_out'].includes(event.kind)
      || !Number.isFinite(timestamp) || timestamp < previousTime || timestamp > now || timestamp > Date.parse(proof.blockTimestamp)
      || amount === null || amount <= 0 || event.logIndex !== null) return;
    seen.add(key); previousTime = timestamp;
    if (event.kind === 'buy' || event.kind === 'sell') {
      const trade = event.tradeId ? trades.get(event.tradeId) : undefined, indexedAmount = number(trade?.tokenAmount);
      if (!trade || matched.has(trade.id) || trade.side !== event.kind || trade.txHash.toLowerCase() !== event.txHash
        || indexedAmount === null || !quantity(indexedAmount, amount) || Math.abs(Date.parse(trade.timestamp) - timestamp) > 1000
        || trade.walletAddress.toLowerCase() !== raw.walletAddress || trade.tokenAddress.toLowerCase() !== raw.tokenAddress
        || event.blockNumber === null || !/^\d+$/.test(event.blockNumber) || event.blockNumber !== trade.blockNumber
        || BigInt(event.blockNumber) > BigInt(proof.blockNumber) || event.transactionIndex !== trade.transactionIndex
        || event.transactionIndex !== null && (!Number.isSafeInteger(event.transactionIndex) || event.transactionIndex < 0)) return;
      matched.add(trade.id);
    } else if (event.tradeId !== undefined || event.blockNumber !== null || event.transactionIndex !== null || swapTxs.has(event.txHash)) return;
    const snapshot = {} as Pick<ReplayAccounting['events'][number], keyof ReplayAccountingSnapshot>;
    for (const field of fields) {
      snapshot[field] = number(event[field], field === 'cumulativeRealizedProfitUsd');
      if (snapshot[field] === null && (event[field] !== null || !['remainingCostBasisUsd', 'cumulativeRealizedProfitUsd'].includes(field))) return;
    }
    const nextHeld = snapshot.remainingTokenAmount!, nextCost = snapshot.feeInclusiveCostUsd!, nextFees = snapshot.feesUsd!;
    const buyDelta = snapshot.investedUsd! - invested, sellDelta = snapshot.soldUsd! - sold, outDelta = snapshot.transferOutIncomeUsd! - out;
    const feeDelta = nextFees - fees, basisDelta = nextCost - cost - feeDelta;
    const expectedHeld = held + (incoming ? amount : -amount);
    if (expectedHeld < -Math.max(held, amount) * 1e-12 || !close(nextHeld, Math.max(0, expectedHeld))
      || buyDelta < 0 || sellDelta < 0 || outDelta < 0 || feeDelta < 0 || nextCost < cost || nextCost <= 0
      || event.kind === 'buy' && (buyDelta <= 0 || !close(basisDelta, buyDelta) || sellDelta !== 0 || outDelta !== 0)
      || event.kind === 'transfer_in' && (basisDelta <= 0 || buyDelta !== 0 || sellDelta !== 0 || outDelta !== 0 || feeDelta !== 0)
      || event.kind === 'sell' && (!close(basisDelta, 0) || buyDelta !== 0 || outDelta !== 0)
      || event.kind === 'transfer_out' && (!close(basisDelta, 0) || buyDelta !== 0 || sellDelta !== 0)
      || nextCost + 1e-8 < snapshot.investedUsd! + nextFees
      || snapshot.remainingCostBasisUsd !== null && snapshot.cumulativeRealizedProfitUsd !== null
        && !close(snapshot.cumulativeRealizedProfitUsd, snapshot.soldUsd! + snapshot.transferOutIncomeUsd! - nextCost + snapshot.remainingCostBasisUsd)
      || nextHeld === 0 && snapshot.remainingCostBasisUsd !== 0) return;
    const group = groups.get(timestamp) ?? [];
    group.push({ incoming, unitCost: (nextCost - cost) / amount, block: event.blockNumber, ordinal: event.transactionIndex }); groups.set(timestamp, group);
    held = nextHeld; invested = snapshot.investedUsd!; sold = snapshot.soldUsd!; out = snapshot.transferOutIncomeUsd!; fees = nextFees; cost = nextCost;
    events.push({ ...event, ...snapshot }); inventoryEvents.push({ ...event, ...snapshot, tokenAmount: amount });
  }
  if (matched.size !== activity.trades.length || !quantity(held, balance)) return;
  for (const group of groups.values()) {
    if (group.length < 2 || group.every(item => item.incoming && quantity(item.unitCost, group[0].unitCost))) continue;
    for (let i = 1; i < group.length; i++) {
      const a = group[i - 1], b = group[i];
      if (a.block === null || b.block === null || a.ordinal === null || b.ordinal === null
        || BigInt(b.block) < BigInt(a.block) || b.block === a.block && b.ordinal <= a.ordinal) return;
    }
  }
  return { inventory: { version: 1, events: inventoryEvents, coverage: { verification: 'gmgn_history', complete: true, reconciled: true,
    fromBlock: null, toBlock: proof.blockNumber, blockHash: proof.blockHash, balance: proof.balance,
    checkedAt: proof.checkedAt, initialBalanceSource: null, reason: 'gmgn_history_estimate' } },
    accounting: { ...raw, events, final: null } };
}
