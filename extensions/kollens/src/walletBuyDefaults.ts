import { browserApi } from './platform';
import { maxWalletBuySlippageBps, parseWalletBuyAmount } from './walletSwap';

export interface WalletBuyAmounts {
  single: string;
  group: string;
}

export type WalletBuyMode = keyof WalletBuyAmounts;
export type WalletBuyPresets = Record<WalletBuyMode, readonly string[]>;
export type WalletBuySlippage = Record<WalletBuyMode, number>;
export type WalletBuyDestination = 'same-tab' | 'new-tab';
export const defaultWalletBuyPresets = ['0.01', '0.025', '0.05', '0.1'] as const;
export const defaultWalletBuySlippageBps = 100;
export const defaultWalletBuyMaxFeeBnb = '0.002';
export const defaultWalletBuyDestination: WalletBuyDestination = 'same-tab';

export interface WalletBuySettings {
  amounts: WalletBuyAmounts;
  presets: WalletBuyPresets;
  slippageBps: WalletBuySlippage;
  maxFeeBnb: string;
  singleTokenDestination: WalletBuyDestination;
}

const amountKeys = {
  single: 'wallet-buy-default:single',
  group: 'wallet-buy-default:group',
} as const;

const presetKeys = {
  single: 'wallet-buy-presets:single',
  group: 'wallet-buy-presets:group',
} as const;

const slippageKeys = {
  single: 'wallet-buy-slippage:single',
  group: 'wallet-buy-slippage:group',
} as const;
const maxFeeKey = 'wallet-buy-max-fee-bnb';
const destinationKey = 'wallet-buy-single-token-destination';

function storedAmount(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '';
  try {
    parseWalletBuyAmount(value);
    return value;
  } catch {
    return '';
  }
}

function validatedPresets(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length !== defaultWalletBuyPresets.length ||
      !value.every(amount => typeof amount === 'string')) return null;
  const presets = value.map(amount => amount.trim());
  try {
    return new Set(presets.map(parseWalletBuyAmount)).size === presets.length ? presets : null;
  } catch {
    return null;
  }
}

function validSlippageBps(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxWalletBuySlippageBps;
}

export function parseWalletBuySlippage(value: string): number | null {
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return validSlippageBps(basisPoints) ? basisPoints : null;
}

export async function loadWalletBuySettings(): Promise<WalletBuySettings> {
  const stored = await browserApi.storage.local.get([
    ...Object.values(amountKeys), ...Object.values(presetKeys), ...Object.values(slippageKeys), maxFeeKey, destinationKey,
  ]);
  const single = stored[slippageKeys.single];
  const group = stored[slippageKeys.group];
  return {
    amounts: { single: storedAmount(stored[amountKeys.single]), group: storedAmount(stored[amountKeys.group]) },
    presets: {
      single: validatedPresets(stored[presetKeys.single]) ?? defaultWalletBuyPresets,
      group: validatedPresets(stored[presetKeys.group]) ?? defaultWalletBuyPresets,
    },
    slippageBps: {
      single: validSlippageBps(single) ? single : defaultWalletBuySlippageBps,
      group: validSlippageBps(group) ? group : defaultWalletBuySlippageBps,
    },
    maxFeeBnb: storedAmount(stored[maxFeeKey]) || defaultWalletBuyMaxFeeBnb,
    singleTokenDestination: stored[destinationKey] === 'new-tab' ? 'new-tab' : defaultWalletBuyDestination,
  };
}

export async function saveWalletBuyPresets(mode: WalletBuyMode, values: readonly string[]): Promise<string[] | null> {
  const presets = validatedPresets(values);
  if (presets) await browserApi.storage.local.set({ [presetKeys[mode]]: presets });
  return presets;
}

export async function saveWalletBuySettings({ amounts, slippageBps, maxFeeBnb, singleTokenDestination }: {
  amounts: Partial<WalletBuyAmounts>;
  slippageBps: Partial<WalletBuySlippage>;
  maxFeeBnb?: string;
  singleTokenDestination?: WalletBuyDestination;
}): Promise<void> {
  const updates: Record<string, string | number> = {};
  for (const mode of ['single', 'group'] as const) {
    const amount = amounts[mode];
    if (amount !== undefined) {
      if (amount !== '') parseWalletBuyAmount(amount);
      updates[amountKeys[mode]] = amount;
    }
    const slippage = slippageBps[mode];
    if (slippage !== undefined) {
      if (!validSlippageBps(slippage)) throw new Error('Invalid buy slippage.');
      updates[slippageKeys[mode]] = slippage;
    }
  }
  if (maxFeeBnb !== undefined) {
    parseWalletBuyAmount(maxFeeBnb);
    updates[maxFeeKey] = maxFeeBnb;
  }
  if (singleTokenDestination !== undefined) updates[destinationKey] = singleTokenDestination;
  if (Object.keys(updates).length) await browserApi.storage.local.set(updates);
}
