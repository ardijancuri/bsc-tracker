import type { KolTokenActivity } from '../shared/kolTokenTrades';
import type { JournalTokenActivity } from '../shared/journal';
import type { ReplayAccountingSnapshot } from '../shared/tradeReplayAccounting';
import type { ReplayAccounting, ReplayInventory } from './tradeReplayData';
import type { TradeRequestContext } from './tradeRequestContext';

const fields: (keyof ReplayAccountingSnapshot)[] = ['remainingTokenAmount', 'remainingCostBasisUsd', 'cumulativeRealizedProfitUsd',
  'investedUsd', 'soldUsd', 'transferOutIncomeUsd', 'feesUsd', 'feeInclusiveCostUsd'];
const numeric = (raw: unknown) => typeof raw === 'string' && /^-?\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : null;
const quantityKey = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.'); return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`;
};

/** The server owns financial eligibility. The browser checks the immutable
 * contract, account, pair, version and canonical snapshot agreement. */
export function prepareNodeReplay(activity: KolTokenActivity, now: number, context?: TradeRequestContext): { inventory: ReplayInventory; accounting: ReplayAccounting } | undefined {
  const identity = activity.accountingSnapshot, raw = activity.replayAccounting, history = raw?.history, proof = history?.balanceProof;
  const journal = (activity as JournalTokenActivity).journal;
  if (!identity || identity.version !== 2 || !identity.complete || !/^[a-f0-9]{64}$/.test(identity.snapshotId)
    || !['node', 'mixed', 'imported'].includes(identity.source) || !raw || raw.version !== 2 || raw.source !== identity.source
    || raw.policy !== 'kollens_fifo_v1' || !['ready', 'estimated'].includes(raw.status) || !raw.coverage.transactionsComplete || !raw.coverage.balanceMatched
    || raw.walletAddress !== activity.kol.address.toLowerCase() || raw.tokenAddress !== activity.token.address.toLowerCase()
    || !history || !proof || proof.walletAddress !== raw.walletAddress || proof.tokenAddress !== raw.tokenAddress
    || proof.blockNumber !== raw.inventoryBlockNumber || proof.blockHash !== raw.inventoryBlockHash
    || proof.blockNumber !== identity.coveredThroughBlock || !/^0x[0-9a-f]{64}$/i.test(proof.blockHash)
    || !/^\d+$/.test(proof.blockNumber) || proof.chain !== 'bsc' || !Array.isArray(history.events) || history.events.length > 100_000) return;
  if (context ? identity.scope !== 'portfolio' || !journal || !journal.private || journal.accountId !== context.accountId
    || journal.walletAddress !== raw.walletAddress || context.snapshotId && context.snapshotId !== journal.snapshotId
    : identity.scope !== 'public') return;
  const fresh = (timestamp: string) => Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) <= now + 1000 && now - Date.parse(timestamp) <= 180_000;
  if (!fresh(raw.checkedAt) || !fresh(proof.checkedAt) || !fresh(identity.asOf)) return;
  const seen = new Set<string>();
  let last = -Infinity;
  const inventoryEvents: ReplayInventory['events'] = [], events: ReplayAccounting['events'] = [];
  for (const event of history.events) {
    const time = Date.parse(event.timestamp), amount = numeric(event.tokenAmount);
    if (!event.id || seen.has(event.id) || !/^0x[0-9a-f]{64}$/i.test(event.txHash) || !['buy', 'sell', 'transfer_in', 'transfer_out'].includes(event.kind)
      || !Number.isFinite(time) || time < last || time > Date.parse(proof.blockTimestamp) || time > now || amount === null || amount <= 0
      || event.blockNumber != null && (!/^\d+$/.test(event.blockNumber) || BigInt(event.blockNumber) > BigInt(proof.blockNumber))) return;
    const values = Object.fromEntries(fields.map(field => [field, numeric(event[field])])) as { [Key in keyof ReplayAccountingSnapshot]: number | null };
    if (fields.some(field => event[field] !== null && values[field] === null)) return;
    seen.add(event.id); last = time;
    events.push({ ...event, ...values }); inventoryEvents.push({ ...event, ...values, tokenAmount: amount });
  }
  let final: ReplayAccounting['final'] = null;
  if (raw.final) {
    const values = Object.fromEntries(fields.map(field => [field, numeric(raw.final![field])])) as { [Key in keyof ReplayAccountingSnapshot]: number | null };
    const profit = numeric(raw.final.reportedProfitUsd), roi = numeric(raw.final.reportedRoi), price = numeric(raw.final.priceUsd);
    if (fields.some(field => raw.final![field] !== null && values[field] === null) || profit === null || roi === null
      || quantityKey(proof.balance) === null || quantityKey(proof.balance) !== quantityKey(raw.final.remainingTokenAmount) || !fresh(raw.final.timestamp)
      || Date.parse(raw.final.timestamp) < last || values.remainingTokenAmount! > 0 && (price === null || price <= 0)) return;
    final = { ...raw.final, ...values, reportedProfitUsd: profit, reportedRoi: roi, priceUsd: price };
  }
  return { inventory: { version: 1, events: inventoryEvents, coverage: { complete: true, reconciled: true,
    fromBlock: null, toBlock: proof.blockNumber, blockHash: proof.blockHash, checkedAt: proof.checkedAt, balance: proof.balance } },
  accounting: { ...raw, events, final } };
}
