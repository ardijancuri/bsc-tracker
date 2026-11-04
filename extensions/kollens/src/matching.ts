import { extensionAddress, extensionMatchTypes, type SocialLink, type TokenCard, type SocialMatchGroup, type ExtensionMatchType } from '../../../shared/extension';

const xHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com']);
const reserved = new Set(['home','explore','search','intent','i','share','settings','messages','compose','hashtag','notifications','login','signup','tos','privacy']);
const validId = (id: string) => /^[1-9][0-9]{0,24}$/.test(id);

/** No network resolution, HTML interpretation, author inference or Number IDs. */
export function normalizeSocialLink(input: string): SocialLink | null {
  if (input.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(input)) return null;
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase(), path = url.pathname.replace(/\/+$/, '');
  const link = (type: ExtensionMatchType, key: string, canonical: string): SocialLink => ({ type, key, url: canonical });
  if (xHosts.has(host)) {
    const post = path.match(/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/(?:web\/)?status)\/([0-9]+)(?:\/(?:photo|video)\/[0-9]+)?$/);
    if (post && validId(post[1])) return link('x_post', post[1], `https://x.com/i/web/status/${post[1]}`);
    const community = path.match(/^\/i\/communities\/([0-9]+)$/);
    if (community && validId(community[1])) return link('x_community', community[1], `https://x.com/i/communities/${community[1]}`);
    const profile = path.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1]?.toLowerCase();
    if (profile && !reserved.has(profile)) return link('x_profile', profile, `https://x.com/${profile}`);
  }
  if (['t.me','www.t.me','telegram.me','www.telegram.me'].includes(host)) {
    const invite = path.match(/^\/(?:\+|joinchat\/)([A-Za-z0-9_-]{8,128})$/)?.[1];
    if (invite) return link('telegram', `invite:${invite}`, `https://t.me/+${invite}`);
    const username = path.match(/^\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{3,31})(?:\/[1-9][0-9]*)?$/)?.[1]?.toLowerCase();
    if (username && !['share','proxy','socks','login','joinchat','addstickers','addemoji','c','iv','confirmphone','setlanguage'].includes(username))
      return link('telegram', `public:${username}`, `https://t.me/${username}`);
  }
  return null;
}

const colors = ['#f4c542','#62b8ef','#c29aff','#4ed0b0','#ed91b6','#f2a46d'];
export function groupColor(key: string) {
  let hash = 2166136261;
  for (const c of key) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return colors[(hash >>> 0) % colors.length];
}
export function matchCards(cards: TokenCard[], enabled: ExtensionMatchType[] = [...extensionMatchTypes]): SocialMatchGroup[] {
  const groups = new Map<string, { link: SocialLink; addresses: Set<string>; cardIds: Set<string> }>();
  for (const card of cards) {
    if (card.chainId !== 56 || !extensionAddress(card.address)) continue;
    for (const link of card.socialLinks) {
      if (!enabled.includes(link.type)) continue;
      const normalized = normalizeSocialLink(link.url);
      if (!normalized || normalized.type !== link.type || normalized.key !== link.key) continue;
      const id = `${link.type}:${link.key}`, group = groups.get(id) ?? { link, addresses: new Set<string>(), cardIds: new Set<string>() };
      group.addresses.add(card.address); group.cardIds.add(card.cardId); groups.set(id, group);
    }
  }
  return [...groups].filter(([, group]) => group.addresses.size >= 2).map(([id, group]) => ({
    id, type: group.link.type, key: group.link.key, url: group.link.url,
    addresses: [...group.addresses].sort(), cardIds: [...group.cardIds], color: groupColor(id),
  })).sort((a, b) => extensionMatchTypes.indexOf(a.type) - extensionMatchTypes.indexOf(b.type) || a.id.localeCompare(b.id));
}
