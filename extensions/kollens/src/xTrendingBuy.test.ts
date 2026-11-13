import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { XTrendingBuy } from './xTrendingBuy';

const api = vi.hoisted(() => ({
  runtime: { id: 'kollens', getURL: (path: string) => 'chrome-extension://kollens/' + path },
  tabs: { get: vi.fn(), sendMessage: vi.fn(), create: vi.fn() },
}));
const access = vi.hoisted(() => ({ allowed: vi.fn(), list: vi.fn() }));
vi.mock('./platform', () => ({ browserApi: api }));
vi.mock('./xTrendingAccess', async importOriginal => ({
  ...await importOriginal<typeof import('./xTrendingAccess')>(),
  xTrendingSiteAllowed: access.allowed,
  getXTrendingTokens: access.list,
}));

const address = '0x' + 'ab'.repeat(20);
const source = { id: 17, windowId: 3, url: 'https://x.com/home', pendingUrl: undefined };
const tab = { ...source, active: true } as chrome.tabs.Tab;
const sender = {
  id: api.runtime.id, frameId: 0, url: source.url, origin: 'https://x.com', documentLifecycle: 'active',
  documentId: 'source-document', tab,
} satisfies chrome.runtime.MessageSender;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('__LOCAL_FIXTURE__', false);
  api.tabs.get.mockResolvedValue(tab);
  api.tabs.sendMessage.mockResolvedValue({ ok: true });
  access.allowed.mockResolvedValue(true);
  access.list.mockResolvedValue({ items: [{ address, kolCount: 2, name: 'Example', symbol: 'EX' }] });
  api.tabs.create.mockResolvedValue({ id: 18 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('opens a one-time, extension-origin review with the exact token and source tab', async () => {
  const buy = new XTrendingBuy();
  await expect(buy.openReview(address, '15m', sender)).resolves.toEqual({ ok: true });
  expect(api.tabs.sendMessage).toHaveBeenCalledWith(17, { kind: 'x-trending/buy-source', address, window: '15m' },
    { documentId: 'source-document' });
  const [{ url, active, windowId }] = api.tabs.create.mock.calls[0];
  expect({ active, windowId }).toEqual({ active: true, windowId: 3 });
  expect(url).toMatch(/^chrome-extension:\/\/kollens\/panel\.html\?xBuy=[\da-f-]+$/);
  const id = new URL(url).searchParams.get('xBuy');
  const reviewSender = { id: api.runtime.id, url, frameId: 0 };
  expect(buy.readReview(id, sender)).toHaveProperty('ok', false);
  expect(buy.readReview(id, { ...reviewSender, frameId: 1 })).toHaveProperty('ok', false);
  expect(buy.readReview(id, reviewSender)).toEqual({ ok: true, review: {
    token: { chainId: 56, address, name: 'Example', symbol: 'EX' }, source,
  } });
  expect(buy.readReview(id, reviewSender)).toHaveProperty('ok', false);
});

it('rejects foreign, nested, stale and nonparticipating click documents', async () => {
  const buy = new XTrendingBuy();
  for (const candidate of [
    { ...sender, id: 'other' }, { ...sender, frameId: 2 }, { ...sender, documentId: undefined },
    { ...sender, url: 'https://x.com.example/home' }, { ...sender, documentLifecycle: 'cached' as const },
  ]) await expect(buy.openReview(address, '15m', candidate)).resolves.toHaveProperty('ok', false);
  expect(api.tabs.get).not.toHaveBeenCalled();
  api.tabs.sendMessage.mockResolvedValueOnce(undefined);
  await expect(buy.openReview(address, '15m', sender)).resolves.toHaveProperty('ok', false);
  expect(access.list).not.toHaveBeenCalled();
  expect(api.tabs.create).not.toHaveBeenCalled();
});

it('requires X permission and an eligible token until the review opens', async () => {
  const buy = new XTrendingBuy();
  access.allowed.mockResolvedValueOnce(false);
  await expect(buy.openReview(address, '15m', sender)).resolves.toHaveProperty('ok', false);
  access.list.mockResolvedValueOnce({ items: [{ address, kolCount: 1 }] });
  await expect(buy.openReview(address, '15m', sender)).resolves.toHaveProperty('ok', false);
  api.tabs.get.mockResolvedValueOnce(tab).mockResolvedValueOnce({ ...tab, url: 'https://x.com/explore' });
  await expect(buy.openReview(address, '15m', sender)).resolves.toHaveProperty('ok', false);
  expect(api.tabs.create).not.toHaveBeenCalled();
});

it('invalidates a pending review when its source tab navigates', async () => {
  let resolveList!: () => void;
  access.list.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { resolveList = resolve; });
    return { items: [{ address, kolCount: 2 }] };
  });
  const buy = new XTrendingBuy();
  const pending = buy.openReview(address, '15m', sender);
  await vi.waitFor(() => expect(access.list).toHaveBeenCalledOnce());
  buy.invalidateTab(tab.id!);
  await expect(buy.openReview(address, '15m', sender)).resolves.toHaveProperty('error', expect.stringContaining('in progress'));
  resolveList();
  await expect(pending).resolves.toHaveProperty('ok', false);
  expect(api.tabs.create).not.toHaveBeenCalled();
});

it('expires unused extension review drafts', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const buy = new XTrendingBuy();
  await buy.openReview(address, '15m', sender);
  const [{ url }] = api.tabs.create.mock.calls[0];
  now.mockReturnValue(1000 + 60_000);
  const id = new URL(url).searchParams.get('xBuy');
  expect(buy.readReview(id, { id: api.runtime.id, url, frameId: 0 })).toHaveProperty('ok', false);
});
