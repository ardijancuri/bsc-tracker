import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { pool } from './db.js';
import { resolveAuthUser, telegramAuthConfig, verifiedTelegramId, type ResolvedAuthUser, type TelegramAuthConfig } from './telegramAuth.js';
import type { TelegramNotificationState } from '../shared/telegramNotifications.js';

export type TelegramNotificationPatch = Partial<Pick<TelegramNotificationState, 'enabled' | 'buys' | 'sells' | 'language'>>;
export type TelegramNotificationUpdate = { updateId: string; telegramId: string; command: 'stop' | 'start' | 'status' | null; blocked?: boolean };
export type TelegramNotificationApiOptions = {
  pool?: Pool;
  config?: TelegramAuthConfig | null;
  webhookSecret?: string;
  available(): boolean;
  state(userId: string): Promise<TelegramNotificationState>;
  update(userId: string, patch: TelegramNotificationPatch): Promise<TelegramNotificationState>;
  mute(userId: string, wallet: string, muted: boolean): Promise<TelegramNotificationState>;
  webhook(update: TelegramNotificationUpdate): Promise<void>;
  resolveUser?: (request: FastifyRequest) => Promise<ResolvedAuthUser | null>;
};

function privateResponse(reply: FastifyReply) { reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie').header('Referrer-Policy', 'no-referrer'); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function telegramWebhookSecretMatches(expected: string | undefined, actual: unknown) {
  if (!expected || !/^[A-Za-z0-9_-]{1,256}$/.test(expected) || typeof actual !== 'string') return false;
  const left = Buffer.from(expected), right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Only direct private-chat commands and membership changes affect an account. */
export function parseTelegramNotificationUpdate(body: unknown): TelegramNotificationUpdate | null {
  if (!object(body) || !Number.isSafeInteger(body.update_id) || Number(body.update_id) < 0) return null;
  const updateId = String(body.update_id);
  if (object(body.message)) {
    const message = body.message;
    if (!object(message.chat) || message.chat.type !== 'private' || !object(message.from) || message.from.is_bot === true) return null;
    const telegramId = verifiedTelegramId(message.chat.id);
    if (!telegramId || verifiedTelegramId(message.from.id) !== telegramId || typeof message.text !== 'string') return null;
    const command = /^\/(stop|start|status)(?:@[A-Za-z0-9_]{1,64})?(?:\s|$)/.exec(message.text)?.[1] as TelegramNotificationUpdate['command'] | undefined;
    return command ? { updateId, telegramId, command } : null;
  }
  if (object(body.my_chat_member)) {
    const member = body.my_chat_member;
    if (!object(member.chat) || member.chat.type !== 'private' || !object(member.new_chat_member)) return null;
    const telegramId = verifiedTelegramId(member.chat.id);
    if (!telegramId || !['kicked', 'member'].includes(String(member.new_chat_member.status))) return null;
    return { updateId, telegramId, command: null, blocked: member.new_chat_member.status === 'kicked' };
  }
  return null;
}

export function registerTelegramNotificationRoutes(app: FastifyInstance, options: TelegramNotificationApiOptions) {
  const db = options.pool ?? pool;
  const config = options.config === undefined ? telegramAuthConfig() : options.config;
  const attempts = new Map<string, { count: number; until: number }>();
  const getUser = options.resolveUser ?? (request => resolveAuthUser(request, db));
  async function account(request: FastifyRequest, reply: FastifyReply) {
    privateResponse(reply);
    const user = await getUser(request);
    if (!user) { reply.code(401).send({ error: 'Sign in to manage Telegram alerts' }); return null; }
    const expected = request.headers['x-watchlist-owner'];
    if (expected !== undefined && expected !== user.id) { reply.code(409).send({ error: 'Your account changed. Refresh and try again.' }); return null; }
    return user;
  }
  function mutationAllowed(request: FastifyRequest, reply: FastifyReply) {
    let expected = config?.origin ?? 'https://kollens.com';
    try { expected = config?.origin ?? new URL(process.env.PUBLIC_APP_URL || expected).origin; } catch { /* Disabled invalid config keeps the pinned production default. */ }
    const origin = request.headers.origin;
    const development = process.env.NODE_ENV !== 'production' && origin === `${request.protocol}://${request.headers.host}`;
    if (origin !== expected && !development) { reply.code(403).send({ error: 'Request origin rejected' }); return false; }
    const now = Date.now();
    if (attempts.size > 5000) for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    if (attempts.size >= 10_000 && !attempts.has(request.ip)) { reply.code(429).header('Retry-After', '60').send({ error: 'Try again shortly' }); return false; }
    const previous = attempts.get(request.ip);
    const entry = previous && previous.until > now ? previous : { count: 0, until: now + 60_000 };
    attempts.set(request.ip, entry);
    if (++entry.count > 120) { reply.code(429).header('Retry-After', '60').send({ error: 'Try again shortly' }); return false; }
    return true;
  }
  async function result(reply: FastifyReply, run: () => Promise<TelegramNotificationState>) {
    try { return await run(); }
    catch (error) {
      if (error instanceof Error && error.name === 'TelegramNotificationInputError') {
        const code = 'status' in error ? error.status : 'statusCode' in error ? error.statusCode : 400;
        return reply.code(typeof code === 'number' && [400, 404, 409, 503].includes(code) ? code : 400).send({ error: error.message });
      }
      app.log.warn({ event: 'telegram_notifications_api_failed' }, 'Telegram alert settings unavailable');
      return reply.code(503).send({ error: 'Telegram alerts are temporarily unavailable' });
    }
  }
  app.get('/api/notifications/telegram', { logLevel: 'silent' }, async (request, reply) => {
    const user = await account(request, reply);
    if (!user) return;
    return result(reply, async () => ({ ...await options.state(user.id), available: options.available() }));
  });
  app.patch('/api/notifications/telegram', { logLevel: 'silent', bodyLimit: 4096 }, async (request, reply) => {
    privateResponse(reply);
    if (!mutationAllowed(request, reply)) return;
    const user = await account(request, reply);
    if (!user) return;
    const body = request.body;
    if (!object(body) || !Object.keys(body).length || Object.keys(body).some(key => !['enabled', 'buys', 'sells', 'language'].includes(key))
      || ['enabled', 'buys', 'sells'].some(key => body[key] !== undefined && typeof body[key] !== 'boolean')
      || (body.language !== undefined && body.language !== 'en' && body.language !== 'zh-CN') || (body.buys === false && body.sells === false)) return reply.code(400).send({ error: 'Invalid notification preferences' });
    if (body.enabled === true && !options.available()) return reply.code(503).send({ error: 'Telegram alerts are not configured' });
    return result(reply, () => options.update(user.id, body as TelegramNotificationPatch));
  });
  app.put<{ Params: { wallet: string } }>('/api/notifications/telegram/kols/:wallet', { logLevel: 'silent', bodyLimit: 4096 }, async (request, reply) => {
    privateResponse(reply);
    if (!mutationAllowed(request, reply)) return;
    const user = await account(request, reply);
    if (!user) return;
    const body = request.body;
    if (!/^0x[0-9a-fA-F]{40}$/.test(request.params.wallet) || !object(body) || Object.keys(body).length !== 1 || typeof body.muted !== 'boolean') return reply.code(400).send({ error: 'Invalid KOL notification request' });
    return result(reply, () => options.mute(user.id, request.params.wallet.toLowerCase(), body.muted as boolean));
  });
  app.post('/api/telegram/webhook', { logLevel: 'silent', bodyLimit: 65_536, onRequest: async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!telegramWebhookSecretMatches(options.webhookSecret ?? process.env.TELEGRAM_WEBHOOK_SECRET, request.headers['x-telegram-bot-api-secret-token'])) return reply.code(403).send({ error: 'Webhook authentication failed' });
  } }, async (request, reply) => {
    if (!object(request.body) || !Number.isSafeInteger(request.body.update_id) || Number(request.body.update_id) < 0) return reply.code(400).send({ error: 'Invalid Telegram update' });
    const update = parseTelegramNotificationUpdate(request.body);
    if (update) {
      try { await options.webhook(update); }
      catch { app.log.warn({ event: 'telegram_webhook_failed' }, 'Telegram update could not be saved'); return reply.code(503).send({ error: 'Try again shortly' }); }
    }
    return { ok: true };
  });
}
