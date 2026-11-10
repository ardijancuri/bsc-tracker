import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPageSeo, publicSeoPaths, siteOrigin } from '../shared/pageSeo.js';
import { registerFrontendRoutes } from './frontendRoutes.js';
import { createSiteSeo, makeSitemap, type SiteSeo } from './siteSeo.js';

const kol = '0x' + 'a'.repeat(40);
const token = '0x' + 'b'.repeat(40);
const unknown = '0x' + 'c'.repeat(40);
const attack = 'Hello </script><script>alert(1)</script> & "world"';

describe('SEO document and discovery routes', () => {
  let app: FastifyInstance;
  let folder: string;
  let seo: SiteSeo;
  beforeEach(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'kollens-seo-test-'));
    await writeFile(path.join(folder, 'index.html'), await readFile('index.html', 'utf8'));
    seo = {
      identity: vi.fn(async (kind, address) => {
        if (kind === 'kol' && address === kol) return { name: 'Example KOL' };
        if (kind === 'token' && address === token) return { name: attack, symbol: 'CA' };
        return null;
      }),
      sitemap: vi.fn(async document => {
        if (document === 'pages.xml') return makeSitemap(publicSeoPaths);
        if (document === 'kols.xml') return makeSitemap(['/kol/' + kol]);
        if (document === 'tokens-1.xml') return makeSitemap(['/token/' + token]);
        if (document !== undefined) return null;
        return '<sitemapindex><sitemap><loc>https://kollens.com/sitemaps/pages.xml</loc></sitemap></sitemapindex>';
      }),
    };
    app = Fastify();
    await registerFrontendRoutes(app, folder, undefined, { seo, analyticsEnabled: true });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  });

  it('provides root site-name metadata and meaningful HTML before JavaScript', async () => {
    const response = await app.inject({ url: '/?utm_source=search', headers: { host: 'malicious.test' } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<h1>Live BNB Chain KOL Trades</h1>');
    expect(response.body).toContain('<link data-kollens-seo rel="canonical" href="https://kollens.com/">');
    expect(response.body).toContain('<meta data-kollens-seo property="og:url" content="https://kollens.com/">');
    expect(response.body).toContain('"@type":"WebSite"');
    expect(response.body).toContain('<meta name="kollens-analytics" content="enabled">');
    expect(response.body).not.toContain('malicious.test');
    expect(response.body).not.toContain('utm_source');
    expect(response.body.match(/name="description"/g)).toHaveLength(1);
    expect(response.body.match(/property="og:title"/g)).toHaveLength(1);
    expect(seo.identity).not.toHaveBeenCalled();
    const head = await app.inject({ method: 'HEAD', url: '/' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
  });

  it.each([
    ['/trades?ref=friend', '/?ref=friend'],
    ['/index.html', '/'],
    ['/Tokens/', '/tokens'],
    ['/journal?tab=wallets', '/portfolio?tab=wallets'],
    ['/Token/' + token.toUpperCase() + '?range=24h', '/token/' + token + '?range=24h'],
  ])('redirects %s to the canonical route', async (url, location) => {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(location);
  });

  it('renders different public detail titles and safely escapes untrusted identity text', async () => {
    const [wallet, contract] = await Promise.all([
      app.inject({ url: '/kol/' + kol }),
      app.inject({ url: '/token/' + token + '?token=duplicate' }),
    ]);
    expect(wallet.statusCode).toBe(200);
    expect(wallet.body).toContain('<title>Example KOL Wallet Trades | Kollens</title>');
    expect(contract.statusCode).toBe(200);
    expect(contract.body).toContain('Hello &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;world&quot;');
    expect(contract.body).toContain('\\u003c/script>');
    expect(contract.body).not.toContain('<script>alert(1)</script>');
    expect(contract.body).toContain('href="https://kollens.com/token/' + token + '"');
    expect(contract.body).not.toContain('token=duplicate');
    expect(contract.body).toContain('"@type":"BreadcrumbList"');
  });

  it.each(['/typo', '/kol/invalid', '/token/' + unknown, '/kol/' + unknown])
  ('returns genuine uncached document 404s for %s', async url => {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('<h1>Page not found</h1>');
    expect(response.body).toContain('name="robots" content="noindex"');
    expect(response.body).not.toContain('rel="canonical"');
  });

  it.each(['/portfolio', '/watchlist', '/?view=watchlist', '/creator', '/extension/connect?attempt=private', '/auth/telegram/finish?handoff=private'])
  ('keeps %s functional, private and uncached', async url => {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('name="robots" content="noindex"');
    expect(response.body).not.toContain('rel="canonical"');
    expect(response.body).not.toContain('=private');
    if (url.startsWith('/auth/')) {
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    }
  });

  it('advertises a canonical public sitemap without blocking scripts or read APIs', async () => {
    const [robots, sitemap] = await Promise.all([app.inject({ url: '/robots.txt' }), app.inject({ url: '/sitemap.xml' })]);
    expect(robots.headers['content-type']).toMatch(/^text\/plain/);
    expect(robots.body).toContain('Sitemap: https://kollens.com/sitemap.xml');
    expect(robots.body).not.toContain('Disallow: /');
    expect(sitemap.headers['content-type']).toMatch(/^application\/xml/);
    expect(sitemap.body).toContain('<sitemapindex>');
    expect(sitemap.body).toContain('<loc>https://kollens.com/sitemaps/pages.xml</loc>');
    const [pages, tokens, kols, missing] = await Promise.all([
      app.inject({ url: '/sitemaps/pages.xml' }), app.inject({ url: '/sitemaps/tokens-1.xml' }),
      app.inject({ url: '/sitemaps/kols.xml' }), app.inject({ url: '/sitemaps/tokens-99.xml' }),
    ]);
    expect(pages.body).toContain('<loc>https://kollens.com/</loc>');
    expect(tokens.body).toContain('<loc>https://kollens.com/token/' + token + '</loc>');
    expect(kols.body).toContain('<loc>https://kollens.com/kol/' + kol + '</loc>');
    expect(pages.body).not.toMatch(/\/(portfolio|watchlist|trades|extension\/connect)</);
    expect(missing.statusCode).toBe(404);
    expect(makeSitemap(['/tokens?a=1&b=2', '/tokens?a=1&b=2']).match(/&amp;/g)).toHaveLength(1);
  });

  it('handles transient identity or sitemap errors without representing them as 404s', async () => {
    vi.mocked(seo.identity).mockRejectedValueOnce(new Error('database fixture error'));
    vi.mocked(seo.sitemap).mockRejectedValueOnce(new Error('database fixture error'));
    const [identity, sitemap] = await Promise.all([app.inject({ url: '/kol/' + kol }), app.inject({ url: '/sitemap.xml' })]);
    expect(identity.statusCode).toBe(503);
    expect(sitemap.statusCode).toBe(503);
    expect(sitemap.headers['retry-after']).toBe('5');
  });
});

it('coalesces bounded public queries and does not cache a failed refresh', async () => {
  let fail = true;
  const statements: string[] = [];
  const query = vi.fn(async (text: string) => {
    statements.push(text);
    if (text === 'BEGIN READ ONLY' || text === 'COMMIT' || text === 'ROLLBACK' || text.startsWith('SELECT set_config')) return { rows: [] };
    if (fail) { fail = false; throw new Error('not ready'); }
    if (text.startsWith('SELECT t.address')) return { rows: [{ address: token }, { address: 'invalid' }] };
    if (text.startsWith('SELECT p.address')) return { rows: [{ address: kol }] };
    return { rows: [{ name: 'KOL' }] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  const seo = createSiteSeo({ connect } as unknown as Pick<Pool, 'connect'>);
  await expect(seo.sitemap()).rejects.toThrow('not ready');
  const [first, second] = await Promise.all([seo.sitemap(), seo.sitemap()]);
  expect(second).toBe(first);
  expect(await seo.sitemap()).toBe(first);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledTimes(2);
  expect(statements).toContain('ROLLBACK');
  expect(first).toContain(siteOrigin + '/sitemaps/tokens-1.xml');
  const leaf = await seo.sitemap('tokens-1.xml');
  expect(leaf).toContain(siteOrigin + '/token/' + token);
  expect(leaf).not.toContain('/token/invalid');
  expect(await seo.sitemap('tokens-2.xml')).toBe(null);
  const tokenQuery = statements.find(text => text.startsWith('SELECT t.address'))!;
  expect(tokenQuery).toContain('public_trade_kol.is_tracked');
  expect(tokenQuery).toContain('LIMIT $1');
  const [left, right] = await Promise.all([seo.identity('kol', kol), seo.identity('kol', kol)]);
  expect(left).toEqual(right);
  expect(await seo.identity('kol', kol)).toEqual(left);
  expect(connect).toHaveBeenCalledTimes(3);
  expect(release).toHaveBeenCalledTimes(3);
  expect(getPageSeo('/token/' + token, { name: '   ', symbol: null }).noindex).toBe(true);
});

it('keeps every public token across 1000-entry leaves and fails explicitly above its memory bound', async () => {
  const rows = Array.from({ length: 1001 }, (_, n) => ({ address: '0x' + n.toString(16).padStart(40, '0') }));
  const query = vi.fn(async (text: string) => ({ rows: text.startsWith('SELECT t.address') ? rows : [] }));
  const db = { connect: async () => ({ query, release() {} }) } as unknown as Pick<Pool, 'connect'>;
  const seo = createSiteSeo(db);
  const index = await seo.sitemap();
  expect(index).toContain('sitemaps/tokens-2.xml');
  expect((await seo.sitemap('tokens-1.xml'))?.match(/<url>/g)).toHaveLength(1000);
  expect((await seo.sitemap('tokens-2.xml'))?.match(/<url>/g)).toHaveLength(1);
  expect(await seo.sitemap('tokens-2.xml')).toContain(rows.at(-1)!.address);
  rows.push(...Array.from({ length: 49_000 }, () => ({ address: token })));
  await expect(createSiteSeo(db).sitemap()).rejects.toThrow('exceeds');
});
