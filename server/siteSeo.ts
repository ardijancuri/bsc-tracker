import type { Pool, PoolClient } from 'pg';
import {
  getPageSeoTags, getPageStructuredData, publicSeoPaths, siteOrigin,
  type PageSeo, type PageSeoIdentity,
} from '../shared/pageSeo.js';
import { freshPublicTokenSql } from './fresh/publicTokens.js';

type DetailKind = 'kol' | 'token';
export type SiteSeo = {
  identity: (kind: DetailKind, address: string) => Promise<PageSeoIdentity | null>;
  sitemap: (document?: string) => Promise<string | null>;
};

const detailLimit = 6;
const maxIdentities = 1024;
const maxSitemapDetails = 50_000;
const tokensPerSitemap = 1000;
const sitemapTtlMs = 5 * 60_000;

const tokenIdentitySql = `SELECT t.name,t.symbol FROM fresh.tokens t
  WHERE t.address=$1 AND ${freshPublicTokenSql('t', { requestedIdentity: true })}`;
const kolIdentitySql = `SELECT p.display_name AS name FROM published_kols p
  JOIN fresh.wallets w ON w.address=p.address WHERE p.address=$1 AND p.is_tracked`;
const sitemapTokenSql = `SELECT t.address FROM fresh.tokens t
WHERE t.last_trade_at IS NOT NULL
  AND (COALESCE(t.name,'')~'[^[:space:]]' OR COALESCE(t.symbol,'')~'[^[:space:]]')
  AND ${freshPublicTokenSql('t')}
ORDER BY t.address LIMIT $1`;
const sitemapKolSql = `SELECT p.address FROM published_kols p JOIN fresh.kols k ON k.wallet_address=p.address
  JOIN fresh.wallets w ON w.address=p.address WHERE p.is_tracked AND w.active
  AND COALESCE(p.display_name,'')~'[^[:space:]]' AND k.last_trade_at IS NOT NULL
  ORDER BY p.address LIMIT $1`;

export const robotsTxt = `User-agent: *\nDisallow:\nSitemap: ${siteOrigin}/sitemap.xml\n`;

const addressPattern = /^0x[0-9a-f]{40}$/;
function detailPaths(kind: DetailKind, rows: { address: string }[]) {
  return rows.filter(row => addressPattern.test(row.address)).map(row => `/${kind}/${row.address}`);
}

export function makeSitemap(paths: string[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...new Set(paths.map(path => `  <url><loc>${escapeMarkup(siteOrigin + path)}</loc></url>`)),
    '</urlset>',
    '',
  ].join('\n');
}

function makeSitemapIndex(paths: string[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map(path => `  <sitemap><loc>${siteOrigin}/sitemaps/${path}</loc></sitemap>`),
    '</sitemapindex>',
    '',
  ].join('\n');
}

export function createSiteSeo(db: Pick<Pool, 'connect'>): SiteSeo {
  const identities = new Map<string, { value: PageSeoIdentity | null; expiresAt: number }>();
  const identityReads = new Map<string, Promise<PageSeoIdentity | null>>();
  let sitemapCache: { value: Map<string, string>; expiresAt: number } | undefined;
  let sitemapRead: Promise<Map<string, string>> | undefined;

  async function identity(kind: DetailKind, address: string) {
    if (!addressPattern.test(address)) return null;
    const key = `${kind}:${address}`;
    const cached = identities.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = identityReads.get(key);
    if (pending) return pending;
    if (identityReads.size >= detailLimit) throw new Error('SEO identity reads are busy');
    const request = readOnlyQuery(db, '1500ms', async client => {
      return client.query<PageSeoIdentity>(kind === 'kol' ? kolIdentitySql : tokenIdentitySql, [address]);
    }).then(({ rows }) => {
      const value = rows[0] ?? null;
      if (identities.size >= maxIdentities) identities.delete(identities.keys().next().value!);
      identities.set(key, { value, expiresAt: Date.now() + (value ? 60_000 : 15_000) });
      return value;
    }).finally(() => identityReads.delete(key));
    identityReads.set(key, request);
    return request;
  }

  async function sitemap(document = 'index') {
    if (document !== 'index' && !/^(pages|kols|tokens-[1-9]\d{0,2})\.xml$/.test(document)) return null;
    if (sitemapCache && sitemapCache.expiresAt > Date.now()) return sitemapCache.value.get(document) ?? null;
    if (!sitemapRead) {
      sitemapRead = readOnlyQuery(db, '5s', async client => {
        const kols = await client.query<{ address: string }>(sitemapKolSql, [maxSitemapDetails + 1]);
        const tokens = await client.query<{ address: string }>(sitemapTokenSql, [maxSitemapDetails + 1]);
        return [kols, tokens];
      }).then(([kols, tokens]) => {
        if (kols.rows.length + tokens.rows.length > maxSitemapDetails) {
          throw new Error('Public sitemap exceeds its configured identity limit');
        }
        const value = new Map<string, string>([
          ['pages.xml', makeSitemap(publicSeoPaths)],
          ['kols.xml', makeSitemap(detailPaths('kol', kols.rows))],
        ]);
        const tokenPaths = detailPaths('token', tokens.rows);
        for (let offset = 0; offset < tokenPaths.length; offset += tokensPerSitemap) {
          value.set(`tokens-${offset / tokensPerSitemap + 1}.xml`, makeSitemap(tokenPaths.slice(offset, offset + tokensPerSitemap)));
        }
        value.set('index', makeSitemapIndex([...value.keys()]));
        sitemapCache = { value, expiresAt: Date.now() + sitemapTtlMs };
        return value;
      }).finally(() => { sitemapRead = undefined; });
    }
    return (await sitemapRead).get(document) ?? null;
  }

  return { identity, sitemap };
}

async function readOnlyQuery<T>(db: Pick<Pool, 'connect'>, timeout: '1500ms' | '5s', read: (client: PoolClient) => Promise<T>) {
  const client = await db.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','500ms',true)", [timeout]);
    const result = await read(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

const markupEscapes: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
const escapeMarkup = (value: string) => value.replace(/[&<>"']/g, char => markupEscapes[char]);

export function renderSiteDocument(shell: string, seo: PageSeo, analyticsEnabled: boolean) {
  const structured = getPageStructuredData(seo);
  const head = [
    `<title>${escapeMarkup(seo.title)}</title>`,
    ...getPageSeoTags(seo).map(tag => `<meta data-kollens-seo ${tag.attribute}="${tag.key}" content="${escapeMarkup(tag.content)}">`),
    seo.canonical ? `<link data-kollens-seo rel="canonical" href="${escapeMarkup(seo.canonical)}">` : '',
    structured ? `<script id="kollens-structured-data" type="application/ld+json">${JSON.stringify(structured).replace(/</g, '\\u003c')}</script>` : '',
    analyticsEnabled ? '<meta name="kollens-analytics" content="enabled">' : '',
  ].filter(Boolean).join('\n    ');
  const body = seo.description || seo.heading === 'Page not found' ? `<main class="page"><header class="section-title"><div><h1>${escapeMarkup(seo.heading)}</h1>
    ${seo.description ? `<p>${escapeMarkup(seo.description)}</p>` : ''}</div></header>
    <nav aria-label="Kollens pages"><a href="/">Live trades</a> · <a href="/tokens">Tokens</a> ·
    <a href="/leaderboard">Leaderboard</a> · <a href="/extension">Extension</a></nav></main>`
    : '';
  return shell
    .replace(/<!-- kollens:seo:start -->[\s\S]*?<!-- kollens:seo:end -->/, () => head)
    .replace('<div id="root"></div>', () => `<div id="root">${body}</div>`);
}
