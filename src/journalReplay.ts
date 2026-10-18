import type { JournalTokenActivity } from '../shared/journal';
import type { KolTokenActivity } from '../shared/kolTokenTrades';
import type { ReplayAccountingSnapshot } from '../shared/tradeReplayAccounting';
import type { ReplayAccounting, ReplayInventory } from './tradeReplayData';
import type { TradeRequestContext } from './tradeRequestContext';

const fields: (keyof ReplayAccountingSnapshot)[] = ['remainingTokenAmount', 'remainingCostBasisUsd', 'cumulativeRealizedProfitUsd', 'investedUsd', 'soldUsd', 'transferOutIncomeUsd', 'feesUsd', 'feeInclusiveCostUsd'];
const exactQuantity = (raw: unknown) => {
  if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`;
};
const decimal = (raw: unknown, signed = false) => {
  if (typeof raw !== 'string' || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)) return null;
  const value = Number(raw); return Number.isFinite(value) && (signed || value >= 0) ? value : null;
};

export function journalTokenProfit(activity: KolTokenActivity | null, context: TradeRequestContext, now = Date.now()) {
  if (!activity || !prepareJournalReplay(activity, now, context)) return null;
  const position = activity.realizedAccounting?.position;
  return position?.status === 'open' ? decimal(position.estimatedProfitUsd, true) : decimal(activity.realizedAccounting?.realizedProfitUsd, true);
}

/** Eligibility is decided by the authenticated journal service. This adapter
 * validates the frozen contract without inventing block positions for recovery data. */
export function prepareJournalReplay(activity: KolTokenActivity, now: number, context?: TradeRequestContext): { inventory: ReplayInventory; accounting: ReplayAccounting } | undefined {
  if (!context || context.kind !== 'journal') return;
  const journal = (activity as JournalTokenActivity).journal, raw = activity.replayAccounting, history = raw?.history, proof = history?.balanceProof;
  const fresh = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 1000 && now - Date.parse(value) <= 180_000;
  if (!journal || journal.accountId !== context.accountId || journal.private !== true || !/^[a-f0-9]{64}$/.test(journal.snapshotId ?? '')
    || context.snapshotId && context.snapshotId !== journal.snapshotId
    || !/^[a-f0-9-]{36}$/i.test(journal.membershipRevision) || journal.walletAddress !== activity.kol.address.toLowerCase()
    || !fresh(journal.preparedAt) || !raw || !proof || !history || !fresh(raw.checkedAt) || !fresh(history.checkedAt)
    || raw.version !== 1 || raw.source !== 'gmgn' || raw.policy !== 'gmgn_total_profit_v1'
    || !['ready', 'estimated'].includes(raw.status) || !raw.coverage.transactionsComplete || !raw.coverage.balanceMatched
    || raw.walletAddress !== journal.walletAddress || raw.tokenAddress !== activity.token.address.toLowerCase()
    || proof.walletAddress !== raw.walletAddress || proof.tokenAddress !== raw.tokenAddress || proof.chain !== 'bsc'
    || !fresh(proof.checkedAt) || !fresh(proof.blockTimestamp) || !/^\d+$/.test(proof.blockNumber)
    || !/^0x[\da-f]{64}$/i.test(proof.blockHash) || raw.inventoryBlockNumber !== proof.blockNumber || raw.inventoryBlockHash !== proof.blockHash
    || !Array.isArray(history.events) || !history.events.length || history.events.length > 10000) return;
  const balance = decimal(proof.balance); if (balance === null) return;
  const events: ReplayAccounting['events'] = [], inventoryEvents: ReplayInventory['events'] = [], seen = new Set<string>();
  let previous = -Infinity;
  for (const event of history.events) {
    const time = Date.parse(event.timestamp), amount = decimal(event.tokenAmount);
    if (!event.id || seen.has(event.id) || !/^0x[\da-f]{64}$/i.test(event.txHash) || !['buy', 'sell', 'transfer_in', 'transfer_out'].includes(event.kind)
    || !Number.isFinite(time) || time > now || time < previous || time > Date.parse(proof.blockTimestamp) || amount === null || amount <= 0
      || event.blockNumber !== null && (!/^\d+$/.test(event.blockNumber) || BigInt(event.blockNumber) > BigInt(proof.blockNumber))) return;
    const values = {} as { [Key in keyof ReplayAccountingSnapshot]: number | null };
    for (const field of fields) {
      values[field] = decimal(event[field], field === 'cumulativeRealizedProfitUsd');
      if (event[field] !== null && values[field] === null) return;
    }
    if (values.remainingTokenAmount === null) return;
    seen.add(event.id); previous = time;
    events.push({ ...event, ...values }); inventoryEvents.push({ ...event, ...values, tokenAmount: amount });
  }
  const ending = events.at(-1)!.remainingTokenAmount;
  if (ending === null || exactQuantity(proof.balance) === null || exactQuantity(history.events.at(-1)?.remainingTokenAmount) !== exactQuantity(proof.balance)) return;
  let final: ReplayAccounting['final'] = null;
  if (raw.final) {
    const values = Object.fromEntries(fields.map(field => [field, decimal(raw.final![field], field === 'cumulativeRealizedProfitUsd')])) as { [Key in keyof ReplayAccountingSnapshot]: number | null };
    const profit = decimal(raw.final.reportedProfitUsd, true), roi = decimal(raw.final.reportedRoi, true), price = decimal(raw.final.priceUsd);
    if (exactQuantity(raw.final.remainingTokenAmount) !== exactQuantity(proof.balance) || !fresh(raw.final.timestamp) || profit === null || roi === null || values.feeInclusiveCostUsd === null || values.feeInclusiveCostUsd <= 0
      || values.soldUsd === null || values.transferOutIncomeUsd === null || balance > 0 && (price === null || price <= 0)) return;
    const expected = values.soldUsd + values.transferOutIncomeUsd + balance * (price ?? 0) - values.feeInclusiveCostUsd;
    if (Math.abs(expected - profit) > Math.max(1e-8, Math.abs(expected) * 1e-10)) return;
    final = { ...raw.final, ...values, reportedProfitUsd: profit, reportedRoi: roi, priceUsd: price };
  }
  return { inventory: { version: 1, events: inventoryEvents, coverage: { complete: true, reconciled: true, verification: 'gmgn_history',
    fromBlock: null, toBlock: proof.blockNumber, blockHash: proof.blockHash, balance: proof.balance, checkedAt: proof.checkedAt,
    initialBalanceSource: null, reason: 'journal_reconciled_history' } }, accounting: { ...raw, events, final,
      coverage: { ...raw.coverage, exactFinal: false, journalFinal: final !== null } } };
}
