import { describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import { freshTransferValuationOnly, canCompleteFreshUntradedTransfers, type FreshDecodedReceipt } from './decode.js';
import { applyFreshEvent, summarizeFreshPosition } from './accounting.js';
import { infinityMarketAbi, v3MarketAbi } from '../nodeMarketProtocols.js';
import type { FreshCapturedReceipt, FreshLog } from './capture.js';
import type { FreshFinancialEvent, FreshScope } from '../../shared/freshAccounting.js';

const address = (digit: string) => `0x${digit.repeat(40)}`, hash = (digit: string) => `0x${digit.repeat(64)}`;
const wallet = address('1'), other = address('2'), token = address('7'), secondToken = address('8');
const timestamp = '2026-10-22T22:30:00.000Z', blockHash = hash('a'), txHash = hash('b');
function event(overrides: Partial<FreshFinancialEvent> = {}): FreshFinancialEvent {
  return { id: 'incoming', executionKey: 'execution:incoming', walletAddress: wallet, tokenAddress: token, kind: 'transfer_in',
    quantity: '10', amountUsd: null, feeUsd: '0', feeKey: 'fee:incoming', counterparty: other, transferKey: 'transfer:incoming',
    blockNumber: '101', blockHash, transactionHash: txHash, transactionIndex: 0, executionIndex: 0, logIndex: 0,
    occurredAt: timestamp, canonical: true, ...overrides };
}
function decoded(overrides: Partial<FreshDecodedReceipt> = {}): FreshDecodedReceipt {
  return { events: [event()], reasons: ['incoming_transfer_cost_unknown'], executions: 1,
    tokens: [{ address: token, name: 'Untraded', symbol: 'DROP', decimals: 18, supplyRaw: null,
      block: { number: 101, hash: blockHash, timestamp } }], ...overrides };
}
function entry(logs: FreshLog[] = []): FreshCapturedReceipt {
  return { transaction: { hash: txHash, from: other, to: wallet, value: '0x0', blockNumber: '0x65', blockHash, transactionIndex: '0x0', gasPrice: '0x1' },
    receipt: { transactionHash: txHash, transactionIndex: '0x0', blockNumber: '0x65', blockHash, status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs },
    wallets: [wallet], observedAt: timestamp };
}
function database(hasTrade: unknown = false) {
  const query = vi.fn(async () => ({ rows: [{ has_trade: hasTrade }] }));
  return { query };
}

describe('untraded transfer movement and valuation separation', () => {
  it('accepts authenticated incoming and outgoing value-only gaps without changing null amounts', () => {
    const incoming = decoded(), before = structuredClone(incoming);
    expect(freshTransferValuationOnly(incoming, entry())).toBe(true);
    expect(incoming).toEqual(before);
    expect(freshTransferValuationOnly(decoded({ events: [event({ kind: 'transfer_out' })], reasons: ['outgoing_transfer_value_unknown'] }))).toBe(true);
    const both = decoded({ events: [event(), event({ id: 'outgoing', kind: 'transfer_out', logIndex: 1, transferKey: 'transfer:outgoing' })],
      reasons: ['incoming_transfer_cost_unknown', 'outgoing_transfer_value_unknown'] });
    expect(freshTransferValuationOnly(both)).toBe(true);
  });

  it.each(['wallet_fee_valuation_unavailable', 'trade_value_unavailable', 'token_decimals_unavailable',
    'native_payment_receipt_mismatch', 'factory_launch_unverified', 'operation_fee_allocation_unknown'])('keeps %s blocking', reason => {
    const value = decoded(); value.reasons.push(reason);
    expect(freshTransferValuationOnly(value)).toBe(false);
  });

  it('requires a real unresolved value and the matching transfer warning', () => {
    expect(freshTransferValuationOnly(decoded({ reasons: [] }))).toBe(false);
    expect(freshTransferValuationOnly(decoded({ events: [] }))).toBe(false);
    expect(freshTransferValuationOnly(decoded({ events: [event({ amountUsd: '1' })] }))).toBe(false);
    expect(freshTransferValuationOnly(decoded({ reasons: ['outgoing_transfer_value_unknown'] }))).toBe(false);
  });

  it.each(['buy', 'sell', 'fee'] as const)('does not exempt a mixed receipt containing %s', kind => {
    expect(freshTransferValuationOnly(decoded({ events: [event(), event({ id: 'mixed', kind, amountUsd: '1', quantity: kind === 'fee' ? '0' : '1' })] }))).toBe(false);
  });

  it.each([
    { quantity: '0' }, { quantity: '-1' }, { quantity: 'invalid' }, { feeUsd: null }, { feeUsd: '-1' }, { feeUsd: 'invalid' },
    { amountUsd: '-1' }, { canonical: false }, { logIndex: null }, { transferKey: null }, { tokenAddress: null },
  ] as Partial<FreshFinancialEvent>[])('retains malformed or incomplete movement evidence: %j', change => {
    expect(freshTransferValuationOnly(decoded({ events: [event(change)] }))).toBe(false);
  });

  it('requires matching verified token precision, including the original block identity', () => {
    expect(freshTransferValuationOnly(decoded({ tokens: [] }))).toBe(false);
    const wrongToken = decoded(); wrongToken.tokens[0].address = secondToken;
    expect(freshTransferValuationOnly(wrongToken)).toBe(false);
    for (const decimals of [-1, 256, 1.5, NaN]) {
      const value = decoded(); value.tokens[0].decimals = decimals;
      expect(freshTransferValuationOnly(value)).toBe(false);
    }
    const wrongBlock = decoded(); wrongBlock.tokens[0].block.hash = hash('f');
    expect(freshTransferValuationOnly(wrongBlock)).toBe(false);
    const wrongHeight = decoded(); wrongHeight.tokens[0].block.number = 102;
    expect(freshTransferValuationOnly(wrongHeight)).toBe(false);
  });

  it('keeps a failed receipt and any recognized swap blocking', () => {
    const failed = entry(); failed.receipt.status = '0x0';
    expect(freshTransferValuationOnly(decoded(), failed)).toBe(false);
    const v2 = new Interface(['event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
    for (const topic of [v2.getEvent('Swap')!.topicHash, v3MarketAbi.getEvent('Swap')!.topicHash, infinityMarketAbi.getEvent('Swap')!.topicHash]) {
      const swap: FreshLog = { address: other, topics: [topic], data: '0x', logIndex: '0x1', transactionHash: txHash,
        transactionIndex: '0x0', blockNumber: '0x65', blockHash };
      expect(freshTransferValuationOnly(decoded(), entry([swap]))).toBe(false);
    }
  });

  it('checks canonical history and shared-scope trades before completing movement decoding', async () => {
    const untraded = database(false);
    await expect(canCompleteFreshUntradedTransfers(untraded as any, decoded())).resolves.toBe(true);
    expect(untraded.query).toHaveBeenCalledTimes(1);
    // The history predicate also covers a different wallet trading this token
    // inside the same combined Portfolio book.
    await expect(canCompleteFreshUntradedTransfers(database(true) as any, decoded())).resolves.toBe(false);
    await expect(canCompleteFreshUntradedTransfers(database(null) as any, decoded())).resolves.toBe(false);
    await expect(canCompleteFreshUntradedTransfers(database('false') as any, decoded())).resolves.toBe(false);
  });

  it.each(['buy', 'sell'] as const)('keeps a same-wallet/token %s anywhere in the selected batch blocking before querying history', async kind => {
    const db = database(false), later = event({ id: 'later', kind, amountUsd: '20', blockNumber: '999' });
    await expect(canCompleteFreshUntradedTransfers(db as any, decoded(), [later])).resolves.toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('does not import unrelated wallets, tokens or orphan trades into the affected book', async () => {
    const batch = [event({ id: 'other-wallet', walletAddress: other, kind: 'buy', amountUsd: '1' }),
      event({ id: 'other-token', tokenAddress: secondToken, kind: 'sell', amountUsd: '1' }),
      event({ id: 'orphan', kind: 'buy', amountUsd: '1', canonical: false })];
    await expect(canCompleteFreshUntradedTransfers(database(false) as any, decoded(), batch)).resolves.toBe(true);
    await expect(canCompleteFreshUntradedTransfers(database(true) as any, decoded(), batch)).resolves.toBe(false);
  });

  it('never clears unknown acquisition basis when the token later becomes traded', () => {
    const scope: FreshScope = { id: `kol:${wallet}`, kind: 'kol', walletAddresses: [wallet], accountId: null,
      startsAt: '2026-10-22T00:00:00.000Z', startsBlock: '100', revision: '1' };
    const incoming = applyFreshEvent(scope, event(), { position: null, lots: [] });
    expect(incoming.result).toMatchObject({ realizedQ: '0', tradeCount: 0, volumeQ: '0', tokensTrade: false });
    expect(incoming.lots[0].costQ).toBeNull();
    expect(summarizeFreshPosition(incoming.position!, incoming.lots, null)).toMatchObject({ incomingTransferCostUsd: null, remainingCostUsd: null, status: 'unknown_costs' });
    const sold = applyFreshEvent(scope, event({ id: 'sold', executionKey: 'execution:sold', kind: 'sell', amountUsd: '20',
      feeKey: 'fee:sold', blockNumber: '102', transferKey: null, occurredAt: '2026-10-22T22:31:00.000Z' }), incoming);
    expect(sold.result.realizedQ).toBeNull();
    expect(summarizeFreshPosition(sold.position!, sold.lots, null)).toMatchObject({ quantity: '0', realizedProfitUsd: null, estimatedProfitUsd: null, status: 'unknown_costs' });
    expect(incoming.lots[0].costQ).toBeNull();
  });
});
