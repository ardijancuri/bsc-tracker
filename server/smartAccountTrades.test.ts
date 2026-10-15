import { readFileSync } from 'node:fs';
import { id } from 'ethers';
import { describe, expect, it } from 'vitest';
import { beforeExecutionTopic, transactionWallets, userOperationTopic, walletTransactionContext } from './smartAccountTrades.js';
import { hasRecognizedSwap, nativeSellProceeds, walletSwapFlows } from './swap.js';
import { verifiedTradeRepair } from './verifiedTradeRepair.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/smartAccountSale.json', import.meta.url), 'utf8'));
const { tx, receipt, wallet, token, block } = fixture;
const indexed = (address: string) => '0x' + address.slice(2).padStart(64, '0');
const other = '0x' + '3'.repeat(40), amount = 7756869718250679382671672n;
const hint = { txHash: tx.hash, walletAddress: wallet, tokenAddress: token, blockNumber: String(BigInt(tx.blockNumber)), blockHash: block.hash };

describe('authenticated smart-account swap attribution', () => {
  it('uses the canonical ERC-4337 event signatures', () => {
    expect(id('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')).toBe(userOperationTopic);
    expect(id('BeforeExecution()')).toBe(beforeExecutionTopic);
  });
  it('finds the actual wallet and net native payout in the previously omitted AA sale', () => {
    expect(transactionWallets(tx, receipt)).toEqual([wallet]);
    expect(walletTransactionContext(tx, receipt, tx.from)).toBeNull();
    const context = walletTransactionContext(tx, receipt, wallet)!;
    expect(context.nativeValue).toBe(0n); expect(context.router).toBeNull();
    expect(hasRecognizedSwap(context.logs)).toBe(true);
    expect([...walletSwapFlows(wallet, context.nativeValue, context.logs)]).toEqual([[token, -amount]]);
    expect(nativeSellProceeds(wallet, amount, context.logs, context.router, token)).toBe(62060813161377537n);
  });
  it('never attributes bundler-funded transaction value or validation transfers to the wallet', () => {
    const changed = structuredClone(receipt), validation = structuredClone(receipt.logs[1]);
    validation.data = '0x' + '1'.padStart(64, '0'); changed.logs.unshift(validation);
    const context = walletTransactionContext({ ...tx, value: '0x123456789' }, changed, wallet)!;
    expect(context.nativeValue).toBe(0n); expect(context.logs).not.toContain(validation);
    expect(walletSwapFlows(wallet, context.nativeValue, context.logs).get(token)).toBe(-amount);
  });
  it.each(['failed-receipt', 'failed-op', 'fake-entrypoint', 'fake-event', 'missing-boundary', 'malformed-event', 'removed-log', 'paymaster-fees'])(
    'rejects unauthenticated or ambiguous %s evidence', scenario => {
      const changed = structuredClone(receipt), transaction = { ...tx };
      const event = changed.logs.at(-1)!;
      if (scenario === 'failed-receipt') changed.status = '0x0';
      if (scenario === 'failed-op') event.data = event.data.slice(0, 66) + '0'.repeat(64) + event.data.slice(130);
      if (scenario === 'fake-entrypoint') transaction.to = other;
      if (scenario === 'fake-event') event.address = other;
      if (scenario === 'missing-boundary') changed.logs.shift();
      if (scenario === 'malformed-event') event.topics[2] = '0x' + 'f'.repeat(24) + wallet.slice(2);
      if (scenario === 'removed-log') changed.logs[1].removed = true;
      if (scenario === 'paymaster-fees') event.topics[3] = indexed(other);
      expect(walletTransactionContext(transaction, changed, wallet)).toBeNull();
    });
  it('separates different operations and refuses to net multiple operations from one wallet', () => {
    const firstOp = structuredClone(receipt.logs.slice(1)), secondOp = structuredClone(receipt.logs.slice(1));
    for (const log of secondOp) {
      log.topics = log.topics.map((topic: string) => topic === indexed(wallet) ? indexed(other) : topic);
      log.data = log.data.replaceAll(wallet.slice(2), other.slice(2));
    }
    const bundle = { ...receipt, logs: [receipt.logs[0], ...firstOp, ...secondOp] };
    expect(transactionWallets(tx, bundle)).toEqual([wallet, other]);
    const context = walletTransactionContext(tx, bundle, wallet)!;
    expect(context.logs).toEqual(firstOp.slice(0, -1));
    expect(context.logs).not.toContain(secondOp[0]);
    expect(transactionWallets(tx, { ...receipt, logs: [receipt.logs[0], ...firstOp, ...firstOp] })).toEqual([]);
  });
  it('preserves direct-wallet transaction attribution without accepting another wallet', () => {
    const direct = { ...tx, from: wallet, to: other, value: '0x10' };
    expect(walletTransactionContext(direct, receipt, wallet)).toEqual({ logs: receipt.logs, nativeValue: 16n, router: other });
    expect(walletTransactionContext(direct, receipt, tx.from)).toBeNull();
  });
  it.each(['wrong-recipient', 'wrong-sender', 'wrong-token', 'nonnative', 'wrong-amount', 'duplicate', 'wrong-router'])(
    'refuses misleading Kyber payout evidence for %s', scenario => {
      const logs = structuredClone(receipt.logs), swap = logs.find((log: any) => log.address === '0x6131b5fae19ea4f9d964eac0408e4408b66337b5');
      const words = swap.data.slice(2).match(/.{64}/g)!;
      if (scenario === 'wrong-recipient') words[3] = other.slice(2).padStart(64, '0');
      if (scenario === 'wrong-sender') words[0] = other.slice(2).padStart(64, '0');
      if (scenario === 'wrong-token') words[1] = other.slice(2).padStart(64, '0');
      if (scenario === 'nonnative') words[2] = other.slice(2).padStart(64, '0');
      if (scenario === 'wrong-amount') words[4] = '1'.padStart(64, '0');
      if (scenario === 'wrong-router') swap.address = other;
      swap.data = '0x' + words.join('');
      if (scenario === 'duplicate') logs.push(swap);
      expect(nativeSellProceeds(wallet, amount, logs, null, token)).toBeNull();
    });
});

describe('canonical repair verification', () => {
  it('allows a confirmed missing token trade only for the authenticated account', () => {
    expect(verifiedTradeRepair(hint, tx, receipt, block, Number(BigInt(block.number)) + 6)).toBe(true);
    expect(verifiedTradeRepair({ ...hint, walletAddress: tx.from }, tx, receipt, block, Number(BigInt(block.number)) + 6)).toBe(false);
    expect(verifiedTradeRepair({ ...hint, tokenAddress: other }, tx, receipt, block, Number(BigInt(block.number)) + 6)).toBe(false);
  });
  it.each(['unconfirmed', 'reorg', 'receipt-hash', 'tx-block', 'receipt-block', 'removed', 'wrong-log-hash'])(
    'rejects %s hints without authorizing an indexed trade', scenario => {
      const transaction = structuredClone(tx), evidence = structuredClone(receipt), canonical = { ...block };
      let head = Number(BigInt(block.number)) + 6;
      if (scenario === 'unconfirmed') head -= 1;
      if (scenario === 'reorg') canonical.hash = '0x' + '3'.repeat(64);
      if (scenario === 'receipt-hash') evidence.transactionHash = '0x' + '3'.repeat(64);
      if (scenario === 'tx-block') transaction.blockHash = '0x' + '3'.repeat(64);
      if (scenario === 'receipt-block') evidence.blockNumber = '0x1';
      if (scenario === 'removed') evidence.logs[1].removed = true;
      if (scenario === 'wrong-log-hash') evidence.logs[1].transactionHash = '0x' + '3'.repeat(64);
      expect(verifiedTradeRepair(hint, transaction, evidence, canonical, head)).toBe(false);
    });
});
