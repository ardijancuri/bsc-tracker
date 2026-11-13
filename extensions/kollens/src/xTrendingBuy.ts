import { extensionAddress, type ExtensionTokenIdentity } from '../../../shared/extension';
import { isTrendingWindow } from '../../../shared/trendingTokens';
import { browserApi as chrome } from './platform';
import { getXTrendingTokens, isDisplayableXTrendingToken, isXPage, xTrendingSiteAllowed } from './xTrendingAccess';

declare const __LOCAL_FIXTURE__: boolean;

const xOrigin = 'https://x.com';
const fixtureOrigin = 'http://127.0.0.1:3360';
const inactive = 'The X tab changed before the buy could start.';
const reviewLifetimeMs = 60_000;
const reviewUnavailable = 'This buy review expired. Open Buy again from Trending Tokens.';
const failure = (error: string) => ({ ok: false as const, error });

export interface XTrendingBuyReview {
  token: ExtensionTokenIdentity;
  source: Pick<chrome.tabs.Tab, 'id' | 'windowId' | 'url' | 'pendingUrl'>;
}

const reviewUrl = (id: string) => chrome.runtime.getURL(`panel.html?xBuy=${id}`);

function pageOrigin(url: string | undefined) {
  if (isXPage(url)) return xOrigin;
  if (__LOCAL_FIXTURE__ && url) {
    try {
      const page = new URL(url);
      if (page.origin === fixtureOrigin && page.pathname === '/x-fixture') return fixtureOrigin;
    } catch {}
  }
}

export class XTrendingBuy {
  private request: { tabId: number; controller: AbortController } | undefined;
  private review: { id: string; expiresAt: number; value: XTrendingBuyReview } | undefined;

  invalidateTab(tabId: number) {
    if (this.request?.tabId === tabId) this.request.controller.abort();
  }

  readReview(id: unknown, sender: chrome.runtime.MessageSender) {
    const review = this.review;
    if (typeof id !== 'string' || !review || review.id !== id || sender.id !== chrome.runtime.id ||
        sender.url !== reviewUrl(id) || sender.frameId !== 0 ||
        (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active')) return failure(reviewUnavailable);
    this.review = undefined;
    return Date.now() < review.expiresAt ? { ok: true as const, review: review.value } : failure(reviewUnavailable);
  }

  async openReview(address: unknown, window: unknown, sender: chrome.runtime.MessageSender) {
    const { id: tabId, windowId } = sender.tab ?? {};
    const { documentId } = sender;
    const origin = pageOrigin(sender.url);
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || tabId == null || windowId == null ||
        !documentId || !origin || (sender.origin !== undefined && sender.origin !== origin) ||
        (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') ||
        !extensionAddress(address) || !isTrendingWindow(window)) return failure(inactive);

    if (this.request) return failure('A Trending Tokens buy is already in progress.');
    const request = { tabId, controller: new AbortController() };
    this.request = request;
    const { signal } = request.controller;
    const currentSource = async () => {
      if (signal.aborted) return;
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab?.id !== tabId || tab.windowId !== windowId || !tab.active || !tab.url ||
          pageOrigin(tab.url) !== origin || (tab.pendingUrl && tab.pendingUrl !== tab.url) ||
          (origin === xOrigin && !await xTrendingSiteAllowed())) return;
      // Only the isolated content document that observed the physical click can answer this.
      const probe = await chrome.tabs.sendMessage(tabId, { kind: 'x-trending/buy-source', address, window },
        { documentId }).catch(() => undefined);
      if (probe?.ok !== true || signal.aborted) return;
      return { id: tabId, url: tab.url, windowId, pendingUrl: tab.pendingUrl };
    };

    try {
      const source = await currentSource();
      if (!source) return failure(inactive);
      const list = await getXTrendingTokens(window);
      const item = list.items.find(item => isDisplayableXTrendingToken(item) && item.address === address);
      if (!item) return failure('This token is no longer in Trending for that time window.');
      if ((await currentSource())?.url !== source.url) return failure(inactive);

      const id = crypto.randomUUID();
      const review = {
        id, expiresAt: Date.now() + reviewLifetimeMs,
        value: { source, token: {
          chainId: 56 as const, address,
          name: typeof item.name === 'string' ? item.name : '',
          symbol: typeof item.symbol === 'string' ? item.symbol : '',
        } },
      };
      this.review = review;
      try {
        await chrome.tabs.create({ url: reviewUrl(id), active: true, windowId });
      } catch {
        if (this.review === review) this.review = undefined;
        return failure('Could not open the Kollens buy review. Try again.');
      }
      return { ok: true as const };
    } catch {
      return failure('Could not open the Kollens buy review. Try again.');
    } finally {
      this.request = undefined;
    }
  }
}
