import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';

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

export async function registerFrontendRoutes(app: FastifyInstance, publicDir: string, assetCacheDir?: string) {
  if (assetCacheDir) await retainFrontendAssets(publicDir, assetCacheDir);
  app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    wildcard: false,
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

  app.setNotFoundHandler((request, reply) => {
    let pathname: string;
    try { pathname = decodeURIComponent(request.url.split('?')[0]).replace(/\\/g, '/'); }
    catch { pathname = ''; }
    const documentRoute = pathname && !/^\/(?:api|assets)(?:\/|$)/.test(pathname)
      && !pathname.split('/').some(segment => segment.includes('.'));
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !documentRoute) {
      return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
        .code(404).send({ error: 'Not found' });
    }
    if (pathname === '/auth/telegram/finish') return reply.header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY')
      .header('Content-Security-Policy', "frame-ancestors 'none'").type('text/html').sendFile('index.html');
    // Deep links need the SPA shell; missing lazy chunks must remain genuine 404s.
    return reply.header('Cache-Control', revalidate).type('text/html').sendFile('index.html');
  });
}
