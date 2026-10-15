import { describe, expect, it } from 'vitest';
import type { KolTokenActivity, KolTokenBalanceProof, KolTokenTrade } from '../shared/kolTokenTrades.js';
import type { GmgnReplayActivity } from './tradeReplayGmgnAccounting.js';
import { buildGmgnAggregatePnl } from './gmgnAggregatePnl.js';

const now = Date.parse('2026-10-16T00:00:00Z'), wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40);
const hash = (id: number) => '0x' + id.toString(16).padStart(64, '0');
const timestamp = (id: number) => Math.floor(now / 1000) - 600 + id * 60;
function fixture() {
  const rows: GmgnReplayActivity[] = [
    { event_type: 'buy', token_amount: '10', cost_usd: '100' },
    { event_type: 'sell', token_amount: '10', cost_usd: '30' },
    { event_type: 'buy', token_amount: '20', cost_usd: '200' },
    { event_type: 'sell', token_amount: '5', cost_usd: '75' },
  ].map((row, index) => ({ wallet, chain: 'bsc', token: { address: token }, tx_hash: hash(index + 1), timestamp: timestamp(index + 1), ...row }));
  const trades: KolTokenTrade[] = rows.slice(2).map((row, index) => ({ id: `trade-${index}`, txHash: String(row.tx_hash), walletAddress: wallet,
    tokenAddress: token, side: row.event_type as 'buy' | 'sell', tokenAmount: String(row.token_amount), quoteSymbol: 'BNB', quoteTokenAddress: null,
    quoteAmount: null, amountUsd: null, priceUsd: null, marketCapUsd: null, timestamp: new Date(Number(row.timestamp) * 1000).toISOString(),
    source: 'node', blockNumber: String(100 + index), transactionIndex: 1, valuationStatus: 'unpriced', realizedProfitUsd: null,
    cumulativeRealizedProfitUsd: null, kolName: null, kolAvatarUrl: null, kolTwitter: null, tokenSymbol: null, tokenName: null, tokenLogoUrl: null }));
  const activity: KolTokenActivity = { kol: { address: wallet, name: null, avatarUrl: null, twitter: null, source: 'node', lastSeenAt: null },
    token: { address: token, name: null, symbol: null, logoUrl: null, priceUsd: null, marketCapUsd: null, marketCapSupply: null }, trades,
    summary: { investedUsd: null, soldUsd: null, realizedProfitUsd: null, avgBoughtPriceUsd: null, avgSoldPriceUsd: null, avgBoughtMcapUsd: null,
      avgSoldMcapUsd: null, remainingTokenAmount: '15', remainingCostBasisUsd: null, buyCount: 1, sellCount: 1, valuedBuyCount: 0, valuedSellCount: 0,
      excludedSellCount: 1, unpricedTradeCount: 2, firstTradeAt: trades[0].timestamp, lastTradeAt: trades[1].timestamp, status: 'open', profitBasis: 'observed_fifo' },
    inventory: { version: 1, coverage: { complete: true, reconciled: true, status: 'verified', fromBlock: '100', toBlock: '200', blockHash: hash(200),
      checkedAt: new Date(now).toISOString(), balance: '15', initialBalanceSource: 'derived_complete_movements' },
      events: trades.map((trade, index) => ({ id: `event-${index}`, tradeId: trade.id, txHash: trade.txHash, kind: trade.side as 'buy' | 'sell',
        timestamp: trade.timestamp, blockNumber: trade.blockNumber!, transactionIndex: 1, logIndex: null, tokenAmount: trade.tokenAmount,
        remainingTokenAmount: index ? '15' : '20', remainingCostBasisUsd: null, cumulativeRealizedProfitUsd: null, investedUsd: null, soldUsd: null })) },
    coverage: { source: 'indexed', indexedTradeCount: 2, returnedTradeCount: 2, complete: true, historyLimit: 2000, costsIncluded: false },
    generatedAt: new Date(now).toISOString() };
  const proof: KolTokenBalanceProof = { chain: 'bsc', walletAddress: wallet, tokenAddress: token, blockNumber: '200', blockHash: hash(200),
    blockTimestamp: new Date(now - 3000).toISOString(), checkedAt: new Date(now).toISOString(), balance: '15' };
  const aggregate: Record<string, unknown> = { address: wallet, balance: 15, usd_value: 225, cost_cur: 150,
    history_bought_cost: 300, history_bought_fee: 5, history_sold_income: 105, history_sold_fee: 3, history_transfer_in_cost: 0,
    history_transfer_out_income: 0, history_transfer_out_fee: 0, history_transfer_in_amount: 0, history_transfer_out_amount: 0,
    current_buy_amount: 20, current_sell_amount: 5, buy_amount_cur: 30, sell_amount_cur: 15, buy_tx_count_cur: 2, sell_tx_count_cur: 2,
    transfer_in_count: 0, transfer_out_count: 0, last_block: 101, last_active_timestamp: timestamp(4), total_cost: 308,
    profit: 22, profit_change: 22 / 308, realized_profit: -53, unrealized_profit: 75 };
  return { activity, rows, aggregate, proof };
}
function build(data: ReturnType<typeof fixture>, historyAt = now, aggregateAt = now) {
  return buildGmgnAggregatePnl(data.activity, data.rows, data.aggregate, data.proof, historyAt, now, aggregateAt);
}

describe('verified full-history GMGN aggregate recovery', () => {
  it('includes losses from a closed cycle before the canonical window and keeps current quote time', () => {
    const data = fixture(), before = structuredClone(data), result = build(data, now - 2000, now - 1000);
    expect(result).toMatchObject({ status: 'ready', realizedProfitUsd: '-53', coverage: { verification: 'gmgn_history', reason: 'gmgn_aggregate_verified',
      historyCheckedAt: new Date(now - 2000).toISOString(), balanceProof: data.proof },
      position: { estimatedProfitUsd: '22', estimatedRoi: String(Number((22 / 308).toPrecision(15))), feeInclusiveCostUsd: '308',
        remainingCostBasisUsd: '150', priceUsd: '15', pricedAt: new Date(now - 1000).toISOString(),
        cashFlow: { investedUsd: '300', soldUsd: '105', transferOutIncomeUsd: '0', feesUsd: '8' } } });
    expect(result).not.toHaveProperty('events'); expect(result).not.toHaveProperty('replayHistory'); expect(data).toEqual(before);
  });

  it.each(['inventory_history_unavailable', 'inventory_rpc_unavailable'])('also reconciles complete provider history for %s', reason => {
    const data = fixture(); Object.assign(data.activity.inventory!.coverage, { complete: false, reconciled: false, status: 'unavailable', reason });
    data.activity.inventory!.events = [];
    expect(build(data)?.position?.estimatedProfitUsd).toBe('22');
  });

  it('preserves CATTO’s observed earlier loss instead of showing only the profitable October cycle', () => {
    const data = fixture();
    const amounts = ['8429716.693067621', '8429716.693067621', '5858334.297546666', '3222083.8636506665'];
    const costs = ['1539.131609746145', '233.04278813395288', '1430.8899583107936', '1470.8762390900422'];
    data.rows.forEach((row, index) => { row.token_amount = amounts[index]; row.cost_usd = costs[index]; });
    data.activity.trades[0].tokenAmount = '5858334.297546666317920453';
    data.activity.trades[1].tokenAmount = '3222083.863650666474856249';
    data.activity.inventory!.events[0].tokenAmount = data.activity.trades[0].tokenAmount;
    data.activity.inventory!.events[1].tokenAmount = data.activity.trades[1].tokenAmount;
    data.activity.inventory!.events[0].remainingTokenAmount = data.activity.trades[0].tokenAmount;
    const balance = '2636250.433895999843064204';
    data.activity.inventory!.events[1].remainingTokenAmount = balance;
    data.activity.inventory!.coverage.balance = balance; data.proof.balance = balance;
    Object.assign(data.aggregate, { balance: 2636250.433896, usd_value: 835.7717668207615, cost_cur: 660.2874703961388,
      history_bought_cost: 2970.0215680569386, history_bought_fee: 75.27290140452456, history_sold_income: 1703.919027223995,
      history_sold_fee: 41.14586561487688, current_buy_amount: 5858334.297546666, buy_amount_cur: 14288050.99061429,
      current_sell_amount: 3222083.8636506665, sell_amount_cur: 11651800.556718288, total_cost: 3086.44033507634,
      profit: -546.7495410315836, profit_change: -0.1771456699868654, realized_profit: -722.2338374562063, unrealized_profit: 175.4842964246227 });
    const result = build(data);
    expect(Number(result?.realizedProfitUsd)).toBeCloseTo(-722.2338374562063, 8);
    expect(Number(result?.position?.estimatedProfitUsd)).toBeCloseTo(-546.7495410315836, 8);
    expect(Number(result?.position?.estimatedRoi)).toBeCloseTo(-0.1771456699868654, 12);
    expect(Number(result?.position?.cashFlow?.feesUsd)).toBeCloseTo(116.41876701940144, 9);
  });

  it('uses the lifetime aggregate for a closed position without requiring a market quote', () => {
    const data = fixture(); data.rows[3].token_amount = '20'; data.rows[3].cost_usd = '300';
    data.activity.trades[1].tokenAmount = '20'; data.activity.inventory!.events[1].tokenAmount = '20';
    data.activity.inventory!.events[1].remainingTokenAmount = '0'; data.activity.inventory!.coverage.balance = '0'; data.proof.balance = '0';
    Object.assign(data.aggregate, { balance: 0, usd_value: 0, cost_cur: 0, history_sold_income: 330, current_sell_amount: 20,
      sell_amount_cur: 30, realized_profit: 22, unrealized_profit: 0 });
    expect(build(data)).toMatchObject({ realizedProfitUsd: '22', position: { status: 'closed', estimatedProfitUsd: '22',
      remainingCostBasisUsd: '0', priceUsd: null, pricedAt: null, valuationSource: null } });
  });

  it('includes marked transfer-out gains and their reported fees', () => {
    const data = fixture(); data.rows[1].event_type = 'transferOut';
    Object.assign(data.aggregate, { history_sold_income: 75, history_transfer_out_income: 30, history_sold_fee: 2,
      history_transfer_out_fee: 1, history_transfer_out_amount: 10, sell_amount_cur: 5, sell_tx_count_cur: 1, transfer_out_count: 1 });
    expect(build(data)).toMatchObject({ realizedProfitUsd: '-53', position: { estimatedProfitUsd: '22',
      cashFlow: { soldUsd: '75', transferOutIncomeUsd: '30', feesUsd: '8' } } });
  });

  it('reconciles a known provider opening balance when the canonical window starts mid-position', () => {
    const data = fixture(); data.rows[1].token_amount = '5';
    data.activity.inventory!.events[0].remainingTokenAmount = '25'; data.activity.inventory!.events[1].remainingTokenAmount = '20';
    data.activity.inventory!.coverage.balance = '20'; data.proof.balance = '20';
    Object.assign(data.aggregate, { balance: 20, usd_value: 300, cost_cur: 200, sell_amount_cur: 10, current_sell_amount: 5,
      profit: 97, profit_change: 97 / 308, realized_profit: -3, unrealized_profit: 100 });
    expect(build(data)).toMatchObject({ realizedProfitUsd: '-3', position: { estimatedProfitUsd: '97', remainingTokenAmount: '20' } });
  });

  it.each(['wrong-wallet', 'wrong-token', 'wrong-chain', 'duplicate', 'missing-row', 'wrong-quantity', 'bad-time', 'future-row', 'extra-current-cycle', 'swap-transfer-overlap',
    'early-incoming', 'indexed-mismatch', 'indexed-time', 'indexed-missing', 'incomplete-index', 'canonical-quantity', 'canonical-opening',
    'canonical-balance', 'canonical-block', 'canonical-hash', 'canonical-stale', 'canonical-window-gap', 'contradictory-inventory', 'pending-inventory'] as const)
    ('rejects %s history evidence without dropping past trades', variant => {
      const data = fixture(), coverage = data.activity.inventory!.coverage;
      if (variant === 'wrong-wallet') data.rows[0].wallet = token;
      if (variant === 'wrong-token') data.rows[0].token = { address: wallet };
      if (variant === 'wrong-chain') data.rows[0].chain = 'eth';
      if (variant === 'duplicate') data.rows.push({ ...data.rows[0] });
      if (variant === 'missing-row') data.rows.shift();
      if (variant === 'wrong-quantity') data.rows[0].token_amount = '9';
      if (variant === 'bad-time') data.rows[0].timestamp = 'invalid';
      if (variant === 'future-row') data.rows[0].timestamp = now / 1000;
      if (variant === 'extra-current-cycle') data.rows[0].timestamp = timestamp(3) + 1;
      if (variant === 'swap-transfer-overlap') { data.rows[1].event_type = 'transferOut'; data.rows[1].tx_hash = data.rows[0].tx_hash; }
      if (variant === 'early-incoming') data.rows[0].token_amount = '11';
      if (variant === 'indexed-mismatch') data.activity.trades[0].tokenAmount = '21';
      if (variant === 'indexed-time') data.activity.trades[0].timestamp = new Date(now).toISOString();
      if (variant === 'indexed-missing') data.activity.trades[0].txHash = hash(999);
      if (variant === 'incomplete-index') data.activity.coverage.complete = false;
      if (variant === 'canonical-quantity') data.activity.inventory!.events[0].tokenAmount = '21';
      if (variant === 'canonical-opening') data.activity.inventory!.events[0].remainingTokenAmount = '21';
      if (variant === 'canonical-balance') coverage.balance = '16';
      if (variant === 'canonical-block') coverage.toBlock = '201';
      if (variant === 'canonical-hash') coverage.blockHash = hash(201);
      if (variant === 'canonical-stale') coverage.checkedAt = new Date(now - 180_001).toISOString();
      if (variant === 'canonical-window-gap') coverage.fromBlock = '99';
      if (variant === 'contradictory-inventory') Object.assign(coverage, { complete: false, reconciled: false, status: 'unavailable', reason: 'movement_balance_unreconciled' });
      if (variant === 'pending-inventory') Object.assign(coverage, { complete: false, reconciled: false, status: 'pending', reason: 'scan_pending' });
      expect(build(data)).toBeNull();
    });

  it.each(['balance', 'count', 'full-quantity', 'gross', 'fees', 'profit', 'roi', 'realized', 'unrealized', 'basis', 'last-block', 'last-time', 'wallet', 'missing-field'] as const)
    ('rejects mismatched %s aggregate rather than trusting a reported profit', variant => {
      const data = fixture(), value = data.aggregate;
      if (variant === 'balance') value.balance = 16;
      if (variant === 'count') value.buy_tx_count_cur = 1;
      if (variant === 'full-quantity') { value.buy_amount_cur = null; value.current_buy_amount = 30; }
      if (variant === 'gross') value.history_bought_cost = 301;
      if (variant === 'fees') value.history_bought_fee = 4;
      if (variant === 'profit') value.profit = 23;
      if (variant === 'roi') value.profit_change = 0.5;
      if (variant === 'realized') value.realized_profit = -52;
      if (variant === 'unrealized') value.unrealized_profit = 76;
      if (variant === 'basis') value.cost_cur = 149;
      if (variant === 'last-block') value.last_block = 100;
      if (variant === 'last-time') value.last_active_timestamp = timestamp(2);
      if (variant === 'wallet') value.address = token;
      if (variant === 'missing-field') delete value.history_transfer_out_fee;
      expect(build(data)).toBeNull();
    });

  it.each(['history-old', 'aggregate-old', 'history-future', 'aggregate-future', 'proof-old', 'proof-future', 'block-old', 'block-future', 'wrong-pair', 'balance'] as const)
    ('rejects %s snapshot proof', variant => {
      const data = fixture(); let historyAt = now, aggregateAt = now;
      if (variant === 'history-old') historyAt -= 30_001;
      if (variant === 'aggregate-old') aggregateAt -= 30_001;
      if (variant === 'history-future') historyAt++;
      if (variant === 'aggregate-future') aggregateAt++;
      if (variant === 'proof-old') data.proof.checkedAt = new Date(now - 180_001).toISOString();
      if (variant === 'proof-future') data.proof.checkedAt = new Date(now + 1).toISOString();
      if (variant === 'block-old') data.proof.blockTimestamp = new Date(now - 180_001).toISOString();
      if (variant === 'block-future') data.proof.blockTimestamp = new Date(now + 1).toISOString();
      if (variant === 'wrong-pair') data.proof.walletAddress = token;
      if (variant === 'balance') data.proof.balance = '16';
      expect(build(data, historyAt, aggregateAt)).toBeNull();
    });
});
