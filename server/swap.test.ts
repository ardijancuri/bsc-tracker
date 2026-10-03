import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { nativeSellProceeds, swapTopics, transferTopic, walletSwapFlows, type TransferLog } from './swap.js';

const wallet = '0x1111111111111111111111111111111111111111';
const router = '0x2222222222222222222222222222222222222222';
const tokenA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const tokenB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const indexed = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const transfer = (token: string, from: string, to: string, amount: bigint): TransferLog => ({ address: token, topics: [transferTopic, indexed(from), indexed(to)], data: `0x${amount.toString(16).padStart(64, '0')}` });
const swap = (topic: string): TransferLog => ({ address: router, topics: [topic], data: '0x' });

describe('wallet swap classification', () => {
  it('uses the canonical V2 and V3 event signatures', () => {
    expect([...swapTopics]).toEqual([
      '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
      '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
    ]);
  });

  it.each([...swapTopics])('tracks a DEX swap event %s', topic => {
    const flows = walletSwapFlows(wallet, 0n, [transfer(tokenA, wallet, router, 100n), transfer(tokenB, router, wallet, 40n), swap(topic)]);
    expect(flows.get(tokenA)).toBe(-100n);
    expect(flows.get(tokenB)).toBe(40n);
  });

  it('tracks a native BNB purchase and ignores a plain token transfer', () => {
    const incoming = transfer(tokenA, router, wallet, 100n);
    expect(walletSwapFlows(wallet, 10n ** 18n, [incoming]).get(tokenA)).toBe(100n);
    expect(walletSwapFlows(wallet, 0n, [incoming]).size).toBe(0);
  });

  it('recognizes an outbound-only Pancake V2 sell from a real BSC receipt', () => {
    const receiptTopic = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
    const flows = walletSwapFlows(wallet, 0n, [transfer(tokenA, wallet, router, 18578888329828771644640278n), swap(receiptTopic)]);
    expect(flows.get(tokenA)).toBe(-18578888329828771644640278n);
  });

  it('recognizes an outbound-only Binance DEX router swap', () => {
    const dex = '0xb300000b72deaeb607a12d5f54773d1c19c7028d';
    const event = { address: dex, topics: ['0xf228de527fc1b9843baac03b9a04565473a263375950e63435d4138464386f46'], data: '0x' };
    expect(walletSwapFlows(wallet, 0n, [transfer(tokenA, wallet, dex, 100n), event]).get(tokenA)).toBe(-100n);
    expect(walletSwapFlows(wallet, 0n, [transfer(tokenA, wallet, dex, 100n), { ...event, address: router }]).size).toBe(0);
  });

  it('tracks token-to-token flows without counting other wallet transfers', () => {
    const flows = walletSwapFlows(wallet, 0n, [
      transfer(tokenA, wallet, router, 100n),
      transfer(tokenB, router, wallet, 40n),
      transfer(tokenA, router, '0x3333333333333333333333333333333333333333', 5n),
    ]);
    expect([...flows.entries()]).toEqual([[tokenA, -100n], [tokenB, 40n]]);
  });

  it('nets multiple transfers and ignores zero net flow', () => {
    const flows = walletSwapFlows(wallet, 0n, [transfer(tokenA, wallet, router, 100n), transfer(tokenA, router, wallet, 100n), swap([...swapTopics][0])]);
    expect(flows.size).toBe(0);
  });

  it('ignores the NFT burn that stalled block 124454372 while retaining token swaps', () => {
    const seller = '0x9c31fef448c9094b2aac6f244242b5b3a6ca6508';
    const nft: TransferLog = {
      address: '0xabbeb6e9b9c96a837c99fb9faa908fc7a1df2bc1',
      topics: [transferTopic, indexed(seller), indexed('0x' + '0'.repeat(40)), '0x' + '7e30'.padStart(64, '0')],
      data: '0x',
    };
    expect(walletSwapFlows(seller, 0n, [nft]).size).toBe(0);
    expect([...walletSwapFlows(seller, 0n, [nft, transfer(tokenA, seller, router, 100n), transfer(tokenB, router, seller, 40n)]).entries()])
      .toEqual([[tokenA, -100n], [tokenB, 40n]]);
    expect(walletSwapFlows(seller, 0n, [{ ...nft, data: '0x' + '1'.padStart(64, '0') }, swap([...swapTopics][0])]).size).toBe(0);
  });

  it.each(['0x', '0x01', '0x' + '0'.repeat(63), '0x' + '0'.repeat(65), '0x' + 'g'.repeat(64)])('ignores invalid token amount data %s', data => {
    const invalid = { ...transfer(tokenA, wallet, router, 100n), data };
    expect([...walletSwapFlows(wallet, 10n ** 18n, [invalid, transfer(tokenB, router, wallet, 40n)]).entries()])
      .toEqual([[tokenB, 40n]]);
  });
});

describe('native BNB proceeds', () => {
  const receipts = JSON.parse(readFileSync(new URL('./fixtures/nativePayouts.json', import.meta.url), 'utf8')) as {
    name: string; hash: string; wallet: string; router: string; soldToken: string; soldRaw: string; paid: string; logs: TransferLog[];
  }[];
  it.each(receipts)('recovers the net recipient payout from a real $name receipt ($hash)', receipt => {
    expect(nativeSellProceeds(receipt.wallet, BigInt(receipt.soldRaw), receipt.logs, receipt.router, receipt.soldToken)).toBe(BigInt(receipt.paid));
    expect(nativeSellProceeds(wallet, BigInt(receipt.soldRaw), receipt.logs, receipt.router, receipt.soldToken)).toBeNull();
    expect(nativeSellProceeds(receipt.wallet, BigInt(receipt.soldRaw) * 2n, receipt.logs, receipt.router, receipt.soldToken)).toBeNull();
    expect(nativeSellProceeds(receipt.wallet, BigInt(receipt.soldRaw), [...receipt.logs, ...receipt.logs], receipt.router, receipt.soldToken)).toBeNull();
    expect(nativeSellProceeds(receipt.wallet, BigInt(receipt.soldRaw), receipt.logs.map(log => ({ ...log, address: router })), receipt.router, receipt.soldToken)).toBeNull();
  });
  it.each(receipts.filter(receipt => !receipt.name.startsWith('Flap')))('rejects the wrong input token or a nonnative $name payout', receipt => {
    expect(nativeSellProceeds(receipt.wallet, BigInt(receipt.soldRaw), receipt.logs, receipt.router, tokenA)).toBeNull();
    // All native asset sentinels become WBNB; a token payout cannot be counted as native BNB as well.
    const nonnative = receipt.logs.map(log => ({ ...log,
      topics: log.topics.map(topic => /^0x0{64}$/.test(topic) ? indexed(tokenB) : topic),
      data: log.data.replaceAll('0'.repeat(24) + 'e'.repeat(40), '0'.repeat(24) + tokenB.slice(2)),
    }));
    expect(nativeSellProceeds(receipt.wallet, BigInt(receipt.soldRaw), nonnative, receipt.router, receipt.soldToken)).toBeNull();
  });
  it('reads the net BNB paid by the Flap router rather than its gross WBNB withdrawal', () => {
    const seller = '0xb2d1af0746c410e146272e804b1741f07f83b851';
    const sold = 2815127483162583606162285n;
    const paid = 5004510678010167520n;
    const event: TransferLog = {
      address: '0x1de460f363af910f51726def188f9004276bf4bc',
      topics: [
        '0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a',
        indexed(seller), indexed(seller), `0x${'0'.repeat(64)}`,
      ],
      data: `0x${sold.toString(16).padStart(64, '0')}${paid.toString(16).padStart(64, '0')}`,
    };
    expect(nativeSellProceeds(seller, sold, [event])).toBe(paid);
    expect(nativeSellProceeds(seller, sold + 1n, [event])).toBeNull();
    expect(nativeSellProceeds(wallet, sold, [event])).toBeNull();
  });

  it('uses a single WBNB withdrawal for the observed bot router sell', () => {
    const bot = '0x9689992f5b5c09447f15906d8d11214944488341';
    const output = 707955562631066169n;
    const withdrawal: TransferLog = {
      address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
      topics: ['0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65', indexed(bot)],
      data: `0x${output.toString(16).padStart(64, '0')}`,
    };
    const logs = [withdrawal, swap([...swapTopics][0])];
    expect(nativeSellProceeds(wallet, 9003570826366468577919n, logs, bot)).toBe(output);
    expect(nativeSellProceeds(wallet, 9003570826366468577919n, logs, router)).toBeNull();
    expect(nativeSellProceeds(wallet, 9003570826366468577919n, [withdrawal], bot)).toBeNull();
  });
});
