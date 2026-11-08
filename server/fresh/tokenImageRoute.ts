import type { FastifyInstance } from 'fastify';
import { loadFreshArtwork } from './artwork.js';

type StoredImage = { logo_data: Buffer | null; logo_mime: string | null };
type ArtworkLoader = typeof loadFreshArtwork;
const maxCached = 256;
const maxActive = 8;

export function registerFreshTokenImage(
  app: FastifyInstance,
  findStored: (address: string) => Promise<StoredImage | undefined>,
  load: ArtworkLoader = loadFreshArtwork,
) {
  const pending = new Map<string, Promise<Buffer | null>>();
  const cache = new Map<string, { data: Buffer | null; expiresAt: number }>();
  let budget = { until: 0, count: 0 };

  async function lookup(address: string) {
    const signal = AbortSignal.timeout(12_000);
    // Flap can have original artwork before it appears in market indexes.
    // Each provider must verify the full BSC contract before supplying an image.
    for (const provider of ['flap', 'auto', 'pancakeswap'] as const) {
      if (signal.aborted) break;
      try {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
        return (await load(address, { provider, signal: deadline })).data;
      } catch { /* Try the next exact-contract source. */ }
    }
    return null;
  }

  app.get<{ Params: { address: string }; Querystring: { fallback?: string } }>('/api/token-image/:address', async (req, reply) => {
    const address = req.params.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) return reply.code(404).send();
    const stored = await findStored(address);
    if (stored?.logo_data) return reply.header('Cache-Control', 'public,max-age=3600').type(stored.logo_mime ?? 'image/webp').send(stored.logo_data);
    if (req.query.fallback !== 'extension') return reply.code(404).send();

    const now = Date.now();
    const cached = cache.get(address);
    if (cached && cached.expiresAt > now) {
      cache.delete(address);
      cache.set(address, cached);
      return cached.data
        ? reply.header('Cache-Control', 'public,max-age=3600').type('image/webp').send(cached.data)
        : reply.header('Cache-Control', 'public,max-age=60').code(404).send();
    }

    let work = pending.get(address);
    if (!work) {
      if (now >= budget.until) budget = { until: now + 60_000, count: 0 };
      if (pending.size >= maxActive || budget.count >= 60) return reply.header('Cache-Control', 'no-store').header('Retry-After', '5').code(503).send();
      budget.count++;
      work = lookup(address).then(data => {
        cache.delete(address);
        cache.set(address, { data, expiresAt: Date.now() + (data ? 3_600_000 : 60_000) });
        if (cache.size > maxCached) cache.delete(cache.keys().next().value!);
        return data;
      }).finally(() => pending.delete(address));
      pending.set(address, work);
    }
    const data = await work;
    return data
      ? reply.header('Cache-Control', 'public,max-age=3600').type('image/webp').send(data)
      : reply.header('Cache-Control', 'public,max-age=60').code(404).send();
  });
}
