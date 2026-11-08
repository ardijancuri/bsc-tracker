import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerFreshTokenImage } from './tokenImageRoute.js';

const address = '0x022ceb5bafac618902c5fd8f1a2636388f137777';
const storedAddress = '0x44b626e510ebf3ec02949fd4a3fa512f49c67777';
const data = Buffer.from('contract image');
const request = (address: string) => '/api/token-image/' + address;

describe('extension token artwork', () => {
  it('serves stored images first and only looks up explicitly requested extension fallbacks', async () => {
    const app = Fastify();
    const load = vi.fn();
    registerFreshTokenImage(app, async key => key === storedAddress ? { logo_data: data, logo_mime: 'image/webp' } : undefined, load);
    try {
      expect((await app.inject(request(address))).statusCode).toBe(404);
      expect((await app.inject(request('CATONFONE') + '?fallback=extension')).statusCode).toBe(404);
      const stored = await app.inject(request(storedAddress) + '?fallback=extension');
      expect(stored.statusCode).toBe(200);
      expect(stored.rawPayload).toEqual(data);
      expect(load).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('shares the lookup for one exact contract and caches both images and misses', async () => {
    const app = Fastify();
    const load = vi.fn(async (key: string) => {
      if (key !== address) throw new Error('Artwork unavailable');
      return { data, mime: 'image/webp' as const, url: 'https://example.com/image.webp', source: 'flap_contract_page' as const };
    });
    registerFreshTokenImage(app, async () => undefined, load);
    const path = request(address) + '?fallback=extension';
    const absent = request(storedAddress) + '?fallback=extension';
    try {
      for (const result of await Promise.all([app.inject(path), app.inject(path)])) {
        expect(result.statusCode).toBe(200);
        expect(result.headers['content-type']).toBe('image/webp');
        expect(result.rawPayload).toEqual(data);
      }
      expect(load).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledWith(address, expect.objectContaining({ provider: 'flap' }));
      expect((await app.inject(absent)).statusCode).toBe(404);
      expect((await app.inject(absent)).statusCode).toBe(404);
      expect(load).toHaveBeenCalledTimes(4);
    } finally { await app.close(); }
  });
});
