import { afterEach, describe, expect, it, vi } from 'vitest';
import { Interface, ZeroAddress } from 'ethers';
import type { Rpc } from '../rpc.js';
import { WBNB, PCS_V2_FACTORY, PCS_V3_FACTORY } from '../launchpad.js';
import { MarketDecimal } from '../nodeMarketMath.js';
import { oracleMarketAbi, poolMarketAbi, TRUSTED_QUOTE_FEEDS } from '../nodeMarketProtocols.js';
import { freshCurrentQuote, type FreshPriceBlock } from './pricing.js';
import {
  FRESH_BSC_GENESIS_HASH, FRESH_STOCKWAVE_CREATION_CODE_HASH, FRESH_STOCKWAVE_DEPLOYER,
  FRESH_STOCKWAVE_DEPLOYER_CODE_HASH, FRESH_STOCKWAVE_FACTORY, FRESH_STOCKWAVE_FACTORY_CODE_HASH,
  FRESH_STOCKWAVE_LAUNCH_TOPIC, freshStockwaveCreate2Address,
} from './factoryLaunch.js';
import * as market from './stockwaveMarket.js';
import * as stock from './stockQuote.js';
import * as currentStock from './stockCurrentQuote.js';

const hash = (digit: string) => `0x${digit.repeat(64)}`;
const token = '0xe36ae6bc18726a84db820ec49dd866145df5a149', pool = `0x${'2'.repeat(40)}`;
const creationHash = '0x03298ef00c64e87255ca243a0559ed36cb25467988ea7fdbcdf781399c5c60cf';
const creationTx = '0x92e90bed43138f30c7be30a4d1b0158ede2775baae32feba5a188d280e8d413f';
const block: FreshPriceBlock = { number: 129204000, hash: hash('a'), timestamp: '2026-10-22T21:45:00.000Z' };
const tokenAbi = new Interface(['function decimals() view returns(uint8)', 'function totalSupply() view returns(uint256)', 'function name() view returns(string)', 'function symbol() view returns(string)']);

function factFixture() {
  const constructor = { name: 'Stockwave.live', symbol: 'Swave', creator: '0x4e67d54e0d2b7ad010d091b288484a647532a14c',
    salt: '0x97a1d230d185059882268fda69f93505755f41fe27af901292dbe16112ac0dff' };
  const identity: market.FreshStockwaveMarketIdentity = { version: 1, manager: market.FRESH_UNISWAP_V4_BSC_MANAGER,
    poolId: '0x0e38433efc106f676d3fc5492de87aa79b1ae02aaf6188e3c9763042e064617c',
    poolKey: { currency0: stock.FRESH_STOCK_QUOTE_TOKEN, currency1: token, fee: 0, tickSpacing: 200, hooks: '0x5e4b06cf354bdfb306d441cad181f5768053a0cc' },
    tokenAddress: token, quoteAddress: stock.FRESH_STOCK_QUOTE_TOKEN,
    initial: { sqrtPriceX96: '716315759258551657759850475898725', tick: 182200, blockNumber: 129181068, blockHash: creationHash, transactionHash: creationTx, logIndex: 219 } };
  return { token_address: token, protocol: 'stockwave', status: 'eligible', block_number: 129181068, block_hash: creationHash,
    tx_hash: creationTx, log_index: 247, launched_at: '2026-10-22T18:51:48.000Z', proof: { version: 1,
      classification: 'authenticated_factory_create2', controller: FRESH_STOCKWAVE_FACTORY, topic: FRESH_STOCKWAVE_LAUNCH_TOPIC,
      deployer: FRESH_STOCKWAVE_DEPLOYER, ...constructor, initcodeHash: freshStockwaveCreate2Address(constructor).initcodeHash,
      calldataHash: hash('b'), launchHash: hash('c'), originChainId: '4663', market: identity,
      historicalCodeBasis: 'bsc_bep344_persistent_runtime_inference', codeEvidence: { version: 1, chainId: 56, genesisHash: FRESH_BSC_GENESIS_HASH,
        observedBlock: { number: 129200291, hash: hash('d'), timestamp: 1792703760 }, factoryRuntimeHash: FRESH_STOCKWAVE_FACTORY_CODE_HASH,
        deployerRuntimeHash: FRESH_STOCKWAVE_DEPLOYER_CODE_HASH, tokenCreationCodeHash: FRESH_STOCKWAVE_CREATION_CODE_HASH,
        immutabilityRule: 'bsc_bep344_eip6780' } } };
}

function rpcFixture(options: { pcs?: boolean; supplyUnavailable?: boolean; decimals?: number; nativeDecimals?: number } = {}) {
  return vi.fn(async (method: string, params: any[]) => {
    expect(method).toBe('eth_call'); expect(params[1]).toEqual({ blockHash: block.hash, requireCanonical: true });
    const call = params[0], to = call.to.toLowerCase();
    if (to === PCS_V2_FACTORY || to === PCS_V3_FACTORY) {
      const parsed = poolMarketAbi.parseTransaction(call)!;
      return poolMarketAbi.encodeFunctionResult(parsed.name, [options.pcs && parsed.name === 'getPair' && String(parsed.args[1]).toLowerCase() === WBNB ? pool : ZeroAddress]);
    }
    if (to === pool) {
      const parsed = poolMarketAbi.parseTransaction(call)!;
      const values: Record<string, unknown[]> = { factory: [PCS_V2_FACTORY], token0: [token], token1: [WBNB], getReserves: [1000n * 10n ** 18n, 10_000n * 10n ** 18n, 123] };
      return poolMarketAbi.encodeFunctionResult(parsed.name, values[parsed.name]);
    }
    const trusted = Object.values(TRUSTED_QUOTE_FEEDS).find(feed => feed.feed === to);
    if (trusted) {
      const parsed = oracleMarketAbi.parseTransaction(call)!;
      const values: Record<string, unknown[]> = { decimals: [8], description: [trusted.description], latestRoundData: [100n, 600n * 10n ** 8n, 1n, BigInt(Date.parse(block.timestamp) / 1000 - 5), 100n] };
      return oracleMarketAbi.encodeFunctionResult(parsed.name, values[parsed.name]);
    }
    if ([token, ...Object.keys(TRUSTED_QUOTE_FEEDS)].includes(to)) {
      const parsed = tokenAbi.parseTransaction(call)!;
      if (parsed.name === 'totalSupply' && options.supplyUnavailable) throw Error('missing_supply');
      const values: Record<string, unknown[]> = { decimals: [to === token ? options.decimals ?? 18 : options.nativeDecimals ?? 18],
        totalSupply: [1000n * 10n ** 18n], name: ['Stockwave.live'], symbol: ['Swave'] };
      return tokenAbi.encodeFunctionResult(parsed.name, values[parsed.name]);
    }
    // In particular, no mutable stock-quote decimals getter is available.
    throw Error('unsupported_state');
  }) as unknown as Rpc;
}

function conversions(age = 0) {
  const current = vi.spyOn(market, 'readFreshStockwaveMarket').mockResolvedValue({ sqrtPriceX96: '123', liquidityRaw: '456',
    rawQuoteRatio: { numerator: '1', denominator: String(7n * 10n ** 18n) }, virtualQuoteLiquidityRaw: { numerator: '30', denominator: '1' } } as any);
  const conversion = vi.spyOn(currentStock, 'readFreshStockCurrentRawQuote').mockResolvedValue({ version: 1, kind: 'woofi_current_query', chainId: 56,
    venue: stock.FRESH_WOOFI_BSC_POOL, quoteToken: stock.FRESH_STOCK_QUOTE_TOKEN, nativeToken: WBNB, target: block,
    source: { number: block.number, hash: block.hash, timestamp: new Date(Date.parse(block.timestamp) - age * 1000).toISOString() },
    nativeRaw: String(10n ** 18n), quoteRaw: '3', quoteDecimals: 6, nativeDecimals: 18,
    venueRuntimeHash: hash('e'), calldataHash: hash('f') } as any);
  return { current, conversion };
}
const canonicalHash = async (number: number) => number === 129181068 ? creationHash : null;
afterEach(() => vi.restoreAllMocks());

describe('current authenticated Stockwave valuation', () => {
  it('cancels raw stock precision exactly and formats only after the USD conversion', async () => {
    const { current } = conversions(), rpc = rpcFixture(), launchFact = factFixture();
    const quote = await freshCurrentQuote(token, { rpc, block, launchFact, canonicalHash });
    expect(quote.priceUsd).toBe(new MarketDecimal(200n, 7n).text());
    expect(quote.marketCapUsd).toBe(new MarketDecimal(200000n, 7n).text());
    expect(quote.metadata).toMatchObject({ decimals: 18, supplyRaw: String(1000n * 10n ** 18n), block });
    expect(quote).toMatchObject({ blockNumber: block.number, blockHash: block.hash, observedAt: block.timestamp,
      market: { protocol: 'uniswap_v4', address: market.FRESH_UNISWAP_V4_BSC_MANAGER, quoteAddress: stock.FRESH_STOCK_QUOTE_TOKEN,
        identity: { poolId: launchFact.proof.market.poolId, stockConversion: { sourceBlock: block.number, observedAt: block.timestamp,
          venueRuntimeHash: hash('e'), calldataHash: hash('f'), quoteDecimals: 6 } } } });
    expect(current).toHaveBeenCalledWith({ rpc, block, identity: launchFact.proof.market, tokenDecimals: 18 });
    expect((rpc as any).mock.calls.some(([, params]: any[]) => params[0].to === stock.FRESH_STOCK_QUOTE_TOKEN)).toBe(false);
    expect(JSON.stringify(quote.market)).not.toMatch(/privateFullReceiptMarker|never retained|"receipt"/);
  });

  it('requires current verified supply and precision independently of immutable launch identity', async () => {
    const { current } = conversions(), launchFact = factFixture();
    await expect(freshCurrentQuote(token, { rpc: rpcFixture({ supplyUnavailable: true }), block, launchFact, canonicalHash })).rejects.toMatchObject({ field: 'total_supply' });
    await expect(freshCurrentQuote(token, { rpc: rpcFixture({ decimals: 6 }), block, launchFact, canonicalHash })).rejects.toThrow('authenticated_market_quote_unavailable');
    expect(current).not.toHaveBeenCalled();
  });

  it.each([1, 120, -1])('rejects a current stock conversion aged %s seconds', async age => {
    conversions(age);
    await expect(freshCurrentQuote(token, { rpc: rpcFixture(), block, launchFact: factFixture(), canonicalHash })).rejects.toThrow('authenticated_market_quote_unavailable');
  });
  it('requires the current conversion source block and hash to match the current pool state', async () => {
    const { conversion } = conversions();
    const proof = await conversion.getMockImplementation()!({ rpc: rpcFixture(), block });
    conversion.mockResolvedValue({ ...proof, source: { ...block, hash: hash('e') } });
    await expect(freshCurrentQuote(token, { rpc: rpcFixture(), block, launchFact: factFixture(), canonicalHash })).rejects.toThrow('authenticated_market_quote_unavailable');
  });
  it('rejects an unverified native precision', async () => {
    conversions();
    await expect(freshCurrentQuote(token, { rpc: rpcFixture({ nativeDecimals: 6 }), block, launchFact: factFixture(), canonicalHash })).rejects.toThrow('authenticated_market_quote_unavailable');
  });
  it.each(['constructor', 'poolId', 'creation', 'canonical'] as const)('rejects changed %s proof before market state or conversion reads', async changed => {
    const { current, conversion } = conversions(), launchFact = factFixture();
    if (changed === 'constructor') launchFact.proof.name = 'Other';
    if (changed === 'poolId') launchFact.proof.market.poolId = hash('c');
    if (changed === 'creation') launchFact.proof.market.initial.blockHash = hash('c');
    await expect(freshCurrentQuote(token, { rpc: rpcFixture(), block, launchFact,
      canonicalHash: changed === 'canonical' ? async () => hash('c') : canonicalHash })).rejects.toThrow('authenticated_market_quote_unavailable');
    expect(current).not.toHaveBeenCalled(); expect(conversion).not.toHaveBeenCalled();
  });
  it('chooses a deeper authenticated pool and uses its own current observation time', async () => {
    conversions();
    const quote = await freshCurrentQuote(token, { rpc: rpcFixture({ pcs: true }), block, launchFact: factFixture(), canonicalHash });
    expect(quote).toMatchObject({ priceUsd: '6000', observedAt: block.timestamp, market: { protocol: 'pcs_v2', quoteAddress: WBNB, address: pool } });
    expect(quote.market.identity).not.toHaveProperty('stockConversion');
  });
});
