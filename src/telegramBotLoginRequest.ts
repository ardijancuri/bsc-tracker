export type TelegramBotLoginPreview = {
  user: { name: string; username: string | null; avatarUrl: string | null };
  sameBrowser: boolean;
  expiresAt: string;
  requiresRecovery?: boolean;
};

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export function telegramBotLoginToken(fragment: string) {
  const params = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  const token = params.get('token');
  return params.size === 1 && token && tokenPattern.test(token) ? token : null;
}
export function telegramBotLoginUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.port || url.username || url.password || url.hash
    || !/^\/[A-Za-z0-9_]{5,32}$/.test(url.pathname) || url.searchParams.size !== 1
    || !/^login_[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('start') ?? '')) throw new Error('Invalid Telegram bot link');
  return url.href;
}
export function telegramBotLoginReturnTo(value: string) {
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value) || value.length > 2048) throw new Error('Invalid login return path');
  const url = new URL(value, 'https://kollens.invalid');
  if (url.origin !== 'https://kollens.invalid' || url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) throw new Error('Invalid login return path');
  return `${url.pathname}${url.search}${url.hash}`;
}
export function telegramOidcLoginUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'oauth.telegram.org' || url.port || url.username || url.password || url.hash || url.pathname !== '/auth') throw new Error('Invalid Telegram recovery link');
  return url.href;
}
export class TelegramBotLoginRequestError extends Error {
  constructor(readonly status: number) { super('Telegram login could not complete'); }
}
async function telegramLoginPost<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const response = await fetch(url, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new TelegramBotLoginRequestError(response.status);
    return await response.json() as T;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function requestTelegramBotLogin<T>(stage: 'preview' | 'complete', token: string, signal?: AbortSignal, automatic = false): Promise<T> {
  if (!tokenPattern.test(token)) throw new TelegramBotLoginRequestError(400);
  return telegramLoginPost(`/api/auth/telegram/bot/${stage}`, stage === 'complete' ? { token, confirmed: true, ...(automatic ? { automatic: true } : {}) } : { token }, signal);
}
/** Only the browser that started this login can skip the account confirmation. */
export async function resumeTelegramBotLogin(token: string, signal: AbortSignal): Promise<{ preview: TelegramBotLoginPreview; returnTo?: string }> {
  const preview = await requestTelegramBotLogin<TelegramBotLoginPreview>('preview', token, signal);
  if (!preview.user?.name || typeof preview.sameBrowser !== 'boolean' || !Number.isFinite(Date.parse(preview.expiresAt))) throw new Error('Invalid login preview');
  if (signal.aborted) throw new Error('Login cancelled');
  if (!preview.sameBrowser || preview.requiresRecovery) return { preview };
  try {
    const result = await requestTelegramBotLogin<{ returnTo: string }>('complete', token, signal, true);
    return { preview, returnTo: telegramBotLoginReturnTo(result.returnTo) };
  } catch (error) {
    // The cookie may disappear between preview and completion. Keep the link usable with explicit confirmation.
    if (error instanceof TelegramBotLoginRequestError && error.status === 403) return { preview: { ...preview, sameBrowser: false } };
    throw error;
  }
}
export async function requestTelegramLoginRecovery(token?: string | null, signal?: AbortSignal) {
  if (token && !tokenPattern.test(token)) throw new TelegramBotLoginRequestError(400);
  const result = await telegramLoginPost<{ url: string }>('/api/auth/telegram/oidc/start', { returnTo: '/watchlist', ...(token ? { botToken: token } : {}) }, signal);
  return telegramOidcLoginUrl(result.url);
}
export function telegramBotLoginError(error: unknown) {
  if (error instanceof TelegramBotLoginRequestError) {
    if (error.status === 409) return 'Log out before signing in to a different Telegram account.';
    if (error.status === 400 || error.status === 410 || error.status === 404) return 'This login link has expired or was already used.';
    if (error.status === 429) return 'Too many login attempts. Wait a moment and try again.';
    if (error.status === 422) return 'Your browser and account favorites exceed the limit. Remove some favorites and try again.';
    if (error.status === 428) return 'One-time Telegram verification is needed to preserve existing accounts.';
  }
  return 'Could not log in with Telegram. Try again.';
}
