import { useSyncExternalStore } from 'react';
import { chinese } from './zh-CN';

export type Language = 'en' | 'zh-CN';
export const languageStorageKey = 'bscan-language';
export function validLanguage(value: unknown): Language { return value === 'zh-CN' ? 'zh-CN' : 'en'; }
function storedLanguage(): Language {
  try { return validLanguage(window.localStorage.getItem(languageStorageKey)); }
  catch { return 'en'; }
}
let language: Language = storedLanguage();
const listeners = new Set<() => void>();
export const getLanguage = () => language;
export const getLocale = () => language === 'zh-CN' ? 'zh-CN' : 'en-US';
export function setLanguage(value: Language) {
  language = validLanguage(value);
  try { window.localStorage.setItem(languageStorageKey, language); } catch { /* Still works with storage disabled. */ }
  listeners.forEach(listener => listener());
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === languageStorageKey || event.key === null) {
    language = storedLanguage(); listeners.forEach(listener => listener());
  }
});
export function useLanguage() {
  const current = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getLanguage, () => 'en' as Language);
  return [current, setLanguage] as const;
}
export function translate(source: string, locale: Language, values: Record<string, string | number> = {}) {
  const text = locale === 'zh-CN' && Object.hasOwn(chinese, source) ? chinese[source] : source;
  return text.replace(/\{(\w+)\}/g, (placeholder, key: string) => Object.hasOwn(values, key) ? String(values[key]) : placeholder);
}
export function t(source: string, values?: Record<string, string | number>) { return translate(source, language, values); }
export function localDate(value: string | Date) { return new Date(value).toLocaleString(getLocale()); }
