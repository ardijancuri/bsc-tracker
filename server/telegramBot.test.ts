import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramBot, telegramBotConfig, type TelegramBotConfig } from './telegramBot.js';

const config: TelegramBotConfig = { token: '12345:abcdefghijklmnopqrstuvwxyz_123456789', botId: '12345', origin: 'https://kollens.com', webhookSecret: null };
const identity = () => Response.json({ ok: true, result: { id: 12345, is_bot: true } });
const success = (id = 71) => Response.json({ ok: true, result: { message_id: id } });
afterEach(() => { vi.useRealTimers(); });

describe('Telegram server configuration', () => {
  const env = { TELEGRAM_BOT_TOKEN: config.token, TELEGRAM_CLIENT_ID: config.botId, PUBLIC_APP_URL: 'https://kollens.com' };
  it('supports a server-only outbound configuration without a webhook secret', () => {
    expect(telegramBotConfig(env)).toEqual(config);
    expect(telegramBotConfig({ ...env, PUBLIC_APP_URL: 'http://127.0.0.1:5173' })?.origin).toBe('http://127.0.0.1:5173');
    expect(telegramBotConfig({ ...env, TELEGRAM_WEBHOOK_SECRET: 'secret_-123' })?.webhookSecret).toBe('secret_-123');
  });
  it.each([
    { TELEGRAM_BOT_TOKEN: 'wrong' }, { TELEGRAM_CLIENT_ID: '555' }, { TELEGRAM_CLIENT_ID: '1e5' }, { PUBLIC_APP_URL: 'http://kollens.com' },
    { PUBLIC_APP_URL: 'https://x:y@kollens.com' }, { PUBLIC_APP_URL: 'https://kollens.com/path' }, { PUBLIC_APP_URL: 'https://kollens.com?q=1' },
    { PUBLIC_APP_URL: 'https://kollens.com#x' }, { TELEGRAM_WEBHOOK_SECRET: 'bad secret' }, { NODE_ENV: 'production', PUBLIC_APP_URL: 'http://localhost:5173' },
  ])('rejects invalid configuration without exposing credentials: %j', overrides => {
    expect(telegramBotConfig({ ...env, ...overrides })).toBeNull();
  });
});

describe('Telegram Bot API transport', () => {
  it('checks and coalesces the registered webhook without changing it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, result: { url: 'https://kollens.com/api/telegram/webhook' } }));
    const bot = createTelegramBot(config, { fetch: fetcher });
    expect(await Promise.all([bot.webhookMatchesOrigin(), bot.webhookMatchesOrigin()])).toEqual([true, true]);
    expect(await bot.webhookMatchesOrigin()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain('/getWebhookInfo');
  });
  it('does not authorize a localhost handoff through the production bot webhook', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, result: { url: 'https://kollens.com/api/telegram/webhook' } }));
    const bot = createTelegramBot({ ...config, origin: 'http://127.0.0.1:5173' }, { fetch: fetcher });
    expect(await bot.webhookMatchesOrigin()).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rechecks a mismatched webhook after fifteen seconds and never exposes its URL', async () => {
    let time = 0;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, result: { url: 'https://another.example/private-hook' } }))
      .mockResolvedValue(Response.json({ ok: true, result: { url: 'https://kollens.com/api/telegram/webhook' } }));
    const bot = createTelegramBot(config, { fetch: fetcher, now: () => time });
    expect(await bot.webhookMatchesOrigin()).toBe(false);
    time = 14_999; expect(await bot.webhookMatchesOrigin()).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
    time++; expect(await bot.webhookMatchesOrigin()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('returns only the username of the verified bot for deep links', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, result: { id: 12345, is_bot: true, username: 'kollens_login_bot' } }));
    const bot = createTelegramBot(config, { fetch: fetcher });
    expect(await bot.identity()).toEqual({ username: 'kollens_login_bot' });
    expect(await bot.identity()).toEqual({ username: 'kollens_login_bot' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await createTelegramBot(config, { fetch: vi.fn().mockResolvedValue(identity()) }).identity()).toBeNull();
  });
  it('downloads an optional photo only from the verified Bot API file path', async () => {
    const bytes = Buffer.from('test image bytes');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(Response.json({ ok: true, result: { photos: [[{ file_id: 'photo-id', file_size: bytes.length }]] } }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: 'photos/file_1.jpg', file_size: bytes.length } }))
      .mockResolvedValueOnce(new Response(bytes));
    expect(await createTelegramBot(config, { fetch: fetcher }).profilePhoto('44')).toEqual(bytes);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ user_id: '44', limit: 1 });
    expect(String(fetcher.mock.calls[3][0])).toBe(`https://api.telegram.org/file/bot${config.token}/photos/file_1.jpg`);
  });
  it.each(['../file.jpg', 'https://evil.example/photo.jpg', 'photos/file.svg'])('rejects an unsafe photo path %s without fetching it', async file_path => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(Response.json({ ok: true, result: { photos: [[{ file_id: 'photo-id' }]] } }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path } }));
    expect(await createTelegramBot(config, { fetch: fetcher }).profilePhoto('44')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('bounds an optional photo download even if its transport ignores cancellation', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity())
      .mockResolvedValueOnce(Response.json({ ok: true, result: { photos: [[{ file_id: 'photo-id' }]] } }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: 'photos/file.jpg' } }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const bot = createTelegramBot(config, { fetch: fetcher });
    await bot.verifyIdentity();
    const photo = bot.profilePhoto('44');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await photo).toBeNull();
  });
  it('coalesces identity checks, caches successful checks for ten minutes and sends plain text', async () => {
    let time = 10;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/getMe') ? identity() : success());
    const bot = createTelegramBot(config, { fetch: fetcher, now: () => time });
    expect(await Promise.all([bot.verifyIdentity(), bot.verifyIdentity()])).toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const buttons = [[{ text: 'View KOL', url: 'https://kollens.com/kol/0xabc' }]];
    expect(await bot.send('123456', '<b>literal metadata</b>', buttons)).toEqual({ kind: 'sent', messageId: 71 });
    const [url, init] = fetcher.mock.calls[1];
    expect(String(url)).toBe(`https://api.telegram.org/bot${config.token}/sendMessage`);
    expect(JSON.parse(String(init?.body))).toEqual({ chat_id: '123456', text: '<b>literal metadata</b>', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: buttons } });
    expect(init?.redirect).toBe('error');
    time += 599_999; expect(await bot.verifyIdentity()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
    time++; expect(await bot.verifyIdentity()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects another bot identity and caches the failure for thirty seconds', async () => {
    let time = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, result: { id: 999, is_bot: true } })).mockImplementation(async () => identity());
    const bot = createTelegramBot(config, { fetch: fetcher, now: () => time });
    expect(await bot.send('44', 'Test')).toEqual({ kind: 'failed', reason: 'bot_identity_unverified' });
    time = 29_999; expect(await bot.verifyIdentity()).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
    time = 30_000; expect(await bot.verifyIdentity()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('supports corrections through editMessageText', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockResolvedValueOnce(success(15));
    const bot = createTelegramBot(config, { fetch: fetcher });
    expect(await bot.edit('44', 15, 'Corrected')).toEqual({ kind: 'sent', messageId: 15 });
    expect(String(fetcher.mock.calls[1][0])).toContain('/editMessageText');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).message_id).toBe(15);
  });
  it('passes explicit bold and link entities without enabling metadata markup parsing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockResolvedValueOnce(success(15)).mockResolvedValueOnce(success(15));
    const bot = createTelegramBot(config, { fetch: fetcher });
    const entities = [{ type: 'bold' as const, offset: 3, length: 4 }, { type: 'text_link' as const, offset: 3, length: 4, url: 'https://kollens.com/token/0x123' }];
    await bot.send('44', '🟢 BIBI', undefined, entities);
    await bot.edit('44', 15, '🟢 BIBI', undefined, entities);
    for (const call of fetcher.mock.calls.slice(1)) {
      const body = JSON.parse(String(call[1]?.body)); expect(body.entities).toEqual(entities); expect(body.parse_mode).toBeUndefined();
    }
    expect(await bot.send('44', 'Short', undefined, [{ type: 'bold', offset: 3, length: 9 }])).toEqual({ kind: 'failed', reason: 'invalid_message' });
    expect(await bot.send('44', 'Short', undefined, [{ type: 'text_link', offset: 0, length: 5, url: 'javascript:evil' }])).toEqual({ kind: 'failed', reason: 'invalid_message' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    [429, { ok: false, parameters: { retry_after: 37 } }, { kind: 'retry', reason: 'rate_limited', retryAfterMs: 37_000 }],
    [429, { ok: false, parameters: { retry_after: -1 } }, { kind: 'retry', reason: 'rate_limited', retryAfterMs: 1000 }],
    [429, { ok: false, parameters: { retry_after: 9e9 } }, { kind: 'retry', reason: 'rate_limited', retryAfterMs: 86_400_000 }],
    [200, { ok: false, error_code: 429, parameters: { retry_after: 2 } }, { kind: 'retry', reason: 'rate_limited', retryAfterMs: 2000 }],
    [403, { ok: false }, { kind: 'blocked' }],
    [400, { ok: false, description: `secret ${config.token}` }, { kind: 'failed', reason: 'message_rejected' }],
    [401, { ok: false }, { kind: 'failed', reason: 'bot_unauthorized' }],
    [503, { ok: false }, { kind: 'uncertain', reason: 'upstream_unavailable' }],
    [200, { ok: true, result: {} }, { kind: 'uncertain', reason: 'invalid_response' }],
  ])('classifies status %i without exposing provider bodies', async (status, body, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockResolvedValueOnce(Response.json(body, { status }));
    const result = await createTelegramBot(config, { fetch: fetcher }).send('44', 'Test');
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(config.token);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('never blindly retries a network failure after sending begins', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockRejectedValueOnce(new Error(`https://api.telegram.org/bot${config.token}/sendMessage`));
    const result = await createTelegramBot(config, { fetch: fetcher }).send('44', 'Test');
    expect(result).toEqual({ kind: 'uncertain', reason: 'network' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserves known HTTP rejection and cooldown categories when a proxy responds with HTML', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockResolvedValueOnce(new Response('<html>upstream limit</html>', { status: 429, headers: { 'retry-after': '15' } })).mockResolvedValueOnce(new Response('proxy unavailable', { status: 503 }));
    const bot = createTelegramBot(config, { fetch: fetcher });
    expect(await bot.send('44', 'Test')).toEqual({ kind: 'retry', reason: 'rate_limited', retryAfterMs: 15_000 });
    expect(await bot.send('44', 'Test')).toEqual({ kind: 'uncertain', reason: 'upstream_unavailable' });
  });
  it('bounds a hung request to eight seconds even if the transport ignores abort', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockImplementationOnce(() => new Promise(() => {}));
    const bot = createTelegramBot(config, { fetch: fetcher });
    await bot.verifyIdentity();
    const sending = bot.send('44', 'Test');
    await vi.advanceTimersByTimeAsync(8000);
    expect(await sending).toEqual({ kind: 'uncertain', reason: 'timeout' });
  });
  it.each([false, true])('bounds chunked and declared response sizes (declared=%s)', async declared => {
    const response = new Response('x'.repeat(65_537), { headers: declared ? { 'content-length': '65537' } : {} });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockResolvedValueOnce(response);
    expect(await createTelegramBot(config, { fetch: fetcher }).send('44', 'Test')).toEqual({ kind: 'uncertain', reason: 'response_too_large' });
  });
  it('validates private chat IDs, message size, corrections and links before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const bot = createTelegramBot(config, { fetch: fetcher });
    for (const id of ['-123', '@username', '0', '9007199254740992']) expect(await bot.send(id, 'Test')).toEqual({ kind: 'failed', reason: 'invalid_message' });
    expect(await bot.send('44', 'x'.repeat(4097))).toEqual({ kind: 'failed', reason: 'invalid_message' });
    expect(await bot.send('44', 'Test', [[{ text: 'Unsafe', url: 'javascript:alert(1)' }]])).toEqual({ kind: 'failed', reason: 'invalid_message' });
    expect(await bot.edit('44', 0, 'Test')).toEqual({ kind: 'failed', reason: 'invalid_message' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
