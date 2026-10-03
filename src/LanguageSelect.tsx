import { ChevronDown } from 'lucide-react';
import { t, useLanguage } from './i18n';

export function LanguageSelect() {
  const [language, setLanguage] = useLanguage();
  return <label className="language-select"><span className="language-current" aria-hidden="true">{language === 'zh-CN' ? '中文' : 'EN'}</span><ChevronDown size={12} aria-hidden="true" /><select aria-label={t('Language')} title={t('Language')} value={language} onChange={event => setLanguage(event.target.value === 'zh-CN' ? 'zh-CN' : 'en')}>
    <option value="en" lang="en">English</option><option value="zh-CN" lang="zh-CN">简体中文</option>
  </select></label>;
}
