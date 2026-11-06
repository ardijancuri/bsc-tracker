import type { WalletBuyDestination } from './walletBuyDefaults';
import type { WalletBuyResult } from './walletSwap';

type BuyTab = Pick<chrome.tabs.Tab, 'id' | 'windowId' | 'url' | 'pendingUrl'>;
type QueryBuyTabs = (query: chrome.tabs.QueryInfo) => Promise<BuyTab[]>;
interface NavigateBuyTabs {
  get(id: number): Promise<BuyTab>;
  update(id: number, changes: chrome.tabs.UpdateProperties): Promise<unknown>;
  create(properties: chrome.tabs.CreateProperties): Promise<unknown>;
}

export async function captureWalletBuyTab(tabs: { query: QueryBuyTabs }, windowId?: number): Promise<BuyTab | undefined> {
  try {
    return (await tabs.query(windowId === undefined ? { active: true, currentWindow: true } : { active: true, windowId }))[0];
  } catch {
    return undefined;
  }
}

export function walletBuyTokenUrl(address: string): string | null {
  return /^0x[a-f0-9]{40}$/i.test(address) ? `https://gmgn.ai/bsc/token/${address.toLowerCase()}` : null;
}

export function allWalletBuysAccepted(address: string, wallets: readonly string[], results: readonly WalletBuyResult[]): boolean {
  const expected = new Set(wallets.map(wallet => wallet.toLowerCase()));
  return expected.size > 0 && results.length === expected.size && results.every(result =>
    result.token.toLowerCase() === address.toLowerCase() &&
    (result.status === 'submitted' || result.status === 'confirmed') &&
    expected.delete(result.wallet.toLowerCase()));
}

export async function openWalletBuyToken(tabs: NavigateBuyTabs, address: string, destination: WalletBuyDestination,
  origin: BuyTab | undefined): Promise<boolean> {
  const url = walletBuyTokenUrl(address);
  if (!url) return false;
  if (destination === 'new-tab') {
    await tabs.create({ url, active: true, ...(origin ? { windowId: origin.windowId } : {}) });
    return true;
  }
  // Only replace the tab the click came from, while it still shows that page.
  if (origin?.id === undefined || !origin.url || !/^https?:\/\//.test(origin.url) ||
      (origin.pendingUrl && origin.pendingUrl !== origin.url)) return false;
  const current = await tabs.get(origin.id);
  if (current.windowId !== origin.windowId || current.url !== origin.url ||
      (current.pendingUrl && current.pendingUrl !== origin.url)) return false;
  await tabs.update(origin.id, { url });
  return true;
}
