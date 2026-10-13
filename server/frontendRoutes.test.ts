import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerFrontendRoutes } from './frontendRoutes.js';

const shell = '<!doctype html><html><body>Current frontend</body></html>';
const script = 'export const version = "current";';
let app: FastifyInstance;
let publicDir: string;
let fixtureDir: string;

beforeEach(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'bscan-frontend-test-'));
  publicDir = path.join(fixtureDir, 'dist');
  await mkdir(path.join(publicDir, 'assets'), { recursive: true });
  await Promise.all([
    writeFile(path.join(publicDir, 'index.html'), shell),
    writeFile(path.join(publicDir, 'assets', 'KolTokenTradeModal-Ru3iC1ze.js'), script),
    writeFile(path.join(publicDir, 'assets', 'index-Dmr2zoUp.css'), 'body{color:white}'),
    writeFile(path.join(publicDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>'),
  ]);
  app = Fastify();
  app.get('/api/health', async () => ({ ok: true }));
  await registerFrontendRoutes(app, publicDir);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('retained deployment chunks', () => {
  async function withAssetCache() {
    await app.close();
    app = Fastify();
    const cacheDir = path.join(fixtureDir, 'retained-assets');
    await registerFrontendRoutes(app, publicDir, cacheDir);
    await app.ready();
    return cacheDir;
  }

  it('serves an earlier release module after replacing the frontend build and still rejects unknown assets', async () => {
    const oldName = 'KolTokenTradeModal-kl4bLLrn.js';
    const dependencyName = 'OldChart-rC29LLe9.js';
    const cssName = 'OldChart-cS29LLe9.css';
    const oldModule = `import "./${dependencyName}"; export const oldRelease = true;`;
    await Promise.all([
      writeFile(path.join(publicDir, 'assets', oldName), oldModule),
      writeFile(path.join(publicDir, 'assets', dependencyName), 'export const oldDependency = true;'),
      writeFile(path.join(publicDir, 'assets', cssName), '.old-chart{color:white}'),
    ]);
    const cacheDir = await withAssetCache();
    for (const name of [oldName, dependencyName, cssName]) await rm(path.join(publicDir, 'assets', name));
    await withAssetCache();
    const retained = await app.inject({ url: '/assets/' + oldName });
    expect(retained.statusCode).toBe(200);
    expect(retained.headers['content-type']).toMatch(/^(?:application|text)\/javascript/);
    expect(retained.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(retained.body).toBe(oldModule);
    expect(await readFile(path.join(cacheDir, oldName), 'utf8')).toBe(retained.body);
    const dependency = await app.inject({ url: '/assets/' + dependencyName });
    expect(dependency.statusCode).toBe(200);
    expect(dependency.headers['content-type']).toMatch(/^(?:application|text)\/javascript/);
    expect(dependency.body).toBe('export const oldDependency = true;');
    const css = await app.inject({ url: '/assets/' + cssName });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toMatch(/^text\/css/);
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(css.body).toBe('.old-chart{color:white}');
    const missing = await app.inject({ url: '/assets/UnknownModal-rC29LLe9.js' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toMatch(/^application\/json/);
    expect(missing.headers['cache-control']).toBe('no-store');
  });

  it('refreshes existing immutable cache entries without rewriting files served by an overlapping process', async () => {
    const cacheDir = path.join(fixtureDir, 'retained-assets');
    await mkdir(cacheDir);
    const name = 'KolTokenTradeModal-Ru3iC1ze.js';
    const cachedFile = path.join(cacheDir, name);
    await writeFile(cachedFile, script);
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(cachedFile, oldDate, oldDate);
    const before = await stat(cachedFile);
    // Different fixture contents prove registration does not overwrite an existing file.
    await writeFile(path.join(publicDir, 'assets', name), 'export const differentFixture = true;');
    await withAssetCache();
    const after = await stat(cachedFile);
    expect(await readFile(cachedFile, 'utf8')).toBe(script);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBeGreaterThan(oldDate.getTime());
  });

  it('prunes old release files while refreshing assets included in the current build, regardless of source mtime', async () => {
    const cacheDir = path.join(fixtureDir, 'retained-assets');
    await mkdir(cacheDir);
    const currentName = 'KolTokenTradeModal-Ru3iC1ze.js';
    const removedName = 'OldModal-8oLdwASH.js';
    const recentName = 'RecentModal-rC29LLe9.js';
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (const name of [currentName, removedName, recentName]) await writeFile(path.join(cacheDir, name), script);
    for (const file of [path.join(cacheDir, currentName), path.join(cacheDir, removedName), path.join(publicDir, 'assets', currentName)]) {
      await utimes(file, oldDate, oldDate);
    }
    await withAssetCache();
    await expect(stat(path.join(cacheDir, removedName))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(cacheDir, currentName))).mtimeMs).toBeGreaterThan(oldDate.getTime());
    expect((await app.inject({ url: '/assets/' + recentName })).statusCode).toBe(200);
    expect((await app.inject({ url: '/assets/' + currentName })).body).toBe(script);
  });

  it('retains and serves only fingerprinted regular files, with current build files taking priority', async () => {
    await writeFile(path.join(publicDir, 'assets', 'settings.json'), '{"secret":"fixture"}');
    const cacheDir = await withAssetCache();
    await expect(stat(path.join(cacheDir, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(cacheDir, 'notes.txt'), 'not a frontend asset');
    await writeFile(path.join(cacheDir, 'KolTokenTradeModal-Ru3iC1ze.js'), 'stale cache contents');
    const regular = await app.inject({ url: '/assets/notes.txt' });
    expect(regular.statusCode).toBe(404);
    expect((await app.inject({ url: '/assets/KolTokenTradeModal-Ru3iC1ze.js' })).body).toBe(script);
    const deepLink = await app.inject({ url: '/kol/0x1234567890123456789012345678901234567890' });
    expect(deepLink.body).toBe(shell);
    expect(deepLink.headers['cache-control']).toBe('no-cache, max-age=0, must-revalidate');
  });
});

describe('frontend static delivery', () => {
  it('returns a genuine uncached 404 for a lazy chunk removed by a release, even with an HTML Accept header', async () => {
    const response = await app.inject({ url: '/assets/KolTokenTradeModal-kl4bLLrn.js', headers: { accept: 'text/html' } });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ error: 'Not found' });
    expect(response.body).not.toContain(shell);
  });

  it.each(['/assets', '/assets/missing', '/%61ssets/missing', '/api', '/api/missing?next=/kol/test', '/favicon-missing.svg', '/missing.js'])
    ('does not serve the SPA shell for missing files or reserved endpoints: %s', async url => {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['cache-control']).toBe('no-store');
    });

  it.each(['GET', 'HEAD'] as const)('preserves %s token and KOL deep links with a revalidated shell', async method => {
    for (const url of ['/token/0x1234567890123456789012345678901234567890?interval=1m', '/kol/0x1234567890123456789012345678901234567890', '/trades']) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.headers['cache-control']).toBe('no-cache, max-age=0, must-revalidate');
      expect(response.body).toBe(method === 'GET' ? shell : '');
    }
  });

  it.each(['/', '/index.html'])('revalidates the direct shell route %s rather than caching stale release imports', async url => {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(shell);
    expect(response.headers['cache-control']).toBe('no-cache, max-age=0, must-revalidate');
    const cached = await app.inject({ url, headers: { 'if-none-match': response.headers.etag as string } });
    expect(cached.statusCode).toBe(304);
    expect(cached.headers['cache-control']).toBe('no-cache, max-age=0, must-revalidate');
  });

  it('serves existing fingerprinted modules and styles with their proper MIME types and immutable caching', async () => {
    const module = await app.inject({ url: '/assets/KolTokenTradeModal-Ru3iC1ze.js' });
    expect(module.statusCode).toBe(200);
    expect(module.headers['content-type']).toMatch(/^(?:application|text)\/javascript/);
    expect(module.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(module.headers['x-content-type-options']).toBe('nosniff');
    expect(module.body).toBe(script);
    const css = await app.inject({ url: '/assets/index-Dmr2zoUp.css' });
    expect(css.headers['content-type']).toMatch(/^text\/css/);
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('revalidates ordinary static files whose URLs stay the same across releases', async () => {
    const response = await app.inject({ url: '/favicon.svg' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(response.headers['cache-control']).toBe('no-cache, max-age=0, must-revalidate');
  });

  it('does not turn an unmatched mutation into a successful HTML response or interfere with API routes', async () => {
    const mutation = await app.inject({ method: 'POST', url: '/trades' });
    expect(mutation.statusCode).toBe(404);
    expect(mutation.headers['content-type']).toMatch(/^application\/json/);
    const health = await app.inject({ url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
  });
});
