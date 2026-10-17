export type TelegramBotConfig = { token: string; botId: string; origin: string; webhookSecret: string | null };
export type TelegramMessageButton = { text: string; url: string };
export type TelegramBotResult =
  | { kind: 'sent'; messageId: number }
  | { kind: 'retry'; retryAfterMs: number; reason: 'rate_limited' | 'unavailable' }
  | { kind: 'blocked' }
  | { kind: 'failed'; reason: string }
  | { kind: 'uncertain'; reason: string };

const positiveId = (value: string) => /^[1-9]\d{0,15}$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);

/** Server configuration only. Never include this object in responses or diagnostics. */
export function telegramBotConfig(env: NodeJS.ProcessEnv = process.env): TelegramBotConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const botId = env.TELEGRAM_CLIENT_ID?.trim();
  if (!token || !botId || !positiveId(botId) || !new RegExp(`^${botId}:[A-Za-z0-9_-]{20,200}$`).test(token) || !env.PUBLIC_APP_URL?.trim()) return null;
  try {
    const url = new URL(env.PUBLIC_APP_URL.trim());
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) return null;
    const secure = env.NODE_ENV === 'production' || url.protocol === 'https:';
    if ((secure && url.protocol !== 'https:') || (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
    if (webhookSecret && !/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) return null;
    return { token, botId, origin: url.origin, webhookSecret };
  } catch { return null; }
}

type BotEnvelope = { ok?: unknown; result?: unknown; error_code?: unknown; parameters?: { retry_after?: unknown } };
type BotResponse = { status: number; body: BotEnvelope };
class BotRequestError extends Error {
  constructor(readonly category: 'timeout' | 'network' | 'response_too_large' | 'invalid_response') { super(category); }
}

async function boundedJson(response: Response): Promise<BotEnvelope> {
  const maxBytes = 64 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) { void response.body?.cancel().catch(() => undefined); throw new BotRequestError('response_too_large'); }
  if (!response.body) throw new BotRequestError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { void reader.cancel().catch(() => undefined); throw new BotRequestError('response_too_large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as BotEnvelope;
  } catch { throw new BotRequestError('invalid_response'); }
}

function validButtons(buttons?: TelegramMessageButton[][]) {
  return !buttons || (buttons.length <= 8 && buttons.every(row => row.length > 0 && row.length <= 8 && row.every(button => {
    if (typeof button.text !== 'string' || !button.text.trim() || button.text.length > 64 || typeof button.url !== 'string' || button.url.length > 2048) return false;
    try { const url = new URL(button.url); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  })));
}

export function createTelegramBot(config: TelegramBotConfig, options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let identity: { valid: boolean; expiresAt: number } | null = null;
  let identityRequest: Promise<boolean> | null = null;

  async function request(method: 'getMe' | 'sendMessage' | 'editMessageText', payload: Record<string, unknown>): Promise<BotResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BotRequestError('timeout')); }, 8_000); });
    try {
      return await Promise.race([timeout, (async () => {
        let response: Response;
        try {
          response = await fetcher(`https://api.telegram.org/bot${config.token}/${method}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error',
          });
        } catch { throw new BotRequestError(controller.signal.aborted ? 'timeout' : 'network'); }
        let body: BotEnvelope;
        try { body = await boundedJson(response); }
        catch (error) {
          if (!(error instanceof BotRequestError) || error.category !== 'invalid_response' || response.status < 400) throw error;
          // A rejected HTTP request can be classified even when a proxy returns HTML.
          const retryAfter = Number(response.headers.get('retry-after'));
          body = response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? { parameters: { retry_after: retryAfter } } : {};
        }
        return { status: response.status, body };
      })()]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }

  async function verifyIdentity(): Promise<boolean> {
    if (identity && identity.expiresAt > now()) return identity.valid;
    if (identityRequest) return identityRequest;
    identityRequest = (async () => {
      let valid = false;
      try {
        const response = await request('getMe', {});
        const user = response.body.result as { id?: unknown; is_bot?: unknown } | undefined;
        valid = response.status === 200 && response.body.ok === true && user?.is_bot === true && typeof user.id === 'number' && Number.isSafeInteger(user.id) && String(user.id) === config.botId;
      } catch { /* Fixed identity state only; provider errors may contain the bot token. */ }
      identity = { valid, expiresAt: now() + (valid ? 600_000 : 30_000) };
      return valid;
    })().finally(() => { identityRequest = null; });
    return identityRequest;
  }

  async function deliver(method: 'sendMessage' | 'editMessageText', chatId: string, text: string, buttons?: TelegramMessageButton[][], messageId?: number): Promise<TelegramBotResult> {
    if (!positiveId(chatId) || typeof text !== 'string' || !text.trim() || text.length > 4096 || !validButtons(buttons) || (method === 'editMessageText' && (!Number.isSafeInteger(messageId) || messageId! <= 0))) return { kind: 'failed', reason: 'invalid_message' };
    if (!await verifyIdentity()) return { kind: 'failed', reason: 'bot_identity_unverified' };
    try {
      const response = await request(method, {
        chat_id: chatId, text, ...(messageId ? { message_id: messageId } : {}),
        link_preview_options: { is_disabled: true },
        ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
      });
      const code = typeof response.body.error_code === 'number' ? response.body.error_code : response.status;
      if (response.status === 429 || code === 429) {
        const delay = response.body.parameters?.retry_after;
        const retryAfterMs = typeof delay === 'number' && Number.isFinite(delay) ? Math.min(86_400_000, Math.max(1_000, Math.ceil(delay * 1000))) : 1_000;
        return { kind: 'retry', reason: 'rate_limited', retryAfterMs };
      }
      if (response.status === 403 || code === 403) return { kind: 'blocked' };
      if (response.status >= 500 || code >= 500) return { kind: 'uncertain', reason: 'upstream_unavailable' };
      if (response.status >= 400 || response.body.ok !== true) return { kind: 'failed', reason: code === 401 ? 'bot_unauthorized' : code === 400 ? 'message_rejected' : 'api_rejected' };
      const sent = response.body.result as { message_id?: unknown } | undefined;
      if (typeof sent?.message_id !== 'number' || !Number.isSafeInteger(sent.message_id) || sent.message_id <= 0) return { kind: 'uncertain', reason: 'invalid_response' };
      return { kind: 'sent', messageId: sent.message_id };
    } catch (error) {
      return { kind: 'uncertain', reason: error instanceof BotRequestError ? error.category : 'network' };
    }
  }

  return {
    verifyIdentity,
    send: (chatId: string, text: string, buttons?: TelegramMessageButton[][]) => deliver('sendMessage', chatId, text, buttons),
    edit: (chatId: string, messageId: number, text: string, buttons?: TelegramMessageButton[][]) => deliver('editMessageText', chatId, text, buttons, messageId),
  };
}
