import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Share2, X } from 'lucide-react';
import type { Token } from './types';
import { t, useLanguage } from './i18n';
import './tokenReplay.css';

type ReplayModule = typeof import('./TokenReplayShare');
let loaded: ReplayModule | null = null, pending: Promise<ReplayModule> | null = null;
function loadReplay() {
  if (loaded) return Promise.resolve(loaded);
  return pending ??= import('./TokenReplayShare').then(module => { loaded = module; return module; }).catch(error => { pending = null; throw error; });
}

function TokenReplayDialog({ token, onClose }: { token: Token; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  const [module, setModule] = useState(loaded), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; element?.showModal();
    return () => { element?.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let active = true; setFailed(false);
    void loadReplay().then(value => { if (active) setModule(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt]);
  const Content = module?.default;
  return createPortal(<dialog ref={dialog} className="token-replay-modal" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className="token-replay-modal-header"><strong id={title}>{token.symbol || token.name || t('Token')}</strong>
      <button type="button" className="token-replay-close" aria-label={t('Close token replay')} onClick={onClose} autoFocus><X size={19} /></button>
    </header>
    {Content ? <Content token={token} /> : <div className="token-replay-loading">
      <p role={failed ? 'alert' : 'status'}>{t(failed ? 'Token replay could not load. Please retry.' : 'Preparing token replay…')}</p>
      {failed && <button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} /> {t('Retry replay')}</button>}
    </div>}
  </dialog>, document.body);
}

/** Loading the token page never requests extra replay history or the encoder bundle. */
export function TokenReplayTrigger({ token, onOpenChange }: { token: Token | null; onOpenChange?(open: boolean): void }) {
  useLanguage();
  const [snapshot, setSnapshot] = useState<Token | null>(null);
  return <><button type="button" className="token-replay-trigger" disabled={!token} onClick={() => {
    if (token) { setSnapshot({ ...token }); onOpenChange?.(true); }
  }}><Share2 size={15} /> {t('Share replay')}</button>
    {snapshot && <TokenReplayDialog token={snapshot} onClose={() => { setSnapshot(null); onOpenChange?.(false); }} />}
  </>;
}
