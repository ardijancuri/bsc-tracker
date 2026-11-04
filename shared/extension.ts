/** Browser and server contract. Observed card/link graphs never go to the server. */
export const extensionMatchTypes = ['x_post', 'x_community', 'telegram', 'x_profile'] as const;
export type ExtensionMatchType = typeof extensionMatchTypes[number];
export interface ExtensionPreferences {
  highlights: boolean;
  matchTypes: ExtensionMatchType[];
  newGroups: boolean;
  newMembers: boolean;
  watchedOnly: boolean;
  sound: boolean;
}
export const defaultExtensionPreferences: ExtensionPreferences = {
  highlights: true, matchTypes: [...extensionMatchTypes], newGroups: true,
  newMembers: true, watchedOnly: false, sound: false,
};
export interface ExtensionTokenIdentity { chainId: 56; address: string; name: string; symbol: string; logoUrl?: string|null }
export interface ExtensionSavedToken extends ExtensionTokenIdentity {
  pinned: boolean; note: string; revision: number; updatedAt: string;
}
export interface ExtensionWorkspace {
  user: { id: string; name: string; email?: string | null; telegramLinked?: boolean; telegramUsername?: string | null; xUsername?: string | null };
  items: ExtensionSavedToken[];
  preferences: ExtensionPreferences;
  preferencesRevision: number;
}
export interface ExtensionAuthOptions { google: boolean; email: boolean; telegram?: boolean; x?: boolean }
export interface SocialLink { type: ExtensionMatchType; key: string; url: string }
export interface TokenCardMetric { value: string; color?: string }
export interface TokenCard extends ExtensionTokenIdentity {
  cardId: string; tokenUrl: string; socialLinks: SocialLink[];
  marketCap?: TokenCardMetric | null;
  volume?: TokenCardMetric | null;
}
export interface SocialMatchGroup {
  id: string; type: ExtensionMatchType; key: string; url: string;
  addresses: string[]; cardIds: string[]; color: string;
}
export interface MatchAlert {
  id: string; groupId: string; type: 'new_group' | 'new_member'; matchType: ExtensionMatchType;
  addresses: string[]; addedAddresses: string[]; occurredAt: number;
}
export interface ExtensionPage {
  pageId: string; status: 'ready' | 'unsupported' | 'disabled' | 'waiting';
  url: string; cards: TokenCard[]; groups: SocialMatchGroup[]; alerts: MatchAlert[];
  active: boolean; updatedAt: number; durations: number[];
}
export const extensionAddress = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value);
/** Public image destinations only; never scripts, local resources or credentials.
 * This URL is rendered as an image, never fetched by the Kollens server. */
export function extensionTokenImageUrl(value:unknown,baseUrl?:string):string|null{
  if(typeof value!=='string'||!value.trim()||value.length>2048)return null;
  try{const url=new URL(value,baseUrl),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'
      ||!host.includes('.')||host.includes(':')||/^[\d.]+$/.test(host)
      ||/(^|\.)(localhost|local|internal|invalid|test)$/.test(host))return null;
    url.hash='';return url.href;
  }catch{return null;}
}
export const extensionLabels: Record<ExtensionMatchType, string> = {
  x_post: 'Same X post', x_profile: 'Same X profile', x_community: 'Same X community', telegram: 'Same Telegram link',
};
