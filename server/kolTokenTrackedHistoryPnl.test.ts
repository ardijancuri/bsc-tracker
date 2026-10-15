import { describe, expect, it } from 'vitest';
import type { KolTokenActivity, KolTokenBalanceProof, KolTokenTrade } from '../shared/kolTokenTrades.js';
import { trackedHistoryTokenPnl, type TrackedProviderHistory } from './kolTokenTrackedHistoryPnl.js';

const now = Date.parse('2026-10-16T00:00:00Z'), wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40);
const h = (value: number) => '0x' + String(value).padStart(64, '0');
function scenario() {
  const trades = [
    { side: 'buy', tokenAmount: '10.123456789123456789', amountUsd: '100' },
    { side: 'sell', tokenAmount: '2.123456789123456789', amountUsd: '30' },
    { side: 'sell', tokenAmount: '8', amountUsd: '90' },
  ].map((value, index) => ({ ...value, id: h(index + 1), txHash: h(index + 1), blockNumber: String(100 + index), blockHash: h(100 + index),
    transactionIndex: index, walletAddress: wallet, tokenAddress: token, source: 'node', valuationStatus: 'valued',
    timestamp: new Date(now - 30_000 + index * 1000).toISOString() })) as (KolTokenTrade & { blockHash: string })[];
  const activity = { kol: { address: wallet }, token: { address: token, decimals: 18 }, trades,
    coverage: { complete: true, indexedTradeCount: 3, returnedTradeCount: 3 },
    inventory: { version: 1, events: [], coverage: { status: 'unavailable', reason: 'inventory_history_unavailable', complete: false, reconciled: false } },
  } as unknown as KolTokenActivity;
  const history: TrackedProviderHistory = { complete: true, checkedAt: now, rows: trades.slice(0, 2).map(trade => ({
    tx: trade.txHash, kind: trade.side, quantity: Number(trade.tokenAmount), timestamp: Date.parse(trade.timestamp) / 1000,
  })) };
  const proof: KolTokenBalanceProof = { chain: 'bsc', walletAddress: wallet, tokenAddress: token, blockNumber: '200', blockHash: h(200),
    balance: '0', checkedAt: new Date(now).toISOString(), blockTimestamp: new Date(now - 3000).toISOString() };
  return { activity, history, proof, trades };
}

describe('tracked PNL with complete GMGN history and repaired canonical swaps', () => {
  it('includes a repaired AA closing sale omitted by GMGN without claiming GMGN accounting or canonical archive coverage', () => {
    const s = scenario(), before = structuredClone(s.activity);
    const value = trackedHistoryTokenPnl(s.activity, s.history, s.proof, now);
    expect(value).toMatchObject({ source: 'onchain', policy: 'onchain_net_trade_profit_v1', status: 'ready', realizedProfitUsd: '20',
      coverage: { verification: 'tracked_history', transactionsComplete: true, balanceMatched: true, reason: 'onchain_estimate_gas_excluded',
        balanceProof: s.proof, historyCheckedAt: new Date(now).toISOString() },
      position: { status: 'closed', remainingTokenAmount: '0', remainingCostBasisUsd: '0', estimatedProfitUsd: '20',
        estimatedRoi: '0.2', cashFlow: { investedUsd: '100', soldUsd: '120', feesUsd: '0', transferOutIncomeUsd: '0' } } });
    expect(value!.coverage.historyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(value!.coverage).not.toHaveProperty('initialBalanceSource'); expect(value).not.toHaveProperty('inventory');
    expect(s.activity).toEqual(before);
  });

  it('retains an open position for later current-price valuation after an omitted partial sale', () => {
    const s = scenario(); s.trades[2].tokenAmount = '4'; s.proof.balance = '4';
    const value = trackedHistoryTokenPnl(s.activity, s.history, s.proof, now);
    expect(value).toMatchObject({ status: 'ready', coverage: { verification: 'tracked_history' },
      position: { status: 'open', remainingTokenAmount: '4', estimatedProfitUsd: null, reason: 'current_quote_unavailable' } });
    expect(Number(value!.position!.remainingCostBasisUsd)).toBeCloseTo(39.5121951183806);
  });

  it('accepts unknown transaction ordinals when distinct canonical block heights prove ordering', () => {
    const s = scenario(); s.trades[0].transactionIndex = null;
    expect(trackedHistoryTokenPnl(s.activity, s.history, s.proof, now)?.realizedProfitUsd).toBe('20');
  });

  it('uses verified transaction ordinals to order swaps in the same block', () => {
    const s = scenario(); s.trades[1].blockNumber = s.trades[0].blockNumber; s.trades[1].blockHash = s.trades[0].blockHash;
    s.activity.trades.reverse();
    expect(trackedHistoryTokenPnl(s.activity, s.history, s.proof, now)?.realizedProfitUsd).toBe('20');
  });

  it.each(['transfer-in', 'transfer-out', 'extra-cycle', 'duplicate-provider', 'mismatched-quantity', 'mismatched-time', 'incomplete-provider', 'stale-provider'])(
    'does not discard or reinterpret %s provider evidence', variant => {
      const s = scenario();
      if (variant === 'transfer-in') s.history.rows.push({ ...s.history.rows[0], tx: h(9), kind: 'transfer_in' });
      if (variant === 'transfer-out') s.history.rows.push({ ...s.history.rows[0], tx: h(9), kind: 'transfer_out' });
      if (variant === 'extra-cycle') s.history.rows.push({ ...s.history.rows[0], tx: h(9) });
      if (variant === 'duplicate-provider') s.history.rows.push({ ...s.history.rows[0] });
      if (variant === 'mismatched-quantity') s.history.rows[0].quantity += 1;
      if (variant === 'mismatched-time') s.history.rows[0].timestamp += 3;
      if (variant === 'incomplete-provider') s.history.complete = false;
      if (variant === 'stale-provider') s.history.checkedAt -= 30_001;
      expect(trackedHistoryTokenPnl(s.activity, s.history, s.proof, now)).toBeNull();
    });

  it.each(['one-wei-mismatch', 'missing-sale', 'stale-proof', 'future-proof', 'wrong-wallet', 'wrong-token', 'wrong-chain', 'proof-before-trade'])(
    'refuses %s rather than guessing current holdings', variant => {
      const s = scenario();
      if (variant === 'one-wei-mismatch') s.proof.balance = '0.000000000000000001';
      if (variant === 'missing-sale') { s.activity.trades.pop(); s.activity.coverage.indexedTradeCount--; s.activity.coverage.returnedTradeCount--; }
      if (variant === 'stale-proof') s.proof.checkedAt = new Date(now - 180_001).toISOString();
      if (variant === 'future-proof') s.proof.checkedAt = new Date(now + 1).toISOString();
      if (variant === 'wrong-wallet') s.proof.walletAddress = token;
      if (variant === 'wrong-token') s.proof.tokenAddress = wallet;
      if (variant === 'wrong-chain') s.proof.chain = 'eth' as 'bsc';
      if (variant === 'proof-before-trade') s.proof.blockTimestamp = new Date(now - 60_000).toISOString();
      expect(trackedHistoryTokenPnl(s.activity, s.history, s.proof, now)).toBeNull();
    });

  it.each(['provider-source', 'unknown-cost', 'missing-hash', 'unknown-opening-cost', 'duplicate-id', 'incomplete-index',
    'same-block-no-ordinal', 'same-block-same-ordinal', 'same-block-different-hash', 'fractional-ordinal'])(
    'rejects %s indexed evidence', variant => {
      const s = scenario();
      if (variant === 'provider-source') s.trades[2].source = 'gmgn';
      if (variant === 'unknown-cost') s.trades[2].amountUsd = null;
      if (variant === 'missing-hash') s.trades[2].blockHash = '';
      if (variant === 'unknown-opening-cost') { s.trades[0].side = 'sell'; s.history.rows[0].kind = 'sell'; }
      if (variant === 'duplicate-id') s.trades[2].id = s.trades[0].id;
      if (variant === 'incomplete-index') s.activity.coverage.complete = false;
      if (variant.startsWith('same-block')) {
        s.trades[1].blockNumber = s.trades[0].blockNumber;
        if (variant !== 'same-block-different-hash') s.trades[1].blockHash = s.trades[0].blockHash;
        if (variant === 'same-block-no-ordinal') s.trades[0].transactionIndex = null;
        if (variant === 'same-block-same-ordinal') s.trades[1].transactionIndex = s.trades[0].transactionIndex;
      }
      if (variant === 'fractional-ordinal') s.trades[2].transactionIndex = 1.5;
      expect(trackedHistoryTokenPnl(s.activity, s.history, s.proof, now)).toBeNull();
    });
});
