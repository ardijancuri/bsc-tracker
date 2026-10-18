import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTelegramBotLoginStart, parseTelegramNotificationUpdate, registerTelegramNotificationRoutes, telegramWebhookSecretMatches } from './telegramNotificationsApi.js';
import type { TelegramNotificationState } from '../shared/telegramNotifications.js';

const origin = 'https://kollens.com', wallet = `0x${'ab'.repeat(20)}`;
const initial: TelegramNotificationState = { available: true, connection: 'connected', enabled: true, buys: true, sells: true, language: 'en', mutedKols: [], lastError: null };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.unstubAllEnvs(); });
function fixture(signedIn = true, available = true, botLoginStart?: (input: NonNullable<ReturnType<typeof parseTelegramBotLoginStart>>) => Promise<boolean>) {
  const app = Fastify(); apps.push(app);
  const state = vi.fn(async () => ({ ...initial }));
  const update = vi.fn(async (_user: string, patch: unknown) => ({ ...initial, ...(patch as object) }));
  const mute = vi.fn(async () => ({ ...initial, mutedKols: [wallet] }));
  const webhook = vi.fn(async () => {});
  registerTelegramNotificationRoutes(app, { config: { clientId: '1234', clientSecret: 'private', origin, secure: true }, webhookSecret: 'private_secret',
    available: () => available, state, update, mute, webhook, botLoginStart,
    resolveUser: async () => signedIn ? { id: 'user-a', name: 'Tester', username: null, avatarUrl: null, preferences: {} as never } : null });
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method, url, payload: payload as never, headers: { origin, ...headers } });
  return { app, state, update, mute, webhook, request };
}
const privateMessage = (command: string, extra: Record<string, unknown> = {}) => ({ update_id: 7, message: { chat: { id: 987654321, type: 'private' }, from: { id: 987654321, is_bot: false }, text: command, ...extra } });

describe('Telegram notification account APIs', () => {
  it('returns only the current account state and keeps responses private', async () => {
    const f = fixture();
    const response = await f.request('GET', '/api/notifications/telegram');
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(initial);
    expect(f.state).toHaveBeenCalledWith('user-a');
    expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers.vary).toBe('Cookie');
  });
  it('reports disabled server configuration without hiding saved preferences', async () => {
    const f = fixture(true, false);
    expect((await f.request('GET', '/api/notifications/telegram')).json()).toEqual({ ...initial, available: false });
    expect((await f.request('PATCH', '/api/notifications/telegram', { enabled: true })).statusCode).toBe(503);
    expect((await f.request('PATCH', '/api/notifications/telegram', { enabled: false })).statusCode).toBe(200);
  });
  it.each(['GET', 'PATCH', 'PUT'] as const)('requires sign-in for %s', async method => {
    const f = fixture(false);
    const response = await f.request(method, method === 'PUT' ? `/api/notifications/telegram/kols/${wallet}` : '/api/notifications/telegram', method === 'GET' ? undefined : { enabled: false });
    expect(response.statusCode).toBe(401); expect(f.update).not.toHaveBeenCalled(); expect(f.mute).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PATCH', 'PUT'] as const)('rejects stale account-owner headers for %s', async method => {
    const f = fixture();
    const response = await f.request(method, method === 'PUT' ? `/api/notifications/telegram/kols/${wallet}` : '/api/notifications/telegram', method === 'GET' ? undefined : { enabled: false }, { 'x-watchlist-owner': 'user-b' });
    expect(response.statusCode).toBe(409); expect(f.update).not.toHaveBeenCalled(); expect(f.mute).not.toHaveBeenCalled();
  });
  it('updates account preferences without changing Radar settings', async () => {
    const f = fixture();
    const response = await f.request('PATCH', '/api/notifications/telegram', { enabled: false, buys: false, sells: true, language: 'zh-CN' });
    expect(response.statusCode).toBe(200);
    expect(f.update).toHaveBeenCalledWith('user-a', { enabled: false, buys: false, sells: true, language: 'zh-CN' });
  });
  it.each([{}, [], null, { buys: 'yes' }, { language: 'fr' }, { buys: false, sells: false }, { radar: true }, { enabled: null }])('rejects invalid preference patch %j', async payload => {
    const f = fixture();
    expect((await f.request('PATCH', '/api/notifications/telegram', payload)).statusCode).toBe(400);
    expect(f.update).not.toHaveBeenCalled();
  });
  it('normalizes per-KOL mute addresses and leaves favorite validation to the transactional helper', async () => {
    const f = fixture();
    expect((await f.request('PUT', `/api/notifications/telegram/kols/${wallet.toUpperCase().replace('0X', '0x')}`, { muted: true })).statusCode).toBe(200);
    expect(f.mute).toHaveBeenCalledWith('user-a', wallet, true);
    for (const [address, body] of [['bad', { muted: true }], [wallet, { muted: true, enabled: true }], [wallet, { muted: 'yes' }]] as const) expect((await f.request('PUT', `/api/notifications/telegram/kols/${address}`, body)).statusCode).toBe(400);
  });
  it('rejects cross-origin writes', async () => {
    const f = fixture();
    expect((await f.request('PATCH', '/api/notifications/telegram', { enabled: false }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await f.request('PUT', `/api/notifications/telegram/kols/${wallet}`, { muted: true }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(f.update).not.toHaveBeenCalled(); expect(f.mute).not.toHaveBeenCalled();
  });
  it('returns safe helper validation errors and hides unexpected internal details', async () => {
    const f = fixture();
    const error = Object.assign(new Error('Reconnect Telegram alerts'), { name: 'TelegramNotificationInputError', status: 409 });
    f.update.mockRejectedValueOnce(error);
    expect((await f.request('PATCH', '/api/notifications/telegram', { enabled: true })).json()).toEqual({ error: 'Reconnect Telegram alerts' });
    f.update.mockRejectedValueOnce(new Error('private-db-connection-secret'));
    const failed = await f.request('PATCH', '/api/notifications/telegram', { enabled: false });
    expect(failed.statusCode).toBe(503); expect(failed.body).not.toContain('private');
  });
  it('bounds account mutation frequency', async () => {
    const f = fixture();
    for (let index = 0; index < 120; index++) await f.request('PATCH', '/api/notifications/telegram', { enabled: false });
    const response = await f.request('PATCH', '/api/notifications/telegram', { enabled: false });
    expect(response.statusCode).toBe(429); expect(response.headers['retry-after']).toBe('60');
  });
});

describe('Telegram authenticated webhook', () => {
  it.each(['/start', '/start@kollens_login_bot', '/start expired_old_parameter'])('prioritizes a login link for %s instead of Manage alerts', async command => {
    const botLogin = vi.fn(async () => true), f = fixture(false, true, botLogin);
    const response = await f.request('POST', '/api/telegram/webhook', privateMessage(command), { 'x-telegram-bot-api-secret-token': 'private_secret' });
    expect(response.statusCode).toBe(200);
    expect(botLogin).toHaveBeenCalledWith(expect.objectContaining({ startToken: '', telegramId: '987654321' }));
    expect(f.webhook).not.toHaveBeenCalled();
  });
  it('keeps explicit /status routed to alert settings', async () => {
    const botLogin = vi.fn(async () => true), f = fixture(false, true, botLogin);
    await f.request('POST', '/api/telegram/webhook', privateMessage('/status'), { 'x-telegram-bot-api-secret-token': 'private_secret' });
    expect(botLogin).not.toHaveBeenCalled();
    expect(f.webhook).toHaveBeenCalledWith(expect.objectContaining({ command: 'status' }));
  });
  it('routes a validated private login command before alert status processing', async () => {
    const botLogin = vi.fn(async () => true), f = fixture(false, true, botLogin);
    const body = privateMessage('/start login_' + 'a'.repeat(43), { from: { id: 987654321, first_name: 'RD', last_name: 'Dev', username: 'dev_test', language_code: 'en' } });
    expect((await f.request('POST', '/api/telegram/webhook', body, { 'x-telegram-bot-api-secret-token': 'private_secret' })).statusCode).toBe(200);
    expect(botLogin).toHaveBeenCalledWith({ updateId: '7', telegramId: '987654321', startToken: 'login_' + 'a'.repeat(43), name: 'RD Dev', username: 'dev_test', language: 'en' });
    expect(f.webhook).not.toHaveBeenCalled();
  });
  it('never exposes a login payload to handlers before webhook authentication', async () => {
    const botLogin = vi.fn(async () => true), f = fixture(false, true, botLogin);
    expect((await f.request('POST', '/api/telegram/webhook', privateMessage('/start login_' + 'a'.repeat(43)))).statusCode).toBe(403);
    expect(botLogin).not.toHaveBeenCalled();
    for (const extra of [{ chat: { type: 'group', id: 987654321 } }, { from: { id: 321 } }, { from: { id: 987654321, is_bot: true } }]) {
      expect(parseTelegramBotLoginStart(privateMessage('/start login_' + 'a'.repeat(43), extra))).toBeNull();
    }
  });
  it('does not let a failed login write consume an alert update or leak login secrets', async () => {
    const botLogin = vi.fn(async () => { throw new Error('private-login-secret'); }), f = fixture(false, true, botLogin);
    const response = await f.request('POST', '/api/telegram/webhook', privateMessage('/start login_' + 'a'.repeat(43)), { 'x-telegram-bot-api-secret-token': 'private_secret' });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain('private-login-secret'); expect(f.webhook).not.toHaveBeenCalled();
  });
  it('compares the configured webhook secret and rejects missing/invalid values', () => {
    expect(telegramWebhookSecretMatches('private_secret', 'private_secret')).toBe(true);
    for (const value of [undefined, ['private_secret'], 'different', 'private_secret_extra']) expect(telegramWebhookSecretMatches('private_secret', value)).toBe(false);
    expect(telegramWebhookSecretMatches('', '')).toBe(false); expect(telegramWebhookSecretMatches('bad token', 'bad token')).toBe(false);
  });
  it('authenticates before processing updates and does not require browser origin or account cookies', async () => {
    const f = fixture(false);
    const bad = await f.request('POST', '/api/telegram/webhook', privateMessage('/stop'));
    expect(bad.statusCode).toBe(403); expect(f.webhook).not.toHaveBeenCalled();
    const good = await f.app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'private_secret' }, payload: privateMessage('/stop') });
    expect(good.json()).toEqual({ ok: true });
    expect(f.webhook).toHaveBeenCalledWith({ updateId: '7', telegramId: '987654321', command: 'stop' });
  });
  it('rejects an invalid secret before parsing malformed JSON', async () => {
    const f = fixture(false);
    const response = await f.app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong-secret' }, payload: '{malformed-json' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Webhook authentication failed' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.webhook).not.toHaveBeenCalled();
  });
  it.each(['stop', 'start', 'status'] as const)('passes %s commands to durable deduplication without enabling in the API', command => {
    expect(parseTelegramNotificationUpdate(privateMessage(`/${command}@kollens_login_bot argument`))).toEqual({ updateId: '7', telegramId: '987654321', command });
  });
  it('ignores group chats, forged sender ids, bot senders, unknown commands and unsafe IDs', async () => {
    const f = fixture();
    const bad = [privateMessage('/stop', { chat: { id: -9876, type: 'group' } }), privateMessage('/stop', { from: { id: 1234 } }), privateMessage('/stop', { from: { id: 987654321, is_bot: true } }), privateMessage('/stopnow'), privateMessage('/stop', { chat: { id: Number.MAX_SAFE_INTEGER + 1, type: 'private' } })];
    for (const body of bad) {
      expect(parseTelegramNotificationUpdate(body)).toBeNull();
      expect((await f.request('POST', '/api/telegram/webhook', body, { 'x-telegram-bot-api-secret-token': 'private_secret' })).statusCode).toBe(200);
    }
    expect(f.webhook).not.toHaveBeenCalled();
  });
  it('recognizes private bot blocking/unblocking without enabling delivery', () => {
    for (const [status, blocked] of [['kicked', true], ['member', false]] as const) expect(parseTelegramNotificationUpdate({ update_id: 8, my_chat_member: { chat: { type: 'private', id: 987654321 }, new_chat_member: { status } } })).toEqual({ updateId: '8', telegramId: '987654321', command: null, blocked });
  });
  it('rejects malformed updates and asks Telegram to retry failed durable writes', async () => {
    const f = fixture(), headers = { 'x-telegram-bot-api-secret-token': 'private_secret' };
    expect((await f.request('POST', '/api/telegram/webhook', { update_id: -1 }, headers)).statusCode).toBe(400);
    f.webhook.mockRejectedValueOnce(new Error('private-storage-secret'));
    const response = await f.request('POST', '/api/telegram/webhook', privateMessage('/status'), headers);
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain('private');
  });
});
