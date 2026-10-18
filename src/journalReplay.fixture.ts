import type { JournalTokenActivity } from '../shared/journal';
import type { ReplayAccountingSnapshot } from '../shared/tradeReplayAccounting';
import type { TradeRequestContext } from './tradeRequestContext';

/** Synthetic identities and amounts only; useful for regression and local MP4 inspection. */
export function journalReplayFixture(inputTime = Date.now()) {
  const now = Math.floor(inputTime / 1000) * 1000, iso = (seconds = 0) => new Date(now + seconds * 1000).toISOString();
  const wallet = `0x${'1'.repeat(40)}`, token = `0x${'2'.repeat(40)}`, blockHash = `0x${'f'.repeat(64)}`;
  const context: TradeRequestContext = { kind: 'journal', accountId: '11111111-1111-4111-8111-111111111111', snapshotId: 'a'.repeat(64) };
  const rows = [
    { id: 'journal-buy', kind: 'buy' as const, tokenAmount: '100', seconds: -720, hash: 'a',
      remainingTokenAmount: '100', remainingCostBasisUsd: '101', cumulativeRealizedProfitUsd: '0', investedUsd: '100', soldUsd: '0', transferOutIncomeUsd: '0', feesUsd: '1', feeInclusiveCostUsd: '101' },
    { id: 'journal-sell', kind: 'sell' as const, tokenAmount: '40', seconds: -360, hash: 'b',
      remainingTokenAmount: '60', remainingCostBasisUsd: '60.6', cumulativeRealizedProfitUsd: '37.6', investedUsd: '100', soldUsd: '80', transferOutIncomeUsd: '0', feesUsd: '3', feeInclusiveCostUsd: '103' },
    { id: 'journal-out', kind: 'transfer_out' as const, tokenAmount: '20', seconds: -180, hash: 'c',
      remainingTokenAmount: '40', remainingCostBasisUsd: '40.4', cumulativeRealizedProfitUsd: '66.9', investedUsd: '100', soldUsd: '80', transferOutIncomeUsd: '50', feesUsd: '3.5', feeInclusiveCostUsd: '103.5' },
  ];
  const history = rows.map(({ seconds, hash, ...row }) => ({ ...row, txHash: `0x${hash.repeat(64)}`, timestamp: iso(seconds), blockNumber: null, transactionIndex: null, logIndex: null }));
  const final: ReplayAccountingSnapshot & { timestamp: string; reportedProfitUsd: string; reportedRoi: string; priceUsd: string } = {
    remainingTokenAmount: '40', remainingCostBasisUsd: '40.4', cumulativeRealizedProfitUsd: '66.9', investedUsd: '100', soldUsd: '80',
    transferOutIncomeUsd: '50', feesUsd: '3.5', feeInclusiveCostUsd: '103.5', timestamp: iso(), reportedProfitUsd: '186.5', reportedRoi: String(186.5 / 101), priceUsd: '4',
  };
  const proof = { walletAddress: wallet, tokenAddress: token, chain: 'bsc' as const, blockNumber: '1000', blockHash, blockTimestamp: iso(), balance: '40', checkedAt: iso() };
  const activity: JournalTokenActivity = {
    journal: { accountId: context.accountId, walletAddress: wallet, membershipRevision: '22222222-2222-4222-8222-222222222222', preparedAt: iso(), private: true, snapshotId: context.snapshotId },
    kol: { address: wallet, name: 'Wallet 0x1111…1111', avatarUrl: null, twitter: null, source: 'node', lastSeenAt: iso(-180) },
    token: { address: token, symbol: 'DEMO', name: 'Journal replay demo', logoUrl: null, priceUsd: '4', marketCapUsd: '40000', marketCapSupply: '10000' },
    trades: rows.filter(row => row.kind !== 'transfer_out').map((row, index) => ({
      id: row.id, walletAddress: wallet, tokenAddress: token, kolName: 'Wallet 0x1111…1111', kolAvatarUrl: null, kolTwitter: null,
      tokenSymbol: 'DEMO', tokenName: 'Journal replay demo', tokenLogoUrl: null, side: row.kind as 'buy' | 'sell',
      txHash: `0x${row.hash.repeat(64)}`, timestamp: iso(row.seconds), blockNumber: String(100 + index), transactionIndex: 0,
      tokenAmount: row.tokenAmount, quoteSymbol: 'BNB', quoteAmount: null, amountUsd: index ? '80' : '100', priceUsd: index ? '2' : '1', marketCapUsd: index ? '20000' : '10000',
      source: 'node' as const, valuationStatus: 'valued' as const, realizedProfitUsd: index ? '37.6' : null, cumulativeRealizedProfitUsd: row.cumulativeRealizedProfitUsd,
    })),
    summary: { buyCount: 1, sellCount: 1, investedUsd: '100', soldUsd: '80', realizedProfitUsd: '66.9', avgBoughtPriceUsd: '1', avgSoldPriceUsd: '2', avgBoughtMcapUsd: '10000', avgSoldMcapUsd: '20000', firstTradeAt: iso(-720), lastTradeAt: iso(-360), valuedBuyCount: 1, valuedSellCount: 1, excludedSellCount: 0, unpricedTradeCount: 0, remainingTokenAmount: '40', remainingCostBasisUsd: '40.4', status: 'open', profitBasis: 'observed_fifo' },
    coverage: { source: 'indexed', indexedTradeCount: 2, returnedTradeCount: 2, complete: true, historyLimit: 2000, costsIncluded: false }, generatedAt: iso(),
    replayAccounting: { version: 1, source: 'gmgn', policy: 'gmgn_total_profit_v1', walletAddress: wallet, tokenAddress: token,
      status: 'estimated', checkedAt: iso(), inventoryBlockNumber: '1000', inventoryBlockHash: blockHash,
      coverage: { transactionsComplete: true, balanceMatched: true, exactFinal: false, reason: 'journal_gmgn_accounting' }, events: [], final,
      history: { fingerprint: 'b'.repeat(64), checkedAt: iso(), balanceProof: proof, events: history } },
    realizedAccounting: { version: 1, source: 'gmgn', policy: 'gmgn_realized_profit_v1', walletAddress: wallet, tokenAddress: token, status: 'ready', checkedAt: iso(), realizedProfitUsd: '66.9',
      coverage: { transactionsComplete: true, balanceMatched: true, verification: 'gmgn_history', historyFingerprint: 'b'.repeat(64), historyCheckedAt: iso(), lastMovementAt: iso(-180), balanceProof: proof },
      position: { status: 'open', estimatedProfitUsd: final.reportedProfitUsd, estimatedRoi: final.reportedRoi, unrealizedProfitUsd: '119.6', remainingTokenAmount: '40', remainingCostBasisUsd: '40.4', feeInclusiveCostUsd: '101',
        cashFlow: { investedUsd: '100', soldUsd: '80', transferOutIncomeUsd: '50', feesUsd: '3.5' }, priceUsd: '4', pricedAt: iso(), valuationSource: 'market' } },
  };
  return { activity, context, now,
    chartPoints: Array.from({ length: 31 }, (_, index) => { const fraction = index / 30; const priceUsd = 1 + fraction * 3 + Math.sin(index / 2) * .12; return { timestamp: iso(-900 + index * 30), priceUsd, marketCapUsd: priceUsd * 10000 }; }),
  };
}
