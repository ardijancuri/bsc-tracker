import { describe, expect, it } from 'vitest';
import { beforeExecutionTopic, userOperationTopic } from './smartAccountTrades.js';
import { transferTopic } from './swap.js';
import { decodeNodeExecutions, executionTokenFlows, type NodeBlock, type NodeLog, type NodeReceipt, type NodeTransaction } from './nodeExecution.js';
const wallet = `0x${'a'.repeat(40)}`, other = `0x${'b'.repeat(40)}`, token = `0x${'c'.repeat(40)}`, ep = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const hash = `0x${'1'.repeat(64)}`, blockHash = `0x${'2'.repeat(64)}`, word = (raw: bigint) => raw.toString(16).padStart(64, '0');
const topic = (raw: string) => `0x${raw.slice(2).padStart(64, '0')}`;
const block: NodeBlock = { number: '0x64', hash: blockHash, parentHash: `0x${'3'.repeat(64)}`, timestamp: '0x1234' };
const tx: NodeTransaction = { hash, from: wallet, to: other, value: '0x0', blockNumber: '0x64', blockHash, transactionIndex: '0x0', gasPrice: '0x2' };
const receipt: NodeReceipt = { status: '0x1', blockHash, gasUsed: '0x64', logs: [] };
const transfer = (from: string, to: string, amount: bigint, index: number): NodeLog => ({ address: token, topics: [transferTopic, topic(from), topic(to)], data: `0x${word(amount)}`, logIndex: `0x${index.toString(16)}` });
const operation = (id: number, success: bigint, fee: bigint, index: number, paymaster = `0x${'0'.repeat(40)}`): NodeLog => ({ address: ep,
  topics: [userOperationTopic, `0x${word(BigInt(id))}`, topic(wallet), topic(paymaster)], data: `0x${word(BigInt(id))}${word(success)}${word(fee)}${word(2n)}`, logIndex: `0x${index.toString(16)}` });
describe('durable execution identities', () => {
  it('preserves exact raw transfers without metadata or decimal assumptions', () => {
    const raw = (1n << 200n) + 123n;
    expect(executionTokenFlows(wallet, [transfer(other, wallet, raw, 8)] )).toEqual([{ tokenAddress: token, deltaRaw: raw.toString(), logIndices: [8], counterparties: [other] }]);
  });
  it('captures failed EOA fees without reverted token movements', () => {
    const result = decodeNodeExecutions(tx, { ...receipt, status: '0x0', logs: [transfer(other, wallet, 10n, 1)] }, block, new Set([wallet]));
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ status: 'failed', feeNativeWei: '200', feeComplete: true, flows: [] });
  });
  it('keeps repeated operations by the same sender in execution order', () => {
    const logs: NodeLog[] = [{ address: ep, topics: [beforeExecutionTopic], data: '0x', logIndex: '0x0' },
      transfer(other, wallet, 50n, 1), operation(1, 1n, 10n, 2), transfer(wallet, other, 30n, 3), operation(2, 1n, 20n, 4)];
    const result = decodeNodeExecutions({ ...tx, from: other, to: ep }, { ...receipt, logs }, block, new Set([wallet]));
    expect(result).toHaveLength(2); expect(result.map(item => item.executionIndex)).toEqual([0, 1]);
    expect(result.map(item => item.flows[0].deltaRaw)).toEqual(['50', '-30']); expect(new Set(result.map(item => item.id)).size).toBe(2);
    expect(result.map(item => item.feeNativeWei)).toEqual(['10', '20']);
  });
  it('records unsuccessful smart operations as fee-only executions', () => {
    const logs = [{ address: ep, topics: [beforeExecutionTopic], data: '0x', logIndex: '0x0' }, operation(1, 0n, 9n, 1)];
    expect(decodeNodeExecutions({ ...tx, from: other, to: ep }, { ...receipt, logs }, block, new Set([wallet]))[0]).toMatchObject({ status: 'failed', feeNativeWei: '9', flows: [] });
  });
  it('does not repeat operation flows in a monitored bundler transaction', () => {
    const logs: NodeLog[] = [{ address: ep, topics: [beforeExecutionTopic], data: '0x', logIndex: '0x0' }, transfer(other, wallet, 50n, 1), operation(1, 1n, 10n, 2)];
    const result = decodeNodeExecutions({ ...tx, to: ep }, { ...receipt, logs }, block, new Set([wallet]));
    expect(result.filter(item => item.flows.length)).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'transaction', flows: [], feeNativeWei: '200' });
    expect(result[1]).toMatchObject({ kind: 'user_operation', feeNativeWei: '10' });
  });
  it('does not charge an unrelated sender fee to an incoming-transfer recipient', () => {
    const result = decodeNodeExecutions({ ...tx, from: other }, { ...receipt, logs: [transfer(other, wallet, 10n, 1)] }, block, new Set([wallet]));
    expect(result[0]).toMatchObject({ kind: 'transfer', feeNativeWei: '0', feeComplete: true });
  });
  it('does not authenticate spoofed EntryPoint logs', () => {
    const logs = [{ address: token, topics: [beforeExecutionTopic], data: '0x', logIndex: '0x0' }, { ...operation(1, 1n, 8n, 1), address: token }];
    expect(decodeNodeExecutions({ ...tx, from: other, to: token }, { ...receipt, logs }, block, new Set([wallet]))).toEqual([]);
  });
  it('retains unsupported sponsored operations without pretending fees are complete', () => {
    const logs = [{ address: ep, topics: [beforeExecutionTopic], data: '0x', logIndex: '0x0' }, operation(1, 1n, 8n, 1, other)];
    expect(decodeNodeExecutions({ ...tx, from: other, to: ep }, { ...receipt, logs }, block, new Set([wallet]))[0]).toMatchObject({ status: 'unsupported', feeComplete: false, feeNativeWei: null });
  });
  it('rejects duplicate operation hashes and absent execution positions', () => {
    const logs = [{ address: ep, topics: [beforeExecutionTopic], data: '0x', logIndex: '0x0' }, operation(1, 1n, 8n, 1), operation(1, 1n, 8n, 2)];
    expect(() => decodeNodeExecutions({ ...tx, from: other, to: ep }, { ...receipt, logs }, block, new Set([wallet]))).toThrow('duplicate');
    expect(() => executionTokenFlows(wallet, [{ ...transfer(other, wallet, 1n, 1), logIndex: undefined }])).toThrow('position_missing');
  });
});
