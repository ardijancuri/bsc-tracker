import { useMemo, useSyncExternalStore } from 'react';
import { chineseTokenName, type TokenTranslation } from '../shared/tokenTranslation';
import { t } from './i18n';
import { shortAddress } from './lib';
import { TokenTranslationStore } from './tokenTranslations';

const translations = new TokenTranslationStore(async address => {
  const response = await fetch(`/api/tokens/${address}/translation`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Translation unavailable');
  return response.json();
});
const empty = { subscribe: () => () => {}, getSnapshot: () => null };
type TokenNameData = { address: string; symbol?: string | null; name?: string | null };

export function useTokenTranslation(token: TokenNameData) {
  const source = chineseTokenName(token);
  const entry = useMemo(() => source && /^0x[0-9a-f]{40}$/i.test(token.address) ? translations.watch(token.address, source) : empty, [token.address, source]);
  return useSyncExternalStore<TokenTranslation | null>(entry.subscribe, entry.getSnapshot);
}

export function TokenName({ token, addressSubtitle = false }: { token: TokenNameData; addressSubtitle?: boolean }) {
  const translation = useTokenTranslation(token);
  const primary = token.symbol || token.name || t('Unknown');
  const secondary = token.name && token.name !== primary && (!addressSubtitle || /\p{Script=Han}/u.test(token.name)) ? token.name : shortAddress(token.address);
  const translatedLine = translation?.englishName && <span className="token-translation" lang="en" title={`${t('Automatic English translation')}: ${translation.englishName}`}>{translation.englishName}</span>;
  // When only the full name is Chinese, keep its translation next to that name.
  const translateSecondary = !/\p{Script=Han}/u.test(primary) && /\p{Script=Han}/u.test(secondary);
  return <span className="identity-copy"><strong title={primary}>{primary}</strong>{!translateSecondary && translatedLine}<small className={translateSecondary ? 'token-source-name' : undefined} title={secondary}>{secondary}</small>{translateSecondary && translatedLine}</span>;
}
