import { createHash } from 'node:crypto';
import type { KolTokenActivity, KolTokenBalanceProof, KolTokenRealizedAccounting, KolTokenTrade } from '../shared/kolTokenTrades.js';
import { trackedTokenPnl } from './kolTokenTrackedPnl.js';

export interface TrackedProviderHistory {
  complete: boolean; checkedAt: number;
  rows: { tx: string; kind: string; quantity: number; timestamp: number }[];
}
const hash = /^0x[0-9a-f]{64}$/, address = /^0x[0-9a-f]{40}$/;
type CanonicalTrade = KolTokenTrade & { blockHash?: string | null };
const same = (left: number, right: number) => Number.isFinite(left) && Number.isFinite(right) && left > 0 && right > 0
  && Math.abs(left - right) <= Math.max(left, right) * 1e-12;
const rawQuantity = (value: string | null, decimals: number): bigint | null => {
  const parts = /^(\d+)(?:\.(\d+))?$/.exec(value ?? '');
  if (!parts || (parts[2]?.length ?? 0) > decimals) return null;
  return BigInt(parts[1] + (parts[2] ?? '').padEnd(decimals, '0'));
};
const units = (value: bigint, decimals: number) => {
  if (!decimals) return String(value);
  const digits = String(value).padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(/\.?0+$/, '');
};

/** Complete provider history may omit authenticated account-abstraction swaps
 * already repaired from canonical receipts. Reconcile that combined swap ledger
 * against a fresh current balance, but publish only a tracked, gas-excluded
 * estimate. No provider transfers or unindexed older cycles may be discarded. */
export function trackedHistoryTokenPnl(activity: KolTokenActivity, history: TrackedProviderHistory,
  proof: KolTokenBalanceProof, now = Date.now()): KolTokenRealizedAccounting | null {
  const wallet = activity.kol.address.toLowerCase(), token = activity.token.address.toLowerCase();
  const decimals = (activity.token as KolTokenActivity['token'] & { decimals?: number | null }).decimals;
  const proofTime = Date.parse(proof.checkedAt), blockTime = Date.parse(proof.blockTimestamp);
  if (!address.test(wallet) || !address.test(token) || !activity.coverage.complete || !history.complete || !history.rows.length
    || history.rows.length > 2000 || !Number.isFinite(history.checkedAt) || history.checkedAt > now || now - history.checkedAt > 30_000
    || !Number.isInteger(decimals) || decimals! < 0 || decimals! > 36 || proof.chain !== 'bsc'
    || proof.walletAddress !== wallet || proof.tokenAddress !== token || !/^\d+$/.test(proof.blockNumber) || !hash.test(proof.blockHash)
    || !Number.isFinite(proofTime) || proofTime > now || now - proofTime > 180_000 || !Number.isFinite(blockTime)
    || blockTime > proofTime || proofTime - blockTime > 180_000 || !activity.trades.length || activity.trades.length > 2000
    || activity.coverage.indexedTradeCount !== activity.trades.length || activity.coverage.returnedTradeCount !== activity.trades.length) return null;
  const balance = rawQuantity(proof.balance, decimals!); if (balance === null) return null;
  const bySwap = new Map<string, CanonicalTrade>(), byBlock = new Map<string, CanonicalTrade[]>(), ids = new Set<string>();
  for (const trade of activity.trades as CanonicalTrade[]) {
    if (!trade.id || ids.has(trade.id) || trade.walletAddress.toLowerCase() !== wallet || trade.tokenAddress.toLowerCase() !== token
      || !['buy', 'sell'].includes(trade.side) || !hash.test(trade.txHash.toLowerCase()) || !['node', 'node+gmgn'].includes(trade.source)
      || trade.valuationStatus !== 'valued' || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trade.amountUsd ?? '')
      || !Number.isFinite(Number(trade.amountUsd)) || Number(trade.amountUsd) <= 0 || !/^\d+$/.test(trade.blockNumber ?? '')
      || !hash.test(trade.blockHash?.toLowerCase() ?? '') || BigInt(trade.blockNumber!) > BigInt(proof.blockNumber)
      || !Number.isFinite(Date.parse(trade.timestamp)) || Date.parse(trade.timestamp) > blockTime
      || trade.transactionIndex != null && (!Number.isSafeInteger(trade.transactionIndex) || trade.transactionIndex < 0)) return null;
    const count = rawQuantity(trade.tokenAmount, decimals!); if (count === null || count <= 0n) return null;
    const key = `${trade.txHash.toLowerCase()}:${trade.side}`;
    if (bySwap.has(key)) return null;
    bySwap.set(key, trade); ids.add(trade.id);
    const group = byBlock.get(trade.blockNumber!) ?? []; group.push(trade); byBlock.set(trade.blockNumber!, group);
  }
  for (const group of byBlock.values()) {
    if (group.length < 2) continue;
    if (new Set(group.map(trade => trade.blockHash!.toLowerCase())).size !== 1 || group.some(trade => trade.transactionIndex == null)
      || new Set(group.map(trade => trade.transactionIndex)).size !== group.length) return null;
  }
  const seen = new Set<string>();
  for (const row of history.rows) {
    if (!['buy', 'sell'].includes(row.kind) || !hash.test(row.tx) || !Number.isSafeInteger(row.timestamp)
      || row.timestamp <= 0 || row.timestamp * 1000 > blockTime) return null;
    const key = `${row.tx}:${row.kind}`, trade = bySwap.get(key);
    if (!trade || seen.has(key) || !same(row.quantity, Number(trade.tokenAmount)) || Math.abs(Date.parse(trade.timestamp) - row.timestamp * 1000) > 1000) return null;
    seen.add(key);
  }
  const ordered = [...activity.trades].sort((a, b) => {
    const height = BigInt(a.blockNumber!) - BigInt(b.blockNumber!);
    return (height < 0n ? -1 : height > 0n ? 1 : 0) || a.transactionIndex! - b.transactionIndex!;
  });
  let held = 0n;
  const events: NonNullable<KolTokenActivity['inventory']>['events'] = [];
  for (const trade of ordered) {
    const quantity = rawQuantity(trade.tokenAmount, decimals!)!;
    held += trade.side === 'buy' ? quantity : -quantity;
    if (held < 0n) return null;
    events.push({ id: trade.id, tradeId: trade.id, kind: trade.side as 'buy' | 'sell', txHash: trade.txHash, timestamp: trade.timestamp,
      blockNumber: trade.blockNumber!, transactionIndex: trade.transactionIndex, logIndex: null, tokenAmount: trade.tokenAmount,
      remainingTokenAmount: units(held, decimals!), remainingCostBasisUsd: null, cumulativeRealizedProfitUsd: null,
      investedUsd: null, soldUsd: null });
  }
  if (held !== balance) return null;
  // Only reuse the FIFO arithmetic internally. This synthetic adapter is never
  // exposed as canonical inventory or a proof of complete historical RPC logs.
  const result = trackedTokenPnl({ ...activity, inventory: { version: 1, events, coverage: {
    complete: true, reconciled: true, status: 'verified', fromBlock: ordered[0].blockNumber,
    toBlock: proof.blockNumber, blockHash: proof.blockHash, checkedAt: proof.checkedAt, balance: proof.balance,
  } } }, now);
  if (!result) return null;
  result.coverage = { transactionsComplete: true, balanceMatched: true, reason: 'onchain_estimate_gas_excluded',
    verification: 'tracked_history', historyCheckedAt: new Date(history.checkedAt).toISOString(), balanceProof: { ...proof },
    historyFingerprint: createHash('sha256').update(JSON.stringify({ wallet, token, rows: history.rows, trades: ordered,
      proof: [proof.blockNumber, proof.blockHash, proof.balance] })).digest('hex'), lastMovementAt: ordered.at(-1)!.timestamp };
  return result;
}
