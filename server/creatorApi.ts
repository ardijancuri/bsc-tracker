import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { pool } from './db.js';
import { authSessionSecret, resolveAuthUser, type ResolvedAuthUser } from './telegramAuth.js';
import { createCreatorService, CreatorInputError, creatorOrigin, creatorSessionHash, creatorWallet } from './creatorProfiles.js';
import { creatorChainId } from '../shared/creatorProfiles.js';
import type { Rpc } from './rpc.js';

type CreatorApiOptions = {
  pool?: Pool;
  rpc?: Rpc;
  origin?: string;
  resolveUser?: (request: FastifyRequest) => Promise<ResolvedAuthUser | null>;
};
function privateResponse(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie').header('Referrer-Policy', 'no-referrer');
}
export function registerCreatorRoutes(app: FastifyInstance, options: CreatorApiOptions = {}) {
  const db = options.pool ?? pool, service = createCreatorService(db, options.rpc);
  const origin = creatorOrigin(options.origin ?? process.env.PUBLIC_APP_URL ?? 'https://kollens.com');
  const resolve = options.resolveUser ?? (request => resolveAuthUser(request, db));
  const limits = new Map<string, { count: number; until: number }>();
  function mutation(request: FastifyRequest, reply: FastifyReply) {
    if (request.headers.origin !== origin) {
      reply.code(403).send({ error: 'Request origin rejected', code: 'wrong_origin' }); return false;
    }
    const now = Date.now();
    if (limits.size > 5000) for (const [key, value] of limits) if (value.until <= now) limits.delete(key);
    if (limits.size >= 10000 && !limits.has(request.ip)) { reply.code(429).header('Retry-After', '60').send({ error: 'Try again shortly', code: 'rate_limited' }); return false; }
    const previous = limits.get(request.ip), entry = previous && previous.until > now ? previous : { count: 0, until: now + 60000 };
    limits.set(request.ip, entry);
    if (++entry.count > 30) { reply.code(429).header('Retry-After', '60').send({ error: 'Try again shortly', code: 'rate_limited' }); return false; }
    return true;
  }
  async function account(request: FastifyRequest, reply: FastifyReply) {
    privateResponse(reply);
    const user = await resolve(request), secret = authSessionSecret(request.headers.cookie);
    if (!user || !secret) { reply.code(401).send({ error: 'Sign in with Telegram to manage creator profiles', code: 'unauthorized' }); return null; }
    const owner = request.headers['x-watchlist-owner'];
    if (owner !== undefined && owner !== user.id) { reply.code(409).send({ error: 'Your account changed. Refresh and try again.', code: 'account_changed' }); return null; }
    return { user, sessionHash: creatorSessionHash(secret) };
  }
  async function result(reply: FastifyReply, operation: () => Promise<unknown>) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof CreatorInputError) return reply.code(error.status).send({ error: error.message, code: error.code });
      app.log.warn({ event: 'creator_profile_failed' }, 'Creator profile request failed');
      return reply.code(503).send({ error: 'Creator profiles are temporarily unavailable', code: 'node_unavailable' });
    }
  }
  app.get('/api/creator/profiles', { logLevel: 'silent' }, async (request, reply) => {
    const identity = await account(request, reply); if (!identity) return;
    return result(reply, () => service.mine(identity.user.id).then(profiles => ({ profiles })));
  });
  app.get<{ Params: { wallet: string } }>('/api/kols/:wallet/creator', { logLevel: 'silent' }, async (request, reply) => {
    privateResponse(reply);
    return result(reply, async () => service.status(creatorWallet(request.params.wallet), (await resolve(request))?.id ?? null));
  });
  app.post<{ Params: { wallet: string } }>('/api/kols/:wallet/creator/challenge', { logLevel: 'silent', bodyLimit: 1024 }, async (request, reply) => {
    privateResponse(reply); if (!mutation(request, reply)) return;
    const identity = await account(request, reply); if (!identity) return;
    return result(reply, async () => {
      const body = request.body as Record<string, unknown> | null;
      if (!body || body.chainId !== creatorChainId || !['claim', 'release'].includes(String(body.action))) throw new CreatorInputError('invalid_input', 'Select BNB Smart Chain (chain ID 56) and try again');
      return service.challenge(creatorWallet(request.params.wallet), identity.user.id, identity.sessionHash, origin, body.action as 'claim' | 'release');
    });
  });
  for (const action of ['claim', 'release'] as const) {
    app.post<{ Params: { wallet: string } }>(`/api/kols/:wallet/creator/${action}`, { logLevel: 'silent', bodyLimit: 20000 }, async (request, reply) => {
      privateResponse(reply); if (!mutation(request, reply)) return;
      const identity = await account(request, reply); if (!identity) return;
      return result(reply, async () => {
        const body = request.body as Record<string, unknown> | null;
        return service.prove({ wallet: creatorWallet(request.params.wallet), userId: identity.user.id,
          sessionHash: identity.sessionHash, origin, action, challengeId: body?.challengeId, signature: body?.signature });
      });
    });
  }
  app.patch<{ Params: { wallet: string } }>('/api/kols/:wallet/creator', { logLevel: 'silent', bodyLimit: 8192 }, async (request, reply) => {
    privateResponse(reply); if (!mutation(request, reply)) return;
    const identity = await account(request, reply); if (!identity) return;
    return result(reply, () => service.update(creatorWallet(request.params.wallet), identity.user.id, request.body));
  });
  app.post<{ Params: { wallet: string } }>('/api/kols/:wallet/creator/avatar', { logLevel: 'silent', bodyLimit: 2_800_000 }, async (request, reply) => {
    privateResponse(reply); if (!mutation(request, reply)) return;
    const identity = await account(request, reply); if (!identity) return;
    return result(reply, () => service.avatar(creatorWallet(request.params.wallet), identity.user.id, request.body));
  });
  app.get<{ Params: { wallet: string } }>('/api/kols/:wallet/creator/avatar', { logLevel: 'silent' }, async (request, reply) => result(reply, async () => {
    const image = await service.image(creatorWallet(request.params.wallet));
    if (!image?.data) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'Image not found' });
    const etag = `"${image.hash}"`;
    reply.header('Cache-Control', 'public,max-age=3600').header('X-Content-Type-Options', 'nosniff').header('ETag', etag);
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('image/webp').send(image.data);
  }));
}
