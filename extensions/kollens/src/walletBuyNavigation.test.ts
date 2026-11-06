import { beforeEach, expect, it, vi } from 'vitest';
import { loadWalletBuySettings, saveWalletBuySettings } from './walletBuyDefaults';
import { allWalletBuysAccepted, captureWalletBuyTab, openWalletBuyToken, walletBuyTokenUrl } from './walletBuyNavigation';
import type { WalletBuyResult } from './walletSwap';

const storage = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./platform', () => ({ browserApi: { storage: { local: {
  get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, storage.get(key)])),
  set: async (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) storage.set(key, value);
  },
} } } }));

const token = `0x${'ab'.repeat(20)}`;
const url = `https://gmgn.ai/bsc/token/${token}`;
const sourceTab = { id: 9, windowId: 2, url: 'https://gmgn.ai/?chain=bsc' };
const submitted = (wallet: string): WalletBuyResult => ({ wallet, token, status: 'submitted' });

beforeEach(() => storage.clear());

it('defaults to the same tab and saves an independent single-buy preference', async () => {
  await saveWalletBuySettings({ amounts: { single: '0.05' }, slippageBps: { group: 200 } });
  const original = await loadWalletBuySettings();
  expect(original.singleTokenDestination).toBe('same-tab');
  await saveWalletBuySettings({ amounts: {}, slippageBps: {}, singleTokenDestination: 'new-tab' });
  expect(await loadWalletBuySettings()).toEqual({ ...original, singleTokenDestination: 'new-tab' });
  await saveWalletBuySettings({ amounts: {}, slippageBps: {}, singleTokenDestination: 'same-tab' });
  expect(await loadWalletBuySettings()).toEqual(original);
});

it('uses the click’s owning window for a same-tab buy and opens the exact contract', async () => {
  const tabs = {
    query: vi.fn().mockResolvedValue([sourceTab]), get: vi.fn().mockResolvedValue(sourceTab),
    update: vi.fn().mockResolvedValue(undefined), create: vi.fn(),
  };
  const origin = await captureWalletBuyTab(tabs, 2);
  expect(tabs.query).toHaveBeenCalledWith({ active: true, windowId: 2 });
  expect(await openWalletBuyToken(tabs, token.toUpperCase(), 'same-tab', origin)).toBe(true);
  expect(tabs.get).toHaveBeenCalledWith(9);
  expect(tabs.update).toHaveBeenCalledExactlyOnceWith(9, { url });
  expect(tabs.create).not.toHaveBeenCalled();
});

it('opens a new tab in the source window when selected', async () => {
  const tabs = { get: vi.fn(), update: vi.fn(), create: vi.fn().mockResolvedValue(undefined) };
  expect(await openWalletBuyToken(tabs, token, 'new-tab', sourceTab)).toBe(true);
  expect(tabs.create).toHaveBeenCalledExactlyOnceWith({ url, active: true, windowId: 2 });
  expect(tabs.get).not.toHaveBeenCalled();
  expect(tabs.update).not.toHaveBeenCalled();
  expect(walletBuyTokenUrl(`${token}?ref=other`)).toBeNull();
});

it('keeps the original tab unchanged if it cannot be safely replaced', async () => {
  const tabs = { get: vi.fn(), update: vi.fn(), create: vi.fn() };
  for (const origin of [undefined, { ...sourceTab, url: undefined }, { ...sourceTab, url: 'chrome-extension://fake/popup.html' }]) {
    expect(await openWalletBuyToken(tabs, token, 'same-tab', origin)).toBe(false);
  }
  expect(tabs.get).not.toHaveBeenCalled();
  tabs.get.mockResolvedValueOnce({ ...sourceTab, url: 'https://example.org/' });
  expect(await openWalletBuyToken(tabs, token, 'same-tab', sourceTab)).toBe(false);
  tabs.get.mockResolvedValueOnce({ ...sourceTab, pendingUrl: 'https://example.org/' });
  expect(await openWalletBuyToken(tabs, token, 'same-tab', sourceTab)).toBe(false);
  expect(tabs.update).not.toHaveBeenCalled();
  expect(tabs.create).not.toHaveBeenCalled();
});

it('requires an acknowledged exact-token submission from every selected wallet', () => {
  const wallets = ['wallet-one', 'wallet-two'];
  const results = wallets.map(submitted);
  expect(allWalletBuysAccepted(token, wallets, results)).toBe(true);
  expect(allWalletBuysAccepted(token, wallets, [results[0]])).toBe(false);
  expect(allWalletBuysAccepted(token, wallets, [results[0], results[0]])).toBe(false);
  expect(allWalletBuysAccepted(token, wallets, [results[0], { ...results[1], token: sourceTab.url }])).toBe(false);
  for (const status of ['unknown', 'failed', 'skipped', 'reverted'] as const) {
    expect(allWalletBuysAccepted(token, wallets, [results[0], { ...results[1], status }])).toBe(false);
  }
});
