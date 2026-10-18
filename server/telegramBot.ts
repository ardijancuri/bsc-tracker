export type TelegramBotConfig = { token: string; botId: string; origin: string; webhookSecret: string | null };
export type TelegramMessageButton = { text: string; url: string };
export type TelegramMessageEntity = { type: 'bold' | 'text_link'; offset: number; length: number; url?: string };
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

function validEntities(text: string, entities?: TelegramMessageEntity[]) {
  return !entities || (entities.length <= 100 && entities.every(entity => {
    if (!['bold', 'text_link'].includes(entity.type) || !Number.isSafeInteger(entity.offset) || !Number.isSafeInteger(entity.length)
      || entity.offset < 0 || entity.length <= 0 || entity.offset + entity.length > text.length) return false;
    if (entity.type === 'bold') return entity.url === undefined;
    try { const url = new URL(entity.url ?? ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
  }));
}

export function createTelegramBot(config: TelegramBotConfig, options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let identity: { valid: boolean; username: string | null; expiresAt: number } | null = null;
  let identityRequest: Promise<boolean> | null = null;
  let webhookState: { matches: boolean; expiresAt: number } | null = null;
  let webhookRequest: Promise<boolean> | null = null;

  async function request(method: 'getMe' | 'getWebhookInfo' | 'sendMessage' | 'editMessageText' | 'getUserProfilePhotos' | 'getFile', payload: Record<string, unknown>, timeoutMs = 8_000): Promise<BotResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new BotRequestError('timeout')); }, timeoutMs); });
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

  /** A shared live bot cannot receive a localhost attempt. Do not change its registered webhook here. */
  async function webhookMatchesOrigin(): Promise<boolean> {
    if (webhookState && webhookState.expiresAt > now()) return webhookState.matches;
    if (webhookRequest) return webhookRequest;
    webhookRequest = (async () => {
      let matches = false;
      try {
        const response = await request('getWebhookInfo', {}, 3_000);
        const value = response.body.result as { url?: unknown } | undefined;
        matches = response.status === 200 && response.body.ok === true && value?.url === `${config.origin}/api/telegram/webhook`;
      } catch { /* Fixed readiness only: never log Bot API URLs or provider bodies. */ }
      webhookState = { matches, expiresAt: now() + (matches ? 60_000 : 15_000) };
      return matches;
    })().finally(() => { webhookRequest = null; });
    return webhookRequest;
  }

  async function verifyIdentity(): Promise<boolean> {
    if (identity && identity.expiresAt > now()) return identity.valid;
    if (identityRequest) return identityRequest;
    identityRequest = (async () => {
      let valid = false;
      let username: string | null = null;
      try {
        const response = await request('getMe', {});
        const user = response.body.result as { id?: unknown; is_bot?: unknown; username?: unknown } | undefined;
        valid = response.status === 200 && response.body.ok === true && user?.is_bot === true && typeof user.id === 'number' && Number.isSafeInteger(user.id) && String(user.id) === config.botId;
        if (valid && typeof user?.username === 'string' && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(user.username)) username = user.username;
      } catch { /* Fixed identity state only; provider errors may contain the bot token. */ }
      identity = { valid, username, expiresAt: now() + (valid ? 600_000 : 30_000) };
      return valid;
    })().finally(() => { identityRequest = null; });
    return identityRequest;
  }

  /** Optional profile bytes stay server-side; file URLs contain the bot credential. */
  async function profilePhoto(telegramId: string): Promise<Buffer | null> {
    if (!positiveId(telegramId) || !await verifyIdentity()) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 3_000;
    const loading = (async () => { try {
      const photos = await request('getUserProfilePhotos', { user_id: telegramId, limit: 1 }, Math.max(1, deadline - Date.now()));
      const result = photos.body.result as { photos?: { file_id?: unknown; file_size?: unknown }[][] } | undefined;
      const photo = result?.photos?.[0]?.[0];
      if (!photos.body.ok || typeof photo?.file_id !== 'string' || photo.file_id.length > 512 || Number(photo.file_size) > 2_097_152) return null;
      const file = await request('getFile', { file_id: photo.file_id }, Math.max(1, deadline - Date.now()));
      const info = file.body.result as { file_path?: unknown; file_size?: unknown } | undefined;
      if (!file.body.ok || typeof info?.file_path !== 'string' || !/^[A-Za-z0-9_/-]+\.(?:jpg|jpeg|png|webp)$/i.test(info.file_path)
        || info.file_path.includes('..') || info.file_path.length > 512 || Number(info.file_size) > 2_097_152 || controller.signal.aborted) return null;
      const response = await fetcher(`https://api.telegram.org/file/bot${config.token}/${info.file_path}`, { signal: controller.signal, redirect: 'error' });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > 2_097_152) { void response.body?.cancel().catch(() => undefined); return null; }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      try { while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 2_097_152 || controller.signal.aborted) { void reader.cancel().catch(() => undefined); return null; }
        chunks.push(chunk.value);
      } } finally { reader.releaseLock(); }
      return Buffer.concat(chunks);
    } catch { return null; } })();
    try { return await Promise.race([loading, new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 3_000); })]); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }

  async function deliver(method: 'sendMessage' | 'editMessageText', chatId: string, text: string, buttons?: TelegramMessageButton[][], messageId?: number, entities?: TelegramMessageEntity[]): Promise<TelegramBotResult> {
    if (!positiveId(chatId) || typeof text !== 'string' || !text.trim() || text.length > 4096 || !validButtons(buttons) || !validEntities(text, entities) || (method === 'editMessageText' && (!Number.isSafeInteger(messageId) || messageId! <= 0))) return { kind: 'failed', reason: 'invalid_message' };
    if (!await verifyIdentity()) return { kind: 'failed', reason: 'bot_identity_unverified' };
    try {
      const response = await request(method, {
        chat_id: chatId, text, ...(messageId ? { message_id: messageId } : {}),
        ...(entities?.length ? { entities } : {}),
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
    webhookMatchesOrigin,
    identity: async () => await verifyIdentity() && identity?.username ? { username: identity.username } : null,
    profilePhoto,
    send: (chatId: string, text: string, buttons?: TelegramMessageButton[][], entities?: TelegramMessageEntity[]) => deliver('sendMessage', chatId, text, buttons, undefined, entities),
    edit: (chatId: string, messageId: number, text: string, buttons?: TelegramMessageButton[][], entities?: TelegramMessageEntity[]) => deliver('editMessageText', chatId, text, buttons, messageId, entities),
  };
}
