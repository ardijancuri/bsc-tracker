import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { TelegramNotificationState } from '../shared/telegramNotifications';
import { notificationIdentityChanged, requestTelegramNotifications, shouldPromptTelegramAlerts, telegramConsentUrl, telegramConnectionLabel, TelegramAlertsControls, TelegramAlertsPrompt, TelegramNotificationsProvider } from './TelegramNotifications';
import { WatchlistProvider } from './Intelligence';
import { TokenWatchlistPage } from './TokenWatchlist';
import { translate, setLanguage } from './i18n';

vi.mock('./Account', async original => ({ ...await original<typeof import('./Account')>(), AccountWatchlistNotice: () => null, useAccount: () => ({
  state: { enabled: true, user: null }, loaded: true, checking: false, busy: false, unavailable: false, revision: 1,
  login: vi.fn(), refresh: vi.fn(), logout: vi.fn(),
}) }));

const state: TelegramNotificationState = { available: true, connection: 'connected', enabled: true, buys: true, sells: true, language: 'en', mutedKols: [], lastError: null };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setLanguage('en'); });
describe('account-bound Telegram notification requests', () => {
  it('binds reads to the account with uncached same-origin credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(state)); vi.stubGlobal('fetch', fetcher);
    expect(await requestTelegramNotifications('/api/notifications/telegram', 'user-1')).toEqual(state);
    expect(fetcher).toHaveBeenCalledWith('/api/notifications/telegram', expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Watchlist-Owner': 'user-1' } }));
  });
  it('keeps delivery preferences and individual mute separate from Radar settings', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(state)); vi.stubGlobal('fetch', fetcher);
    await requestTelegramNotifications('/api/notifications/telegram', 'user-1', 'PATCH', { buys: false, sells: true });
    await requestTelegramNotifications('/api/notifications/telegram/kols/0x123', 'user-1', 'PUT', { muted: true });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ buys: false, sells: true });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ muted: true });
    expect(fetcher.mock.calls.every(call => call[1].headers['X-Watchlist-Owner'] === 'user-1')).toBe(true);
  });
  it.each([401, 409])('recognizes identity changes (%i) without retrying under another account', async status => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status })); vi.stubGlobal('fetch', fetcher);
    expect(notificationIdentityChanged(await requestTelegramNotifications('/api/notifications/telegram', 'old-user').catch(reason => reason))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not surface provider response bodies or mistake service errors for account changes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'private provider response' }, { status: 503 })));
    const reason = await requestTelegramNotifications('/api/notifications/telegram', 'user-1').catch(reason => reason);
    expect(notificationIdentityChanged(reason)).toBe(false);
    expect((reason as Error).message).not.toContain('private provider');
  });
  it('cancels a request on account switch and bounds a stalled connection', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted'))))));
    const controller = new AbortController();
    const switching = requestTelegramNotifications('/api/notifications/telegram', 'old-user', 'GET', undefined, controller.signal).catch(reason => reason);
    controller.abort(); expect(((await switching) as Error).message).toBe('Aborted');
    const stalled = requestTelegramNotifications('/api/notifications/telegram', 'user-1').catch(reason => reason);
    await vi.advanceTimersByTimeAsync(15_000); expect(((await stalled) as Error).message).toBe('Aborted');
  });
  it.each(['https://evil.example/authorize', 'http://oauth.telegram.org/auth', 'javascript:alert(1)', 'https://oauth.telegram.org@evil.example/'])('rejects an unsafe consent navigation: %s', url => {
    expect(() => telegramConsentUrl(url)).toThrow();
  });
  it('allows only the Telegram HTTPS consent page', () => {
    expect(telegramConsentUrl('https://oauth.telegram.org/auth?client_id=123')).toBe('https://oauth.telegram.org/auth?client_id=123');
  });
});
describe('Telegram settings controls', () => {
  const render = (overrides: Partial<TelegramNotificationState> = {}, disabled = false) => renderToStaticMarkup(<TelegramAlertsControls state={{ ...state, ...overrides }} disabled={disabled} onEnable={() => {}} onPreferences={() => {}} />);
  it('shows active and paused preferences distinctly without requiring consent again', () => {
    expect(render()).toContain('Alerts active'); expect(render()).toContain('Pause alerts');
    expect(render({ enabled: false })).toContain('Alerts paused'); expect(render({ enabled: false })).toContain('Resume alerts');
  });
  it('keeps activation pending until worker confirmation and supports reconnecting', () => {
    const pending = render({ connection: 'pending', enabled: false });
    expect(pending).toContain('Waiting for Telegram confirmation'); expect(pending).toContain('Cancel connection'); expect(pending).not.toMatch(/button[^>]*disabled/);
    expect(render({ connection: 'blocked', enabled: false })).toContain('Reconnect Telegram');
    expect(render({ connection: 'not_connected', enabled: false })).toContain('Enable Telegram alerts');
  });
  it('disables the last selected side and all controls while updating', () => {
    expect(render({ buys: true, sells: false })).toMatch(/input[^>]*checked=""[^>]*disabled|input[^>]*disabled[^>]*checked=""/);
    expect((render({}, true).match(/disabled=""/g) || []).length).toBe(3);
  });
  it('still lets an active account pause when Telegram becomes unavailable', () => {
    expect(render({ available: false })).not.toMatch(/button[^>]*disabled/);
    expect(render({ available: false, enabled: false })).toMatch(/button[^>]*disabled/);
  });
  it('translates every connection state and active controls', () => {
    for (const connection of ['not_connected', 'pending', 'connected', 'blocked', 'error'] as const) {
      const label = telegramConnectionLabel({ ...state, connection }); expect(translate(label, 'zh-CN')).not.toBe(label);
    }
    setLanguage('zh-CN'); const html = render();
    expect(html).toContain('提醒已启用'); expect(html).toContain('暂停提醒'); expect(html).not.toContain('Pause alerts');
  });
});

describe('Telegram login alert invitation', () => {
  it('offers consent only for available inactive alerts, including paused or disconnected accounts', () => {
    expect(shouldPromptTelegramAlerts(state)).toBe(false);
    expect(shouldPromptTelegramAlerts({ ...state, enabled: false })).toBe(true);
    expect(shouldPromptTelegramAlerts({ ...state, enabled: false, connection: 'not_connected' })).toBe(true);
    expect(shouldPromptTelegramAlerts({ ...state, enabled: false, connection: 'pending' })).toBe(false);
    expect(shouldPromptTelegramAlerts({ ...state, enabled: false, available: false })).toBe(false);
  });
  it('provides explicit enable and dismiss actions and a labelled dialog', () => {
    const html = renderToStaticMarkup(<TelegramAlertsPrompt state={{ ...state, enabled: false, connection: 'not_connected' }} busy={false} onEnable={() => {}} onDismiss={() => {}} />);
    expect(html).toContain('aria-labelledby="telegram-alert-prompt-title"');
    expect(html).toContain('Get your KOL trades in Telegram'); expect(html).toContain('Enable Telegram alerts'); expect(html).toContain('Not now');
    const paused = renderToStaticMarkup(<TelegramAlertsPrompt state={{ ...state, enabled: false }} busy={false} onEnable={() => {}} onDismiss={() => {}} />);
    expect(paused).toContain('Resume alerts');
  });
});
describe('Watchlist Telegram entry point', () => {
  const render = (url: string) => renderToStaticMarkup(<MemoryRouter initialEntries={[url]}><WatchlistProvider><TelegramNotificationsProvider><TokenWatchlistPage /></TelegramNotificationsProvider></WatchlistProvider></MemoryRouter>);
  it('returns directly to KOL alert settings after consent and provides guests a login action', () => {
    const html = render('/watchlist?tab=kols&telegramAlerts=pending');
    expect(html).toContain('telegram-alert-heading'); expect(html).toContain('Log in to receive favorite KOL trades in Telegram.');
    expect(html).toMatch(/id="watchlist-kol-tab" aria-selected="true"/);
    expect(html).not.toContain('Enable Telegram alerts');
    expect(html).toContain('watchlist-kol-layout'); expect(html).toContain('watchlist-kol-settings'); expect(html).toContain('watchlist-kol-following');
  });
  it('keeps the default token tab unchanged and omits Telegram controls there', () => {
    const html = render('/watchlist');
    expect(html).toMatch(/id="watchlist-token-tab" aria-selected="true"/);
    expect(html).not.toContain('telegram-alert-heading');
  });
});
