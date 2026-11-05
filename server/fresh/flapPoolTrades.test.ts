import { AbiCoder, Interface, ZeroAddress, ZeroHash, toBeHex } from 'ethers';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { FreshScope } from '../../shared/freshAccounting.js';
import { WBNB } from '../launchpad.js';
import { poolMarketAbi } from '../nodeMarketProtocols.js';
import { applyFreshEvent, FreshRational } from './accounting.js';
import { decodeFreshFlapPoolLaunchFact, type FreshBlock, type FreshCapturedReceipt } from './capture.js';
import { freshPoolQuotePair } from './currentPoolQuote.js';
import { normalizeFreshReceipt, type FreshDecodeServices } from './decode.js';
import { FRESH_FLAP_POOL_LAUNCH_TOPIC, FRESH_FLAP_POOL_PORTAL, FRESH_FLAP_POOL_V2_SCHEMA, flapPoolLaunchDataType, flapPoolLaunchInterface } from './flapPoolLaunch.js';

const token = '0x' + '11'.repeat(20), wallet = '0x' + '22'.repeat(20);
const usdt = '0x55d398326f99059ff775485246999027b3197955';
const abi = new Interface([
  'function launchTaxTokenV2((string,string,string,uint256,bytes32,address,uint8,uint256,uint256,uint16,uint16,uint32,uint32,(uint8,uint16,bytes)[],uint8,uint32,address[],uint256,bytes32,bytes,address),(uint8,address,uint128,bytes),(uint256,bytes)) payable',
  'event Mint(address indexed sender,uint256 amount0,uint256 amount1)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);

function fixture(quoteToken: string) {
  const native = quoteToken === ZeroAddress, quote = native ? WBNB : quoteToken;
  const pool = freshPoolQuotePair(token, quote), unit = 10n ** 18n, seed = 10n * unit, spend = 2n * unit;
  const supply = 10_000n * unit, received = 1400n * unit;
  const block = { number: '0x100', hash: toBeHex(100, 32), timestamp: '0x6553f100' };
  const tx = {
    from: wallet, to: FRESH_FLAP_POOL_PORTAL, value: native ? toBeHex(seed + spend) : '0x0',
    hash: toBeHex(200, 32), blockNumber: block.number, blockHash: block.hash, transactionIndex: '0x0',
    type: '0x2', chainId: '0x38',
    input: abi.encodeFunctionData('launchTaxTokenV2', [
      ['Pool Token', 'POOL', '', supply, ZeroHash, quoteToken, 0, seed, supply, 500, 500, 1, 0, [], 0, 0, [], spend, ZeroHash, '0x', ZeroAddress],
      [0, ZeroAddress, 0, '0x'], [received, '0x'],
    ]),
  };
  const entry: FreshCapturedReceipt = { transaction: tx, wallets: [wallet], observedAt: '',
    receipt: { transactionHash: tx.hash, transactionIndex: tx.transactionIndex, blockNumber: block.number, blockHash: block.hash,
      gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', status: '0x1', logs: [] } };
  const add = (address: string, log: { topics: string[]; data: string }) => entry.receipt.logs.push({
    address, ...log, logIndex: toBeHex(entry.receipt.logs.length), blockHash: block.hash, blockNumber: block.number,
    transactionHash: tx.hash, transactionIndex: tx.transactionIndex,
  });
  const transfer = (asset: string, from: string, to: string, amount: bigint) => add(asset, abi.encodeEventLog('Transfer', [from, to, amount]));
  transfer(token, ZeroAddress, FRESH_FLAP_POOL_PORTAL, supply);
  if (!native) transfer(quote, wallet, FRESH_FLAP_POOL_PORTAL, seed);
  transfer(quote, FRESH_FLAP_POOL_PORTAL, pool, seed);
  add(pool, abi.encodeEventLog('Mint', [FRESH_FLAP_POOL_PORTAL, supply, seed]));
  const payload = AbiCoder.defaultAbiCoder().encode([flapPoolLaunchDataType],
    [[1n, BigInt(block.timestamp), 0n, quoteToken, 1n, unit / 1000n, 'Pool Token', 'POOL', '', pool, supply, 0n, 0n]]);
  add(FRESH_FLAP_POOL_PORTAL, flapPoolLaunchInterface.encodeEventLog('FlapDirectLaunched', [token, 0, wallet, FRESH_FLAP_POOL_V2_SCHEMA, payload]));
  if (!native) transfer(quote, wallet, FRESH_FLAP_POOL_PORTAL, spend);
  transfer(quote, FRESH_FLAP_POOL_PORTAL, pool, spend);
  transfer(token, pool, wallet, received);
  add(pool, poolMarketAbi.encodeEventLog('Swap', [FRESH_FLAP_POOL_PORTAL, 0n, spend, received, 0n, wallet]));
  const priceBlock = { number: 256, hash: block.hash, timestamp: '2023-11-14T22:13:20.000Z' };
  const services = {
    metadata: async (address: string) => ({ address, decimals: 18, name: 'Pool Token', symbol: 'POOL', block: priceBlock, supplyRaw: null }),
    eligible: async ({ address }: { address: string }) => address === token,
    knownLaunch: async (address: string) => address === token,
    priceUsd: async (address: string) => address === WBNB ? '600' : address === usdt ? '1' : null,
    trace: vi.fn(async () => null),
  };
  return { entry, block, services };
}

describe('Flap Pool creator purchases', () => {
  it.each([[ZeroAddress, 'BNB', '1200'], [usdt, 'USDT', '2']])('records the purchase alone for quote %s', async (quote, symbol, amountUsd) => {
    const { entry, block, services } = fixture(quote);
    expect(String(entry.transaction.input).slice(0, 10)).toBe('0x67e258b6');
    const decoded = await normalizeFreshReceipt(entry, block, services);
    expect(decoded.reasons).toEqual([]);
    expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]).toMatchObject({ kind: 'buy', quantity: '1400', quoteSymbol: symbol, quoteAmount: '2', amountUsd, feeUsd: '0.0126' });
    expect(services.trace).not.toHaveBeenCalled();
  });

  it('keeps an unsupported creator settlement pending even if a trace reports the whole launch payment', async () => {
    const { entry, block, services } = fixture(ZeroAddress);
    entry.transaction.value = toBeHex(13n * 10n ** 18n);
    const decoded = await normalizeFreshReceipt(entry, block, services);
    expect(decoded.events).toEqual([]);
    expect(decoded.reasons).toEqual(['flap_pool_creator_buy_unverified']);
    expect(services.trace).not.toHaveBeenCalled();
  });

  it('does not interpret distributions or seeding as a buy when the launch pool has no swap', async () => {
    const { entry, block, services } = fixture(ZeroAddress);
    const unrelated = entry.receipt.logs.find(log => log.topics[0] === poolMarketAbi.getEvent('Swap')!.topicHash)!;
    unrelated.address = '0x' + '33'.repeat(20);
    const decoded = await normalizeFreshReceipt(entry, block, services);
    expect(decoded.events.map(event => event.kind)).toEqual(['transfer_in']);
  });
});

it('accounts for a real Flap Pool buy and sell using exact WBNB transfers and the dated feed', async () => {
  const chain = JSON.parse(readFileSync(new URL('./fixtures/flapPoolLaunchChain.json', import.meta.url), 'utf8')) as {
    token: string; wallet: string; launch: FreshCapturedReceipt & { block: FreshBlock };
    buy: FreshCapturedReceipt & { block: FreshBlock }; sell: FreshCapturedReceipt & { block: FreshBlock };
  };
  const launchBlock = Number(BigInt(chain.launch.block.number));
  const log = chain.launch.receipt.logs.find(log => log.topics[0] === FRESH_FLAP_POOL_LAUNCH_TOPIC)!;
  const launch = decodeFreshFlapPoolLaunchFact(log, chain.launch.block, launchBlock - 1)!;
  const trace = vi.fn(async () => null);
  const decode = (sample: typeof chain.buy) => {
    const block = { number: Number(BigInt(sample.block.number)), hash: sample.block.hash, timestamp: new Date(Number(BigInt(sample.block.timestamp)) * 1000).toISOString() };
    const services: FreshDecodeServices = {
      metadata: async address => ({ address, decimals: 18, supplyRaw: null, name: String(launch.proof.name), symbol: String(launch.proof.symbol), block }),
      knownLaunch: async address => address === chain.token,
      eligible: async ({ address }) => address === chain.token,
      tradeAdmission: async address => address === chain.token ? { kind: 'new_launch', fact: launch, fromBlock: launchBlock, launchStatus: 'eligible' } : null,
      priceUsd: async address => address === WBNB ? '713.75256' : null,
      trace,
    };
    return normalizeFreshReceipt({ ...sample, wallets: [chain.wallet], observedAt: block.timestamp }, sample.block, services);
  };
  const buy = await decode(chain.buy), sell = await decode(chain.sell);
  expect(buy.reasons).toEqual([]);
  expect(sell.reasons).toEqual([]);
  expect(buy.events).toEqual([expect.objectContaining({ kind: 'buy', quantity: '1133.234294416661076682', quoteAmount: '0.022', quoteSymbol: 'WBNB', amountUsd: '15.70255632', feeUsd: '0.10731570521074479042624' })]);
  expect(sell.events).toEqual([expect.objectContaining({ kind: 'sell', quantity: '1133.234294416661076682', quoteAmount: '0.023173331575150068', quoteSymbol: 'WBNB', amountUsd: '16.54002473549219341917408', feeUsd: '0.1204191318953903915592' })]);
  expect(trace).not.toHaveBeenCalled();
  const scope: FreshScope = { id: 'kol:' + chain.wallet, kind: 'kol', accountId: null, walletAddresses: [chain.wallet],
    startsAt: launch.launchedAt, startsBlock: String(launchBlock), revision: '1' };
  const open = applyFreshEvent(scope, buy.events[0], { position: null, lots: [] });
  const closed = applyFreshEvent(scope, sell.events[0], open);
  expect(closed.position?.quantityQ).toBe('0');
  expect(FreshRational.parse(closed.result.realizedQ!).decimal()).toBe('0.60973357838605823718864');
});
