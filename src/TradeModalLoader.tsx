import { useEffect, useState, type ComponentProps } from 'react';
import { X } from 'lucide-react';
import { t, useLanguage } from './i18n';
import { reloadOutdatedModule } from './moduleLoadRecovery';
import './tradeModalLoader.css';

type ModalModule = typeof import('./KolTokenTradeModal');
type ModalProps = ComponentProps<ModalModule['default']>;
let loaded: ModalModule | null = null;
let pending: Promise<ModalModule> | null = null;

function loadModal() {
  if (loaded) return Promise.resolve(loaded);
  if (!pending) pending = import('./KolTokenTradeModal').then(module => { loaded = module; return module; }).catch(error => {
    pending = null;
    throw error;
  });
  return pending;
}

// Hover preloads never navigate away from the current page on a network failure.
export function preloadKolTokenTradeModal() { void loadModal().catch(() => {}); }

export function TradeModalLoader(props: ModalProps) {
  useLanguage();
  const [module, setModule] = useState(loaded);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void loadModal().then(value => { if (active) setModule(value); }).catch(async error => {
      const reloading = await reloadOutdatedModule(error, props.kol.address, props.token.address, () => active, !props.journalAccountId);
      if (active && !reloading) setFailed(true);
    });
    return () => { active = false; };
  }, [props.kol.address, props.token.address]);
  useEffect(() => {
    if (module) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [module, props.onClose]);
  if (module) { const Modal = module.default; return <Modal {...props} />; }
  return <div className="dialog-scrim" onClick={props.onClose}>
    <section className="trade-modal-load-status" role="dialog" aria-modal="true" aria-labelledby="trade-modal-load-title" onClick={event => event.stopPropagation()}>
      <button type="button" className="trade-modal-load-close" aria-label={t('Close')} onClick={props.onClose} autoFocus><X size={18} /></button>
      <h2 id="trade-modal-load-title">{failed ? t('Trade details could not load') : t('Loading trade details…')}</h2>
      <p role={failed ? 'alert' : 'status'}>{failed ? t('Reload the page to reconnect, then open this token again.') : t('Preparing the token chart and trades.')}</p>
      {failed && <button type="button" className="trade-modal-load-reload" onClick={() => window.location.reload()}>{t('Reload page')}</button>}
    </section>
  </div>;
}
