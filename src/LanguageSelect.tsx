import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Languages } from 'lucide-react';
import { t, useLanguage, type Language } from './i18n';

const languages = [{ value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }] as const;

export function LanguageSelect() {
  const [language, setLanguage] = useLanguage();
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), options = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const show = (index: number) => { setActive(index); setOpen(true); };
  const choose = (value: Language) => { setLanguage(value); setOpen(false); trigger.current?.focus(); };
  useEffect(() => { if (open) options.current[active]?.focus(); }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const navigate = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + languages.length) % languages.length); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setActive(event.key === 'Home' ? 0 : languages.length - 1); }
  };
  return <div className="language-select" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <button ref={trigger} type="button" className="language-trigger" aria-label={`${t('Language')}: ${language === 'en' ? 'English' : '简体中文'}`} title={t('Language')} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? setOpen(false) : show(language === 'en' ? 0 : 1)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(event.key === 'ArrowDown' ? 0 : languages.length - 1); } }}>
      <Languages size={18} aria-hidden="true" />
    </button>
    {open && <div className="language-menu" id={menuId} role="menu" aria-label={t('Language')} onKeyDown={navigate}>
      {languages.map((option, index) => <button key={option.value} ref={element => { options.current[index] = element; }} type="button" role="menuitemradio" aria-checked={language === option.value} tabIndex={active === index ? 0 : -1} lang={option.value} onFocus={() => setActive(index)} onClick={() => choose(option.value)}>
        <span>{option.label}</span>{language === option.value && <Check size={14} aria-hidden="true" />}
      </button>)}
    </div>}
  </div>;
}
