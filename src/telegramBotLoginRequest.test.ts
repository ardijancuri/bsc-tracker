import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestTelegramBotLogin, requestTelegramLoginRecovery, telegramBotLoginError, telegramBotLoginReturnTo, telegramBotLoginToken, telegramBotLoginUrl, telegramOidcLoginUrl, TelegramBotLoginRequestError } from './telegramBotLoginRequest';

const token = 'A'.repeat(43);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Telegram bot login links', () => {
  it('opens only an exact HTTPS Telegram bot start link', () => {
    expect(telegramBotLoginUrl(`https://t.me/kollens_login_bot?start=login_${token}`)).toBe(`https://t.me/kollens_login_bot?start=login_${token}`);
  });
  it.each([
    `http://t.me/kollens_login_bot?start=login_${token}`,
    `https://oauth.telegram.org/auth?start=login_${token}`,
    `https://t.me.evil.example/kollens_login_bot?start=login_${token}`,
    `https://t.me@evil.example/kollens_login_bot?start=login_${token}`,
    `https://user:password@t.me/kollens_login_bot?start=login_${token}`,
    `https://t.me:444/kollens_login_bot?start=login_${token}`,
    `https://t.me/kollens_login_bot/extra?start=login_${token}`,
    `https://t.me/kollens_login_bot?start=login_${token}&redirect=https://evil.example`,
    `https://t.me/kollens_login_bot?start=login_${token}&start=login_${token}`,
    `https://t.me/kollens_login_bot?start=login_${token}#extra`,
    'https://t.me/kollens_login_bot?start=other',
    'javascript:alert(1)',
  ])('rejects a malformed or redirected bot link: %s', value => expect(() => telegramBotLoginUrl(value)).toThrow());
  it('reads one opaque fragment token without accepting query or extra parameters', () => {
    expect(telegramBotLoginToken(`#token=${token}`)).toBe(token);
    for (const value of ['', '#token=short', `#token=${token}&token=${token}`, `#token=${token}&next=/`, `#token=${'A'.repeat(42)}!`]) expect(telegramBotLoginToken(value)).toBeNull();
  });
  it('returns only to internal product pages, preserving the login success marker', () => {
    expect(telegramBotLoginReturnTo('/kol/0xabc?telegramLogin=success#trades')).toBe('/kol/0xabc?telegramLogin=success#trades');
    for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', '/api/auth/logout', '/api', '/auth/telegram/finish', '/\nlogin']) expect(() => telegramBotLoginReturnTo(value)).toThrow();
  });
  it('accepts the legacy recovery URL only from the explicit Telegram HTTPS authorization endpoint', () => {
    expect(telegramOidcLoginUrl('https://oauth.telegram.org/auth?client_id=123')).toBe('https://oauth.telegram.org/auth?client_id=123');
    for (const url of ['https://evil.example/auth', 'http://oauth.telegram.org/auth', 'https://name@oauth.telegram.org/auth', 'https://oauth.telegram.org:444/auth', 'https://oauth.telegram.org/auth#token', 'https://oauth.telegram.org/token']) expect(() => telegramOidcLoginUrl(url)).toThrow();
  });
});

describe('Telegram bot browser confirmation requests', () => {
  it('only posts tokens in an uncached same-origin body; completion requires explicit confirmation', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetcher);
    await requestTelegramBotLogin('preview', token);
    await requestTelegramBotLogin('complete', token);
    expect(fetcher.mock.calls[0][0]).toBe('/api/auth/telegram/bot/preview');
    expect(fetcher.mock.calls[1][0]).toBe('/api/auth/telegram/bot/complete');
    for (const call of fetcher.mock.calls) expect(call[1]).toEqual(expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store' }));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ token });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ token, confirmed: true });
  });
  it('rejects invalid tokens before making requests', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(requestTelegramBotLogin('preview', 'short')).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requests legacy recovery only explicitly and returns to the Watchlist', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ url: 'https://oauth.telegram.org/auth?client_id=123' })); vi.stubGlobal('fetch', fetcher);
    expect(await requestTelegramLoginRecovery()).toBe('https://oauth.telegram.org/auth?client_id=123');
    expect(fetcher.mock.calls[0][0]).toBe('/api/auth/telegram/oidc/start');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ returnTo: '/watchlist' });
  });
  it('binds one-time recovery to the current bot proof without putting it in the URL', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ url: 'https://oauth.telegram.org/auth?client_id=123' })); vi.stubGlobal('fetch', fetcher);
    await requestTelegramLoginRecovery(token);
    expect(fetcher.mock.calls[0][0]).toBe('/api/auth/telegram/oidc/start');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ returnTo: '/watchlist', botToken: token });
    await expect(requestTelegramLoginRecovery('invalid')).rejects.toMatchObject({ status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not expose upstream response messages, tokens or account data through errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: `private ${token}` }, { status: 409 })));
    const error = await requestTelegramBotLogin('complete', token).catch(reason => reason);
    expect((error as Error).message).not.toContain(token);
    expect(telegramBotLoginError(error)).toBe('Log out before signing in to a different Telegram account.');
  });
  it('bounds a stalled request and cancels independently on navigation', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      if (options.signal.aborted) reject(new Error('Aborted'));
      else options.signal.addEventListener('abort', () => reject(new Error('Aborted')));
    })));
    const controller = new AbortController();
    const cancelled = requestTelegramBotLogin('preview', token, controller.signal).catch(reason => reason);
    controller.abort(); expect(((await cancelled) as Error).message).toBe('Aborted');
    const stalled = requestTelegramBotLogin('preview', token).catch(reason => reason);
    await vi.advanceTimersByTimeAsync(15_000); expect(((await stalled) as Error).message).toBe('Aborted');
  });
  it('uses distinct expired, account mismatch, cooldown and temporary failure messages', () => {
    expect(telegramBotLoginError(new TelegramBotLoginRequestError(410))).toBe('This login link has expired or was already used.');
    expect(telegramBotLoginError(new TelegramBotLoginRequestError(429))).toBe('Too many login attempts. Wait a moment and try again.');
    expect(telegramBotLoginError(new TelegramBotLoginRequestError(422))).toBe('Your browser and account favorites exceed the limit. Remove some favorites and try again.');
    expect(telegramBotLoginError(new TelegramBotLoginRequestError(428))).toBe('One-time Telegram verification is needed to preserve existing accounts.');
    expect(telegramBotLoginError(new Error('private token'))).toBe('Could not log in with Telegram. Try again.');
  });
});
