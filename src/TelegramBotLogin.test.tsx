import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TelegramBotLoginCard } from './TelegramBotLogin';
import { setLanguage } from './i18n';
import type { TelegramBotLoginPreview } from './telegramBotLoginRequest';

const preview: TelegramBotLoginPreview = { user: { name: 'RD - Dev', username: 'rd_dev', avatarUrl: 'https://t.me/i/userpic/320/example.jpg' }, sameBrowser: true, expiresAt: '2026-10-18T12:00:00Z' };
const actions = { onContinue() {}, onRetry() {}, onLogin() {}, onRecover() {} };
const render = (overrides: Partial<Parameters<typeof TelegramBotLoginCard>[0]> = {}) => renderToStaticMarkup(<MemoryRouter><TelegramBotLoginCard preview={preview} busy={false} error={null} loading={false} {...actions} {...overrides} /></MemoryRouter>);
afterEach(() => setLanguage('en'));

describe('Telegram bot browser confirmation', () => {
  it('shows the named Telegram identity and requires explicit browser confirmation', () => {
    const html = render();
    expect(html).toContain('aria-labelledby="telegram-bot-login-title"');
    expect(html).toContain('Continue as RD - Dev'); expect(html).toContain('@rd_dev');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('Only continue if you requested this login.');
    expect(html).toContain('Previously used Telegram login? Recover your existing account');
    expect(html).not.toContain('You’ll be logged in to Kollens in this browser.');
  });
  it('explains the browser destination for a Telegram in-app or different browser', () => {
    expect(render({ preview: { ...preview, sameBrowser: false } })).toContain('You’ll be logged in to Kollens in this browser.');
  });
  it('requires explicit one-time recovery instead of completing into an empty account', () => {
    const html = render({ preview: { ...preview, requiresRecovery: true } });
    expect(html).toContain('One-time Telegram verification is needed to preserve existing accounts.');
    expect(html).toContain('Verify Telegram account'); expect(html).not.toContain('Continue as RD - Dev');
    expect(html).not.toContain('Previously used Telegram login?');
    const required = render({ error: 'One-time Telegram verification is needed to preserve existing accounts.' });
    expect(required).toContain('Verify Telegram account'); expect(required).not.toContain('Retry login');
  });
  it('does not display an identity or completion button while loading or in an error state', () => {
    const loading = render({ loading: true });
    expect(loading).toContain('Checking your Telegram login'); expect(loading).not.toContain('Continue as');
    const expired = render({ error: 'This login link has expired or was already used.' });
    expect(expired).toContain('Log in with Telegram'); expect(expired).not.toContain('Continue as');
    const conflict = render({ error: 'Log out before signing in to a different Telegram account.' });
    expect(conflict).toContain('Go to your account'); expect(conflict).not.toContain('Continue as'); expect(conflict).not.toContain('Log out</button>');
  });
  it('escapes Telegram names and keeps the confirmation text unchanged during submission', () => {
    const html = render({ busy: true, preview: { ...preview, user: { name: '<script>name</script>', username: null, avatarUrl: null } } });
    expect(html).toContain('&lt;script&gt;name&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toMatch(/button[^>]*disabled=""/); expect(html).not.toContain('Loading');
  });
  it('supports Chinese confirmation and error states', () => {
    setLanguage('zh-CN');
    expect(render()).toContain('以 RD - Dev 的身份继续');
    expect(render({ error: 'This login link has expired or was already used.' })).toContain('此登录链接已过期或已使用。');
  });
});
