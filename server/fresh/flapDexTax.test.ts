import { Interface } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type { Rpc } from '../rpc.js';
import { freshConstantCloneRuntime } from './constantMetadataRecovery.js';
import { readFreshFlapDexTax } from './flapDexTax.js';

const taxAbi = new Interface([
  'function mainPool() view returns (address)',
  'function getPoolStateData() view returns (uint8,uint16,uint16,uint256,uint256,uint256)',
]);
const token = '0x74324d060c36b004ee92dd00a19910dff62a7777';
const market = '0xf1fd3715af97c9dfd15e127c5099d3536e181197';
const block = {
  hash: '0x67feb0b9c70baae15562f7d2c6df975775f46d2eca7b9b4cec9c1dc55ba8af1b',
  timestamp: new Date(1794596860 * 1000).toISOString(),
};
const rates = { buyTaxBps: 0, sellTaxBps: 100 };
const expiry = 4948172517;

function fixture(overrides: { code?: string; pool?: string; state?: number; expiry?: number; buy?: number; sell?: number; failed?: boolean } = {}) {
  return vi.fn(async (method: string, params: unknown[]) => {
    expect(params[1]).toEqual({ blockHash: block.hash, requireCanonical: true });
    if (method === 'eth_getCode') {
      expect(params[0]).toBe(token);
      return overrides.code ?? freshConstantCloneRuntime('flap');
    }
    expect(method).toBe('eth_call');
    const { to, data } = params[0] as { to: string; data: string };
    expect(to).toBe(token);
    const fn = taxAbi.getFunction(data)?.name;
    if (fn === 'mainPool') return taxAbi.encodeFunctionResult(fn, [overrides.pool ?? market]);
    if (fn === 'getPoolStateData' && !overrides.failed) {
      return taxAbi.encodeFunctionResult(fn, [
        overrides.state ?? 2, overrides.buy ?? 0, overrides.sell ?? 100, 4n * 10n ** 23n,
        overrides.expiry ?? expiry, 1794658917,
      ]);
    }
    throw Error('unsupported_state');
  });
}

describe('graduated Flap V3 market tax', () => {
  it('retains Yellow Room’s asymmetric active rates for its exact market', async () => {
    const rpc = fixture();
    await expect(readFreshFlapDexTax(rpc as Rpc, block, token, market, rates))
      .resolves.toEqual({ ...rates, expiresAtSeconds: expiry });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('retains explicit tax-free state and stops serving elapsed active rates', async () => {
    await expect(readFreshFlapDexTax(fixture({ state: 4, sell: 0 }) as Rpc, block, token, market, rates))
      .resolves.toEqual({ buyTaxBps: 0, sellTaxBps: 0 });
    await expect(readFreshFlapDexTax(fixture({ expiry: 1794596859 }) as Rpc, block, token, market, rates))
      .resolves.toBeUndefined();
  });

  it.each([
    { code: '0x' }, { pool: '0x' + '3'.repeat(40) }, { state: 1 },
    { state: 4 }, { sell: 200 }, { failed: true },
  ])('leaves unsupported or contradictory market evidence unknown (%j)', async overrides => {
    await expect(readFreshFlapDexTax(fixture(overrides) as Rpc, block, token, market, rates))
      .resolves.toBeUndefined();
  });
});
