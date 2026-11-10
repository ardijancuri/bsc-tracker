import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { analyticsDay, analyticsPublicPath } from '../shared/analytics.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bot = /bot|spider|crawler|headless|preview|lighthouse|curl\/|wget\/|python-requests|facebookexternalhit/i;
const localOrigin = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;
const key = (value: string) => createHash('sha256').update(value).digest();

export async function ensureAnalyticsSchema(db: Pick<Pool, 'query'>) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.website_analytics_daily (
      day date PRIMARY KEY,
      page_views bigint NOT NULL,
      unique_visitors bigint NOT NULL
    );
    CREATE TABLE IF NOT EXISTS public.website_analytics_keys (
      day date NOT NULL,
      is_visitor boolean NOT NULL,
      digest bytea NOT NULL,
      PRIMARY KEY (is_visitor, digest)
    );
    CREATE INDEX IF NOT EXISTS website_analytics_keys_day ON public.website_analytics_keys(day);
  `);
}

// Claim the page view before counting the visitor. Retries and simultaneous tabs
// must not increment either total more than once for the same key.
const recordPageView = `
  WITH page AS (
    INSERT INTO public.website_analytics_keys(day, is_visitor, digest)
    VALUES ($1::date, false, $2)
    ON CONFLICT DO NOTHING RETURNING 1
  ), visitor AS (
    INSERT INTO public.website_analytics_keys(day, is_visitor, digest)
    SELECT $1::date, true, $3 FROM page
    ON CONFLICT DO NOTHING RETURNING 1
  )
  INSERT INTO public.website_analytics_daily AS daily(day, page_views, unique_visitors)
  SELECT $1::date, 1, (SELECT count(*) FROM visitor) FROM page
  ON CONFLICT (day) DO UPDATE SET
    page_views = daily.page_views + EXCLUDED.page_views,
    unique_visitors = daily.unique_visitors + EXCLUDED.unique_visitors
`;

export function registerAnalytics(
  app: FastifyInstance,
  db: Pick<Pool, 'query'>,
  options: { origin?: string; development?: boolean } = {},
) {
  const siteOrigin = new URL(options.origin ?? 'https://kollens.com').origin;
  let windowEnds = 0;
  let windowCount = 0;
  let inFlight = 0;
  const sourceCounts = new Map<string, number>();

  // Drop telemetry bursts before they can fill the shared database pool.
  function allowRequest(source: string) {
    const now = Date.now();
    if (now >= windowEnds) {
      windowEnds = now + 60_000;
      windowCount = 0;
      sourceCounts.clear();
    }
    if (windowCount >= 600 || inFlight >= 4) return false;
    const digest = key(`${windowEnds}:${source}`).toString('hex');
    const count = sourceCounts.get(digest) ?? 0;
    if (count >= 90) return false;
    sourceCounts.set(digest, count + 1);
    windowCount++;
    return true;
  }

  app.post<{ Body: { id?: unknown; visitor?: unknown; path?: unknown } }>(
    '/api/analytics/page-view',
    { bodyLimit: 512, logLevel: 'silent' },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const { origin, dnt, 'sec-gpc': gpc, 'user-agent': userAgent, 'sec-fetch-site': fetchSite } = request.headers;
      if (!origin || !(origin === siteOrigin || options.development && localOrigin.test(origin))
        || (fetchSite && fetchSite !== 'same-origin')) return reply.code(403).send();
      if (dnt === '1' || gpc === '1' || !userAgent || bot.test(userAgent)) return reply.code(204).send();

      const { id, visitor, path } = request.body ?? {};
      if (typeof id !== 'string' || !uuid.test(id)
        || typeof visitor !== 'string' || !uuid.test(visitor)
        || typeof path !== 'string' || !analyticsPublicPath(path)) return reply.code(400).send();

      const proxySource = request.ips?.[1] ?? request.ip;
      if (!allowRequest(proxySource)) return reply.code(429).send();

      inFlight++;
      try {
        const day = analyticsDay();
        // No addresses, page paths, account data, user agents or browser UUIDs are stored.
        await db.query(recordPageView, [day, key(id.toLowerCase()), key(`${day}:${visitor.toLowerCase()}`)]);
        return reply.code(204).send();
      } catch {
        app.log.warn({ event: 'analytics_write_failed' }, 'Could not record a page view');
        return reply.code(503).send();
      } finally {
        inFlight--;
      }
    },
  );

  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let cleanup: Promise<unknown> | undefined;
  function pruneKeys() {
    if (cleanup) return;
    cleanup = db.query('DELETE FROM public.website_analytics_keys WHERE day < $1::date - 2', [analyticsDay()])
      .catch(() => app.log.warn({ event: 'analytics_prune_failed' }, 'Could not prune analytics keys'))
      .finally(() => { cleanup = undefined; });
  }
  app.addHook('onReady', async () => {
    pruneKeys();
    cleanupTimer = setInterval(pruneKeys, 60 * 60_000);
    cleanupTimer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(cleanupTimer);
    await cleanup;
  });
}
