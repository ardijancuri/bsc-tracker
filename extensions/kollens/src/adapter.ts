import { extensionAddress, extensionTokenImageUrl, type TokenCard } from '../../../shared/extension';
import { normalizeSocialLink } from './matching';
import { readCardMetric } from './cardMetrics';

export interface Layout {
  root: string; card: string; tokenLink: string|null; addressAttribute: string;
  name: string; symbol: string; socials: string; badgeSlot: string|null; tokenImage?:string;
  chainAttribute?:string; cardContainer?:string; maxCards?:number;
}
export const fixtureLayout: Layout = {
  root: '[data-kollens-trenches][data-chain="bsc"]', card: '[data-token-card]',
  tokenLink: 'a[data-token-link]', addressAttribute: 'data-token-address',
  name: '[data-token-name]', symbol: '[data-token-symbol]', socials: '[data-social-link][href]', badgeSlot: '[data-badge-slot]',tokenImage:'img[data-token-image]',
};
/** Inspected Chrome DOM, November 2, 2026. Activation is a separate local opt-in.
 * GMGN uses a div with href, not an anchor. Never attach badges over its controls. */
export const verifiedGmgnLayout: Layout = {
  root:'#MainDomId',card:'[data-testid="trench-token-card"]',tokenLink:null,
  addressAttribute:'data-trenches-token-address',chainAttribute:'data-trenches-token-chain',
  cardContainer:'[data-testid^="trenches"]',maxCards:2000,
  name:'[class~="group/token-translation"] > div',symbol:'[class~="group/token-translation"] > span',
  socials:'a[href]',badgeSlot:null,tokenImage:'img[alt="logo" i]',
};
export function isBscTrenches(url: string) {
  try {
    const u = new URL(url);
    return ['https://gmgn.ai','https://www.gmgn.ai'].includes(u.origin)
      && ['/', '/trenches', '/trenches/'].includes(u.pathname) && u.searchParams.get('chain') === 'bsc';
  } catch { return false; }
}
export function readCard(element: HTMLElement, cardId: string, layout: Layout, baseUrl: string): TokenCard | null {
  if(!element.matches(layout.card)||!element.getClientRects().length||element.closest('[hidden],[aria-hidden="true"]')||getComputedStyle(element).visibility==='hidden')return null;
  if(layout.chainAttribute&&element.getAttribute(layout.chainAttribute)!=='bsc'||layout.cardContainer&&!element.closest(layout.cardContainer))return null;
  const address = element.getAttribute(layout.addressAttribute)?.toLowerCase();
  if (!extensionAddress(address)) return null;
  const anchor = layout.tokenLink===null?element:element.querySelector<HTMLElement>(layout.tokenLink);
  if (!anchor) return null;
  let url: URL;
  try { url = new URL(anchor.getAttribute('href') ?? '', baseUrl); } catch { return null; }
  if (!['https://gmgn.ai','https://www.gmgn.ai'].includes(url.origin) || url.username || url.password
    || !new RegExp(`^/bsc/token/${address}/?$`, 'i').test(url.pathname)) return null;
  const unique = new Map<string, NonNullable<ReturnType<typeof normalizeSocialLink>>>();
  for (const social of element.querySelectorAll<HTMLAnchorElement>(layout.socials)) {
    const link = normalizeSocialLink(social.getAttribute('href') ?? '');
    if (link) unique.set(`${link.type}:${link.key}`, link);
  }
  const image=layout.tokenImage?element.querySelector<HTMLImageElement>(layout.tokenImage):null;
  // Attribute first: currentSrc can still point to a recycled card's old image.
  const sources=[image?.getAttribute('src'),image?.getAttribute('data-src')];if(!sources.some(Boolean))sources.push(image?.currentSrc);
  const logoUrl=sources.map(src=>extensionTokenImageUrl(src,baseUrl)).find(Boolean)??null;
  return { cardId, chainId: 56, address, logoUrl,name: (element.querySelector(layout.name)?.textContent ?? '').trim().slice(0,120),
    symbol: (element.querySelector(layout.symbol)?.textContent ?? '').trim().slice(0,40),
    tokenUrl: url.href, socialLinks: [...unique.values()],
    marketCap: readCardMetric(element, 'MC'),
    volume: readCardMetric(element, 'V') };
}
