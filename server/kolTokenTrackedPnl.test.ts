import { describe, expect, it } from 'vitest';
import type { KolTokenActivity } from '../shared/kolTokenTrades.js';
import { trackedTokenPnl } from './kolTokenTrackedPnl.js';

const now = Date.parse('2026-10-16T10:00:00Z'), wallet = '0x' + 'a'.repeat(40), token = '0x' + 'b'.repeat(40);
const hash = (id: number) => '0x' + id.toString(16).padStart(64, '0');
function activity(closed = false): KolTokenActivity {
  const trades = ['buy', 'sell'].map((side, i) => ({ id: String(i), txHash: hash(i + 1), walletAddress: wallet, tokenAddress: token,
    side, tokenAmount: i === 0 || closed ? '10' : '4', amountUsd: i === 0 ? '100' : '70', valuationStatus: 'valued', source: 'node',
    blockNumber: String(100 + i), transactionIndex: null, timestamp: new Date(now - 60_000 + i * 1000).toISOString() }));
  return { kol: { address: wallet }, token: { address: token }, trades,
    coverage: { complete: true, indexedTradeCount: 2, returnedTradeCount: 2 },
    inventory: { version: 1, coverage: { complete: true, reconciled: true, status: 'verified', balance: closed ? '0' : '6',
      fromBlock: '100', toBlock: '110', blockHash: hash(110), checkedAt: new Date(now).toISOString() },
      events: trades.map((trade, i) => ({ ...trade, tradeId: trade.id, kind: trade.side, remainingTokenAmount: i === 0 ? '10' : closed ? '0' : '6' })) }
  } as unknown as KolTokenActivity;
}
describe('canonical tracked PNL with explicit gas exclusion', () => {
  it('keeps open-position realized profit and known basis ready for a current mark', () => {
    const input = activity(), before = structuredClone(input), result = trackedTokenPnl(input, now);
    expect(result).toMatchObject({ source: 'onchain', policy: 'onchain_net_trade_profit_v1', status: 'ready', realizedProfitUsd: '30',
      coverage: { reason: 'onchain_estimate_gas_excluded' }, position: { status: 'open', remainingCostBasisUsd: '60',
        estimatedProfitUsd: null, cashFlow: { investedUsd: '100', soldUsd: '70', feesUsd: '0', transferOutIncomeUsd: '0' } } });
    expect(input).toEqual(before);
  });
  it('shows a closed loss without needing a market quote or inventing gas fees', () => {
    expect(trackedTokenPnl(activity(true), now)).toMatchObject({ realizedProfitUsd: '-30', position: {
      status: 'closed', estimatedProfitUsd: '-30', estimatedRoi: '-0.3', remainingCostBasisUsd: '0' } });
  });
  it('supports buy-only open positions', () => {
    const input = activity(); input.trades.pop(); input.inventory!.events.pop();
    input.coverage.indexedTradeCount = input.coverage.returnedTradeCount = 1; input.inventory!.coverage.balance = '10';
    expect(trackedTokenPnl(input, now)).toMatchObject({ realizedProfitUsd: '0', position: { status: 'open', remainingCostBasisUsd: '100' } });
  });
  it.each(['opening', 'balance'])('does not hide tiny unknown %s quantities behind a dollar tolerance', reason => {
    const input = activity(); input.trades.pop(); input.inventory!.events.pop();
    input.coverage.indexedTradeCount = input.coverage.returnedTradeCount = 1;
    input.trades[0].tokenAmount = input.inventory!.events[0].tokenAmount = '0.000000001';
    input.inventory!.events[0].remainingTokenAmount = reason === 'opening' ? '0.000000002' : '0.000000001';
    input.inventory!.coverage.balance = '0.000000002';
    expect(trackedTokenPnl(input, now)).toBeNull();
  });
  it.each(['stale', 'future', 'incomplete', 'reorg', 'balance', 'transfer', 'unpriced', 'shared_quote', 'unknown-opening', 'invalid-block',
    'wrong-wallet', 'wrong-token', 'wrong-event', 'duplicate', 'ambiguous-order'])( 'rejects %s evidence', reason => {
    const input = activity(), proof = input.inventory!.coverage, events = input.inventory!.events;
    if (reason === 'stale') proof.checkedAt = new Date(now - 180001).toISOString();
    if (reason === 'future') proof.checkedAt = new Date(now + 1).toISOString();
    if (reason === 'incomplete') proof.complete = false;
    if (reason === 'reorg') proof.reason = 'inventory_reorg';
    if (reason === 'balance') proof.balance = '5';
    if (reason === 'transfer') events[1].kind = 'transfer_out';
    if (reason === 'unpriced') input.trades[0].amountUsd = null;
    if (reason === 'shared_quote') input.trades[0].valuationStatus = 'shared_quote' as any;
    if (reason === 'unknown-opening') { events[0].kind = 'sell'; input.trades[0].side = 'sell'; }
    if (reason === 'invalid-block') events[0].blockNumber = 'nope';
    if (reason === 'wrong-wallet') input.trades[0].walletAddress = token;
    if (reason === 'wrong-token') input.trades[0].tokenAddress = wallet;
    if (reason === 'wrong-event') events[0].timestamp = new Date(now - 3000).toISOString();
    if (reason === 'duplicate') input.trades[1].id = input.trades[0].id;
    if (reason === 'ambiguous-order') { events[1].blockNumber = events[0].blockNumber; input.trades[1].blockNumber = events[0].blockNumber; }
    expect(trackedTokenPnl(input, now)).toBeNull();
  });
});
