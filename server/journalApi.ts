import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { pool } from './db.js';
import { resolveAuthUser, telegramAuthConfig, type ResolvedAuthUser } from './telegramAuth.js';
import { journalService, JournalInputError, type createJournalService } from './journalService.js';

type Service = ReturnType<typeof createJournalService>;
export function registerJournalRoutes(app: FastifyInstance, options: { db?: Pool; service?: Service; resolveUser?: (request: FastifyRequest) => Promise<ResolvedAuthUser | null> } = {}) {
  const db = options.db ?? pool, service = options.service ?? journalService;
  const resolve = options.resolveUser ?? ((request: FastifyRequest) => resolveAuthUser(request, db));
  const attempts = new Map<string, { until: number; count: number }>();
  const account = async (request: FastifyRequest, reply: FastifyReply, mutation = false) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Cookie').header('Referrer-Policy', 'no-referrer');
    const user = await resolve(request);
    if (!user) { reply.code(401).send({ error: 'Sign in with Telegram to use your private portfolio' }); return null; }
    const expected = request.headers['x-watchlist-owner'];
    if (expected !== undefined && expected !== user.id) { reply.code(409).send({ error: 'Your account changed. Refresh and try again.' }); return null; }
    if (mutation) {
      const origin = telegramAuthConfig()?.origin ?? 'https://kollens.com';
      const development = process.env.NODE_ENV !== 'production' && request.headers.origin === `${request.protocol}://${request.headers.host}`;
      if (request.headers.origin !== origin && !development) { reply.code(403).send({ error: 'Request origin rejected' }); return null; }
      const now = Date.now(), entry = attempts.get(user.id);
      const current = entry && entry.until > now ? entry : { until: now + 60_000, count: 0 };
      attempts.set(user.id, current);
      if (++current.count > 60) { reply.code(429).header('Retry-After', '60').send({ error: 'Try again shortly' }); return null; }
      if (attempts.size > 10000) for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    }
    return user;
  };
  const result = async (reply: FastifyReply, work: () => Promise<unknown>) => {
    try { return await work(); }
    catch (error) {
      if (error instanceof JournalInputError) return reply.code(error.statusCode).send({ error: error.message });
      app.log.warn({ event: 'journal_api_unavailable' }, 'Private portfolio preparation unavailable');
      return reply.code(503).header('Retry-After', '3').send({ error: 'Your private portfolio is temporarily unavailable. Try again shortly.' });
    }
  };
  const settings = { logLevel: 'silent' as const };
  app.get('/api/journal/wallets', settings, async (request, reply) => { const user = await account(request, reply); if (user) return result(reply, () => service.list(user.id)); });
  app.post<{ Body: { address?: unknown; label?: unknown } }>('/api/journal/wallets', settings, async (request, reply) => {
    const user = await account(request, reply, true); if (user) return result(reply, () => service.add(user.id, request.body?.address, request.body?.label ?? ''));
  });
  app.patch<{ Params: { wallet: string }; Body: { label?: unknown } }>('/api/journal/wallets/:wallet', settings, async (request, reply) => {
    const user = await account(request, reply, true); if (user) return result(reply, () => service.updateLabel(user.id, request.params.wallet, request.body?.label));
  });
  app.delete<{ Params: { wallet: string } }>('/api/journal/wallets/:wallet', settings, async (request, reply) => {
    const user = await account(request, reply, true); if (user) return result(reply, () => service.remove(user.id, request.params.wallet));
  });
  app.post<{ Params: { wallet: string } }>('/api/journal/wallets/:wallet/older', settings, async (request, reply) => {
    const user = await account(request, reply, true); if (user) return result(reply, () => service.older(user.id, request.params.wallet));
  });
  for (const endpoint of ['summary', 'positions']) app.get<{ Querystring: { wallet?: string } }>(`/api/journal/${endpoint}`, settings, async (request, reply) => {
    const user = await account(request, reply); if (user) return result(reply, () => service.summary(user.id, request.query.wallet));
  });
  app.get<{ Querystring: { wallet?: string; cursor?: string } }>('/api/journal/activity', settings, async (request, reply) => {
    const user = await account(request, reply); if (user) return result(reply, () => service.activity(user.id, request.query.wallet, request.query.cursor));
  });
  app.get<{ Params: { wallet: string; token: string }; Querystring: { replay?: string; pnl?: string; snapshot?: string } }>('/api/journal/wallets/:wallet/tokens/:token/activity', settings, async (request, reply) => {
    const user = await account(request, reply); if (!user) return;
    return result(reply, async () => {
      const value = await service.tokenActivity(user.id, request.params.wallet.toLowerCase(), request.params.token.toLowerCase(), request.query.replay === 'true', request.query.snapshot);
      if (value === null) return reply.code(202).header('Retry-After', '2').send({ status: 'pending' });
      if (!value) return reply.code(404).send({ error: 'Portfolio token activity not found' });
      return value;
    });
  });
  app.get<{ Params: { wallet: string; token: string }; Querystring: { end?: string; snapshot?: string } }>('/api/journal/wallets/:wallet/tokens/:token/replay-chart', settings, async (request, reply) => {
    const user = await account(request, reply); if (!user) return;
    if (request.query.end !== undefined && request.query.end !== 'current') return reply.code(400).send({ error: 'Invalid replay ending' });
    return result(reply, () => service.replayChart(user.id, request.params.wallet.toLowerCase(), request.params.token.toLowerCase(), request.query.end === 'current', request.query.snapshot));
  });
}
