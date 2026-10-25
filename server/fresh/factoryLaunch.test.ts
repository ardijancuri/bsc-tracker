import { describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'ethers';
import type { Rpc } from '../rpc.js';
import type { FreshBlock, FreshLog, FreshReceipt, FreshTransaction } from './capture.js';
import { FRESH_UNISWAP_V4_BSC_MANAGER, stockwavePoolManagerInterface } from './stockwaveMarket.js';
import {
  classifyFreshStockwaveCreation, freshStockwaveCreate2Address, freshStockwaveOrderedStartTick, freshStockwaveMetadataFromFact, freshStockwaveMetadataFromLaunch, readFreshStockwaveCodeEvidence, stockwaveFactoryInterface,
  FRESH_BSC_BEP344_TIME, FRESH_BSC_GENESIS_HASH, FRESH_STOCKWAVE_CREATION_CODE_HASH, FRESH_STOCKWAVE_DEPLOYER,
  FRESH_STOCKWAVE_DEPLOYER_CODE_HASH, FRESH_STOCKWAVE_FACTORY, FRESH_STOCKWAVE_FACTORY_CODE_HASH,
  FRESH_STOCKWAVE_TOKEN_CREATION_CODE, type FreshStockwaveCodeEvidence,
} from './factoryLaunch.js';

const hash = (digit: string) => `0x${digit.repeat(64)}`;
const token = '0xe36ae6bc18726a84db820ec49dd866145df5a149';
const creator = '0x4e67d54e0d2b7ad010d091b288484a647532a14c';
const blockHash = '0x03298ef00c64e87255ca243a0559ed36cb25467988ea7fdbcdf781399c5c60cf';
const txHash = '0x92e90bed43138f30c7be30a4d1b0158ede2775baae32feba5a188d280e8d413f';
const salt = '0x97a1d230d185059882268fda69f93505755f41fe27af901292dbe16112ac0dff';
const pairId = '0xe108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb';
const launchHash = '0x93435ac938a3b9e550dd4ff4a01a8f3836cc13c4118677678630f4cb53261c6f';
const poolId = '0x0e38433efc106f676d3fc5492de87aa79b1ae02aaf6188e3c9763042e064617c';
const pair = '0x02fca66c1d1afb4e2a7884261eb00f63598a7436';
const params = { creator, name: 'Stockwave.live', symbol: 'Swave', uri: 'https://stockwave.live/api/meta/a4e557deade69af7', pairId, taxBps: 200n,
  devBuy: 390000000000000000n, salt, deadline: 1792696888n, originChainId: 4663n };

// Recorded public constructor/calldata vector. Unrelated block transactions and
// receipt logs are omitted from this unit fixture; no balances or mint logs are
// needed by the proof. The genuine full receipt is checked separately by node.
const recordedInput = '0x0f47d6cf000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000002a0000000000000000000000000000000000000000000000000000000000002c7b800000000000000000000000000000000000000000000000000000000000003200000000000000000000000004e67d54e0d2b7ad010d091b288484a647532a14c0000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001c0e108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb00000000000000000000000000000000000000000000000000000000000000c800000000000000000000000000000000000000000000000005698eef0667000097a1d230d185059882268fda69f93505755f41fe27af901292dbe16112ac0dff000000000000000000000000000000000000000000000000000000006ada62380000000000000000000000000000000000000000000000000000000000001237000000000000000000000000000000000000000000000000000000000000000e53746f636b776176652e6c69766500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000055377617665000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003068747470733a2f2f73746f636b776176652e6c6976652f6170692f6d6574612f61346535353764656164653639616637000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041a4e107dc586d557b1783dbb5a8a6fef4025a88615d1e8923c62db93b591728fe2dafd92c50d7d6d3b5636b80c3d6c2d8d210b981aa36c5beb1724afbe034d07c1c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041767c4ead740fca5600b9b9c32a4a9f0375e7e9b8d47afb865e5c3a95aed9f1b964c7b0f43b3076647b8a6aede62a497fb034f948484530fc309a568847a2e5941b00000000000000000000000000000000000000000000000000000000000000';
function fixture() {
  const tx: FreshTransaction = { hash: txHash, from: creator, to: FRESH_STOCKWAVE_FACTORY, input: recordedInput, value: '0x0', blockHash,
    blockNumber: '0x7b3258c', transactionIndex: '0x43', gasPrice: '0x1' };
  const block: FreshBlock = { number: tx.blockNumber, hash: blockHash, parentHash: hash('9'), timestamp: '0x6ada5b44',
    transactions: Array.from({ length: 68 }, (_, i) => ({ ...tx, hash: `0x${i.toString(16).padStart(64, '0')}`, transactionIndex: `0x${i.toString(16)}` })) };
  block.transactions[67] = tx;
  const makeLog = (event: string, args: unknown[], index: string, eventInterface = stockwaveFactoryInterface, logAddress = FRESH_STOCKWAVE_FACTORY): FreshLog => ({ address: logAddress,
    ...eventInterface.encodeEventLog(event, args), logIndex: index, transactionHash: tx.hash, blockHash, blockNumber: tx.blockNumber, transactionIndex: tx.transactionIndex });
  const receipt: FreshReceipt = { transactionHash: tx.hash, blockHash, blockNumber: tx.blockNumber, transactionIndex: tx.transactionIndex,
    status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null, logs: [
      makeLog('Initialize', [poolId, pair, token, 0, 200, '0x5e4b06cf354bdfb306d441cad181f5768053a0cc', 716315759258551657759850475898725n, 182200],
        '0xdb', stockwavePoolManagerInterface, FRESH_UNISWAP_V4_BSC_MANAGER),
      makeLog('TokenLaunched', [token, creator, 200n, launchHash, poolId, 182200, pairId, pair, 0n, 0n, 4663n], '0xf7'),
      makeLog('TokenMetadata', [token, params.name, params.symbol, params.uri], '0xf8'),
    ] };
  const codeEvidence: FreshStockwaveCodeEvidence = { version: 1, chainId: 56, genesisHash: FRESH_BSC_GENESIS_HASH,
    observedBlock: { number: 129200291, hash: hash('a'), timestamp: 1792703760 }, factoryRuntimeHash: FRESH_STOCKWAVE_FACTORY_CODE_HASH,
    deployerRuntimeHash: FRESH_STOCKWAVE_DEPLOYER_CODE_HASH, tokenCreationCodeHash: FRESH_STOCKWAVE_CREATION_CODE_HASH,
    immutabilityRule: 'bsc_bep344_eip6780' };
  return { transaction: tx, receipt, block, codeEvidence, startBlock: 129180844 };
}

// Second canonical factory launch: the created token sorts before the pair.
// Its calldata supplied +187200, while both actual launch and Initialize emit
// -187200. The complete receipt/node and exact bytecode dependency proof are
// retained in the local factory-proof-diagnosis.json audit.
function reversedQuoteFixture(suppliedTick = 187200n, emittedTick = -187200) {
  const value = fixture(), token = '0x015cbd57d19b1e328590d32442761d5b48fc5048', pair = '0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a';
  const pool = '0xa00c27206feb5d65c7bc730e17d644623aff5a832c84dcba2866623fccd3cff1';
  const p = { creator, name: 'Stockwave.live', symbol: 'STOCKWAVE', uri: 'https://stockwave.live/api/meta/8dfa6a51c8b3950b',
    pairId: '0x3a54a9a690616fbc26cfc409bf11f89d51f1d57a4ab2791fb86026cee74ed2f3', taxBps: 200n, devBuy: 0n,
    salt: '0x7495c57ec83dcfa366c561c732534b005e45dac7f6b70bc7a195248ef88fb5fb', deadline: 1792720650n, originChainId: 1n };
  const tx = value.transaction;
  Object.assign(tx, { hash: '0x5371cd16cf5eeb604e82088e861ded6290a7bb61909be994f5186ac1efac325a',
    blockHash: '0x6fcbd09c626405c43cfa2cdd0334ce919cfcd64efdde126a25d3b1134965cfac', blockNumber: '0x' + (129234022).toString(16), transactionIndex: '0x3d',
    input: stockwaveFactoryInterface.encodeFunctionData('launch', [p,
      '0xf04cdafdbc553af852583bb0b2573434b79afab5f1b9f013010c23f1b58cc00d4820d07c625cbf42c25d31314256fed498b34ba1d2ce532f721fefadae05f3a51c', suppliedTick,
      '0xb4db6cad686473d6bbaa345a61cc368905ec818d903114341b4a6de98f4c1fd5016e639de2400ba76b5a26076d870ee55ce75e61313e211f7202d1c4e205f09a1b']) });
  Object.assign(value.block, { number: tx.blockNumber, hash: tx.blockHash, timestamp: '0x' + (1792718943).toString(16),
    transactions: Array.from({ length: 62 }, (_, i) => ({ ...tx, hash: hash(String(i % 10)), transactionIndex: '0x' + i.toString(16) })) });
  value.block.transactions[61] = tx;
  const make = (event: string, args: unknown[], index: string, abi = stockwaveFactoryInterface, address = FRESH_STOCKWAVE_FACTORY): FreshLog => ({ address,
    ...abi.encodeEventLog(event, args), logIndex: index, transactionHash: tx.hash, blockHash: tx.blockHash, blockNumber: tx.blockNumber, transactionIndex: tx.transactionIndex });
  Object.assign(value.receipt, { transactionHash: tx.hash, blockHash: tx.blockHash, blockNumber: tx.blockNumber, transactionIndex: tx.transactionIndex,
    logs: [make('Initialize', [pool, token, pair, 0, 200, '0x5e4b06cf354bdfb306d441cad181f5768053a0cc', 6824745634457896513059293n, emittedTick],
      '0x12d', stockwavePoolManagerInterface, FRESH_UNISWAP_V4_BSC_MANAGER),
    make('TokenLaunched', [token, creator, 200n, '0x6ad963f79200a2800eee95bec4fca94211d29d349e178476d2cee51f7efaad15', pool, emittedTick, p.pairId, pair, 0n, 0n, 1n], '0x149'),
    make('TokenMetadata', [token, p.name, p.symbol, p.uri], '0x14a')] });
  value.codeEvidence.observedBlock = { number: 129246585, hash: hash('d'), timestamp: 1792724597 };
  return { ...value, token, pair };
}

describe('exact authenticated Stockwave CREATE2 creation', () => {
  it('matches the recorded mainnet token address and complete initcode hash', () => {
    expect(keccak256(FRESH_STOCKWAVE_TOKEN_CREATION_CODE)).toBe(FRESH_STOCKWAVE_CREATION_CODE_HASH);
    expect(freshStockwaveCreate2Address(params)).toEqual({ address: token, initcodeHash: '0xf9f176c38a87210e65c8654d95e0397a169cd2b3bbc47ee72d238015db7b62b2' });
  });

  it('authenticates remote-chain launch metadata without a mint heuristic', () => {
    const value = fixture(), fact = classifyFreshStockwaveCreation(value);
    expect(fact).toMatchObject({ tokenAddress: token, protocol: 'stockwave', status: 'eligible', blockNumber: 129181068,
      blockHash, txHash, logIndex: 247, launchedAt: '2026-10-22T18:51:48.000Z', proof: { classification: 'authenticated_factory_create2',
        deployer: FRESH_STOCKWAVE_DEPLOYER, originChainId: '4663', historicalCodeBasis: 'bsc_bep344_persistent_runtime_inference' } });
    expect(classifyFreshStockwaveCreation({ ...value, startBlock: 129181068 })?.status).toBe('before_boundary');
  });

  it('authenticates the recorded reverse-order launch with its exact oriented tick', () => {
    const value = reversedQuoteFixture();
    expect(classifyFreshStockwaveCreation(value)).toMatchObject({ tokenAddress: value.token, blockNumber: 129234022, status: 'eligible',
      proof: { market: { initial: { tick: -187200 }, poolKey: { currency0: value.token, currency1: value.pair } } } });
  });

  it.each([[token, pair, 182200n, 182200n], [token, pair, -182200n, -182200n],
    [pair, token, 182200n, -182200n], [pair, token, -182200n, 182200n]])('orients the supplied sign exactly by pair/token order', (token, pair, supplied, expected) => {
    expect(freshStockwaveOrderedStartTick(String(token), String(pair), BigInt(supplied))).toBe(expected);
  });

  it('rejects an unflipped reverse tick or absolute-value substitution', () => {
    expect(classifyFreshStockwaveCreation(reversedQuoteFixture(187200n, 187200))).toBeNull();
    expect(classifyFreshStockwaveCreation(reversedQuoteFixture(-187200n, -187200))).toBeNull();
    expect(classifyFreshStockwaveCreation(reversedQuoteFixture(-187200n, 187200))).not.toBeNull();
  });

  it('requires the oriented factory and Initialize ticks to agree', () => {
    const value = reversedQuoteFixture();
    value.receipt.logs[0] = { ...value.receipt.logs[0], ...stockwavePoolManagerInterface.encodeEventLog('Initialize',
      ['0xa00c27206feb5d65c7bc730e17d644623aff5a832c84dcba2866623fccd3cff1', value.token, value.pair, 0, 200,
        '0x5e4b06cf354bdfb306d441cad181f5768053a0cc', 6824745634457896513059293n, 187200]) };
    expect(classifyFreshStockwaveCreation(value)).toBeNull();
  });

  it('rejects int24 negation overflow and malformed/equal token pairs', () => {
    expect(() => freshStockwaveOrderedStartTick(pair, token, -8388608n)).toThrow('overflow');
    expect(freshStockwaveOrderedStartTick(token, pair, -8388608n)).toBe(-8388608n);
    expect(() => freshStockwaveOrderedStartTick(pair, token, 8388608n)).toThrow('invalid');
    expect(() => freshStockwaveOrderedStartTick(token, token, 1n)).toThrow('invalid');
    expect(() => freshStockwaveOrderedStartTick('unknown', pair, 1n)).toThrow('invalid');
  });

  it('keeps reverse orientation inside the already authenticated immutable factory', () => {
    const value = reversedQuoteFixture(); (value.codeEvidence as { factoryRuntimeHash: string }).factoryRuntimeHash = hash('f');
    expect(classifyFreshStockwaveCreation(value)).toBeNull();
    const other = reversedQuoteFixture(); other.transaction.to = creator;
    expect(classifyFreshStockwaveCreation(other)).toBeNull();
  });

  it.each([
    ['failed creation', (v: ReturnType<typeof fixture>) => { v.receipt.status = '0x0'; }],
    ['lookalike factory', (v: ReturnType<typeof fixture>) => { v.receipt.logs[0].address = creator; }],
    ['different entrypoint', (v: ReturnType<typeof fixture>) => { v.transaction.input = `0x11111111${recordedInput.slice(10)}`; }],
    ['noncanonical calldata suffix', (v: ReturnType<typeof fixture>) => { v.transaction.input = `${recordedInput}00`; }],
    ['mint without a factory launch', (v: ReturnType<typeof fixture>) => { v.receipt.logs = []; }],
    ['missing metadata', (v: ReturnType<typeof fixture>) => { v.receipt.logs.pop(); }],
    ['duplicate launch identity', (v: ReturnType<typeof fixture>) => { v.receipt.logs.push({ ...v.receipt.logs[0], logIndex: '0xf9' }); }],
    ['removed log', (v: ReturnType<typeof fixture>) => { v.receipt.logs[0].removed = true; }],
    ['wrong receipt block', (v: ReturnType<typeof fixture>) => { v.receipt.blockHash = hash('b'); }],
    ['wrong log block', (v: ReturnType<typeof fixture>) => { v.receipt.logs[0].blockHash = hash('b'); }],
    ['wrong log transaction', (v: ReturnType<typeof fixture>) => { v.receipt.logs[1].transactionHash = hash('b'); }],
    ['wrong indexed transaction', (v: ReturnType<typeof fixture>) => { v.block.transactions[67] = { ...v.transaction, hash: hash('b') }; }],
    ['old code observation', (v: ReturnType<typeof fixture>) => { v.codeEvidence.observedBlock.number = 129181067; }],
    ['pre-fork candidate', (v: ReturnType<typeof fixture>) => { v.block.timestamp = `0x${(FRESH_BSC_BEP344_TIME - 1).toString(16)}`; }],
    ['unknown factory code', (v: ReturnType<typeof fixture>) => { (v.codeEvidence as { factoryRuntimeHash: string }).factoryRuntimeHash = hash('b'); }],
    ['other genesis', (v: ReturnType<typeof fixture>) => { (v.codeEvidence as { genesisHash: string }).genesisHash = hash('b'); }],
  ])('does not promote %s', (_name, mutate) => {
    const value = fixture(); mutate(value); expect(classifyFreshStockwaveCreation(value)).toBeNull();
  });

  it('requires a matching constructor even when a genuine factory event is present', () => {
    for (const changed of [{ ...params, salt: hash('b') }, { ...params, creator: pair }, { ...params, name: 'Other' }]) {
      const value = fixture(), call = stockwaveFactoryInterface.parseTransaction({ data: recordedInput })!;
      value.transaction.input = stockwaveFactoryInterface.encodeFunctionData('launch', [changed, call.args.creatorSig, call.args.startTick, call.args.signerSig]);
      expect(classifyFreshStockwaveCreation(value)).toBeNull();
    }
  });

  it('does not use a proof when code authentication is missing', () => {
    expect(classifyFreshStockwaveCreation({ ...fixture(), codeEvidence: null })).toBeNull();
  });

  it('recovers only constructor identity and constant precision, with supply unknown', () => {
    const fact = classifyFreshStockwaveCreation(fixture())!;
    const block = { number: fact.blockNumber + 100, hash: hash('e'), timestamp: '2026-10-22T18:52:48.000Z' };
    expect(freshStockwaveMetadataFromLaunch(fact, block)).toEqual({ address: token, name: 'Stockwave.live', symbol: 'Swave', decimals: 18, supplyRaw: null, block });
    expect(freshStockwaveMetadataFromFact({ token_address: fact.tokenAddress, protocol: fact.protocol, block_number: String(fact.blockNumber),
      block_hash: fact.blockHash, tx_hash: fact.txHash, log_index: fact.logIndex, launched_at: new Date(fact.launchedAt), status: fact.status, proof: fact.proof }, block))
      .toEqual(freshStockwaveMetadataFromLaunch(fact, block));
    expect(freshStockwaveMetadataFromLaunch({ ...fact, protocol: 'evm_creation' }, block)).toBeNull();
    expect(freshStockwaveMetadataFromLaunch({ ...fact, proof: { ...fact.proof, name: 'Other' } }, block)).toBeNull();
    expect(freshStockwaveMetadataFromLaunch({ ...fact, proof: { ...fact.proof, initcodeHash: hash('b') } }, block)).toBeNull();
    expect(freshStockwaveMetadataFromLaunch(fact, { ...block, number: fact.blockNumber - 1 })).toBeNull();
    expect(freshStockwaveMetadataFromLaunch(fact, { ...block, timestamp: '2026-10-21T18:52:48.000Z' })).toBeNull();
  });

  it('bounds code reads to one canonical selector and never retries latest', async () => {
    const rpc = vi.fn(async (method: string) => method === 'eth_chainId' ? '0x38' : method === 'eth_getBlockByNumber'
      ? { number: '0x0', hash: FRESH_BSC_GENESIS_HASH } : '0x00') as unknown as Rpc;
    const block = fixture().block;
    await expect(readFreshStockwaveCodeEvidence(rpc, block)).rejects.toThrow('factory_runtime_unrecognized');
    expect(rpc).toHaveBeenCalledTimes(4);
    expect((rpc as ReturnType<typeof vi.fn>).mock.calls.filter(([method]) => method === 'eth_getCode')).toEqual([
      ['eth_getCode', [FRESH_STOCKWAVE_FACTORY, { blockHash, requireCanonical: true }]],
      ['eth_getCode', [FRESH_STOCKWAVE_DEPLOYER, { blockHash, requireCanonical: true }]],
    ]);
  });

  it('propagates unavailable code rather than producing eligibility', async () => {
    const rpc = vi.fn(async () => { throw new Error('historical_state_unavailable'); }) as unknown as Rpc;
    await expect(readFreshStockwaveCodeEvidence(rpc, fixture().block)).rejects.toThrow('historical_state_unavailable');
    expect(rpc).toHaveBeenCalledTimes(4);
  });
});
