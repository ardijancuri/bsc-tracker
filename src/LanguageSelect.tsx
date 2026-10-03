import { Languages } from 'lucide-react';
import { t, useLanguage } from './i18n';

export function LanguageSelect() {
  const [language, setLanguage] = useLanguage();
  return <label className="language-select"><Languages size={16} aria-hidden="true" /><span className="language-caption">{t('Language')}</span><select aria-label={t('Language')} value={language} onChange={event => setLanguage(event.target.value === 'zh-CN' ? 'zh-CN' : 'en')}>
    <option value="en" lang="en">English</option><option value="zh-CN" lang="zh-CN">简体中文</option>
  </select></label>;
}
