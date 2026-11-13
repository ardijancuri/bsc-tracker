import { ZeroAddress } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { FOUR_MANAGERS, WBNB } from '../launchpad.js';
import { readFreshFourMemeMarketTax } from './fourMemeMarketTax.js';

const tokenAddress = '0x' + 'a'.repeat(40);
const poolAddress = '0x' + 'b'.repeat(40);
const manager = FOUR_MANAGERS[1];
const curve = {
  tokenAddress, manager, version: 2n, helperQuoteAddress: ZeroAddress, liquidityAdded: false,
  market: { address: manager, protocol: 'fourmeme', quoteAddress: WBNB },
};
const migrated = {
  ...curve, liquidityAdded: true,
  market: { address: poolAddress, protocol: 'pcs_v2', quoteAddress: WBNB },
};

function contractReads({
  creator = 9n, status = 0n, base = tokenAddress, quote = ZeroAddress, offers = 10n,
  pair = poolAddress, buy = 0n, sell = 4n, rate = 350n, rejected,
}: {
  creator?: bigint; status?: bigint; base?: string; quote?: string; offers?: bigint;
  pair?: string; buy?: bigint; sell?: bigint; rate?: bigint; rejected?: string;
} = {}) {
  const getters = {
    _tokenInfos: [base, quote, (creator << 10n) | 3n, 0n, 0n, 0n, 0n, offers, 0n, 0n, 0n, 0n, status],
    pair: [pair], feeRateBuy: [buy], feeRateSell: [sell], feeRate: [rate],
  } as const;
  const read: Parameters<typeof readFreshFourMemeMarketTax>[1] = async (address, abi, method, args) => {
    if (method === rejected) throw Error('Unavailable confirmed state');
    if (method === '_tokenInfos') {
      expect(address).toBe(manager);
      expect(args).toEqual([tokenAddress]);
    } else {
      expect(address).toBe(tokenAddress);
    }
    const result = getters[method as keyof typeof getters];
    if (!result) throw Error('Unexpected contract read');
    return abi.decodeFunctionResult(method, abi.encodeFunctionResult(method, result));
  };
  return vi.fn(read);
}

describe('Four.Meme market tax', () => {
  it.each([8n, 9n])('reads separate curve tax rates for creator type %s in basis points', async creator => {
    const call = contractReads({ creator });
    expect(await readFreshFourMemeMarketTax(curve, call)).toEqual({ buyTaxBps: 0, sellTaxBps: 400 });
    expect(call.mock.calls.map(([, , method]) => method)).toEqual(['_tokenInfos', 'feeRateBuy', 'feeRateSell']);
  });

  it('uses the symmetric rate only for the migrated classic tax token and its exact pair', async () => {
    const call = contractReads({ creator: 5n, status: 3n, offers: 0n });
    expect(await readFreshFourMemeMarketTax(migrated, call)).toEqual({ buyTaxBps: 350, sellTaxBps: 350 });
    expect(call.mock.calls.map(([, , method]) => method)).toEqual(['_tokenInfos', 'pair', 'feeRate']);
    expect(await readFreshFourMemeMarketTax(curve, contractReads({ creator: 5n }))).toBeNull();
  });

  it('matches the ERC20 quote and requires the migrated pair before attaching asymmetric rates', async () => {
    const quote = '0x' + 'c'.repeat(40);
    const input = { ...migrated, helperQuoteAddress: quote, market: { ...migrated.market, quoteAddress: quote } };
    expect(await readFreshFourMemeMarketTax(input, contractReads({ quote, creator: 8n, status: 3n, buy: 3n, sell: 5n })))
      .toEqual({ buyTaxBps: 300, sellTaxBps: 500 });
    const wrongPool = contractReads({ quote, status: 3n, pair: manager });
    expect(await readFreshFourMemeMarketTax(input, wrongPool)).toBeNull();
    expect(wrongPool.mock.calls.map(([, , method]) => method)).toEqual(['_tokenInfos', 'pair']);
  });

  it('rejects unsupported provenance, mismatched registration, inactive curves and unavailable rates', async () => {
    const unused = contractReads();
    expect(await readFreshFourMemeMarketTax({ ...curve, manager: FOUR_MANAGERS[0] }, unused)).toBeNull();
    expect(await readFreshFourMemeMarketTax({ ...migrated, market: { ...migrated.market, protocol: 'pcs_v3' } }, unused)).toBeNull();
    expect(unused).not.toHaveBeenCalled();
    for (const options of [
      { creator: 0n }, { base: poolAddress }, { quote: WBNB }, { status: 1n }, { status: 3n }, { offers: 0n },
      { sell: 11n }, { rejected: 'feeRateSell' },
    ]) {
      expect(await readFreshFourMemeMarketTax(curve, contractReads(options))).toBeNull();
    }
  });
});
