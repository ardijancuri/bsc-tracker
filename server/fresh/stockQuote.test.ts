import { describe, expect, it } from 'vitest';
import type { Rpc } from '../rpc.js';
import { WBNB } from '../launchpad.js';
import type { FreshLog, FreshReceipt } from './capture.js';
import { FRESH_STOCK_QUOTE_TOKEN, FRESH_WOOFI_BSC_POOL, freshWooSwapInterface as abi, recoverFreshStockRawQuote } from './stockQuote.js';

const h = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const hex = (n: number) => '0x' + n.toString(16);
const sender = '0x' + '1'.repeat(40), recipient = '0x' + '2'.repeat(40);
const target = {number: 1000, hash: h(1000), timestamp: '2026-10-22T20:00:00.000Z'};
const time = Date.parse(target.timestamp) / 1000;
function fixture(reverse = false) {
  const sourceNumber = 990, txHash = h(10000), base = {blockNumber: hex(sourceNumber), blockHash: h(sourceNumber), transactionHash: txHash, transactionIndex: '0x0'};
  const nativeRaw = 123456789012345678901234n, quoteRaw = 9876543210987654321098765n;
  const fromToken = reverse ? FRESH_STOCK_QUOTE_TOKEN : WBNB, toToken = reverse ? WBNB : FRESH_STOCK_QUOTE_TOKEN;
  const fromAmount = reverse ? quoteRaw : nativeRaw, toAmount = reverse ? nativeRaw : quoteRaw;
  const event = (name: 'Transfer' | 'WooSwap', args: unknown[], address: string, index: number): FreshLog => ({...base, address, logIndex: hex(index), ...abi.encodeEventLog(abi.getEvent(name)!, args)});
  const input = event('Transfer', [sender, FRESH_WOOFI_BSC_POOL, fromAmount], fromToken, 4);
  const output = event('Transfer', [FRESH_WOOFI_BSC_POOL, recipient, toAmount], toToken, 6);
  const swap = event('WooSwap', [fromToken, toToken, fromAmount, toAmount, sender, recipient, recipient, 17n, 1n], FRESH_WOOFI_BSC_POOL, 7);
  const receipt: FreshReceipt = {...base, status: '0x1', gasUsed: '0x100', transactionHash: txHash, logs: [input, output, swap]};
  const block = {number: hex(sourceNumber), hash: h(sourceNumber), timestamp: hex(time - 10), transactions: [txHash]};
  const methods: string[] = [];
  const data = {logs: [swap], receipt, block, chainId: '0x38'};
  const rpc = (async (method: string, params: unknown[]) => {
    methods.push(method);
    if (method === 'eth_chainId') return data.chainId;
    if (method === 'eth_getLogs') {
      expect(params[0]).toMatchObject({address: FRESH_WOOFI_BSC_POOL, fromBlock: hex(488), toBlock: hex(999)});
      return data.logs;
    }
    if (method === 'eth_getBlockByNumber') { expect(params).toEqual([hex(sourceNumber), false]); return data.block; }
    if (method === 'eth_getTransactionReceipt') { expect(params).toEqual([txHash]); return data.receipt; }
    throw Error('unexpected_rpc');
  }) as Rpc;
  return {data, methods, input, output, swap, nativeRaw, quoteRaw, options: {rpc, target: {...target}, canonicalHash: async (n: number) => h(n)}};
}

describe('WOOFi historical settled raw exchange evidence', () => {
  it.each([false, true])('retains exact native/quote amounts in either swap direction (%s)', async reverse => {
    const f = fixture(reverse), proof = await recoverFreshStockRawQuote(f.options);
    expect(proof.nativeRaw).toBe(f.nativeRaw.toString()); expect(proof.quoteRaw).toBe(f.quoteRaw.toString());
    expect(proof.source.number).toBe(990); expect(proof.inputLogIndex).toBe(4); expect(proof.outputLogIndex).toBe(6);
    expect(proof.receipt).toEqual(f.data.receipt); expect(proof.receiptSha256).toMatch(/^[\da-f]{64}$/);
    expect(f.methods).toEqual(['eth_chainId', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getTransactionReceipt']);
    expect(JSON.stringify(proof)).not.toContain('decimals');
  });
  it('uses the last earlier swap and never asks for current metadata or a spot quote', async () => {
    const f = fixture(); f.data.logs.unshift({...f.swap, blockNumber: hex(989), blockHash: h(989)});
    expect((await recoverFreshStockRawQuote(f.options)).source.number).toBe(990);
    expect(f.methods.some(m => ['eth_call', 'eth_getStorageAt', 'eth_getCode'].includes(m))).toBe(false);
  });
  it('replays the retained receipt without RPC and accepts JSONB key ordering', async () => {
    const f = fixture(), proof = await recoverFreshStockRawQuote(f.options);
    const reversed = Object.fromEntries(Object.entries(proof).reverse()) as typeof proof;
    const result = await recoverFreshStockRawQuote({...f.options, rpc: (async () => { throw Error('no_rpc'); }) as Rpc, prior: reversed});
    expect(result.nativeRaw).toBe(proof.nativeRaw);
  });
  it('invalidates replay on source and target reorgs', async () => {
    const f = fixture(), proof = await recoverFreshStockRawQuote(f.options);
    for (const replaced of [990, 1000]) await expect(recoverFreshStockRawQuote({...f.options, prior: proof,
      canonicalHash: async n => h(n === replaced ? 2000 : n)})).rejects.toThrow('stock_quote_noncanonical');
  });
  it('rejects forged retained amounts, target, checksum and settlement indexes', async () => {
    const f = fixture(), proof = await recoverFreshStockRawQuote(f.options);
    for (const patch of [{nativeRaw: '1'}, {quoteRaw: '1'}, {receiptSha256: '0'.repeat(64)}, {inputLogIndex: 99}, {target: {...target, hash: h(7)}}])
      await expect(recoverFreshStockRawQuote({...f.options, prior: {...proof, ...patch}})).rejects.toThrow('stock_quote_prior_invalid');
  });
  it('rejects a stale, future-dated or later-block observation', async () => {
    for (const age of [121, -1]) {
      const f = fixture(); f.data.block.timestamp = hex(time - age);
      await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_stale');
    }
    const f = fixture(); f.data.logs = [{...f.swap, blockNumber: hex(target.number), blockHash: target.hash}];
    await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_log_invalid');
  });
  it('accepts a quote exactly 120 seconds old', async () => {
    const f = fixture(); f.data.block.timestamp = hex(time - 120);
    expect((await recoverFreshStockRawQuote(f.options)).quoteRaw).toBe(f.quoteRaw.toString());
  });
  it('rejects absent market activity and bounds response work', async () => {
    const f = fixture(); f.data.logs = [];
    await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_unavailable');
    f.data.logs = Array(513).fill(f.swap);
    await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_work_bounds');
  });
  it('rejects an unsupported chain and incorrect canonical transaction inclusion', async () => {
    const f = fixture(); f.data.chainId = '0x1';
    await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_chain_invalid');
    f.data.chainId = '0x38'; f.data.block.transactions = [h(88)];
    await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_block_invalid');
  });
  it('rejects foreign venue, wrong pair, removed and dirty-address events', async () => {
    for (const change of [(l: FreshLog) => { l.address = sender; }, (l: FreshLog) => { l.topics[1] = h(1); },
      (l: FreshLog) => { l.removed = true; }, (l: FreshLog) => { l.topics[2] = l.topics[1]; }]) {
      const f = fixture(); change(f.swap);
      await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_log_invalid');
    }
  });
  it('rejects duplicated and reversed query results', async () => {
    for (const reverse of [false, true]) {
      const f = fixture(), previous = {...f.swap, blockNumber: hex(989), blockHash: h(989)};
      f.data.logs = reverse ? [f.swap, previous] : [f.swap, f.swap];
      await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_log_order_invalid');
    }
  });
  it('requires exact input/output amounts and counterparties instead of aggregate receipt volume', async () => {
    for (const logIndex of [0, 1]) {
      const f = fixture(); f.data.receipt.logs[logIndex].data = h(12);
      await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_settlement_invalid');
    }
    const f = fixture(); f.input.topics[1] = '0x' + '0'.repeat(24) + recipient.slice(2);
    await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_settlement_invalid');
  });
  it('rejects ambiguous pool movements, failure receipts and missing matching receipt events', async () => {
    const f = fixture(); f.data.receipt.logs.splice(1, 0, {...f.input, logIndex: '0x5'});
    await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_settlement_invalid');
    const g = fixture(); g.data.receipt.status = '0x0';
    await expect(recoverFreshStockRawQuote(g.options)).rejects.toThrow('stock_quote_receipt_invalid');
    const j = fixture(); j.data.receipt.logs = j.data.receipt.logs.slice(0, 2);
    await expect(recoverFreshStockRawQuote(j.options)).rejects.toThrow('stock_quote_event_invalid');
  });
  it('does not match transfers across an earlier WooSwap boundary', async () => {
    const f = fixture(); f.data.receipt.logs.splice(1, 0, {...f.swap, logIndex: '0x5'});
    await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_settlement_invalid');
  });
  it('rejects dirty ABI address padding with a bounded diagnostic', async () => {
    const f = fixture(); f.swap.data = f.swap.data.slice(0, 130) + 'ff' + f.swap.data.slice(132);
    await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow(/^stock_quote_event_invalid$/);
    const g = fixture(); g.input.topics[1] = '0xff' + g.input.topics[1].slice(4);
    await expect(recoverFreshStockRawQuote(g.options)).rejects.toThrow(/^stock_quote_settlement_invalid$/);
  });
  it('rejects receipt logs that belong to another block or transaction', async () => {
    const f = fixture(); f.input.blockHash = h(999);
    await expect(recoverFreshStockRawQuote(f.options)).rejects.toThrow('stock_quote_receipt_invalid');
    const g = fixture(); g.output.transactionHash = h(999);
    await expect(recoverFreshStockRawQuote(g.options)).rejects.toThrow('stock_quote_receipt_invalid');
  });
});
