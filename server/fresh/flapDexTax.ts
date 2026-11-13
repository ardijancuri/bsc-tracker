import { Interface, ZeroAddress } from 'ethers';
import type { Rpc } from '../rpc.js';
import { freshAddress, freshHash } from './capture.js';
import { freshConstantCloneRuntime } from './constantMetadataRecovery.js';

const taxAbi = new Interface([
  'function mainPool() view returns (address)',
  'function getPoolStateData() view returns (uint8 state,uint16 buyTaxRate,uint16 sellTaxRate,uint256 liquidationThreshold,uint256 taxExpirationTime,uint256 antiFarmerExpirationTime)',
]);

interface TaxRates {
  buyTaxBps: number;
  sellTaxBps: number;
}

interface FlapDexTax extends TaxRates {
  expiresAtSeconds?: number;
}

function validRate(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 10_000;
}

/** The caller must authenticate the graduated Flap V3 lens and its quote.
 * Confirm that the selected market is the main pool of the official clone
 * before applying its block-pinned transfer tax to either side. */
export async function readFreshFlapDexTax(
  rpc: Rpc, block: { hash: string; timestamp: string },
  tokenAddress: string, marketAddress: string, configured: TaxRates,
): Promise<FlapDexTax | undefined> {
  const token = freshAddress(tokenAddress), market = freshAddress(marketAddress);
  const blockHash = freshHash(block.hash);
  const observedAt = Date.parse(block.timestamp) / 1000;
  if (!token || !market || token === ZeroAddress || market === ZeroAddress || token === market
    || !blockHash || !Number.isSafeInteger(observedAt) || observedAt < 0
    || !validRate(configured.buyTaxBps) || !validRate(configured.sellTaxBps)) return;

  const at = { blockHash, requireCanonical: true };
  async function read(method: string) {
    const raw = await rpc<string>('eth_call', [{ to: token, data: taxAbi.encodeFunctionData(method) }, at]);
    const result = taxAbi.decodeFunctionResult(method, raw);
    if (taxAbi.encodeFunctionResult(method, [...result]) !== raw.toLowerCase()) throw Error('flap_tax_state_invalid');
    return result;
  }

  try {
    const [runtime, main, state] = await Promise.all([
      rpc<string>('eth_getCode', [token, at]),
      read('mainPool'),
      read('getPoolStateData'),
    ]);
    if (runtime !== freshConstantCloneRuntime('flap') || freshAddress(main[0]) !== market) return;

    const buyTaxBps = Number(state.buyTaxRate), sellTaxBps = Number(state.sellTaxRate);
    if (state.state === 4n && buyTaxBps === 0 && sellTaxBps === 0) return { buyTaxBps, sellTaxBps };

    const expiresAtSeconds = Number(state.taxExpirationTime);
    // The transition to TaxFree occurs during a sell to the main pool.
    // Past expiry the old getters alone cannot establish both effective rates.
    if ((state.state !== 2n && state.state !== 3n)
      || !Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds < observedAt
      || buyTaxBps !== configured.buyTaxBps || sellTaxBps !== configured.sellTaxBps) return;
    return { buyTaxBps, sellTaxBps, expiresAtSeconds };
  } catch {
    // Tax enrichment is optional. A failed getter must leave pricing usable.
    return undefined;
  }
}
