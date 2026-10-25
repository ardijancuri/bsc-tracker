import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCreateAddress } from 'ethers';
import type { PoolClient } from 'pg';
import type { Rpc, RpcBatchRequest } from '../rpc.js';
import { transferTopic } from '../swap.js';
import { fourInterface, FOUR_MANAGERS, pairInterface, PCS_V2_FACTORY } from '../launchpad.js';
import { collectFreshPage, commitFreshPage, decodeFreshEvidence, decodeFreshLaunch, encodeFreshEvidence, FRESH_EVIDENCE_TTL_MS, runFreshCapture, validateFreshReceipt, type FreshBlock, type FreshCapturedReceipt, type FreshLog } from './capture.js';
import { FRESH_NONLEDGER_TEMPLATES } from './tokenAuthenticity.js';
import * as stockwave from './factoryLaunch.js';
import { FRESH_UNISWAP_V4_BSC_MANAGER, freshStockwavePoolId, stockwavePoolManagerInterface } from './stockwaveMarket.js';

const hash = (digit: string) => `0x${digit.repeat(64)}`, address = (digit: string) => `0x${digit.repeat(40)}`, word = (value: string) => `0x${value.slice(2).padStart(64, '0')}`;
const wallet = address('1'), router = address('2'), token = address('7');
function fixture(): { block: FreshBlock; entry: FreshCapturedReceipt } {
  const tx = { hash: hash('b'), from: wallet, to: router, value: '0x0', blockHash: hash('a'), blockNumber: '0x65', transactionIndex: '0x0', gasPrice: '0x1' };
  const log: FreshLog = { address: token, topics: [transferTopic, word(router), word(wallet)], data: word('0x64'), logIndex: '0x0', transactionHash: tx.hash, transactionIndex: '0x0', blockNumber: '0x65', blockHash: tx.blockHash };
  return { block: { number: '0x65', hash: hash('a'), parentHash: hash('9'), timestamp: '0x69000000', transactions: [tx] },
    entry: { transaction: tx, receipt: { transactionHash: tx.hash, transactionIndex: '0x0', blockHash: tx.blockHash, blockNumber: tx.blockNumber, status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [log] }, wallets: [wallet], observedAt: '2026-10-21T18:00:00Z' } };
}
function rpcFixture(options: { missing?: boolean; mutate?: (value: ReturnType<typeof fixture>) => void } = {}): Rpc {
  const value = fixture(); options.mutate?.(value);
  return vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'eth_blockNumber') return '0x6b';
    if (method === 'eth_getBlockByNumber') return value.block;
    if (method === 'eth_getTransactionReceipt') return options.missing ? null : value.entry.receipt;
    if (method === 'eth_getLogs') { const filter = params[0] as { address?: unknown; topics: unknown[] }; return filter.topics[0] === transferTopic ? [value.entry.receipt.logs[0]] : []; }
    throw new Error('unexpected_rpc');
  }) as Rpc;
}
const checkpoint = { blockNumber: 100, blockHash: hash('9'), revision: 1, startBlock: 100 };
function limitedBlockBatchFixture(options: { lag?: number; failure?: 'rejected' | 'missing_result' | 'missing_block' | 'identity' | 'parent' } = {}) {
  const blockHash = (number: number) => '0x' + number.toString(16).padStart(64, '0');
  const batches: number[][] = []; let active = 0, maximumActive = 0;
  const rpc = vi.fn(async (method: string) => {
    if (method === 'eth_blockNumber') return '0x' + (106 + (options.lag ?? 64)).toString(16);
    if (method === 'eth_getLogs') return [];
    throw Error('unexpected_single_rpc');
  }) as Rpc;
  rpc.batch = vi.fn(async (requests: RpcBatchRequest[]) => {
    if (!requests.length) return [];
    if (requests.some(request => request.method !== 'eth_getBlockByNumber' || request.params[1] !== true)) throw Error('unexpected_batch_rpc');
    if (requests.length > 16) throw Error('full_block_batch_too_large');
    const numbers = requests.map(request => Number(BigInt(request.params[0] as string)));
    batches.push(numbers); active++; maximumActive = Math.max(maximumActive, active);
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    return numbers.flatMap<PromiseSettledResult<unknown>>(number => {
      if (number === 117 && options.failure === 'rejected') return [{ status: 'rejected' as const, reason: Error('block_unavailable') }];
      if (number === 132 && options.failure === 'missing_result') return [];
      const block: FreshBlock | null = number === 117 && options.failure === 'missing_block' ? null : {
        number: '0x' + (number === 117 && options.failure === 'identity' ? number + 1 : number).toString(16),
        hash: blockHash(number), parentHash: blockHash(number === 117 && options.failure === 'parent' ? 999 : number - 1),
        timestamp: '0x69000000', transactions: [],
      };
      return [{ status: 'fulfilled' as const, value: block }];
    });
  });
  return { rpc, batches, checkpoint: { ...checkpoint, blockHash: blockHash(100) }, get maximumActive() { return maximumActive; } };
}
afterEach(() => { vi.restoreAllMocks(); });
describe('lean confirmed capture', () => {
  it.each([{lag:0,want:0},{lag:16,want:16},{lag:32,want:16},{lag:33,want:32},{lag:100,want:32}])('uses one head read and the correct adaptive page at confirmed lag $lag',async({lag,want})=>{
    const blockHash=(n:number)=>'0x'+n.toString(16).padStart(64,'0'),requests:number[]=[];
    const rpc=vi.fn(async(method:string,params:unknown[])=>{
      if(method==='eth_blockNumber')return'0x'+(100+6+lag).toString(16);
      if(method==='eth_getBlockByNumber'){const n=Number(BigInt(params[0] as string));requests.push(n);return{number:'0x'+n.toString(16),hash:blockHash(n),parentHash:blockHash(n-1),timestamp:'0x69000000',transactions:[]};}
      if(method==='eth_getLogs')return[];throw Error('unexpected_rpc');
    })as Rpc;
    const page=await collectFreshPage({rpc,checkpoint:{...checkpoint,blockHash:blockHash(100)},wallets:[],limit:16,catchUpLimit:999,launchDiscovery:false,collectCreations:false});
    expect(page.blocks).toHaveLength(want);expect(requests).toEqual(Array.from({length:want},(_,i)=>101+i));
    expect(page.nodeHead).toBe(106+lag);
    expect((rpc as any).mock.calls.filter(([method]:string[])=>method==='eth_blockNumber')).toHaveLength(1);
    if(want)expect(Number(BigInt(page.blocks.at(-1)!.number))).toBeLessThanOrEqual(100+lag);
  });
  it('retains an explicit smaller caller limit without opting in to catch-up pages',async()=>{
    const blockHash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
    const rpc=(async(method:string,params:unknown[])=>method==='eth_blockNumber'?'0x100':{number:params[0],hash:blockHash(Number(BigInt(params[0] as string))),parentHash:blockHash(Number(BigInt(params[0] as string))-1),timestamp:'0x69000000',transactions:[]})as Rpc;
    const page=await collectFreshPage({rpc,checkpoint:{...checkpoint,blockHash:blockHash(100)},wallets:[],limit:2,launchDiscovery:false,collectCreations:false});expect(page.blocks).toHaveLength(2);
  });
  it('collects one atomic 32-block page using sequential full-block batches of at most 16', async () => {
    const f = limitedBlockBatchFixture();
    const page = await collectFreshPage({ rpc: f.rpc, checkpoint: f.checkpoint, wallets: [], limit: 16, catchUpLimit: 32, launchDiscovery: false, collectCreations: false });
    expect(f.batches).toEqual([Array.from({ length: 16 }, (_, i) => 101 + i), Array.from({ length: 16 }, (_, i) => 117 + i)]);
    expect(f.maximumActive).toBe(1);
    expect(page.previous).toEqual(f.checkpoint);
    expect(page.blocks.map(block => Number(BigInt(block.number)))).toEqual(Array.from({ length: 32 }, (_, i) => 101 + i));
    expect(page.receipts).toEqual([]); expect(page.launches).toEqual([]);
  });
  it('retains a single near-head 16-block page with the bounded full-block transport', async () => {
    const f = limitedBlockBatchFixture({ lag: 32 });
    const page = await collectFreshPage({ rpc: f.rpc, checkpoint: f.checkpoint, wallets: [], limit: 16, catchUpLimit: 32, launchDiscovery: false, collectCreations: false });
    expect(page.blocks).toHaveLength(16); expect(f.batches).toHaveLength(1); expect(f.batches[0]).toHaveLength(16);
  });
  it.each([
    ['rejected', 'required_block_unavailable'], ['missing_result', 'required_block_unavailable'],
    ['missing_block', 'block_identity_mismatch'], ['identity', 'block_identity_mismatch'], ['parent', 'block_identity_mismatch'],
  ] as const)('rejects the whole page before any database transaction when the second block batch has %s', async (failure, reason) => {
    const f = limitedBlockBatchFixture({ failure });
    const database = {
      query: vi.fn(async (sql: string) => sql.includes("key='capture'") ? { rows: [{ block_number: f.checkpoint.blockNumber, block_hash: f.checkpoint.blockHash, revision: 1, value: { startBlock: 100 } }] } : { rows: [] }),
      connect: vi.fn(),
    } as unknown as Parameters<typeof runFreshCapture>[0];
    await expect(runFreshCapture(database, f.rpc, { limit: 16, catchUpLimit: 32 })).rejects.toThrow(reason);
    expect(f.batches).toHaveLength(2); expect(f.maximumActive).toBe(1);
    expect(database.connect).not.toHaveBeenCalled();
    expect((f.rpc as any).mock.calls.map(([method]: string[]) => method)).toEqual(['eth_blockNumber']);
  });
  it('captures a six-confirmed transfer receipt without needing metadata or provider calls', async () => {
    const rpc = rpcFixture(), page = await collectFreshPage({ rpc, checkpoint, wallets: [{ address: wallet, fromBlock: 101 }], now: new Date('2026-10-21T18:00:00Z') });
    expect(page.blocks).toHaveLength(1); expect(page.receipts).toHaveLength(1); expect(page.receipts[0].wallets).toEqual([wallet]);
    expect((rpc as any).mock.calls.every(([method]: string[]) => method.startsWith('eth_'))).toBe(true);
  });
  it('waits for the sixth confirmation', async () => {
    const rpc = rpcFixture(); expect((await collectFreshPage({ rpc, checkpoint, head: 106, wallets: [] })).blocks).toHaveLength(0);
  });
  it.each([106,107])('reports confirmed capture lag from the existing head read at head %i',async(head)=>{
    let clock=1000;vi.spyOn(Date,'now').mockImplementation(()=>clock);
    const base=rpcFixture(),rpc=vi.fn(async(method:string,params:unknown[])=>{if(method==='eth_blockNumber')return'0x'+head.toString(16);clock=10000;return base(method,params);})as Rpc;
    const saved={block_number:100,block_hash:checkpoint.blockHash,revision:1,value:{startBlock:100}};
    const client={query:vi.fn(async(sql:string)=>({rows:sql.includes('FOR UPDATE')?[saved]:[]})),release:vi.fn()};
    const database={query:vi.fn(async(sql:string)=>({rows:sql.includes("key='capture'")?[saved]:[]})),connect:vi.fn(async()=>client)}as unknown as Parameters<typeof runFreshCapture>[0];
    const result=await runFreshCapture(database,rpc);
    expect(result).toMatchObject({nodeHead:head,confirmedHeadBlock:head-6,capturedBlock:head-6,lagBlocks:0,blocks:head-106,checkedAt:1000});
    expect((rpc as any).mock.calls.filter(([method]:string[])=>method==='eth_blockNumber')).toHaveLength(1);
    expect(database.connect).toHaveBeenCalledTimes(head-106);
  });
  it('dates the head observation before a delayed head response',async()=>{
    let clock=1000;vi.spyOn(Date,'now').mockImplementation(()=>clock);
    const rpc=vi.fn(async()=>{clock=10000;return'0x6a';})as Rpc;
    const saved={block_number:100,block_hash:checkpoint.blockHash,revision:1,value:{startBlock:100}};
    const database={query:vi.fn(async(sql:string)=>({rows:sql.includes("key='capture'")?[saved]:[]}))}as unknown as Parameters<typeof runFreshCapture>[0];
    expect(await runFreshCapture(database,rpc)).toMatchObject({checkedAt:1000,confirmedHeadBlock:100,capturedBlock:100,lagBlocks:0});
    expect(clock).toBe(10000);expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('does not produce a committable page when a required receipt is missing', async () => {
    await expect(collectFreshPage({ rpc: rpcFixture({ missing: true }), checkpoint, wallets: [{ address: wallet, fromBlock: 101 }] })).rejects.toThrow('required_receipt_missing');
  });
  it('rejects wrong block, parent, transaction positions and receipt identities', async () => {
    await expect(collectFreshPage({ rpc: rpcFixture({ mutate: value => { value.block.parentHash = hash('c'); } }), checkpoint, wallets: [] })).rejects.toThrow('block_identity_mismatch');
    await expect(collectFreshPage({ rpc: rpcFixture({ mutate: value => { value.entry.transaction.transactionIndex = '0x1'; } }), checkpoint, wallets: [] })).rejects.toThrow('transaction_identity_mismatch');
    const value = fixture(); value.entry.receipt.blockHash = hash('c'); expect(() => validateFreshReceipt(value.entry.receipt, value.entry.transaction, value.block)).toThrow('receipt_identity_mismatch');
  });
  it('honors registration at the next block and rejects a changed membership revision', async () => {
    const page = await collectFreshPage({ rpc: rpcFixture(), checkpoint, wallets: [{ address: wallet, fromBlock: 102 }] }); expect(page.receipts).toHaveLength(0);
    const client = { query: vi.fn(async () => ({ rows: [{ block_number: 100, block_hash: hash('9'), revision: 2 }] })) } as unknown as PoolClient;
    await expect(commitFreshPage(client, { ...page, previous: checkpoint })).rejects.toThrow('capture_checkpoint_changed'); expect(client.query).toHaveBeenCalledTimes(1);
  });
  it('round trips compressed complete evidence and rejects corruption', () => {
    const { entry } = fixture(), encoded = encodeFreshEvidence(entry); expect(decodeFreshEvidence(encoded)).toMatchObject(entry);
    const damaged = Buffer.from(encoded); damaged[12] ^= 255; expect(() => decodeFreshEvidence(damaged)).toThrow('checksum');
    expect(FRESH_EVIDENCE_TTL_MS).toBe(72 * 60 * 60 * 1_000);
  });
  it('authenticates creation facts and never treats a newly created pair as a token launch', () => {
    const { block, entry } = fixture(), encoded = fourInterface.encodeEventLog('TokenCreate', [wallet, token, 1n, 'Fresh Token', 'NEW', 1_000_000n, 1_761_063_000n, 0n]);
    const log = { ...entry.receipt.logs[0], ...encoded, address: FOUR_MANAGERS[1] };
    expect(decodeFreshLaunch(log, block, 100)?.status).toBe('eligible'); expect(decodeFreshLaunch(log, block, 102)?.status).toBe('before_boundary');
    expect(decodeFreshLaunch({ ...log, address: router }, block, 100)).toBeNull();
    const pair = pairInterface.encodeEventLog('PairCreated', [token, wallet, router, 1n]); expect(decodeFreshLaunch({ ...log, ...pair, address: PCS_V2_FACTORY }, block, 100)).toBeNull();
  });
  it('preserves the launch policy and original evidence for unrecognized creation bytecode', async () => {
    const rpc = rpcFixture({ mutate: value => {
      value.entry.transaction.to = null;
      value.entry.transaction.input = '0x60006000f3';
      value.entry.receipt.contractAddress = token;
    } });
    const page = await collectFreshPage({ rpc, checkpoint, wallets: [{ address: wallet, fromBlock: 101 }] });
    expect(page.launches).toEqual([expect.objectContaining({ tokenAddress: token, protocol: 'evm_creation', status: 'eligible',
      blockNumber: 101, blockHash: hash('a'), txHash: hash('b'), proof: { creator: wallet, creation: 'top_level' } })]);
    expect(page.receipts).toHaveLength(1);
    expect(decodeFreshEvidence(encodeFreshEvidence(page.receipts[0]))).toMatchObject({ transaction: { to: null, input: '0x60006000f3' },
      receipt: { contractAddress: token, logs: fixture().entry.receipt.logs }, wallets: [wallet] });
    expect((rpc as any).mock.calls.some(([method]: string[]) => method === 'eth_call' || method === 'eth_getCode')).toBe(false);
  });
  it.each(FRESH_NONLEDGER_TEMPLATES)('retains an authenticated excluded launch fact and raw receipt for $id', async template => {
    const created = getCreateAddress({ from: wallet, nonce: 0 }).toLowerCase();
    const rpc = rpcFixture({ mutate: value => {
      value.entry.transaction.to = null;
      value.entry.transaction.nonce = '0x0';
      value.entry.transaction.input = template.initcode;
      value.entry.receipt.contractAddress = created;
      value.entry.receipt.logs[0].address = created;
    } });
    const page = await collectFreshPage({ rpc, checkpoint, wallets: [{ address: wallet, fromBlock: 101 }] });
    expect(page.launches).toHaveLength(1);
    expect(page.launches[0]).toMatchObject({ tokenAddress: created, protocol: 'evm_creation', status: 'excluded_non_token',
      blockNumber: 101, blockHash: hash('a'), txHash: hash('b'), proof: { creator: wallet, creation: 'top_level',
        authenticity: { version: 1, classification: 'proven_nonledger_event_emitter', templateId: template.id, ledgerAbsent: true } } });
    expect(page.receipts).toHaveLength(1);
    expect(decodeFreshEvidence(encodeFreshEvidence(page.receipts[0]))).toMatchObject({ transaction: { to: null, input: template.initcode, nonce: '0x0' },
      receipt: { contractAddress: created, logs: [{ ...fixture().entry.receipt.logs[0], address: created }] }, wallets: [wallet] });
    expect((rpc as any).mock.calls.some(([method]: string[]) => method === 'eth_call' || method === 'eth_getCode')).toBe(false);
  });
});

function stockwaveCaptureFixture(options: { missing?: boolean; spoofToken?: boolean; mismatchDiscovery?: boolean } = {}) {
  const creator = '0x4e67d54e0d2b7ad010d091b288484a647532a14c', swave = '0xe36ae6bc18726a84db820ec49dd866145df5a149';
  const p = { creator, name: 'Stockwave.live', symbol: 'Swave', uri: 'https://stockwave.live/api/meta/a4e557deade69af7',
    pairId: '0xe108948b9667048232851f26a1427d3a908b22da622562906ca50ea536c2ecfb', taxBps: 200n, devBuy: 0n,
    salt: '0x97a1d230d185059882268fda69f93505755f41fe27af901292dbe16112ac0dff', deadline: 1792696888n, originChainId: 4663n };
  const tx = { hash: hash('b'), from: creator, to: stockwave.FRESH_STOCKWAVE_FACTORY,
    input: stockwave.stockwaveFactoryInterface.encodeFunctionData('launch', [p, '0x', 182200, '0x']), value: '0x0',
    blockHash: hash('a'), blockNumber: '0x65', transactionIndex: '0x0', gasPrice: '0x1' };
  const logToken = options.spoofToken ? address('5') : swave;
  const makeLog = (event: string, args: unknown[], index: string): FreshLog => ({ address: stockwave.FRESH_STOCKWAVE_FACTORY,
    ...stockwave.stockwaveFactoryInterface.encodeEventLog(event, args), logIndex: index, transactionHash: tx.hash, transactionIndex: '0x0', blockNumber: tx.blockNumber, blockHash: tx.blockHash });
  const poolKey = { currency0: address('6'), currency1: swave, fee: 0, tickSpacing: 200, hooks: '0x5e4b06cf354bdfb306d441cad181f5768053a0cc' };
  const poolId = freshStockwavePoolId(poolKey);
  const initialize = { ...makeLog('TokenMetadata', [logToken, p.name, p.symbol, p.uri], '0x0'), address: FRESH_UNISWAP_V4_BSC_MANAGER,
    ...stockwavePoolManagerInterface.encodeEventLog('Initialize', [poolId, poolKey.currency0, poolKey.currency1, 0, 200, poolKey.hooks, 1n << 96n, 182200]) };
  const logs = [initialize, makeLog('TokenLaunched', [logToken, creator, 200n, hash('d'), poolId, 182200, p.pairId, address('6'), 0n, 0n, 4663n], '0x1'),
    makeLog('TokenMetadata', [logToken, p.name, p.symbol, p.uri], '0x2')];
  const receipt = { transactionHash: tx.hash, transactionIndex: '0x0', blockHash: tx.blockHash, blockNumber: tx.blockNumber,
    status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null, logs };
  const block: FreshBlock = { number: tx.blockNumber, hash: tx.blockHash, parentHash: checkpoint.blockHash, timestamp: '0x6ada5b44', transactions: [tx] };
  const proof: stockwave.FreshStockwaveCodeEvidence = { version: 1, chainId: 56, genesisHash: stockwave.FRESH_BSC_GENESIS_HASH,
    observedBlock: { number: 101, hash: block.hash, timestamp: Number(BigInt(block.timestamp)) }, factoryRuntimeHash: stockwave.FRESH_STOCKWAVE_FACTORY_CODE_HASH,
    deployerRuntimeHash: stockwave.FRESH_STOCKWAVE_DEPLOYER_CODE_HASH, tokenCreationCodeHash: stockwave.FRESH_STOCKWAVE_CREATION_CODE_HASH,
    immutabilityRule: 'bsc_bep344_eip6780' };
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'eth_blockNumber') return '0x6b';
    if (method === 'eth_getBlockByNumber') return block;
    if (method === 'eth_getTransactionReceipt') return options.missing ? null : receipt;
    if (method === 'eth_getLogs') {
      const filter = params[0] as { address?: unknown };
      return Array.isArray(filter.address) && filter.address.includes(stockwave.FRESH_STOCKWAVE_FACTORY)
        ? [{ ...logs[1], ...(options.mismatchDiscovery ? { data: `${logs[1].data}00` } : {}) }] : [];
    }
    throw new Error('unexpected_rpc');
  }) as unknown as Rpc;
  return { rpc, proof, creator, block, receipt, swave };
}

describe('Stockwave factory capture', () => {
  it('authenticates an unmonitored internal creation using its mandatory full receipt', async () => {
    const f = stockwaveCaptureFixture(), code = vi.spyOn(stockwave, 'readFreshStockwaveCodeEvidence').mockResolvedValue(f.proof);
    const page = await collectFreshPage({ rpc: f.rpc, checkpoint, wallets: [] });
    expect(page.launches).toEqual([expect.objectContaining({ tokenAddress: f.swave, protocol: 'stockwave', status: 'eligible' })]);
    expect(page.receipts).toHaveLength(0);
    expect(code).toHaveBeenCalledExactlyOnceWith(f.rpc, f.block);
    expect(f.rpc).toHaveBeenCalledWith('eth_getTransactionReceipt', [f.receipt.transactionHash]);
  });

  it('shares one code authentication across multiple mandatory factory receipts in a page', async () => {
    const f = stockwaveCaptureFixture(), code = vi.spyOn(stockwave, 'readFreshStockwaveCodeEvidence').mockResolvedValue(f.proof);
    const call = stockwave.stockwaveFactoryInterface.parseTransaction({ data: f.block.transactions[0].input as string })!;
    const p = { ...call.args.p.toObject(), name: 'Second', salt: hash('f') };
    const secondToken = stockwave.freshStockwaveCreate2Address(p as { name: string; symbol: string; creator: string; salt: string }).address;
    const tx = { ...f.block.transactions[0], hash: hash('c'), transactionIndex: '0x1',
      input: stockwave.stockwaveFactoryInterface.encodeFunctionData('launch', [p, '0x', 182200, '0x']) };
    f.block.transactions.push(tx);
    const firstLaunch = f.receipt.logs[1], firstMetadata = f.receipt.logs[2];
    const args = stockwave.stockwaveFactoryInterface.parseLog(firstLaunch)!.args;
    const secondKey = { currency0: BigInt(secondToken) < BigInt(args.pair) ? secondToken : String(args.pair).toLowerCase(),
      currency1: BigInt(secondToken) < BigInt(args.pair) ? String(args.pair).toLowerCase() : secondToken,
      fee: 0, tickSpacing: 200, hooks: '0x5e4b06cf354bdfb306d441cad181f5768053a0cc' };
    const secondPool = freshStockwavePoolId(secondKey);
    const logs: FreshLog[] = [
      { ...f.receipt.logs[0], ...stockwavePoolManagerInterface.encodeEventLog('Initialize',
        [secondPool, secondKey.currency0, secondKey.currency1, 0, 200, secondKey.hooks, 1n << 96n, 182200]),
        transactionHash: tx.hash, transactionIndex: '0x1', logIndex: '0x3' },
      { ...firstLaunch, ...stockwave.stockwaveFactoryInterface.encodeEventLog('TokenLaunched',
        [secondToken, p.creator, p.taxBps, args.launchHash, secondPool, 182200, p.pairId, args.pair, 0n, 0n, p.originChainId]),
      transactionHash: tx.hash, transactionIndex: '0x1', logIndex: '0x4' },
      { ...firstMetadata, ...stockwave.stockwaveFactoryInterface.encodeEventLog('TokenMetadata', [secondToken, p.name, p.symbol, p.uri]),
        transactionHash: tx.hash, transactionIndex: '0x1', logIndex: '0x5' },
    ];
    const receipt = { ...f.receipt, transactionHash: tx.hash, transactionIndex: '0x1', logs };
    const rpcMock = f.rpc as ReturnType<typeof vi.fn>, original = rpcMock.getMockImplementation()! as (method: string, params: unknown[]) => Promise<unknown>;
    rpcMock.mockImplementation(async (method: string, params: unknown[]) => {
      if (method === 'eth_getTransactionReceipt' && params[0] === tx.hash) return receipt;
      const filter = params[0] as { address?: unknown };
      if (method === 'eth_getLogs' && Array.isArray(filter.address) && filter.address.includes(stockwave.FRESH_STOCKWAVE_FACTORY)) return [firstLaunch, logs[1]];
      return original(method, params);
    });
    const page = await collectFreshPage({ rpc: f.rpc, checkpoint, wallets: [] });
    expect(page.launches.map(fact => fact.tokenAddress)).toEqual([f.swave, secondToken]);
    expect(code).toHaveBeenCalledExactlyOnceWith(f.rpc, f.block);
  });

  it('does not produce a committable page if an unmonitored creation receipt is missing', async () => {
    const f = stockwaveCaptureFixture({ missing: true }), code = vi.spyOn(stockwave, 'readFreshStockwaveCodeEvidence').mockResolvedValue(f.proof);
    await expect(collectFreshPage({ rpc: f.rpc, checkpoint, wallets: [] })).rejects.toThrow('required_receipt_missing');
    expect(code).not.toHaveBeenCalled();
  });

  it('matches the discovered factory log against the complete receipt before code reads', async () => {
    const f = stockwaveCaptureFixture({ mismatchDiscovery: true }), code = vi.spyOn(stockwave, 'readFreshStockwaveCodeEvidence').mockResolvedValue(f.proof);
    await expect(collectFreshPage({ rpc: f.rpc, checkpoint, wallets: [] })).rejects.toThrow('receipt_discovery_mismatch');
    expect(code).not.toHaveBeenCalled();
  });

  it('never turns a spoofed factory-shaped token identity into eligibility', async () => {
    const f = stockwaveCaptureFixture({ spoofToken: true }); vi.spyOn(stockwave, 'readFreshStockwaveCodeEvidence').mockResolvedValue(f.proof);
    const page = await collectFreshPage({ rpc: f.rpc, checkpoint, wallets: [] });
    expect(page.launches).toHaveLength(0); expect(page.blocks).toHaveLength(1);
    expect(page.receipts).toEqual([expect.objectContaining({ receipt: f.receipt, wallets: [],
      launchRepair: { version: 1, kind: 'stockwave', reason: 'factory_creation_proof_invalid' } })]);
  });

  it('keeps normal watched-wallet receipt capture alongside authenticated launch facts', async () => {
    const f = stockwaveCaptureFixture(); vi.spyOn(stockwave, 'readFreshStockwaveCodeEvidence').mockResolvedValue(f.proof);
    const page = await collectFreshPage({ rpc: f.rpc, checkpoint, wallets: [{ address: f.creator, fromBlock: 101 }] });
    expect(page.launches).toHaveLength(1); expect(page.receipts).toHaveLength(1);
    expect(page.receipts[0].wallets).toEqual([f.creator]); expect(page.receipts[0].receipt).toEqual(f.receipt);
  });

  it('retains unsupported factory code for repair while raw capture advances', async () => {
    const f = stockwaveCaptureFixture(); vi.spyOn(stockwave, 'readFreshStockwaveCodeEvidence').mockRejectedValue(new Error('factory_runtime_unrecognized'));
    const page = await collectFreshPage({ rpc: f.rpc, checkpoint, wallets: [] });
    expect(page.launches).toHaveLength(0); expect(page.blocks).toHaveLength(1);
    expect(page.receipts).toEqual([expect.objectContaining({ receipt: f.receipt, wallets: [],
      launchRepair: { version: 1, kind: 'stockwave', reason: 'factory_creation_code_unverified' } })]);
    expect(decodeFreshEvidence(encodeFreshEvidence(page.receipts[0])).launchRepair).toEqual(page.receipts[0].launchRepair);
  });
});
