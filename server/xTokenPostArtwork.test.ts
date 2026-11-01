import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { Pool } from 'pg';
import type { TokenPostEvidence } from '../shared/xTokenPosts.js';
import { loadXTokenPostArtwork } from './xTokenPostArtwork.js';

const address = '0xa1a38fa8146040b3e67311c4b58c1915d4b27777';
const evidence = { token: { address, logoUrl: 'https://never-fetch.test/token.png' },
  participants: [{ wallet: '0x2222222222222222222222222222222222222222',
    imageUrl: 'https://never-fetch.test/avatar.png' }] } as TokenPostEvidence;
const image = () => sharp({ create: { width: 12, height: 12, channels: 3, background: '#f9c932' } }).png().toBuffer();
function database(token: unknown) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ logo_data: token }] }));
  return { query, db: { query } as unknown as Pick<Pool, 'query'> };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('cached X token post artwork', () => {
  it('reads version-2 token artwork from Fresh without falling back to the retired identity table', async () => {
    const png=await image(),fixture=database(png);
    expect(await loadXTokenPostArtwork(fixture.db,{ ...evidence,version:2 })).toEqual({ tokenAvatar:png });
    expect(fixture.query.mock.calls[0][0]).toContain('FROM fresh.tokens WHERE address=$1');
  });
  it('uses only the bounded token cache without HTTP or KOL artwork queries', async () => {
    const png = await image(), fixture = database(png);
    const fetch = vi.fn(() => { throw new Error('No remote images permitted'); }); vi.stubGlobal('fetch', fetch);
    const result = await loadXTokenPostArtwork(fixture.db, evidence);
    expect(result).toEqual({ tokenAvatar: png });
    expect(fetch).not.toHaveBeenCalled(); expect(fixture.query).toHaveBeenCalledTimes(1);
    expect(fixture.query.mock.calls[0][0]).toContain('FROM tokens WHERE address=$1');
    expect(fixture.query.mock.calls[0][0]).toContain('octet_length(logo_data)<=$2');
    expect(fixture.query.mock.calls[0][1]).toEqual([address, 512_000]);
  });

  it('ignores missing, non-buffer, invalid, oversized and unsupported database images', async () => {
    const invalid = [null, undefined, 'https://example.test/token.png', Buffer.alloc(0), Buffer.from('<svg/>'),
      Buffer.alloc(512_001),
      Buffer.from('R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAIfkEAAAAAAAsAAAAAAEAAQAAAgJEAQA7', 'base64')];
    for (const bytes of invalid) {
      await expect(loadXTokenPostArtwork(database(bytes).db, evidence)).resolves.toEqual({ tokenAvatar: null });
    }
  });

  it('rejects static rasters over the decoded pixel bound', async () => {
    const oversized = await sharp({ create: { width: 2001, height: 2000, channels: 3,
      background: '#f9c932' } }).png().toBuffer();
    expect(oversized.length).toBeLessThan(512_000);
    await expect(loadXTokenPostArtwork(database(oversized).db, evidence)).resolves.toEqual({ tokenAvatar: null });
  });

  it('continues without artwork if the token cache query fails or returns no row', async () => {
    const unavailable = { query: vi.fn(async () => { throw new Error('offline'); }) } as unknown as Pick<Pool, 'query'>;
    await expect(loadXTokenPostArtwork(unavailable, evidence)).resolves.toEqual({ tokenAvatar: null });
    const missing = { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pick<Pool, 'query'>;
    await expect(loadXTokenPostArtwork(missing, evidence)).resolves.toEqual({ tokenAvatar: null });
  });

  it('normalizes valid token addresses and rejects invalid ones without querying', async () => {
    const png = await image(), fixture = database(png);
    await expect(loadXTokenPostArtwork(fixture.db, { ...evidence, token: { ...evidence.token,
      address: address.toUpperCase() } })).resolves.toEqual({ tokenAvatar: png });
    expect(fixture.query.mock.calls[0][1]).toEqual([address, 512_000]);
    const invalid = database(png);
    await expect(loadXTokenPostArtwork(invalid.db, { ...evidence, token: { ...evidence.token,
      address: '../../private' } })).resolves.toEqual({ tokenAvatar: null });
    expect(invalid.query).not.toHaveBeenCalled();
  });
});
