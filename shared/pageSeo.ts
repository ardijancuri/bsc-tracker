export const siteOrigin = 'https://kollens.com';
const socialImage = `${siteOrigin}/social/kollens-preview-5439ec9927a0.png`;
const socialImageAlt = 'Kollens logo on a dark background';

const publicPages = {
  '/': {
    heading: 'Live BNB Chain KOL Trades',
    title: 'Live BNB Chain KOL Trades & Wallet Tracker | Kollens',
    description: 'Track BNB Chain KOL wallet trades as they happen. Explore buys, sells, token activity and trade replays from tracked wallets.',
  },
  '/tokens': {
    heading: 'BNB Chain Meme Coin Tracker',
    title: 'BNB Chain Meme Coin Tracker | Kollens',
    description: 'Explore BNB Chain meme coins traded by tracked KOL wallets. Browse token charts, market caps and recent buy and sell activity.',
  },
  '/leaderboard': {
    heading: 'BNB Chain KOL Leaderboard',
    title: 'BNB Chain KOL Leaderboard & Realized P&L | Kollens',
    description: 'Compare tracked BNB Chain KOL wallets by realized profit and loss over the last 24 hours. Explore each wallet’s trading activity and positions.',
  },
  '/extension': {
    heading: 'Kollens Companion for Chrome',
    title: 'Kollens Companion Chrome Extension | Kollens',
    description: 'Explore the Kollens Companion extension for Chrome, with BNB Chain token groups on GMGN, local wallets and trending tokens on X.',
  },
  '/privacy-policy': {
    heading: 'Privacy Policy',
    title: 'Privacy Policy | Kollens',
    description: 'Read how Kollens handles visitor information, accounts, tracked wallet data, and the Kollens Companion extension.',
  },
  '/terms-of-use': {
    heading: 'Terms of Use',
    title: 'Terms of Use | Kollens',
    description: 'Read the terms for using Kollens and its public BNB Chain analytics.',
  },
} as const;

const privatePages = {
  '/watchlist': 'Watchlist',
  '/portfolio': 'Portfolio',
  '/creator': 'Creator Profiles',
  '/extension/connect': 'Connect Kollens Companion',
  '/auth/telegram/finish': 'Finish Telegram Sign-In',
} as const;

export const publicSeoPaths = Object.keys(publicPages);
type PublicPath = keyof typeof publicPages;
type PrivatePath = keyof typeof privatePages;

export type SiteRoute =
  | { kind: 'public'; path: PublicPath }
  | { kind: 'private'; path: PrivatePath }
  | { kind: 'kol' | 'token'; path: string; address: string }
  | { kind: 'missing' };

export function getSiteRoute(pathname: string): SiteRoute {
  let path = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  if (path === '/trades' || path === '/index.html') path = '/';
  if (path === '/journal') path = '/portfolio';
  if (Object.hasOwn(publicPages, path)) return { kind: 'public', path: path as PublicPath };
  if (Object.hasOwn(privatePages, path)) return { kind: 'private', path: path as PrivatePath };
  const detail = /^\/(kol|token)\/(0x[0-9a-f]{40})$/.exec(path);
  if (!detail) return { kind: 'missing' };
  return { kind: detail[1] as 'kol' | 'token', path, address: detail[2] };
}

export type PageSeoIdentity = { name?: string | null; symbol?: string | null };
export type PageSeo = {
  heading: string;
  title: string;
  description: string | null;
  canonical: string | null;
  noindex: boolean;
  image: string;
};

function cleanIdentityPart(value?: string | null) {
  return value?.replace(/\s+/g, ' ').trim().slice(0, 70) || '';
}

export function getPageSeo(pathname: string, identity?: PageSeoIdentity | null): PageSeo {
  const route = getSiteRoute(pathname);
  const base = { canonical: null, noindex: true, image: socialImage } as const;
  if (route.kind === 'public') {
    return { ...base, ...publicPages[route.path], canonical: siteOrigin + route.path, noindex: false };
  }
  if (route.kind === 'private') {
    const heading = privatePages[route.path];
    return { ...base, heading, title: `${heading} | Kollens`, description: null };
  }
  if (route.kind === 'missing' || identity === null) {
    return { ...base, heading: 'Page not found', title: 'Page Not Found | Kollens', description: null };
  }
  const name = cleanIdentityPart(identity?.name);
  const symbol = cleanIdentityPart(identity?.symbol);
  const label = route.kind === 'token' && name && symbol && name.toLowerCase() !== symbol.toLowerCase()
    ? `${name} (${symbol})` : name || symbol;
  const heading = label || (route.kind === 'kol' ? 'BNB Chain KOL Wallet' : 'BNB Chain Token');
  const description = route.kind === 'kol'
    ? `Explore ${label ? `${label}’s` : 'this wallet’s'} BNB Chain trades, token positions and realized P&L. Wallet: ${route.address}.`
    : `Explore ${label || 'this BNB Chain token'} price charts, market cap and tracked KOL trades. Contract: ${route.address}.`;
  return {
    ...base,
    heading,
    title: label ? `${heading} ${route.kind === 'kol' ? 'Wallet Trades' : 'Token Chart & KOL Trades'} | Kollens` : `${heading} | Kollens`,
    description,
    canonical: label ? siteOrigin + route.path : null,
    noindex: !label,
  };
}

type SeoTag = { attribute: 'name' | 'property'; key: string; content: string };

export function getPageSeoTags(seo: PageSeo): SeoTag[] {
  if (seo.noindex) return [{ attribute: 'name', key: 'robots', content: 'noindex' }];
  return [
    { attribute: 'name', key: 'description', content: seo.description ?? '' },
    { attribute: 'property', key: 'og:type', content: 'website' },
    { attribute: 'property', key: 'og:site_name', content: 'Kollens' },
    { attribute: 'property', key: 'og:title', content: seo.title },
    { attribute: 'property', key: 'og:description', content: seo.description ?? '' },
    { attribute: 'property', key: 'og:url', content: seo.canonical ?? '' },
    { attribute: 'property', key: 'og:image', content: seo.image },
    { attribute: 'property', key: 'og:image:secure_url', content: seo.image },
    { attribute: 'property', key: 'og:image:type', content: 'image/png' },
    { attribute: 'property', key: 'og:image:width', content: '1200' },
    { attribute: 'property', key: 'og:image:height', content: '630' },
    { attribute: 'property', key: 'og:image:alt', content: socialImageAlt },
    { attribute: 'name', key: 'twitter:card', content: 'summary_large_image' },
    { attribute: 'name', key: 'twitter:site', content: '@kollens' },
    { attribute: 'name', key: 'twitter:title', content: seo.title },
    { attribute: 'name', key: 'twitter:description', content: seo.description ?? '' },
    { attribute: 'name', key: 'twitter:image', content: seo.image },
    { attribute: 'name', key: 'twitter:image:alt', content: socialImageAlt },
  ];
}

export function getPageStructuredData(seo: PageSeo) {
  if (!seo.canonical) return null;
  const home = `${siteOrigin}/`;
  const schema = 'https://schema.org';
  const route = getSiteRoute(new URL(seo.canonical).pathname);
  if (seo.canonical === home) return {
    '@context': schema,
    '@graph': [
      { '@type': 'WebSite', '@id': `${siteOrigin}/#website`, name: 'Kollens', url: home,
        publisher: { '@id': `${siteOrigin}/#organization` } },
      { '@type': 'Organization', '@id': `${siteOrigin}/#organization`, name: 'Kollens', url: home,
        logo: `${siteOrigin}/kollens-icon.png`, sameAs: ['https://x.com/kollens'] },
    ],
  };
  const parent = route.kind === 'token' ? '/tokens' : route.kind === 'kol' ? '/leaderboard' : null;
  const items = [{ name: 'Kollens', item: home }];
  if (parent) items.push({ name: publicPages[parent].heading, item: siteOrigin + parent });
  items.push({ name: seo.heading, item: seo.canonical });
  return {
    '@context': schema,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, ...item })),
  };
}
