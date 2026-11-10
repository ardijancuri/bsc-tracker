import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { getPageSeo, getSiteRoute, type PageSeoIdentity } from '../shared/pageSeo.js';
import { renderSiteDocument, robotsTxt, type SiteSeo } from './siteSeo.js';

const revalidate = 'no-cache, max-age=0, must-revalidate';
const immutable = 'public, max-age=31536000, immutable';
const assetRetentionMs = 7 * 24 * 60 * 60 * 1000;
const fingerprintedAsset = (filename: string) => /^[^/\\]+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9]+$/.test(path.basename(filename));

async function retainFrontendAssets(publicDir: string, cacheDir: string) {
  const deployedAt = new Date();
  await mkdir(cacheDir, { recursive: true });
  const copyAssets = async (sourceDir: string, relativeDir = '') => {
    let entries;
    try { entries = await readdir(sourceDir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) await copyAssets(path.join(sourceDir, entry.name), relativePath);
      else if (entry.isFile() && fingerprintedAsset(entry.name)) {
        const target = path.join(cacheDir, relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        // Old and new app processes can share this cache during a release switch.
        // Never truncate a fingerprinted file that the old process may be serving.
        try { await copyFile(path.join(sourceDir, entry.name), target, constants.COPYFILE_EXCL); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        // A repeated deployment refreshes retention even when Docker's source mtime is old.
        await utimes(target, deployedAt, deployedAt);
      }
    }
  };
  await copyAssets(path.join(publicDir, 'assets'));
  const pruneAssets = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await pruneAssets(filename);
      else if (entry.isFile() && fingerprintedAsset(entry.name)
        && (await stat(filename)).mtimeMs < deployedAt.getTime() - assetRetentionMs) await unlink(filename);
    }
  };
  await pruneAssets(cacheDir);
}

export async function registerFrontendRoutes(app: FastifyInstance, publicDir: string, assetCacheDir?: string,
  options: { seo?: SiteSeo; analyticsEnabled?: boolean } = {}) {
  const { seo, analyticsEnabled = false } = options;
  const shell = seo ? await readFile(path.join(publicDir, 'index.html'), 'utf8').catch(error => {
    if (error.code === 'ENOENT' && process.env.NODE_ENV !== 'production') return null;
    throw error;
  }) : null;
  if (shell !== null && (!shell.includes('<!-- kollens:seo:start -->') || !shell.includes('<!-- kollens:seo:end -->'))) {
    throw new Error('Frontend build is missing its SEO metadata slot');
  }
  if (assetCacheDir) await retainFrontendAssets(publicDir, assetCacheDir);
  app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    wildcard: false,
    globIgnore: shell !== null ? ['index.html'] : undefined,
    cacheControl: false,
    setHeaders(reply, filename) {
      const relativePath = path.relative(publicDir, filename).split(path.sep).join('/');
      // Only Vite's fingerprinted build files can stay cached across releases.
      const fingerprinted = relativePath.startsWith('assets/') && fingerprintedAsset(filename);
      if (reply.getHeader('Cache-Control') !== 'no-store') reply.header('Cache-Control', fingerprinted ? immutable : revalidate);
      reply.header('X-Content-Type-Options', 'nosniff');
    },
  });
  if (assetCacheDir) app.register(fastifyStatic, {
    root: assetCacheDir,
    prefix: '/assets/',
    wildcard: true,
    decorateReply: false,
    cacheControl: false,
    allowedPath: filename => fingerprintedAsset(filename),
    setHeaders(reply) {
      reply.header('Cache-Control', immutable).header('X-Content-Type-Options', 'nosniff');
    },
  });

  if (seo) {
    app.get('/robots.txt', (_, reply) => reply.type('text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=300').send(robotsTxt));
    const sitemapDocument = async (document: string | undefined, reply: FastifyReply) => {
      try {
        const sitemap = await seo.sitemap(document);
        if (sitemap === null) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'Sitemap not found' });
        return reply.type('application/xml; charset=utf-8').header('Cache-Control', 'public, max-age=300').send(sitemap);
      } catch {
        return unavailable(reply);
      }
    };
    app.get('/sitemap.xml', (_, reply) => sitemapDocument(undefined, reply));
    app.get<{ Params: { document: string } }>('/sitemaps/:document', (request, reply) => sitemapDocument(request.params.document, reply));
  }

  app.setNotFoundHandler(async (request, reply) => {
    let pathname: string;
    const rawPath = request.url.split('?')[0];
    try { pathname = decodeURIComponent(rawPath).replace(/\\/g, '/'); }
    catch { pathname = ''; }
    const documentRoute = pathname && !/^\/(?:api|assets)(?:\/|$)/.test(pathname)
      && ((seo && pathname.toLowerCase() === '/index.html') || !pathname.split('/').some(segment => segment.includes('.')));
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !documentRoute) {
      return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
        .code(404).send({ error: 'Not found' });
    }
    if (!seo || shell === null) {
      if (pathname === '/auth/telegram/finish') secureTelegramFinish(reply);
      else reply.header('Cache-Control', revalidate);
      return reply.type('text/html').sendFile('index.html');
    }
    const route = getSiteRoute(pathname);
    if (route.kind !== 'missing' && route.path !== rawPath) {
      return reply.redirect(route.path + request.url.slice(rawPath.length), 301);
    }
    let identity: PageSeoIdentity | null | undefined;
    if (route.kind === 'kol' || route.kind === 'token') {
      try { identity = await seo.identity(route.kind, route.address); }
      catch { return unavailable(reply); }
    }
    const missing = route.kind === 'missing' || identity === null;
    const watchlistView = route.kind === 'public' && route.path === '/'
      && new URLSearchParams(request.url.slice(rawPath.length)).get('view') === 'watchlist';
    const metadata = getPageSeo(watchlistView ? '/watchlist' : pathname, identity);
    if (pathname === '/auth/telegram/finish') secureTelegramFinish(reply);
    const document = renderSiteDocument(shell, metadata, analyticsEnabled);
    return reply.code(missing ? 404 : 200)
      .header('Cache-Control', route.kind === 'private' || watchlistView || missing ? 'no-store' : revalidate)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Length', String(Buffer.byteLength(document)))
      .type('text/html; charset=utf-8')
      .send(request.method === 'HEAD' ? undefined : document);
  });
}

function secureTelegramFinish(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
    .header('X-Frame-Options', 'DENY').header('Content-Security-Policy', "frame-ancestors 'none'");
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).header('Retry-After', '5').header('Cache-Control', 'no-store').send({ error: 'Data is temporarily unavailable.' });
}
