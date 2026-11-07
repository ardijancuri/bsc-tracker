import { isTrendingWindow, type TrendingToken, type TrendingTokens, type TrendingWindow } from '../../../shared/trendingTokens';
import { extensionAddress } from '../../../shared/extension';
import { browserApi as chrome, config } from './platform';

export const xTrendingOrigins = ['https://x.com/*'];
const registrationId = 'kollens-x-trending';
let permissionWork = Promise.resolve();
export type XTrendingResponse = Omit<TrendingTokens,'items'> & { items: (TrendingToken & { thumbnail: string | null })[] };
const cache = new Map<TrendingWindow, { expires: number; result: Promise<XTrendingResponse> }>();
const thumbnails = new Map<string, { expires: number; data: Promise<string | null> }>();
const thumbnailLimit = 64 * 1024;

export function isXPage(url: string | undefined) {
  if (!url) return false;
  try {
    const page = new URL(url);
    return page.protocol === 'https:' && page.origin === 'https://x.com';
  } catch { return false; }
}

export function xTrendingSiteAllowed() {
  return chrome.permissions.contains({ origins: xTrendingOrigins });
}

export function refreshXTrendingAccess(reinject = false) {
  const next = permissionWork.then(async () => {
    const [allowed, registered] = await Promise.all([
      xTrendingSiteAllowed(),
      chrome.scripting.getRegisteredContentScripts({ ids: [registrationId] }),
    ]);
    if (!allowed) {
      if (!registered.length) return;
      await chrome.scripting.unregisterContentScripts({ ids: [registrationId] });
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.map(tab => tab.id == null ? null :
        chrome.tabs.sendMessage(tab.id, { kind: 'x-trending/stop' }).catch(() => {})));
      return;
    }
    if (!registered.length) {
      await chrome.scripting.registerContentScripts([{
        id: registrationId, matches: xTrendingOrigins, js: ['x-trending.js'], runAt: 'document_end', world: 'ISOLATED',
      }]);
    } else if (!reinject) return;
    const tabs = await chrome.tabs.query({ url: xTrendingOrigins });
    await Promise.all(tabs.map(tab => tab.id == null || !isXPage(tab.url) ? null :
      chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['x-trending.js'], world: 'ISOLATED' }).catch(() => {})));
  });
  permissionWork = next.catch(() => {});
  return next;
}

declare const __LOCAL_FIXTURE__: boolean;

async function readThumbnail(url: URL) {
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(2_500) });
  const mime = response.headers.get('Content-Type')?.split(';')[0];
  if (!response.ok || !mime || !/^image\/(?:png|jpeg|webp|avif)$/.test(mime)) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  let bytes = 0, binary = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes ? `data:${mime};base64,${btoa(binary)}` : null;
      bytes += value.byteLength;
      if (bytes > thumbnailLimit) {
        await reader.cancel();
        return null;
      }
      for (const byte of value) binary += String.fromCharCode(byte);
    }
  } finally {
    reader.releaseLock();
  }
}

function thumbnail(item: TrendingToken) {
  if (!item.logoUrl || !extensionAddress(item.address)) return null;
  let url: URL;
  try { url = new URL(item.logoUrl, config.apiOrigin); } catch { return null; }
  // X permits inline raster images but blocks direct requests to our CDN.
  // Resolve only Kollens-hosted artwork belonging to this result.
  if (url.origin !== config.apiOrigin || url.username || url.password || url.search || url.hash ||
    (url.pathname !== '/api/token-image/' + item.address &&
      !/^\/token-icons\/[a-z0-9_-]+\.(?:png|jpg|webp)$/i.test(url.pathname))) return null;
  const previous = thumbnails.get(url.href);
  if (previous && previous.expires > Date.now()) return previous.data;
  const data = readThumbnail(url).catch(() => null);
  if (thumbnails.size >= 48) thumbnails.delete(thumbnails.keys().next().value!);
  thumbnails.set(url.href, { expires: Date.now() + 300_000, data });
  void data.then(image => { if (!image && thumbnails.get(url.href)?.data === data) thumbnails.delete(url.href); });
  return data;
}

export async function loadXTrendingTokens(window: unknown, sender: chrome.runtime.MessageSender) {
  if (!isTrendingWindow(window) || sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id == null) {
    throw Error('Trending request context rejected');
  }
  const tab = await chrome.tabs.get(sender.tab.id);
  const local = __LOCAL_FIXTURE__ && tab.url?.split('?')[0] === 'http://127.0.0.1:3360/x-fixture';
  if (!local && (!isXPage(tab.url) || !isXPage(sender.url) || !await xTrendingSiteAllowed())) {
    throw Error('Trending request context rejected');
  }
  const previous = cache.get(window);
  if (previous && previous.expires > Date.now()) return previous.result;
  const result = fetch(`${config.apiOrigin}/api/extension/trending-tokens?window=${window}`, {
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(8_000),
  }).then(async response => {
    if (!response.ok) throw Error('Trending tokens are unavailable');
    const data = await response.json() as TrendingTokens;
    if (data.window !== window || !Array.isArray(data.items) || data.items.length > 12) {
      throw Error('Invalid trending token response');
    }
    return { ...data, items: await Promise.all(data.items.map(async item => ({ ...item, thumbnail: await thumbnail(item) }))) };
  });
  cache.set(window, { result, expires: Date.now() + 30_000 });
  void result.catch(() => { if (cache.get(window)?.result === result) cache.delete(window); });
  return result;
}
